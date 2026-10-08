#!/usr/bin/env node
// Local, read-only ARC → Obsidian bridge. No service-role key and no public listener.
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { createClient } from '@supabase/supabase-js';
import { adaptEvent, memoryNote, MEMORY_FOLDER, safeFilePart } from '../src/portal/ecosystem/model.js';

export async function memoryDirectories(vaultPath, tenantId) {
  const vault = await realpath(vaultPath);
  const tenant = path.join(vault, MEMORY_FOLDER, safeFilePart(tenantId));
  await mkdir(tenant, { recursive: true });
  const resolved = await realpath(tenant);
  if (!resolved.startsWith(vault + path.sep))
    throw new Error('Memory directory must stay inside the chosen vault.');
  const events = path.join(resolved, 'Events');
  await mkdir(events, { recursive: true });
  const resolvedEvents = await realpath(events);
  if (!resolvedEvents.startsWith(resolved + path.sep))
    throw new Error('Event directory must stay inside the client memory directory.');
  return { tenant: resolved, events: resolvedEvents };
}

export async function writeEventNote(folder, event) {
  const target = path.join(folder, `${safeFilePart(event.id)}.md`);
  try {
    await writeFile(target, memoryNote(event), { flag: 'wx' });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

async function passwordPrompt() {
  if (!process.stdin.isTTY) throw new Error('Run in an interactive terminal to sign in.');
  process.stdout.write('OPS password (hidden): ');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let password = '';
    const finish = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off('data', read);
      process.stdout.write('\n');
    };
    const read = (buffer) => {
      for (const c of buffer.toString('utf8')) {
        if (c === '\u0003') {
          finish();
          reject(new Error('Cancelled.'));
          return;
        }
        if (c === '\r' || c === '\n') {
          finish();
          resolve(password);
          return;
        }
        if (c === '\u007f' || c === '\b') password = password.slice(0, -1);
        else if (c >= ' ') password += c;
      }
    };
    process.stdin.on('data', read);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (key) => (args.includes(key) ? args[args.indexOf(key) + 1] : null);
  if (args.includes('--help') || !arg('--vault') || !arg('--tenant')) {
    console.log(
      'Usage: npm run memory:sync -- --vault "C:\\path\\to\\Obsidian vault" --tenant CLIENT_UUID [--once]\n\nReads the project URL and public anon key from .env.local. Prompts for your OPS login.\nBackfills all recorded events, then syncs every 10 seconds. Leave running for continuous logging.\nCreates Damon Read Memory/<tenant-id>/Events. Existing event files and Context.md are preserved.',
    );
    return;
  }
  const tenantId = arg('--tenant');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId))
    throw new Error('Use the client UUID shown in Mission Control’s memory panel.');
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  try {
    process.loadEnvFile(path.join(projectRoot, '.env.local'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const url = process.env.VITE_SUPABASE_URL,
    anon = process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anon)
    throw new Error(
      'Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.local. Never use a service-role key.',
    );
  if (!/^https:\/\/[a-z0-9.-]+\.supabase\.co\/?$/i.test(url))
    throw new Error('Expected your HTTPS Supabase project URL.');
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const email = await prompt.question('OPS email: ');
  prompt.close();
  let password = await passwordPrompt();
  const db = createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false },
  });
  const login = await db.auth.signInWithPassword({ email: email.trim(), password });
  password = '';
  if (login.error) throw new Error('OPS sign-in failed. Check your email and password.');
  const admin = await db.rpc('is_arc_admin');
  if (admin.error || admin.data !== true) {
    await db.auth.signOut({ scope: 'local' });
    throw new Error('An ARC operator account is required.');
  }
  const client = await db.from('tenants').select('id').eq('id', tenantId).single();
  if (client.error || !client.data) throw new Error('That client is not available to this operator.');
  const folders = await memoryDirectories(arg('--vault'), tenantId);
  for (const [name, body] of [
    [
      'Context.md',
      '# Approved business context\n\nAdd reviewed operator notes here. ARC does not yet retrieve this file into the production classifier. Operational rules belong in the versioned client settings.\n',
    ],
    [
      'Index.md',
      `# Damon Reid memory\n\nTenant: ${tenantId}\n\n[[Context]]\n\nEvents are recorded ARC evidence, not private model reasoning. The bridge mirrors all event types, including labeled synthetic checks, while it runs. Raw customer messages and secrets are not copied.\n`,
    ],
  ]) {
    try {
      await writeFile(path.join(folders.tenant, name), body, { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  let stop = false,
    since = null,
    lastFullScan = Date.now(),
    total = 0;
  process.on('SIGINT', () => {
    stop = true;
  });
  console.log(`Syncing client ${tenantId} into ${MEMORY_FOLDER}. Press Ctrl+C to stop.`);
  try {
    do {
      try {
        // Hourly full reconciliation also catches unusually late transaction commits.
        if (Date.now() - lastFullScan > 3600000) {
          since = null;
          lastFullScan = Date.now();
        }
        const cycleStart = new Date(Date.now() - 60000).toISOString();
        let cursor = null,
          count = 0;
        do {
          let query = db
            .from('events')
            .select(
              'id,tenant_id,event_type,occurred_at,created_at,correlation_id,status,is_canary,payload,workflow_id',
            )
            .eq('tenant_id', tenantId)
            .order('created_at')
            .order('id')
            .limit(500);
          if (since) query = query.gte('created_at', since);
          if (cursor)
            query = query.or(
              `created_at.gt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.gt.${cursor.id})`,
            );
          const { data, error } = await query;
          if (error) throw new Error('Event read failed. Check network access and your operator session.');
          for (const raw of data ?? []) {
            const event = adaptEvent(raw, tenantId);
            if (event && (await writeEventNote(folders.events, event))) count++;
          }
          cursor = data?.length === 500 ? data[data.length - 1] : null;
        } while (cursor && !stop);
        total += count;
        if (!stop) since = cycleStart;
        await writeFile(
          path.join(folders.tenant, 'Sync status.md'),
          `# Memory sync status\n\nLast successful read: ${new Date().toISOString()}\n\nNew notes this session: ${total}\n\nSource: tenant-scoped ARC event ledger. Reconnect after a restart; this file is a timestamp, not proof the bridge is still running.\n`,
        );
        console.log(`${new Date().toISOString()} · ${count} new notes · ${total} this session`);
      } catch (error) {
        console.error(error.message);
        if (args.includes('--once')) throw error;
      }
      if (args.includes('--once')) break;
      for (let i = 0; i < 10 && !stop; i++) await new Promise((resolve) => setTimeout(resolve, 1000));
    } while (!stop);
  } finally {
    await db.auth.signOut({ scope: 'local' });
    db.auth.stopAutoRefresh();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
