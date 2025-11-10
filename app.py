import subprocess
import os
import json
from flask import Flask, jsonify, render_template, request, abort

# --- 設定 ---
PORT = 9999
SECRET_PATH = "remote-admin-xxxx" # 必ずユニークな文字列に変更してください
CONFIG_FILE = "config.json"
PID_FILE = "processes.json"


# --- アプリケーション本体 ---

app = Flask(__name__)

# --- ヘルパー関数 (ファイルI/O) ---

def load_json_file(filename, default_data={}):
    """JSONファイルを読み込む"""
    if not os.path.exists(filename):
        return default_data
    try:
        with open(filename, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return default_data

def save_json_file(filename, data):
    """JSONファイルに保存する"""
    try:
        with open(filename, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=4, ensure_ascii=False)
    except IOError as e:
        print(f"Error saving {filename}: {e}")

def load_and_migrate_config():
    """設定をロードし、古い形式の場合は新しい形式に移行する"""
    config = load_json_file(CONFIG_FILE)
    # 古い形式（ルートが辞書で、'apps'キーがない）か、空の場合
    if not isinstance(config, dict) or 'apps' not in config:
        print("Old config format detected or config is empty. Migrating...")
        new_config = {
            "apps": config if isinstance(config, dict) else {},
            "order": list(config.keys()) if isinstance(config, dict) else []
        }
        save_json_file(CONFIG_FILE, new_config)
        return new_config
    # orderキーがない場合は追加
    if 'order' not in config:
        config['order'] = list(config.get('apps', {}).keys())
        save_json_file(CONFIG_FILE, config)
    
    # データの整合性を確認
    app_keys = set(config.get('apps', {}).keys())
    order_keys = set(config.get('order', []))
    if app_keys != order_keys:
        print("Inconsistency found between apps and order. Rebuilding order.")
        config['order'] = list(app_keys)
        save_json_file(CONFIG_FILE, config)

    return config

# --- グローバル変数の初期化 ---

app_config = load_and_migrate_config()
processes = load_json_file(PID_FILE)


# --- API Endpoints ---

@app.route('/')
def index():
    """メインのHTMLページを返す"""
    return render_template('index.html', SECRET_PATH=SECRET_PATH)

@app.route('/apps')
def get_apps():
    """設定されているアプリケーションの一覧を返す"""
    return jsonify(app_config)

@app.route('/status')
def get_status():
    """全アプリケーションのステータスを返す"""
    global processes
    current_status = {}
    apps_to_remove_pid = []

    for app_name, app_info in app_config.get('apps', {}).items():
        pid = processes.get(app_name)
        is_running = False
        if pid:
            try:
                result = subprocess.run(['tasklist', '/FI', f'PID eq {pid}'], capture_output=True, text=True, check=True)
                if str(pid) in result.stdout:
                    is_running = True
                else:
                    apps_to_remove_pid.append(app_name)
            except (subprocess.CalledProcessError, FileNotFoundError):
                apps_to_remove_pid.append(app_name)
        
        current_status[app_name] = {
            "running": is_running,
            "pid": pid if is_running else None,
            "port": app_info.get("port")
        }

    if apps_to_remove_pid:
        for app_name in apps_to_remove_pid:
            if app_name in processes:
                del processes[app_name]
        save_json_file(PID_FILE, processes)

    return jsonify(current_status)

def _stop_process(app_name):
    """Internal helper to stop a process and update state."""
    pid = processes.get(app_name)
    if pid is None:
        return True, f"{app_name} is not running or not tracked."
    try:
        subprocess.run(['taskkill', '/F', '/PID', str(pid), '/T'], check=True, capture_output=True, text=True)
        del processes[app_name]
        save_json_file(PID_FILE, processes)
        return True, f"Sent stop signal to {app_name} (PID: {pid})."
    except subprocess.CalledProcessError as e:
        if "not found" in e.stderr.lower():
            if app_name in processes:
                del processes[app_name]
                save_json_file(PID_FILE, processes)
            return True, f"Process for {app_name} (PID: {pid}) not found. Already stopped."
        else:
            return False, f"Failed to stop {app_name}: {e.stderr}"
    except Exception as e:
        return False, f"An unexpected error occurred: {str(e)}"

@app.route(f'/{SECRET_PATH}/add', methods=['POST'])
def add_app():
    """新しいアプリケーションを追加する"""
    data = request.get_json()
    if not data or 'name' not in data or 'path' not in data:
        return jsonify({"error": "Missing name or path in request"}), 400
    
    name = data['name']
    path = data['path']
    port = data.get('port')

    if name in app_config['apps']:
        return jsonify({"error": f"Application '{name}' already exists."}), 409
    if not path.endswith('.bat') or not os.path.isabs(path):
        return jsonify({"error": "Invalid path. Please provide an absolute path to a .bat file."}), 400
    if not os.path.exists(path):
        return jsonify({"error": f"File not found at path: {path}"}), 400

    try:
        port_int = int(port) if port and str(port).strip() else None
    except (ValueError, TypeError):
        return jsonify({"error": f"Invalid port number: {port}"}), 400

    app_config['apps'][name] = {
        "path": path,
        "cwd": os.path.dirname(path),
        "port": port_int
    }
    app_config['order'].append(name)
    save_json_file(CONFIG_FILE, app_config)

    return jsonify({"message": f"Application '{name}' added successfully."}), 201

@app.route(f'/{SECRET_PATH}/delete/<app_name>', methods=['POST'])
def delete_app(app_name):
    """アプリケーションを削除する"""
    if app_name not in app_config['apps']:
        return jsonify({"error": "Application not found"}), 404

    if processes.get(app_name):
        _stop_process(app_name)

    del app_config['apps'][app_name]
    if app_name in app_config['order']:
        app_config['order'].remove(app_name)
    save_json_file(CONFIG_FILE, app_config)

    if app_name in processes:
        del processes[app_name]
        save_json_file(PID_FILE, processes)

    return jsonify({"message": f"Application '{app_name}' deleted."}), 200

@app.route(f'/{SECRET_PATH}/save-order', methods=['POST'])
def save_order():
    """アプリケーションの並び順を保存する"""
    data = request.get_json()
    if not data or 'order' not in data:
        return jsonify({"error": "Missing order data"}), 400
    
    new_order = data['order']
    # 整合性チェック
    if set(new_order) != set(app_config['apps'].keys()):
        return jsonify({"error": "Order data does not match current apps"}), 400
        
    app_config['order'] = new_order
    save_json_file(CONFIG_FILE, app_config)
    return jsonify({"status": "success"}), 200

@app.route(f'/{SECRET_PATH}/start/<app_name>', methods=['POST'])
def start_app(app_name):
    """アプリケーションを起動する"""
    if app_name not in app_config['apps']:
        return jsonify({"error": "Invalid application name"}), 404
    
    pid = processes.get(app_name)
    if pid:
        try:
            result = subprocess.run(['tasklist', '/FI', f'PID eq {pid}'], capture_output=True, text=True)
            if str(pid) in result.stdout:
                 return jsonify({"message": f"{app_name} is already running."}), 200
        except subprocess.CalledProcessError:
            pass

    try:
        app_info = app_config['apps'][app_name]
        abs_path = app_info['path']
        abs_cwd = app_info['cwd']
        
        if not os.path.exists(abs_path):
            return jsonify({"error": f"Batch file not found: {abs_path}"}), 500

        command = ['cmd.exe', '/k', abs_path]
        proc = subprocess.Popen(command, creationflags=subprocess.CREATE_NEW_CONSOLE, cwd=abs_cwd)
        
        processes[app_name] = proc.pid
        save_json_file(PID_FILE, processes)
        
        return jsonify({"message": f"Started {app_name} with PID: {proc.pid}"}), 200
    except Exception as e:
        return jsonify({"error": f"Failed to start {app_name}: {str(e)}"}), 500

@app.route(f'/{SECRET_PATH}/stop/<app_name>', methods=['POST'])
def stop_app(app_name):
    """アプリケーションを停止する"""
    if app_name not in app_config['apps']:
        return jsonify({"error": "Application not found"}), 404
        
    success, message = _stop_process(app_name)
    
    if success:
        return jsonify({"message": message}), 200
    else:
        return jsonify({"error": message}), 500

if __name__ == '__main__':
    print("--- Dynamic Remote Starter Server ---")
    print(f"1. IMPORTANT: Edit 'app.py' and change SECRET_PATH to a unique value.")
    print(f"2. Access this server from your browser (e.g., on your phone) via:")
    print(f"   http://<your-pc-ip>:{PORT}/")
    print("   (To find your PC's IP, use 'ipconfig' in cmd or 'tailscale ip' if you use it)")
    print("------------------------------------")
    app.run(host='0.0.0.0', port=PORT, debug=False)
