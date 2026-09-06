import { createClient } from '@supabase/supabase-js';

/* browser client, anon key only. row level security is what scopes every read to the
   caller's tenant — postgres refuses rows that do not belong to them, so a mistake in a
   query here cannot leak another client's data. the service-role key never appears in this
   repo; it lives only in the ingest edge function's secrets. */

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isConfigured = Boolean(url && anonKey);

let client = null;

export function getSupabase() {
  if (!isConfigured) return null;
  if (!client) {
    client = createClient(url, anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
  }
  return client;
}
