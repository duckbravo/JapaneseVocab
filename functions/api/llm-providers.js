// GET /api/llm-providers
//
// The registry, projected down to the fields the browser needs to render rows
// and run its advisory format check. Server-only fields (strictPattern,
// validate) never appear here.

import { json } from './_lib/http.js';
import { publicProviderList } from './_lib/providers.js';

export function onRequestGet() {
  return json({ providers: publicProviderList() });
}
