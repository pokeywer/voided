import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js';
import {
    getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signInAnonymously, signOut
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js';
import { getFirestore, collection, getDocs, query, where } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';

const firebaseConfig = {
    apiKey: 'AIzaSyBdAR4ARjHccTlxrmP9tzdYGJxo4MvETXw',
    authDomain: 'voidedx-fe79f.firebaseapp.com',
    projectId: 'voidedx-fe79f',
    storageBucket: 'voidedx-fe79f.firebasestorage.app',
    messagingSenderId: '784635868195',
    appId: '1:784635868195:web:6e879214df4238bc2aad96'
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const loginView = document.getElementById('panel-login');
const dashboard = document.getElementById('panel-dashboard');
const feedback = document.getElementById('panel-feedback');
const authError = document.getElementById('panel-auth-error');
const vaultList = document.getElementById('panel-vault-list');
const backupList = document.getElementById('panel-backup-list');
const restoreRequestList = document.getElementById('panel-restore-request-list');
const backupFeedback = document.getElementById('panel-backup-feedback');
const signInButton = document.getElementById('panel-sign-in-btn');
const signUpButton = document.getElementById('panel-sign-up-btn');
let activeUser = null;
let loadedVaults = [];

function setMessage(element, message, type = 'info') {
    element.textContent = message;
    element.className = `admin-status ${type}`;
    element.classList.remove('hidden');
}

function setBusy(button, busy, label) {
    if (busy) {
        button.dataset.savedHtml = button.innerHTML;
        button.disabled = true;
        button.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${label}`;
    } else {
        button.disabled = false;
        if (button.dataset.savedHtml) {
            button.innerHTML = button.dataset.savedHtml;
            delete button.dataset.savedHtml;
        }
    }
}

function safeDate(value) {
    const time = typeof value === 'number' ? value : value && typeof value.toMillis === 'function' ? value.toMillis() : 0;
    if (!time) return 'Date unavailable';
    try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(time)); }
    catch { return 'Date unavailable'; }
}

function makeTag(icon, label, active) {
    const tag = document.createElement('span');
    tag.className = `creator-vault-tag${active ? ' active' : ''}`;
    const glyph = document.createElement('i');
    glyph.className = `fa-solid ${icon}`;
    const text = document.createElement('span');
    text.textContent = label;
    tag.append(glyph, text);
    return tag;
}

function renderVaults() {
    vaultList.replaceChildren();
    const totalExecutions = loadedVaults.reduce((sum, vault) => sum + (Number(vault.data.executions) || 0), 0);
    document.getElementById('panel-stat-vaults').textContent = loadedVaults.length.toLocaleString();
    document.getElementById('panel-stat-executions').textContent = totalExecutions.toLocaleString();
    document.getElementById('panel-stat-protected').textContent = loadedVaults.filter(vault => vault.data.requireKey === true).length.toLocaleString();
    if (!loadedVaults.length) {
        const empty = document.createElement('div');
        empty.className = 'creator-empty-state';
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-box-open';
        const title = document.createElement('strong');
        title.textContent = 'No saved scripts yet';
        const copy = document.createElement('p');
        copy.textContent = 'Create a vault to start obfuscating scripts and configuring verification.';
        const action = document.createElement('a');
        action.className = 'btn-primary';
        action.href = '/';
        action.innerHTML = '<i class="fa-solid fa-plus"></i> Create your first script';
        empty.append(icon, title, copy, action);
        vaultList.appendChild(empty);
        return;
    }

    loadedVaults.sort((a, b) => {
        const time = item => typeof item.data.updatedAt === 'number' ? item.data.updatedAt : item.data.updatedAt?.toMillis?.() || 0;
        return time(b) - time(a);
    });
    for (const vault of loadedVaults) {
        const data = vault.data;
        const card = document.createElement('article');
        card.className = 'creator-vault-card';
        const top = document.createElement('div');
        top.className = 'creator-vault-card-top';
        const titleBlock = document.createElement('div');
        titleBlock.className = 'creator-vault-title-block';
        const mark = document.createElement('span');
        mark.className = 'creator-vault-mark';
        mark.textContent = String(data.title || 'V').trim().charAt(0).toUpperCase() || 'V';
        const titleMeta = document.createElement('div');
        const title = document.createElement('h3');
        title.textContent = String(data.title || 'Untitled Vault');
        const id = document.createElement('span');
        id.className = 'creator-vault-id';
        id.textContent = vault.id;
        titleMeta.append(title, id);
        titleBlock.append(mark, titleMeta);
        const count = document.createElement('span');
        count.className = 'creator-vault-executions';
        count.innerHTML = `<i class="fa-solid fa-play"></i> ${Math.max(0, Number(data.executions) || 0).toLocaleString()}`;
        top.append(titleBlock, count);

        const tags = document.createElement('div');
        tags.className = 'creator-vault-tags';
        tags.append(
            makeTag('fa-key', data.requireKey ? 'Verification on' : 'Verification off', data.requireKey === true),
            makeTag('fa-mask', data.obfuscationEnabled ? 'Obfuscated' : 'Readable delivery', data.obfuscationEnabled === true),
            makeTag('fa-gauge-high', `Strength ${String(data.obfuscatedCodeLevel || data.obfuscationLevel || 'auto').toUpperCase()}`, data.obfuscationEnabled === true),
            makeTag('fa-shield-halved', data.vmProtectionEnabled ? 'VM pass' : data.tamperCheckEnabled ? 'Tamper check' : 'Extra checks off', data.vmProtectionEnabled === true || data.tamperCheckEnabled === true),
            makeTag('fa-code-branch', data.expandedTransformsEnabled ? 'String splitting' : 'Default transforms', data.expandedTransformsEnabled === true),
            makeTag('fa-clock', `Updated ${safeDate(data.updatedAt)}`, false)
        );

        const actions = document.createElement('div');
        actions.className = 'creator-vault-actions';
        const edit = document.createElement('a');
        edit.className = 'btn-primary';
        edit.href = `/?vault=${encodeURIComponent(vault.id)}`;
        edit.innerHTML = '<i class="fa-solid fa-code"></i> Edit & obfuscate';
        const verify = document.createElement('a');
        verify.className = 'btn-ghost';
        verify.href = `/keysystem.html?id=${encodeURIComponent(vault.id)}`;
        verify.innerHTML = '<i class="fa-solid fa-key"></i> Verification & access';
        actions.append(edit, verify);
        card.append(top, tags, actions);
        vaultList.appendChild(card);
    }
}

async function loadVaults() {
    if (!activeUser) return;
    setMessage(feedback, 'Loading your vaults…', 'info');
    vaultList.innerHTML = '<div class="creator-loading"><i class="fa-solid fa-spinner fa-spin"></i><span>Loading your scripts…</span></div>';
    try {
        const snapshot = await getDocs(query(collection(db, 'vaults'), where('uid', '==', activeUser.uid)));
        if (!activeUser || auth.currentUser?.uid !== activeUser.uid) return;
        loadedVaults = snapshot.docs.map(item => ({ id: item.id, data: item.data() }));
        renderVaults();
        feedback.classList.add('hidden');
    } catch (error) {
        console.error('Could not load creator vaults:', error);
        loadedVaults = [];
        vaultList.replaceChildren();
        setMessage(feedback, `Could not load your scripts: ${error.message || 'Check your connection and database access.'}`, 'error');
    }
}

async function ownerApi(path, options = {}) {
    if (!activeUser) throw new Error('Sign in first.');
    const token = await activeUser.getIdToken();
    const response = await fetch(path, {
        cache: 'no-store',
        ...options,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(options.headers || {}) }
    });
    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok || data.ok === false) throw new Error(data.message || 'Could not complete the request.');
    return data;
}

function recoveryRow(titleText, detailText, action = null) {
    const row = document.createElement('article');
    row.className = 'creator-recovery-item';
    const copy = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = titleText;
    const detail = document.createElement('span');
    detail.textContent = detailText;
    copy.append(title, detail);
    row.appendChild(copy);
    if (action) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn-ghost';
        button.dataset.backupAction = action.action;
        button.dataset.backupId = action.backupId || '';
        button.dataset.backupType = action.backupType || 'vault';
        button.textContent = action.label;
        button.disabled = action.disabled === true;
        row.appendChild(button);
    }
    return row;
}

async function loadBackups() {
    if (!activeUser) return;
    backupList.innerHTML = '<div class="creator-loading"><i class="fa-solid fa-spinner fa-spin"></i><span>Loading your backups…</span></div>';
    restoreRequestList.replaceChildren();
    try {
        const result = await ownerApi('/api/vault-backups');
        const pendingIds = new Set((result.requests || []).filter(item => item.status === 'pending')
            .map(item => `${item.backupType || 'vault'}:${item.backupId}`));
        backupList.replaceChildren();
        const allBackups = [
            ...(result.backups || []).map(item => ({ ...item, backupType: 'vault' })),
            ...(result.scriptBackups || []).map(item => ({ ...item, backupType: 'communityScript' }))
        ].sort((a, b) => b.createdAt - a.createdAt);
        if (!allBackups.length) {
            const empty = document.createElement('p');
            empty.className = 'creator-panel-muted';
            empty.textContent = 'No backups yet. A vault backup is created when you next edit or delete it. Community upload backups are created before removal or moderation changes.';
            backupList.appendChild(empty);
        } else {
            for (const item of allBackups) {
                const date = item.createdAt ? safeDate(item.createdAt) : 'Date unavailable';
                const isScript = item.backupType === 'communityScript';
                const resourceId = isScript ? item.scriptId : item.vaultId;
                const requestKey = `${item.backupType}:${item.id}`;
                backupList.appendChild(recoveryRow(item.title || (isScript ? 'Untitled script' : 'Untitled Vault'), `${isScript ? 'Community script' : 'Vault'} ${resourceId} · ${String(item.reason || 'backup').replaceAll('_', ' ')} · ${date}`, {
                    action: 'request-restore', backupId: item.id, backupType: item.backupType,
                    label: pendingIds.has(requestKey) ? 'Request pending' : 'Request restore',
                    disabled: pendingIds.has(requestKey)
                }));
            }
        }
        if (!result.requests?.length) {
            const empty = document.createElement('p');
            empty.className = 'creator-panel-muted';
            empty.textContent = 'You have not requested a restore.';
            restoreRequestList.appendChild(empty);
        } else {
            for (const item of result.requests) {
                const isScript = item.backupType === 'communityScript';
                const resourceId = isScript ? item.scriptId : item.vaultId;
                restoreRequestList.appendChild(recoveryRow(item.title || (isScript ? 'Untitled script' : 'Untitled Vault'), `${isScript ? 'Community script' : 'Vault'} ${resourceId} · ${item.status} · ${safeDate(item.createdAt)}`));
            }
        }
        backupFeedback.classList.add('hidden');
    } catch (error) {
        backupList.replaceChildren();
        setMessage(backupFeedback, error.message, 'error');
    }
}

async function authenticate(button, createAccount = false) {
    const email = document.getElementById('panel-email').value.trim();
    const password = document.getElementById('panel-password').value;
    authError.classList.add('hidden');
    if (!email || !password) {
        setMessage(authError, 'Enter your email and password first.', 'error');
        return;
    }
    setBusy(button, true, createAccount ? 'CREATING…' : 'SIGNING IN…');
    try {
        if (createAccount) await createUserWithEmailAndPassword(auth, email, password);
        else await signInWithEmailAndPassword(auth, email, password);
    } catch (error) {
        const messages = {
            'auth/invalid-email': 'That email address is not valid.',
            'auth/invalid-credential': 'Email or password is incorrect.',
            'auth/email-already-in-use': 'That email already has an account. Sign in instead.',
            'auth/weak-password': 'Use a stronger password with at least 6 characters.',
            'auth/too-many-requests': 'Too many attempts. Wait a little and try again.',
            'auth/network-request-failed': 'Network error. Check your connection and retry.'
        };
        setMessage(authError, messages[error.code] || error.message || 'Sign-in failed.', 'error');
    } finally {
        setBusy(button, false);
    }
}

signInButton.addEventListener('click', () => authenticate(signInButton));
signUpButton.addEventListener('click', () => authenticate(signUpButton, true));
document.getElementById('panel-guest-btn').addEventListener('click', async event => {
    setBusy(event.currentTarget, true, 'OPENING GUEST…');
    try { await signInAnonymously(auth); }
    catch (error) { setMessage(authError, error.message || 'Guest sign-in failed.', 'error'); }
    finally { setBusy(event.currentTarget, false); }
});
document.getElementById('panel-password').addEventListener('keydown', event => {
    if (event.key === 'Enter') authenticate(signInButton);
});
document.getElementById('panel-refresh-btn').addEventListener('click', loadVaults);
document.getElementById('panel-backups-refresh').addEventListener('click', loadBackups);
backupList.addEventListener('click', async event => {
    const button = event.target.closest('button[data-backup-action="request-restore"]');
    if (!button || button.disabled || !activeUser) return;
    setBusy(button, true, 'SENDING…');
    try {
        const result = await ownerApi('/api/vault-backups', { method: 'POST', body: JSON.stringify({ action: 'request_restore', backupId: button.dataset.backupId, backupType: button.dataset.backupType || 'vault' }) });
        setMessage(backupFeedback, result.alreadyRequested ? 'A restore request for this backup is already waiting.' : 'Restore request sent. An administrator will review it.', 'success');
        await loadBackups();
    } catch (error) { setMessage(backupFeedback, error.message, 'error'); }
    finally { setBusy(button, false); }
});
document.getElementById('panel-logout-btn').addEventListener('click', () => signOut(auth));

onAuthStateChanged(auth, user => {
    activeUser = user;
    const isAccount = !!user;
    loginView.classList.toggle('hidden', isAccount);
    dashboard.classList.toggle('hidden', !isAccount);
    document.getElementById('panel-logout-btn').classList.toggle('hidden', !isAccount);
    if (isAccount) {
        document.getElementById('panel-user-label').textContent = user.email || `Guest account · ${user.uid}`;
        loadVaults();
        loadBackups();
    } else {
        loadedVaults = [];
        vaultList.replaceChildren();
        backupList.replaceChildren();
        restoreRequestList.replaceChildren();
    }
});
