// Minimal PostgREST client for the Worker.
//
// WHY THIS EXISTS: everything else in this repo writes to Supabase from the
// BROWSER, through the supabase-js client under the user's own session. The
// background example generator can't — by the time it finishes, the tab that
// asked for it may be closed, on another page, or on another device. So the
// Worker has to do the write itself.
//
// THE KEY DESIGN POINT: it writes as the USER, by forwarding the same access
// token the browser sent in the Authorization header — not with a service_role
// key. That matters for three reasons:
//   1. RLS still applies. A bug here cannot touch another user's rows, because
//      Postgres refuses, not because this code remembered to add a filter.
//   2. There is no service_role key anywhere in this project, and CLAUDE.md
//      says there never should be. Introducing one to write four columns would
//      be a large, permanent increase in blast radius for a small feature.
//   3. Revocation works. If the user signs out or is deleted mid-generation,
//      the write fails — which is the correct outcome.
//
// The token is valid for roughly an hour and generation is capped at 45s, so
// it cannot expire underneath an in-flight job.

/** Pulls the caller's raw bearer token back off the request. */
export function bearerToken(request) {
  const header = request.headers.get('Authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

/**
 * PATCH a single row by primary key, as the user who owns `token`.
 *
 * @returns {Promise<{ ok: boolean, status: number, message?: string }>}
 *   Never throws — callers run inside waitUntil(), where an unhandled
 *   rejection is invisible. A failure here has to be a value that gets logged.
 */
export async function patchRow(env, token, table, id, patch) {
  if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) {
    return { ok: false, status: 503, message: 'Supabase configuration missing.' };
  }

  const url = `${env.SUPABASE_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(String(id))}`;

  let res;
  try {
    res = await fetch(url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: env.SUPABASE_PUBLISHABLE_KEY,
        'Content-Type': 'application/json',
        // No row echoed back — nothing here reads the result, and asking for
        // one would only widen what a log could accidentally capture.
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(patch),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    return { ok: false, status: 503, message: 'Could not reach the database.' };
  }

  if (!res.ok) {
    // PostgREST returns a JSON body with `message`; keep only that, never the
    // request body (it may carry generated content) and never the token.
    const detail = await res.json().catch(() => null);
    return { ok: false, status: res.status, message: detail?.message || `HTTP ${res.status}` };
  }

  return { ok: true, status: res.status };
}
