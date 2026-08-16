// Sidebar account section + login/signup modal, shared by every page.
// Dispatches an "auth-state-changed" event on `document` (detail: { session })
// on load and on every login/logout, so classic (non-module) scripts like the
// future saved-words.js can react without importing this module directly.
//
// Both the modal markup AND the sidebar account links are injected here
// (rather than hand-copied into every HTML file) so every page — including
// future ones — gets identical markup just by including this script; there's
// nothing to keep in sync or forget to update. An HTML page only needs an
// empty `<li id="accountSection"></li>` in its sidebar.
import { supabase } from './supabase-client.js';

let authMode = 'login';

// Fills the sidebar's `<li id="accountSection">` with the guest/logged-in
// links. Hand-copying these into every page is what let one page's modal
// drift out of sync before; adding a link here now reaches every page at
// once, including ones that don't exist yet.
function injectAccountLinks() {
  const section = document.getElementById('accountSection');
  if (!section || section.querySelector('#accountGuestView')) return;

  section.innerHTML = `
    <span id="accountGuestView">
      <a href="#" id="loginLink">🔐 Log In / Sign Up</a>
    </span>
    <span id="accountUserView" style="display: none;">
      <span id="accountEmailLabel"></span>
      <a href="my-saved-words.html">⭐ My Saved Words</a>
      <a href="my-vocab.html">📝 My Vocab</a>
      <a href="add-vocab.html">➕ Add Vocab</a>
      <a href="account-settings.html">⚙️ Account Settings</a>
      <a href="#" id="logoutLink">🚪 Log Out</a>
    </span>
  `;
}

function injectAuthModal() {
  if (document.getElementById('authModal')) return;

  document.body.insertAdjacentHTML('beforeend', `
    <div id="authModal" class="auth-modal">
      <div class="auth-modal-content">
        <button id="authModalClose" class="auth-modal-close" aria-label="Close">&times;</button>
        <h2 id="authModalTitle">Log In</h2>
        <form id="authForm">
          <input type="email" id="authEmail" placeholder="Email" autocomplete="email" required />
          <input type="password" id="authPassword" placeholder="Password" autocomplete="current-password" required />
          <div id="authError" class="auth-error"></div>
          <button type="submit" id="authSubmitBtn">Log In</button>
        </form>
        <div class="auth-divider"><span>or</span></div>
        <button type="button" id="googleSignInBtn" class="google-signin-btn">
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
            <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84c-.21 1.13-.84 2.09-1.8 2.73v2.27h2.92c1.71-1.57 2.68-3.88 2.68-6.64z"/>
            <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.27c-.81.54-1.85.86-3.04.86-2.34 0-4.32-1.58-5.03-3.71H.96v2.34C2.44 15.98 5.48 18 9 18z"/>
            <path fill="#FBBC05" d="M3.97 10.7c-.18-.54-.28-1.11-.28-1.7s.1-1.16.28-1.7V4.96H.96A8.996 8.996 0 000 9c0 1.45.35 2.83.96 4.04l3.01-2.34z"/>
            <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.59-2.59C13.46.89 11.43 0 9 0 5.48 0 2.44 2.02.96 4.96l3.01 2.34C4.68 5.16 6.66 3.58 9 3.58z"/>
          </svg>
          Continue with Google
        </button>
        <p>
          <span id="authToggleText">Don't have an account?</span>
          <a href="#" id="authToggleLink">Sign Up</a>
        </p>
      </div>
    </div>
  `);
}

function setAccountView(session) {
  // Optional-chained for the same reason initAuthUI() is: a page missing the
  // `<li id="accountSection">` host element must not throw here, because that
  // would skip the dispatch below and silently break every classic script
  // that depends on "auth-state-changed" (saved-words.js, custom-vocab.js,
  // account-settings.js). The dispatch always runs.
  const guestView = document.getElementById('accountGuestView');
  const userView = document.getElementById('accountUserView');
  const emailLabel = document.getElementById('accountEmailLabel');

  if (session) {
    if (guestView) guestView.style.display = 'none';
    if (userView) userView.style.display = '';
    if (emailLabel) emailLabel.textContent = session.user.email;
  } else {
    if (guestView) guestView.style.display = '';
    if (userView) userView.style.display = 'none';
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

  const { data, error } = authMode === 'login'
    ? await supabase.auth.signInWithPassword({ email, password })
    : await supabase.auth.signUp({ email, password });

  if (error) {
    errorEl.textContent = error.message;
    return;
  }

  // With email confirmation required, signUp() returns a user but no
  // session yet (session appears only after the confirmation link is
  // clicked). With confirmation disabled (e.g. a dev project), signUp()
  // returns an active session immediately, so there's nothing to "check
  // email" for and the user is already logged in.
  if (authMode === 'signup' && !data.session) {
    errorEl.classList.add('auth-success');
    errorEl.textContent = 'Check your email to confirm your account, then log in.';
    return;
  }

  closeAuthModal();
}

async function handleLogout() {
  await supabase.auth.signOut();
}

async function handleGoogleSignIn() {
  const errorEl = document.getElementById('authError');
  errorEl.textContent = '';
  errorEl.classList.remove('auth-success');

  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: window.location.href,
      // Without this, Google silently reuses the browser's existing session
      // cookie and skips straight to the last-used account instead of
      // showing the account chooser.
      queryParams: { prompt: 'select_account' },
    },
  });

  // On success the browser navigates away to Google's consent screen, so
  // there's nothing further to do here — only errors (e.g. provider not
  // enabled) return without a redirect happening.
  if (error) {
    errorEl.textContent = error.message;
  }
}

function initAuthUI() {
  // Inject markup before wiring listeners — #loginLink / #logoutLink only
  // exist after injectAccountLinks() has run.
  injectAccountLinks();
  injectAuthModal();

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
  document.getElementById('googleSignInBtn')?.addEventListener('click', handleGoogleSignIn);

  supabase.auth.getSession().then(({ data: { session } }) => {
    setAccountView(session);
  });

  supabase.auth.onAuthStateChange((_event, session) => {
    setAccountView(session);
  });
}

document.addEventListener('DOMContentLoaded', initAuthUI);
