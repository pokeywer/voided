import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js';
import {
    getAuth, onAuthStateChanged, signOut, setPersistence, browserLocalPersistence,
    signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail,
    GoogleAuthProvider, OAuthProvider, signInWithPopup, linkWithPopup, signInWithCredential,
    EmailAuthProvider, linkWithCredential
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js';

// Every visitor page requires a real account. This gate mounts before the
// page's own module resolves, reuses whatever Firebase app the page created,
// and moves any vaults owned by a leftover anonymous session onto the account
// that signs in.

const firebaseConfig = {
    apiKey: 'AIzaSyBdAR4ARjHccTlxrmP9tzdYGJxo4MvETXw',
    authDomain: 'voidedx-fe79f.firebaseapp.com',
    projectId: 'voidedx-fe79f',
    storageBucket: 'voidedx-fe79f.firebasestorage.app',
    messagingSenderId: '784635868195',
    appId: '1:784635868195:web:6e879214df4238bc2aad96'
};

const FRIENDLY_ERRORS = {
    'auth/invalid-email': 'That email address is not valid.',
    'auth/invalid-credential': 'Email or password is incorrect.',
    'auth/wrong-password': 'Email or password is incorrect.',
    'auth/user-not-found': 'Email or password is incorrect.',
    'auth/email-already-in-use': 'That email already has an account. Switch to Log in.',
    'auth/credential-already-in-use': 'That credential already has an account. Switch to Log in.',
    'auth/account-exists-with-different-credential': 'That email already uses another sign-in method. Log in with that method first.',
    'auth/weak-password': 'Use a password with at least 6 characters.',
    'auth/too-many-requests': 'Too many attempts. Wait a little and try again.',
    'auth/network-request-failed': 'Network error. Check your connection and retry.',
    'auth/popup-closed-by-user': 'The sign-in window closed before it finished.',
    'auth/cancelled-popup-request': 'Another sign-in window is already open.',
    'auth/popup-blocked': 'The browser blocked the sign-in window. Allow pop-ups and retry.',
    'auth/unauthorized-domain': 'This site address is not authorized for sign-in yet.',
    'auth/operation-not-allowed': 'This sign-in method is not enabled on the site yet.',
    'auth/user-disabled': 'This account has been disabled.'
};

const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });
const discordProvider = new OAuthProvider('discord.com');
// The email claim is what keeps a person's void tokens on one ledger when they
// switch between Discord and the other sign-in methods.
discordProvider.addScope('identify');
discordProvider.addScope('email');

let auth = null;
let overlay = null;
let form = null;
let emailInput = null;
let passwordInput = null;
let errorNode = null;
let statusNode = null;
let submitButton = null;
let googleButton = null;
let discordButton = null;
let guestNote = null;
let tabsNode = null;
let orNode = null;
let fineNode = null;
let forgotButton = null;
let resetForm = null;
let resetEmail = null;
let resetError = null;
let resetSent = null;
let resetButton = null;
let tabButtons = [];
let gateHidden = false;
let mode = 'login';
let submitting = false;
let resetting = false;

function friendlyError(error) {
    return FRIENDLY_ERRORS[error?.code] || error?.message || 'Sign-in failed. Try again.';
}

function injectStyles() {
    if (document.getElementById('vx-auth-styles')) return;
    const style = document.createElement('style');
    style.id = 'vx-auth-styles';
    style.textContent = `
        body.vx-auth-locked { overflow: hidden !important; }
        .vx-auth-gate {
            position: fixed; inset: 0; z-index: 100000; display: flex; align-items: center; justify-content: center;
            padding: 24px 16px; overflow-y: auto; overscroll-behavior: contain;
            background: radial-gradient(1200px 600px at 50% -10%, rgba(34, 211, 238, .12), transparent 60%), #05070c;
            color: #e2e8f0; font-family: "Inter", "Segoe UI", system-ui, sans-serif;
        }
        .vx-auth-gate[data-checking="true"] .vx-auth-card { visibility: hidden; }
        .vx-auth-gate[data-checking="true"]::after {
            content: ''; position: absolute; left: 50%; top: 50%; width: 28px; height: 28px; margin: -14px 0 0 -14px;
            border: 3px solid rgba(34, 211, 238, .18); border-top-color: #22d3ee; border-radius: 50%;
            animation: vx-auth-spin .7s linear infinite;
        }
        @keyframes vx-auth-spin { to { transform: rotate(360deg); } }
        .vx-auth-card {
            width: min(420px, 100%); margin: auto; padding: 26px 24px 22px; border-radius: 18px;
            border: 1px solid rgba(148, 163, 184, .18); background: linear-gradient(180deg, rgba(15, 23, 42, .94), rgba(5, 7, 12, .97));
            box-shadow: 0 30px 80px rgba(0, 0, 0, .55), inset 0 1px 0 rgba(255, 255, 255, .04);
        }
        .vx-auth-card [hidden] { display: none !important; }
        .vx-auth-brand { display: flex; align-items: center; gap: 10px; margin-bottom: 18px; }
        .vx-auth-brand img { width: 30px; height: 30px; object-fit: contain; }
        .vx-auth-brand strong { display: block; color: #f8fafc; font-size: 13px; font-weight: 900; letter-spacing: .18em; }
        .vx-auth-brand small { display: block; margin-top: 2px; color: #64748b; font-size: 9px; font-weight: 700; letter-spacing: .16em; }
        .vx-auth-card h1 { margin: 0; color: #f8fafc; font-size: 23px; font-weight: 900; letter-spacing: -.7px; }
        .vx-auth-card h2 { margin: 0; color: #f8fafc; font-size: 16px; font-weight: 900; letter-spacing: -.3px; }
        .vx-auth-sub, .vx-auth-reset-note { margin: 7px 0 0; color: #8b9bb0; font-size: 12px; line-height: 1.55; }
        .vx-auth-guest {
            margin-top: 12px; padding: 9px 11px; border-radius: 9px; border: 1px solid rgba(34, 211, 238, .28);
            background: rgba(34, 211, 238, .07); color: #a5f3fc; font-size: 10.5px; font-weight: 650; line-height: 1.45;
        }
        .vx-auth-tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; margin: 18px 0 14px; padding: 3px; border-radius: 10px; border: 1px solid rgba(148, 163, 184, .14); background: rgba(148, 163, 184, .05); }
        .vx-auth-tab { appearance: none; border: 0; border-radius: 7px; padding: 8px 6px; background: transparent; color: #8b9bb0; font: inherit; font-size: 11px; font-weight: 800; letter-spacing: .04em; cursor: pointer; transition: background .15s ease, color .15s ease; }
        .vx-auth-tab.on { background: rgba(34, 211, 238, .14); color: #ecfeff; box-shadow: inset 0 0 0 1px rgba(34, 211, 238, .28); }
        .vx-auth-form { display: grid; gap: 10px; }
        .vx-auth-reset { gap: 12px; margin-top: 18px; }
        .vx-auth-field { display: grid; gap: 5px; }
        .vx-auth-field span { color: #7d8ca3; font-size: 9px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
        .vx-auth-field input {
            width: 100%; box-sizing: border-box; padding: 11px 12px; border-radius: 9px; border: 1px solid rgba(148, 163, 184, .18);
            background: rgba(2, 6, 12, .7); color: #e2e8f0; font: inherit; font-size: 13px; outline: none;
            transition: border-color .15s ease, box-shadow .15s ease;
        }
        .vx-auth-field input:focus { border-color: rgba(34, 211, 238, .55); box-shadow: 0 0 0 3px rgba(34, 211, 238, .12); }
        .vx-auth-forgot-row { display: flex; justify-content: flex-end; margin-top: -2px; }
        .vx-auth-link { appearance: none; border: 0; background: none; padding: 0; color: #67e8f9; font: inherit; font-size: 10.5px; font-weight: 700; cursor: pointer; }
        .vx-auth-link:hover { text-decoration: underline; }
        .vx-auth-error { margin: 0; padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(248, 113, 113, .35); background: rgba(248, 113, 113, .1); color: #fecaca; font-size: 11px; line-height: 1.4; }
        .vx-auth-sent { margin: 0; padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(34, 211, 238, .32); background: rgba(34, 211, 238, .08); color: #a5f3fc; font-size: 11px; line-height: 1.45; }
        .vx-auth-submit {
            display: inline-flex; align-items: center; justify-content: center; gap: 8px; width: 100%; padding: 12px 16px; margin-top: 2px;
            border: 0; border-radius: 10px; background: linear-gradient(120deg, #22d3ee, #6366f1 55%, #7c3aed); color: #f8fafc;
            font: inherit; font-size: 12.5px; font-weight: 900; letter-spacing: .03em; cursor: pointer;
            box-shadow: 0 12px 30px rgba(34, 211, 238, .16); transition: filter .15s ease, transform .15s ease;
        }
        .vx-auth-submit:hover { filter: brightness(1.08); }
        .vx-auth-submit:disabled { opacity: .6; cursor: progress; }
        .vx-auth-or { display: flex; align-items: center; gap: 10px; margin: 14px 0; color: #4b5b70; font-size: 9px; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; }
        .vx-auth-or::before, .vx-auth-or::after { content: ''; flex: 1; height: 1px; background: rgba(148, 163, 184, .14); }
        .vx-auth-oauth {
            display: inline-flex; align-items: center; justify-content: center; gap: 9px; width: 100%; padding: 11px 16px;
            border: 1px solid rgba(148, 163, 184, .22); border-radius: 10px; background: rgba(148, 163, 184, .05);
            color: #dbe7f5; font: inherit; font-size: 12px; font-weight: 800; cursor: pointer; transition: background .15s ease, border-color .15s ease;
        }
        .vx-auth-oauth + .vx-auth-oauth { margin-top: 8px; }
        .vx-auth-oauth:hover { background: rgba(148, 163, 184, .1); border-color: rgba(148, 163, 184, .34); }
        .vx-auth-oauth:disabled { opacity: .6; cursor: progress; }
        .vx-auth-oauth b { display: inline-flex; align-items: center; justify-content: center; width: 17px; height: 17px; border-radius: 50%; background: #f8fafc; color: #1f2937; font-size: 10px; font-weight: 900; }
        .vx-auth-discord b { background: #5865f2; color: #fff; }
        .vx-auth-status { min-height: 14px; margin: 12px 0 0; color: #64748b; font-size: 10px; font-weight: 650; text-align: center; }
        .vx-auth-fine { margin: 10px 0 0; color: #4b5b70; font-size: 9.5px; line-height: 1.5; text-align: center; }
        .vx-auth-notice {
            position: fixed; left: 18px; bottom: 18px; z-index: 100001; display: flex; align-items: flex-start; gap: 10px;
            max-width: min(380px, calc(100vw - 36px)); padding: 12px 14px; border-radius: 11px;
            border: 1px solid rgba(34, 211, 238, .32); background: #0b1220; color: #dbeafe;
            font-family: "Inter", "Segoe UI", system-ui, sans-serif; font-size: 11.5px; line-height: 1.5;
            box-shadow: 0 18px 40px rgba(0, 0, 0, .45);
        }
        .vx-auth-notice.error { border-color: rgba(248, 113, 113, .4); color: #fecaca; }
        .vx-auth-notice button { appearance: none; border: 0; background: transparent; color: inherit; font-size: 15px; line-height: 1; cursor: pointer; opacity: .7; }
        .vx-auth-notice span { flex: 1; }
        @media (max-width: 480px) {
            .vx-auth-gate { padding: 14px 12px; align-items: flex-start; }
            .vx-auth-card { padding: 22px 18px 18px; border-radius: 15px; }
            .vx-auth-card h1 { font-size: 20px; }
        }
    `;
    document.head.appendChild(style);
}

function buildGate() {
    if (overlay) return;
    injectStyles();
    overlay = document.createElement('div');
    overlay.id = 'vx-auth-gate';
    overlay.className = 'vx-auth-gate';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'vx-auth-title');
    overlay.dataset.checking = 'true';
    overlay.innerHTML = `
        <div class="vx-auth-card">
            <div class="vx-auth-brand">
                <img src="/logo.png" alt="">
                <div><strong>VOIDEDX</strong><small>ACCOUNT REQUIRED</small></div>
            </div>
            <h1 id="vx-auth-title">Sign in to VoidedX</h1>
            <p class="vx-auth-sub">Every page now needs a real account. Guest vaults saved in this browser move to your account automatically when you sign in.</p>
            <div class="vx-auth-guest" hidden>Guest session found. Sign in or create an account to keep this browser's vaults.</div>
            <div class="vx-auth-tabs" role="tablist" aria-label="Account action">
                <button type="button" class="vx-auth-tab on" data-mode="login" role="tab" aria-selected="true">Log in</button>
                <button type="button" class="vx-auth-tab" data-mode="signup" role="tab" aria-selected="false">Create account</button>
            </div>
            <form class="vx-auth-form vx-auth-login" novalidate>
                <label class="vx-auth-field"><span>Email</span><input type="email" name="email" autocomplete="email" spellcheck="false" required></label>
                <label class="vx-auth-field"><span>Password</span><input type="password" name="password" autocomplete="current-password" maxlength="200" required></label>
                <div class="vx-auth-forgot-row"><button type="button" class="vx-auth-link vx-auth-forgot">Forgot password?</button></div>
                <p class="vx-auth-error" role="alert" hidden></p>
                <button type="submit" class="vx-auth-submit">Log in</button>
            </form>
            <div class="vx-auth-or"><span>or</span></div>
            <button type="button" class="vx-auth-oauth vx-auth-google"><b>G</b> Continue with Google</button>
            <button type="button" class="vx-auth-oauth vx-auth-discord"><b>D</b> Continue with Discord</button>
            <p class="vx-auth-status" aria-live="polite">Checking your account…</p>
            <p class="vx-auth-fine">Use email, Google, or Discord. Guest mode is no longer available.</p>
            <form class="vx-auth-form vx-auth-reset" hidden novalidate>
                <h2>Reset your password</h2>
                <p class="vx-auth-reset-note">Enter the email on your VoidedX account and we send a reset link. Google and Discord accounts sign in with those buttons instead.</p>
                <label class="vx-auth-field"><span>Email</span><input type="email" name="reset-email" autocomplete="email" spellcheck="false" maxlength="254" required></label>
                <p class="vx-auth-error" role="alert" hidden></p>
                <p class="vx-auth-sent" role="status" hidden></p>
                <button type="submit" class="vx-auth-submit">Send reset link</button>
                <button type="button" class="vx-auth-link vx-auth-back">Back to log in</button>
            </form>
        </div>
    `;
    document.body.appendChild(overlay);

    form = overlay.querySelector('.vx-auth-login');
    emailInput = overlay.querySelector('input[name="email"]');
    passwordInput = overlay.querySelector('input[name="password"]');
    errorNode = overlay.querySelector('.vx-auth-login .vx-auth-error');
    statusNode = overlay.querySelector('.vx-auth-status');
    submitButton = overlay.querySelector('.vx-auth-login .vx-auth-submit');
    googleButton = overlay.querySelector('.vx-auth-google');
    discordButton = overlay.querySelector('.vx-auth-discord');
    guestNote = overlay.querySelector('.vx-auth-guest');
    tabsNode = overlay.querySelector('.vx-auth-tabs');
    orNode = overlay.querySelector('.vx-auth-or');
    fineNode = overlay.querySelector('.vx-auth-fine');
    tabButtons = Array.from(overlay.querySelectorAll('.vx-auth-tab'));

    resetForm = overlay.querySelector('.vx-auth-reset');
    resetEmail = overlay.querySelector('input[name="reset-email"]');
    resetError = overlay.querySelector('.vx-auth-reset .vx-auth-error');
    resetSent = overlay.querySelector('.vx-auth-sent');
    resetButton = overlay.querySelector('.vx-auth-reset .vx-auth-submit');
    forgotButton = overlay.querySelector('.vx-auth-forgot');

    tabButtons.forEach(button => button.addEventListener('click', () => setMode(button.dataset.mode)));
    form.addEventListener('submit', handleSubmit);
    resetForm.addEventListener('submit', handleReset);
    googleButton.addEventListener('click', handleGoogle);
    discordButton.addEventListener('click', handleDiscord);
    forgotButton.addEventListener('click', () => showReset(true));
    overlay.querySelector('.vx-auth-back').addEventListener('click', () => showReset(false));

    lockScroll(true);
}

function lockScroll(locked) {
    document.body.classList.toggle('vx-auth-locked', locked);
}

function setMode(next) {
    mode = next === 'signup' ? 'signup' : 'login';
    tabButtons.forEach(button => {
        const on = button.dataset.mode === mode;
        button.classList.toggle('on', on);
        button.setAttribute('aria-selected', String(on));
    });
    submitButton.textContent = mode === 'signup' ? 'Create account' : 'Log in';
    passwordInput.autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
    overlay.querySelector('.vx-auth-forgot-row').hidden = mode === 'signup';
    hideError();
}

function showReset(show) {
    form.hidden = show;
    tabsNode.hidden = show;
    orNode.hidden = show;
    googleButton.hidden = show;
    discordButton.hidden = show;
    fineNode.hidden = show;
    resetForm.hidden = !show;
    resetError.hidden = true;
    resetSent.hidden = true;
    if (show) {
        statusNode.hidden = true;
        resetEmail.value = emailInput.value.trim() || resetEmail.value;
        setTimeout(() => resetEmail.focus(), 30);
    } else {
        statusNode.textContent = '';
        statusNode.hidden = true;
        setTimeout(() => emailInput.focus(), 30);
    }
}

function setChecking(checking) {
    overlay.dataset.checking = String(checking);
    submitButton.disabled = checking;
    googleButton.disabled = checking;
    discordButton.disabled = checking;
    statusNode.textContent = checking ? 'Checking your account…' : '';
    statusNode.hidden = !checking;
}

function showGate({ anonymous = false } = {}) {
    buildGate();
    overlay.hidden = false;
    overlay.style.display = 'flex';
    gateHidden = false;
    lockScroll(true);
    guestNote.hidden = !anonymous;
    setChecking(false);
    setTimeout(() => {
        if (!gateHidden && window.matchMedia('(min-width: 768px)').matches) emailInput.focus();
    }, 40);
}

function hideGate() {
    if (!overlay || gateHidden) return;
    gateHidden = true;
    overlay.hidden = true;
    overlay.style.display = 'none';
    lockScroll(false);
}

function showError(message) {
    errorNode.textContent = message;
    errorNode.hidden = false;
}

function hideError() {
    errorNode.textContent = '';
    errorNode.hidden = true;
}

function setBusy(busy, label) {
    submitButton.disabled = busy;
    googleButton.disabled = busy;
    discordButton.disabled = busy;
    submitButton.textContent = busy ? 'Working…' : (mode === 'signup' ? 'Create account' : 'Log in');
    statusNode.textContent = busy && label ? label : (overlay.dataset.checking === 'true' ? 'Checking your account…' : '');
    statusNode.hidden = !statusNode.textContent;
}

function notify(message, isError = false) {
    const node = document.createElement('div');
    node.className = `vx-auth-notice${isError ? ' error' : ''}`;
    node.innerHTML = '<span></span><button type="button" aria-label="Dismiss">×</button>';
    node.querySelector('span').textContent = message;
    node.querySelector('button').addEventListener('click', () => node.remove());
    document.body.appendChild(node);
    setTimeout(() => node.remove(), 10000);
}

async function currentGuest() {
    const user = auth?.currentUser;
    if (!user || !user.isAnonymous) return null;
    try {
        return { uid: user.uid, token: await user.getIdToken() };
    } catch {
        return null;
    }
}

async function claimGuestVaults(guest) {
    const user = auth?.currentUser;
    if (!guest || !user || user.isAnonymous || guest.uid === user.uid) return;
    try {
        const idToken = await user.getIdToken();
        const res = await fetch('/api/claim-guest-vaults', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
            body: JSON.stringify({ guestToken: guest.token })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) {
            notify(`Signed in, but guest vaults could not be moved: ${data.message || 'try again later'}.`, true);
            return;
        }
        const moved = Number(data.moved) || 0;
        if (moved > 0) {
            notify(`Moved ${moved} guest vault${moved === 1 ? '' : 's'} to your account.`);
            window.dispatchEvent(new CustomEvent('voidedx:vaults-claimed', { detail: { moved } }));
        }
    } catch {
        notify('Signed in, but guest vaults could not be moved right now.', true);
    }
}

async function finishSignIn(guest) {
    hideGate();
    await claimGuestVaults(guest);
}

function validate(email, password) {
    if (!email) return 'Enter your email address.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'That email address is not valid.';
    if (!password) return 'Enter your password.';
    if (mode === 'signup' && password.length < 6) return 'Use a password with at least 6 characters.';
    return '';
}

function authReady() {
    if (auth) return true;
    showError('Accounts are still loading. Try again in a second.');
    return false;
}

async function handleSubmit(event) {
    event.preventDefault();
    if (submitting || !authReady()) return;
    hideError();
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    const problem = validate(email, password);
    if (problem) {
        showError(problem);
        return;
    }

    const guest = await currentGuest();
    submitting = true;
    setBusy(true, mode === 'signup' ? 'Creating your account…' : 'Signing you in…');
    try {
        if (mode === 'signup') {
            if (auth.currentUser?.isAnonymous) {
                try {
                    await linkWithCredential(auth.currentUser, EmailAuthProvider.credential(email, password));
                } catch (error) {
                    if (['auth/email-already-in-use', 'auth/credential-already-in-use', 'auth/invalid-credential'].includes(error.code)) {
                        await signInWithEmailAndPassword(auth, email, password);
                    } else {
                        throw error;
                    }
                }
            } else {
                await createUserWithEmailAndPassword(auth, email, password);
            }
        } else {
            await signInWithEmailAndPassword(auth, email, password);
        }
        passwordInput.value = '';
        await finishSignIn(guest);
    } catch (error) {
        showError(friendlyError(error));
        setBusy(false);
    } finally {
        submitting = false;
    }
}

async function handleReset(event) {
    event.preventDefault();
    if (resetting || !authReady()) return;
    resetError.hidden = true;
    resetSent.hidden = true;
    const email = resetEmail.value.trim();
    if (!email) {
        resetError.textContent = 'Enter your email address.';
        resetError.hidden = false;
        return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        resetError.textContent = 'That email address is not valid.';
        resetError.hidden = false;
        return;
    }

    resetting = true;
    resetButton.disabled = true;
    resetButton.textContent = 'Sending…';
    try {
        await sendPasswordResetEmail(auth, email, { url: `${location.origin}/`, handleCodeInApp: false });
        resetSent.textContent = 'If that email has an account, a reset link is on the way. Check the spam folder too.';
        resetSent.hidden = false;
    } catch (error) {
        resetError.textContent = friendlyError(error);
        resetError.hidden = false;
    } finally {
        resetting = false;
        resetButton.disabled = false;
        resetButton.textContent = 'Send reset link';
    }
}

async function oauthSignIn(provider, label, credentialFromError) {
    if (submitting || !authReady()) return;
    hideError();
    const guest = await currentGuest();
    submitting = true;
    setBusy(true, label);
    try {
        if (auth.currentUser?.isAnonymous) {
            try {
                await linkWithPopup(auth.currentUser, provider);
            } catch (error) {
                const credential = credentialFromError(error);
                if (!credential) throw error;
                await signInWithCredential(auth, credential);
            }
        } else {
            await signInWithPopup(auth, provider);
        }
        await finishSignIn(guest);
    } catch (error) {
        if (error?.code !== 'auth/popup-closed-by-user' && error?.code !== 'auth/cancelled-popup-request') {
            showError(friendlyError(error));
        }
        setBusy(false);
    } finally {
        submitting = false;
    }
}

function handleGoogle() {
    return oauthSignIn(googleProvider, 'Opening Google…', GoogleAuthProvider.credentialFromError);
}

function handleDiscord() {
    return oauthSignIn(discordProvider, 'Opening Discord…', OAuthProvider.credentialFromError);
}

let nullUserTimer = null;

function onUser(user) {
    if (nullUserTimer) {
        clearTimeout(nullUserTimer);
        nullUserTimer = null;
    }
    if (!user) {
        // A token refresh can report a null user for a moment, so wait for the
        // SDK to settle before treating it as a real sign-out.
        nullUserTimer = setTimeout(() => {
            nullUserTimer = null;
            if (auth?.currentUser) {
                onUser(auth.currentUser);
                return;
            }
            showGate({ anonymous: false });
        }, 700);
        return;
    }
    if (user.isAnonymous) {
        showGate({ anonymous: true });
        return;
    }
    hideGate();
}

function resolveApp() {
    const apps = getApps();
    return apps.find(app => app.name === '[DEFAULT]') || apps[0] || initializeApp(firebaseConfig);
}

async function boot() {
    buildGate();
    try {
        auth = getAuth(resolveApp());
        // Long-lived storage instead of an in-memory session, so a deploy or a
        // browser restart keeps the user signed in.
        try {
            await setPersistence(auth, browserLocalPersistence);
        } catch (_) {
            notify('This browser is blocking site storage, so you may need to sign in again after closing it.', true);
        }
        // Wait for the stored session to be restored before deciding whether
        // this visitor is signed in, but never let a stalled restore keep the
        // gate spinning.
        try {
            await Promise.race([
                auth.authStateReady(),
                new Promise(resolve => setTimeout(resolve, 3000))
            ]);
        } catch (_) { /* Older SDKs resolve immediately. */ }
        onAuthStateChanged(auth, onUser);
    } catch (error) {
        setChecking(false);
        statusNode.textContent = '';
        showError(`Could not reach the account service: ${error.message || 'unknown error'}.`);
    }
}

// Page modules also initialize Firebase with the default app name, so mount
// the gate immediately but wait for DOMContentLoaded (all module scripts have
// run by then) before resolving which app to share.
buildGate();
setChecking(true);
if (document.readyState === 'complete') {
    setTimeout(boot, 0);
} else {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0), { once: true });
}

window.vxAuth = {
    get user() { return auth?.currentUser || null; },
    signOut: () => { if (auth) signOut(auth); }
};
