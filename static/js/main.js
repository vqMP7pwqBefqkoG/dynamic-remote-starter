const SECRET_PATH = document.body.dataset.secretPath;

// --- API Communication ---
async function apiFetch(endpoint, options = {}) {
    const messageBox = document.getElementById('message-box');
    messageBox.style.display = 'none';
    try {
        const response = await fetch(endpoint, options);
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error || 'An unknown error occurred.');
        }
        if (data.message) {
            messageBox.textContent = data.message;
            messageBox.style.display = 'block';
        }
        return data;
    } catch (error) {
        messageBox.textContent = `Error: ${error.message}`;
        messageBox.style.display = 'block';
        throw error;
    }
}

// --- App Control ---
function controlApp(appName, action) {
    apiFetch(`/${SECRET_PATH}/${action}/${appName}`, { method: 'POST' })
        .then(() => setTimeout(updateStatus, 500))
        .catch(err => console.error(`Failed to ${action} ${appName}`, err));
}

function deleteApp(appName) {
    if (!confirm(`Are you sure you want to delete "${appName}"?`)) {
        return;
    }
    apiFetch(`/${SECRET_PATH}/delete/${appName}`, { method: 'POST' })
        .then(() => {
            updateAppList();
        })
        .catch(err => console.error(`Failed to delete ${appName}`, err));
}

// --- UI Rendering ---

function sanitizeForId(str) {
    return str.replace(/[^a-zA-Z0-9-_]/g, '-');
}

function createAppCard(appName, appInfo) {
    const sanitizedAppName = sanitizeForId(appName);
    return `
        <div class="card" id="card-${sanitizedAppName}" draggable="true" data-app-name="${appName}">
            <a href="#" class="app-link" target="_blank" rel="noopener noreferrer">
                <h2>${appName}</h2>
            </a>
            <div class="card-footer">
                <div class="status-container">
                    <span id="status-${sanitizedAppName}" class="status status-unknown">Unknown</span>
                </div>
                <div class="buttons">
                    <button class="icon-btn start-btn" onclick="controlApp('${appName}', 'start')" title="Start">&#9654;</button>
                    <button class="icon-btn stop-btn" onclick="controlApp('${appName}', 'stop')" title="Stop">&#9632;</button>
                    <button class="icon-btn delete-btn" onclick="deleteApp('${appName}')" title="Delete">&#128465;</button>
                </div>
            </div>
        </div>
    `;
}

async function updateAppList() {
    try {
        const data = await apiFetch('/apps');
        const appList = document.getElementById('app-list');
        appList.innerHTML = '';
        
        const apps = data.apps || {};
        const order = data.order || [];

        if (order.length === 0) {
            appList.innerHTML = '<p style="text-align: center;">No applications configured. Add one above.</p>';
        } else {
            order.forEach(appName => {
                const appInfo = apps[appName];
                if (appInfo) {
                    appList.innerHTML += createAppCard(appName, appInfo);
                }
            });
        }
        updateStatus();
    } catch (error) {
        console.error('Failed to update app list:', error);
    }
}

async function updateStatus() {
    try {
        const data = await apiFetch('/status');

        Object.keys(data).forEach(appName => {
            const sanitizedAppName = sanitizeForId(appName);
            const card = document.getElementById(`card-${sanitizedAppName}`);
            if (!card) return;

            const statusEl = card.querySelector(`#status-${sanitizedAppName}`);
            const startBtn = card.querySelector('.start-btn');
            const stopBtn = card.querySelector('.stop-btn');
            const appLink = card.querySelector('.app-link');

            const appData = data[appName];

            if (appData.running) {
                statusEl.textContent = 'Run';
                statusEl.className = 'status status-running';
                startBtn.classList.add('disabled');
                stopBtn.classList.add('active');
                if (appData.port) {
                    appLink.href = `http://${window.location.hostname}:${appData.port}`;
                    appLink.style.pointerEvents = 'auto';
                    appLink.style.cursor = 'pointer';
                } else {
                    appLink.style.pointerEvents = 'none';
                    appLink.style.cursor = 'default';
                }
            } else {
                statusEl.textContent = 'Stop';
                statusEl.className = 'status status-stopped';
                startBtn.classList.remove('disabled');
                stopBtn.classList.remove('active');
                appLink.href = '#';
                appLink.style.pointerEvents = 'none';
                appLink.style.cursor = 'default';
            }
        });
    } catch (error) {
        console.error('Failed to fetch status:', error);
        document.querySelectorAll('.status').forEach(el => {
            el.textContent = 'Unknown';
            el.className = 'status status-unknown';
        });
    }
}

// --- Drag and Drop ---
function initDragAndDrop() {
    const appList = document.getElementById('app-list');
    let draggedItem = null;

    // Use event delegation for all drag events on the container
    appList.addEventListener('dragstart', e => {
        const targetCard = e.target.closest('.card');
        if (!targetCard) return;
        
        draggedItem = targetCard;
        // Use a timeout to allow the browser to create the drag image
        setTimeout(() => {
            draggedItem.classList.add('dragging');
        }, 0);
    });

    appList.addEventListener('dragend', e => {
        if (draggedItem) {
            draggedItem.classList.remove('dragging');
        }
        // Clear any lingering drag-over styles
        appList.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
        draggedItem = null;
    });

    appList.addEventListener('dragover', e => {
        e.preventDefault(); // Necessary to allow dropping
        const targetCard = e.target.closest('.card');
        // Clear previous drag-over styles
        appList.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
        if (targetCard && targetCard !== draggedItem) {
            targetCard.classList.add('drag-over');
        }
    });

    appList.addEventListener('dragleave', e => {
        const targetCard = e.target.closest('.card');
        if (targetCard) {
            targetCard.classList.remove('drag-over');
        }
    });

    appList.addEventListener('drop', e => {
        e.preventDefault();
        if (!draggedItem) return;

        const dropTarget = e.target.closest('.card');
        appList.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));

        if (dropTarget && dropTarget !== draggedItem) {
            // Swap the elements
            const parent = appList;
            const draggedNext = draggedItem.nextSibling;
            const dropTargetNext = dropTarget.nextSibling;

            // Swap positions by moving draggedItem before dropTarget's next sibling
            // and dropTarget before draggedItem's original next sibling.
            parent.insertBefore(draggedItem, dropTargetNext);
            parent.insertBefore(dropTarget, draggedNext);

            // Get new order and save it
            const newOrder = [...parent.querySelectorAll('.card')].map(card => card.dataset.appName);
            
            apiFetch(`/${SECRET_PATH}/save-order`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ order: newOrder })
            }).catch(err => {
                console.error('Failed to save new order:', err);
                // On error, revert the UI change by reloading the list
                updateAppList();
            });
        }
    });
}


// --- Event Listeners ---
document.getElementById('add-app-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const appName = document.getElementById('app-name').value;
    const appPath = document.getElementById('app-path').value;
    const appPort = document.getElementById('app-port').value;

    if (!appName || !appPath) {
        alert('Please provide both an application name and a path to a .bat file.');
        return;
    }

    const payload = {
        name: appName,
        path: appPath,
        port: appPort
    };

    try {
        await apiFetch(`/${SECRET_PATH}/add`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        document.getElementById('add-app-form').reset();
        updateAppList();
    } catch (error) {
        console.error('Failed to add application:', error);
    }
});

// --- Theme Switching ---
const themeToggle = document.getElementById('theme-toggle');
const themeLabel = document.querySelector('.theme-switcher label');

function applyTheme(isDark) {
    if (isDark) {
        document.body.classList.add('dark-mode');
        themeLabel.textContent = '☀️';
        themeToggle.checked = true;
    } else {
        document.body.classList.remove('dark-mode');
        themeLabel.textContent = '🌙';
        themeToggle.checked = false;
    }
}

function toggleTheme() {
    const isDark = themeToggle.checked;
    applyTheme(isDark);
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
}

themeToggle.addEventListener('change', toggleTheme);


// --- Initial Load ---
document.addEventListener('DOMContentLoaded', () => {
    // Load theme
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme) {
        applyTheme(savedTheme === 'dark');
    } else {
        const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        applyTheme(prefersDark);
    }

    // Init Drag and Drop
    initDragAndDrop();

    // Load app data
    updateAppList();
    setInterval(updateStatus, 5000);
});
