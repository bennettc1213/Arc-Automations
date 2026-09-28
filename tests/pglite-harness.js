/* real Postgres for the test suite, without Docker.
 *
 * PGlite is Postgres compiled to WebAssembly, in-process. With four Supabase stubs —
 * the three API roles, an `auth` schema whose `uid()` reads the JWT subject, the
 * realtime publication, and Supabase's default grants — it applies every migration in
 * `supabase/migrations/` for real: constraints, triggers, functions, RLS.
 *
 * Optional, like `npm run smoke`'s browser. It is not a dependency, and installing it
 * into this checkout with `npm i --no-save` would prune the other no-save tools other
 * sessions rely on, so it is found either as an installed package or through
 * ARC_PGLITE_DIR (a directory whose node_modules holds @electric-sql/pglite):
 *
 *   npm i --prefix <somewhere> @electric-sql/pglite
 *   ARC_PGLITE_DIR=<somewhere> npm test
 *
 * Without it the database suites skip and say how to run them. They never pass by
 * default: a skipped test is reported as skipped.
 *
 * `restClient()` is a PostgREST-shaped client over the same database — the subset of the
 * supabase-js builder the adapters call — so `supabaseStore()` runs against real SQL
 * exactly as it does in production, as the service role, one transaction per request.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MIGRATIONS = new URL('../supabase/migrations/', import.meta.url);

let loaded;

/** `{ PGlite, pgcrypto }`, or null when PGlite is not available. */
export async function loadPglite() {
  if (loaded !== undefined) return loaded;
  loaded = null;
  try {
    const { PGlite } = await import('@electric-sql/pglite');
    const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto');
    loaded = { PGlite, pgcrypto };
    return loaded;
  } catch { /* not installed here — try the side directory */ }
  const dir = process.env.ARC_PGLITE_DIR;
  if (dir) {
    const root = join(dir, 'node_modules', '@electric-sql', 'pglite', 'dist');
    if (existsSync(join(root, 'index.js'))) {
      const { PGlite } = await import(pathToFileURL(join(root, 'index.js')).href);
      const { pgcrypto } = await import(pathToFileURL(join(root, 'contrib', 'pgcrypto.js')).href);
      loaded = { PGlite, pgcrypto };
    }
  }
  return loaded;
}

export const SKIP_REASON =
  'PGlite is not installed — run with ARC_PGLITE_DIR pointing at a directory holding @electric-sql/pglite (see tests/pglite-harness.js)';

export function migrationFiles(upTo = Infinity) {
  return readdirSync(MIGRATIONS)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .filter((f) => Number(f.slice(0, 4)) <= upTo)
    .sort();
}

/**
 * ARC-130's approved local stand-in for Supabase Vault (ADR ARC-010 §20a): the same
 * objects Vault exposes — `vault.secrets`, `vault.decrypted_secrets`,
 * `vault.create_secret`, `vault.update_secret` — so 0016's real SQL runs unchanged. It
 * does NOT encrypt anything, which is why it exists only here: 0016 refuses to apply
 * without real Vault unless the session also sets `arc.vault_test_double = 'pglite'`,
 * which nothing hosted does.
 *
 * Granted far too much on purpose, the way an unhardened install could be: the database
 * suite proves it is 0016's revokes, not this double's defaults, that keep every API role
 * out of it.
 */
const VAULT_DOUBLE = `
  create schema vault;
  comment on schema vault is 'ARC test double of Supabase Vault: plaintext, PGlite only';
  create table vault.secrets (
    id          uuid primary key default gen_random_uuid(),
    name        text unique,
    description text not null default '',
    secret      text not null,
    key_id      uuid,
    nonce       bytea,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
  );
  create view vault.decrypted_secrets as
    select id, name, description, secret, secret as decrypted_secret, key_id, nonce, created_at, updated_at
      from vault.secrets;
  create function vault.create_secret(new_secret text, new_name text default null, new_description text default '', new_key_id uuid default null)
  returns uuid language plpgsql as $$
  declare v uuid;
  begin
    insert into vault.secrets (secret, name, description, key_id)
    values (new_secret, new_name, coalesce(new_description, ''), new_key_id) returning id into v;
    return v;
  end $$;
  create function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null, new_description text default null, new_key_id uuid default null)
  returns void language plpgsql as $$
  begin
    update vault.secrets set secret = coalesce(new_secret, secret), name = coalesce(new_name, name),
      description = coalesce(new_description, description), key_id = coalesce(new_key_id, key_id), updated_at = now()
     where id = secret_id;
  end $$;
  grant usage on schema vault to public, anon, authenticated, service_role;
  grant all on all tables in schema vault to public, anon, authenticated, service_role;
  grant execute on all functions in schema vault to public, anon, authenticated, service_role;
  set arc.vault_test_double = 'pglite';
`;

/** A fresh database with the Supabase stubs and every migration up to `upTo` applied. */
export async function freshDatabase({ upTo = Infinity, before, vault = true } = {}) {
  const lib = await loadPglite();
  if (!lib) throw new Error(SKIP_REASON);
  const db = new lib.PGlite({ extensions: { pgcrypto: lib.pgcrypto } });
  await db.exec(`
    create extension if not exists pgcrypto;
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create publication supabase_realtime;
    grant usage on schema public, auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    -- what a Supabase project grants by default, so RLS and explicit revokes decide,
    -- not a missing GRANT.
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  `);
  /* `vault: false` is a database with no Vault at all — what 0016 must refuse. */
  if (vault) await db.exec(VAULT_DOUBLE);
  for (const file of migrationFiles(upTo)) {
    if (before) await before(db, file);
    try {
      await db.exec(readFileSync(new URL(file, MIGRATIONS), 'utf8'));
    } catch (error) {
      throw new Error(`${file} did not apply: ${error.message}`);
    }
  }
  return db;
}

/** Run `fn` inside a transaction as a browser role carrying a JWT subject, then roll back. */
export async function asRole(db, { role, sub = null }, fn) {
  return await db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [sub ?? '']);
    await tx.query(`set local role ${role}`);
    try {
      return await fn(tx);
    } finally {
      await tx.rollback();
    }
  });
}

/** Expect a statement to be refused; returns the error message. */
export async function refused(db, sql, params = []) {
  try {
    await db.transaction(async (tx) => { await tx.query(sql, params); });
  } catch (error) {
    return error.message;
  }
  throw new Error(`expected a refusal, but it succeeded: ${sql}`);
}

/* ── a PostgREST-shaped client ──────────────────────────── */

const IDENT = /^[a-z_][a-z0-9_]*$/;

function ident(name) {
  if (!IDENT.test(name)) throw new Error(`restClient: unsupported identifier ${name}`);
  return `"${name}"`;
}

/**
 * The supabase-js subset `supabaseStore()`, the event writer and the `ops` handlers use,
 * compiled to SQL and run as `service_role` — one transaction per request, as PostgREST
 * does. Anything else throws rather than quietly returning nothing.
 */
export function restClient(db, { role = 'service_role', sub = null } = {}) {
  const columnTypes = new Map();

  async function typesOf(tx, table) {
    if (!columnTypes.has(table)) {
      const { rows } = await tx.query(
        `select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = $1`,
        [table],
      );
      columnTypes.set(table, new Map(rows.map((r) => [r.column_name, r.data_type])));
    }
    return columnTypes.get(table);
  }

  function encode(types, column, value) {
    if (value === undefined) return null;
    const type = types.get(column);
    if (type === 'jsonb' || type === 'json') return value === null ? null : JSON.stringify(value);
    return value;
  }

  async function run(fn) {
    try {
      const data = await db.transaction(async (tx) => {
        await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [sub ?? '']);
        await tx.query(`set local role ${role}`);
        return await fn(tx);
      });
      return { data, error: null };
    } catch (error) {
      return { data: null, error: { code: error.code ?? null, message: error.message, details: error.detail ?? null } };
    }
  }

  function from(table) {
    const q = { op: 'select', columns: '*', payload: null, filters: [], order: [], limit: null, mode: 'many', returning: false, conflict: null, ignoreDuplicates: false };
    const builder = {
      select(columns = '*') { if (q.op === 'select') q.columns = columns; else { q.returning = true; q.columns = columns; } return builder; },
      insert(payload) { q.op = 'insert'; q.payload = payload; return builder; },
      update(payload) { q.op = 'update'; q.payload = payload; return builder; },
      upsert(payload, options = {}) {
        q.op = 'upsert'; q.payload = payload; q.conflict = options.onConflict ?? 'id'; q.ignoreDuplicates = options.ignoreDuplicates === true;
        return builder;
      },
      eq(col, v) { q.filters.push(['eq', col, v]); return builder; },
      lt(col, v) { q.filters.push(['cmp', col, '<', v]); return builder; },
      lte(col, v) { q.filters.push(['cmp', col, '<=', v]); return builder; },
      gt(col, v) { q.filters.push(['cmp', col, '>', v]); return builder; },
      gte(col, v) { q.filters.push(['cmp', col, '>=', v]); return builder; },
      is(col, v) { q.filters.push(['is', col, v]); return builder; },
      in(col, v) { q.filters.push(['in', col, v]); return builder; },
      not(col, op, v) { q.filters.push(['not', col, op, v]); return builder; },
      contains(col, v) { q.filters.push(['contains', col, v]); return builder; },
      or(expr) { q.filters.push(['or', null, expr]); return builder; },
      order(col, opts = {}) { q.order.push([col, opts.ascending !== false]); return builder; },
      limit(n) { q.limit = n; return builder; },
      single() { q.mode = 'single'; return builder; },
      maybeSingle() { q.mode = 'maybe'; return builder; },
      then(resolve, reject) { return execute(table, q).then(resolve, reject); },
    };
    return builder;
  }

  function where(q, params, types) {
    const parts = [];
    const param = (value) => { params.push(value); return `$${params.length}`; };
    for (const [kind, col, a, b] of q.filters) {
      if (kind === 'eq') parts.push(`${ident(col)} = ${param(encode(types, col, a))}`);
      else if (kind === 'cmp') parts.push(`${ident(col)} ${a} ${param(encode(types, col, b))}`);
      else if (kind === 'is') parts.push(`${ident(col)} is ${a === null ? 'null' : a ? 'true' : 'false'}`);
      else if (kind === 'in') parts.push(`${ident(col)}::text = any(${param(a.map(String))}::text[])`);
      else if (kind === 'not' && a === 'is' && b === null) parts.push(`${ident(col)} is not null`);
      else if (kind === 'not' && a === 'in') {
        const values = String(b).replace(/^\(|\)$/g, '').split(',').map((s) => s.replace(/"/g, ''));
        parts.push(`not (${ident(col)}::text = any(${param(values)}::text[]))`);
      } else if (kind === 'contains') parts.push(`${ident(col)} @> ${param(JSON.stringify(a))}::jsonb`);
      else if (kind === 'or') {
        const alternatives = String(a).split(',').map((clause) => {
          const [c, op, ...rest] = clause.split('.');
          const value = rest.join('.');
          if (op === 'is' && value === 'null') return `${ident(c)} is null`;
          const sql = { eq: '=', gt: '>', gte: '>=', lt: '<', lte: '<=' }[op];
          if (!sql) throw new Error(`restClient: unsupported or() operator ${op}`);
          return `${ident(c)} ${sql} ${param(value)}`;
        });
        parts.push(`(${alternatives.join(' or ')})`);
      } else throw new Error(`restClient: unsupported filter ${kind}`);
    }
    return parts.length ? ` where ${parts.join(' and ')}` : '';
  }

  function project(rows, columns) {
    if (!columns || columns.trim() === '*') return rows;
    const wanted = columns.split(',').map((c) => c.trim());
    return rows.map((r) => Object.fromEntries(wanted.map((c) => [c, r[c]])));
  }

  function shape(rows, q) {
    const out = project(rows, q.columns);
    if (q.op !== 'select' && !q.returning) return null;
    if (q.mode === 'single') {
      if (out.length !== 1) {
        const error = new Error(`JSON object requested, multiple (or no) rows returned (${out.length})`);
        error.code = 'PGRST116';
        throw error;
      }
      return out[0];
    }
    if (q.mode === 'maybe') {
      if (out.length > 1) {
        const error = new Error('JSON object requested, multiple rows returned');
        error.code = 'PGRST116';
        throw error;
      }
      return out[0] ?? null;
    }
    return out;
  }

  async function execute(table, q) {
    return await run(async (tx) => {
      const types = await typesOf(tx, table);
      const params = [];
      let rows;
      if (q.op === 'select') {
        let sql = `select * from public.${ident(table)}${where(q, params, types)}`;
        if (q.order.length) sql += ` order by ${q.order.map(([c, asc]) => `${ident(c)} ${asc ? 'asc' : 'desc'}`).join(', ')}`;
        if (q.limit !== null) sql += ` limit ${Number(q.limit)}`;
        rows = (await tx.query(sql, params)).rows;
      } else if (q.op === 'insert' || q.op === 'upsert') {
        const list = Array.isArray(q.payload) ? q.payload : [q.payload];
        rows = [];
        for (const payload of list) {
          const cols = Object.keys(payload);
          const values = cols.map((c) => { params.push(encode(types, c, payload[c])); return `$${params.length}`; });
          let sql = `insert into public.${ident(table)} (${cols.map(ident).join(', ')}) values (${values.join(', ')})`;
          if (q.op === 'upsert') {
            const keys = q.conflict.split(',').map((k) => ident(k.trim()));
            const updates = cols.filter((c) => !q.conflict.split(',').map((k) => k.trim()).includes(c));
            sql += q.ignoreDuplicates || updates.length === 0
              ? ` on conflict (${keys.join(', ')}) do nothing`
              : ` on conflict (${keys.join(', ')}) do update set ${updates.map((c) => `${ident(c)} = excluded.${ident(c)}`).join(', ')}`;
          }
          sql += ' returning *';
          rows.push(...(await tx.query(sql, params)).rows);
          params.length = 0;
        }
      } else if (q.op === 'update') {
        const cols = Object.keys(q.payload);
        const sets = cols.map((c) => { params.push(encode(types, c, q.payload[c])); return `${ident(c)} = $${params.length}`; });
        const sql = `update public.${ident(table)} set ${sets.join(', ')}${where(q, params, types)} returning *`;
        rows = (await tx.query(sql, params)).rows;
      }
      return shape(rows, q);
    });
  }

  async function rpc(name, args = {}) {
    return await run(async (tx) => {
      const { rows: procs } = await tx.query(
        `select p.proretset, t.typtype, pg_get_function_result(p.oid) as result
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           join pg_type t on t.oid = p.prorettype
          where n.nspname = 'public' and p.proname = $1`,
        [name],
      );
      if (procs.length === 0) {
        const error = new Error(`Could not find the function public.${name}`);
        error.code = 'PGRST202';
        throw error;
      }
      const names = Object.keys(args);
      const params = names.map((k) => {
        const v = args[k];
        return v !== null && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : v;
      });
      const call = `public.${ident(name)}(${names.map((k, i) => `${ident(k)} => $${i + 1}`).join(', ')})`;
      if (procs[0].proretset || /^TABLE\(|^SETOF /i.test(procs[0].result)) {
        return (await tx.query(`select * from ${call}`, params)).rows;
      }
      /* a single row type comes back as one object, as PostgREST returns it. */
      if (procs[0].typtype === 'c') {
        const { rows } = await tx.query(`select * from ${call}`, params);
        return rows[0] ?? null;
      }
      const { rows } = await tx.query(`select ${call} as value`, params);
      return rows[0]?.value ?? null;
    });
  }

  return { from, rpc };
}
