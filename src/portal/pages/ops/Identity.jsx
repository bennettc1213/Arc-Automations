import { useState } from 'react';
import { Link } from 'react-router-dom';
import Icon from '../../components/Icon';
import { Empty, Panel, Pill } from '../../components/ui';
import { ActionButton, CopyValue, Field, Notice, SelectInput } from '../../components/ops-ui';
import { isClientIdTaken, updateClient } from '../../lib/ops';
import { CLIENT_ID_EXAMPLE, generateClientId } from '../../lib/client-id';

/**
 * the ID generator, and who currently holds one.
 *
 * two things on one page because they are two halves of one question. generating
 * an ID is trivial — it is eight random symbols — and the part that actually
 * matters is that exactly one account holds it and that the account can be
 * reached at an address. so the generator sits above a table that says, for every
 * client, whether their ID will actually let them in.
 *
 * the batch exists for the real workflow: you are about to onboard three clients
 * this week and you want the IDs in front of you before the calls, not generated
 * one at a time mid-conversation.
 */

const BATCH = 5;

export default function Identity({ clients, base, reload }) {
  const [batch, setBatch] = useState(() => Array.from({ length: BATCH }, generateClientId));
  const [assignTo, setAssignTo] = useState('');
  const [assignId, setAssignId] = useState(() => generateClientId());

  const assignable = clients
    .filter((client) => client.tenant.status !== 'archived')
    .map((client) => ({
      value: client.tenant.id,
      label: `${client.tenant.name} — ${client.tenant.clientId ?? 'no id'}`,
    }));

  const target = clients.find((client) => client.tenant.id === assignTo);
  const withoutId = clients.filter((client) => !client.tenant.clientId);
  const withoutEmail = clients.filter((client) => !client.tenant.loginEmail);

  return (
    <>
      {withoutId.length > 0 && (
        <Notice tone="warn" title={`${withoutId.length} account${withoutId.length === 1 ? ' has' : 's have'} no client id`}>
          <p>
            they cannot sign in at all until they do. assign one below, or open the account and
            reissue from there.
          </p>
        </Notice>
      )}

      <Panel title="generate" note="nothing is saved until you assign one">
        <div className="ops-idcard">
          <div>
            <div className="ops-idcard__val">{batch[0]}</div>
            <div className="ops-idcard__meta" style={{ marginTop: 12 }}>
              <span>format {CLIENT_ID_EXAMPLE}</span>
              <span>crockford base32 — no i, l, o or u to misread or mishear</span>
            </div>
          </div>

          <div className="ops-idcard__actions">
            <CopyValue value={batch[0]} label="id" />
            <button
              type="button"
              className="ws-btn"
              onClick={() => setBatch(Array.from({ length: BATCH }, generateClientId))}
            >
              <Icon name="refresh" size={13} />
              new batch
            </button>
          </div>
        </div>

        <ul className="ws-list" style={{ marginTop: 16 }}>
          {batch.slice(1).map((id) => (
            <li key={id}>
              <span className="ws-list__label mono">{id}</span>
              <span className="ws-list__val">
                <CopyValue value={id} />
              </span>
            </li>
          ))}
        </ul>

        <p className="ws-note">
          eight symbols out of thirty-two is forty bits — about a trillion. these are generated
          in your browser with <code>crypto.getRandomValues</code>, not <code>Math.random</code>,
          so one id tells you nothing about the next. the database holds a unique index on top
          of that, which is what actually guarantees no two clients share one.
        </p>
      </Panel>

      <Panel title="assign an id to a client" note="replaces whatever they hold now">
        {clients.length === 0 ? (
          <Empty title="no clients yet">
            <Link className="ops-inline-link" to={`${base}/clients/new`}>
              add one
            </Link>{' '}
            and an id is generated as part of it.
          </Empty>
        ) : (
          <div className="ops-form">
            <Field label="client">
              <SelectInput
                options={[{ value: '', label: 'choose an account…' }, ...assignable]}
                value={assignTo}
                onChange={(event) => setAssignTo(event.target.value)}
              />
            </Field>

            <Field
              label="new id"
              hint={
                target?.tenant.clientId
                  ? `replaces ${target.tenant.clientId}, which stops working immediately`
                  : 'this account has no id yet'
              }
            >
              <div className="ops-row">
                <code className="ops-copy__val" style={{ fontSize: 14 }}>
                  {assignId}
                </code>
                <button
                  type="button"
                  className="ws-btn"
                  onClick={() => setAssignId(generateClientId())}
                  title="generate another"
                >
                  <Icon name="refresh" size={13} />
                </button>
              </div>
            </Field>

            <div className="ops-form__row">
              <ActionButton
                variant="primary"
                icon="check"
                disabled={!assignTo}
                confirm={
                  target?.tenant.clientId
                    ? `give ${target.tenant.name} the id ${assignId}? ${target.tenant.clientId} stops working the moment this saves.`
                    : undefined
                }
                onRun={async () => {
                  /* checked before the write even though the unique index would
                     catch it. the index gives you a constraint violation; this
                     gives you a sentence about which account already holds it. */
                  if (await isClientIdTaken(assignId)) {
                    throw new Error('that id is already held by another account — generate another');
                  }
                  await updateClient(assignTo, { client_id: assignId });
                  await reload();
                  const next = generateClientId();
                  setAssignId(next);
                  return `${target?.tenant.name ?? 'account'} now signs in with ${assignId}`;
                }}
              >
                assign it
              </ActionButton>
            </div>
          </div>
        )}
      </Panel>

      <Panel title="who holds what" note={`${clients.length} account${clients.length === 1 ? '' : 's'}`} bare>
        {clients.length === 0 ? (
          <Empty title="nothing to show yet" />
        ) : (
          <div className="ws-tablewrap">
            <table className="ws-table ws-table--dense">
              <thead>
                <tr>
                  <th className="ws-table__wide">client</th>
                  <th>client id</th>
                  <th>sign-in goes to</th>
                  <th>can they get in</th>
                  <th aria-label="actions" />
                </tr>
              </thead>
              <tbody>
                {clients.map((client) => {
                  const ready = Boolean(client.tenant.clientId && client.tenant.loginEmail);
                  return (
                    <tr className="ws-table__row" key={client.tenant.id}>
                      <td>
                        <Link className="ops-inline-link" to={`${base}/clients/${client.tenant.id}`}>
                          {client.tenant.name}
                        </Link>
                      </td>
                      <td className="mono">{client.tenant.clientId ?? '—'}</td>
                      <td className="ws-table__sub">{client.tenant.loginEmail ?? 'nowhere yet'}</td>
                      <td>
                        <Pill tone={ready ? 'ok' : 'warn'}>{ready ? 'yes' : 'not yet'}</Pill>
                      </td>
                      <td>
                        {client.tenant.clientId && <CopyValue value={client.tenant.clientId} />}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="ws-note">
          an id on its own is half of a sign-in. the other half is an address the link can be
          sent to, which is why this table reports both together —{' '}
          {withoutEmail.length === 0
            ? 'every account currently has one.'
            : `${withoutEmail.length} do not, and their ids will not work.`}
        </p>
      </Panel>
    </>
  );
}
