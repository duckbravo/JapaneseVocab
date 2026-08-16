// GET /api/jisho?q=<word> — proxies jisho.org's unofficial search API.
//
// jisho.org sends no Access-Control-Allow-Origin header, so the browser can't
// call it directly; this exists purely to get around that, plus give the
// lookup the same auth + rate limiting as every other /api/* route. The
// response is edge-cached (24h) since dictionary entries don't change.

import { json, err } from './_lib/http.js';
import { checkRateLimit } from './_lib/ratelimit.js';

const MAX_QUERY_LENGTH = 64;
const MAX_RESULTS = 12;

export async function onRequestGet({ request, env, data }) {
  const q = new URL(request.url).searchParams.get('q')?.trim();
  if (!q) return err(400, 'bad_request', 'Enter a word to look up.');
  if (q.length > MAX_QUERY_LENGTH) {
    return err(400, 'bad_request', 'That search is too long.');
  }

  const { allowed, retryAfter } = await checkRateLimit(env, data.user.id, 'jisho');
  if (!allowed) {
    return err(429, 'rate_limited', `Too many lookups — try again in ${retryAfter}s.`);
  }

  let res;
  try {
    res = await fetch(`https://jisho.org/api/v1/search/words?keyword=${encodeURIComponent(q)}`, {
      signal: AbortSignal.timeout(8000),
      cf: { cacheTtl: 86400, cacheEverything: true },
    });
  } catch {
    return err(
      502,
      'lookup_failed',
      'Jisho is not responding right now. You can still add the word manually.',
    );
  }

  if (!res.ok) {
    return err(
      502,
      'lookup_failed',
      'Jisho is not responding right now. You can still add the word manually.',
    );
  }

  let body;
  try {
    body = await res.json();
  } catch {
    return err(502, 'lookup_failed', "Jisho's response could not be read.");
  }

  return json({ results: (Array.isArray(body?.data) ? body.data : []).slice(0, MAX_RESULTS).map(toEntry) });
}

/**
 * Allowlist projection of a jisho.org entry — same discipline as
 * _lib/kv.js#toPublic(): keep only what the UI needs, and never forward
 * fields we haven't looked at (this is third-party content, not curated).
 */
function toEntry(entry) {
  return {
    slug: typeof entry?.slug === 'string' ? entry.slug : null,
    isCommon: entry?.is_common === true,
    jlpt: Array.isArray(entry?.jlpt) ? entry.jlpt.filter((j) => typeof j === 'string') : [],
    forms: Array.isArray(entry?.japanese)
      ? entry.japanese.map((f) => ({
          word: typeof f?.word === 'string' ? f.word : null,
          reading: typeof f?.reading === 'string' ? f.reading : '',
        }))
      : [],
    senses: Array.isArray(entry?.senses)
      ? entry.senses.slice(0, 5).map((s) => ({
          english: Array.isArray(s?.english_definitions)
            ? s.english_definitions.filter((e) => typeof e === 'string')
            : [],
          partsOfSpeech: Array.isArray(s?.parts_of_speech)
            ? s.parts_of_speech.filter((p) => typeof p === 'string')
            : [],
          tags: Array.isArray(s?.tags) ? s.tags.filter((t) => typeof t === 'string') : [],
        }))
      : [],
  };
}
