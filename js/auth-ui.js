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

  const { error } = authMode === 'login'
    ? await supabase.auth.signInWithPassword({ email, password })
    : await supabase.auth.signUp({ email, password });

  if (error) {
    errorEl.textContent = error.message;
    return;
  }

  if (authMode === 'signup') {
    errorEl.classList.add('auth-success');
    errorEl.textContent = 'Check your email to confirm your account, then log in.';
    return;
  }

  closeAuthModal();
}

async function handleLogout() {
  await supabase.auth.signOut();
}

function initAuthUI() {
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

  supabase.auth.getSession().then(({ data: { session } }) => {
    setAccountView(session);
  });

  supabase.auth.onAuthStateChange((_event, session) => {
    setAccountView(session);
  });
}

document.addEventListener('DOMContentLoaded', initAuthUI);
