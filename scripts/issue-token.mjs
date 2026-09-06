/*
  Issues an ingest token for a tenant.

    SUPABASE_SERVICE_ROLE_KEY=... node scripts/issue-token.mjs <tenant-slug> ["label"]

  The raw token is printed once and never stored. Only its SHA-256 hash goes into the
  database, so this output is the only copy: paste it straight into the n8n credential.
  Losing it means issuing a new one, which is the intended trade.

  The service-role key is read from the environment rather than a file in this repo, because
  this repo is public and that key bypasses every row level security policy.
*/

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

function readEnvLocal() {
  try {
    const src = readFileSync('.env.local', 'utf8');
    const get = (k) => (src.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1]?.trim();
    return { url: get('VITE_SUPABASE_URL') };
  } catch {
    return {};
  }
}

const url = process.env.VITE_SUPABASE_URL ?? readEnvLocal().url;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url) {
  console.error('missing VITE_SUPABASE_URL (env or .env.local)');
  process.exit(1);
}
if (!serviceKey) {
  console.error('missing SUPABASE_SERVICE_ROLE_KEY in the environment.');
  console.error('find it in supabase → project settings → api. do not commit it.');
  process.exit(1);
}

const slug = process.argv[2];
const label = process.argv[3] ?? 'n8n';

if (!slug) {
  console.error('usage: SUPABASE_SERVICE_ROLE_KEY=... node scripts/issue-token.mjs <tenant-slug> ["label"]');
  process.exit(1);
}

const db = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { data: tenants, error: tenantError } = await db
  .from('tenants')
  .select('id, name')
  .eq('slug', slug)
  .limit(1);

if (tenantError) {
  console.error(`tenant lookup failed: ${tenantError.message}`);
  process.exit(1);
}
if (!tenants?.length) {
  console.error(`no tenant with slug "${slug}".`);
  process.exit(1);
}

const tenant = tenants[0];
const raw = `arc_${randomBytes(32).toString('base64url')}`;
const tokenHash = createHash('sha256').update(raw).digest('hex');

const { error: insertError } = await db
  .from('ingest_tokens')
  .insert({ tenant_id: tenant.id, token_hash: tokenHash, label });

if (insertError) {
  console.error(`token insert failed: ${insertError.message}`);
  process.exit(1);
}

console.log(`\n  tenant: ${tenant.name} (${slug})`);
console.log(`  label:  ${label}`);
console.log(`\n  token, shown once:\n\n  ${raw}\n`);
console.log('  set it in n8n as an HTTP Header Auth credential:');
console.log('    name:  Authorization');
console.log(`    value: Bearer ${raw}\n`);
