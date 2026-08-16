// Worker entry point.
//
// WHY THIS EXISTS: this site is deployed as a **Worker with static assets**,
// not as a Cloudflare Pages project. The `functions/` directory with its
// file-path routing and `onRequest*` exports is a *Pages* convention — a Worker
// has a single entry point and never compiles that directory on its own, so
// without this file every /api/* route would 404 in production.
//
// Rather than rewrite the handlers, this reproduces the small part of the Pages
// contract they rely on:
//   - a path -> module table (what Pages derives from the file tree)
//   - `onRequest<Method>` dispatch, falling back to `onRequest`
//   - a context object carrying { request, env, data, next, waitUntil }
//   - `_middleware.onRequest` wrapping every /api/* request
//
// Anything that is not /api/* goes to the static asset server, which keeps its
// normal behaviour (e.g. /account-settings resolving to account-settings.html).
//
// Keeping the handlers in Pages shape is deliberate: they stay portable, and
// adding an endpoint is still "new file under functions/api/ + one line in
// ROUTES below". The one cost is that ROUTES is hand-maintained where Pages
// inferred it from filenames — forget an entry and you get an immediate 404.

import { onRequest as apiMiddleware } from './functions/api/_middleware.js';
import * as llmProviders from './functions/api/llm-providers.js';
import * as llmKeys from './functions/api/llm-keys/index.js';
import * as llmKeysValidate from './functions/api/llm-keys/validate.js';
import * as llmKeysActive from './functions/api/llm-keys/active.js';
import * as jisho from './functions/api/jisho.js';
import * as generateExamples from './functions/api/generate-examples.js';

// ADD NEW ENDPOINTS HERE.
const ROUTES = {
  '/api/llm-providers': llmProviders,
  '/api/llm-keys': llmKeys,
  '/api/llm-keys/validate': llmKeysValidate,
  '/api/llm-keys/active': llmKeysActive,
  '/api/jisho': jisho,
  '/api/generate-examples': generateExamples,
};

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/** 'GET' -> 'onRequestGet', 'DELETE' -> 'onRequestDelete' */
function handlerName(method) {
  return 'onRequest' + method.charAt(0).toUpperCase() + method.slice(1).toLowerCase();
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    // Pages serves a route at both `/api/x` and `/api/x/`; match that so a
    // stray trailing slash isn't a 404.
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
    const mod = ROUTES[path];

    const context = {
      request,
      env,
      data: {},
      waitUntil: ctx.waitUntil.bind(ctx),
      // What `_middleware.js` calls once it has authenticated the request. In
      // Pages this walks on to the matched function; here it dispatches through
      // the table above.
      next: async () => {
        if (!mod) {
          return json({ ok: false, code: 'not_found', message: 'No such endpoint.' }, 404);
        }
        const handler = mod[handlerName(request.method)] || mod.onRequest;
        if (!handler) {
          return json(
            { ok: false, code: 'method_not_allowed', message: 'Method not allowed.' },
            405,
          );
        }
        return handler(context);
      },
    };

    return apiMiddleware(context);
  },
};
