// Which model to actually call, and keeping that decision from going stale.
//
// THE PROBLEM THIS SOLVES. Two things drift underneath a hardcoded model id:
//
//   1. Availability. Google replaces its flash-tier models every 1-3 months
//      and has pulled older ones ahead of their announced retirement dates.
//      A pinned id eventually 404s, and the symptom reaches the user as a
//      generic "couldn't generate" rather than "that model is gone".
//   2. Quota. Free-tier allowances change without notice and are no longer
//      published per-model at all — Google's rate-limit docs now just point at
//      the AI Studio dashboard. Free-tier Flash went from ~250 requests/day to
//      ~20 while Flash-Lite stayed around 500, which is the whole reason
//      providers.js defaults to Lite.
//
// So the registry's `models` array is a PREFERENCE ORDER, not a source of
// truth. This module intersects it with what the provider says is actually
// available, and walks down it when a model reports quota exhaustion.
//
// THE "REGULAR CHECK". Discovery needs a key, and keys are per-user and
// encrypted — a Cron Trigger has no credentials to check with, so a scheduled
// job can't do this. Instead the catalogue is cached in KV under a non-user
// key and refreshed opportunistically: the first generation after the cache
// goes stale pays for one extra listing call and updates it for everybody.
// Traffic-driven rather than clock-driven, but it is a regular check, it uses
// credentials that actually exist, and it costs nothing when nobody is using
// the site.
//
// Nothing cached here is secret: it is the provider's public model catalogue.
// The user's key is used to fetch it and is never stored alongside it.

const CACHE_PREFIX = 'models:';

// A day. Model catalogues turn over on a scale of months, so this is already
// far more often than it needs to be; the point is to be fresh enough that a
// mid-week deprecation doesn't strand anyone for long.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Discovery must never be the reason a generation fails, so it gets a much
// tighter budget than the generation itself (45s).
const LIST_TIMEOUT_MS = 8000;

/**
 * The provider's model ids in preference order, user's pick first.
 *
 * @param {object} provider registry entry
 * @param {string|null} preferred the user's chosen model, if any
 * @returns {string[]} deduped, never empty
 */
export function preferenceChain(provider, preferred) {
  const registry = Array.isArray(provider.models) ? provider.models.map((m) => m.id) : [];
  // defaultModel last as a backstop: for a provider with no `models` array it
  // is the only candidate, and for one that has it, it is already in there.
  const chain = [preferred, ...registry, provider.defaultModel];
  return [...new Set(chain.filter((id) => typeof id === 'string' && id))];
}

/**
 * Reads the cached catalogue, refreshing it if stale.
 *
 * Returns null — meaning "no opinion" — whenever discovery can't be done or
 * fails. A null must leave the caller using its preference chain unfiltered:
 * an empty array would be indistinguishable from "the provider offers
 * nothing", and would take the feature down on a transient listing failure.
 *
 * @returns {Promise<string[]|null>}
 */
export async function knownModels(env, provider, apiKey, waitUntil) {
  if (typeof provider.listModels !== 'function' || !env.LLM_KEYS) return null;

  const cacheKey = CACHE_PREFIX + provider.id;
  const cached = await env.LLM_KEYS.get(cacheKey, { type: 'json' }).catch(() => null);

  const fresh =
    cached &&
    Array.isArray(cached.models) &&
    typeof cached.checkedAt === 'string' &&
    Date.now() - Date.parse(cached.checkedAt) < CACHE_TTL_MS;

  if (fresh) return cached.models;

  // Stale or missing. If we have something usable, refresh in the BACKGROUND
  // and answer from the stale copy — a day-old catalogue is fine, and making
  // the user wait on a listing call to find out is not.
  if (cached && Array.isArray(cached.models) && cached.models.length) {
    if (waitUntil) waitUntil(refresh(env, provider, apiKey, cacheKey));
    return cached.models;
  }

  return refresh(env, provider, apiKey, cacheKey);
}

async function refresh(env, provider, apiKey, cacheKey) {
  let models;
  try {
    models = await provider.listModels({
      apiKey,
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    });
  } catch (e) {
    console.error(`[models:${provider.id}] listing threw`, e?.stack || String(e));
    return null;
  }

  if (!Array.isArray(models) || models.length === 0) return null;

  try {
    await env.LLM_KEYS.put(
      cacheKey,
      JSON.stringify({ models, checkedAt: new Date().toISOString() }),
    );
  } catch (e) {
    // Caching is an optimisation; a failed write just means the next request
    // lists again.
    console.error(`[models:${provider.id}] cache write failed`, e?.stack || String(e));
  }

  return models;
}

/**
 * The chain to actually try, in order.
 *
 * Availability filtering is applied only when it leaves something behind. A
 * catalogue that excludes every preferred model usually means the naming
 * convention moved (Google has renamed the prefix before), and in that case
 * attempting the preferred ids and getting a real error is more useful than
 * refusing to call anything at all.
 */
export function resolveChain(provider, preferred, available) {
  const chain = preferenceChain(provider, preferred);
  if (!Array.isArray(available) || available.length === 0) return chain;

  const set = new Set(available);
  const filtered = chain.filter((id) => set.has(id));

  if (filtered.length === 0) {
    console.error(
      `[models:${provider.id}] none of [${chain.join(', ')}] are in the provider's catalogue ` +
        `(${available.length} models listed) — trying them anyway`,
    );
    return chain;
  }

  // Anything available but not in the registry's list stays out: the chain is
  // a curated cost/quota ordering, not "everything the provider sells".
  return filtered;
}

/**
 * Is this failure worth trying the next model for?
 *
 * 429 is quota/rate limiting — the case this whole module exists for. 404 is
 * "that model id doesn't exist here", which is what a deprecation looks like
 * from the client side. Anything else (401 bad key, 400 bad request, 500
 * provider outage) will fail identically on every model, so retrying down the
 * chain would just multiply the damage.
 */
export function shouldTryNextModel(status) {
  return status === 429 || status === 404;
}
