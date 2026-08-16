// THE PROVIDER REGISTRY.
//
// Adding an LLM provider means adding one object literal here, plus one
// matching `<h2 id="...">` section in api-key-setup.html. Everything else —
// the settings page rows, the client-side format hints, the live validation
// call, the error messages — derives from this file.
//
// If you ever find yourself writing `if (provider === 'gemini')` outside this
// file, that's a bug: the behaviour belongs in the registry entry.

// Status -> outcome mapping shared by all providers. Individual providers
// override only the entries where their wording or verdict differs.
//
//   valid   -> the key works; encrypt and store it
//   invalid -> the provider rejected it; store NOTHING, tell the user why
//   unknown -> we couldn't tell (rate limit, outage, network); store it anyway
//              rather than blocking the user on someone else's downtime
const DEFAULT_STATUS_MAP = {
  200: { outcome: 'valid', message: null },
  400: {
    outcome: 'invalid',
    message:
      'PROVIDER rejected this key as malformed. Check you copied the whole key with no extra characters.',
  },
  401: {
    outcome: 'invalid',
    message:
      'PROVIDER rejected this key (unauthorized). It may be mistyped, revoked, or from a different account.',
  },
  403: {
    outcome: 'invalid',
    message:
      'PROVIDER recognised the key but denied access. Check the key has not been restricted or disabled.',
  },
  404: {
    outcome: 'unknown',
    message:
      "PROVIDER's API responded unexpectedly. This is probably a bug on our side — please report it.",
  },
  429: {
    outcome: 'unknown',
    message:
      'PROVIDER is rate-limiting us right now. The key is probably fine — try "Re-check" in a minute.',
  },
  500: {
    outcome: 'unknown',
    message: 'PROVIDER is having a service problem. Try again later.',
  },
};

const NETWORK_FAILURE = {
  outcome: 'unknown',
  message: "Couldn't reach PROVIDER (network error or timeout). Try again in a moment.",
};

/**
 * Gemini's responseSchema is the older OpenAPI-subset Schema object, not full
 * JSON Schema — it 400s outright on "additionalProperties" (confirmed against
 * a live call: 'Unknown name "additionalProperties" at
 * generation_config.response_schema[...]: Cannot find field.'). The SCHEMA
 * objects callers pass into generate() are written once and shared with
 * Anthropic/OpenAI's json_schema formats, which DO require it, so strip it
 * here for Gemini specifically rather than weakening the shared schema.
 */
function toGeminiSchema(schema) {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (schema && typeof schema === 'object') {
    const { additionalProperties, ...rest } = schema;
    for (const key of Object.keys(rest)) {
      rest[key] = toGeminiSchema(rest[key]);
    }
    return rest;
  }
  return schema;
}

/**
 * generate() failures collapse to a generic 502 for the browser (see
 * generate-examples.js) — the plaintext invariant means a provider's raw
 * error body can't just be forwarded to the client, since some APIs echo
 * request fragments back in error messages. But that leaves zero visibility
 * server-side into what actually went wrong (bad model id, rejected schema,
 * quota, refusal...) without this. Safe to log in full: the API key only
 * ever goes in a header, never in the body, on any of these three APIs.
 */
async function logGenerateFailure(providerId, label, res, extra) {
  let detail = extra ?? '';
  if (!detail) {
    try {
      detail = (await res.text()).slice(0, 500);
    } catch {
      /* body unreadable/already consumed — nothing more to log */
    }
  }
  console.error(`[generate:${providerId}] ${label} (HTTP ${res.status}): ${detail}`);
}

export const PROVIDERS = {
  // ---------------------------------------------------------------------
  // ONE OBJECT LITERAL = ONE PROVIDER
  // ---------------------------------------------------------------------
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    docsAnchor: 'gemini', // -> api-key-setup.html#gemini
    consoleUrl: 'https://aistudio.google.com/apikey',

    // --- fields exposed to the browser via GET /api/llm-providers ---
    //
    // Google issues TWO key shapes, and as of 2026 AI Studio hands out the
    // newer one on most accounts:
    //   AIza… — legacy "Standard" key. Google says these stop working after
    //           September 2026.
    //   AQ.…  — newer "Authorization" key, bound to a service account.
    prefixes: ['AIza', 'AQ.'],
    excludePrefixes: [],
    minLength: 30,
    maxLength: 300,
    formatHint: 'Google keys start with "AQ." (newer) or "AIza" (legacy).',

    // Cheap, fast, and on the free tier — good enough for a handful of short
    // example sentences. See generate() below for how this is used.
    //
    // gemini-2.5-flash (the original pick here) started erroring out from
    // under us: Gemini 3 shipped and Google has a track record of pulling
    // 2.x-series availability ahead of the officially announced retirement
    // date (see the "deprecated without warning earlier than shutdown date"
    // reports on the Google AI dev forum). gemini-3.5-flash has been GA since
    // 2026-05-19 — new enough to not be EOL'd again immediately, old enough
    // to not carry brand-new-release rollout quirks. Verified Aug 2026
    // against https://ai.google.dev/pricing that its free tier terms match
    // the note below.
    defaultModel: 'gemini-3.5-flash',

    // Verified Aug 2026 against https://ai.google.dev/pricing — the Flash
    // family is listed "Free of charge" on the free tier, and the free tier
    // needs no billing account. The same page marks free-tier "Content used to
    // improve our products: Yes", which users deserve to know BEFORE they hand
    // over their study notes, so it's surfaced in the UI, not buried in docs.
    pricingLabel: 'Free tier',
    pricingNote:
      'Free to use without a credit card. Note that on the free tier Google may use what you send to improve their products.',

    // Cheapest possible liveness check: lists model metadata. No tokens billed.
    // The key goes in a header, not `?key=`, so it can't end up in a URL or an
    // access log.
    async validate({ apiKey, signal }) {
      const url = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1';

      // Legacy AIza keys authenticate with x-goog-api-key.
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'x-goog-api-key': apiKey },
        signal,
      });

      // Newer AQ. authorization keys are service-account-bound and are
      // reported to come back 401 ACCESS_TOKEN_TYPE_UNSUPPORTED on that
      // header. Retry once as a bearer token, which is how service-account
      // credentials are normally presented. Costs one extra subrequest only on
      // the already-failing path.
      if (res.status === 401 && apiKey.startsWith('AQ.')) {
        return fetch(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${apiKey}` },
          signal,
        });
      }

      return res;
    },

    // Status alone isn't enough for Google right now — the verdict depends on
    // which KIND of key it is. See the AQ. callout in api-key-setup.html.
    outcomeFor({ status, apiKey }) {
      if (status === 401 && apiKey.startsWith('AQ.')) {
        return {
          outcome: 'unknown',
          message:
            "Google's API rejected this key's type, which is a known problem with their newer \"AQ.\" keys rather than anything wrong with your key. It has been saved — press Re-check later, or see the setup guide for how to get a legacy \"AIza\" key.",
        };
      }
      return null;
    },

    statusOverrides: {
      400: {
        outcome: 'invalid',
        message:
          'Google rejected this key as invalid (API_KEY_INVALID). Copy it again from AI Studio.',
      },
      403: {
        outcome: 'invalid',
        message:
          'Google denied access with this key. Check it is not restricted to specific APIs or HTTP referrers, and that the Generative Language API is enabled on its project.',
      },
    },

    // Structured JSON output via Gemini's responseSchema. The key goes in the
    // same x-goog-api-key header as validate() — never in the URL, so it can't
    // end up in a proxy log or browser history.
    async generate({ apiKey, model, systemPrompt, userPrompt, schema, signal }) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: toGeminiSchema(schema),
          },
        }),
        signal,
      });

      if (!res.ok) {
        await logGenerateFailure('gemini', 'request rejected', res);
        return { ok: false, status: res.status };
      }

      const body = await res.json();
      const text = body?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (typeof text !== 'string') {
        await logGenerateFailure('gemini', 'no text in response', res, JSON.stringify(body).slice(0, 500));
        return { ok: false, status: res.status };
      }

      try {
        return { ok: true, data: JSON.parse(text) };
      } catch {
        await logGenerateFailure('gemini', 'model output was not valid JSON', res, text.slice(0, 500));
        return { ok: false, status: res.status };
      }
    },
  },

  anthropic: {
    id: 'anthropic',
    label: 'Anthropic Claude',
    docsAnchor: 'anthropic',
    consoleUrl: 'https://platform.claude.com/settings/keys',

    prefixes: ['sk-ant-'],
    excludePrefixes: [],
    minLength: 40,
    maxLength: 300,
    formatHint: 'Anthropic keys start with "sk-ant-".',

    defaultModel: 'claude-opus-5',

    // Anthropic's rate-limit docs list Start/Build/Scale/Custom tiers and no
    // free tier. New Console accounts are widely reported to get a small
    // one-time trial credit (~$5, phone verification, expires) but Anthropic
    // doesn't publish the figure, so don't quote one.
    pricingLabel: 'Paid',
    pricingNote:
      'Pay-as-you-go, no free tier. New accounts usually get a small one-off trial credit to test with.',

    validate({ apiKey, signal }) {
      return fetch('https://api.anthropic.com/v1/models?limit=1', {
        method: 'GET',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        signal,
      });
    },

    statusOverrides: {
      401: {
        outcome: 'invalid',
        message:
          'Anthropic rejected this key. Check it is still active in the Console and belongs to an organisation with API access.',
      },
    },

    // Structured output via output_config.format (json_schema). Two things
    // that will 400 if gotten wrong, both intentional here, not oversights:
    //   - no temperature/top_p/top_k — removed on Claude Opus 5.
    //   - no `thinking` param — Opus 5 thinks by default, and max_tokens caps
    //     thinking + response text together, so a generous max_tokens (not a
    //     disabled-thinking request) is what keeps a short reply from being
    //     truncated behind it.
    async generate({ apiKey, model, systemPrompt, userPrompt, schema, signal }) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          // Generous on purpose: Opus 5 thinks by default and max_tokens caps
          // thinking + response text together, so a tight budget risks
          // truncating the reply behind thinking tokens for no real saving.
          max_tokens: 16000,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
          output_config: { format: { type: 'json_schema', schema } },
        }),
        signal,
      });

      if (!res.ok) {
        await logGenerateFailure('anthropic', 'request rejected', res);
        return { ok: false, status: res.status };
      }

      const body = await res.json();
      // A safety-classifier decline is a normal 200 with an empty/partial
      // content array — never index content[0] before checking this.
      if (body.stop_reason === 'refusal') {
        console.error('[generate:anthropic] model refused the request');
        return { ok: false, status: 200 };
      }

      const text = body?.content?.find((b) => b.type === 'text')?.text;
      if (typeof text !== 'string') {
        await logGenerateFailure('anthropic', 'no text block in response', res, JSON.stringify(body).slice(0, 500));
        return { ok: false, status: res.status };
      }

      try {
        return { ok: true, data: JSON.parse(text) };
      } catch {
        await logGenerateFailure('anthropic', 'model output was not valid JSON', res, text.slice(0, 500));
        return { ok: false, status: res.status };
      }
    },
  },

  openai: {
    id: 'openai',
    label: 'OpenAI',
    docsAnchor: 'openai',
    consoleUrl: 'https://platform.openai.com/api-keys',

    prefixes: ['sk-'],
    // Anthropic keys ALSO start with "sk-", so exclude theirs explicitly —
    // this is what lets the client tell "wrong provider" from "wrong format".
    excludePrefixes: ['sk-ant-'],
    minLength: 40,
    maxLength: 300,
    formatHint: 'OpenAI keys start with "sk-" (often "sk-proj-").',

    defaultModel: 'gpt-4.1-mini',

    // OpenAI's pricing page lists no free tier and no starter credits; the
    // only free surfaces are moderation and file-search storage.
    pricingLabel: 'Paid',
    pricingNote:
      'Pay-as-you-go, no free tier. You need to add credit before the key will work.',

    validate({ apiKey, signal }) {
      return fetch('https://api.openai.com/v1/models', {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
        signal,
      });
    },

    statusOverrides: {
      403: {
        outcome: 'invalid',
        message:
          'OpenAI denied access. If this is a project key, check its permissions include model access.',
      },
      429: {
        outcome: 'unknown',
        message:
          'OpenAI is rate-limiting, or the account has no remaining quota. The key itself looks fine — add credit and re-check.',
      },
    },

    // Structured output via response_format.json_schema (strict mode).
    async generate({ apiKey, model, systemPrompt, userPrompt, schema, signal }) {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'examples', strict: true, schema },
          },
        }),
        signal,
      });

      if (!res.ok) {
        await logGenerateFailure('openai', 'request rejected', res);
        return { ok: false, status: res.status };
      }

      const body = await res.json();
      const text = body?.choices?.[0]?.message?.content;
      if (typeof text !== 'string') {
        await logGenerateFailure('openai', 'no content in response', res, JSON.stringify(body).slice(0, 500));
        return { ok: false, status: res.status };
      }

      try {
        return { ok: true, data: JSON.parse(text) };
      } catch {
        await logGenerateFailure('openai', 'model output was not valid JSON', res, text.slice(0, 500));
        return { ok: false, status: res.status };
      }
    },
  },
};

// Only these fields are ever sent to the browser; `validate`/`outcomeFor` stay
// server-side.
const PUBLIC_PROVIDER_FIELDS = [
  'id',
  'label',
  'docsAnchor',
  'consoleUrl',
  'prefixes',
  'excludePrefixes',
  'minLength',
  'maxLength',
  'formatHint',
  'pricingLabel',
  'pricingNote',
];

export function publicProviderList() {
  return Object.values(PROVIDERS).map((p) =>
    Object.fromEntries(PUBLIC_PROVIDER_FIELDS.map((f) => [f, p[f]])),
  );
}

/**
 * "a Google Gemini" / "an Anthropic Claude" / "an OpenAI" — so messages built
 * from a registry label read correctly whatever provider is added next.
 */
export function withArticle(label) {
  return `${/^[aeiou]/i.test(label) ? 'an' : 'a'} ${label}`;
}

/** @returns the registry entry, or undefined for an unknown id. */
export function getProvider(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(PROVIDERS, id)
    ? PROVIDERS[id]
    : undefined;
}

// Longest-first so "sk-ant-" wins over "sk-" when extracting from pasted text.
const ALL_PREFIXES = ['sk-ant-', 'sk-', 'AIza', 'AQ.'];

/** Escape regex metacharacters — "AQ." contains a literal dot. */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');

/** Does this key look like it belongs to this provider, by prefix alone? */
export function matchesPrefixes(provider, key) {
  return (
    provider.prefixes.some((pre) => key.startsWith(pre)) &&
    !provider.excludePrefixes.some((pre) => key.startsWith(pre))
  );
}

/**
 * Structural sanity check. Deliberately NOT a "does this look like a real key"
 * check.
 *
 * There used to be a per-provider `strictPattern` here that required an exact
 * prefix. It broke the moment Google started issuing "AQ." keys instead of
 * "AIza" ones — users with a perfectly good key were refused before we ever
 * asked Google about it. The live call in validate() is the real gate; this
 * only catches obvious garbage.
 *
 * The one thing it DOES enforce strictly is the cross-vendor guard: we must
 * never forward one provider's key to another provider's servers.
 *
 * @returns {string|null} an error message, or null if the key is worth trying
 */
export function checkKeyShape(provider, key) {
  if (!key) return 'No API key was provided.';
  if (key.length < 20) return 'That key looks too short to be complete. Copy the whole thing.';
  if (key.length > 512) return 'That key is too long to be an API key.';
  if (!/^[A-Za-z0-9._-]+$/.test(key)) {
    return 'That contains characters no provider uses in an API key — check you copied only the key itself.';
  }

  const other = Object.values(PROVIDERS).find(
    (p) => p.id !== provider.id && matchesPrefixes(p, key),
  );
  if (other) {
    return `That looks like ${withArticle(other.label)} key, not ${withArticle(provider.label)} one. Save it under ${other.label} instead.`;
  }

  return null;
}

/**
 * Cleans up a pasted key: stray whitespace, smart-copy artefacts, wrapping
 * quotes, a `Bearer `/`x-api-key:` prefix, or a whole curl command.
 *
 * KEEP IN SYNC with the copy in js/account-settings.js. That copy exists only
 * so the user sees the cleaned value before saving; THIS one is authoritative
 * and re-runs on everything the client sends.
 */
export function sanitizeApiKey(raw) {
  if (typeof raw !== 'string') return '';

  let s = raw
    .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '') // zero-width + nbsp from web copy-paste
    .replace(/[\r\n\t]+/g, ' ')
    .trim();

  s = s.replace(/^(?:Bearer|bearer)\s+/, '');
  s = s.replace(/^(?:x-api-key|x-goog-api-key|authorization|api[_-]?key|key)\s*[:=]\s*/i, '');
  // Note the trailing-punctuation strip includes "." — a key pasted at the end
  // of a sentence picks one up. Google's AQ. keys contain dots INTERNALLY, so
  // only trailing ones are removed.
  s = s.replace(/^['"`]+/, '').replace(/['"`,;.\\]+$/, '').trim();

  // A whole curl command, or "Your key: sk-... (keep it secret)".
  if (/\s/.test(s)) {
    // The charset must allow "." for Google's AQ.… keys.
    const re = new RegExp(`(?:${ALL_PREFIXES.map(esc).join('|')})[A-Za-z0-9._-]{16,}`, 'g');
    const matches = s.match(re);
    if (matches?.length) {
      s = matches.reduce((a, b) => (b.length > a.length ? b : a)).replace(/[.,;]+$/, '');
    }
  }

  return s.replace(/^['"`]+|['"`]+$/g, '').trim();
}

/**
 * Runs the provider's live liveness check.
 *
 * Never throws on a provider error — a provider being down is a normal
 * outcome, not an exception.
 *
 * @returns {Promise<{ outcome: 'valid'|'invalid'|'unknown', message: string|null, detail: string|null }>}
 */
export async function runValidation(provider, apiKey) {
  let res;
  try {
    res = await provider.validate({ apiKey, signal: AbortSignal.timeout(8000) });
  } catch {
    return fill(NETWORK_FAILURE, provider, null);
  }

  const bucket = res.status >= 500 ? 500 : res.status;

  // Extract only a short machine-readable code. NEVER echo the provider's
  // response body back to the browser — some APIs quote fragments of the
  // request, which could include the key itself.
  let detail = null;
  if (res.status !== 200) {
    try {
      const body = await res.json();
      const raw = body?.error?.status ?? body?.error?.type ?? body?.error?.code ?? null;
      if (typeof raw === 'string') {
        detail = raw.replace(/[^A-Za-z0-9_. -]/g, '').slice(0, 80);
      }
    } catch {
      /* body wasn't JSON — no detail, that's fine */
    }
  }

  // outcomeFor() gets first say, because some verdicts depend on the KIND of
  // key rather than just the status code (see the Gemini AQ. case).
  const rule =
    provider.outcomeFor?.({ status: res.status, apiKey, detail }) ??
    provider.statusOverrides?.[bucket] ??
    DEFAULT_STATUS_MAP[bucket] ?? {
      outcome: 'unknown',
      message: 'PROVIDER responded with an unexpected status. Try again.',
    };

  return fill(rule, provider, detail);
}

function fill(rule, provider, detail) {
  return {
    outcome: rule.outcome,
    message: rule.message ? rule.message.replaceAll('PROVIDER', provider.label) : null,
    detail,
  };
}
