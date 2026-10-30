import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js';
import {
    getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged,
    GoogleAuthProvider, signInWithPopup, linkWithPopup, signInWithCredential
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js';
import {
    getFirestore, collection, doc, setDoc, addDoc, getDoc, getDocs, deleteDoc, updateDoc, query, where, serverTimestamp, runTransaction
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import { obfuscateLua, resolveObfuscationLevel, describeObfuscationError, encodeObfuscatedCode, encodeVaultSource, decodeVaultSource, getUtf8ByteLength, MAX_VAULT_SOURCE_BYTES, MAX_OBFUSCATED_OUTPUT_BYTES, MAX_INLINE_OBFUSCATED_PREVIEW_BYTES, MAX_VAULT_DOCUMENT_ESTIMATE_BYTES } from './lua-medium.js';
import { setEmbeddedTokenLoader } from './loader-ui.js';
import { createDashboardTelemetry } from './dashboard-telemetry.js';

// --- YOUR FIREBASE CONFIG HERE ---
const firebaseConfig = {
    apiKey: "AIzaSyBdAR4ARjHccTlxrmP9tzdYGJxo4MvETXw",
    authDomain: "voidedx-fe79f.firebaseapp.com",
    projectId: "voidedx-fe79f",
    storageBucket: "voidedx-fe79f.firebasestorage.app",
    messagingSenderId: "784635868195",
    appId: "1:784635868195:web:6e879214df4238bc2aad96"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

let currentUser = null;
let isSignUpMode = false;
const ZERO_EXECUTION_VAULT_TTL_MS = 10 * 60 * 60 * 1000;
const MAX_USER_VAULTS = 5;
const vaultExpiryTimers = new Map();
const vaultExpiryWarningIds = new Set();
let vaultsLoadedForUid = null;
let editorLoadGeneration = 0;
let requestedVaultOpened = false;
const requestedVaultId = new URLSearchParams(window.location.search).get('vault');

// ============================================================
// Small reusable UI helpers (toasts, field errors, confirm modal)
// ============================================================

function showToast(message, type = 'info', duration = 4000) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const icons = { success: 'fa-circle-check', error: 'fa-circle-exclamation', info: 'fa-circle-info', warning: 'fa-triangle-exclamation' };
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
        <i class="fa-solid ${icons[type] || icons.info} toast-icon"></i>
        <span>${message}</span>
        <button class="toast-close" aria-label="Dismiss"><i class="fa-solid fa-xmark"></i></button>
    `;

    const remove = () => {
        toast.classList.add('leaving');
        setTimeout(() => toast.remove(), 200);
    };

    toast.querySelector('.toast-close').addEventListener('click', remove);
    container.appendChild(toast);

    if (duration > 0) setTimeout(remove, duration);
}

function setFieldError(inputEl, errorEl, message) {
    if (inputEl) inputEl.classList.add('error');
    if (errorEl) {
        errorEl.textContent = message;
        errorEl.classList.remove('hidden');
    }
}

function clearFieldError(inputEl, errorEl) {
    if (inputEl) inputEl.classList.remove('error');
    if (errorEl) {
        errorEl.textContent = '';
        errorEl.classList.add('hidden');
    }
}

function shakeElement(el) {
    if (!el) return;
    el.classList.remove('shake-error');
    // force reflow so the animation can restart if triggered repeatedly
    void el.offsetWidth;
    el.classList.add('shake-error');
    setTimeout(() => el.classList.remove('shake-error'), 450);
}

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Translates raw Firebase Auth error codes into human, actionable copy.
function friendlyAuthError(err) {
    const code = err && err.code ? err.code : '';
    switch (code) {
        case 'auth/invalid-email':
            return "That email address doesn't look valid.";
        case 'auth/user-not-found':
        case 'auth/wrong-password':
        case 'auth/invalid-credential':
            return 'Incorrect email or password. Double-check and try again.';
        case 'auth/email-already-in-use':
            return 'An account with this email already exists — try logging in instead.';
        case 'auth/weak-password':
            return 'That password is too weak — use at least 6 characters.';
        case 'auth/too-many-requests':
            return 'Too many attempts. Please wait a moment before trying again.';
        case 'auth/network-request-failed':
            return "Network error — check your connection and try again.";
        case 'auth/user-disabled':
            return 'This account has been disabled. Contact support if that seems wrong.';
        case 'auth/operation-not-allowed':
            return 'Google sign-in is not enabled yet. Turn it on in your authentication settings.';
        case 'auth/unauthorized-domain':
            return 'This website domain is not approved for Google sign-in. Add it to your authorized domains.';
        case 'auth/popup-blocked':
            return 'Your browser blocked the Google sign-in window. Allow popups for this site and try again.';
        case 'auth/popup-closed-by-user':
            return 'Google sign-in was closed before it finished.';
        case 'auth/account-exists-with-different-credential':
            return 'This Google email already uses a different sign-in method. Log in with that method first.';
        default:
            return (err && err.message ? err.message.replace(/^Firebase:\s*/i, '') : 'Something went wrong. Please try again.');
    }
}

async function loadSiteAnnouncement() {
    const bannerList = document.getElementById('site-announcements');
    if (!bannerList) return;
    try {
        const response = await fetch('/api/announcements');
        if (!response.ok) return;
        const data = await response.json();
        const items = Array.isArray(data?.announcements)
            ? data.announcements
            : data?.announcement ? [data.announcement] : [];
        const current = items.filter(item => item && item.message && item.enabled !== false && (!Number(item.expiresAt) || Number(item.expiresAt) > Date.now()));
        const dismissalKey = item => `voidedx-announcement-dismissed-${item.id || 'legacy'}-${item.updatedAt || item.message}`;
        const isDismissed = item => {
            try { return localStorage.getItem(dismissalKey(item)) === '1'; } catch { return false; }
        };
        const markDismissed = item => {
            try { localStorage.setItem(dismissalKey(item), '1'); } catch {}
        };
        const visible = current.filter(item => !(item.displayMode === 'modal' || item.dismissible) || !isDismissed(item));
        const banners = visible.filter(item => item.displayMode !== 'modal');
        bannerList.replaceChildren();

        const announcementKind = item => ['info', 'success', 'warning'].includes(item.kind) ? item.kind : 'info';
        const iconFor = kind => kind === 'success' ? 'fa-solid fa-circle-check'
            : kind === 'warning' ? 'fa-solid fa-triangle-exclamation' : 'fa-solid fa-circle-info';
        const setLink = (element, item) => {
            if (!item.link) return;
            try {
                const parsed = new URL(item.link, window.location.origin);
                if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
                element.href = parsed.href;
                element.textContent = item.linkLabel || 'Learn more';
                element.classList.remove('hidden');
            } catch {}
        };

        banners.forEach(item => {
            const kind = announcementKind(item);
            const card = document.createElement('div');
            card.className = `site-announcement ${kind}`;
            card.setAttribute('role', 'status');
            const icon = document.createElement('i');
            icon.className = iconFor(kind);
            icon.setAttribute('aria-hidden', 'true');
            const copy = document.createElement('div');
            copy.className = 'site-announcement-copy';
            const title = document.createElement('strong');
            title.textContent = item.title || 'VoidedX update';
            const message = document.createElement('span');
            message.textContent = item.message;
            copy.append(title, message);
            card.append(icon, copy);
            const link = document.createElement('a');
            link.className = 'site-announcement-link hidden';
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            setLink(link, item);
            if (!link.classList.contains('hidden')) card.appendChild(link);
            if (item.dismissible === true) {
                const dismiss = document.createElement('button');
                dismiss.className = 'site-announcement-dismiss';
                dismiss.type = 'button';
                dismiss.setAttribute('aria-label', document.documentElement.lang === 'pt-BR' ? 'Dispensar aviso' : 'Dismiss announcement');
                dismiss.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';
                dismiss.addEventListener('click', () => { markDismissed(item); card.remove(); });
                card.appendChild(dismiss);
            }
            bannerList.appendChild(card);
        });

        const modalItems = visible.filter(item => item.displayMode === 'modal');
        const modal = document.getElementById('site-announcement-modal');
        const dialog = document.getElementById('site-announcement-dialog');
        const closeButton = document.getElementById('site-announcement-modal-dismiss');
        const countdown = document.getElementById('site-announcement-countdown');
        if (!modal || !dialog || !closeButton || !countdown) return;

        for (const item of modalItems) {
            const kind = announcementKind(item);
            document.getElementById('site-announcement-modal-title').textContent = item.title || 'VoidedX update';
            document.getElementById('site-announcement-modal-message').textContent = item.message;
            document.getElementById('site-announcement-modal-icon').className = `${iconFor(kind)} site-announcement-modal-icon ${kind}`;
            dialog.classList.remove('info', 'success', 'warning');
            dialog.classList.add(kind);
            const link = document.getElementById('site-announcement-modal-link');
            link.classList.add('hidden');
            setLink(link, item);
            closeButton.disabled = true;
            modal.classList.remove('hidden');
            modal.setAttribute('aria-hidden', 'false');
            dialog.focus();

            await new Promise(resolve => {
                const deadline = Date.now() + 5000;
                let unlocked = false;
                let timerId = null;
                let finished = false;
                const finish = () => {
                    if (finished) return;
                    finished = true;
                    if (timerId !== null) clearInterval(timerId);
                    document.removeEventListener('keydown', onModalKeydown);
                    modal.removeEventListener('click', onBackdropClick);
                    document.removeEventListener('voidedx:languagechange', updateCountdown);
                    closeButton.onclick = null;
                    markDismissed(item);
                    modal.classList.add('hidden');
                    modal.setAttribute('aria-hidden', 'true');
                    resolve();
                };
                const updateCountdown = () => {
                    const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
                    const portuguese = document.documentElement.lang === 'pt-BR';
                    countdown.textContent = unlocked ? (portuguese ? 'Fechar' : 'Close')
                        : (portuguese ? `Aguarde ${seconds}s…` : `Wait ${seconds}s…`);
                    closeButton.setAttribute('aria-label', unlocked
                        ? (portuguese ? 'Fechar aviso' : 'Close announcement')
                        : (portuguese ? 'Aguarde cinco segundos para fechar' : 'Wait five seconds to close'));
                    if (seconds === 0 && !unlocked) {
                        unlocked = true;
                        closeButton.disabled = false;
                        if (timerId !== null) { clearInterval(timerId); timerId = null; }
                    }
                };
                const onModalKeydown = event => { if (event.key === 'Escape' && unlocked) finish(); };
                const onBackdropClick = event => { if (event.target === modal && unlocked) finish(); };
                closeButton.onclick = () => { if (unlocked) finish(); };
                document.addEventListener('keydown', onModalKeydown);
                modal.addEventListener('click', onBackdropClick);
                document.addEventListener('voidedx:languagechange', updateCountdown);
                updateCountdown();
                timerId = setInterval(updateCountdown, 200);
            });
        }
    } catch {
        // Public pages remain usable if announcements are temporarily unavailable.
    }
}

// Start the backup download directly from the Save button click. Browsers can
// block downloads triggered only after the later Firebase requests complete.
function downloadLocalVaultBackup(vaultId, title, code) {
    let blobUrl = '';
    let link = null;
    try {
        const getKeyLine = vaultId
            ? `Get-key page: ${window.location.origin}/key.html?id=${encodeURIComponent(vaultId)}`
            : 'Get-key page: Available after this draft is saved.';
        const backupTxt = [
            '==================================================',
            'VOIDEDX VAULT BACKUP',
            `Title: ${String(title).replace(/[\r\n]+/g, ' ')}`,
            `Vault ID: ${vaultId || 'Not saved yet'}`,
            getKeyLine,
            'For protected vaults, copy the current loader from VoidedX after saving.',
            '==================================================',
            code
        ].join('\n');
        const safeVaultId = String(vaultId || 'draft').replace(/[^a-z0-9_-]/gi, '_').slice(0, 80) || 'vault';
        blobUrl = URL.createObjectURL(new Blob([backupTxt], { type: 'text/plain;charset=utf-8' }));
        link = document.createElement('a');
        link.href = blobUrl;
        link.download = `${safeVaultId}_backup.txt`;
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        link.remove();
        // Let the browser finish consuming the Blob URL before releasing it.
        window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
        return true;
    } catch (error) {
        if (link) link.remove();
        if (blobUrl) URL.revokeObjectURL(blobUrl);
        console.warn('Could not start the local vault backup download:', error);
        return false;
    }
}

async function createRemoteVaultBackup(vaultId, reason = 'before_save') {
    if (!currentUser || !vaultId) throw new Error('Sign in before creating a vault backup.');
    const idToken = await currentUser.getIdToken();
    const response = await fetch('/api/vault-backups', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ action: 'snapshot', vaultId, reason })
    });
    let result = {};
    try { result = await response.json(); } catch {}
    if (!response.ok || result.ok !== true) {
        throw new Error(result.message || 'Could not create the server backup. Your vault was not changed.');
    }
    return result.backup;
}

// Promise-based confirm that uses the shared themed dialog.
function customConfirm({ title, message, confirmLabel = 'Delete' }) {
    if (window.vxDialog) return window.vxDialog.confirm(message, { title, confirmLabel, tone: 'danger' });
    return Promise.resolve(window.confirm(`${title}\n\n${message}`));
}

// ============================================================
// Main app
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
    loadSiteAnnouncement();

    // If opened from Discord /obfuscate, pre-load the queued script into the editor.
    (async () => {
        const params = new URLSearchParams(location.search);
        const obfKey = params.get('obfuscate');
        if (!obfKey || !/^[a-f0-9]{32}$/.test(obfKey)) return;
        // Remove the param from the URL so reload doesn't re-trigger
        history.replaceState({}, '', location.pathname);
        try {
            const res  = await fetch(`/api/discord-obfuscate-pickup?key=${obfKey}`, { credentials: 'same-origin', cache: 'no-store' });
            const data = await res.json();
            if (!data.ok) throw new Error(data.message || 'Could not load script from Discord.');
            // Wait until the editor exists in the DOM
            let tries = 0;
            while (!document.getElementById('source-code') && tries++ < 40) {
                await new Promise(r => setTimeout(r, 250));
            }
            const srcEl = document.getElementById('source-code');
            const lvlEl = document.getElementById('obfuscation-level');
            const chkEl = document.getElementById('chk-obfuscation');
            if (srcEl) {
                srcEl.value = data.source;
                srcEl.dispatchEvent(new Event('input', { bubbles: true }));
            }
            if (lvlEl && data.level) lvlEl.value = data.level;
            if (chkEl) { chkEl.checked = true; chkEl.dispatchEvent(new Event('change', { bubbles: true })); }
            showToast(`Script loaded from Discord (${data.filename}). Choose your settings and preview/download.`, 'success', 7000);
        } catch (err) {
            showToast(`Discord obfuscate: ${err.message}`, 'error', 6000);
        }
    })();

    const lockBtn = document.getElementById('lock-vault-btn');
    const newVaultBtn = document.getElementById('new-vault-btn');
    const deleteBtn = document.getElementById('delete-vault-btn');
    const sourceCode = document.getElementById('source-code');
    const codeError = document.getElementById('code-error');
    const mobileVaultSettings = document.getElementById('mobile-vault-settings');
    const mobileEditorQuery = window.matchMedia('(max-width: 768px)');
    // On phones: collapse the long settings panel and soft-wrap the source so
    // the textarea stays reachable above the keyboard.
    const syncEditorLayout = () => {
        const mobile = mobileEditorQuery.matches;
        sourceCode.wrap = mobile ? 'soft' : 'off';
        if (window.VoidedXEditor) window.VoidedXEditor.applyViewport(mobile);
        if (mobileVaultSettings) mobileVaultSettings.open = !mobile;
    };
    syncEditorLayout();
    if (mobileEditorQuery.addEventListener) mobileEditorQuery.addEventListener('change', syncEditorLayout);
    const scriptTitle = document.getElementById('script-title');
    const titleError = document.getElementById('title-error');
    const resultOverlay = document.getElementById('result-overlay');
    const editorSaveStatus = document.getElementById('editor-save-status');
    const editorSaveLabel = document.getElementById('editor-save-label');
    const lsOutput = document.getElementById('ls-output');
    const copyBtn = document.getElementById('copy-out-btn');
    const getKeyRow = document.getElementById('get-key-row');
    const getKeyOutput = document.getElementById('get-key-output');
    const copyKeyLinkBtn = document.getElementById('copy-key-link-btn');
    const chkBackup = document.getElementById('chk-backup');
    const chkObfuscation = document.getElementById('chk-obfuscation');
    const chkFastLoadCache = document.getElementById('chk-fast-load-cache');
    const obfuscationLevelSelect = document.getElementById('obfuscation-level');
    const obfuscationLayersSelect = document.getElementById('obfuscation-layers');
    const obfuscationJunkSelect = document.getElementById('obfuscation-junk');
    const obfuscationLayoutSelect = document.getElementById('obfuscation-layout');
    const chkTamperCheck = document.getElementById('chk-tamper-check');
    const chkInstantRun = document.getElementById('chk-instant-run');
    const chkVmProtection = document.getElementById('chk-vm-protection');
    const chkExpandedTransforms = document.getElementById('chk-expanded-transforms');
    const chkJunkComments = document.getElementById('chk-junk-comments');
    const backupNowBtn = document.getElementById('backup-now-btn');
    const previewObfuscatedBtn = document.getElementById('preview-obfuscated-btn');
    const obfuscatedPreviewPanel = document.getElementById('obfuscated-preview-panel');
    const obfuscatedPreview = document.getElementById('obfuscated-preview');
    const obfuscatedPreviewStatus = document.getElementById('obfuscated-preview-status');
    const copyObfuscatedBtn = document.getElementById('copy-obfuscated-btn');
    const downloadObfuscatedBtn = document.getElementById('download-obfuscated-btn');
    const protectionKeyStatus = document.getElementById('protection-key-status');
    const openKeysystemBtn = document.getElementById('open-keysystem-btn');
    const keysystemStatusBadge = document.getElementById('keysystem-status-badge');
    const activeVaultId = document.getElementById('active-vault-id');
    const editingIndicator = document.getElementById('editing-indicator');
    const vaultListContainer = document.getElementById('vault-list');
    const vaultListToggle = document.getElementById('vault-list-toggle');
    const vaultListPanel = document.getElementById('vault-list-panel');
    const vaultListCount = document.getElementById('vault-list-count');
    const vaultSearch = document.getElementById('vault-search');
    if (vaultSearch) {
        // Clear stale browser-restored credentials and keep password managers
        // away until the user deliberately focuses the search box.
        vaultSearch.value = '';
        vaultSearch.readOnly = true;
    }
    const vaultSort = document.getElementById('vault-sort');
    const vaultFilter = document.getElementById('vault-filter');
    const vaultStatTotal = document.getElementById('vault-stat-total');
    const vaultStatExecutions = document.getElementById('vault-stat-executions');
    const vaultStatProtected = document.getElementById('vault-stat-protected');
    const dashEls = {
        greeting: document.getElementById('dash-greeting'),
        vaults: document.getElementById('dash-stat-vaults'),
        executions: document.getElementById('dash-stat-executions'),
        protected: document.getElementById('dash-stat-protected'),
        updated: document.getElementById('dash-stat-updated'),
        updatedNote: document.getElementById('dash-stat-updated-note'),
        keysNote: document.getElementById('dash-keys-note'),
        keysPill: document.getElementById('dash-keys-pill'),
        topVaults: document.getElementById('dash-top-vaults'),
        vaultList: document.getElementById('dash-vault-list')
    };
    const execCountBadge = document.getElementById('exec-count-badge');
    const execCountNum = document.getElementById('exec-count-num');
    const promoShareBtn = document.getElementById('promo-share-btn');
    const editorSourceContext = document.getElementById('editor-source-context');
    let clearActiveLoaderBinding = null;
    let obfuscationRevision = 0;
    let obfuscatedPreviewIsCurrent = false;
    let obfuscatedPreviewText = '';

    function refreshVaultLoader(id, key = '') {
        if (clearActiveLoaderBinding) clearActiveLoaderBinding();
        clearActiveLoaderBinding = null;
        if (!id) {
            lsOutput.value = '';
            copyBtn.disabled = true;
            return;
        }
        lsOutput.value = '';
        copyBtn.disabled = true;
        clearActiveLoaderBinding = setEmbeddedTokenLoader({ id, key, input: lsOutput, copyButton: copyBtn });
    }

    function getObfuscationSettings(code) {
        const enabled = !!(chkObfuscation && chkObfuscation.checked);
        const requestedLevel = obfuscationLevelSelect ? obfuscationLevelSelect.value : 'auto';
        const absoluteMode = enabled && requestedLevel === 'absolute';
        const fastMode = enabled && requestedLevel === 'fast';
        const vmProtection = enabled;
        const layerChoice = Math.floor(Number(obfuscationLayersSelect ? obfuscationLayersSelect.value : ''));
        const protection = {
            tamperCheck: absoluteMode || !!(chkTamperCheck && chkTamperCheck.checked),
            vmProtection,
            expandedTransforms: absoluteMode || (!fastMode && !!(chkExpandedTransforms && chkExpandedTransforms.checked)),
            layers: Number.isFinite(layerChoice) && layerChoice > 0 ? layerChoice : 0,
            junk: ['off', 'normal', 'heavy'].includes(obfuscationJunkSelect?.value) ? obfuscationJunkSelect.value : 'normal',
            comments: !!(chkJunkComments && chkJunkComments.checked),
            layout: obfuscationLayoutSelect?.value === 'compact' ? 'compact' : 'messy'
        };
        return {
            enabled,
            requestedLevel,
            effectiveLevel: resolveObfuscationLevel(code, requestedLevel),
            protection
        };
    }

    function looksAlreadyObfuscatedLua(code) {
        const source = String(code || '');
        const lower = source.toLowerCase();
        const signatures = [
            'prometheus obfuscator', 'prometheus obfuscation', 'ironbrew', 'moonsec',
            'moonsec v3', 'luraph', 'galactic tools', 'galactic dumper', 'luarmor',
            'wearedevs obfuscator', 'lua obfuscator by', 'obfuscated with',
            'obfuscated by', 'generated by an obfuscator', 'obfuscation by'
        ];
        if (signatures.some(signature => lower.includes(signature))) return true;

        // Only skip the warning for clear, high-confidence generated forms;
        // ordinary minified or compact hand-written code should still warn.
        const escapedBytes = (source.match(/\\\d{1,3}/g) || []).length;
        const charCalls = (source.match(/string\s*\.\s*char\s*\(/gi) || []).length;
        if (source.length >= 400 && escapedBytes >= 24 && (charCalls >= 2 || /loadstring\s*\(/i.test(source))) return true;

        const packedNumbers = (source.match(/(?:^|[,{])\s*\d{1,3}\s*(?=,)/g) || []).length;
        const encodedLiteral = /["'][A-Za-z0-9+/_=-]{512,}["']/.test(source);
        const hasRuntimeDecoder = /(?:loadstring|load)\s*\(/i.test(source) &&
            /(?:string\s*\.\s*char|table\s*\.\s*concat|bit32\s*\.\s*bxor|tonumber)\s*\(/i.test(source);
        if (source.length >= 700 && ((encodedLiteral && hasRuntimeDecoder) || (packedNumbers >= 48 && hasRuntimeDecoder))) return true;

        const shortLocals = (source.match(/\blocal\s+[A-Za-z_]\w*\s*=/g) || [])
            .filter(declaration => {
                const name = declaration.match(/\blocal\s+([A-Za-z_]\w*)/i)?.[1] || '';
                return name.length <= 2;
            }).length;
        const lines = source.split(/\r?\n/).filter(line => line.trim()).length;
        const compactRatio = source.length / Math.max(1, lines);
        return source.length >= 1200 && shortLocals >= 14 && compactRatio >= 180;
    }

    function setObfuscatedPreview(output, statusText, outputBytes = getUtf8ByteLength(output)) {
        obfuscatedPreviewText = output;
        const inlinePreview = outputBytes <= MAX_INLINE_OBFUSCATED_PREVIEW_BYTES;
        obfuscatedPreview.value = inlinePreview ? output : '';
        obfuscatedPreviewPanel.classList.remove('hidden');
        obfuscatedPreviewStatus.textContent = inlinePreview
            ? statusText
            : `${statusText} This large output is download-only here to keep the page responsive.`;
        obfuscatedPreviewIsCurrent = true;
        copyObfuscatedBtn.disabled = !output || !inlinePreview;
        downloadObfuscatedBtn.disabled = !output;
    }

    function offerUnstoredObfuscatedPreview(output, level, reason) {
        if (!output) return;
        const outputBytes = getUtf8ByteLength(output);
        const outputKiB = Math.ceil(outputBytes / 1024).toLocaleString();
        setObfuscatedPreview(
            output,
            `${level} execution copy was not saved (${reason}). The generated ${outputKiB} KiB copy is available to download. Choose Fast or Medium to reduce its size and execution cost.`,
            outputBytes
        );
    }

    function markObfuscatedPreviewStale() {
        if (!obfuscatedPreviewText && obfuscatedPreviewPanel.classList.contains('hidden')) return;
        obfuscatedPreviewIsCurrent = false;
        copyObfuscatedBtn.disabled = true;
        downloadObfuscatedBtn.disabled = true;
        obfuscatedPreviewStatus.textContent = 'The source or protection settings changed. Generate a fresh preview before copying or downloading.';
    }

    function clearObfuscatedPreview() {
        obfuscatedPreviewText = '';
        obfuscatedPreview.value = '';
        obfuscatedPreviewPanel.classList.add('hidden');
        obfuscatedPreviewStatus.textContent = 'Generate a preview to inspect the execution copy.';
        obfuscatedPreviewIsCurrent = false;
        copyObfuscatedBtn.disabled = true;
        downloadObfuscatedBtn.disabled = true;
    }

    function getLoaderKey(data) {
        if (!data.requireKey || data.guiMode) return '';
        if (typeof data.key === 'string' && data.key) return data.key;
        if (Array.isArray(data.keys)) {
            const key = data.keys.find(item => item && typeof item.key === 'string' && item.key && !item.terminated);
            if (key) return key.key;
        }
        return '';
    }

    function setEditorSourceContext(hasSavedVault) {
        if (!editorSourceContext) return;
        if (hasSavedVault) {
            const title = scriptTitle.value.trim() || 'Untitled Vault';
            editorSourceContext.textContent = `Showing “${title}” from your vault. This is the saved Luau source, not the website’s index.html.`;
        } else {
            editorSourceContext.textContent = 'Paste Luau source here. A loaded vault’s saved script appears in this editor; it is separate from the website HTML.';
        }
    }

    let hasUnsavedChanges = false;
    let cachedVaults = [];

    function setEditorDirty(isDirty) {
        hasUnsavedChanges = !!isDirty;
        if (!editorSaveStatus) return;
        editorSaveStatus.classList.toggle('unsaved', hasUnsavedChanges);
        editorSaveStatus.setAttribute('aria-label', hasUnsavedChanges ? 'Unsaved changes' : 'All changes saved');
        if (editorSaveStatus.querySelector('i')) {
            editorSaveStatus.querySelector('i').className = hasUnsavedChanges
                ? 'fa-solid fa-circle-exclamation'
                : 'fa-solid fa-circle-check';
        }
        if (editorSaveLabel) editorSaveLabel.textContent = hasUnsavedChanges ? 'Unsaved changes' : 'All changes saved';
    }

    function setProtectionKeyStatus(isEnabled) {
        if (!protectionKeyStatus) return;
        protectionKeyStatus.textContent = isEnabled ? 'ON' : 'OFF';
        protectionKeyStatus.classList.toggle('on', !!isEnabled);
        protectionKeyStatus.classList.toggle('off', !isEnabled);
    }

    let allowUnload = false;

    function askBeforeLeaving(destination) {
        const ask = window.vxDialog
            ? window.vxDialog.confirm('Changes you made may not be saved.', {
                title: 'Leave this page?',
                detail: 'Save your vault first if you want to keep these edits.',
                confirmLabel: 'Leave page',
                cancelLabel: 'Stay here',
                tone: 'warning'
            })
            : Promise.resolve(window.confirm('Leave this page? Changes you made may not be saved.'));
        ask.then((leave) => {
            if (!leave) return;
            allowUnload = true;
            window.location.href = destination;
        });
    }

    // In-app links leave through the themed dialog. The native beforeunload
    // prompt only remains for reloads and closing the tab, where browsers do
    // not allow custom UI.
    document.addEventListener('click', (event) => {
        if (!hasUnsavedChanges || allowUnload) return;
        if (event.defaultPrevented || event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const link = event.target.closest('a[href]');
        if (!link || link.target === '_blank' || link.hasAttribute('download')) return;
        const destination = new URL(link.href, window.location.href);
        if (destination.origin !== window.location.origin) return;
        if (destination.pathname === window.location.pathname && destination.search === window.location.search) return;
        event.preventDefault();
        askBeforeLeaving(destination.href);
    });

    window.addEventListener('beforeunload', (event) => {
        if (!hasUnsavedChanges || allowUnload) return;
        event.preventDefault();
        event.returnValue = '';
    });

    if (promoShareBtn) {
        promoShareBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(window.location.origin);
            showToast('VoidedX link copied to clipboard!', 'success', 3000);
        });
    }

    // Vault list dropdown (starts expanded)
    vaultListPanel.classList.add('expanded');
    vaultListToggle.classList.add('expanded');
    vaultListToggle.addEventListener('click', () => {
        const isExpanded = vaultListPanel.classList.toggle('expanded');
        vaultListToggle.classList.toggle('expanded', isExpanded);
    });

    // Auth Elements
    const authBtn = document.getElementById('auth-btn');
    const userDisplay = document.getElementById('user-display');
    const authModal = document.getElementById('auth-modal');
    const authHeading = document.getElementById('auth-heading');
    const authSubheading = document.getElementById('auth-subheading');
    const authBanner = document.getElementById('auth-banner');
    const tabLogin = document.getElementById('tab-login');
    const tabSignup = document.getElementById('tab-signup');
    const googleAuthBtn = document.getElementById('google-auth-btn');
    const googleAuthLabel = document.getElementById('google-auth-label');
    const authEmail = document.getElementById('auth-email');
    const emailError = document.getElementById('email-error');
    const authPassword = document.getElementById('auth-password');
    const passwordError = document.getElementById('password-error');
    const passwordHint = document.getElementById('password-hint');
    const togglePasswordBtn = document.getElementById('toggle-password-btn');
    const authSubmitBtn = document.getElementById('auth-submit-btn');
    const authSubmitLabel = document.getElementById('auth-submit-label');
    const authCloseBtn = document.getElementById('auth-close-btn');
    const authCloseX = document.getElementById('auth-close-x');

    // ---------------- Auth modal open/close ----------------

    function resetAuthForm() {
        authEmail.value = '';
        authPassword.value = '';
        // Reopen the modal in Log In mode so a previous Sign Up selection cannot
        // make an existing user accidentally try to create the account again.
        setAuthMode(false);
        clearFieldError(authEmail, emailError);
        clearFieldError(authPassword, passwordError);
        authBanner.classList.add('hidden');
        authPassword.type = 'password';
        togglePasswordBtn.innerHTML = '<i class="fa-solid fa-eye"></i>';
        setAuthLoading(false);
    }

    function openAuthModal() {
        resetAuthForm();
        authModal.classList.remove('hidden');
        if (!window.matchMedia('(max-width: 768px)').matches) authEmail.focus();
    }

    function closeAuthModal() {
        authModal.classList.add('hidden');
    }

    authBtn.addEventListener('click', () => {
        if (currentUser && !currentUser.isAnonymous) {
            signOut(auth);
            showToast('Logged out.', 'info', 2500);
        } else {
            openAuthModal();
        }
    });

    authCloseBtn.addEventListener('click', closeAuthModal);
    authCloseX.addEventListener('click', closeAuthModal);
    authModal.addEventListener('click', (e) => { if (e.target === authModal) closeAuthModal(); });

    function setAuthMode(signUp) {
        isSignUpMode = signUp;
        tabLogin.classList.toggle('active', !signUp);
        tabSignup.classList.toggle('active', signUp);
        authSubmitLabel.textContent = signUp ? 'Sign Up' : 'Log In';
        authHeading.textContent = signUp ? 'Create your account' : 'Welcome back';
        authSubheading.textContent = signUp
            ? 'Sign up to start saving vaults to the cloud.'
            : 'Log in to sync your vaults to the cloud.';
        passwordHint.classList.toggle('hidden', !signUp);
        clearFieldError(authEmail, emailError);
        clearFieldError(authPassword, passwordError);
        authBanner.classList.add('hidden');
    }

    tabLogin.addEventListener('click', () => setAuthMode(false));
    tabSignup.addEventListener('click', () => setAuthMode(true));

    togglePasswordBtn.addEventListener('click', () => {
        const showing = authPassword.type === 'text';
        authPassword.type = showing ? 'password' : 'text';
        togglePasswordBtn.innerHTML = showing
            ? '<i class="fa-solid fa-eye"></i>'
            : '<i class="fa-solid fa-eye-slash"></i>';
    });

    authEmail.addEventListener('input', () => clearFieldError(authEmail, emailError));
    authPassword.addEventListener('input', () => clearFieldError(authPassword, passwordError));
    [authEmail, authPassword].forEach(el => {
        el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                authSubmitBtn.click();
            }
        });
    });

    function setAuthLoading(isLoading) {
        authSubmitBtn.disabled = isLoading;
        googleAuthBtn.disabled = isLoading;
        authCloseBtn.disabled = isLoading;
        authSubmitLabel.innerHTML = isLoading
            ? `<i class="fa-solid fa-spinner fa-spin"></i> ${isSignUpMode ? 'Creating account…' : 'Logging in…'}`
            : (isSignUpMode ? 'Sign Up' : 'Log In');
        googleAuthLabel.textContent = isLoading ? 'Opening Google…' : 'Continue with Google';
    }

    const googleProvider = new GoogleAuthProvider();
    googleProvider.setCustomParameters({ prompt: 'select_account' });

    async function finishGoogleLinkConflict(error) {
        if (!error || error.code !== 'auth/credential-already-in-use') return false;
        const credential = GoogleAuthProvider.credentialFromError(error);
        if (!credential) return false;
        await signInWithCredential(auth, credential);
        closeAuthModal();
        showToast('Signed in with Google.', 'success', 4000);
        return true;
    }

    function showGoogleAuthError(error) {
        authBanner.textContent = friendlyAuthError(error);
        authBanner.className = 'auth-banner error';
    }

    googleAuthBtn.addEventListener('click', async () => {
        authBanner.classList.add('hidden');
        setAuthLoading(true);
        try {
            const current = auth.currentUser;
            // Popup sign-in also works on this Vercel-hosted site without requiring
            // the extra same-domain proxy setup that redirect sign-in needs.
            if (current && current.isAnonymous) await linkWithPopup(current, googleProvider);
            else await signInWithPopup(auth, googleProvider);
            closeAuthModal();
            showToast('You’re signed in with Google.', 'success');
        } catch (error) {
            try {
                if (await finishGoogleLinkConflict(error)) return;
            } catch (signInError) {
                error = signInError;
            }
            showGoogleAuthError(error);
        } finally {
            setAuthLoading(false);
        }
    });

    authSubmitBtn.addEventListener('click', async () => {
        const email = authEmail.value.trim();
        const password = authPassword.value;

        clearFieldError(authEmail, emailError);
        clearFieldError(authPassword, passwordError);
        authBanner.classList.add('hidden');

        let hasError = false;
        if (!email) {
            setFieldError(authEmail, emailError, 'Enter your email address.');
            hasError = true;
        } else if (!isValidEmail(email)) {
            setFieldError(authEmail, emailError, "That doesn't look like a valid email.");
            hasError = true;
        }

        if (!password) {
            setFieldError(authPassword, passwordError, 'Enter your password.');
            hasError = true;
        } else if (isSignUpMode && password.length < 6) {
            setFieldError(authPassword, passwordError, 'Password must be at least 6 characters.');
            hasError = true;
        }

        if (hasError) return;

        setAuthLoading(true);
        try {
            if (isSignUpMode) {
                await createUserWithEmailAndPassword(auth, email, password);
                showToast('Account created — you\'re logged in!', 'success');
            } else {
                await signInWithEmailAndPassword(auth, email, password);
                showToast('Welcome back!', 'success');
            }
            closeAuthModal();
        } catch (err) {
            if (isSignUpMode && err.code === 'auth/email-already-in-use') {
                // Keep the email and move straight to the existing account's login.
                setAuthMode(false);
                authEmail.value = email;
                authPassword.value = '';
                authBanner.textContent = 'This email already has an account. You are on Log In now—use the same sign-in method you used before.';
            } else {
                authBanner.textContent = friendlyAuthError(err);
            }
            authBanner.classList.remove('hidden');
            authBanner.className = 'auth-banner error';
        } finally {
            setAuthLoading(false);
        }
    });

    function updateDashGreeting(user) {
        if (!dashEls.greeting) return;
        if (user && !user.isAnonymous && user.email) {
            dashEls.greeting.textContent = `Welcome back, ${user.email.split('@')[0]}`;
        } else if (user && user.isAnonymous) {
            dashEls.greeting.textContent = 'Signed out';
        } else {
            dashEls.greeting.textContent = 'Welcome back';
        }
    }

    let lastUid = null;
    onAuthStateChanged(auth, user => {
        currentUser = user;
        updateDashGreeting(user);
        const newUid = user ? user.uid : null;
        if (newUid !== lastUid) {
            for (const timer of vaultExpiryTimers.values()) clearTimeout(timer);
            vaultExpiryTimers.clear();
            vaultExpiryWarningIds.clear();
            vaultsLoadedForUid = null;
            // Identity changed (login / logout / new guest): clear the editor and the
            // vault list so nothing from the previous account stays on screen.
            resetEditor();
            vaultListContainer.innerHTML = '<div class="info-box"><p><i class="fa-solid fa-spinner fa-spin"></i> Loading vaults...</p></div>';
            updateVaultCount(0);
            lastUid = newUid;
        }
        if (user && !user.isAnonymous) {
            userDisplay.innerHTML = `<i class="fa-solid fa-user-check text-cyan"></i> ${user.email}`;
            authBtn.innerHTML = `<i class="fa-solid fa-right-from-bracket"></i> Logout`;
            loadUserVaults();
        } else {
            // The site login gate owns sign-in now; this page never starts a
            // guest session of its own.
            userDisplay.innerHTML = `<i class="fa-solid fa-user"></i> Signed out`;
            authBtn.innerHTML = `<i class="fa-solid fa-right-to-bracket"></i> Login`;
            vaultListContainer.innerHTML = '<div class="info-box"><p>Sign in to save and manage your script vaults.</p></div>';
            updateVaultCount(0);
            dashboardTelemetry.setVaults([]);
            dashboardTelemetry.clear('Sign in to see who ran your vaults.');        }
    });

    // ---------------- Vault list ----------------

    function updateVaultOverview() {
        const totalExecutions = cachedVaults.reduce((sum, vault) => sum + (Number(vault.data.executions) || 0), 0);
        const protectedCount = cachedVaults.filter(vault => !!vault.data.requireKey).length;
        if (vaultStatTotal) vaultStatTotal.textContent = cachedVaults.length.toLocaleString();
        if (vaultStatExecutions) vaultStatExecutions.textContent = totalExecutions.toLocaleString();
        if (vaultStatProtected) vaultStatProtected.textContent = protectedCount.toLocaleString();
        dashboardTelemetry.setVaults(cachedVaults.map(vault => ({ id: vault.id, title: vault.data.title })));
        renderDashboardStats();
        renderDashboardVaults();
    }

    function dashRelative(ms) {
        if (!ms) return '';
        const diff = Math.max(0, Date.now() - ms);
        if (diff < 60000) return 'just now';
        if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
        if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
        if (diff < 7 * 86400000) return `${Math.floor(diff / 86400000)}d ago`;
        return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }

    function renderDashboardStats() {
        if (!dashEls.vaults) return;
        const totalExecutions = cachedVaults.reduce((sum, vault) => sum + (Number(vault.data.executions) || 0), 0);
        const protectedCount = cachedVaults.filter(vault => !!vault.data.requireKey).length;
        const latest = cachedVaults.reduce((max, vault) => Math.max(max, vaultUpdatedAt(vault.data.updatedAt)), 0);

        dashEls.vaults.textContent = cachedVaults.length.toLocaleString();
        dashEls.executions.textContent = totalExecutions.toLocaleString();
        dashEls.protected.textContent = protectedCount.toLocaleString();
        dashEls.updated.textContent = latest ? dashRelative(latest) : '—';
        if (dashEls.updatedNote) {
            dashEls.updatedNote.textContent = latest ? new Date(latest).toLocaleString() : 'No vaults yet';
        }
        if (dashEls.keysNote) {
            dashEls.keysNote.textContent = cachedVaults.length
                ? `${protectedCount} of ${cachedVaults.length} vault${cachedVaults.length === 1 ? '' : 's'} require a key`
                : 'No vaults yet';
        }
        if (dashEls.keysPill) {
            dashEls.keysPill.textContent = protectedCount ? 'ON' : 'OFF';
            dashEls.keysPill.classList.toggle('on', protectedCount > 0);
            dashEls.keysPill.classList.toggle('off', protectedCount === 0);
        }

        if (!dashEls.topVaults) return;
        const ranked = cachedVaults
            .map(vault => ({ title: String(vault.data.title || 'Untitled Vault'), execs: Number(vault.data.executions) || 0 }))
            .filter(vault => vault.execs > 0)
            .sort((a, b) => b.execs - a.execs)
            .slice(0, 5);
        if (!ranked.length) {
            dashEls.topVaults.innerHTML = '<div class="vx-empty"><i class="fa-solid fa-chart-simple"></i><span>No runs yet. Share a loadstring and executions will show up here.</span></div>';
            return;
        }
        const max = Math.max(...ranked.map(vault => vault.execs));
        dashEls.topVaults.innerHTML = ranked.map(vault => `
            <div class="vx-bar-row">
                <div class="vx-bar-track"><span class="vx-bar-fill" style="width:${Math.max(6, Math.round((vault.execs / max) * 100))}%"></span><span class="vx-bar-name">${escapeHtml(vault.title)}</span></div>
                <span class="vx-bar-value">${vault.execs.toLocaleString()}</span>
            </div>
        `).join('');
    }

    function renderDashboardVaults() {
        if (!dashEls.vaultList) return;
        const recent = [...cachedVaults]
            .sort((a, b) => vaultUpdatedAt(b.data.updatedAt) - vaultUpdatedAt(a.data.updatedAt))
            .slice(0, 6);
        if (!recent.length) {
            dashEls.vaultList.innerHTML = '<div class="vx-empty"><i class="fa-solid fa-box-open"></i><span>No vaults yet. Create your first one to get a shareable loadstring.</span></div>';
            return;
        }
        dashEls.vaultList.innerHTML = recent.map(vault => {
            const item = vault.data;
            const title = String(item.title || 'Untitled Vault');
            const execs = Number(item.executions) || 0;
            const initial = title.trim().charAt(0).toUpperCase() || '?';
            const keyed = !!item.requireKey;
            return `
                <div class="vx-vault-row">
                    <div class="vx-vrow-main">
                        <span class="vx-vrow-icon">${escapeHtml(initial)}</span>
                        <div class="vx-vrow-copy">
                            <strong>${escapeHtml(title)}</strong>
                            <span class="vx-vrow-meta">
                                <i class="fa-solid fa-play"></i> ${execs.toLocaleString()} runs
                                <span class="sep">·</span>
                                <i class="fa-solid fa-key"></i> ${keyed ? 'Key on' : 'Open'}
                                <span class="sep">·</span>
                                ${dashRelative(vaultUpdatedAt(item.updatedAt)) || 'not saved yet'}
                            </span>
                        </div>
                    </div>
                    <div class="vx-vrow-actions">
                        <button type="button" class="vx-btn vx-btn-ghost" data-dash-edit="${escapeHtml(vault.id)}"><i class="fa-solid fa-pen"></i> Edit</button>
                        <a class="vx-btn vx-btn-ghost" href="/keysystem.html?id=${encodeURIComponent(vault.id)}"><i class="fa-solid fa-key"></i> Keys</a>
                        <a class="vx-btn vx-btn-ghost" href="/vault.html?id=${encodeURIComponent(vault.id)}" target="_blank" rel="noopener" aria-label="Open vault page"><i class="fa-solid fa-arrow-up-right-from-square"></i></a>
                    </div>
                </div>
            `;
        }).join('');
    }

    if (dashEls.vaultList) {
        dashEls.vaultList.addEventListener('click', async event => {
            const button = event.target.closest('[data-dash-edit]');
            if (!button) return;
            const vault = cachedVaults.find(item => item.id === button.dataset.dashEdit);
            if (!vault) return;
            if (hasUnsavedChanges && !(await window.vxDialog.confirm('You have unsaved changes. Discard them and open this vault?', {
                title: 'Discard unsaved changes?',
                confirmLabel: 'Discard & open',
                tone: 'warning'
            }))) return;
            loadVaultIntoEditor(vault.id, vault.data);
            if (window.vxShell) window.vxShell.showView('editor');
        });
    }

    // ---------------- Dashboard: reach map + runners ----------------

    const dashboardTelemetry = createDashboardTelemetry({
        getToken: async () => (currentUser && !currentUser.isAnonymous ? currentUser.getIdToken() : null),
        escapeHtml,
        relativeTime: dashRelative,
        showToast
    });

    dashboardTelemetry.mount();

    function vaultUpdatedAt(value) {
        if (typeof value === 'number') return value;
        if (value && typeof value.toMillis === 'function') return value.toMillis();
        return 0;
    }

    function renderVaultList() {
        if (!vaultListContainer) return;
        vaultListContainer.innerHTML = '';

        if (!cachedVaults.length) {
            vaultListContainer.innerHTML = '<div class="info-box"><p>No vaults found. Create one!</p></div>';
            return;
        }

        const searchTerm = vaultSearch ? vaultSearch.value.trim().toLowerCase() : '';
        const filterMode = vaultFilter ? vaultFilter.value : 'all';
        const visibleVaults = cachedVaults.filter(vault => {
            const title = String(vault.data.title || '').toLowerCase();
            const matchesSearch = !searchTerm || title.includes(searchTerm) || vault.id.toLowerCase().includes(searchTerm);
            const matchesProtection = filterMode === 'all'
                || (filterMode === 'protected' && !!vault.data.requireKey)
                || (filterMode === 'open' && !vault.data.requireKey);
            return matchesSearch && matchesProtection;
        });
        const sortMode = vaultSort ? vaultSort.value : 'recent';
        visibleVaults.sort((a, b) => {
            if (sortMode === 'executions') {
                return (Number(b.data.executions) || 0) - (Number(a.data.executions) || 0)
                    || String(a.data.title || '').localeCompare(String(b.data.title || ''));
            }
            if (sortMode === 'title') {
                return String(a.data.title || '').localeCompare(String(b.data.title || ''));
            }
            return vaultUpdatedAt(b.data.updatedAt) - vaultUpdatedAt(a.data.updatedAt);
        });

        if (!visibleVaults.length) {
            vaultListContainer.innerHTML = '<div class="info-box"><p>No vaults match that search.</p></div>';
            return;
        }

        visibleVaults.forEach(vault => {
            const item = vault.data;
            const div = document.createElement('div');
            div.className = 'vault-item';
            const execs = Number(item.executions) || 0;
            const title = String(item.title || 'Untitled Vault');
            const initial = title.trim().charAt(0).toUpperCase() || '?';
            div.innerHTML = `
                <span class="vault-item-main">
                    <span class="vault-item-icon">${escapeHtml(initial)}</span>
                    <span class="vault-item-title">${escapeHtml(title)}</span>
                </span>
                <span class="vault-item-badge"><i class="fa-solid fa-play"></i> ${execs.toLocaleString()}</span>
            `;
            div.addEventListener('click', async () => {
                if (hasUnsavedChanges && !(await window.vxDialog.confirm('You have unsaved changes. Discard them and open this vault?', {
                    title: 'Discard unsaved changes?',
                    confirmLabel: 'Discard & open',
                    tone: 'warning'
                }))) return;
                loadVaultIntoEditor(vault.id, item);
            });
            vaultListContainer.appendChild(div);
        });
    }

    if (vaultSearch) vaultSearch.addEventListener('input', renderVaultList);
    if (vaultSort) vaultSort.addEventListener('change', renderVaultList);
    if (vaultFilter) vaultFilter.addEventListener('change', renderVaultList);
    window.addEventListener('voidedx:vaults-claimed', () => {
        if (currentUser && !currentUser.isAnonymous) loadUserVaults();
    });

    async function loadUserVaults() {
        if (!currentUser) return;
        vaultListContainer.innerHTML = '<div class="info-box"><p><i class="fa-solid fa-spinner fa-spin"></i> Loading vaults...</p></div>';
        try {
            const uidAtStart = currentUser.uid;
            const q = query(collection(db, "vaults"), where("uid", "==", uidAtStart));
            const snapshot = await getDocs(q);
            if (!currentUser || currentUser.uid !== uidAtStart) return;
            const now = Date.now();
            const loadedVaults = [];
            let expiredCount = 0;
            let expirySetupFailed = false;

            for (const docSnap of snapshot.docs) {
                let data = docSnap.data();
                const executions = Number(data.executions) || 0;
                if (executions === 0) {
                    let expiresAt = Number(data.autoDeleteAt);
                    if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
                        expiresAt = Date.now() + ZERO_EXECUTION_VAULT_TTL_MS;
                        try {
                            await updateDoc(docSnap.ref, { autoDeleteAt: expiresAt });
                            data = { ...data, autoDeleteAt: expiresAt };
                        } catch {
                            data = { ...data, autoDeleteAt: null };
                            expiresAt = 0;
                            expirySetupFailed = true;
                        }
                    }

                    if (expiresAt > 0 && expiresAt <= now
                        && !(activeVaultId.value === docSnap.id && hasUnsavedChanges)) {
                        try {
                            const outcome = await deleteVaultIfStillUnused(docSnap.id, uidAtStart);
                            if (outcome.deleted) {
                                expiredCount++;
                                continue;
                            }
                            if (outcome.data) {
                                data = outcome.data;
                            } else {
                                const fresh = await getDoc(docSnap.ref);
                                if (!fresh.exists()) { expiredCount++; continue; }
                                data = fresh.data();
                            }
                        } catch {
                            // Leave the vault visible; a later list refresh will retry.
                        }
                    }
                }
                loadedVaults.push({ id: docSnap.id, data });
            }

            if (!currentUser || currentUser.uid !== uidAtStart) return;
            vaultsLoadedForUid = uidAtStart;
            for (const timer of vaultExpiryTimers.values()) clearTimeout(timer);
            vaultExpiryTimers.clear();
            cachedVaults = loadedVaults;
            cachedVaults.forEach(vault => scheduleUnusedVaultCleanup(vault, uidAtStart));
            updateVaultCount(cachedVaults.length);
            updateVaultOverview();
            renderVaultList();
            dashboardTelemetry.refresh();
            if (requestedVaultId && !requestedVaultOpened) {
                const requestedVault = cachedVaults.find(vault => vault.id === requestedVaultId);
                if (requestedVault) {
                    requestedVaultOpened = true;
                    loadVaultIntoEditor(requestedVault.id, requestedVault.data);
                } else if (!auth.currentUser?.isAnonymous) {
                    requestedVaultOpened = true;
                    showToast('That script was not found in your account.', 'error');
                }
            }
            if (expiredCount) {
                showToast(`${expiredCount} unused vault${expiredCount === 1 ? '' : 's'} removed after 10 hours with 0 executions.`, 'info', 7000);
            }
            if (expirySetupFailed) {
                showToast('Could not start the 10-hour timer for an older vault. Save it once to enable cleanup.', 'warning', 7000);
            }
        } catch (err) {
            vaultListContainer.innerHTML = `<div class="info-box text-red"><p>Error loading vaults: ${escapeHtml(friendlyAuthError(err))}</p></div>`;
        }
    }

    async function deleteVaultIfStillUnused(vaultId, ownerUid) {
        const ref = doc(db, 'vaults', vaultId);
        const initial = await getDoc(ref);
        if (!initial.exists()) return { deleted: true };
        const initialData = initial.data();
        const initialExpiry = Number(initialData.autoDeleteAt);
        if (initialData.uid !== ownerUid || (Number(initialData.executions) || 0) !== 0
            || !Number.isFinite(initialExpiry) || initialExpiry > Date.now()) {
            return { deleted: false, data: initialData };
        }
        await createRemoteVaultBackup(vaultId, 'before_delete');
        return runTransaction(db, async transaction => {
            const fresh = await transaction.get(ref);
            if (!fresh.exists()) return { deleted: true };
            const data = fresh.data();
            const expiresAt = Number(data.autoDeleteAt);
            if (data.uid !== ownerUid || (Number(data.executions) || 0) !== 0
                || !Number.isFinite(expiresAt) || expiresAt > Date.now()) {
                return { deleted: false, data };
            }
            transaction.delete(ref);
            return { deleted: true };
        });
    }

    function scheduleUnusedVaultCleanup(vault, ownerUid, delayOverride = null) {
        const previous = vaultExpiryTimers.get(vault.id);
        if (previous) clearTimeout(previous);

        const expiresAt = Number(vault.data.autoDeleteAt);
        if ((Number(vault.data.executions) || 0) !== 0 || !Number.isFinite(expiresAt) || expiresAt <= 0) {
            vaultExpiryTimers.delete(vault.id);
            return;
        }

        const delay = delayOverride == null ? Math.max(0, expiresAt - Date.now()) : delayOverride;
        const timer = setTimeout(async () => {
            vaultExpiryTimers.delete(vault.id);
            if (!currentUser || currentUser.uid !== ownerUid) return;

            if (activeVaultId.value === vault.id && hasUnsavedChanges) {
                if (!vaultExpiryWarningIds.has(vault.id)) {
                    vaultExpiryWarningIds.add(vault.id);
                    showToast('This unused vault reached its 10-hour limit. Save your edits or download a backup before leaving it.', 'warning', 9000);
                }
                scheduleUnusedVaultCleanup(vault, ownerUid, 60 * 1000);
                return;
            }

            try {
                const outcome = await deleteVaultIfStillUnused(vault.id, ownerUid);
                if (outcome.deleted) {
                    cachedVaults = cachedVaults.filter(item => item.id !== vault.id);
                    if (activeVaultId.value === vault.id) resetEditor();
                    vaultExpiryWarningIds.delete(vault.id);
                    updateVaultCount(cachedVaults.length);
                    updateVaultOverview();
                    renderVaultList();
                    showToast(`"${vault.data.title || 'Untitled Vault'}" was deleted after 10 hours with 0 executions.`, 'info', 7000);
                    return;
                }

                if (outcome.data) {
                    const refreshed = { id: vault.id, data: outcome.data };
                    cachedVaults = cachedVaults.map(item => item.id === vault.id ? refreshed : item);
                    updateVaultOverview();
                    renderVaultList();
                    scheduleUnusedVaultCleanup(refreshed, ownerUid);
                }
            } catch {
                // Cleanup is retried when the owner next reloads the vault list.
            }
        }, Math.min(delay, 2147483647));
        vaultExpiryTimers.set(vault.id, timer);
    }

    function updateVaultCount(count) {
        if (!vaultListCount) return;
        vaultListCount.textContent = `${count}/${MAX_USER_VAULTS}`;
        vaultListCount.title = `${count} of ${MAX_USER_VAULTS} saved vaults`;
        vaultListCount.classList.remove('hidden');
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str || '';
        return div.innerHTML;
    }

    async function loadVaultIntoEditor(id, data) {
        const loadGeneration = ++editorLoadGeneration;
        obfuscationRevision += 1;
        clearObfuscatedPreview();
        activeVaultId.value = id;
        let loadedCode;
        try {
            loadedCode = await decodeVaultSource(data.code, data.codeEncoding);
        } catch (error) {
            showToast('Could not open this vault source: ' + (error && error.message ? error.message : 'unknown error'), 'error', 8000);
            return;
        }
        if (loadGeneration !== editorLoadGeneration || activeVaultId.value !== id) return;
        scriptTitle.value = data.title || '';
        setEditorSourceContext(true);
        sourceCode.value = loadedCode;
        if (window.VoidedXEditor) window.VoidedXEditor.refresh();
        if (chkObfuscation) chkObfuscation.checked = data.obfuscationEnabled === true;
        if (chkFastLoadCache) chkFastLoadCache.checked = data.fastLoadCacheEnabled === true;
        if (obfuscationLevelSelect) {
            obfuscationLevelSelect.value = ['auto', 'fast', 'low', 'medium', 'high', 'absolute'].includes(data.obfuscationLevel) ? data.obfuscationLevel : 'auto';
        }
        if (chkTamperCheck) chkTamperCheck.checked = data.tamperCheckEnabled === true;
        if (chkInstantRun) chkInstantRun.checked = data.instantRunEnabled === true;
        if (chkVmProtection) chkVmProtection.checked = true;
        if (chkExpandedTransforms) chkExpandedTransforms.checked = data.expandedTransformsEnabled === true;
        if (obfuscationLayersSelect) {
            const savedLayers = Number(data.armorLayerCount);
            obfuscationLayersSelect.value = Number.isSafeInteger(savedLayers) && savedLayers >= 1 && savedLayers <= 6
                ? String(savedLayers)
                : 'auto';
        }
        if (obfuscationJunkSelect) {
            obfuscationJunkSelect.value = ['off', 'normal', 'heavy'].includes(data.junkPreambleMode) ? data.junkPreambleMode : 'normal';
        }
        if (obfuscationLayoutSelect) {
            obfuscationLayoutSelect.value = data.armorLayout === 'compact' ? 'compact' : 'messy';
        }
        if (chkJunkComments) chkJunkComments.checked = data.junkCommentsEnabled !== false;
        setEditorDirty(false);
        if (data.obfuscationEnabled === true && data.obfuscationProfileVersion !== 24) {
            showToast('This vault has an older obfuscated copy. Save it again to rebuild it with the current protection settings.', 'warning', 10000);
        }
        if (data.obfuscationEnabled === true && !data.obfuscatedCode) {
            showToast('This vault has no stored protected copy, so it cannot launch. Save it again with obfuscation enabled.', 'error', 12000);
        }
        syncObfuscationProtectionControls();
        setProtectionKeyStatus(!!data.requireKey);
        clearFieldError(sourceCode, codeError);
        editingIndicator.classList.remove('hidden');
        deleteBtn.classList.remove('hidden');

        const keyCount = Array.isArray(data.keys) ? data.keys.length : (data.requireKey && data.key ? 1 : 0);
        if (data.requireKey && keyCount > 0) {
            keysystemStatusBadge.textContent = `ON · ${keyCount} key${keyCount > 1 ? 's' : ''}`;
            keysystemStatusBadge.classList.remove('hidden');
            keysystemStatusBadge.classList.add('on');
        } else {
            keysystemStatusBadge.textContent = 'OFF';
            keysystemStatusBadge.classList.remove('on');
            keysystemStatusBadge.classList.add('hidden');
        }

        if (execCountBadge && execCountNum) {
            execCountNum.textContent = data.executions || 0;
            execCountBadge.classList.remove('hidden');
        }

        refreshVaultLoader(id, getLoaderKey(data));
        resultOverlay.classList.remove('hidden');

        if (data.requireKey) {
            getKeyOutput.value = `${window.location.origin}/key.html?id=${id}`;
            getKeyRow.classList.remove('hidden');
        } else {
            getKeyRow.classList.add('hidden');
        }
        showToast(`Loaded "${escapeHtml(data.title || 'Untitled Vault')}" into the editor.`, 'info', 2500);
    }

    // ---------------- Lock / Save Vault ----------------

    sourceCode.addEventListener('input', () => {
        clearFieldError(sourceCode, codeError);
        obfuscationRevision += 1;
        markObfuscatedPreviewStale();
        setEditorDirty(true);
    });
    scriptTitle.addEventListener('input', () => {
        clearFieldError(scriptTitle, titleError);
        setEditorDirty(true);
    });
    if (chkFastLoadCache) chkFastLoadCache.addEventListener('change', () => setEditorDirty(true));
    if (chkInstantRun) chkInstantRun.addEventListener('change', () => setEditorDirty(true));
    function syncObfuscationProtectionControls() {
        const obfuscationOn = !!(chkObfuscation && chkObfuscation.checked);
        const absoluteMode = obfuscationOn && !!(obfuscationLevelSelect && obfuscationLevelSelect.value === 'absolute');
        const fastMode = obfuscationOn && !!(obfuscationLevelSelect && obfuscationLevelSelect.value === 'fast');
        if (!obfuscationOn && chkVmProtection) chkVmProtection.checked = false;
        if (absoluteMode) {
            if (chkTamperCheck) chkTamperCheck.checked = true;
            if (chkVmProtection) chkVmProtection.checked = true;
            if (chkExpandedTransforms) chkExpandedTransforms.checked = true;
        }
        if (fastMode && chkExpandedTransforms) chkExpandedTransforms.checked = false;
        if (chkVmProtection) {
            chkVmProtection.checked = obfuscationOn;
            chkVmProtection.disabled = true;
        }
        if (obfuscationLevelSelect) obfuscationLevelSelect.disabled = !obfuscationOn;
        if (obfuscationLayersSelect) obfuscationLayersSelect.disabled = !obfuscationOn;
        if (obfuscationJunkSelect) obfuscationJunkSelect.disabled = !obfuscationOn;
        if (obfuscationLayoutSelect) obfuscationLayoutSelect.disabled = !obfuscationOn;
        if (chkJunkComments) chkJunkComments.disabled = !obfuscationOn || obfuscationJunkSelect?.value === 'off';
        if (chkTamperCheck) chkTamperCheck.disabled = !obfuscationOn || absoluteMode;
        if (chkExpandedTransforms) chkExpandedTransforms.disabled = !obfuscationOn || absoluteMode || fastMode;
    }

    if (chkObfuscation) chkObfuscation.addEventListener('change', () => {
        syncObfuscationProtectionControls();
        obfuscationRevision += 1;
        markObfuscatedPreviewStale();
        setEditorDirty(true);
    });
    if (obfuscationLevelSelect) obfuscationLevelSelect.addEventListener('change', () => {
        syncObfuscationProtectionControls();
        obfuscationRevision += 1;
        markObfuscatedPreviewStale();
        setEditorDirty(true);
    });
    if (chkTamperCheck) chkTamperCheck.addEventListener('change', () => {
        obfuscationRevision += 1;
        markObfuscatedPreviewStale();
        setEditorDirty(true);
    });
    if (chkVmProtection) chkVmProtection.addEventListener('change', () => {
        syncObfuscationProtectionControls();
        obfuscationRevision += 1;
        markObfuscatedPreviewStale();
        setEditorDirty(true);
    });
    if (chkExpandedTransforms) chkExpandedTransforms.addEventListener('change', () => {
        obfuscationRevision += 1;
        markObfuscatedPreviewStale();
        setEditorDirty(true);
    });
    if (obfuscationLayersSelect) obfuscationLayersSelect.addEventListener('change', () => {
        obfuscationRevision += 1;
        markObfuscatedPreviewStale();
        setEditorDirty(true);
    });
    if (obfuscationJunkSelect) obfuscationJunkSelect.addEventListener('change', () => {
        syncObfuscationProtectionControls();
        obfuscationRevision += 1;
        markObfuscatedPreviewStale();
        setEditorDirty(true);
    });
    if (obfuscationLayoutSelect) obfuscationLayoutSelect.addEventListener('change', () => {
        obfuscationRevision += 1;
        markObfuscatedPreviewStale();
        setEditorDirty(true);
    });
    if (chkJunkComments) chkJunkComments.addEventListener('change', () => {
        obfuscationRevision += 1;
        markObfuscatedPreviewStale();
        setEditorDirty(true);
    });
    syncObfuscationProtectionControls();

    previewObfuscatedBtn.addEventListener('click', async () => {
        const code = sourceCode.value;
        if (!code.trim()) {
            showToast('Paste a script into the editor before generating a preview.', 'info');
            sourceCode.focus();
            return;
        }
        const settings = getObfuscationSettings(code);
        if (!settings.enabled) {
            showToast('Turn on Lua obfuscation first to generate an obfuscated preview.', 'info');
            chkObfuscation.focus();
            return;
        }

        const revision = obfuscationRevision;
        const originalHtml = previewObfuscatedBtn.innerHTML;
        previewObfuscatedBtn.disabled = true;
        previewObfuscatedBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Generating ${settings.effectiveLevel.toUpperCase()} preview…`;
        obfuscatedPreviewPanel.classList.remove('hidden');
        obfuscatedPreviewStatus.textContent = 'Obfuscating the current script with the selected protection settings…';
        try {
            const output = await obfuscateLua(code, settings.effectiveLevel, settings.protection);
            if (revision !== obfuscationRevision) {
                markObfuscatedPreviewStale();
                return;
            }
            const outputBytes = getUtf8ByteLength(output);
            if (outputBytes > MAX_OBFUSCATED_OUTPUT_BYTES) {
                throw new Error('The generated output is over the 32 MiB limit. Try lower strength or reduce the script.');
            }
            const outputKiB = Math.ceil(outputBytes / 1024).toLocaleString();
            setObfuscatedPreview(output, `Current ${settings.effectiveLevel} output · ${outputKiB} KiB · not saved yet.`, outputBytes);
        } catch (error) {
            if (revision !== obfuscationRevision) {
                markObfuscatedPreviewStale();
                return;
            }
            obfuscatedPreviewIsCurrent = false;
            copyObfuscatedBtn.disabled = true;
            downloadObfuscatedBtn.disabled = true;
            obfuscatedPreviewStatus.textContent = 'Preview could not be generated.';
            showToast('Could not generate the obfuscated preview: ' + describeObfuscationError(error), 'error', 9000);
        } finally {
            previewObfuscatedBtn.disabled = false;
            previewObfuscatedBtn.innerHTML = originalHtml;
        }
    });

    copyObfuscatedBtn.addEventListener('click', async () => {
        if (!obfuscatedPreviewIsCurrent || !obfuscatedPreviewText || copyObfuscatedBtn.disabled) return;
        try {
            let copied = false;
            if (navigator.clipboard && window.isSecureContext) {
                try {
                    await navigator.clipboard.writeText(obfuscatedPreviewText);
                    copied = true;
                } catch { /* Try the selection-based fallback below. */ }
            }
            if (!copied) {
                obfuscatedPreview.focus();
                obfuscatedPreview.select();
                if (!document.execCommand('copy')) throw new Error('Clipboard access was denied.');
                obfuscatedPreview.setSelectionRange(0, 0);
            }
            showToast('Obfuscated script copied.', 'success');
        } catch (error) {
            showToast('Could not copy the preview. Try selecting the text and copying it manually.', 'error', 7000);
        }
    });

    downloadObfuscatedBtn.addEventListener('click', () => {
        if (!obfuscatedPreviewIsCurrent || !obfuscatedPreviewText) return;
        const baseName = String(scriptTitle.value.trim() || activeVaultId.value || 'voidedx-script')
            .replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'voidedx-script';
        const blobUrl = URL.createObjectURL(new Blob([obfuscatedPreviewText], { type: 'text/plain;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = `${baseName}_obfuscated.lua`;
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
        showToast('Obfuscated script download started.', 'success');
    });

    if (backupNowBtn) {
        backupNowBtn.addEventListener('click', () => {
            const code = sourceCode.value;
            if (!code.trim()) {
                showToast('Paste a script into the editor before downloading a backup.', 'info');
                sourceCode.focus();
                return;
            }
            const title = scriptTitle.value.trim() || 'Untitled Vault';
            if (downloadLocalVaultBackup(activeVaultId.value, title, code)) {
                showToast('Backup download started. Check your browser’s Downloads.', 'success');
            } else {
                showToast('The browser could not start the backup download.', 'error');
            }
        });
    }

    let isSaving = false;

    document.addEventListener('keydown', (event) => {
        const isSaveShortcut = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's';
        const isEditingVault = event.target === sourceCode || event.target === scriptTitle;
        if (!isSaveShortcut || !isEditingVault) return;
        event.preventDefault();
        lockBtn.click();
    });

    lockBtn.addEventListener('click', async () => {
        if (isSaving) return;
        if (!currentUser) {
            showToast('Still starting your session — try again in a second.', 'info');
            return;
        }
        if (!activeVaultId.value && vaultsLoadedForUid !== currentUser.uid) {
            showToast('Your saved scripts are still loading. Wait a moment, then try again.', 'info');
            return;
        }
        if (!activeVaultId.value && cachedVaults.length >= MAX_USER_VAULTS) {
            showToast('You can save up to 5 scripts. Delete one of your saved vaults before creating another.', 'warning', 8000);
            return;
        }
        const code = sourceCode.value;
        const saveObfuscationRevision = obfuscationRevision;
        const obfuscationSettings = getObfuscationSettings(code);

        clearFieldError(sourceCode, codeError);

        if (!code.trim()) {
            setFieldError(sourceCode, codeError, "Your vault can't be empty — paste a script before locking it.");
            shakeElement(sourceCode);
            sourceCode.focus();
            return;
        }

        if (getUtf8ByteLength(code) > MAX_VAULT_SOURCE_BYTES) {
            showToast('This script is over the 2 MiB save limit. Reduce its size before saving.', 'error', 9000);
            return;
        }

        const title = scriptTitle.value.trim().slice(0, 80);
        if (!title) {
            setFieldError(scriptTitle, titleError, 'Name this vault before saving.');
            shakeElement(scriptTitle);
            scriptTitle.scrollIntoView({ block: 'center', behavior: 'smooth' });
            scriptTitle.focus({ preventScroll: true });
            showToast('Give this vault a name before saving.', 'warning', 4000);
            return;
        }
        if (!obfuscationSettings.enabled && !looksAlreadyObfuscatedLua(code) &&
            !(await window.vxDialog.confirm('Lua obfuscation is off. The saved source will be readable to anyone who can access it. Save this vault without obfuscating it?', {
                title: 'Save without obfuscation?',
                confirmLabel: 'Save anyway',
                tone: 'warning'
            }))) {
            return;
        }
        const vaultId = activeVaultId.value || ('vx_' + Math.random().toString(36).substring(2, 10));

        isSaving = true;
        const originalBtnHtml = lockBtn.innerHTML;
        lockBtn.disabled = true;
        lockBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> PREPARING...';

        // Trigger the local download before awaiting Firestore so the browser
        // still recognizes the Save button click as the user's action.
        if (chkBackup && chkBackup.checked && !downloadLocalVaultBackup(vaultId, title, code)) {
            showToast('Vault saving will continue, but the browser could not start the .txt backup download.', 'info', 6000);
        }

        let encodedSourceCode;
        try {
            encodedSourceCode = await encodeVaultSource(code);
        } catch (error) {
            showToast('Could not compress the source script: ' + (error && error.message ? error.message : 'unknown error'), 'error', 8000);
            isSaving = false;
            lockBtn.disabled = false;
            lockBtn.innerHTML = originalBtnHtml;
            return;
        }

        let encodedObfuscatedCode = null;
        let generatedObfuscatedCode = null;
        const obfuscationEnabled = obfuscationSettings.enabled;
        const requestedObfuscationLevel = obfuscationSettings.requestedLevel;
        const effectiveObfuscationLevel = obfuscationSettings.effectiveLevel;
        const vmProtectionEnabled = obfuscationSettings.protection.vmProtection;
        const tamperCheckEnabled = obfuscationSettings.protection.tamperCheck;
        const expandedTransformsEnabled = obfuscationSettings.protection.expandedTransforms;
        const armorLayerCount = obfuscationSettings.protection.layers || null;
        const junkPreambleMode = obfuscationSettings.protection.junk;
        const junkCommentsEnabled = obfuscationSettings.protection.comments;
        const armorLayout = obfuscationSettings.protection.layout;
        if (obfuscationEnabled) {
            lockBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> OBFUSCATING ${effectiveObfuscationLevel.toUpperCase()}...`;
            try {
                generatedObfuscatedCode = await obfuscateLua(code, effectiveObfuscationLevel, obfuscationSettings.protection);
                encodedObfuscatedCode = await encodeObfuscatedCode(generatedObfuscatedCode);
            } catch (error) {
                const errorMessage = describeObfuscationError(error);
                if (generatedObfuscatedCode && saveObfuscationRevision === obfuscationRevision) {
                    offerUnstoredObfuscatedPreview(generatedObfuscatedCode, effectiveObfuscationLevel, errorMessage);
                    showToast('Vault saving stopped; the existing vault was left unchanged. The generated copy is available in the preview panel.', 'error', 8000);
                } else {
                    showToast('The VoidedX engine could not obfuscate this script: ' + errorMessage, 'error', 8000);
                }
                isSaving = false;
                lockBtn.disabled = false;
                lockBtn.innerHTML = originalBtnHtml;
                return;
            }
        }
        lockBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> SAVING...';

        let currentExecutions = 0;
        let currentLoaderVersion = 0;
        let existingKeyFields = {
            requireKey: false, guiMode: false, guiAppearance: null, publicKeyConfig: null, keys: [], key: '', keyGeneratedAt: null,
            ipLock: false, boundIp: null, bannedUsers: []
        };

        if (activeVaultId.value) {
            try {
                const docSnap = await getDoc(doc(db, "vaults", vaultId));
                if (docSnap.exists()) {
                    const existing = docSnap.data();
                    currentExecutions = existing.executions || 0;
                    currentLoaderVersion = Number.isSafeInteger(Number(existing.loaderVersion)) && Number(existing.loaderVersion) >= 0
                        ? Number(existing.loaderVersion)
                        : 0;
                    // Key system settings are managed on the separate Key System Manager
                    // page — saving the script here just carries them forward untouched.
                    existingKeyFields = {
                        requireKey: !!existing.requireKey,
                        guiMode: !!existing.guiMode,
                        guiAppearance: existing.guiAppearance || null,
                        publicKeyConfig: existing.publicKeyConfig || null,
                        keys: Array.isArray(existing.keys) ? existing.keys : [],
                        key: existing.key || '',
                        keyGeneratedAt: existing.keyGeneratedAt || null,
                        ipLock: !!existing.ipLock,
                        boundIp: existing.boundIp || null,
                        bannedUsers: Array.isArray(existing.bannedUsers) ? existing.bannedUsers : []
                    };
                }
            } catch (e) {}
        }

        const payload = {
            id: vaultId,
            title: title,
            code: encodedSourceCode.value,
            codeEncoding: encodedSourceCode.encoding,
            loaderVersion: currentLoaderVersion + 1,
            obfuscationEnabled,
            fastLoadCacheEnabled: !!(chkFastLoadCache && chkFastLoadCache.checked),
            obfuscationProfileVersion: 24,
            obfuscationLevel: requestedObfuscationLevel,
            tamperCheckEnabled,
            instantRunEnabled: !!(chkInstantRun && chkInstantRun.checked),
            vmProtectionEnabled,
            expandedTransformsEnabled,
            armorLayerCount: obfuscationEnabled ? armorLayerCount : null,
            junkPreambleMode,
            junkCommentsEnabled,
            armorLayout,
            obfuscatedCodeLevel: obfuscationEnabled ? effectiveObfuscationLevel : null,
            obfuscatedCode: encodedObfuscatedCode ? encodedObfuscatedCode.value : null,
            obfuscatedCodeEncoding: encodedObfuscatedCode ? encodedObfuscatedCode.encoding : null,
            ...existingKeyFields,
            executions: currentExecutions,
            autoDeleteAt: currentExecutions === 0 ? Date.now() + ZERO_EXECUTION_VAULT_TTL_MS : null,
            uid: currentUser.uid,
            updatedAt: Date.now()
        };

        try {
            const estimatedDocumentBytes = getUtf8ByteLength(JSON.stringify(payload));
            if (estimatedDocumentBytes > MAX_VAULT_DOCUMENT_ESTIMATE_BYTES) {
                const estimatedKiB = Math.ceil(estimatedDocumentBytes / 1024).toLocaleString();
                const sizeHint = obfuscationEnabled
                    ? 'Choose Fast or Medium, reduce the script, or download the generated preview below.'
                    : 'Reduce the script size.';
                if (generatedObfuscatedCode && saveObfuscationRevision === obfuscationRevision) {
                    offerUnstoredObfuscatedPreview(generatedObfuscatedCode, effectiveObfuscationLevel, `the vault is about ${estimatedKiB} KiB, above the ~920 KiB safe storage size`);
                }
                showToast(`This vault is about ${estimatedKiB} KiB, above the safe storage size (~920 KiB). The save was stopped and the existing vault is unchanged. ${sizeHint}`, 'error', 10000);
                return;
            }

            if (activeVaultId.value) {
                try {
                    await createRemoteVaultBackup(vaultId, 'before_save');
                } catch (backupErr) {
                    // Backup failure is non-fatal — log it silently and let the save continue.
                    console.warn('Server backup failed before save (vault will still be saved):', backupErr);
                }
            }
            await setDoc(doc(db, "vaults", vaultId), payload);
            if (!obfuscationEnabled) {
                clearObfuscatedPreview();
            } else if (generatedObfuscatedCode && saveObfuscationRevision === obfuscationRevision) {
                const outputKiB = Math.ceil(getUtf8ByteLength(generatedObfuscatedCode) / 1024).toLocaleString();
                setObfuscatedPreview(generatedObfuscatedCode, `Saved ${effectiveObfuscationLevel} execution copy · ${outputKiB} KiB.`);
            } else {
                markObfuscatedPreviewStale();
            }
            const savedVault = { id: vaultId, data: payload };
            const savedIndex = cachedVaults.findIndex(vault => vault.id === vaultId);
            if (savedIndex >= 0) cachedVaults[savedIndex] = savedVault;
            else cachedVaults.push(savedVault);
            scheduleUnusedVaultCleanup(savedVault, currentUser.uid);
            updateVaultCount(cachedVaults.length);
            updateVaultOverview();
            renderVaultList();
            vaultExpiryWarningIds.delete(vaultId);
            activeVaultId.value = vaultId;
            setEditorSourceContext(true);

            if (execCountBadge && execCountNum) {
                execCountNum.textContent = currentExecutions;
                execCountBadge.classList.remove('hidden');
            }

            const primaryKey = existingKeyFields.keys[0] || (existingKeyFields.key ? { key: existingKeyFields.key } : null);
            const loaderKey = (!existingKeyFields.guiMode && existingKeyFields.requireKey && primaryKey) ? primaryKey.key : '';
            refreshVaultLoader(vaultId, loaderKey);
            resultOverlay.classList.remove('hidden');

            if (existingKeyFields.requireKey) {
                getKeyOutput.value = `${window.location.origin}/key.html?id=${vaultId}`;
                getKeyRow.classList.remove('hidden');
            } else {
                getKeyRow.classList.add('hidden');
            }

            showToast('Vault saved and locked!', 'success');
            setEditorDirty(false);
            setProtectionKeyStatus(existingKeyFields.requireKey);

            if (currentUser) {
                editingIndicator.classList.remove('hidden');
                deleteBtn.classList.remove('hidden');
                loadUserVaults();
            }

        } catch (err) {
            showToast('Failed to save vault: ' + friendlyAuthError(err), 'error', 6000);
        } finally {
            isSaving = false;
            lockBtn.disabled = false;
            lockBtn.innerHTML = originalBtnHtml;
        }
    });

    // ---------------- Delete Vault ----------------

    function resetEditor() {
        refreshVaultLoader('');
        obfuscationRevision += 1;
        clearObfuscatedPreview();
        activeVaultId.value = '';
        scriptTitle.value = '';
        setEditorSourceContext(false);
        sourceCode.value = '';
        if (window.VoidedXEditor) window.VoidedXEditor.refresh();
        if (chkObfuscation) chkObfuscation.checked = false;
        if (obfuscationLevelSelect) obfuscationLevelSelect.value = 'auto';
        if (chkTamperCheck) chkTamperCheck.checked = true;
        if (chkInstantRun) chkInstantRun.checked = false;
        if (chkVmProtection) chkVmProtection.checked = false;
        if (chkExpandedTransforms) chkExpandedTransforms.checked = false;
        if (obfuscationLayersSelect) obfuscationLayersSelect.value = 'auto';
        if (obfuscationJunkSelect) obfuscationJunkSelect.value = 'normal';
        if (obfuscationLayoutSelect) obfuscationLayoutSelect.value = 'messy';
        if (chkJunkComments) chkJunkComments.checked = true;
        if (chkFastLoadCache) chkFastLoadCache.checked = false;
        syncObfuscationProtectionControls();
        setEditorDirty(false);
        setProtectionKeyStatus(false);
        keysystemStatusBadge.textContent = 'OFF';
        keysystemStatusBadge.classList.remove('on');
        keysystemStatusBadge.classList.add('hidden');
        editingIndicator.classList.add('hidden');
        deleteBtn.classList.add('hidden');
        resultOverlay.classList.add('hidden');
        getKeyRow.classList.add('hidden');
        if (execCountBadge) execCountBadge.classList.add('hidden');
        clearFieldError(sourceCode, codeError);
        clearFieldError(scriptTitle, titleError);
    }

    const claimVaultBtn = document.getElementById('claim-vault-btn');
    claimVaultBtn.addEventListener('click', async () => {
        if (!currentUser) return;
        if (vaultsLoadedForUid !== currentUser.uid) {
            showToast('Your saved scripts are still loading. Wait a moment, then try again.', 'info');
            return;
        }
        if (cachedVaults.length >= MAX_USER_VAULTS) {
            showToast('You can keep up to 5 scripts. Delete one before recovering another vault.', 'warning', 8000);
            return;
        }
        const vidInput = await window.vxDialog.prompt('Enter the ID of your old vault.', {
            title: 'Recover a vault',
            confirmLabel: 'Find vault',
            label: 'Vault ID',
            placeholder: 'vx_abc12345',
            hint: 'The ID looks like vx_abc12345 and was shown when the vault was created.'
        });
        if (vidInput === null) return;
        const vid = vidInput.trim();
        if (!vid) return;
        try {
            const ref = doc(db, "vaults", vid);
            const snap = await getDoc(ref);
            if (!snap.exists()) { showToast('No vault found with that ID.', 'error'); return; }
            const d = snap.data();
            if (d.uid === currentUser.uid) { showToast('That vault is already yours.', 'info'); return; }
            if (d.uid !== 'guest') { showToast('That vault belongs to another account.', 'error'); return; }
            await updateDoc(ref, { uid: currentUser.uid });
            cachedVaults.push({ id: vid, data: { ...d, uid: currentUser.uid } });
            updateVaultCount(cachedVaults.length);
            updateVaultOverview();
            renderVaultList();
            showToast('Vault recovered — it is now tied to your account.', 'success');
            loadUserVaults();
        } catch (err) {
            showToast('Could not recover vault: ' + friendlyAuthError(err), 'error');
        }
    });

    newVaultBtn.addEventListener('click', async () => {
        if (hasUnsavedChanges && !(await window.vxDialog.confirm('You have unsaved changes. Discard them and start a new vault?', {
            title: 'Start a new vault?',
            confirmLabel: 'Discard & start',
            tone: 'warning'
        }))) return;
        resetEditor();
        scriptTitle.focus();
        showToast('Ready for a new vault.', 'info', 2000);
    });

    openKeysystemBtn.addEventListener('click', () => {
        if (!activeVaultId.value) {
            showToast('Save this vault first, then you can manage its key system.', 'info');
            return;
        }
        window.location.href = `keysystem.html?id=${activeVaultId.value}`;
    });

    deleteBtn.addEventListener('click', async () => {
        const id = activeVaultId.value;
        if (!id) return;

        const confirmed = await customConfirm({
            title: 'Delete this vault?',
            message: `"${scriptTitle.value || 'Untitled Vault'}" will be permanently deleted. This can't be undone.`,
            confirmLabel: 'Delete Vault'
        });
        if (!confirmed) return;

        const originalBtnHtml = deleteBtn.innerHTML;
        deleteBtn.disabled = true;
        deleteBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> DELETING...';

        try {
            await createRemoteVaultBackup(id, 'before_delete');
            await deleteDoc(doc(db, "vaults", id));
            resetEditor();
            showToast('Vault deleted.', 'info');
            loadUserVaults();
        } catch (err) {
            showToast('Failed to delete vault: ' + friendlyAuthError(err), 'error', 6000);
        } finally {
            deleteBtn.disabled = false;
            deleteBtn.innerHTML = originalBtnHtml;
        }
    });

    copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(lsOutput.value);
        copyBtn.innerHTML = '<i class="fa-solid fa-check"></i> COPIED!';
        showToast('Loadstring copied to clipboard.', 'success', 2000);
        setTimeout(() => copyBtn.innerHTML = '<i class="fa-solid fa-copy"></i> COPY LOADSTRING', 2000);
    });
});

// ============================================================
// Share Your Ideas — sends feature requests to Firestore
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    const ideasBtn = document.getElementById('ideas-btn');
    const ideasModal = document.getElementById('ideas-modal');
    if (!ideasBtn || !ideasModal) return;

    const ideasCloseX = document.getElementById('ideas-close-x');
    const ideasCancelBtn = document.getElementById('ideas-cancel-btn');
    const ideasSubmitBtn = document.getElementById('ideas-submit-btn');
    const ideasSubmitLabel = document.getElementById('ideas-submit-label');
    const ideasName = document.getElementById('ideas-name');
    const ideasText = document.getElementById('ideas-text');
    const ideasError = document.getElementById('ideas-error');
    const ideasCount = document.getElementById('ideas-count');

    const IDEA_MIN = 10;
    const IDEA_MAX = 1000;

    const openIdeasModal = () => {
        ideasModal.classList.remove('hidden');
        clearFieldError(ideasText, ideasError);
        setTimeout(() => ideasText.focus(), 50);
    };

    const closeIdeasModal = () => {
        ideasModal.classList.add('hidden');
    };

    ideasBtn.addEventListener('click', openIdeasModal);
    ideasCloseX.addEventListener('click', closeIdeasModal);
    ideasCancelBtn.addEventListener('click', closeIdeasModal);
    ideasModal.addEventListener('click', (e) => {
        if (e.target === ideasModal) closeIdeasModal();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !ideasModal.classList.contains('hidden')) closeIdeasModal();
    });

    ideasText.addEventListener('input', () => {
        ideasCount.textContent = `${ideasText.value.length} / ${IDEA_MAX}`;
        clearFieldError(ideasText, ideasError);
    });

    ideasSubmitBtn.addEventListener('click', async () => {
        const idea = ideasText.value.trim();
        const name = ideasName.value.trim();

        if (idea.length < IDEA_MIN) {
            setFieldError(ideasText, ideasError, `Give us a bit more detail — at least ${IDEA_MIN} characters.`);
            shakeElement(ideasText);
            return;
        }
        clearFieldError(ideasText, ideasError);

        ideasSubmitBtn.disabled = true;
        ideasSubmitLabel.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> SENDING...';

        try {
            await addDoc(collection(db, 'feature_requests'), {
                name: name || 'Anonymous',
                idea: idea,
                uid: currentUser ? currentUser.uid : null,
                email: currentUser && currentUser.email ? currentUser.email : null,
                page: 'index',
                userAgent: navigator.userAgent,
                createdAt: serverTimestamp()
            });

            showToast('Thanks! Your idea was sent to the VoidedX team.', 'success');
            ideasText.value = '';
            ideasName.value = '';
            ideasCount.textContent = `0 / ${IDEA_MAX}`;
            closeIdeasModal();
        } catch (err) {
            showToast('Couldn\'t send your idea: ' + friendlyAuthError(err), 'error', 6000);
        } finally {
            ideasSubmitBtn.disabled = false;
            ideasSubmitLabel.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Send Idea';
        }
    });
});
