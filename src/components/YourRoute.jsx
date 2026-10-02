import { useState } from 'react';
import { site } from '../data/site';
import { openPilot } from '../lib/pilot';
import { ROUTE_EVENTS, track } from '../lib/track';
import {
  ROUTES,
  ROUTE_COMPARISON,
  ROUTE_DISCOVERY,
  ROUTE_PRINCIPLES,
  ROUTE_SUGGESTION_NOTICE,
  getRoute,
  parseRouteKey,
  suggestRoute,
} from '../../supabase/functions/_shared/routes/model.ts';
import './YourRoute.css';

const COPY = site.routes;
const TOTAL = ROUTE_DISCOVERY.length;

/* the question shown: the first one still open, or TOTAL once there is a suggestion. */
const nextStep = (suggestion) =>
  suggestion.remaining.length > 0 ? ROUTE_DISCOVERY.findIndex((q) => q.key === suggestion.remaining[0]) : TOTAL;

/* where a company fits, read the way an owner would read it: three situations in
   their own words, and one short answer for the one they pick. everything else —
   the side-by-side and the five questions — is folded away until asked for, and
   the questions come one at a time. it only ever suggests: the answers stay in
   this component, and a route is carried into the pilot intake as a note for the
   call — nothing here configures anything. */
export default function YourRoute({ initialAnswers, initialRoute, initialOpen }) {
  const [answers, setAnswers] = useState(() => suggestRoute(initialAnswers).answers);
  const suggestion = suggestRoute(answers);
  const suggested = getRoute(suggestion.route);
  const [picked, setPicked] = useState(() => parseRouteKey(initialRoute) ?? suggestion.route ?? ROUTES[0].key);
  const [step, setStep] = useState(() => nextStep(suggestion));
  const [compare, setCompare] = useState(initialOpen === 'compare');
  const [quiz, setQuiz] = useState(initialOpen === 'quiz');
  const active = getRoute(picked);
  const question = ROUTE_DISCOVERY[step];

  const pick = (route) => {
    setPicked(route);
    track(ROUTE_EVENTS.picked, { route });
  };

  const toggle = (which, isOpen, set) => {
    set(!isOpen);
    if (!isOpen) track(ROUTE_EVENTS.opened, { which });
  };

  const answer = (key, value) => {
    const next = suggestRoute({ ...answers, [key]: value });
    setAnswers(next.answers);
    setStep(nextStep(next));
    track(ROUTE_EVENTS.answered, { question: key, answered: TOTAL - next.remaining.length });
    if (next.route) {
      setPicked(next.route);
      track(ROUTE_EVENTS.suggested, { route: next.route });
    }
  };

  const reset = () => {
    setAnswers({});
    setStep(0);
    track(ROUTE_EVENTS.reset);
  };

  const talk = (route, routeSource) => {
    track(ROUTE_EVENTS.cta, { route, source: routeSource });
    openPilot(undefined, { route, routeSource });
  };

  return (
    <section className="route wrap" id="route" aria-labelledby="route-title">
      <p className="eyebrow">{COPY.eyebrow}</p>
      <h2 className="section-title route__title" id="route-title">{COPY.title}</h2>
      <p className="route__lead">{COPY.lead}</p>

      <div className="route__tabs" role="tablist" aria-label={COPY.pick}>
        {ROUTES.map((r, i) => (
          <button
            type="button"
            key={r.key}
            role="tab"
            id={`route-tab-${r.key}`}
            aria-selected={picked === r.key}
            aria-controls="route-panel"
            data-route={r.key}
            className={`route__tab ${picked === r.key ? 'is-active' : ''}`}
            onClick={() => pick(r.key)}
          >
            <span className="route__tab-index mono">{String(i + 1).padStart(2, '0')}</span>
            <span className="route__tab-label">{r.situation}</span>
            <span className="route__tab-tag mono">
              {r.name}
              {suggestion.route === r.key && ` · ${COPY.suggestedFlag}`}
            </span>
          </button>
        ))}
      </div>

      <div className="route__panel" role="tabpanel" id="route-panel" aria-labelledby={`route-tab-${active.key}`} key={active.key}>
        <div className="route__panelhead">
          <h3 className="route__name">{active.name}</h3>
          <span className="route__status mono">{COPY.status[active.key]}</span>
        </div>
        <p className="route__summary">{active.summary}</p>

        <div className="route__cols">
          <div>
            <p className="route__label mono">{COPY.provides}</p>
            <ul className="route__points">
              {active.arcProvides.map((pt) => (
                <li key={pt}>
                  <span aria-hidden="true">→</span> {pt}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="route__label mono">{COPY.keeps}</p>
            <p className="route__keep">{active.youKeep}</p>
          </div>
        </div>

        <button type="button" className="route__cta" data-route={active.key} onClick={() => talk(active.key, 'chosen')}>
          {COPY.cta} {active.name} <span aria-hidden="true">→</span>
        </button>
      </div>

      <ul className="route__principles" aria-label="true on every route">
        {ROUTE_PRINCIPLES.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>

      {/* quiet on purpose, like the "more services" toggle: for the reader who
          wants more, not a second thing to read before the first has landed. */}
      <div className="route__more">
        <button
          type="button"
          className={`route__toggle mono ${quiz ? 'is-open' : ''}`}
          aria-expanded={quiz}
          aria-controls="route-quiz"
          onClick={() => toggle('quiz', quiz, setQuiz)}
        >
          {COPY.quizToggle}
          <span className="route__chev" aria-hidden="true">▾</span>
        </button>
        <button
          type="button"
          className={`route__toggle mono ${compare ? 'is-open' : ''}`}
          aria-expanded={compare}
          aria-controls="route-compare"
          onClick={() => toggle('compare', compare, setCompare)}
        >
          {COPY.compareToggle}
          <span className="route__chev" aria-hidden="true">▾</span>
        </button>
      </div>

      {quiz && (
        <div className="route__quiz" id="route-quiz">
          {question && (
            <div className="route__question" role="group" aria-labelledby="route-q" key={question.key}>
              <p className="route__progress mono">
                {String(step + 1).padStart(2, '0')} / {String(TOTAL).padStart(2, '0')}
                {step > 0 && (
                  <button type="button" className="route__back mono" onClick={() => setStep((s) => Math.max(0, s - 1))}>
                    ← {COPY.quizBack}
                  </button>
                )}
              </p>
              <p className="route__q" id="route-q">{question.question}</p>
              <div className="route__options">
                {question.options.map((o) => (
                  <button
                    type="button"
                    key={o.value}
                    className={`route__opt ${answers[question.key] === o.value ? 'is-picked' : ''}`}
                    aria-pressed={answers[question.key] === o.value}
                    onClick={() => answer(question.key, o.value)}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="route__result" role="status" aria-live="polite">
            {!question && suggested && (
              <>
                <p className="route__label mono">{COPY.quizSuggested}</p>
                <p className="route__resultname">{suggested.name}</p>
                <p className="route__reason">{suggestion.reasons[0]}</p>
                <p className="route__notice">{ROUTE_SUGGESTION_NOTICE}</p>
                <div className="route__resultactions">
                  <button
                    type="button"
                    className="route__cta"
                    data-route={suggested.key}
                    onClick={() => talk(suggested.key, 'assessment')}
                  >
                    {COPY.quizCta} {suggested.name} <span aria-hidden="true">→</span>
                  </button>
                  <button type="button" className="route__back mono" onClick={reset}>
                    {COPY.quizReset}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {compare && (
        <table className="route__table" id="route-compare" aria-label={COPY.compareLabel}>
          <thead>
            <tr>
              <td />
              {ROUTES.map((r) => (
                <th scope="col" key={r.key} className={picked === r.key ? 'is-active' : ''}>
                  {r.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROUTE_COMPARISON.map((row) => (
              <tr key={row.key}>
                <th scope="row">{row.label}</th>
                {ROUTES.map((r) => (
                  /* data-label is the column heading again: at phone width the
                     table stacks and each cell has to say whose it is. */
                  <td key={r.key} data-label={r.name} className={picked === r.key ? 'is-active' : ''}>
                    {row.values[r.key]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
