// Sidebar account section + login/signup modal, shared by every page.
// Dispatches an "auth-state-changed" event on `document` (detail: { session })
// on load and on every login/logout, so classic (non-module) scripts like the
// future saved-words.js can react without importing this module directly.
import { supabase } from './supabase-client.js';

let authMode = 'login';

function setAccountView(session) {
  const guestView = document.getElementById('accountGuestView');
  const userView = document.getElementById('accountUserView');
  const emailLabel = document.getElementById('accountEmailLabel');

  if (session) {
    guestView.style.display = 'none';
    userView.style.display = '';
    emailLabel.textContent = session.user.email;
  } else {
    guestView.style.display = '';
    userView.style.display = 'none';
  }

  document.dispatchEvent(new CustomEvent('auth-state-changed', { detail: { session } }));
}

function openAuthModal(mode) {
  authMode = mode;
  document.getElementById('authModalTitle').textContent = mode === 'login' ? 'Log In' : 'Sign Up';
  document.getElementById('authSubmitBtn').textContent = mode === 'login' ? 'Log In' : 'Sign Up';
  document.getElementById('authToggleText').textContent = mode === 'login' ? "Don't have an account?" : 'Already have an account?';
  document.getElementById('authToggleLink').textContent = mode === 'login' ? 'Sign Up' : 'Log In';
  const errorEl = document.getElementById('authError');
  errorEl.textContent = '';
  errorEl.classList.remove('auth-success');
  document.getElementById('authForm').reset();
  document.getElementById('authModal').style.display = 'flex';
}

function closeAuthModal() {
  document.getElementById('authModal').style.display = 'none';
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  const errorEl = document.getElementById('authError');
  errorEl.textContent = '';
  errorEl.classList.remove('auth-success');

<<<<<<< HEAD
  const { data, error } = authMode === 'login'
=======
  const { error } = authMode === 'login'
>>>>>>> 5f1321b630ece71ecb7e039848cdbdcf49f63bc6
    ? await supabase.auth.signInWithPassword({ email, password })
    : await supabase.auth.signUp({ email, password });

  if (error) {
    errorEl.textContent = error.message;
    return;
  }

<<<<<<< HEAD
  // With email confirmation required, signUp() returns a user but no
  // session yet (session appears only after the confirmation link is
  // clicked). With confirmation disabled (e.g. a dev project), signUp()
  // returns an active session immediately, so there's nothing to "check
  // email" for and the user is already logged in.
  if (authMode === 'signup' && !data.session) {
=======
  if (authMode === 'signup') {
>>>>>>> 5f1321b630ece71ecb7e039848cdbdcf49f63bc6
    errorEl.classList.add('auth-success');
    errorEl.textContent = 'Check your email to confirm your account, then log in.';
    return;
  }

  closeAuthModal();
}

<<<<<<< HEAD
async function handleGoogleLogin() {
  const errorEl = document.getElementById('authError');
  errorEl.textContent = '';
  errorEl.classList.remove('auth-success');

  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.href }
  });

  // On success the browser navigates away to Google's consent screen, so
  // there's nothing further to do here — only errors (e.g. provider not
  // enabled) return without a redirect happening.
  if (error) {
    errorEl.textContent = error.message;
  }
}

=======
>>>>>>> 5f1321b630ece71ecb7e039848cdbdcf49f63bc6
async function handleLogout() {
  await supabase.auth.signOut();
}

async function handleGoogleSignIn() {
  const errorEl = document.getElementById('authError');
  errorEl.textContent = '';
  errorEl.classList.remove('auth-success');

  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.href },
  });

  if (error) {
    errorEl.textContent = error.message;
  }
}

function initAuthUI() {
<<<<<<< HEAD
  // Every element lookup here is optional-chained: this function's tail end
  // (getSession()/onAuthStateChange(), which dispatch "auth-state-changed")
  // must always run even if a particular page is missing one of these
  // elements — other scripts (saved-words.js, custom-vocab.js) depend on
  // that event firing regardless of which auth UI pieces a given page has.
  document.getElementById('loginLink')?.addEventListener('click', (e) => {
    e.preventDefault();
    openAuthModal('login');
  });
  document.getElementById('logoutLink')?.addEventListener('click', (e) => {
    e.preventDefault();
    handleLogout();
  });
  document.getElementById('authModalClose')?.addEventListener('click', closeAuthModal);
  document.getElementById('authModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'authModal') closeAuthModal();
  });
  document.getElementById('authToggleLink')?.addEventListener('click', (e) => {
    e.preventDefault();
    openAuthModal(authMode === 'login' ? 'signup' : 'login');
  });
  document.getElementById('authForm')?.addEventListener('submit', handleAuthSubmit);
  document.getElementById('googleLoginBtn')?.addEventListener('click', handleGoogleLogin);
=======
  document.getElementById('loginLink').addEventListener('click', (e) => {
    e.preventDefault();
    openAuthModal('login');
  });
  document.getElementById('logoutLink').addEventListener('click', (e) => {
    e.preventDefault();
    handleLogout();
  });
  document.getElementById('authModalClose').addEventListener('click', closeAuthModal);
  document.getElementById('authModal').addEventListener('click', (e) => {
    if (e.target.id === 'authModal') closeAuthModal();
  });
  document.getElementById('authToggleLink').addEventListener('click', (e) => {
    e.preventDefault();
    openAuthModal(authMode === 'login' ? 'signup' : 'login');
  });
  document.getElementById('authForm').addEventListener('submit', handleAuthSubmit);
<<<<<<< HEAD
  document.getElementById('googleSignInBtn')?.addEventListener('click', handleGoogleSignIn);
=======
>>>>>>> 5f1321b630ece71ecb7e039848cdbdcf49f63bc6
>>>>>>> main

  supabase.auth.getSession().then(({ data: { session } }) => {
    setAccountView(session);
  });

  supabase.auth.onAuthStateChange((_event, session) => {
    setAccountView(session);
  });
}

document.addEventListener('DOMContentLoaded', initAuthUI);
