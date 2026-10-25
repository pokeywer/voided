import { obfuscateLua, resolveObfuscationLevel, encodeVaultSource, encodeObfuscatedCode, getUtf8ByteLength, MAX_VAULT_SOURCE_BYTES, MAX_OBFUSCATED_OUTPUT_BYTES, MAX_INLINE_OBFUSCATED_PREVIEW_BYTES } from './lua-medium.js';

const loginView = document.getElementById('admin-login-view');
const dashboardView = document.getElementById('admin-dashboard-view');
const usernameInput = document.getElementById('admin-username');
const passwordInput = document.getElementById('admin-password');
const loginButton = document.getElementById('admin-login-btn');
const loginError = document.getElementById('admin-login-error');
const statusBox = document.getElementById('admin-status');
const ideasList = document.getElementById('admin-ideas-list');
const pendingScriptsList = document.getElementById('admin-script-pending-list');
const reportedScriptsList = document.getElementById('admin-script-reported-list');
const managedScriptsList = document.getElementById('admin-managed-script-list');
let managedScripts = [];
let announcements = [];
let selectedAnnouncementId = null;
const adminVaultList = document.getElementById('admin-vault-list');
const adminVaultStatus = document.getElementById('admin-vault-status');
const adminVaultSearch = document.getElementById('admin-vault-search');
const adminVaultTitle = document.getElementById('admin-vault-title');
const adminVaultSource = document.getElementById('admin-vault-source');
const adminVaultExecutions = document.getElementById('admin-vault-executions');
const adminVaultSaveExecutions = document.getElementById('admin-vault-save-executions');
const adminVaultObfuscation = document.getElementById('admin-vault-obfuscation');
const adminVaultLevel = document.getElementById('admin-vault-level');
const adminVaultTamper = document.getElementById('admin-vault-tamper');
const adminVaultVm = document.getElementById('admin-vault-vm');
const adminVaultSplitting = document.getElementById('admin-vault-splitting');
const adminVaultOutput = document.getElementById('admin-vault-obfuscated-output');
const adminVaultPreviewWrap = document.getElementById('admin-vault-preview-wrap');
const adminVaultEditFields = document.getElementById('admin-vault-edit-fields');
const adminVaultEmpty = document.getElementById('admin-vault-empty');
const adminVaultPreviewButton = document.getElementById('admin-vault-preview-btn');
const adminVaultFormControls = [adminVaultTitle, adminVaultSource, adminVaultObfuscation, adminVaultLevel, adminVaultTamper, adminVaultVm, adminVaultSplitting];
let adminVaults = [];
let activeAdminVault = null;
let adminVaultDirty = false;
let adminVaultSaving = false;
let adminVaultRevision = 0;
let adminVaultPreviewIsCurrent = false;
let adminVaultPreviewSignature = '';
let adminVaultLoadSequence = 0;
let adminVaultOutputText = '';
const adminOperationsStatus = document.getElementById('admin-operations-status');
const adminRestoreRequests = document.getElementById('admin-restore-requests');
const adminBackupList = document.getElementById('admin-backup-list');
const adminStaffList = document.getElementById('admin-staff-list');

async function requestJson(path, options = {}) {
    const response = await fetch(path, {
        credentials: 'same-origin',
        cache: 'no-store',
        ...options,
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok || data.ok === false) throw new Error(data.message || 'The request could not be completed.');
    return data;
}

function setStatus(message, kind = 'info') {
    statusBox.textContent = message;
    statusBox.className = `admin-status ${kind}`;
    statusBox.classList.remove('hidden');
}

function showLoginError(message) {
    loginError.textContent = message;
    loginError.classList.remove('hidden');
}

function setLoggedIn(isLoggedIn) {
    loginView.classList.toggle('hidden', isLoggedIn);
    dashboardView.classList.toggle('hidden', !isLoggedIn);
    if (isLoggedIn) statusBox.classList.add('hidden');
    else clearAdminVaultWorkspace();
}

function setLoading(button, loading, label) {
    if (!button) return;
    button.disabled = loading;
    if (loading) {
        button.dataset.originalHtml = button.innerHTML;
        button.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${label}`;
    } else if (button.dataset.originalHtml) {
        button.innerHTML = button.dataset.originalHtml;
        delete button.dataset.originalHtml;
    }
}

async function checkSession() {
    try {
        const data = await requestJson('/api/admin-auth');
        if (!data.configured) {
            showLoginError('Admin setup is incomplete. Add the Vercel environment variables, use a password with at least 12 characters, and set a separate random session secret of at least 32 bytes. Then redeploy.');
            return;
        }
        if (data.authenticated) {
            setLoggedIn(true);
            await refreshDashboard();
        }
    } catch (error) {
        showLoginError(error.message);
    }
}

async function signIn() {
    loginError.classList.add('hidden');
    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    if (!username || !password) {
        showLoginError('Enter your admin username and password.');
        return;
    }

    setLoading(loginButton, true, 'SIGNING IN…');
    try {
        await requestJson('/api/admin-auth', {
            method: 'POST',
            body: JSON.stringify({ action: 'login', username, password })
        });
        passwordInput.value = '';
        setLoggedIn(true);
        await refreshDashboard();
    } catch (error) {
        showLoginError(error.message);
    } finally {
        setLoading(loginButton, false);
    }
}

function formatDate(value) {
    if (!value) return 'Date unavailable';
    try {
        return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
    } catch {
        return 'Date unavailable';
    }
}

function setOperationsStatus(message, kind = 'info') {
    adminOperationsStatus.textContent = message;
    adminOperationsStatus.className = `admin-status ${kind}`;
}

function operationLine(titleText, detailText, actions = []) {
    const row = document.createElement('article');
    row.className = 'admin-operation-item';
    const copy = document.createElement('div');
    copy.className = 'admin-operation-copy';
    const title = document.createElement('strong');
    title.textContent = titleText;
    const detail = document.createElement('span');
    detail.textContent = detailText;
    copy.append(title, detail);
    row.appendChild(copy);
    if (actions.length) {
        const group = document.createElement('div');
        group.className = 'admin-operation-actions';
        for (const action of actions) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = action.danger ? 'btn-danger admin-operation-action' : 'btn-ghost admin-operation-action';
            button.dataset.operationAction = action.action;
            if (action.backupId) button.dataset.backupId = action.backupId;
            if (action.backupType) button.dataset.backupType = action.backupType;
            if (action.requestId) button.dataset.requestId = action.requestId;
            if (action.uid) button.dataset.uid = action.uid;
            button.innerHTML = action.icon ? `<i class="fa-solid ${action.icon}"></i> ${action.label}` : action.label;
            group.appendChild(button);
        }
        row.appendChild(group);
    }
    return row;
}

function renderAdminOperations(result) {
    adminRestoreRequests.replaceChildren();
    if (!result.requests?.length) {
        const empty = document.createElement('p');
        empty.className = 'admin-help';
        empty.textContent = 'No restore requests yet.';
        adminRestoreRequests.appendChild(empty);
    } else {
        for (const item of result.requests) {
            const actions = ['pending', 'in_review', 'needs_admin'].includes(item.status) ? [
                { action: 'restore-request', label: 'Restore', icon: 'fa-rotate-left', backupId: item.backupId, backupType: item.backupType, requestId: item.id },
                { action: 'dismiss-request', label: 'Decline', icon: 'fa-xmark', requestId: item.id, danger: true }
            ] : [];
            const isScript = item.backupType === 'communityScript';
            const staffNotes = (item.staffNotes || []).map(note => `${note.email || 'Staff'}: ${note.text}`).join(' · ');
            adminRestoreRequests.appendChild(operationLine(
                item.title || (isScript ? 'Untitled script' : 'Untitled Vault'),
                `${item.ownerEmail || item.ownerUid} · ${isScript ? `Community script ${item.scriptId}` : `Vault ${item.vaultId}`} · ${item.status} · ${formatDate(item.createdAt)}${staffNotes ? ` · Staff notes: ${staffNotes}` : ''}`,
                actions
            ));
        }
    }

    adminBackupList.replaceChildren();
    if (!result.backups?.length) {
        const empty = document.createElement('p');
        empty.className = 'admin-help';
        empty.textContent = 'Backups will appear here after a vault is saved or a community script is changed or removed.';
        adminBackupList.appendChild(empty);
    } else {
        for (const item of result.backups) {
            const isScript = item.backupType === 'communityScript';
            adminBackupList.appendChild(operationLine(
                item.title || (isScript ? 'Untitled script' : 'Untitled Vault'),
                `${isScript ? `Community script ${item.scriptId}` : `Vault ${item.vaultId}`} · ${item.reason.replaceAll('_', ' ')} · ${formatDate(item.createdAt)} · ${item.ownerUid}`,
                [{ action: 'restore-backup', label: 'Restore', icon: 'fa-rotate-left', backupId: item.id, backupType: item.backupType }]
            ));
        }
    }

    adminStaffList.replaceChildren();
    if (!result.staff?.length) {
        const empty = document.createElement('p');
        empty.className = 'admin-help';
        empty.textContent = 'No staff grants yet.';
        adminStaffList.appendChild(empty);
    } else {
        for (const item of result.staff) {
            const state = item.active ? `Active until ${formatDate(item.expiresAt)}` : 'Expired or disabled';
            const scopeLabels = item.scopes.map(scope => ({
                vaults: 'Vaults', vaultSource: 'Source', executions: 'Executions', announcements: 'Announcements',
                announcementManage: 'Manage announcements', ideas: 'Ideas', ideaTriage: 'Triage ideas',
                restoreRequests: 'Restore requests', restoreTriage: 'Triage restore requests',
                communityScripts: 'Community scripts', communityModeration: 'Moderate community scripts'
            }[scope] || scope));
            const actions = item.active ? [{ action: 'revoke-staff', label: 'Revoke', icon: 'fa-user-slash', uid: item.uid, danger: true }] : [];
            adminStaffList.appendChild(operationLine(item.email || 'Guest account', `${item.uid} · ${state} · ${scopeLabels.join(', ')}`, actions));
        }
    }
}

async function loadAdminOperations() {
    const result = await requestJson('/api/admin-operations');
    renderAdminOperations(result);
}

function setVaultStatus(message, kind = 'info') {
    adminVaultStatus.textContent = message;
    adminVaultStatus.className = `admin-status ${kind}`;
}

function clearAdminVaultWorkspace() {
    activeAdminVault = null;
    adminVaults = [];
    adminVaultDirty = false;
    adminVaultRevision += 1;
    adminVaultTitle.value = '';
    adminVaultSource.value = '';
    adminVaultExecutions.value = '';
    adminVaultSearch.value = '';
    adminVaultList.replaceChildren();
    clearAdminVaultPreview();
    setAdminVaultEditorEnabled(false);
    adminVaultStatus.classList.add('hidden');
}

function currentAdminVaultSignature() {
    return JSON.stringify({
        title: adminVaultTitle.value,
        source: adminVaultSource.value,
        enabled: adminVaultObfuscation.checked,
        level: adminVaultLevel.value,
        tamper: adminVaultTamper.checked,
        vm: adminVaultObfuscation.checked,
        splitting: adminVaultSplitting.checked
    });
}

function clearAdminVaultPreview() {
    adminVaultRevision += 1;
    adminVaultOutputText = '';
    adminVaultOutput.value = '';
    adminVaultPreviewWrap.classList.add('hidden');
    adminVaultPreviewIsCurrent = false;
    adminVaultPreviewSignature = '';
    document.getElementById('admin-vault-copy-output').disabled = true;
    document.getElementById('admin-vault-download-output').disabled = true;
}

function invalidateAdminVaultPreview() {
    adminVaultRevision += 1;
    if (!adminVaultOutputText) return;
    adminVaultPreviewIsCurrent = false;
    document.getElementById('admin-vault-copy-output').disabled = true;
    document.getElementById('admin-vault-download-output').disabled = true;
    setVaultStatus('The source or protection settings changed. Generate a fresh preview before using the output.', 'info');
}

function markAdminVaultDirty() {
    adminVaultDirty = true;
    invalidateAdminVaultPreview();
    setVaultStatus(`Unsaved changes to ${activeAdminVault?.title || 'this vault'}. Saving replaces the live source.${adminVaultOutputText ? ' The old preview is stale.' : ''}`, 'info');
}

function getAdminVaultObfuscationSettings() {
    const enabled = adminVaultObfuscation.checked;
    const absoluteMode = enabled && adminVaultLevel.value === 'absolute';
    const fastMode = enabled && adminVaultLevel.value === 'fast';
    const vmProtection = enabled;
    return {
        enabled,
        requestedLevel: adminVaultLevel.value,
        effectiveLevel: resolveObfuscationLevel(adminVaultSource.value, adminVaultLevel.value),
        protection: {
            tamperCheck: absoluteMode || adminVaultTamper.checked,
            vmProtection,
            expandedTransforms: absoluteMode || (!fastMode && adminVaultSplitting.checked)
        }
    };
}

function syncAdminVaultProtectionControls() {
    const enabled = !!activeAdminVault && adminVaultObfuscation.checked;
    const absoluteMode = enabled && adminVaultLevel.value === 'absolute';
    const fastMode = enabled && adminVaultLevel.value === 'fast';
    if (adminVaultVm) {
        adminVaultVm.checked = enabled;
        adminVaultVm.disabled = true;
    }
    if (absoluteMode) {
        adminVaultTamper.checked = true;
        adminVaultSplitting.checked = true;
    }
    if (fastMode) adminVaultSplitting.checked = false;
    adminVaultLevel.disabled = !enabled;
    adminVaultTamper.disabled = !enabled || absoluteMode;
    adminVaultSplitting.disabled = !enabled || absoluteMode || fastMode;
    if (adminVaultPreviewButton) adminVaultPreviewButton.disabled = !enabled || !activeAdminVault;
}

function renderAdminVaultList() {
    const query = adminVaultSearch.value.trim().toLocaleLowerCase();
    const visible = adminVaults.filter(vault => `${vault.title} ${vault.id} ${vault.ownerUid}`.toLocaleLowerCase().includes(query));
    adminVaultList.replaceChildren();
    document.getElementById('admin-vault-count').textContent = query
        ? `${visible.length} shown · ${adminVaults.length} total`
        : `${adminVaults.length} vault${adminVaults.length === 1 ? '' : 's'}`;
    if (!visible.length) {
        const empty = document.createElement('div');
        empty.className = 'info-box';
        const text = document.createElement('p');
        text.textContent = adminVaults.length ? 'No vaults match this search.' : 'No vaults are saved yet.';
        empty.appendChild(text);
        adminVaultList.appendChild(empty);
        return;
    }
    visible.forEach(vault => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `admin-vault-item${activeAdminVault?.id === vault.id ? ' selected' : ''}`;
        button.dataset.vaultId = vault.id;
        const title = document.createElement('strong');
        title.textContent = vault.title || 'Untitled Vault';
        const detail = document.createElement('span');
        detail.textContent = `${vault.id} · ${vault.ownerUid || 'Owner UID unavailable'}`;
        const badges = document.createElement('span');
        badges.textContent = `${vault.obfuscationEnabled ? 'Obfuscated' : 'Plain source'} · ${vault.executions.toLocaleString()} executions · ${formatDate(vault.updatedAt)}`;
        button.append(title, detail, badges);
        adminVaultList.appendChild(button);
    });
}

function setAdminVaultEditorEnabled(enabled) {
    adminVaultEditFields.classList.toggle('hidden', !enabled);
    adminVaultEmpty.classList.toggle('hidden', enabled);
    adminVaultFormControls.forEach(control => { control.disabled = !enabled; });
    document.getElementById('admin-vault-copy-source').disabled = !enabled;
    document.getElementById('admin-vault-download-source').disabled = !enabled;
    document.getElementById('admin-vault-save-btn').disabled = !enabled;
    document.getElementById('admin-vault-preview-btn').disabled = !enabled || !adminVaultObfuscation.checked;
    adminVaultExecutions.disabled = !enabled;
    adminVaultSaveExecutions.disabled = !enabled || adminVaultSaving;
    syncAdminVaultProtectionControls();
}

async function selectAdminVault(id, { discardConfirmed = false } = {}) {
    if (adminVaultSaving) {
        setVaultStatus('Wait for the current vault save to finish before opening another vault.', 'info');
        return;
    }
    if (adminVaultDirty && !discardConfirmed && !window.confirm('Discard your unsaved vault edits and open another vault?')) return;
    const sequence = ++adminVaultLoadSequence;
    adminVaultRevision += 1;
    setVaultStatus('Loading readable source…', 'info');
    try {
        const data = await requestJson(`/api/admin-vaults?id=${encodeURIComponent(id)}`);
        if (sequence !== adminVaultLoadSequence) return;
        const vault = data.vault;
        activeAdminVault = vault;
        adminVaultTitle.value = vault.title || '';
        adminVaultSource.value = vault.source || '';
        adminVaultExecutions.value = String(Math.max(0, Number(vault.executions) || 0));
        adminVaultObfuscation.checked = vault.obfuscationEnabled === true;
        adminVaultLevel.value = ['auto', 'fast', 'low', 'medium', 'high', 'absolute'].includes(vault.obfuscationLevel) ? vault.obfuscationLevel : 'auto';
        adminVaultTamper.checked = vault.tamperCheckEnabled === true;
        adminVaultVm.checked = vault.vmProtectionEnabled === true;
        adminVaultSplitting.checked = vault.expandedTransformsEnabled === true;
        adminVaultDirty = false;
        clearAdminVaultPreview();
        setAdminVaultEditorEnabled(true);
        const sourceSize = (getUtf8ByteLength(vault.source) / 1024).toFixed(1);
        document.getElementById('admin-vault-meta').textContent = `ID ${vault.id} · Owner ${vault.ownerUid || 'unknown'} · ${sourceSize} KiB source · ${vault.requireKey ? 'key gated' : 'no key gate'}`;
        renderAdminVaultList();
        setVaultStatus(`Loaded ${vault.title || vault.id}. Review its source, make changes, then save to update the live vault.`, 'success');
    } catch (error) {
        if (sequence !== adminVaultLoadSequence) return;
        setVaultStatus(error.message, 'error');
        if (/session expired/i.test(error.message)) setLoggedIn(false);
    }
}

async function loadAdminVaults() {
    if (adminVaultSaving) return;
    if (adminVaultDirty && !window.confirm('Discard your unsaved vault edits and reload the vault list?')) return;
    const selectedId = activeAdminVault?.id || '';
    adminVaultDirty = false;
    activeAdminVault = null;
    adminVaultTitle.value = '';
    adminVaultSource.value = '';
    document.getElementById('admin-vault-meta').textContent = '';
    setAdminVaultEditorEnabled(false);
    clearAdminVaultPreview();
    adminVaultList.innerHTML = '<div class="info-box"><p><i class="fa-solid fa-spinner fa-spin"></i> Loading all vaults…</p></div>';
    setVaultStatus('Loading vault list…', 'info');
    try {
        const all = [];
        let cursor = '';
        do {
            const url = cursor ? `/api/admin-vaults?cursor=${encodeURIComponent(cursor)}` : '/api/admin-vaults';
            const page = await requestJson(url);
            all.push(...(Array.isArray(page.items) ? page.items : []));
            cursor = page.nextCursor || '';
        } while (cursor);
        adminVaults = all;
        renderAdminVaultList();
        if (selectedId && adminVaults.some(vault => vault.id === selectedId)) {
            await selectAdminVault(selectedId, { discardConfirmed: true });
        } else {
            setVaultStatus(`Loaded all ${adminVaults.length.toLocaleString()} saved vaults. Select one to inspect its source.`, 'success');
        }
    } catch (error) {
        adminVaultList.innerHTML = '';
        setVaultStatus(error.message, 'error');
        if (/session expired/i.test(error.message)) setLoggedIn(false);
    }
}

function safeVaultFilename(label) {
    return String(label || 'vault-script').replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'vault-script';
}

function downloadAdminText(filename, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function copyAdminText(text, textarea) {
    if (navigator.clipboard && window.isSecureContext) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch { /* Fall through to the selection-based browser copy. */ }
    }
    textarea.focus();
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.setSelectionRange(0, 0);
    return copied;
}

async function generateAdminVaultPreview() {
    if (!activeAdminVault || adminVaultSaving) return;
    if (!adminVaultSource.value.trim()) {
        setVaultStatus('The vault source cannot be empty.', 'error');
        return;
    }
    const settings = getAdminVaultObfuscationSettings();
    if (!settings.enabled) {
        setVaultStatus('Turn on obfuscation before generating an execution preview.', 'info');
        return;
    }
    const revision = adminVaultRevision;
    const signature = currentAdminVaultSignature();
    const button = document.getElementById('admin-vault-preview-btn');
    setLoading(button, true, 'OBFUSCATING…');
    try {
        const output = await obfuscateLua(adminVaultSource.value, settings.effectiveLevel, settings.protection);
        if (revision !== adminVaultRevision) return;
        const outputBytes = getUtf8ByteLength(output);
        if (outputBytes > MAX_OBFUSCATED_OUTPUT_BYTES) throw new Error('The obfuscated output is over the 32 MiB limit.');
        const inlinePreview = outputBytes <= MAX_INLINE_OBFUSCATED_PREVIEW_BYTES;
        adminVaultOutputText = output;
        adminVaultOutput.value = inlinePreview ? output : '';
        adminVaultPreviewWrap.classList.remove('hidden');
        adminVaultPreviewIsCurrent = true;
        adminVaultPreviewSignature = signature;
        document.getElementById('admin-vault-copy-output').disabled = !inlinePreview;
        document.getElementById('admin-vault-download-output').disabled = false;
        setVaultStatus(`Preview ready · ${settings.effectiveLevel} strength · ${(outputBytes / 1024).toFixed(1)} KiB.${inlinePreview ? '' : ' This large output is download-only to keep the page responsive.'}`, 'success');
    } catch (error) {
        if (revision === adminVaultRevision) setVaultStatus(`Could not obfuscate this source: ${error.message}`, 'error');
    } finally {
        setLoading(button, false);
        button.disabled = adminVaultSaving || !activeAdminVault || !adminVaultObfuscation.checked;
    }
}

async function saveAdminVault() {
    if (!activeAdminVault || adminVaultSaving) return;
    const source = adminVaultSource.value;
    if (!source.trim()) return setVaultStatus('The vault source cannot be empty.', 'error');
    if (getUtf8ByteLength(source) > MAX_VAULT_SOURCE_BYTES) return setVaultStatus('Source exceeds the 2 MiB save limit.', 'error');
    const title = adminVaultTitle.value.trim() || 'Untitled Vault';
    if (!window.confirm(`Save changes to “${title}” (${activeAdminVault.id})? This replaces the live source used by that vault's loader.`)) return;

    const settings = getAdminVaultObfuscationSettings();
    adminVaultSaving = true;
    adminVaultRevision += 1;
    const buttons = ['admin-vault-copy-source', 'admin-vault-download-source', 'admin-vault-preview-btn', 'admin-vault-save-btn', 'admin-vault-save-executions'];
    adminVaultFormControls.forEach(control => { control.disabled = true; });
    adminVaultExecutions.disabled = true;
    buttons.forEach(id => { document.getElementById(id).disabled = true; });
    const saveButton = document.getElementById('admin-vault-save-btn');
    const originalHtml = saveButton.innerHTML;
    saveButton.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> SAVING…';
    let generatedOutput = null;
    let generatedOutputBytes = 0;
    try {
        setVaultStatus(settings.enabled ? 'Generating and saving the execution copy…' : 'Saving readable source…', 'info');
        const encodedSource = await encodeVaultSource(source);
        let encodedOutput = null;
        if (settings.enabled) {
            generatedOutput = await obfuscateLua(source, settings.effectiveLevel, settings.protection);
            generatedOutputBytes = getUtf8ByteLength(generatedOutput);
            if (generatedOutputBytes > MAX_OBFUSCATED_OUTPUT_BYTES) throw new Error('The obfuscated output is over the 32 MiB limit.');
            encodedOutput = await encodeObfuscatedCode(generatedOutput);
        }
        const payload = {
            id: activeAdminVault.id,
            title,
            code: encodedSource.value,
            codeEncoding: encodedSource.encoding,
            obfuscationEnabled: settings.enabled,
            obfuscationLevel: settings.requestedLevel,
            tamperCheckEnabled: settings.protection.tamperCheck,
            vmProtectionEnabled: settings.protection.vmProtection,
            expandedTransformsEnabled: settings.protection.expandedTransforms,
            obfuscatedCodeLevel: settings.enabled ? settings.effectiveLevel : null,
            obfuscatedCode: encodedOutput?.value || null,
            obfuscatedCodeEncoding: encodedOutput?.encoding || null
        };
        await requestJson('/api/admin-vaults', { method: 'PATCH', body: JSON.stringify(payload) });
        activeAdminVault.title = title;
        activeAdminVault.source = source;
        activeAdminVault.updatedAt = Date.now();
        activeAdminVault.obfuscationEnabled = settings.enabled;
        activeAdminVault.obfuscationLevel = settings.requestedLevel;
        activeAdminVault.tamperCheckEnabled = settings.protection.tamperCheck;
        activeAdminVault.vmProtectionEnabled = settings.protection.vmProtection;
        activeAdminVault.expandedTransformsEnabled = settings.protection.expandedTransforms;
        const item = adminVaults.find(vault => vault.id === activeAdminVault.id);
        if (item) {
            item.title = title;
            item.updatedAt = activeAdminVault.updatedAt;
            item.obfuscationEnabled = settings.enabled;
        }
        adminVaultDirty = false;
        renderAdminVaultList();
        if (generatedOutput) {
            const inlinePreview = generatedOutputBytes <= MAX_INLINE_OBFUSCATED_PREVIEW_BYTES;
            adminVaultOutputText = generatedOutput;
            adminVaultOutput.value = inlinePreview ? generatedOutput : '';
            adminVaultPreviewWrap.classList.remove('hidden');
            adminVaultPreviewIsCurrent = true;
            adminVaultPreviewSignature = currentAdminVaultSignature();
            document.getElementById('admin-vault-copy-output').disabled = !inlinePreview;
            document.getElementById('admin-vault-download-output').disabled = false;
        } else {
            clearAdminVaultPreview();
        }
        setVaultStatus(`Saved “${title}”. The owner's live vault has been updated.`, 'success');
    } catch (error) {
        if (generatedOutput) {
            const inlinePreview = generatedOutputBytes <= MAX_INLINE_OBFUSCATED_PREVIEW_BYTES;
            adminVaultOutputText = generatedOutput;
            adminVaultOutput.value = inlinePreview ? generatedOutput : '';
            adminVaultPreviewWrap.classList.remove('hidden');
            adminVaultPreviewIsCurrent = true;
            adminVaultPreviewSignature = currentAdminVaultSignature();
            document.getElementById('admin-vault-copy-output').disabled = !inlinePreview;
            document.getElementById('admin-vault-download-output').disabled = false;
            setVaultStatus(`${error.message} The generated execution copy is available to download below.`, 'error');
        } else {
            setVaultStatus(error.message, 'error');
        }
        if (/session expired/i.test(error.message)) setLoggedIn(false);
    } finally {
        adminVaultSaving = false;
        adminVaultFormControls.forEach(control => { control.disabled = false; });
        setAdminVaultEditorEnabled(!!activeAdminVault);
        buttons.forEach(id => { document.getElementById(id).disabled = !activeAdminVault; });
        saveButton.innerHTML = originalHtml;
        syncAdminVaultProtectionControls();
        document.getElementById('admin-vault-copy-source').disabled = !activeAdminVault;
        document.getElementById('admin-vault-download-source').disabled = !activeAdminVault;
        document.getElementById('admin-vault-save-btn').disabled = !activeAdminVault;
        adminVaultExecutions.disabled = !activeAdminVault;
        adminVaultSaveExecutions.disabled = !activeAdminVault;
        document.getElementById('admin-vault-preview-btn').disabled = !activeAdminVault || !adminVaultObfuscation.checked;
    }
}

async function saveAdminVaultExecutions() {
    if (!activeAdminVault || adminVaultSaving) return;
    if (!adminVaultExecutions.value.trim()) {
        setVaultStatus('Enter a whole-number execution count.', 'error');
        return;
    }
    const executions = Number(adminVaultExecutions.value);
    if (!Number.isSafeInteger(executions) || executions < 0 || executions > 1_000_000_000_000) {
        setVaultStatus('Execution count must be a whole number from 0 to 1,000,000,000,000.', 'error');
        return;
    }
    if (executions === Number(activeAdminVault.executions || 0)) {
        setVaultStatus('That vault already has this execution count.', 'info');
        return;
    }
    const button = adminVaultSaveExecutions;
    setLoading(button, true, 'UPDATING…');
    adminVaultExecutions.disabled = true;
    try {
        await requestJson('/api/admin-vaults', {
            method: 'PATCH',
            body: JSON.stringify({ id: activeAdminVault.id, executions })
        });
        activeAdminVault.executions = executions;
        const item = adminVaults.find(vault => vault.id === activeAdminVault.id);
        if (item) item.executions = executions;
        renderAdminVaultList();
        const total = adminVaults.reduce((sum, vault) => sum + (Number(vault.executions) || 0), 0);
        document.getElementById('admin-stat-executions').textContent = total.toLocaleString();
        const vaultName = activeAdminVault.title || activeAdminVault.id;
        setVaultStatus(document.documentElement.lang === 'pt-BR'
            ? `A contagem acumulada de “${vaultName}” foi definida como ${executions.toLocaleString()}. O histórico diário e mensal do ranking não mudou.`
            : `Updated “${vaultName}” to ${executions.toLocaleString()} lifetime executions. Daily and monthly leaderboard history was not changed.`, 'success');
    } catch (error) {
        setVaultStatus(error.message, 'error');
        if (/session expired/i.test(error.message)) setLoggedIn(false);
    } finally {
        setLoading(button, false);
        button.disabled = !activeAdminVault;
        adminVaultExecutions.disabled = !activeAdminVault;
    }
}

function datetimeLocalValue(timestamp) {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) return '';
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function announcementLinkLabel(link, requestedLabel) {
    const label = String(requestedLabel || '').trim();
    if (label) return label;
    try {
        const host = new URL(link).hostname.toLowerCase();
        if (host === 'discord.gg' || host === 'discord.com' || host.endsWith('.discord.com')) return 'Join our Discord';
    } catch {}
    return 'Learn more';
}

function updateAnnouncementPreview() {
    const title = document.getElementById('announcement-title').value.trim();
    const message = document.getElementById('announcement-message').value.trim();
    const kind = document.getElementById('announcement-kind').value;
    const link = document.getElementById('announcement-link').value.trim();
    const label = announcementLinkLabel(link, document.getElementById('announcement-link-label').value);
    const displayMode = document.getElementById('announcement-display-mode').value;
    const dismissible = document.getElementById('announcement-dismissible').checked;
    const preview = document.getElementById('announcement-preview');
    document.getElementById('announcement-preview-stage').classList.toggle('is-modal-preview', displayMode === 'modal');
    preview.classList.remove('info', 'success', 'warning');
    preview.classList.add(['info', 'success', 'warning'].includes(kind) ? kind : 'info');
    preview.classList.toggle('modal-preview-card', displayMode === 'modal');
    document.getElementById('announcement-preview-icon').className = kind === 'success'
        ? 'fa-solid fa-circle-check promo-icon'
        : kind === 'warning' ? 'fa-solid fa-triangle-exclamation promo-icon' : 'fa-solid fa-circle-info promo-icon';
    document.getElementById('announcement-preview-title').textContent = title || 'Your announcement title';
    document.getElementById('announcement-preview-message').textContent = message || 'Your message will appear here.';
    const previewLink = document.getElementById('announcement-preview-link');
    previewLink.textContent = label;
    previewLink.classList.toggle('hidden', !link);
    previewLink.href = link || '#';
    document.getElementById('announcement-preview-dismiss').classList.toggle('hidden', !dismissible && displayMode !== 'modal');
    document.getElementById('announcement-title-count').textContent = `${title.length} / 80`;
    document.getElementById('announcement-message-count').textContent = `${message.length} / 500`;
}

function renderIdeas(ideas) {
    ideasList.innerHTML = '';
    if (!ideas.length) {
        ideasList.innerHTML = '<div class="info-box"><p>No ideas have been submitted yet.</p></div>';
        return;
    }

    ideas.forEach(idea => {
        const card = document.createElement('article');
        card.className = `admin-idea-card${idea.status === 'reviewed' ? ' reviewed' : ''}`;
        const header = document.createElement('div');
        header.className = 'admin-idea-header';
        const author = document.createElement('strong');
        author.textContent = idea.name || 'Anonymous';
        const date = document.createElement('time');
        date.textContent = formatDate(idea.createdAt);
        header.append(author, date);

        const message = document.createElement('p');
        message.textContent = idea.idea || '(Empty suggestion)';
        const actions = document.createElement('div');
        actions.className = 'admin-idea-actions';
        const badge = document.createElement('span');
        badge.className = 'admin-state-pill';
        badge.textContent = idea.status === 'reviewed' ? 'Reviewed' : 'New';
        const action = document.createElement('button');
        action.type = 'button';
        action.className = 'btn-ghost admin-idea-action';
        action.dataset.ideaId = idea.id;
        action.dataset.nextStatus = idea.status === 'reviewed' ? 'new' : 'reviewed';
        action.innerHTML = idea.status === 'reviewed'
            ? '<i class="fa-solid fa-rotate-left"></i> Reopen'
            : '<i class="fa-solid fa-check"></i> Mark reviewed';
        actions.append(badge, action);
        card.append(header, message, actions);
        ideasList.appendChild(card);
    });
}

function renderScriptReviews(items, container, reported = false) {
    container.replaceChildren();
    if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'info-box';
        const copy = document.createElement('p');
        copy.textContent = reported ? 'There are no reported public scripts.' : 'There are no scripts waiting for review.';
        empty.appendChild(copy); container.appendChild(empty); return;
    }
    items.forEach(script => {
        const card = document.createElement('article'); card.className = 'admin-script-review-item';
        const heading = document.createElement('div'); heading.className = 'admin-script-review-heading';
        const title = document.createElement('strong'); title.textContent = script.title;
        const meta = document.createElement('span'); meta.textContent = `${script.category} · ${script.game} · by ${script.authorName}`;
        heading.append(title, meta);
        const description = document.createElement('p'); description.textContent = script.description || '(No description)';
        const codeToggle = document.createElement('details'); codeToggle.className = 'admin-script-source';
        const summary = document.createElement('summary'); summary.textContent = 'Review source code';
        const code = document.createElement('pre'); code.textContent = script.code || '(No source code)';
        codeToggle.append(summary, code);
        const actionRow = document.createElement('div'); actionRow.className = 'admin-idea-actions';
        const state = document.createElement('span'); state.className = 'admin-state-pill';
        state.textContent = reported ? `${script.reports} report${script.reports === 1 ? '' : 's'}` : `Submitted ${formatDate(script.createdAt)}`;
        actionRow.appendChild(state);
        const buttons = document.createElement('div'); buttons.className = 'admin-script-review-actions';
        if (!reported) {
            const approve = document.createElement('button'); approve.type = 'button'; approve.className = 'btn-primary admin-script-review-button'; approve.dataset.scriptId = script.id; approve.dataset.nextStatus = 'approved'; approve.innerHTML = '<i class="fa-solid fa-check"></i> Approve';
            const reject = document.createElement('button'); reject.type = 'button'; reject.className = 'btn-danger admin-script-review-button'; reject.dataset.scriptId = script.id; reject.dataset.nextStatus = 'rejected'; reject.innerHTML = '<i class="fa-solid fa-xmark"></i> Reject';
            buttons.append(approve, reject);
        } else {
            const hide = document.createElement('button'); hide.type = 'button'; hide.className = 'btn-danger admin-script-review-button'; hide.dataset.scriptId = script.id; hide.dataset.nextStatus = 'hidden'; hide.innerHTML = '<i class="fa-solid fa-eye-slash"></i> Hide from library';
            buttons.appendChild(hide);
        }
        actionRow.appendChild(buttons); card.append(heading, description, codeToggle, actionRow); container.appendChild(card);
    });
}

function renderManagedScripts() {
    const query = document.getElementById('admin-script-search').value.trim().toLocaleLowerCase();
    const status = document.getElementById('admin-script-status-filter').value;
    const visible = managedScripts.filter(script => {
        if (status !== 'all' && script.status !== status) return false;
        const searchable = [script.title, script.description, script.game, script.category, script.authorName].join(' ').toLocaleLowerCase();
        return !query || searchable.includes(query);
    });
    document.getElementById('admin-managed-script-count').textContent = `${visible.length} shown · ${managedScripts.length} loaded`;
    managedScriptsList.replaceChildren();
    if (!visible.length) {
        const empty = document.createElement('div');
        empty.className = 'info-box';
        const text = document.createElement('p');
        text.textContent = managedScripts.length ? 'No scripts match these filters.' : 'No published or hidden scripts found.';
        empty.appendChild(text);
        managedScriptsList.appendChild(empty);
        return;
    }

    visible.forEach(script => {
        const card = document.createElement('article');
        card.className = 'admin-script-review-item admin-managed-script-item';
        const heading = document.createElement('div');
        heading.className = 'admin-script-review-heading';
        const title = document.createElement('strong');
        title.textContent = script.title;
        const meta = document.createElement('span');
        meta.textContent = `${script.category} · ${script.game} · by ${script.authorName}`;
        heading.append(title, meta);
        const description = document.createElement('p');
        description.textContent = script.description || '(No description)';
        const actions = document.createElement('div');
        actions.className = 'admin-managed-script-actions';
        const state = document.createElement('span');
        state.className = `admin-state-pill status-pill-${script.status}`;
        state.textContent = script.status === 'approved' ? 'Published' : script.status === 'hidden' ? 'Hidden' : 'Rejected';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = script.status === 'approved' ? 'btn-danger admin-script-review-button' : 'btn-primary admin-script-review-button';
        button.dataset.scriptId = script.id;
        button.dataset.nextStatus = script.status === 'approved' ? 'hidden' : 'approved';
        button.innerHTML = script.status === 'approved'
            ? '<i class="fa-solid fa-eye-slash"></i> Hide from library'
            : '<i class="fa-solid fa-arrow-up"></i> Publish';
        actions.append(state, button);
        card.append(heading, description, actions);
        managedScriptsList.appendChild(card);
    });
}

function fillAnnouncementForm(announcement = null) {
    selectedAnnouncementId = announcement?.id || null;
    document.getElementById('announcement-title').value = announcement?.title || '';
    document.getElementById('announcement-message').value = announcement?.message || '';
    document.getElementById('announcement-kind').value = announcement?.kind || 'info';
    document.getElementById('announcement-display-mode').value = announcement?.displayMode === 'modal' ? 'modal' : 'banner';
    document.getElementById('announcement-link').value = announcement?.link || '';
    document.getElementById('announcement-link-label').value = announcement?.linkLabel || '';
    document.getElementById('announcement-dismissible').checked = announcement?.dismissible === true;
    const expired = announcement?.expiresAt && Number(announcement.expiresAt) <= Date.now();
    document.getElementById('announcement-expires').value = expired ? '' : datetimeLocalValue(Number(announcement?.expiresAt) || 0);
    document.getElementById('announcement-clear-btn').disabled = !announcement;
    document.getElementById('announcement-publish-btn').innerHTML = announcement
        ? '<i class="fa-solid fa-floppy-disk"></i> Save changes'
        : '<i class="fa-solid fa-paper-plane"></i> Publish announcement';
    updateAnnouncementPreview();
}

function renderAnnouncements() {
    const list = document.getElementById('announcement-list');
    const activeCount = announcements.filter(item => item.enabled !== false && (!Number(item.expiresAt) || Number(item.expiresAt) > Date.now())).length;
    const portuguese = document.documentElement.lang === 'pt-BR';
    document.getElementById('announcement-state').textContent = portuguese
        ? `${activeCount} ativos · ${announcements.length} salvos`
        : `${activeCount} active · ${announcements.length} saved`;
    list.replaceChildren();
    if (!announcements.length) {
        const empty = document.createElement('div');
        empty.className = 'info-box';
        const message = document.createElement('p');
        message.textContent = 'No announcements yet. Create one to show it on the homepage.';
        empty.appendChild(message);
        list.appendChild(empty);
        return;
    }
    announcements.forEach(item => {
        const expired = item.expiresAt && Number(item.expiresAt) <= Date.now();
        const row = document.createElement('article');
        row.className = `admin-announcement-item${item.id === selectedAnnouncementId ? ' selected' : ''}`;
        const select = document.createElement('button');
        select.type = 'button';
        select.className = 'admin-announcement-select';
        select.dataset.announcementAction = 'select';
        select.dataset.announcementId = item.id;
        const title = document.createElement('strong');
        title.textContent = item.title || 'Untitled announcement';
        const meta = document.createElement('span');
        const modeText = item.displayMode === 'modal' ? (portuguese ? 'Janela central' : 'Center popup') : (portuguese ? 'Banner superior' : 'Top banner');
        const stateText = expired ? (portuguese ? 'Expirado' : 'Expired') : item.enabled === false ? (portuguese ? 'Pausado' : 'Paused') : (portuguese ? 'Ativo' : 'Active');
        meta.textContent = `${modeText} · ${stateText}`;
        select.append(title, meta);
        const actions = document.createElement('div');
        actions.className = 'admin-announcement-item-actions';
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'btn-ghost admin-announcement-item-action';
        toggle.dataset.announcementAction = 'toggle';
        toggle.dataset.announcementId = item.id;
        toggle.setAttribute('aria-label', item.enabled === false ? (portuguese ? 'Ativar aviso' : 'Activate announcement') : (portuguese ? 'Pausar aviso' : 'Pause announcement'));
        toggle.innerHTML = item.enabled === false
            ? `<i class="fa-solid fa-play"></i><span>${portuguese ? 'Ativar' : 'Activate'}</span>`
            : `<i class="fa-solid fa-pause"></i><span>${portuguese ? 'Pausar' : 'Pause'}</span>`;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'btn-danger admin-announcement-item-action';
        remove.dataset.announcementAction = 'delete';
        remove.dataset.announcementId = item.id;
        remove.setAttribute('aria-label', portuguese ? 'Excluir aviso' : 'Delete announcement');
        remove.innerHTML = `<i class="fa-solid fa-trash"></i><span>${portuguese ? 'Excluir' : 'Delete'}</span>`;
        actions.append(toggle, remove);
        row.append(select, actions);
        list.appendChild(row);
    });
}

async function loadAnnouncements(selectId = selectedAnnouncementId) {
    const data = await requestJson('/api/announcements');
    announcements = Array.isArray(data.announcements) ? data.announcements : data.announcement ? [data.announcement] : [];
    const selected = announcements.find(item => item.id === selectId) || announcements[0] || null;
    renderAnnouncements();
    fillAnnouncementForm(selected);
    renderAnnouncements();
}

async function refreshDashboard() {
    setStatus('Refreshing site data…', 'info');
    try {
        const [dashboard, scriptReviews] = await Promise.all([
            requestJson('/api/admin-dashboard'),
            requestJson('/api/admin-scripts')
        ]);
        document.getElementById('admin-stat-vaults').textContent = Number(dashboard.stats.vaults || 0).toLocaleString();
        document.getElementById('admin-stat-executions').textContent = Number(dashboard.stats.executions || 0).toLocaleString();
        document.getElementById('admin-stat-ideas').textContent = Number(dashboard.stats.ideas || 0).toLocaleString();
        document.getElementById('admin-ideas-count').textContent = `${dashboard.ideas.length} recent`;
        renderIdeas(dashboard.ideas || []);
        renderScriptReviews(scriptReviews.pending || [], pendingScriptsList);
        renderScriptReviews(scriptReviews.reported || [], reportedScriptsList, true);
        managedScripts = Array.isArray(scriptReviews.managed) ? scriptReviews.managed : [];
        renderManagedScripts();
        document.getElementById('admin-script-pending-count').textContent = String((scriptReviews.pending || []).length);
        document.getElementById('admin-script-reported-count').textContent = String((scriptReviews.reported || []).length);
        document.getElementById('admin-script-review-count').textContent = `${(scriptReviews.pending || []).length} pending · ${(scriptReviews.reported || []).length} reported`;
        await loadAdminVaults();
        try {
            await loadAnnouncements();
            statusBox.classList.add('hidden');
        } catch (error) {
            setStatus(`Dashboard loaded, but the announcement could not be loaded: ${error.message}`, 'error');
        }
        try { await loadAdminOperations(); }
        catch (error) { setOperationsStatus(`Could not load recovery or staff data: ${error.message}`, 'error'); }
    } catch (error) {
        setStatus(error.message, 'error');
        if (/session expired/i.test(error.message)) setLoggedIn(false);
    }
}

loginButton.addEventListener('click', signIn);
[usernameInput, passwordInput].forEach(input => input.addEventListener('keydown', event => {
    if (event.key === 'Enter') signIn();
}));

document.getElementById('admin-refresh-btn').addEventListener('click', refreshDashboard);
document.getElementById('admin-operations-refresh').addEventListener('click', async event => {
    setLoading(event.currentTarget, true, 'LOADING…');
    try { await loadAdminOperations(); setOperationsStatus('Recovery and staff data refreshed.', 'success'); }
    catch (error) { setOperationsStatus(error.message, 'error'); }
    finally { setLoading(event.currentTarget, false); }
});
document.getElementById('admin-staff-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    const scopes = [...form.querySelectorAll('input[name="staff-scope"]:checked')].map(input => input.value);
    setLoading(button, true, 'GRANTING…');
    try {
        const result = await requestJson('/api/admin-operations', {
            method: 'POST',
            body: JSON.stringify({
                action: 'grant_staff',
                uid: document.getElementById('admin-staff-uid').value.trim(),
                email: document.getElementById('admin-staff-email').value.trim(),
                durationHours: Number(document.getElementById('admin-staff-hours').value),
                scopes
            })
        });
        setOperationsStatus(`Staff access granted to account ${result.uid}.`, 'success');
        form.reset();
        document.getElementById('admin-staff-hours').value = '24';
        await loadAdminOperations();
    } catch (error) { setOperationsStatus(error.message, 'error'); }
    finally { setLoading(button, false); }
});
const staffScopeDependencies = [
    ['vaultSource', 'vaults'],
    ['announcementManage', 'announcements'],
    ['ideaTriage', 'ideas'],
    ['restoreTriage', 'restoreRequests'],
    ['communityModeration', 'communityScripts']
];
for (const [actionScope, viewScope] of staffScopeDependencies) {
    const actionInput = document.querySelector(`#admin-staff-form input[value="${actionScope}"]`);
    const viewInput = document.querySelector(`#admin-staff-form input[value="${viewScope}"]`);
    actionInput.addEventListener('change', () => {
        if (actionInput.checked) viewInput.checked = true;
    });
    viewInput.addEventListener('change', () => {
        if (!viewInput.checked) actionInput.checked = false;
    });
}
document.querySelector('.admin-operations-grid').addEventListener('click', async event => {
    const button = event.target.closest('button[data-operation-action]');
    if (!button) return;
    const action = button.dataset.operationAction;
    if (action.startsWith('restore')) {
        const confirmation = button.dataset.backupType === 'communityScript'
            ? 'Restore this community script backup? It will restore the saved script and its previous library visibility.'
            : 'Restore this vault backup? This replaces the saved script and obfuscation settings. Existing vaults keep their current keys and execution count. A deleted vault is recreated with its old keys cleared.';
        if (!window.confirm(confirmation)) return;
    }
    if (action === 'dismiss-request' && !window.confirm('Decline this restore request?')) return;
    if (action === 'revoke-staff' && !window.confirm('Revoke this staff member’s access now?')) return;
    setLoading(button, true, 'SAVING…');
    try {
        if (action === 'restore-backup' || action === 'restore-request') {
            const result = await requestJson('/api/admin-operations', {
                method: 'POST',
                body: JSON.stringify({ action: 'restore_backup', backupId: button.dataset.backupId, backupType: button.dataset.backupType || 'vault', requestId: button.dataset.requestId || '' })
            });
            setOperationsStatus(result.backupType === 'communityScript'
                ? `Community script restored${result.recreated ? ' from its backup' : ' to its saved state'}.`
                : result.recreated
                    ? 'Vault restored. Old loaders and keys were invalidated; create new keys before enabling access.'
                    : 'Vault restored. Old loaders were invalidated; its current keys and execution count were kept.', 'success');
        } else if (action === 'dismiss-request') {
            await requestJson('/api/admin-operations', { method: 'POST', body: JSON.stringify({ action: 'dismiss_restore_request', requestId: button.dataset.requestId }) });
            setOperationsStatus('Restore request declined.', 'success');
        } else if (action === 'revoke-staff') {
            await requestJson('/api/admin-operations', { method: 'POST', body: JSON.stringify({ action: 'revoke_staff', uid: button.dataset.uid }) });
            setOperationsStatus('Staff access revoked.', 'success');
        }
        await loadAdminOperations();
    } catch (error) { setOperationsStatus(error.message, 'error'); }
    finally { setLoading(button, false); }
});
document.getElementById('admin-vault-refresh-btn').addEventListener('click', loadAdminVaults);
adminVaultSearch.addEventListener('input', renderAdminVaultList);
adminVaultList.addEventListener('click', event => {
    const button = event.target.closest('button[data-vault-id]');
    if (button) selectAdminVault(button.dataset.vaultId);
});
adminVaultTitle.addEventListener('input', markAdminVaultDirty);
adminVaultSource.addEventListener('input', markAdminVaultDirty);
adminVaultObfuscation.addEventListener('change', () => {
    syncAdminVaultProtectionControls();
    markAdminVaultDirty();
});
adminVaultLevel.addEventListener('change', () => {
    syncAdminVaultProtectionControls();
    markAdminVaultDirty();
});
adminVaultTamper.addEventListener('change', markAdminVaultDirty);
adminVaultSplitting.addEventListener('change', markAdminVaultDirty);
adminVaultVm.addEventListener('change', () => {
    syncAdminVaultProtectionControls();
    markAdminVaultDirty();
});
adminVaultPreviewButton.addEventListener('click', generateAdminVaultPreview);
document.getElementById('admin-vault-save-btn').addEventListener('click', saveAdminVault);
adminVaultSaveExecutions.addEventListener('click', saveAdminVaultExecutions);
document.getElementById('admin-vault-copy-source').addEventListener('click', async () => {
    if (!activeAdminVault) return;
    const copied = await copyAdminText(adminVaultSource.value, adminVaultSource);
    setVaultStatus(copied ? 'Readable source copied.' : 'Copy was blocked. Select the source and copy it manually.', copied ? 'success' : 'error');
});
document.getElementById('admin-vault-download-source').addEventListener('click', () => {
    if (activeAdminVault) downloadAdminText(`${safeVaultFilename(adminVaultTitle.value || activeAdminVault.id)}_source.lua`, adminVaultSource.value);
});
document.getElementById('admin-vault-copy-output').addEventListener('click', async () => {
    if (!adminVaultPreviewIsCurrent || adminVaultPreviewSignature !== currentAdminVaultSignature()) return;
    if (!adminVaultOutput.value) return;
    const copied = await copyAdminText(adminVaultOutput.value, adminVaultOutput);
    setVaultStatus(copied ? 'Obfuscated execution copy copied.' : 'Copy was blocked. Select the output and copy it manually.', copied ? 'success' : 'error');
});
document.getElementById('admin-vault-download-output').addEventListener('click', () => {
    if (!activeAdminVault || !adminVaultPreviewIsCurrent || adminVaultPreviewSignature !== currentAdminVaultSignature()) return;
    downloadAdminText(`${safeVaultFilename(adminVaultTitle.value || activeAdminVault.id)}_obfuscated.lua`, adminVaultOutputText);
});
document.getElementById('admin-logout-btn').addEventListener('click', async () => {
    try { await requestJson('/api/admin-auth', { method: 'POST', body: JSON.stringify({ action: 'logout' }) }); }
    catch {}
    setLoggedIn(false);
    usernameInput.value = '';
    passwordInput.value = '';
    showLoginError('You are signed out.');
});

document.getElementById('announcement-new-btn').addEventListener('click', () => {
    fillAnnouncementForm(null);
    renderAnnouncements();
    document.getElementById('announcement-title').focus();
});

document.getElementById('announcement-list').addEventListener('click', async event => {
    const button = event.target.closest('button[data-announcement-action]');
    if (!button) return;
    const item = announcements.find(announcement => announcement.id === button.dataset.announcementId);
    if (!item) return;
    const action = button.dataset.announcementAction;
    if (action === 'select') {
        fillAnnouncementForm(item);
        renderAnnouncements();
        return;
    }
    if (action === 'delete') {
        if (!window.confirm(`Delete “${item.title}”?`)) return;
        setLoading(button, true, 'DELETING…');
        try {
            await requestJson('/api/announcements', { method: 'DELETE', body: JSON.stringify({ id: item.id }) });
            await loadAnnouncements(selectedAnnouncementId === item.id ? null : selectedAnnouncementId);
            setStatus('Announcement deleted.', 'success');
        } catch (error) {
            setStatus(error.message, 'error');
        } finally {
            setLoading(button, false);
        }
        return;
    }
    if (action === 'toggle') {
        setLoading(button, true, 'SAVING…');
        try {
            const result = await requestJson('/api/announcements', {
                method: 'POST',
                body: JSON.stringify({ ...item, enabled: item.enabled === false })
            });
            await loadAnnouncements(selectedAnnouncementId);
            setStatus(item.enabled === false ? 'Announcement activated.' : 'Announcement paused.', 'success');
        } catch (error) {
            setStatus(error.message, 'error');
        } finally {
            setLoading(button, false);
        }
    }
});

document.getElementById('announcement-publish-btn').addEventListener('click', async event => {
    const button = event.currentTarget;
    const expiresValue = document.getElementById('announcement-expires').value;
    const expiresAt = expiresValue ? new Date(expiresValue).getTime() : 0;
    if (expiresAt && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) {
        setStatus('Choose a future expiration time, or clear the expiry field.', 'error');
        return;
    }
    const payload = {
        ...(selectedAnnouncementId ? { id: selectedAnnouncementId } : {}),
        title: document.getElementById('announcement-title').value.trim(),
        message: document.getElementById('announcement-message').value.trim(),
        kind: document.getElementById('announcement-kind').value,
        displayMode: document.getElementById('announcement-display-mode').value,
        link: document.getElementById('announcement-link').value.trim(),
        linkLabel: announcementLinkLabel(document.getElementById('announcement-link').value.trim(), document.getElementById('announcement-link-label').value),
        dismissible: document.getElementById('announcement-dismissible').checked,
        expiresAt,
        enabled: announcements.find(item => item.id === selectedAnnouncementId)?.enabled !== false
    };
    setLoading(button, true, 'PUBLISHING…');
    try {
        const result = await requestJson('/api/announcements', { method: 'POST', body: JSON.stringify(payload) });
        setStatus(payload.enabled === false ? 'Announcement saved and paused.' : 'Announcement saved and active.', 'success');
        await loadAnnouncements(result.announcement?.id || selectedAnnouncementId);
    } catch (error) {
        setStatus(error.message, 'error');
    } finally {
        setLoading(button, false);
        button.innerHTML = selectedAnnouncementId
            ? '<i class="fa-solid fa-floppy-disk"></i> Save changes'
            : '<i class="fa-solid fa-paper-plane"></i> Publish announcement';
    }
});

document.getElementById('announcement-clear-btn').addEventListener('click', async event => {
    const button = event.currentTarget;
    if (!selectedAnnouncementId) return;
    const item = announcements.find(announcement => announcement.id === selectedAnnouncementId);
    if (!window.confirm(`Delete “${item?.title || 'this announcement'}”?`)) return;
    setLoading(button, true, 'REMOVING…');
    try {
        await requestJson('/api/announcements', { method: 'DELETE', body: JSON.stringify({ id: selectedAnnouncementId }) });
        await loadAnnouncements(null);
        setStatus('Announcement deleted.', 'success');
    } catch (error) {
        setStatus(error.message, 'error');
    } finally {
        setLoading(button, false);
    }
});

ideasList.addEventListener('click', async event => {
    const button = event.target.closest('button[data-idea-id]');
    if (!button) return;
    setLoading(button, true, 'SAVING…');
    try {
        await requestJson('/api/admin-dashboard', {
            method: 'PATCH',
            body: JSON.stringify({ id: button.dataset.ideaId, status: button.dataset.nextStatus })
        });
        await refreshDashboard();
    } catch (error) {
        setStatus(error.message, 'error');
    } finally {
        setLoading(button, false);
    }
});

document.querySelector('.admin-script-review-card').addEventListener('click', async event => {
    const button = event.target.closest('button[data-script-id]');
    if (!button) return;
    const status = button.dataset.nextStatus;
    const actionLabel = status === 'approved' ? 'publish' : status === 'rejected' ? 'reject' : 'hide';
    if (!window.confirm(`Are you sure you want to ${actionLabel} “${button.closest('.admin-script-review-item').querySelector('strong').textContent}”?`)) return;
    setLoading(button, true, 'SAVING…');
    try {
        await requestJson('/api/admin-scripts', { method: 'PATCH', body: JSON.stringify({ id: button.dataset.scriptId, status }) });
        setStatus(`Script ${status === 'approved' ? 'approved and published' : status === 'rejected' ? 'rejected' : 'hidden from the public library'}.`, 'success');
        await refreshDashboard();
    } catch (error) { setStatus(error.message, 'error'); }
    finally { setLoading(button, false); }
});

checkSession();

['announcement-title', 'announcement-message', 'announcement-kind', 'announcement-display-mode', 'announcement-link-label', 'announcement-link', 'announcement-dismissible'].forEach(id => {
    const element = document.getElementById(id);
    element.addEventListener('input', updateAnnouncementPreview);
    element.addEventListener('change', updateAnnouncementPreview);
});
document.getElementById('announcement-preview-link').addEventListener('click', event => event.preventDefault());
document.getElementById('admin-script-search').addEventListener('input', renderManagedScripts);
document.getElementById('admin-script-status-filter').addEventListener('change', renderManagedScripts);
