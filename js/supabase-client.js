// Shared Supabase client singleton, used as an ES module by auth-ui.js and
// (later) saved-words.js / custom-vocab.js.
//
// SUPABASE_ANON_KEY is the public "anon"/"publishable" key — safe to commit
// and expose client-side, since Row Level Security (not key secrecy) is what
// protects user data. Never put the service_role key or any future LLM API
// key here or anywhere else in client code.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://osckijyshkdlribqmtrk.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_VLKWRvkZtZG9HERQJ4odmQ_rL0piKn-';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Classic (non-module) scripts like saved-words.js and custom-vocab.js can't
// `import` this module, so bridge the client onto `window` for them.
window.supabaseClient = supabase;
