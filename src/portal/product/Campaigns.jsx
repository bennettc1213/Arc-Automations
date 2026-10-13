import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { KINDS, QUESTIONS, newCampaign, previewMessage, readiness, validateCampaign } from './model';
import { KIND_HELP, applyRecommended, businessHours, delayWords, guideSteps, hoursWords, isRecommended, journey, messageTemplates, oneLine, questionHelp, readinessItems, recommend, recommendKind, templateOf } from './guide';
import PublishDialog from './Publish';
import SendingPause from './Pause';
import { CAMPAIGN_FIRST_TEXT } from '../../../supabase/functions/_shared/campaigns/model.ts';
import { Badge, Button, Checklist, Choice, Choices, Dialog, Field, Notice, PageHead, Progress, Section, dateLabel, stateLabel, stateTone } from './ui';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function Campaigns({ state, dispatch, base, onReload }) {
  const [review, setReview] = useState(null);
  const [publishing, setPublishing] = useState(null);
  const running = review?.runtime === 'simulated';
  return (
    <>
      <PageHead title="Campaigns" action={<Link className="ap-button ap-button--primary" to={`${base}/campaigns/new`}>New campaign</Link>}>
        Each campaign is one job ARC does for you, from the first text to handing you the lead.
      </PageHead>
      {state.mode !== 'demo' && (
        <Notice>
          A campaign you save is a draft. When you switch one on, its texts become the ones ARC sends, and you can change them and switch it on again at any time.{' '}
          <Link to={`${base}/automations`}>See what is running now</Link>
        </Notice>
      )}
      <SendingPause state={state} onReload={onReload} />
      <div className="ap-campaign-list">
        {state.campaigns.map(c => <CampaignCard key={c.id} c={c} state={state} base={base} dispatch={dispatch} onReview={setReview} onPublish={setPublishing} />)}
      </div>
      {!state.campaigns.length && (
        <Section title="Start with the inquiries you already get" note="Pick the one that matches how customers reach you. You can add the others later.">
          <CampaignChoices base={base} state={state} />
        </Section>
      )}
      {publishing && <PublishDialog state={state} campaign={publishing} base={base} onClose={() => setPublishing(null)} onPublished={onReload} />}
      {review && (
        <Dialog title={running ? 'Pause this campaign?' : 'Start this campaign?'} onClose={() => setReview(null)}>
          <p>{oneLine(review)}</p>
          <Notice>
            {running
              ? 'ARC stops starting new conversations. The ones already under way stay in your inbox.'
              : 'This is the demo, so it runs on sample inquiries only. No real texts are sent.'}
          </Notice>
          {!running && <Checklist items={readinessItems(review, state).filter(item => !item.done)} />}
          <Button primary disabled={!running && readiness(review, state).length > 0}
            onClick={() => { dispatch({ type: 'runtime', id: review.id, runtime: running ? 'paused' : 'simulated' }); setReview(null); }}>
            {running ? 'Pause campaign' : 'Start on sample data'}
          </Button>
        </Dialog>
      )}
    </>
  );
}

function CampaignCard({ c, state, base, dispatch, onReview, onPublish }) {
  const items = readinessItems(c, state);
  const done = items.filter(item => item.done).length;
  const next = items.find(item => !item.done);
  return (
    <article className="ap-card ap-campaign">
      <div className="ap-row">
        <div>
          <h2>{c.name}</h2>
          <p className="ap-muted">{c.name === KINDS[c.kind].name ? '' : `${KINDS[c.kind].name} · `}{c.updatedAt ? `Updated ${dateLabel(c.updatedAt, state.business.timezone)}` : 'Not saved yet'}</p>
        </div>
        <Badge tone={stateTone(c.runtime)}>{stateLabel(c.runtime)}</Badge>
      </div>
      <p className="ap-campaign-summary">{oneLine(c)}</p>
      <div className="ap-campaign-ready">
        <Progress value={done} max={items.length} label={`${done} of ${items.length} ready`} />
        <p>
          {c.runtime === 'paused' ? 'Paused. Look it over before you start it again.'
            : next ? <><b>{done} of {items.length} ready.</b> Next: {next.todo}.</>
              : <b>Everything it needs is in place.</b>}
        </p>
      </div>
      <div className="ap-actions">
        <Link className="ap-button" to={`${base}/campaigns/${c.id}`}>Open</Link>
        <Button onClick={() => dispatch({ type: 'saveCampaign', campaign: c, duplicate: true })}>Duplicate</Button>
        {state.mode === 'demo' && <Button onClick={() => onReview(c)}>{c.runtime === 'simulated' ? 'Pause' : 'Start'}</Button>}
        {state.mode !== 'demo' && CAMPAIGN_FIRST_TEXT[c.kind] && (
          <Button primary={c.runtime !== 'live'} onClick={() => onPublish(c)}>{c.runtime === 'live' ? 'See what is live' : c.runtime === 'live_edited' ? 'Switch on your changes' : 'Switch on'}</Button>
        )}
      </div>
    </article>
  );
}

export function CampaignChoices({ base, state, onSelect }) {
  const pick = recommendKind(state);
  return (
    <div className="ap-kinds">
      {Object.entries(KINDS).map(([key, kind]) => {
        const best = pick.value === key;
        return (
          <article key={key} className={`ap-card ap-kind${best ? ' is-recommended' : ''}`}>
            <div className="ap-kind-head">
              <h3>{kind.name}</h3>
              {best && <Badge tone="rec">Recommended</Badge>}
              {state.campaigns.some(c => c.kind === key) && <Badge>You have one</Badge>}
            </div>
            <p>{KIND_HELP[key].what}</p>
            <p className="ap-muted">{best ? pick.reason : KIND_HELP[key].when}</p>
            {onSelect
              ? <Button primary={best} onClick={() => onSelect(key)}>Choose {kind.name}</Button>
              : <Link className={`ap-button${best ? ' ap-button--primary' : ''}`} to={`${base}/campaigns/new?kind=${key}`}>Set up {kind.name}</Link>}
          </article>
        );
      })}
    </div>
  );
}

/** The campaign told in order: what sets it off, each text, and where it hands over. */
export function Journey({ campaign, business, className = '' }) {
  return (
    <ol className={`ap-journey ${className}`.trim()}>
      {journey(campaign, business).map((step, i) => (
        <li key={i} className={`ap-journey-step ap-journey-step--${step.who}`}>
          <span className="ap-journey-dot" aria-hidden="true" />
          <div>
            <b>{step.title}</b>
            {step.body && <div className="ap-bubble">{step.body}</div>}
            {step.items && (
              <ol className="ap-journey-items">
                {step.items.map(item => <li key={item.body}><div className="ap-bubble">{item.body}</div><small>{item.note}</small></li>)}
              </ol>
            )}
            {step.note && <small>{step.note}</small>}
          </div>
        </li>
      ))}
    </ol>
  );
}

/* ── the guide: one question a screen, each with ARC's pick and why ── */

function GoalStep({ c, locked, state, base, onKind }) {
  const pick = recommendKind(state);
  if (locked) {
    return (
      <Notice>
        This campaign is a {KINDS[c.kind].name}: {KIND_HELP[c.kind].what.toLowerCase()} For a different job,{' '}
        <Link to={`${base}/campaigns/new`}>start a new campaign</Link>.
      </Notice>
    );
  }
  return (
    <Choices legend="Job for this campaign" legendHidden>
      {Object.entries(KINDS).map(([key, kind]) => (
        <Choice key={key} name="goal" checked={c.kind === key} onChange={() => onKind(key)} title={kind.name}
          recommended={pick.value === key} reason={pick.reason}>
          {KIND_HELP[key].what} <span className="ap-choice-when">{KIND_HELP[key].when}</span>
        </Choice>
      ))}
    </Choices>
  );
}

function AudienceStep({ c, set, rec }) {
  return (
    <>
      <Choices legend="Who this campaign contacts" legendHidden>
        <Choice name="audience" checked={c.audience === 'incomplete'} onChange={() => set('audience', 'incomplete')}
          title="People who asked for help, then went quiet" recommended={rec.audience.value === 'incomplete'} reason={rec.audience.reason}>
          They started an inquiry and stopped replying.
        </Choice>
        <Choice name="audience" checked={c.audience === 'reactivation'} onChange={() => set('audience', 'reactivation')}
          title="Past customers and contacts">
          People already on your list who agreed to hear from you about this.
        </Choice>
      </Choices>
      <Field label="Where these contacts come from">
        <select value={c.source} onChange={e => set('source', e.target.value)}>
          <option value="existing">Your existing contacts</option>
          <option value="form">Your website form</option>
        </select>
      </Field>
      <p className="ap-muted">ARC only texts someone when there is a record that they agreed to this kind of message. A list of numbers on its own is not enough.</p>
    </>
  );
}

function MessageStep({ c, set, rec, state, problems }) {
  const templates = messageTemplates(c.kind);
  const current = templateOf(c);
  const [custom, setCustom] = useState(current === 'custom');
  return (
    <>
      <Choices legend="First text" legendHidden>
        {templates.map(t => (
          <Choice key={t.id} name="message" checked={!custom && current === t.id} onChange={() => { setCustom(false); set('message', t.text); }}
            title={t.label} recommended={rec.message.value === t.id} reason={rec.message.reason}>
            <span className="ap-quote">{previewMessage(t.text, state.business).text}</span>
            {c.kind === 'missed' && t.text.includes('{{first_name}}') && (
              <span className="ap-choice-when">When ARC only has a number and no name, this text is held for you to check.</span>
            )}
          </Choice>
        ))}
        <Choice name="message" checked={custom} onChange={() => setCustom(true)} title="Write my own">
          Start from the wording you picked and make it yours.
        </Choice>
      </Choices>
      {custom && (
        <Field label="Your first text" hint="Type {{business}} where your business name goes and {{first_name}} for theirs. Keep “Reply STOP to opt out”. It has to be there.">
          <textarea rows={4} maxLength={1600} value={c.message} onChange={e => set('message', e.target.value)} />
        </Field>
      )}
      {problems.length > 0 && <div role="alert" className="ap-error">{problems.map(p => <p key={p}>{p}</p>)}</div>}
    </>
  );
}

function QuestionsStep({ c, set, rec }) {
  const find = key => c.questions.find(q => q.key === key);
  const extra = c.questions.filter(q => !QUESTIONS.some(base => base.key === q.key));
  const toggle = key => set('questions', [
    ...QUESTIONS.filter(base => base.key === key ? !find(key) : find(base.key))
      .map(base => find(base.key) || { ...base, required: rec.questions[base.key]?.required ?? base.required }),
    ...extra,
  ]);
  const patch = (key, change) => set('questions', c.questions.map(q => q.key === key ? { ...q, ...change } : q));
  return (
    <>
      <div className="ap-questions">
        {QUESTIONS.map(base => {
          const q = find(base.key), help = questionHelp(base.key), pick = rec.questions[base.key];
          return (
            <div key={base.key} className={`ap-question${q ? ' is-on' : ''}`}>
              <label className="ap-question-head">
                <input type="checkbox" checked={Boolean(q)} onChange={() => toggle(base.key)} />
                <span>
                  <span className="ap-choice-title">{help.title}{pick.ask && <Badge tone="rec">Recommended</Badge>}</span>
                  <span className="ap-choice-reason">{pick.reason}</span>
                </span>
              </label>
              {q && (
                <div className="ap-question-body">
                  <Field label={<>ARC asks<span className="ap-sr"> about {help.title.toLowerCase()}</span></>}>
                    <input value={q.text} maxLength={240} onChange={e => patch(base.key, { text: e.target.value })} />
                  </Field>
                  <label className="ap-check">
                    <input type="checkbox" checked={q.required} onChange={e => patch(base.key, { required: e.target.checked })} />
                    They must answer this before a lead counts as a fit
                  </label>
                </div>
              )}
              {!q && ['service', 'location'].includes(base.key) && (
                <p className="ap-question-warn">Without this, ARC cannot tell whether the job is a fit, so these leads come to you to check.</p>
              )}
            </div>
          );
        })}
      </div>
      <p className="ap-muted">ARC asks one question at a time and skips anything the customer has already told you.</p>
    </>
  );
}

const withCurrent = (options, value, label) => options.some(([v]) => v === value) ? options : [...options, [value, label(value)]].sort((a, b) => a[0] - b[0]);

function TimingStep({ c, set, rec, state }) {
  const delays = withCurrent([[0, 'Right away'], [1, 'After about a minute'], [5, 'After 5 minutes'], [15, 'After 15 minutes']], c.delay, v => `After ${v} minutes`);
  return (
    <>
      <Choices legend="How soon after they reach out?">
        {delays.map(([value, label]) => (
          <Choice key={value} name="delay" checked={c.delay === value} onChange={() => set('delay', value)} title={label}
            recommended={rec.delay.value === value} reason={rec.delay.reason} />
        ))}
      </Choices>
      <Choices legend={`And outside your hours (${businessHours(state.business)})?`}>
        <Choice name="afterHours" checked={c.afterHours === 'next_open'} onChange={() => set('afterHours', 'next_open')} title="Wait until you open"
          recommended={rec.afterHours.value === 'next_open'} reason={rec.afterHours.reason} />
        <Choice name="afterHours" checked={c.afterHours === 'hold'} onChange={() => set('afterHours', 'hold')} title="Hold it for me to look at first">
          Nothing goes out until you have seen it.
        </Choice>
      </Choices>
      <p className="ap-muted">Timing is a target. Phone networks sometimes deliver a text later than it was sent.</p>
    </>
  );
}

function FollowupStep({ c, set, rec }) {
  const gaps = [...new Set([24, 48, 72, c.followupHours])].sort((a, b) => a - b);
  return (
    <>
      <Choices legend="When should ARC check in?">
        {gaps.map(hours => (
          <Choice key={hours} name="followupHours" checked={c.followupHours === hours} onChange={() => set('followupHours', hours)}
            title={`After ${hoursWords(hours)}`} recommended={rec.followupHours.value === hours} reason={rec.followupHours.reason} />
        ))}
      </Choices>
      <Choices legend="Who sends it?">
        <Choice name="approval" checked={c.approval === 'template'} onChange={() => set('approval', 'template')} title="ARC sends it for me"
          recommended={rec.approval.value === 'template'} reason={rec.approval.reason}>
          It goes out in your opening hours with the wording below.
        </Choice>
        <Choice name="approval" checked={c.approval === 'review'} onChange={() => set('approval', 'review')} title="Ask me first"
          recommended={rec.approval.value === 'review'} reason={rec.approval.reason}>
          It stays a draft until you approve it.
        </Choice>
      </Choices>
      <Field label="Check-in wording" hint="Keep “Reply STOP to opt out” at the end.">
        <textarea rows={3} maxLength={1600} value={c.followup} onChange={e => set('followup', e.target.value)} />
      </Field>
      <p className="ap-muted">A check-in only goes to someone who has not replied. A reply, STOP, a booking or you taking over cancels it.</p>
    </>
  );
}

const LIMITS = [
  [1, 'One text, then leave it with them', 'No check-in is sent.'],
  [2, 'Up to 2 texts', 'The first text and one check-in.'],
  [3, 'Up to 3 texts', 'The first text and two check-ins.'],
];
function LimitsStep({ c, set, rec }) {
  return (
    <>
      <Choices legend="Texts to one person without a reply" legendHidden>
        {LIMITS.map(([value, title, text]) => (
          <Choice key={value} name="maxContacts" checked={c.maxContacts === value} onChange={() => set('maxContacts', value)} title={title}
            recommended={rec.limits.maxContacts === value} reason={rec.limits.reason}>
            {text}
          </Choice>
        ))}
      </Choices>
      <Field label="Shortest gap between two texts to the same person, in hours" hint={`ARC recommends ${rec.limits.cooldown}. Anything from 1 to 720 works.`}>
        <input type="number" min="1" max="720" value={c.cooldown} onChange={e => set('cooldown', Number(e.target.value))} />
      </Field>
      <p className="ap-muted">The limit counts texts from all your campaigns together, not each one separately.</p>
    </>
  );
}

const SCENARIOS = kind => [
  ['eligible', kind === 'missed' ? 'A missed call from a new customer' : 'A new inquiry'],
  ...(kind === 'missed'
    ? [['answered', 'A call you answered'], ['repeated', 'The same person calling twice'], ['unknown', 'A caller with no number']]
    : [['duplicate', 'The same inquiry sent twice'], ['incomplete', 'An inquiry with no phone number']]),
  ['blocked', 'Someone with no permission on record'],
  ['unavailable', 'A number that cannot receive texts'],
  ['failed', 'A connection that is down'],
  ['quiet', 'An inquiry outside your hours'],
];

function ReviewStep({ c, set, state, base, initial, changed, go, onReset, dispatch }) {
  const [scenario, setScenario] = useState('eligible');
  const items = readinessItems(c, state);
  const open = items.filter(item => !item.done);
  const required = c.questions.filter(q => q.required).length;
  const answers = [
    ['goal', 'Job', KINDS[c.kind].name],
    ...(c.kind === 'followup' ? [['audience', 'Who', c.audience === 'reactivation' ? 'Past customers and contacts' : 'People who went quiet']] : []),
    ['message', 'First text', messageTemplates(c.kind).find(t => t.id === templateOf(c))?.label || 'Your own wording'],
    ['questions', 'Questions', c.questions.length ? `${plural(c.questions.length, 'question')}, ${required} needed for a fit` : 'None'],
    ['timing', 'Timing', `${delayWords(c.delay)}. Outside your hours: ${c.afterHours === 'hold' ? 'held for you' : 'waits until you open'}`],
    ['followup', 'No reply', c.maxContacts > 1 ? `Check-in after ${hoursWords(c.followupHours)}, ${c.approval === 'review' ? 'once you approve it' : 'sent for you'}` : 'No check-in'],
    ['limits', 'Limits', `Up to ${plural(c.maxContacts, 'text')}, at least ${plural(c.cooldown, 'hour')} apart`],
  ];
  return (
    <>
      <Field label="Campaign name" hint="Only you see this.">
        <input value={c.name} maxLength={120} onChange={e => set('name', e.target.value)} />
      </Field>

      <div className="ap-review-grid">
        <section className="ap-card">
          <h3>What your customer gets</h3>
          <Journey campaign={c} business={state.business} />
        </section>

        <div>
          <section className="ap-card">
            <div className="ap-row">
              <h3>Your answers</h3>
              {isRecommended(c, state) ? <Badge tone="rec">ARC’s recommended setup</Badge> : <Button quiet onClick={onReset}>Reset to recommended</Button>}
            </div>
            <dl className="ap-answers">
              {answers.map(([id, label, value]) => (
                <div key={id}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                  <Button quiet aria-label={`Change ${label.toLowerCase()}`} onClick={() => go(id)}>Change</Button>
                </div>
              ))}
              <div>
                <dt>Alerts</dt>
                <dd>{state.business.alerts === 'Inbox and owner text' ? 'Your inbox and a text to you' : 'Your inbox'}</dd>
                <Link className="ap-button ap-button--quiet" to={`${base}/settings`}>Settings</Link>
              </div>
            </dl>
          </section>

          <section className="ap-card">
            <div className="ap-row">
              <h3>Before this can go live</h3>
              <span className="ap-muted">{items.length - open.length} of {items.length} done</span>
            </div>
            <Checklist items={items} renderAction={item => item.to
              ? <Link className="ap-button" to={`${base}/${item.to}`}>{item.action}</Link>
              : item.step ? <Button onClick={() => go(item.step)}>{item.action}</Button> : null} />
          </section>

          {state.mode === 'demo' && (
            <section className="ap-card">
              <h3>Try it</h3>
              <p className="ap-muted">Send a pretend inquiry through this campaign and watch what happens. Nothing real is sent.</p>
              <Field label="What should arrive?">
                <select value={scenario} onChange={e => setScenario(e.target.value)}>
                  {SCENARIOS(c.kind).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </Field>
              <Button disabled={!initial || changed || open.length > 0} onClick={() => dispatch({ type: 'scenario', campaignId: initial.id, scenario })}>Run a test</Button>
              {!initial ? <p className="ap-muted">Save the campaign first, then open it again to test it.</p>
                : changed ? <p className="ap-muted">Save your changes first. A test runs the saved version.</p>
                  : open.length > 0 && <p className="ap-muted">Finish the list above and the test unlocks.</p>}
              {state.lastSimulation && (
                <Notice>
                  {state.lastSimulation}{' '}
                  {state.lastLeadId && <Link to={`${base}/inbox/${state.lastLeadId}`}>Open conversation →</Link>}
                </Notice>
              )}
            </section>
          )}
        </div>
      </div>
    </>
  );
}

function Phone({ c, step, state }) {
  const first = previewMessage(c.message, state.business);
  const say = text => previewMessage(text, state.business).text;
  return (
    <aside className="ap-phone" aria-label="What your customer sees">
      <p className="ap-phone-title">What your customer sees</p>
      <div className="ap-phone-screen">
        <p className="ap-phone-from">{state.business.name || 'Your business'}</p>
        <p className="ap-phone-when">{delayWords(c.delay)}</p>
        <div className="ap-bubble">{first.text}</div>
        {step === 'questions' && c.questions.map(q => <div className="ap-bubble" key={q.key}>{q.text}</div>)}
        {step === 'followup' && c.maxContacts > 1 && (
          <>
            <p className="ap-phone-when">{hoursWords(c.followupHours)} later, no reply</p>
            <div className="ap-bubble">{say(c.followup)}</div>
          </>
        )}
      </div>
      {first.missing.length > 0 && <p role="alert" className="ap-error">ARC does not know what to put for {first.missing.map(m => `{{${m}}}`).join(', ')}.</p>}
      <p className="ap-muted">{step === 'questions' ? 'Questions arrive one at a time, after each reply.' : 'Shown with a sample name.'}</p>
    </aside>
  );
}

export function CampaignBuilder({ state, dispatch, base }) {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const initial = state.campaigns.find(c => c.id === id);
  const asked = KINDS[params.get('kind')] ? params.get('kind') : null;
  // a new campaign starts with ARC's picks filled in, so each screen is a confirmation
  const [c, setC] = useState(() => structuredClone(initial || applyRecommended(newCampaign(asked || recommendKind(state).value || 'missed', state.tenantId), state)));
  const steps = guideSteps(c.kind);
  const [stepId, setStepId] = useState(initial ? 'review' : asked ? steps[1].id : 'goal');
  const [errors, setErrors] = useState([]);
  const index = Math.max(0, steps.findIndex(s => s.id === stepId));
  const step = steps[index];
  const rec = recommend(c.kind, state);
  const set = (key, value) => setC(v => ({ ...v, [key]: value }));
  const go = next => { setErrors([]); setStepId(next); window.scrollTo?.({ top: 0 }); };
  // on a phone the step strip scrolls sideways: keep the current step in view
  useEffect(() => { document.querySelector('.ap-steps [aria-current]')?.scrollIntoView?.({ inline: 'center', block: 'nearest' }); }, [stepId]);
  const changed = Boolean(initial && JSON.stringify(c) !== JSON.stringify(initial));
  const wording = validateCampaign(c, state.business).filter(e => /message|STOP/i.test(e));

  function forward() {
    if (step.id === 'message' && wording.length) { setErrors(wording); return; }
    go(steps[index + 1].id);
  }
  async function save() {
    const problems = validateCampaign(c, state.business);
    setErrors(problems);
    if (problems.length) return;
    if (await dispatch({ type: 'saveCampaign', campaign: c })) navigate(`${base}/campaigns`);
  }
  const wide = step.id === 'goal' || step.id === 'review';

  return (
    <>
      <PageHead back={<Link className="ap-back" to={`${base}/campaigns`}>← Campaigns</Link>} title={initial ? c.name : 'New campaign'}
        action={<Badge tone={stateTone(initial?.runtime || 'draft')}>{stateLabel(initial?.runtime || 'draft')}</Badge>}>
        {state.mode === 'demo' ? 'A few questions, each with the answer ARC would pick for you.' : 'A few questions, each with the answer ARC would pick for you. It saves as a draft.'}
      </PageHead>

      <ol className="ap-steps">
        {steps.map((s, i) => (
          <li key={s.id}>
            <button type="button" aria-current={i === index ? 'step' : undefined} className={i < index ? 'is-done' : ''} onClick={() => go(s.id)}>
              <span>{i + 1}</span>{s.short}
            </button>
          </li>
        ))}
      </ol>

      <div className={`ap-guide${wide ? ' ap-guide--wide' : ''}`}>
        <div className="ap-guide-main">
          <p className="ap-guide-count">{step.id === 'review' ? 'Last step' : `Question ${index + 1} of ${steps.length - 1}`}</p>
          <h2 className="ap-guide-question">{step.title}</h2>

          {step.id === 'goal' && <GoalStep c={c} locked={Boolean(initial)} state={state} base={base}
            onKind={kind => setC(applyRecommended({ ...newCampaign(kind, state.tenantId, c.id), version: c.version }, state))} />}
          {step.id === 'audience' && <AudienceStep c={c} set={set} rec={rec} />}
          {step.id === 'message' && <MessageStep c={c} set={set} rec={rec} state={state} problems={errors} />}
          {step.id === 'questions' && <QuestionsStep c={c} set={set} rec={rec} />}
          {step.id === 'timing' && <TimingStep c={c} set={set} rec={rec} state={state} />}
          {step.id === 'followup' && <FollowupStep c={c} set={set} rec={rec} />}
          {step.id === 'limits' && <LimitsStep c={c} set={set} rec={rec} />}
          {step.id === 'review' && <ReviewStep c={c} set={set} state={state} base={base} initial={initial} changed={changed} go={go}
            dispatch={dispatch} onReset={() => setC(v => applyRecommended(v, state))} />}

          {step.id !== 'message' && errors.length > 0 && <div role="alert" className="ap-error">{errors.map(e => <p key={e}>{e}</p>)}</div>}

          <div className="ap-form-footer">
            <Button disabled={index === 0} onClick={() => go(steps[index - 1].id)}>Back</Button>
            <div className="ap-actions">
              {step.id !== 'review' && <Button quiet onClick={() => go('review')}>Skip to review</Button>}
              {step.id !== 'review'
                ? <Button primary onClick={forward}>Continue</Button>
                : <Button primary disabled={Boolean(initial) && !changed} onClick={save}>{initial ? (changed ? 'Save changes' : 'Saved') : state.mode === 'demo' ? 'Save campaign' : 'Save draft'}</Button>}
            </div>
          </div>
        </div>
        {!wide && <Phone c={c} step={step.id} state={state} />}
      </div>
    </>
  );
}
