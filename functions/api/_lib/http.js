// Small JSON/response helpers shared by every /api/* function.
//
// This file exports no `onRequest*` function, so Cloudflare's file-path router
// emits no route for it — it is a plain helper module, not an endpoint.

/** JSON response with no-store (these are all per-user responses). */
export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

/** Error response in the shape the client's api() helper expects. */
export function err(status, code, message) {
  return json({ ok: false, code, message }, status);
}

// Nothing we accept is remotely near this size — an API key is a few hundred
// bytes. Rejecting on Content-Length before reading the body avoids buffering
// junk and keeps pathological input out of the sanitizer's regexes.
const MAX_BODY_BYTES = 8192;

export class BadRequest extends Error {
  constructor(message) {
    super(message);
    this.code = 'bad_request';
  }
}

/**
 * Reads and parses a JSON request body, enforcing the size cap.
 * @throws {BadRequest} on oversized or unparseable bodies.
 */
export async function readJsonBody(request) {
  const declared = Number(request.headers.get('Content-Length') || '0');
  if (declared > MAX_BODY_BYTES) {
    throw new BadRequest('Request body is too large.');
  }

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    throw new BadRequest('Request body is too large.');
  }
  if (!text) return {};

  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new BadRequest('Request body must be a JSON object.');
    }
    return parsed;
  } catch (e) {
    if (e instanceof BadRequest) throw e;
    throw new BadRequest('Request body is not valid JSON.');
  }
}
