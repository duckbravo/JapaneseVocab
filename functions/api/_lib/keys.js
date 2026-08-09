// THE SEAM for the (not yet built) generation pipeline.
//
// When the "generate vocab details with AI" endpoint lands, it will live at
// functions/api/generate.js and get the user's key through here — so the
// storage format, the decryption, and the provider lookup stay in one place
// and the generation code never touches KV or crypto directly.
//
// This file is one of exactly TWO call sites of decryptSecret(); the other is
// llm-keys/validate.js. Both return only a verdict or generated content — no
// endpoint anywhere returns a plaintext key to the browser.

import { decryptSecret } from './crypto.js';
import { readBlob } from './kv.js';
import { getProvider } from './providers.js';

export class NoKeyError extends Error {
  constructor(message) {
    super(message);
    this.code = 'no_key';
  }
}

/**
 * Resolves a stored key to something callable.
 *
 * @param {string} [providerId] specific provider; defaults to the user's active one
 * @returns {Promise<{ provider: object, apiKey: string, record: object }>}
 * @throws {NoKeyError} when nothing usable is stored
 */
export async function getProviderKey(env, userId, providerId) {
  const blob = await readBlob(env, userId);
  const id = providerId || blob.activeProvider;

  if (!id) {
    throw new NoKeyError('No AI provider is set up yet. Add an API key in Account Settings.');
  }

  const provider = getProvider(id);
  const record = blob.providers[id];
  if (!provider || !record?.cipher) {
    throw new NoKeyError(`No API key is stored for ${provider?.label || id}.`);
  }

  const apiKey = await decryptSecret(env, userId, id, record.cipher);
  return { provider, apiKey, record };
}

/** Convenience wrapper for the common "just use whatever they picked" case. */
export function getActiveProviderKey(env, userId) {
  return getProviderKey(env, userId);
}
