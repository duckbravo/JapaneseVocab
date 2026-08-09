// Per-user rate limiting for the endpoints that make a live call to a third
// party (saving and re-checking a key).
//
// WHAT THIS IS: abuse *dampening*. Without it, POST /api/llm-keys is a free
// credential-testing oracle against Google/Anthropic/OpenAI, run from
// Cloudflare's IPs — which could get our egress throttled. Signup is open, so
// "authenticated only" isn't much of a barrier on its own.
//
// WHAT THIS IS NOT: a security control. KV is eventually consistent and allows
// only ~1 write/sec to the same key, so a burst will lose increments. Counter
// failures are treated as "allow" — never block a legitimate user because the
// limiter itself broke.
//
// If this ever needs to be real: use Cloudflare's native Rate Limiting binding
// (per-Worker and strongly consistent, ~5 lines), or a WAF rate-limiting rule
// on /api/* — note the WAF option requires a custom domain in a Cloudflare
// zone, not a *.pages.dev subdomain.

const WINDOWS = [
  { name: 'minute', seconds: 60, limit: 10 },
  { name: 'hour', seconds: 3600, limit: 60 },
];

/**
 * @returns {Promise<{ allowed: boolean, retryAfter: number }>}
 */
export async function checkRateLimit(env, userId, action = 'validate') {
  const now = Date.now();

  for (const w of WINDOWS) {
    const bucket = Math.floor(now / (w.seconds * 1000));
    const key = `ratelimit:${action}:${userId}:${w.name}:${bucket}`;

    let count = 0;
    try {
      count = Number((await env.LLM_KEYS.get(key)) || '0');
    } catch {
      continue; // limiter unavailable -> allow
    }

    if (count >= w.limit) {
      const elapsed = now - bucket * w.seconds * 1000;
      return { allowed: false, retryAfter: Math.ceil((w.seconds * 1000 - elapsed) / 1000) };
    }

    try {
      // expirationTtl has a 60s minimum in KV, which matches our shortest window.
      await env.LLM_KEYS.put(key, String(count + 1), { expirationTtl: w.seconds + 60 });
    } catch {
      /* dropped increment — accept the slop, see the note above */
    }
  }

  return { allowed: true, retryAfter: 0 };
}
