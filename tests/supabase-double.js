/* a stand-in for the supabase-js client, for testing `supabaseStore` itself.
 *
 * `MemoryStore` answers "does the engine do the right thing"; it cannot answer "does the
 * production adapter persist what the engine hands it", because it keeps whole objects.
 * That gap is how `config_snapshot_id` went missing from the run insert (ARC-015B) with
 * every test green.
 *
 * This double stores exactly the snake_case payload the adapter sends — nothing more —
 * and hands rows back the way PostgREST does, so a column the adapter forgets to write
 * is simply absent when it is read back. It enforces no constraint and runs no trigger:
 * the database's own rules are asserted against the migration SQL, not imitated here.
 *
 * Only the builder calls `supabase-store.ts` and `event-writer.ts` make are supported,
 * and anything else throws rather than quietly returning nothing.
 */

let counter = 0;
const uuid = () => {
  counter += 1;
  return `dddddddd-0000-4000-8000-${String(counter).padStart(12, '0')}`;
};

/* what Postgres fills in on insert, per table, as far as the adapter reads it back. */
const DEFAULTS = {
  automation_runs: () => ({ state: 'new', config_snapshot_id: null, stopped_at: null, completed_at: null, stop_reason: null, last_error: null }),
  scheduled_actions: () => ({
    status: 'pending', attempts: 0, max_attempts: 5, locked_at: null, locked_by: null,
    lease_token: null, fence: 0, last_error: null, completed_at: null, config_snapshot_id: null,
  }),
  conversations: () => ({ status: 'open', provider_ref: null, last_inbound_at: null, last_outbound_at: null }),
  /* 0014. the version columns default to null, so an adapter that forgets to send them
     reads back null — exactly the ARC-015B failure, made visible. */
  lead_recovery_config_snapshots: () => ({ tenant_config_version_id: null, module_config_version_id: null }),
  tenant_config_drafts: () => ({ revision: 1, status: 'open', published_version_id: null, closed_at: null }),
  module_config_drafts: () => ({ revision: 1, status: 'open', published_version_id: null, closed_at: null }),
};

/* 0014's two views: the highest-numbered version per scope. derived here as Postgres
   derives them, so a head is never a separately stored fact in the double either. */
function headsOf(rows, keys) {
  const best = new Map();
  for (const row of rows) {
    const key = keys.map((k) => row[k]).join('|');
    if (!best.has(key) || best.get(key).version < row.version) best.set(key, row);
  }
  return [...best.values()];
}

const VIEWS = {
  tenant_config_heads: (rows) => headsOf(rows('tenant_config_versions'), ['tenant_id']),
  module_config_heads: (rows) => headsOf(rows('module_config_versions'), ['tenant_id', 'module_key']),
};

/* jsonb `@>`: every key and value in `sub` is present in `value`. */
function contains(value, sub) {
  if (sub === null || typeof sub !== 'object') return value === sub;
  if (Array.isArray(sub)) return Array.isArray(value) && sub.every((s) => value.some((v) => contains(v, s)));
  return value !== null && typeof value === 'object' && Object.entries(sub).every(([k, v]) => contains(value[k], v));
}

function matches(row, filter) {
  const [kind, col, a, b] = filter;
  const value = row[col];
  switch (kind) {
    case 'eq': return value === a;
    case 'is': return a === null ? value === null || value === undefined : value === a;
    case 'in': return a.includes(value);
    case 'not':
      if (a === 'is' && b === null) return value !== null && value !== undefined;
      if (a === 'in') return !String(b).replace(/^\(|\)$/g, '').split(',').map((s) => s.replace(/"/g, '')).includes(value);
      throw new Error(`double: unsupported not(${a})`);
    case 'contains': return contains(value, a);
    case 'or': return true; // only used for suppression expiry; no fixture expires
    default: throw new Error(`double: unsupported filter ${kind}`);
  }
}

/**
 * `options.rpc` maps a function name to `(args, double) => ({ data, error })`, for the
 * tests that need a database function's answer. Unscripted calls answer `{ data: [] }`.
 */
export function supabaseDouble(seed = {}, options = {}) {
  const tables = new Map(Object.entries(seed).map(([t, rows]) => [t, rows.map((r) => ({ ...r }))]));
  const writes = [];
  const rpcs = [];
  const rows = (table) => {
    if (VIEWS[table]) return VIEWS[table](rows);
    if (!tables.has(table)) tables.set(table, []);
    return tables.get(table);
  };

  function from(table) {
    const q = { op: 'select', payload: null, filters: [], mode: 'many', returning: false, limit: null, conflict: null, order: null };
    const builder = {
      select() { if (q.op !== 'select') q.returning = true; return builder; },
      insert(payload) { q.op = 'insert'; q.payload = payload; return builder; },
      update(payload) { q.op = 'update'; q.payload = payload; return builder; },
      upsert(payload, options = {}) { q.op = 'upsert'; q.payload = payload; q.conflict = options.onConflict ?? 'id'; return builder; },
      eq(col, v) { q.filters.push(['eq', col, v]); return builder; },
      is(col, v) { q.filters.push(['is', col, v]); return builder; },
      in(col, v) { q.filters.push(['in', col, v]); return builder; },
      not(col, op, v) { q.filters.push(['not', col, op, v]); return builder; },
      contains(col, v) { q.filters.push(['contains', col, v]); return builder; },
      or(expr) { q.filters.push(['or', null, expr]); return builder; },
      order(col, opts = {}) { q.order = { col, ascending: opts.ascending !== false }; return builder; },
      limit(n) { q.limit = n; return builder; },
      single() { q.mode = 'single'; return builder; },
      maybeSingle() { q.mode = 'maybe'; return builder; },
      then(resolve, reject) { return Promise.resolve().then(() => execute(table, q)).then(resolve, reject); },
    };
    return builder;
  }

  function execute(table, q) {
    const store = rows(table);
    let result;
    if (q.op === 'select') {
      result = store.filter((r) => q.filters.every((f) => matches(r, f)));
      if (q.order) {
        const { col, ascending } = q.order;
        result = [...result].sort((a, b) => (a[col] === b[col] ? 0 : (a[col] < b[col]) === ascending ? -1 : 1));
      }
      if (q.limit !== null) result = result.slice(0, q.limit);
    } else if (q.op === 'insert' || q.op === 'upsert') {
      const list = Array.isArray(q.payload) ? q.payload : [q.payload];
      writes.push({ table, op: q.op, payload: list.map((p) => ({ ...p })) });
      result = [];
      for (const payload of list) {
        if (q.op === 'upsert') {
          const keys = q.conflict.split(',').map((k) => k.trim());
          const existing = store.find((r) => keys.every((k) => r[k] === payload[k]));
          if (existing) continue;
        }
        const now = new Date().toISOString();
        const row = { id: uuid(), created_at: now, updated_at: now, started_at: now, ...(DEFAULTS[table]?.() ?? {}), ...payload };
        store.push(row);
        result.push({ ...row });
      }
    } else if (q.op === 'update') {
      writes.push({ table, op: 'update', payload: [{ ...q.payload }], filters: q.filters });
      result = store.filter((r) => q.filters.every((f) => matches(r, f)));
      for (const row of result) Object.assign(row, q.payload);
      result = result.map((r) => ({ ...r }));
    }

    if (q.op !== 'select' && !q.returning) return { data: null, error: null };
    if (q.mode === 'single') {
      return result.length === 1
        ? { data: result[0], error: null }
        : { data: null, error: { code: 'PGRST116', message: `expected one row, got ${result.length}` } };
    }
    if (q.mode === 'maybe') return { data: result[0] ?? null, error: null };
    return { data: result, error: null };
  }

  return {
    from,
    async rpc(name, args) {
      rpcs.push({ name, args });
      const handler = options.rpc?.[name];
      return handler ? handler(args, { rows }) : { data: [], error: null };
    },
    /** every row currently stored, by table — what the adapter actually persisted. */
    table: (name) => rows(name).map((r) => ({ ...r })),
    /** every insert, upsert and update payload, exactly as sent. */
    writes,
    rpcs,
  };
}
