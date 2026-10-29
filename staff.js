import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js';

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
let latestAnnouncements = [];
let staffExpiryTimer = null;

function message(element, text, kind = 'info') {
    element.textContent = text;
    element.className = `admin-status ${kind}`;
    element.classList.remove('hidden');
}

function dateText(value) {
    try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(Number(value))); }
    catch { return 'Date unavailable'; }
}

async function api(path = '/api/staff', options = {}) {
    if (!currentUser) throw new Error('Sign in first.');
    const token = await currentUser.getIdToken();
    const headers = { ...(options.headers || {}), Authorization: `Bearer ${token}` };
    const response = await fetch(path, { ...options, cache: 'no-store', headers });
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

function clearStaffWorkspace() {
    for (const id of [
        'staff-source-list', 'staff-community-script-detail', 'staff-scope-tags', 'staff-vault-list',
        'staff-executions-daily', 'staff-announcement-list', 'staff-ideas-list', 'staff-restore-list',
        'staff-community-scripts-list'
    ]) document.getElementById(id).replaceChildren();
    latestAnnouncements = [];
    resetAnnouncementForm();
    dashboard.classList.add('hidden');
    document.getElementById('staff-grant-summary').classList.add('hidden');
}

function scheduleStaffExpiry(expiresAt) {
    if (staffExpiryTimer) clearTimeout(staffExpiryTimer);
    const checkExpiry = () => {
        const remaining = expiresAt - Date.now();
        if (remaining <= 0) {
            grantedScopes = [];
            clearStaffWorkspace();
            message(feedback, 'Staff access has expired. Ask an administrator to renew it.', 'error');
            return;
        }
        staffExpiryTimer = setTimeout(checkExpiry, Math.min(remaining, 2_000_000_000));
    };
    checkExpiry();
}

function showScopes(scopes) {
    const labels = {
        vaults: 'Vault list and settings', vaultSource: 'Readable source', executions: 'Executions',
        announcements: 'Announcements', ideas: 'Feature ideas', restoreRequests: 'Restore request status',
        communityScripts: 'Pending community scripts', announcementManage: 'Manage public announcements',
        ideaTriage: 'Triage idea status', restoreTriage: 'Claim and escalate restore requests',
        communityModeration: 'Approve or reject submissions'
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

function actionButton(label, action, id, danger = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = danger ? 'btn-danger admin-operation-action' : 'btn-ghost admin-operation-action';
    button.dataset.staffAction = action;
    if (id) button.dataset.itemId = id;
    button.textContent = label;
    return button;
}

function localDateTimeValue(timestamp) {
    const date = new Date(Number(timestamp) || 0);
    if (!Number.isFinite(date.getTime()) || !timestamp) return '';
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function resetAnnouncementForm() {
    const form = document.getElementById('staff-announcement-form');
    form.reset();
    document.getElementById('staff-announcement-id').value = '';
    document.getElementById('staff-announcement-enabled').checked = true;
    form.classList.add('hidden');
    document.getElementById('staff-announcement-new').classList.remove('hidden');
}

function fillAnnouncementForm(item = null) {
    const form = document.getElementById('staff-announcement-form');
    document.getElementById('staff-announcement-id').value = item?.id || '';
    document.getElementById('staff-announcement-title').value = item?.title || '';
    document.getElementById('staff-announcement-message').value = item?.message || '';
    document.getElementById('staff-announcement-kind').value = item?.kind || 'info';
    document.getElementById('staff-announcement-display').value = item?.displayMode === 'modal' ? 'modal' : 'banner';
    document.getElementById('staff-announcement-link').value = item?.link || '';
    document.getElementById('staff-announcement-link-label').value = item?.linkLabel || '';
    document.getElementById('staff-announcement-expires').value = item?.expired ? '' : localDateTimeValue(item?.expiresAt);
    document.getElementById('staff-announcement-dismissible').checked = item?.dismissible !== false;
    document.getElementById('staff-announcement-enabled').checked = item?.enabled !== false;
    form.classList.remove('hidden');
    document.getElementById('staff-announcement-new').classList.add('hidden');
    document.getElementById('staff-announcement-title').focus();
}

function renderAnnouncements(items, canManage) {
    latestAnnouncements = Array.isArray(items) ? items : [];
    renderList('staff-announcement-list', latestAnnouncements, item => {
        const state = item.expired ? 'Expired' : item.enabled ? 'Active' : 'Paused';
        const row = textItem(item.title, `${state} · ${item.displayMode === 'modal' ? 'Popup' : 'Banner'} · ${item.message}`);
        if (canManage) {
            const actions = document.createElement('div');
            actions.className = 'admin-operation-actions';
            const edit = actionButton('Edit', 'announcement-edit', item.id);
            const toggle = actionButton(item.enabled ? 'Pause' : 'Activate', 'announcement-toggle', item.id);
            toggle.dataset.enabled = String(!item.enabled);
            actions.append(edit, toggle);
            row.appendChild(actions);
        }
        return row;
    }, 'No announcements.');
}

function renderIdeas(items, canTriage) {
    renderList('staff-ideas-list', items, item => {
        const row = textItem(item.name, `${item.status === 'reviewed' ? 'Reviewed' : 'New'} · ${dateText(item.createdAt)} · ${item.idea}`);
        if (canTriage) {
            const button = actionButton(item.status === 'reviewed' ? 'Reopen' : 'Mark reviewed', 'idea-status', item.id);
            button.dataset.nextStatus = item.status === 'reviewed' ? 'new' : 'reviewed';
            row.appendChild(button);
        }
        return row;
    }, 'No feature ideas.');
}

function renderRestoreRequests(items, canTriage) {
    renderList('staff-restore-list', items, item => {
        const kind = item.backupType === 'communityScript' ? `Community script ${item.scriptId}` : `Vault ${item.vaultId}`;
        const assigned = item.assignedStaffEmail ? ` · Assigned to ${item.assignedStaffEmail}` : '';
        const notes = (item.staffNotes || []).map(note => `${note.email || 'Staff'}: ${note.text}`).join(' | ');
        const row = textItem(item.title, `${kind} · ${item.status} · ${dateText(item.createdAt)}${assigned}${notes ? ` · Notes: ${notes}` : ''}`);
        if (canTriage && ['pending', 'in_review', 'needs_admin'].includes(item.status)) {
            const actions = document.createElement('div');
            actions.className = 'admin-operation-actions';
            if (item.status === 'pending') actions.appendChild(actionButton('Claim', 'restore-claim', item.id));
            if (item.status === 'in_review') actions.appendChild(actionButton('Send to admin', 'restore-escalate', item.id));
            if (item.status === 'needs_admin') actions.appendChild(actionButton('Return to review', 'restore-reopen', item.id));
            row.appendChild(actions);
        }
        return row;
    }, 'No restore requests.');
}

function renderCommunityScripts(items, canModerate) {
    renderList('staff-community-scripts-list', items, item => {
        const row = textItem(item.title, `${item.game} · ${item.category} · ${item.authorName} · ${dateText(item.createdAt)} · ${item.description}`);
        const actions = document.createElement('div');
        actions.className = 'admin-operation-actions';
        actions.appendChild(actionButton('Review source', 'community-view', item.id));
        if (canModerate) {
            actions.append(actionButton('Approve', 'community-approve', item.id), actionButton('Reject', 'community-reject', item.id, true));
        }
        row.appendChild(actions);
        return row;
    }, 'No pending community scripts.');
}

// ── Source access request flow ────────────────────────────────────────────────

// Returns the latest request for a given vaultId from the cached list, or null.
function getSourceRequest(vaultId) {
    const requests = window._staffSourceRequests || [];
    // Most recent first (list is already ordered by createdAt desc from server)
    return requests.find(r => r.vaultId === vaultId) || null;
}

// Re-render every vault row's source-access button to reflect current request state.
function refreshSourceButtons() {
    document.querySelectorAll('button[data-view-source]').forEach(btn => {
        const vaultId = btn.dataset.viewSource;
        const req = getSourceRequest(vaultId);
        if (!req) {
            btn.textContent = 'Request access';
            btn.className = 'btn-ghost admin-operation-action';
            btn.disabled = false;
        } else if (req.status === 'approved') {
            btn.textContent = 'View source';
            btn.className = 'btn-ghost admin-operation-action';
            btn.disabled = false;
        } else if (req.status === 'pending') {
            btn.textContent = 'Pending admin approval…';
            btn.className = 'btn-ghost admin-operation-action';
            btn.disabled = true;
        } else if (req.status === 'denied') {
            btn.textContent = 'Denied — re-request';
            btn.className = 'btn-danger admin-operation-action';
            btn.disabled = false;
        }
    });
}

// Render the staff member's own source access requests below the vault list.
function renderMySourceRequests(requests) {
    window._staffSourceRequests = Array.isArray(requests) ? requests : [];
    const container = document.getElementById('staff-source-requests-list');
    if (!container) return;
    refreshSourceButtons();
    container.replaceChildren();
    if (!window._staffSourceRequests.length) {
        const p = document.createElement('p');
        p.className = 'creator-panel-muted';
        p.textContent = 'You have no source access requests yet.';
        container.appendChild(p);
        return;
    }
    for (const req of window._staffSourceRequests) {
        const statusLabel = { pending: '⏳ Pending', approved: '✅ Approved', denied: '❌ Denied' }[req.status] || req.status;
        const expiry = req.status === 'approved' && req.expiresAt
            ? ` · Expires ${dateText(req.expiresAt)}`
            : '';
        const adminNote = req.adminNote ? ` · Admin note: "${req.adminNote}"` : '';
        const row = textItem(
            `${req.vaultTitle} (${req.vaultId})`,
            `${statusLabel}${expiry}${adminNote} · Requested ${dateText(req.createdAt)}`
        );
        container.appendChild(row);
    }
}

// Show a prompt to request source access for a vault, then submit it.
async function requestVaultSourceAccess(vaultId, vaultTitle, button) {
    const reason = await window.vxDialog.prompt(`You need admin approval to view the source of "${vaultTitle}". Enter your reason for needing access.`, {
        title: 'Request source access',
        confirmLabel: 'Send request',
        label: 'Reason',
        hint: 'Admins see this reason when reviewing the request.',
        multiline: true,
        required: true,
        validate: value => (value.trim().length >= 8 ? '' : 'Write at least 8 characters for your reason.')
    });
    if (reason === null) return; // cancelled
    if (!reason.trim() || reason.trim().length < 8) {
        message(feedback, 'Write at least 8 characters for your reason.', 'error');
        return;
    }
    if (button) button.disabled = true;
    try {
        await api('/api/staff', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'request_source_access', vaultId, reason: reason.trim() })
        });
        // Refresh dashboard so request list and button states update
        await loadDashboard();
        message(feedback, `Source access request for "${vaultTitle}" sent to admins. You'll be able to view it once approved.`, 'success');
    } catch (error) {
        message(feedback, error.message, 'error');
        if (button) button.disabled = false;
    }
}

async function showVaultSource(vaultId, vaultTitle, button) {
    const req = getSourceRequest(vaultId);
    // If no approved request, open the request flow instead
    if (!req || req.status !== 'approved') {
        await requestVaultSourceAccess(vaultId, vaultTitle || vaultId, button);
        return;
    }
    if (button) button.disabled = true;
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
    } catch (error) {
        message(feedback, error.message, 'error');
    } finally {
        if (button) button.disabled = false;
    }
}

async function showCommunityScript(id) {
    try {
        const result = await api(`/api/staff?communityScriptId=${encodeURIComponent(id)}`);
        const item = result.data?.communityScript;
        if (!item) throw new Error('That pending script is no longer available. Refresh the panel.');
        const container = document.getElementById('staff-community-script-detail');
        container.replaceChildren();
        const details = document.createElement('details');
        details.className = 'staff-source-detail';
        details.open = true;
        const summary = document.createElement('summary');
        summary.textContent = `${item.title} · source by ${item.authorName}`;
        const description = document.createElement('p');
        description.className = 'creator-panel-muted';
        description.textContent = `${item.game} · ${item.category} · ${item.description}`;
        const code = document.createElement('pre');
        code.textContent = item.code;
        details.append(summary, description, code);
        container.appendChild(details);
    } catch (error) { message(feedback, error.message, 'error'); }
}

async function performStaffAction(button, payload, successText) {
    if (button) button.disabled = true;
    try {
        await api('/api/staff', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        await loadDashboard();
        message(feedback, successText, 'success');
    } catch (error) {
        message(feedback, error.message, 'error');
    } finally {
        if (button) button.disabled = false;
    }
}

async function handleStaffActionClick(event) {
    const button = event.target.closest('button[data-staff-action]');
    if (!button) return;
    const id = button.dataset.itemId;
    switch (button.dataset.staffAction) {
        case 'announcement-edit': {
            const item = latestAnnouncements.find(candidate => candidate.id === id);
            if (item) fillAnnouncementForm(item);
            break;
        }
        case 'announcement-toggle':
            await performStaffAction(button, { action: 'toggle_announcement', id, enabled: button.dataset.enabled === 'true' }, 'Announcement status updated.');
            break;
        case 'idea-status': {
            const status = button.dataset.nextStatus === 'new' ? 'new' : 'reviewed';
            await performStaffAction(button, { action: 'update_idea_status', id, status }, status === 'reviewed' ? 'Idea marked as reviewed.' : 'Idea reopened.');
            break;
        }
        case 'restore-claim':
        case 'restore-escalate':
        case 'restore-reopen': {
            const mode = button.dataset.staffAction;
            const promptText = mode === 'restore-escalate'
                ? 'Add a note for the administrator (at least 8 characters):'
                : 'Add an optional private note for the restore request:';
            const note = await window.vxDialog.prompt(promptText, {
                title: mode === 'restore-escalate' ? 'Escalate restore request' : 'Update restore request',
                confirmLabel: mode === 'restore-escalate' ? 'Escalate' : 'Save note',
                tone: 'warning',
                label: 'Note',
                multiline: true,
                required: mode === 'restore-escalate',
                validate: value => (mode === 'restore-escalate' && value.trim().length < 8
                    ? 'Write at least 8 characters before escalating this request.'
                    : '')
            });
            if (note === null) break;
            if (mode === 'restore-escalate' && note.trim().length < 8) {
                message(feedback, 'Write at least 8 characters before escalating this request.', 'error');
                break;
            }
            const status = mode === 'restore-escalate' ? 'needs_admin' : 'in_review';
            await performStaffAction(button, { action: 'triage_restore_request', id, status, note }, status === 'needs_admin' ? 'Restore request sent to an administrator.' : 'Restore request assigned for review.');
            break;
        }
        case 'community-view':
            await showCommunityScript(id);
            break;
        case 'community-approve':
            if (await window.vxDialog.confirm('Approve this script for the public library? A backup will be created first.', {
                title: 'Approve this script?',
                confirmLabel: 'Approve',
                tone: 'success'
            })) {
                await performStaffAction(button, { action: 'moderate_community_script', id, status: 'approved' }, 'Community script approved.');
            }
            break;
        case 'community-reject': {
            const note = await window.vxDialog.prompt('Reason for rejecting this submission.', {
                title: 'Reject this submission',
                confirmLabel: 'Reject script',
                tone: 'danger',
                label: 'Reason',
                hint: 'Shown to the submitter.',
                multiline: true,
                required: true,
                validate: value => (value.trim().length >= 8 ? '' : 'Write at least 8 characters before rejecting this submission.')
            });
            if (note === null) break;
            if (note.trim().length < 8) {
                message(feedback, 'Write at least 8 characters before rejecting this submission.', 'error');
                break;
            }
            await performStaffAction(button, { action: 'moderate_community_script', id, status: 'rejected', note }, 'Community script rejected.');
            break;
        }
    }
}

function bindStaffAnnouncementForm() {
    const form = document.getElementById('staff-announcement-form');
    form.addEventListener('submit', async event => {
        event.preventDefault();
        const expiresInput = document.getElementById('staff-announcement-expires').value;
        const expiresAt = expiresInput ? new Date(expiresInput).getTime() : 0;
        if (expiresInput && !Number.isFinite(expiresAt)) {
            message(feedback, 'Choose a valid expiration time.', 'error');
            return;
        }
        const payload = {
            action: 'save_announcement',
            id: document.getElementById('staff-announcement-id').value,
            title: document.getElementById('staff-announcement-title').value.trim(),
            message: document.getElementById('staff-announcement-message').value.trim(),
            kind: document.getElementById('staff-announcement-kind').value,
            displayMode: document.getElementById('staff-announcement-display').value,
            link: document.getElementById('staff-announcement-link').value.trim(),
            linkLabel: document.getElementById('staff-announcement-link-label').value.trim(),
            expiresAt,
            dismissible: document.getElementById('staff-announcement-dismissible').checked,
            enabled: document.getElementById('staff-announcement-enabled').checked
        };
        const submit = form.querySelector('button[type="submit"]');
        await performStaffAction(submit, payload, payload.enabled ? 'Announcement saved and published.' : 'Announcement saved and paused.');
    });
    document.getElementById('staff-announcement-new').addEventListener('click', () => fillAnnouncementForm());
    document.getElementById('staff-announcement-cancel').addEventListener('click', resetAnnouncementForm);
}

async function loadDashboard() {
    if (!currentUser) return;
    if (staffExpiryTimer) clearTimeout(staffExpiryTimer);
    const uid = currentUser.uid;
    grantedScopes = [];
    document.getElementById('staff-source-list').replaceChildren();
    document.getElementById('staff-community-script-detail').replaceChildren();
    resetAnnouncementForm();
    document.getElementById('staff-account-name').textContent = currentUser.email || 'VoidedX account';
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
        scheduleStaffExpiry(Number(result.staff.expiresAt) || 0);
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
        const canManageAnnouncements = grantedScopes.includes('announcementManage');
        const canTriageIdeas = grantedScopes.includes('ideaTriage');
        const canTriageRestore = grantedScopes.includes('restoreTriage');
        const canModerateScripts = grantedScopes.includes('communityModeration');
        document.getElementById('staff-announcement-new').classList.toggle('hidden', !canManageAnnouncements);
        document.getElementById('staff-announcement-help').classList.toggle('hidden', !canManageAnnouncements);
        document.getElementById('staff-ideas-help').classList.toggle('hidden', !canTriageIdeas);
        document.getElementById('staff-restore-help').classList.toggle('hidden', !canTriageRestore);
        document.getElementById('staff-community-scripts-help').classList.toggle('hidden', !canModerateScripts);

        document.getElementById('staff-vault-count').textContent = String(data.vaults?.length || 0);
        // Load source requests before rendering vault rows so button states are correct immediately
        renderMySourceRequests(data.sourceAccessRequests || []);
        renderList('staff-vault-list', data.vaults, item => {
            const row = textItem(item.title, `${item.id} · ${item.executions.toLocaleString()} executions · ${item.requireKey ? 'key access' : 'no key'} · ${item.paused ? 'paused' : 'active'}`);
            if (grantedScopes.includes('vaultSource')) {
                const button = document.createElement('button');
                button.type = 'button';
                button.dataset.viewSource = item.id;
                button.dataset.vaultTitle = item.title || item.id;
                // Button label/style set by refreshSourceButtons based on current request state
                button.textContent = 'Request access';
                button.className = 'btn-ghost admin-operation-action';
                row.appendChild(button);
            }
            return row;
        }, 'No vaults to show.');
        // Re-apply button states now that vault rows exist
        refreshSourceButtons();

        if (data.executions) {
            document.getElementById('staff-executions-total').textContent = Number(data.executions.lifetime || 0).toLocaleString();
            renderList('staff-executions-daily', data.executions.daily, item => textItem(item.date, `${Number(item.executions || 0).toLocaleString()} executions`), 'No daily activity yet.');
        }
        renderAnnouncements(data.announcements || [], canManageAnnouncements);
        renderIdeas(data.ideas || [], canTriageIdeas);
        renderRestoreRequests(data.restoreRequests || [], canTriageRestore);
        renderCommunityScripts(data.communityScripts || [], canModerateScripts);
    } catch (error) {
        if (!currentUser || currentUser.uid !== uid) return;
        dashboard.classList.add('hidden');
        document.getElementById('staff-grant-summary').classList.add('hidden');
        // If the server said no grant exists (or the account has no access), show a clean
        // instruction rather than a raw API error. Any other failure keeps the real message.
        const noGrant = /no staff grant|not a staff|no access|no grant|unauthori[sz]ed|forbidden/i.test(error.message);
        const userMsg = noGrant
            ? `No staff access found for this account. Give the Account ID shown above to your administrator so they can assign a grant.`
            : `${error.message} If this keeps happening, give the Account ID shown above to your administrator.`;
        message(feedback, userMsg, noGrant ? 'info' : 'error');
    }
}

async function login(action) {
    const button = document.getElementById('staff-login-btn');
    const original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> SIGNING IN…';
    try {
        await signInWithEmailAndPassword(auth, document.getElementById('staff-email').value.trim(), document.getElementById('staff-password').value);
    } catch (error) {
        message(document.getElementById('staff-auth-error'), error.message || 'Sign-in failed.', 'error');
    } finally { button.disabled = false; button.innerHTML = original; }
}

document.getElementById('staff-login-btn').addEventListener('click', () => login('email'));
document.getElementById('staff-sign-out').addEventListener('click', () => signOut(auth));
document.getElementById('staff-vault-list').addEventListener('click', event => {
    const button = event.target.closest('button[data-view-source]');
    if (button) showVaultSource(button.dataset.viewSource, button.dataset.vaultTitle, button);
});
document.getElementById('staff-dashboard').addEventListener('click', handleStaffActionClick);
bindStaffAnnouncementForm();
onAuthStateChanged(auth, user => {
    if (staffExpiryTimer) clearTimeout(staffExpiryTimer);
    currentUser = user;
    grantedScopes = [];
    loginPanel.classList.toggle('hidden', !!user);
    if (!user) {
        accountCard.classList.add('hidden');
        clearStaffWorkspace();
        document.getElementById('staff-sign-out').classList.add('hidden');
        return;
    }
    loadDashboard();
});
