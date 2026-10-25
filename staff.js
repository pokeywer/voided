import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signInAnonymously, signOut } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js';

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
const loginPanel = document.getElementById('staff-sign-in');
const accountCard = document.getElementById('staff-account-card');
const dashboard = document.getElementById('staff-dashboard');
const feedback = document.getElementById('staff-feedback');
let currentUser = null;
let grantedScopes = [];

function message(element, text, kind = 'info') {
    element.textContent = text;
    element.className = `admin-status ${kind}`;
    element.classList.remove('hidden');
}

function dateText(value) {
    try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(Number(value))); }
    catch { return 'Date unavailable'; }
}

async function api(path = '/api/staff') {
    if (!currentUser) throw new Error('Sign in first.');
    const token = await currentUser.getIdToken();
    const response = await fetch(path, { cache: 'no-store', headers: { Authorization: `Bearer ${token}` } });
    let result = {};
    try { result = await response.json(); } catch {}
    if (!response.ok || result.ok === false) throw new Error(result.message || 'Could not load staff data.');
    return result;
}

function textItem(titleText, detailText) {
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
    return row;
}

function renderList(elementId, items, makeRow, emptyText) {
    const element = document.getElementById(elementId);
    element.replaceChildren();
    if (!items?.length) {
        const empty = document.createElement('p');
        empty.className = 'creator-panel-muted';
        empty.textContent = emptyText;
        element.appendChild(empty);
        return;
    }
    for (const item of items) element.appendChild(makeRow(item));
}

function toggleSection(id, enabled) {
    document.getElementById(id).classList.toggle('hidden', !enabled);
}

function showScopes(scopes) {
    const labels = {
        vaults: 'Vault list and settings', vaultSource: 'Readable source', executions: 'Executions',
        announcements: 'Announcements', ideas: 'Feature ideas', restoreRequests: 'Restore request status',
        communityScripts: 'Pending community scripts'
    };
    const target = document.getElementById('staff-scope-tags');
    target.replaceChildren();
    for (const scope of scopes) {
        const tag = document.createElement('span');
        tag.className = 'creator-vault-tag active';
        tag.textContent = labels[scope] || scope;
        target.appendChild(tag);
    }
}

async function showVaultSource(vaultId) {
    try {
        const result = await api(`/api/staff?vaultId=${encodeURIComponent(vaultId)}`);
        const source = result.data?.vaultSource;
        if (!source) throw new Error('The vault source is unavailable.');
        let details = document.getElementById(`staff-source-${vaultId}`);
        if (!details) {
            details = document.createElement('details');
            details.id = `staff-source-${vaultId}`;
            details.className = 'staff-source-detail';
            const summary = document.createElement('summary');
            summary.textContent = `${source.title} · ${vaultId}`;
            const pre = document.createElement('pre');
            pre.textContent = source.source;
            details.append(summary, pre);
            document.getElementById('staff-source-list').appendChild(details);
        }
        details.open = true;
    } catch (error) { message(feedback, error.message, 'error'); }
}

async function loadDashboard() {
    if (!currentUser) return;
    const uid = currentUser.uid;
    grantedScopes = [];
    document.getElementById('staff-source-list').replaceChildren();
    document.getElementById('staff-account-name').textContent = currentUser.email || (currentUser.isAnonymous ? 'Guest account' : 'VoidedX account');
    document.getElementById('staff-account-uid').textContent = `Account ID: ${uid}`;
    document.getElementById('staff-account-uid').title = 'Give this account ID to the administrator for a staff grant.';
    accountCard.classList.remove('hidden');
    document.getElementById('staff-sign-out').classList.remove('hidden');
    dashboard.classList.add('hidden');
    message(feedback, 'Checking staff access…', 'info');
    try {
        const result = await api();
        if (!currentUser || currentUser.uid !== uid) return;
        grantedScopes = result.staff.scopes || [];
        document.getElementById('staff-expiry').textContent = `Staff access expires ${dateText(result.staff.expiresAt)}.`;
        showScopes(grantedScopes);
        document.getElementById('staff-grant-summary').classList.remove('hidden');
        message(feedback, 'Staff access is active for this account.', 'success');
        dashboard.classList.remove('hidden');
        const data = result.data || {};

        toggleSection('staff-vaults-section', grantedScopes.includes('vaults'));
        toggleSection('staff-executions-section', grantedScopes.includes('executions'));
        toggleSection('staff-announcements-section', grantedScopes.includes('announcements'));
        toggleSection('staff-ideas-section', grantedScopes.includes('ideas'));
        toggleSection('staff-restore-section', grantedScopes.includes('restoreRequests'));
        toggleSection('staff-community-scripts-section', grantedScopes.includes('communityScripts'));

        document.getElementById('staff-vault-count').textContent = String(data.vaults?.length || 0);
        renderList('staff-vault-list', data.vaults, item => {
            const row = textItem(item.title, `${item.id} · ${item.executions.toLocaleString()} executions · ${item.requireKey ? 'key access' : 'no key'} · ${item.paused ? 'paused' : 'active'}`);
            if (grantedScopes.includes('vaults') && grantedScopes.includes('vaultSource')) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'btn-ghost admin-operation-action';
                button.dataset.viewSource = item.id;
                button.textContent = 'View source';
                row.appendChild(button);
            }
            return row;
        }, 'No vaults to show.');

        if (data.executions) {
            document.getElementById('staff-executions-total').textContent = Number(data.executions.lifetime || 0).toLocaleString();
            renderList('staff-executions-daily', data.executions.daily, item => textItem(item.date, `${Number(item.executions || 0).toLocaleString()} executions`), 'No daily activity yet.');
        }
        renderList('staff-announcement-list', data.announcements, item => textItem(item.title, `${item.enabled ? 'Active' : 'Paused'} · ${item.message}`), 'No announcements.');
        renderList('staff-ideas-list', data.ideas, item => textItem(item.name, `${item.status} · ${dateText(item.createdAt)} · ${item.idea}`), 'No feature ideas.');
        renderList('staff-restore-list', data.restoreRequests, item => textItem(item.title, `${item.backupType === 'communityScript' ? `Community script ${item.scriptId}` : `Vault ${item.vaultId}`} · ${item.status} · ${dateText(item.createdAt)}`), 'No restore requests.');
        renderList('staff-community-scripts-list', data.communityScripts, item => textItem(item.title, `${item.game} · ${item.category} · ${dateText(item.createdAt)}`), 'No pending community scripts.');
    } catch (error) {
        if (!currentUser || currentUser.uid !== uid) return;
        dashboard.classList.add('hidden');
        document.getElementById('staff-grant-summary').classList.add('hidden');
        message(feedback, `${error.message} Your account ID is shown above so the administrator can assign access.`, 'error');
    }
}

async function login(action) {
    const button = document.getElementById(action === 'guest' ? 'staff-guest-btn' : 'staff-login-btn');
    const original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> SIGNING IN…';
    try {
        if (action === 'guest') await signInAnonymously(auth);
        else await signInWithEmailAndPassword(auth, document.getElementById('staff-email').value.trim(), document.getElementById('staff-password').value);
    } catch (error) {
        message(document.getElementById('staff-auth-error'), error.message || 'Sign-in failed.', 'error');
    } finally { button.disabled = false; button.innerHTML = original; }
}

document.getElementById('staff-login-btn').addEventListener('click', () => login('email'));
document.getElementById('staff-guest-btn').addEventListener('click', () => login('guest'));
document.getElementById('staff-sign-out').addEventListener('click', () => signOut(auth));
document.getElementById('staff-vault-list').addEventListener('click', event => {
    const button = event.target.closest('button[data-view-source]');
    if (button) showVaultSource(button.dataset.viewSource);
});
onAuthStateChanged(auth, user => {
    currentUser = user;
    grantedScopes = [];
    loginPanel.classList.toggle('hidden', !!user);
    if (!user) {
        accountCard.classList.add('hidden');
        dashboard.classList.add('hidden');
        document.getElementById('staff-source-list').replaceChildren();
        document.getElementById('staff-sign-out').classList.add('hidden');
        return;
    }
    loadDashboard();
});
