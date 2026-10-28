import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js';
import {
    getAuth, onAuthStateChanged, signInAnonymously
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js';
import {
    getFirestore, collection, doc, getDocs, query, setDoc, where
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import {
    MAX_INLINE_OBFUSCATED_PREVIEW_BYTES,
    MAX_OBFUSCATION_SOURCE_BYTES,
    MAX_VAULT_DOCUMENT_ESTIMATE_BYTES,
    encodeObfuscatedCode,
    encodeVaultSource,
    getUtf8ByteLength,
    obfuscateLua,
    resolveObfuscationLevel
} from './lua-medium.js';

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

const els = {
    loading: document.getElementById('obf-loading'),
    error: document.getElementById('obf-error'),
    errorMessage: document.getElementById('obf-error-message'),
    app: document.getElementById('obf-app'),
    tokenCard: document.getElementById('obf-token-card'),
    credits: document.getElementById('obf-credits'),
    sessionLine: document.getElementById('obf-session-line'),
    file: document.getElementById('obf-file'),
    source: document.getElementById('obf-source'),
    level: document.getElementById('obf-level'),
    tamper: document.getElementById('obf-tamper'),
    expanded: document.getElementById('obf-expanded'),
    run: document.getElementById('obf-run'),
    status: document.getElementById('obf-status'),
    title: document.getElementById('obf-title'),
    save: document.getElementById('obf-save'),
    vaultStatus: document.getElementById('obf-vault-status'),
    result: document.getElementById('obf-result'),
    output: document.getElementById('obf-output'),
    download: document.getElementById('obf-download')
};

const params = new URLSearchParams(location.search);
let sessionToken = (params.get('vx') || params.get('token') || '').trim();
if (!sessionToken) {
    const match = location.pathname.match(/^\/obfuscationvx=([A-Za-z0-9_-]{24,64})\/?$/);
    if (match) sessionToken = match[1];
}

let credits = 0;
let session = null;
let generated = null;
let running = false;
let saving = false;
let savedVaultId = null;
let authUser = null;

function setMessage(element, message, kind = 'info') {
    element.textContent = message;
    element.className = `admin-status ${kind}`;
    element.classList.remove('hidden');
}

function setBusy(button, busy, label) {
    if (busy) {
        button.dataset.savedHtml = button.innerHTML;
        button.disabled = true;
        button.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${label}`;
        return;
    }
    button.disabled = false;
    if (button.dataset.savedHtml) {
        button.innerHTML = button.dataset.savedHtml;
        delete button.dataset.savedHtml;
    }
}

function showError(message) {
    els.loading.classList.add('hidden');
    els.app.classList.add('hidden');
    els.error.classList.remove('hidden');
    els.errorMessage.textContent = message;
}

function baseName() {
    const raw = (els.title.value || session?.filename || 'script').trim();
    return (raw.replace(/[\\/:*?"<>|\r\n]/g, '').replace(/\.(lua|txt)$/i, '').trim() || 'script').slice(0, 80);
}

function downloadName() {
    return `${baseName()}-obfuscated.lua`;
}

function updateCredits() {
    const shown = Math.max(0, Number(credits) || 0);
    els.credits.textContent = String(shown);
    els.tokenCard.classList.toggle('empty', shown <= 0);
    refreshButtons();
}

function refreshButtons() {
    const hasCredits = credits > 0;
    if (!running) {
        els.run.disabled = !hasCredits;
    }
    const stale = !generated || els.source.value !== generated.source;
    els.save.disabled = saving || !generated || stale || Boolean(savedVaultId);
    els.download.disabled = !generated;
}

function renderSessionLine() {
    if (!session) return;
    const parts = [];
    if (session.discordUsername) parts.push(`Issued to ${session.discordUsername}`);
    parts.push(`${credits} of 5 void tokens remaining`);
    if (session.expiresAt) {
        try {
            parts.push(`Link expires ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(session.expiresAt))}`);
        } catch {}
    }
    els.sessionLine.textContent = parts.join('  ·  ');
}

function triggerDownload() {
    if (!generated) return;
    const blob = new Blob([generated.output], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = downloadName();
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function consumeToken() {
    const res = await fetch('/api/obfuscation-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vx: sessionToken, action: 'consume' })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.message || 'This void token could not be used.');
    credits = Math.max(0, Number(data.credits) || 0);
    updateCredits();
    renderSessionLine();
}

async function loadSession() {
    if (!/^[A-Za-z0-9_-]{24,64}$/.test(sessionToken)) {
        showError('This obfuscation link is not valid. Run /obfuscate again in Discord.');
        return;
    }
    try {
        const res = await fetch(`/api/obfuscation-session?vx=${encodeURIComponent(sessionToken)}`, { cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.message || 'This obfuscation link is invalid or has expired.');
        session = data;
        credits = Math.max(0, Number(data.credits) || 0);
        els.loading.classList.add('hidden');
        els.app.classList.remove('hidden');
        if (data.source) els.source.value = data.source;
        if (data.level) els.level.value = data.level;
        if (data.filename && data.filename !== 'script.lua') {
            els.title.value = data.filename.replace(/\.(lua|txt)$/i, '').slice(0, 80);
        }
        updateCredits();
        renderSessionLine();
        if (credits <= 0) {
            setMessage(els.status, 'You have used all 5 void tokens on this link. Run /obfuscate again in Discord for a new link.', 'error');
        }
    } catch (error) {
        showError(error.message || 'This obfuscation link is invalid or has expired.');
    }
}

onAuthStateChanged(auth, user => {
    authUser = user;
    if (!user) {
        signInAnonymously(auth).catch(() => {});
    }
});

els.file.addEventListener('change', async () => {
    const file = els.file.files?.[0];
    if (!file) return;
    if (file.size > MAX_OBFUSCATION_SOURCE_BYTES) {
        setMessage(els.status, 'That file is over the 4 MiB browser obfuscation limit.', 'error');
        els.file.value = '';
        return;
    }
    try {
        const text = await file.text();
        if (getUtf8ByteLength(text) > MAX_OBFUSCATION_SOURCE_BYTES) {
            setMessage(els.status, 'That file is over the 4 MiB browser obfuscation limit.', 'error');
            return;
        }
        els.source.value = text;
        if (!els.title.value.trim()) {
            els.title.value = file.name.replace(/\.(lua|txt)$/i, '').slice(0, 80);
        }
        setMessage(els.status, `Loaded ${file.name} (${text.length.toLocaleString()} chars).`, 'info');
        refreshButtons();
    } catch {
        setMessage(els.status, 'That file could not be read as text.', 'error');
    }
});

els.source.addEventListener('input', refreshButtons);
els.title.addEventListener('input', () => {
    if (generated && !savedVaultId) {
        els.vaultStatus.classList.add('hidden');
    }
});

els.run.addEventListener('click', async () => {
    if (running) return;
    if (credits <= 0) {
        setMessage(els.status, 'You have used all 5 void tokens on this link. Run /obfuscate again in Discord.', 'error');
        return;
    }
    const source = els.source.value;
    if (!source.trim()) {
        setMessage(els.status, 'Paste a script or upload a .lua file first.', 'error');
        els.source.focus();
        return;
    }
    if (getUtf8ByteLength(source) > MAX_OBFUSCATION_SOURCE_BYTES) {
        setMessage(els.status, 'This script is over the 4 MiB browser obfuscation limit.', 'error');
        return;
    }

    const requestedLevel = els.level.value;
    const effectiveLevel = resolveObfuscationLevel(source, requestedLevel);
    const tamperCheck = requestedLevel === 'absolute' || els.tamper.checked;
    const expandedTransforms = requestedLevel === 'absolute' || (requestedLevel !== 'fast' && els.expanded.checked);

    running = true;
    setBusy(els.run, true, 'Obfuscating...');
    setMessage(els.status, `Running the VoidedX engine at ${effectiveLevel} strength...`, 'info');
    els.result.classList.add('hidden');
    els.vaultStatus.classList.add('hidden');
    savedVaultId = null;

    try {
        const output = await obfuscateLua(source, effectiveLevel, {
            tamperCheck,
            expandedTransforms,
            vmProtection: true
        });
        generated = {
            source,
            requestedLevel,
            effectiveLevel,
            tamperCheck,
            expandedTransforms,
            output
        };
        const outputBytes = getUtf8ByteLength(output);
        if (outputBytes <= MAX_INLINE_OBFUSCATED_PREVIEW_BYTES) {
            els.output.value = output;
            els.output.placeholder = '';
        } else {
            els.output.value = '';
            els.output.placeholder = `Generated copy is ${(outputBytes / (1024 * 1024)).toFixed(1)} MiB. Use the download button.`;
        }
        els.result.classList.remove('hidden');
        refreshButtons();
        triggerDownload();

        try {
            await consumeToken();
            setMessage(els.status, `Protected file generated at ${effectiveLevel} strength and downloaded. ${credits} void token${credits === 1 ? '' : 's'} left.`, 'success');
        } catch (error) {
            if (/all 5|expired|invalid/i.test(error.message || '')) {
                credits = 0;
                updateCredits();
                renderSessionLine();
            }
            setMessage(els.status, `The file was generated and downloaded, but the link could not spend a void token: ${error.message}`, 'error');
        }
    } catch (error) {
        generated = null;
        els.result.classList.add('hidden');
        setMessage(els.status, `Obfuscation failed: ${error.message || 'unknown error'}`, 'error');
    } finally {
        running = false;
        setBusy(els.run, false);
        refreshButtons();
    }
});

els.download.addEventListener('click', triggerDownload);

els.save.addEventListener('click', async () => {
    if (saving || !generated) return;
    if (els.source.value !== generated.source) {
        setMessage(els.vaultStatus, 'The source changed after obfuscation. Generate a new copy before saving.', 'error');
        return;
    }
    const title = els.title.value.trim().slice(0, 80);
    if (!title) {
        setMessage(els.vaultStatus, 'Enter a vault title before saving.', 'error');
        els.title.focus();
        return;
    }

    saving = true;
    setBusy(els.save, true, 'Saving...');
    try {
        let user = authUser || auth.currentUser;
        if (!user) {
            const credential = await signInAnonymously(auth);
            user = credential.user;
            authUser = user;
        }

        const existing = await getDocs(query(collection(db, 'vaults'), where('uid', '==', user.uid)));
        if (existing.size >= 5) {
            throw new Error('This browser already has 5 saved vaults. Delete one in the Creator Panel before saving another.');
        }

        const encodedSource = await encodeVaultSource(generated.source);
        const encodedOutput = await encodeObfuscatedCode(generated.output);
        const vaultId = `vx_${makeId(8)}`;
        const payload = {
            id: vaultId,
            title,
            code: encodedSource.value,
            codeEncoding: encodedSource.encoding,
            loaderVersion: 1,
            obfuscationEnabled: true,
            fastLoadCacheEnabled: false,
            obfuscationProfileVersion: 17,
            obfuscationLevel: generated.requestedLevel,
            tamperCheckEnabled: generated.tamperCheck,
            vmProtectionEnabled: true,
            expandedTransformsEnabled: generated.expandedTransforms,
            obfuscatedCodeLevel: generated.effectiveLevel,
            obfuscatedCode: encodedOutput.value,
            obfuscatedCodeEncoding: encodedOutput.encoding,
            requireKey: false,
            guiMode: false,
            guiAppearance: null,
            publicKeyConfig: null,
            keys: [],
            key: '',
            keyGeneratedAt: null,
            ipLock: false,
            boundIp: null,
            bannedUsers: [],
            executions: 0,
            autoDeleteAt: Date.now() + 10 * 60 * 60 * 1000,
            uid: user.uid,
            updatedAt: Date.now()
        };

        const estimated = getUtf8ByteLength(JSON.stringify(payload));
        if (estimated > MAX_VAULT_DOCUMENT_ESTIMATE_BYTES) {
            throw new Error(`This copy is about ${Math.ceil(estimated / 1024).toLocaleString()} KiB, above the safe vault size (~920 KiB). Download it instead, or use a lower strength.`);
        }

        await setDoc(doc(db, 'vaults', vaultId), payload);
        savedVaultId = vaultId;
        els.save.innerHTML = '<i class="fa-solid fa-circle-check"></i> Saved to vault';

        els.vaultStatus.replaceChildren();
        const line = document.createElement('div');
        line.textContent = `Vault saved as ${vaultId}. Vaults with no executions are removed after 10 hours.`;
        const link = document.createElement('a');
        link.className = 'obf-vault-link';
        link.href = `/?vault=${encodeURIComponent(vaultId)}`;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = 'Open it in the script editor';
        els.vaultStatus.append(line, link);
        if (user.isAnonymous) {
            const note = document.createElement('div');
            note.textContent = 'This browser is signed in as a guest. On another device, open the editor and use Recover old vault by ID with this ID.';
            els.vaultStatus.append(note);
        }
        els.vaultStatus.className = 'admin-status success';
        els.vaultStatus.classList.remove('hidden');
    } catch (error) {
        setMessage(els.vaultStatus, `Could not save this vault: ${error.message || 'unknown error'}`, 'error');
    } finally {
        saving = false;
        setBusy(els.save, false);
        if (savedVaultId) {
            els.save.disabled = true;
            els.save.innerHTML = '<i class="fa-solid fa-circle-check"></i> Saved to vault';
        }
        refreshButtons();
        if (savedVaultId) els.save.disabled = true;
    }
});

function makeId(length) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    let out = '';
    for (let i = 0; i < length; i++) out += chars[bytes[i] % chars.length];
    return out;
}

loadSession();
