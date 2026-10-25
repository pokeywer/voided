import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js';
import {
    getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut
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
    if (!activeUser || activeUser.isAnonymous) return;
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
document.getElementById('panel-password').addEventListener('keydown', event => {
    if (event.key === 'Enter') authenticate(signInButton);
});
document.getElementById('panel-refresh-btn').addEventListener('click', loadVaults);
document.getElementById('panel-logout-btn').addEventListener('click', () => signOut(auth));

onAuthStateChanged(auth, user => {
    activeUser = user;
    const isAccount = !!user && !user.isAnonymous;
    loginView.classList.toggle('hidden', isAccount);
    dashboard.classList.toggle('hidden', !isAccount);
    document.getElementById('panel-logout-btn').classList.toggle('hidden', !isAccount);
    if (isAccount) {
        document.getElementById('panel-user-label').textContent = user.email || 'Signed-in VoidedX account';
        loadVaults();
    } else {
        loadedVaults = [];
        vaultList.replaceChildren();
        if (user?.isAnonymous) setMessage(authError, 'This browser has a guest session. Sign in to see scripts saved to your account.', 'info');
    }
});
