const feedback = document.getElementById('dc-feedback');
const appView = document.getElementById('dc-app');
const authView = document.getElementById('dc-auth-required');
const commandList = document.getElementById('dc-command-list');
const channelList = document.getElementById('dc-channel-list');
let currentConfig = null;

const commands = [
    ['help', 'Quick links and command list'],
    ['panel', 'Open the Creator Panel'],
    ['scripts', 'Browse public scripts'],
    ['verify', 'Open a vault access page'],
    ['rules', 'Rules channel info'],
    ['notices', 'Notices channel info'],
    ['features', 'Features channel info'],
    ['top-globals', 'Leaderboard link'],
    ['chat', 'Chat channel info'],
    ['suggestions', 'Suggestions channel info'],
    ['site', 'Website link'],
    ['blacklist', 'Blacklist review information'],
    ['bypass', 'Safe access troubleshooting'],
    ['commands', 'Commands channel info']
];

function showMessage(message, type = 'info') {
    feedback.textContent = message;
    feedback.className = `admin-status ${type}`;
    feedback.classList.remove('hidden');
}

async function requestJson(url, options = {}) {
    const response = await fetch(url, {
        credentials: 'same-origin',
        cache: 'no-store',
        ...options,
        headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(data.message || `Request failed (${response.status}).`);
    return data;
}

function renderCommands() {
    commandList.replaceChildren();
    for (const [name, description] of commands) {
        const row = document.createElement('div');
        row.className = 'dc-command';
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-terminal';
        const code = document.createElement('code');
        code.textContent = `/${name}`;
        const copy = document.createElement('span');
        copy.textContent = description;
        row.append(icon, code, copy);
        commandList.appendChild(row);
    }
}

function renderChannels(channels) {
    channelList.replaceChildren();
    for (const channel of channels) {
        const card = document.createElement('article');
        card.className = 'dc-channel';
        card.dataset.channelKey = channel.key;

        const head = document.createElement('div');
        head.className = 'dc-channel-head';
        const title = document.createElement('strong');
        title.className = 'dc-channel-title';
        title.textContent = `# ${channel.label}`;
        const command = document.createElement('span');
        command.className = 'dc-channel-command';
        command.textContent = `/${channel.command}`;
        head.append(title, command);

        const idLabel = document.createElement('label');
        idLabel.className = 'panel-label';
        idLabel.textContent = 'CHANNEL ID';
        idLabel.htmlFor = `dc-channel-id-${channel.key}`;
        const idInput = document.createElement('input');
        idInput.className = 'input-field dc-channel-id';
        idInput.id = idLabel.htmlFor;
        idInput.inputMode = 'numeric';
        idInput.autocomplete = 'off';
        idInput.maxLength = 20;
        idInput.placeholder = 'Right-click channel → Copy Channel ID';
        idInput.value = channel.id || '';

        const messageLabel = document.createElement('label');
        messageLabel.className = 'panel-label';
        messageLabel.textContent = 'PANEL MESSAGE';
        messageLabel.htmlFor = `dc-channel-message-${channel.key}`;
        const messageInput = document.createElement('textarea');
        messageInput.className = 'input-field';
        messageInput.id = messageLabel.htmlFor;
        messageInput.maxLength = 1800;
        messageInput.value = channel.message || '';

        const description = document.createElement('p');
        description.className = 'dc-muted';
        description.style.margin = '8px 0 0';
        description.textContent = channel.description;
        card.append(head, idLabel, idInput, messageLabel, messageInput, description);
        channelList.appendChild(card);
    }
}

function setBusy(button, busy, label) {
    if (busy) {
        button.dataset.originalHtml = button.innerHTML;
        button.disabled = true;
        button.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${label}`;
    } else {
        button.disabled = false;
        if (button.dataset.originalHtml) button.innerHTML = button.dataset.originalHtml;
        delete button.dataset.originalHtml;
    }
}

function updateReadiness(config) {
    const status = document.getElementById('dc-bot-status');
    if (config.tokenConfigured) {
        status.className = 'dc-status-pill warn';
        status.innerHTML = '<i class="fa-solid fa-circle-info"></i> Token ready · online worker required';
    } else {
        status.className = 'dc-status-pill';
        status.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> Add bot token in Vercel';
    }
    document.getElementById('dc-app-id').textContent = config.applicationId;
    document.getElementById('dc-public-key').textContent = config.publicKey;
    document.getElementById('dc-guild-id').textContent = config.guildId;
    document.getElementById('dc-endpoint').textContent = `${location.origin}/api/discord-interactions`;
    document.getElementById('dc-register').disabled = !config.tokenConfigured;
    document.getElementById('dc-publish').disabled = !config.tokenConfigured;
}

async function loadConfig() {
    const result = await requestJson('/api/discord-admin');
    currentConfig = result.config;
    updateReadiness(currentConfig);
    renderChannels(currentConfig.channels);
    renderCommands();
}

async function saveConfig() {
    const button = document.getElementById('dc-save');
    setBusy(button, true, 'Saving…');
    feedback.classList.add('hidden');
    try {
        const channels = {};
        const messages = {};
        for (const card of channelList.querySelectorAll('[data-channel-key]')) {
            const key = card.dataset.channelKey;
            channels[key] = card.querySelector('.dc-channel-id').value.trim();
            messages[key] = card.querySelector('textarea').value;
        }
        const result = await requestJson('/api/discord-admin', {
            method: 'PATCH', body: JSON.stringify({ channels, messages })
        });
        currentConfig = result.config;
        updateReadiness(currentConfig);
        renderChannels(currentConfig.channels);
        showMessage('Discord channel setup saved.', 'success');
    } catch (error) {
        showMessage(error.message || 'Could not save the channel setup.', 'error');
    } finally {
        setBusy(button, false);
    }
}

async function runAction(button, action, busyLabel) {
    setBusy(button, true, busyLabel);
    feedback.classList.add('hidden');
    try {
        const result = await requestJson('/api/discord-admin', {
            method: 'POST', body: JSON.stringify({ action })
        });
        if (Array.isArray(result.results)) {
            const details = result.results.map(item => `${item.ok ? '✓' : '•'} ${item.channel}: ${item.message}`).join('\n');
            showMessage(`${result.message}\n${details}`, result.results.every(item => item.ok) ? 'success' : 'info');
        } else {
            showMessage(result.message, 'success');
        }
    } catch (error) {
        showMessage(error.message || 'The Discord action failed.', 'error');
    } finally {
        setBusy(button, false);
    }
}

async function start() {
    try {
        await loadConfig();
        appView.classList.remove('hidden');
    } catch (error) {
        if (/sign in|session/i.test(error.message)) {
            authView.classList.remove('hidden');
            return;
        }
        authView.classList.remove('hidden');
        const copy = authView.querySelector('p');
        copy.textContent = error.message || 'Could not open Discord Control.';
    }
}

document.getElementById('dc-save').addEventListener('click', saveConfig);
document.getElementById('dc-register').addEventListener('click', event => runAction(event.currentTarget, 'register', 'Registering…'));
document.getElementById('dc-publish').addEventListener('click', event => runAction(event.currentTarget, 'publish', 'Publishing…'));
start();
