/**
 * Who may use the `ops` function: a signed-in user that `public.is_arc_admin()` says is in
 * `arc_admins`. Nobody else, for any action.
 *
 * Lifted out of ops/index.ts unchanged so a test can hold it to that — the function itself
 * imports supabase-js from jsr:, which node cannot load. The question is still asked of
 * Postgres with the caller's own JWT, so `is_arc_admin()` remains the one definition of an
 * operator in the system; this only decides what each answer means over HTTP.
 *
 *   no Authorization header           401  not signed in
 *   the check itself errors            500  authorisation check failed
 *   signed in, not in arc_admins       403  not an arc admin
 *   an operator                        ok, with the actor id from the verified token
 */

export type GateCaller = {
  rpc(fn: 'is_arc_admin'): PromiseLike<{ data: unknown; error: unknown }>;
  auth: { getUser(): PromiseLike<{ data: { user: { id?: string } | null } | null }> };
};

export type GateResult =
  | { ok: true; actorId: string | null }
  | { ok: false; status: 401 | 403 | 500; error: string };

export async function operatorGate(
  authorization: string | null,
  callerFor: (authorization: string) => GateCaller,
): Promise<GateResult> {
  if (!authorization) return { ok: false, status: 401, error: 'not signed in' };

  const caller = callerFor(authorization);
  const { data: isAdmin, error } = await caller.rpc('is_arc_admin');
  if (error) return { ok: false, status: 500, error: 'authorisation check failed' };
  if (!isAdmin) return { ok: false, status: 403, error: 'not an arc admin' };

  /* who is acting, taken from the verified token rather than from anything in the body — an
     actor a caller can name is not an actor. */
  const { data } = await caller.auth.getUser();
  return { ok: true, actorId: data?.user?.id ?? null };
}
