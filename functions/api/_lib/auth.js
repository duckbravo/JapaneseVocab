// Authenticates an /api/* request from the browser's Supabase session.
//
// The client sends its Supabase access token as `Authorization: Bearer <jwt>`
// and we verify it by asking Supabase directly (GET /auth/v1/user) rather than
// checking the JWT signature locally against the project's JWKS.
//
// Why remote verification:
//   - It sees sign-out / ban / user-deletion IMMEDIATELY. Local signature
//     verification honours a stolen or logged-out token until `exp` (an hour by
//     default). These endpoints gate access to the user's *paid* API keys, so
//     instant revocation is worth more than the ~150ms round trip.
//   - It's ~15 lines with no cryptography of our own, versus JWKS fetch/cache/
//     rotation, `kid` selection and `alg` allowlisting — security-critical code
//     with real footguns.
//   - The settings page hits this a handful of times per session, not in a loop.
//
// If a future high-QPS endpoint (e.g. generation) makes the round trip matter,
// cache the *verification result* per isolate rather than switching schemes.

export class AuthError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * @returns {Promise<{ id: string, email: string }>} the authenticated user
 * @throws {AuthError} 401 if the token is missing/invalid, 503 if Supabase is
 *   unreachable. Never falls open.
 */
export async function requireUser(request, env) {
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  // 4096 is far above any real Supabase JWT; this just stops us forwarding
  // something absurd to Supabase.
  if (!token || token.length > 4096) {
    throw new AuthError(401, 'unauthenticated', 'Please log in again.');
  }

  if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) {
    throw new AuthError(
      503,
      'server_misconfigured',
      'The server is missing its Supabase configuration.',
    );
  }

  let res;
  try {
    res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: env.SUPABASE_PUBLISHABLE_KEY,
      },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new AuthError(
      503,
      'auth_unavailable',
      "Couldn't reach the login service. Try again in a moment.",
    );
  }

  if (res.status === 401 || res.status === 403) {
    throw new AuthError(401, 'unauthenticated', 'Your session expired. Log in again.');
  }
  if (!res.ok) {
    throw new AuthError(503, 'auth_unavailable', 'Login service error. Try again shortly.');
  }

  const user = await res.json().catch(() => null);
  if (!user?.id) {
    throw new AuthError(401, 'unauthenticated', 'Please log in again.');
  }

  return { id: user.id, email: user.email };
}
