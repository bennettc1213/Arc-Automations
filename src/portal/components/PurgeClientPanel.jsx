import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Icon from './Icon';
import { Panel } from './ui';
import { Field, Notice, TextInput } from './ops-ui';
import { purgeTestClient } from '../lib/ops';

/**
 * permanently deleting a test client (0022).
 *
 * only for a client that never did anything real — no events, leads, runs, texts,
 * connections or opt-outs. the database decides that inside the delete itself, so this panel
 * does not guess: a client with history is refused with the list of what it has, and the
 * answer for that client is deboarding, which keeps it. the confirmation is typing the handle,
 * because the handle is what the database checks.
 *
 * what is left afterwards is one line in the audit log and a purge record: who deleted which
 * client, and when. an auth login the client had is not deleted.
 */
export default function PurgeClientPanel({ tenant, base, reload }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [state, setState] = useState({ kind: 'idle' });
  const confirmed = typed.trim() === tenant.slug;

  async function submit(event) {
    event.preventDefault();
    if (!confirmed || state.kind === 'busy') return;
    setState({ kind: 'busy' });
    try {
      await purgeTestClient(tenant.id, typed.trim());
      await reload();
      navigate(`${base}/clients`);
    } catch (error) {
      setState({ kind: 'error', message: error.message, activity: error.payload?.code === 'tenant_has_activity' });
    }
  }

  return (
    <Panel
      title="delete this test client"
      note="permanent — only for a client that never did anything real"
      className="ops-danger"
      actions={
        !open && (
          <button type="button" className="ws-btn" onClick={() => setOpen(true)}>
            <Icon name="trash" size={13} />
            delete permanently
          </button>
        )
      }
    >
      {!open ? (
        <p className="ops-muted">
          for a client made to try something out. it removes the account and its setup — modules,
          settings, checklists, unused tokens — completely. a client with any real history (events,
          leads, texts, runs, connections, opt-outs) cannot be deleted: deboard it instead, which
          keeps the record.
        </p>
      ) : (
        <form onSubmit={submit}>
          <p className="ops-muted">
            this cannot be undone. the audit log keeps one line saying you deleted{' '}
            <b>{tenant.name}</b>; nothing else about them remains.
          </p>

          {state.kind === 'error' && (
            <div style={{ marginTop: 14 }}>
              <Notice tone="fail" title={state.activity ? 'this client has real history, so it was not deleted' : 'not deleted'}>
                <p>{state.message}</p>
              </Notice>
            </div>
          )}

          <div className="ops-form" style={{ marginTop: 16 }}>
            <Field label={`type ${tenant.slug} to confirm`} required wide>
              <TextInput
                mono
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                autoComplete="off"
                spellCheck="false"
                placeholder={tenant.slug}
              />
            </Field>
          </div>

          <div className="ops-row" style={{ marginTop: 14 }}>
            <button type="submit" className="ws-btn ws-btn--danger" disabled={!confirmed || state.kind === 'busy'}>
              <Icon name="trash" size={13} />
              {state.kind === 'busy' ? 'deleting…' : 'delete permanently'}
            </button>
            <button
              type="button"
              className="ws-btn"
              onClick={() => {
                setOpen(false);
                setTyped('');
                setState({ kind: 'idle' });
              }}
            >
              cancel
            </button>
          </div>
        </form>
      )}
    </Panel>
  );
}
