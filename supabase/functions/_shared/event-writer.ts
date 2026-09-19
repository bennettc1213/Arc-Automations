/**
 * The one way an event is written.
 *
 * Extracted from `ingest/index.ts` when Lead Recovery gave Arc's own functions a reason to
 * append to the log. Three things now write events — the public ingest endpoint, the Twilio
 * webhooks, and the dispatcher — and if each had its own insert, each would have its own
 * opinion about idempotency. The one that got it wrong would double-count a lead, and a
 * double-counted lead makes every number on the dashboard indefensible.
 *
 * The sink is an interface rather than a Supabase client so this file stays free of
 * `jsr:` imports and can be exercised by the test suite directly, with an in-memory sink
 * that behaves the way the unique index does. The Deno functions pass
 * `supabaseEventSink(db)`.
 */

import { type IncomingEvent, validateEvent } from './event-validation.ts';

export type EventRow = IncomingEvent & { tenant_id: string };

export interface EventSink {
  /** upsert on (tenant_id, event_key) ignoring duplicates. Returns rows actually written. */
  upsertKeyed(rows: EventRow[]): Promise<{ written: number; error: string | null }>;
  /** plain insert for rows carrying no event_key — nothing can deduplicate them. */
  insertUnkeyed(rows: EventRow[]): Promise<{ written: number; error: string | null }>;
}

export interface WriteResult {
  accepted: number;
  written: number;
  duplicates: number;
  error: string | null;
}

/**
 * Idempotency, in one place.
 *
 * n8n retries on transient failure and Twilio redelivers callbacks it did not get a 2xx
 * for, so the same event arrives more than once as a matter of routine. Rows carrying an
 * `event_key` collide on the unique index and are ignored; rows without one cannot be
 * deduplicated and are inserted as-is. This depends on migration 0002 having been applied —
 * the partial index from 0001 is not usable as an ON CONFLICT target and every upsert fails
 * against it.
 */
export async function writeEvents(
  sink: EventSink,
  tenantId: string,
  events: IncomingEvent[],
): Promise<WriteResult> {
  const rows: EventRow[] = events.map((e) => ({ ...e, tenant_id: tenantId }));
  const keyed = rows.filter((r) => r.event_key !== null && r.event_key !== undefined);
  const unkeyed = rows.filter((r) => r.event_key === null || r.event_key === undefined);

  let written = 0;

  if (keyed.length > 0) {
    const result = await sink.upsertKeyed(keyed);
    if (result.error) return { accepted: rows.length, written: 0, duplicates: 0, error: result.error };
    written += result.written;
  }

  if (unkeyed.length > 0) {
    const result = await sink.insertUnkeyed(unkeyed);
    if (result.error) return { accepted: rows.length, written, duplicates: 0, error: result.error };
    written += result.written;
  }

  return { accepted: rows.length, written, duplicates: rows.length - written, error: null };
}

/**
 * Validate-then-write, for Arc's own functions.
 *
 * An internally emitted event goes through exactly the same validator an outside workflow's
 * does. It is tempting to skip it — we wrote the object two lines ago, we know its shape —
 * but that is precisely the argument that ends with one internal caller defaulting
 * `occurred_at` to now() on a retry and putting a message on the timeline an hour after it
 * was really sent.
 *
 * A validation failure here is a bug in Arc's code rather than a bad request from outside,
 * so it returns the errors for the caller to log loudly. It never writes a partial batch:
 * if one event in a group is malformed, none of them land, because a half-written lifecycle
 * is harder to read than a missing one.
 */
export async function emitEvents(
  sink: EventSink,
  tenantId: string,
  inputs: unknown[],
): Promise<WriteResult & { invalid: string[] }> {
  const valid: IncomingEvent[] = [];
  const invalid: string[] = [];

  inputs.forEach((input, i) => {
    const result = validateEvent(input);
    if (result.ok) valid.push(result.event);
    else invalid.push(...result.errors.map((e) => `events[${i}]: ${e}`));
  });

  if (invalid.length > 0) {
    return { accepted: inputs.length, written: 0, duplicates: 0, error: 'validation failed', invalid };
  }

  const result = await writeEvents(sink, tenantId, valid);
  return { ...result, invalid };
}

/**
 * A stable event key.
 *
 * Every internal event derives its key from what it is *about* rather than from a random
 * id, which is what makes a redelivered Twilio callback a duplicate rather than a second
 * row. The parts are joined with a separator that cannot appear in a uuid or a Twilio SID,
 * so two different events cannot collide by concatenation.
 */
export function eventKey(...parts: (string | number | null | undefined)[]): string {
  return parts
    .filter((part) => part !== null && part !== undefined && String(part).length > 0)
    .map((part) => String(part).replace(/:/g, '_'))
    .join(':')
    .slice(0, 512);
}

/** Minimal shape of the part of a Supabase client this needs. Keeps `jsr:` out of here. */
interface PostgrestLike {
  from(table: string): {
    upsert(
      rows: unknown[],
      options: { onConflict: string; ignoreDuplicates: boolean },
    ): { select(columns: string): Promise<{ data: unknown[] | null; error: { message: string } | null }> };
    insert(
      rows: unknown[],
    ): { select(columns: string): Promise<{ data: unknown[] | null; error: { message: string } | null }> };
  };
}

export function supabaseEventSink(db: PostgrestLike): EventSink {
  return {
    async upsertKeyed(rows) {
      const { data, error } = await db
        .from('events')
        .upsert(rows, { onConflict: 'tenant_id,event_key', ignoreDuplicates: true })
        .select('id');
      return { written: data?.length ?? 0, error: error?.message ?? null };
    },
    async insertUnkeyed(rows) {
      const { data, error } = await db.from('events').insert(rows).select('id');
      return { written: data?.length ?? 0, error: error?.message ?? null };
    },
  };
}
