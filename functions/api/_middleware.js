// Runs before every /api/* function. `_middleware` is the one filename
// Cloudflare's file-path router special-cases; it emits no route of its own.
//
// Responsibilities:
//   1. Authenticate the request and hand the user down via context.data.user,
//      so no individual endpoint can forget to check.
//   2. Make sure per-user responses are never cached.
//   3. Turn thrown AuthErrors into clean JSON instead of a 500.
//
// CORS: the site and these Functions share one origin, so no CORS headers are
// emitted — none are needed, and adding a permissive one to a credentialed API
// would be a real hole. The OPTIONS 204 below carries no
// Access-Control-Allow-Origin deliberately: a cross-origin caller fails loudly
// rather than silently succeeding. (This is also why local development must use
// `npx wrangler pages dev .` rather than Live Server on a different port.)

import { requireUser, AuthError } from './_lib/auth.js';
import { json } from './_lib/http.js';

export async function onRequest(context) {
  const { request } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }

  try {
    context.data.user = await requireUser(request, context.env);

    const res = await context.next();
    // Copy rather than mutate: for an /api/* path with no matching function,
    // next() falls through to the static asset handler, whose Response has
    // immutable (guarded) headers.
    const out = new Response(res.body, res);
    out.headers.set('Cache-Control', 'no-store');
    out.headers.set('X-Content-Type-Options', 'nosniff');
    return out;
  } catch (e) {
    if (e instanceof AuthError) {
      return json({ ok: false, code: e.code, message: e.message }, e.status);
    }
    // Log the stack only. NEVER log request bodies — they carry API keys, and
    // Cloudflare logs are readable by anyone with dashboard access.
    console.error('api error:', e?.stack || String(e));
    return json(
      { ok: false, code: 'server_error', message: 'Something went wrong on our side.' },
      500,
    );
  }
}
