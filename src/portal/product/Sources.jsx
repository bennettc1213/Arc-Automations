import { useState } from 'react';
import { Link } from 'react-router-dom';
import { parseCsv, suggestMapping, parseMapping, mapImportRows, IMPORT_TARGETS, LIMITS } from '../../../supabase/functions/_shared/intake/model.ts';
import { Button, Field, Notice, PageHead, Section } from './ui';

const METHODS = [['incoming', 'Website and phone'], ['import', 'Existing contact list'], ['provider', 'Bought lists']];
const words = value => String(value || '').replaceAll('_', ' ').replace(/^./, c => c.toUpperCase());

export default function Sources({ state, base }) {
  const [method, setMethod] = useState('incoming'), [file, setFile] = useState(null), [mapping, setMapping] = useState({}), [error, setError] = useState(''), [provenance, setProvenance] = useState('');
  async function choose(event) {
    setError(''); setFile(null);
    const chosen = event.target.files[0];
    if (!chosen) return;
    if (chosen.size > LIMITS.csvCharacters) { setError('That file is too large. Split it into smaller files.'); return; }
    try {
      const parsed = parseCsv(await chosen.text());
      if (parsed.problems.length) throw new Error(parsed.problems.join(' · '));
      setFile({ ...parsed, name: chosen.name });
      setMapping(suggestMapping(parsed.headers));
    } catch (e) { setError(e.message); }
  }
  const checked = file ? parseMapping(mapping, file.headers) : null;
  const rows = file && checked.ok ? mapImportRows({ headers: file.headers, rows: file.rows, mapping, services: [], fileName: file.name }) : [];
  const count = status => rows.filter(row => row.status === status).length;
  return (
    <>
      <PageHead back={<Link className="ap-back" to={`${base}/leads`}>← Leads</Link>} title="Lead sources">Where your leads come from.</PageHead>
      <div className="ap-tabs" role="group" aria-label="Source method">
        {METHODS.map(([key, label]) => <Button key={key} aria-pressed={method === key} onClick={() => setMethod(key)}>{label}</Button>)}
      </div>

      {method === 'incoming' && (
        <Section title="Catch the inquiries you already get">
          <div className="ap-card">
            <p>ARC gives you a form for your website and texts back the callers you miss. Each lead arrives with the customer’s details and a record of what they agreed to.</p>
            <Link className="ap-button ap-button--primary" to={`${base}/connections`}>Set up a connection</Link>
          </div>
        </Section>
      )}

      {method === 'provider' && (
        <Section title="Bought lists are not supported">
          <div className="ap-card">
            <p>No list provider is connected, and ARC does not supply lists of homeowners. People on a bought list have not asked to hear from you, so ARC would need a documented source and a record that each person agreed to be contacted before texting any of them.</p>
          </div>
        </Section>
      )}

      {method === 'import' && (
        <Section title="Check a contact list" note="These are contacts you already have, not new leads.">
          <div className="ap-card">
            <Notice>This is a preview on your own device. The file is not uploaded or saved, and nobody in it is contacted. Importing for real is not available yet.</Notice>
            <Field label="CSV file" hint={state.mode === 'demo' ? 'A spreadsheet saved as CSV. Use made-up data in the demo.' : 'A spreadsheet saved as CSV.'}>
              <input type="file" accept=".csv,text/csv" onChange={choose} />
            </Field>
            {error && <p role="alert" className="ap-error">{error}</p>}
            {file && (
              <>
                <h3 className="ap-subheading">Match your columns</h3>
                <div className="ap-form-grid">
                  {file.headers.map(header => (
                    <Field label={header} key={header}>
                      <select value={mapping[header] || ''} onChange={e => setMapping({ ...mapping, [header]: e.target.value || null })}>
                        <option value="">Leave out</option>
                        {IMPORT_TARGETS.map(target => <option key={target}>{target}</option>)}
                      </select>
                    </Field>
                  ))}
                </div>
                {!checked.ok && <p role="alert" className="ap-error">{checked.errors.map(e => e.message).join(' · ')}</p>}
                <Field label="Where this list came from" hint="Say where the list came from and where the record of each person’s agreement is kept. Writing it here does not count as their agreement.">
                  <textarea value={provenance} onChange={e => setProvenance(e.target.value)} maxLength={1000} />
                </Field>
                <p className="ap-result-count">{count('ready')} valid · {count('duplicate_in_file')} duplicates in file · {count('invalid')} invalid</p>
                <div className="ap-table-wrap">
                  <table>
                    <thead><tr><th>Row</th><th>Check</th><th>Can ARC text them?</th></tr></thead>
                    <tbody>
                      {rows.slice(0, 100).map(row => (
                        <tr key={row.row_number}><td>{row.row_number}</td><td>{words(row.status)} {row.problems.map(p => p.message).join('; ')}</td><td>Not confirmed</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="ap-muted">Showing up to 100 rows. Nothing has been imported, and this preview cannot check against contacts already in your account.</p>
                <Button disabled>Import not available yet</Button>
              </>
            )}
          </div>
        </Section>
      )}
    </>
  );
}
