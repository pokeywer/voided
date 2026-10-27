const feedback    = document.getElementById('dc-feedback');
const appView     = document.getElementById('dc-app');
const authView    = document.getElementById('dc-auth-required');
const commandList = document.getElementById('dc-command-list');
const channelList = document.getElementById('dc-channel-list');
let currentConfig = null;

const ALL_COMMANDS = [
    ['help',         'Show VoidedX help and command list'],
    ['leaderboard',  'Live vault execution leaderboard (today / month / all-time)'],
    ['stats',        'Live site activity — executions, users, vaults'],
    ['vault',        'Look up info about any vault by ID'],
    ['verify',       'Open a vault\'s access page'],
    ['obfuscate',    'Obfuscate a .lua file or pasted code with VoidedX'],
    ['panel',        'Open the VoidedX Creator Panel'],
    ['scripts',      'Browse the public script library'],
    ['rules',        'Server rules info panel'],
    ['notices',      'Notices info panel'],
    ['features',     'VoidedX features info panel'],
    ['top-globals',  'Link to the leaderboard'],
    ['chat',         'Chat channel info panel'],
    ['suggestions',  'Suggestions info panel'],
    ['site',         'Open the VoidedX website'],
    ['blacklist',    'Blacklist review info'],
    ['bypass',       'Safe access troubleshooting info'],
    ['commands',     'Commands info panel']
];

function showMessage(message, type = 'info') {
    feedback.textContent = message;
    feedback.className   = `admin-status ${type}`;
    feedback.classList.remove('hidden');
    setTimeout(() => feedback.classList.add('hidden'), 8000);
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

// ── Command list ──────────────────────────────────────────────────────────────
function renderCommands() {
    commandList.replaceChildren();
    const newCmds   = new Set(['leaderboard','stats','vault','obfuscate']);
    const toolCmds  = new Set(['help','panel','scripts','verify','leaderboard','stats','vault','obfuscate']);
    for (const [name, description] of ALL_COMMANDS) {
        const row  = document.createElement('div');
        row.className = 'dc-command';
        const icon = document.createElement('i');
        icon.className = toolCmds.has(name) ? 'fa-solid fa-bolt' : 'fa-solid fa-terminal';
        icon.style.color = newCmds.has(name) ? 'var(--accent-purple, #a855f7)' : '';
        const code = document.createElement('code');
        code.textContent = `/${name}`;
        const desc = document.createElement('span');
        desc.textContent = description;
        if (newCmds.has(name)) {
            const badge = document.createElement('span');
            badge.textContent = 'NEW';
            badge.style.cssText = 'margin-left:auto;font-size:8px;font-weight:900;color:#a855f7;letter-spacing:.5px;flex-shrink:0;';
            row.append(icon, code, desc, badge);
        } else {
            row.append(icon, code, desc);
        }
        commandList.appendChild(row);
    }
}

// ── Channel config ────────────────────────────────────────────────────────────
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

        const msgLabel = document.createElement('label');
        msgLabel.className = 'panel-label';
        msgLabel.textContent = 'PANEL MESSAGE';
        msgLabel.htmlFor = `dc-channel-message-${channel.key}`;
        const msgInput = document.createElement('textarea');
        msgInput.className = 'input-field';
        msgInput.id = msgLabel.htmlFor;
        msgInput.maxLength = 1800;
        msgInput.value = channel.message || '';

        const desc = document.createElement('p');
        desc.className = 'dc-muted';
        desc.style.margin = '8px 0 0';
        desc.textContent = channel.description;
        card.append(head, idLabel, idInput, msgLabel, msgInput, desc);
        channelList.appendChild(card);
    }
}

// ── Live leaderboard preview ──────────────────────────────────────────────────
async function loadLeaderboardPreview() {
    const container = document.getElementById('dc-leaderboard-preview');
    if (!container) return;
    container.innerHTML = '<p class="dc-muted"><i class="fa-solid fa-spinner fa-spin"></i> Loading leaderboard…</p>';
    try {
        const data = await fetch('/api/leaderboard', { cache: 'no-store' }).then(r => r.json());
        if (!data.ok) throw new Error(data.message);
        const now = data.today;
        const overall = data.rankings.overall.slice(0, 5);
        const today   = data.rankings.today.slice(0, 5);
        const medals  = ['🥇','🥈','🥉','4.','5.'];

        container.innerHTML = '';

        // Activity bar
        const actBar = document.createElement('div');
        actBar.className = 'dc-lb-activity';
        actBar.innerHTML = [
            `<span><i class="fa-solid fa-bolt" style="color:var(--cyan)"></i> <strong>${(data.activity.executionsToday||0).toLocaleString()}</strong> executions today</span>`,
            `<span><i class="fa-solid fa-users" style="color:var(--cyan)"></i> <strong>${(data.activity.activeUsersToday||0).toLocaleString()}</strong> active users</span>`,
            `<span><i class="fa-solid fa-box-archive" style="color:var(--cyan)"></i> <strong>${(data.activity.activeVaultsToday||0).toLocaleString()}</strong> active vaults</span>`,
            `<span style="color:var(--text-muted);font-size:9px">Tracking date: ${now} UTC</span>`
        ].join('');
        container.appendChild(actBar);

        const grid = document.createElement('div');
        grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px;';

        const mkTable = (title, rows) => {
            const wrap = document.createElement('div');
            wrap.className = 'dc-lb-table';
            const h = document.createElement('strong');
            h.style.cssText = 'display:block;font-size:10px;font-weight:900;letter-spacing:.6px;text-transform:uppercase;color:var(--text-muted);margin-bottom:6px;';
            h.textContent = title;
            wrap.appendChild(h);
            for (const [i, row] of rows.entries()) {
                const line = document.createElement('div');
                line.style.cssText = 'display:flex;gap:6px;align-items:center;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.045);font-size:11px;';
                line.innerHTML = `<span style="flex-shrink:0;width:20px;color:var(--text-muted)">${medals[i]||i+1}</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${row.title}</span><span style="flex-shrink:0;color:var(--cyan);font-weight:900;">${(row.executions||0).toLocaleString()}</span>`;
                wrap.appendChild(line);
            }
            if (!rows.length) {
                const e = document.createElement('p');
                e.className = 'dc-muted';
                e.textContent = 'No entries yet.';
                wrap.appendChild(e);
            }
            return wrap;
        };

        grid.append(mkTable(`Today (${now})`, today), mkTable('All-Time', overall));
        container.appendChild(grid);

        // Last push time
        const lbChannelId = currentConfig?.leaderboardChannelId || '';
        const lastPush    = currentConfig?.leaderboardLastPush ? new Date(currentConfig.leaderboardLastPush).toLocaleString() : 'Never';
        const meta = document.createElement('p');
        meta.className = 'dc-muted';
        meta.style.marginTop = '10px';
        meta.innerHTML = `Last pushed to Discord: <strong>${lastPush}</strong>${lbChannelId ? ` · Channel: <code>${lbChannelId}</code>` : ' · No channel set'}`;
        container.appendChild(meta);
    } catch (err) {
        container.innerHTML = `<p class="dc-muted">Could not load leaderboard: ${err.message}</p>`;
    }
}

// ── Bot status ────────────────────────────────────────────────────────────────
function updateReadiness(config) {
    const status = document.getElementById('dc-bot-status');
    if (config.tokenConfigured) {
        status.className = 'dc-status-pill warn';
        status.innerHTML = '<i class="fa-solid fa-circle-info"></i> Token ready · register commands to go live';
    } else {
        status.className = 'dc-status-pill';
        status.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> Add BOT_TOKEN in Vercel env';
    }
    document.getElementById('dc-app-id').textContent      = config.applicationId;
    document.getElementById('dc-public-key').textContent  = config.publicKey;
    document.getElementById('dc-guild-id').textContent    = config.guildId;
    document.getElementById('dc-endpoint').textContent    = `${location.origin}/api/discord-interactions`;
    document.getElementById('dc-register').disabled = !config.tokenConfigured;
    document.getElementById('dc-publish').disabled  = !config.tokenConfigured;
    document.getElementById('dc-push-lb').disabled  = !config.tokenConfigured;

    // Pre-fill leaderboard channel if saved
    const lbInput = document.getElementById('dc-leaderboard-channel');
    if (lbInput && config.leaderboardChannelId) lbInput.value = config.leaderboardChannelId;
}

// ── Load config + preview ─────────────────────────────────────────────────────
async function loadConfig() {
    const result = await requestJson('/api/discord-admin');
    currentConfig = result.config;
    updateReadiness(currentConfig);
    renderChannels(currentConfig.channels);
    renderCommands();
    await loadLeaderboardPreview();
}

// ── Save channel config ───────────────────────────────────────────────────────
async function saveConfig() {
    const button = document.getElementById('dc-save');
    setBusy(button, true, 'Saving…');
    feedback.classList.add('hidden');
    try {
        const channels = {}, messages = {};
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
        showMessage('Channel setup saved.', 'success');
    } catch (err) {
        showMessage(err.message || 'Could not save.', 'error');
    } finally {
        setBusy(button, false);
    }
}

// ── Push leaderboard ──────────────────────────────────────────────────────────
async function pushLeaderboard() {
    const button    = document.getElementById('dc-push-lb');
    const channelId = document.getElementById('dc-leaderboard-channel').value.trim();
    if (!channelId || !/^\d{17,20}$/.test(channelId)) {
        showMessage('Enter a valid leaderboard channel ID (17–20 digits).', 'error');
        return;
    }
    setBusy(button, true, 'Pushing…');
    feedback.classList.add('hidden');
    try {
        const result = await requestJson('/api/discord-admin', {
            method: 'POST', body: JSON.stringify({ action: 'push-leaderboard', channelId })
        });
        currentConfig = { ...currentConfig, leaderboardChannelId: channelId, leaderboardLastPush: Date.now() };
        updateReadiness(currentConfig);
        await loadLeaderboardPreview();
        showMessage(result.message, 'success');
    } catch (err) {
        showMessage(err.message || 'Could not push leaderboard.', 'error');
    } finally {
        setBusy(button, false);
    }
}

// ── Generic action runner ─────────────────────────────────────────────────────
async function runAction(button, action, busyLabel) {
    setBusy(button, true, busyLabel);
    feedback.classList.add('hidden');
    try {
        const result = await requestJson('/api/discord-admin', { method: 'POST', body: JSON.stringify({ action }) });
        if (Array.isArray(result.results)) {
            const details = result.results.map(i => `${i.ok ? '✓' : '•'} ${i.channel}: ${i.message}`).join('\n');
            showMessage(`${result.message}\n${details}`, result.results.every(i => i.ok) ? 'success' : 'info');
        } else {
            showMessage(result.message, 'success');
        }
    } catch (err) {
        showMessage(err.message || 'The Discord action failed.', 'error');
    } finally {
        setBusy(button, false);
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

async function start() {
    try {
        await loadConfig();
        appView.classList.remove('hidden');
    } catch (err) {
        authView.classList.remove('hidden');
        const copy = authView.querySelector('p');
        if (copy) copy.textContent = err.message || 'Could not open Discord Control.';
    }
}

document.getElementById('dc-save').addEventListener('click', saveConfig);
document.getElementById('dc-register').addEventListener('click', e => runAction(e.currentTarget, 'register', 'Registering…'));
document.getElementById('dc-publish').addEventListener('click',  e => runAction(e.currentTarget, 'publish',  'Publishing…'));
document.getElementById('dc-push-lb').addEventListener('click',  pushLeaderboard);
document.getElementById('dc-refresh-lb').addEventListener('click', loadLeaderboardPreview);
start();
