import RecordTable, { DetailFacts, DetailSteps } from '../../components/RecordTable';
import { Panel, Pill, StatCard } from '../../components/ui';
import {
  Freshness,
  ModuleGate,
  ModuleStat,
  RuleCheck,
  RuleList,
  Withheld,
} from '../../components/ModuleUI';
import {
  formatCount,
  formatPct,
  formatRating,
  formatStamp,
  maskEmail,
  maskPhone,
} from '../../lib/format';

/**
 * review requests, what came back, and the customers who need a call rather than a link.
 *
 * the thing this page refuses to do is the thing most review tools are sold on. asking the
 * happy customers for a public review and quietly routing the unhappy ones to a private
 * form is called review gating; it violates every major platform's terms, and a profile
 * caught doing it can be stripped of its reviews entirely. so every eligible completed
 * customer gets the same request, and the only reasons a request may be withheld are
 * mechanical ones — opted out, no consent, wrong number, already asked.
 *
 * a request being withheld for a sentiment reason is not silently honoured here. it is
 * counted as a breach, named on the row, and put in the queue, because the client is the
 * one carrying the risk of it and needs to know it happened.
 *
 * service recovery is the other half and the more valuable one: a bad experience found and
 * answered privately is a customer kept, and it happens whether or not a review was ever
 * written.
 */

const REQUEST_TONE = { sent: 'ok', failed: 'fail', withheld: 'idle', pending: 'neutral' };

function requestState(record) {
  if (record.request) return record.request.delivered ? 'sent' : 'failed';
  if (record.skipReason) return 'withheld';
  return 'pending';
}

export default function Reviews({ data, base }) {
  const module = data.availability.reviews;
  const { records, recordTotal, metrics } = data.reviews;
  const tz = data.tenant.timezone;

  return (
    <ModuleGate module={module}>
      <>
        <div className="ws-stats">
          <StatCard
            label="reviews received"
            value={metrics.reviewsReceived}
            animate
            format={formatCount}
            sub={
              metrics.averageRating === null
                ? 'no ratings in this window'
                : `${formatRating(metrics.averageRating)} average across them`
            }
            tone="lead"
          />

          <StatCard
            label="requests sent"
            value={metrics.requestsSent}
            animate
            format={formatCount}
            sub={
              <>
                {formatCount(metrics.delivered)} delivered ·{' '}
                {metrics.requestCoveragePct === null
                  ? 'no eligible jobs yet'
                  : `${formatPct(metrics.requestCoveragePct)} of eligible jobs asked`}
              </>
            }
          />

          <StatCard
            label="service recovery open"
            value={metrics.recoveryOpen}
            animate
            format={formatCount}
            sub={`${formatCount(metrics.recoveryOpened)} opened · ${formatCount(metrics.recoveryResolved)} resolved in this window`}
          />

          <ModuleStat
            label="awaiting a response"
            value={metrics.awaitingResponse}
            available
            sub="reviews with no reply published yet"
          />
        </div>

        <Freshness at={records[0]?.completedAt ?? null} timezone={tz} label="newest completed job" />

        <RuleList note="the compliance rules this module runs under">
          <RuleCheck
            rule="every eligible customer is asked, whatever we expect them to say"
            breaches={metrics.gatingBreaches}
            detail="a request may only be withheld for a mechanical reason — opted out, no consent, wrong contact, or already asked for this job"
            to={`${base}/reviews?request=withheld`}
            linkLabel="see the withheld ones"
          />
          <RuleCheck
            rule="a sensitive response is never published without a person approving it"
            breaches={metrics.autoPublishedSensitive}
            detail="anything on a low rating or an open recovery case waits for a human"
          />
          <RuleCheck
            rule="nothing is offered in exchange for a review"
            breaches={0}
            detail="no discount, no credit, no entry into anything — the request asks and stops"
          />
          <RuleCheck
            rule="the public route stays open to everyone equally"
            breaches={0}
            detail="an unhappy customer gets the same link as a happy one, and a private recovery case alongside it rather than instead of it"
          />
        </RuleList>

        <RecordTable
          title="completed jobs & reviews"
          records={records}
          recordTotal={recordTotal}
          csvName={`${data.tenant.slug ?? 'arc'}-reviews`}
          csv={[
            { label: 'customer', value: (r) => r.customer },
            { label: 'work type', value: (r) => r.workType },
            { label: 'completed', value: (r) => r.completedAt },
            { label: 'tech', value: (r) => r.tech },
            { label: 'request state', value: (r) => requestState(r) },
            { label: 'withheld reason', value: (r) => r.skipLabel },
            { label: 'platform', value: (r) => r.review?.platform },
            { label: 'rating', value: (r) => r.rating },
            { label: 'review', value: (r) => r.review?.text },
            { label: 'response state', value: (r) => r.responseState },
            { label: 'recovery opened', value: (r) => r.recovery?.openedAt },
            { label: 'recovery resolved', value: (r) => r.recovery?.resolvedAt },
          ]}
          search={(r) => [r.customer, r.workType, r.tech, r.review?.text, r.review?.platform].join(' ')}
          searchPlaceholder="customer, job, tech or review text"
          searchLabel="filter completed jobs"
          noMatchNoun="jobs"
          emptyTitle="no completed jobs yet"
          emptyBody="once completed jobs are syncing, each one shows here with the request we sent, the review it earned, and any recovery case opened against it."
          filters={[
            {
              key: 'request',
              label: 'filter by request',
              options: [
                { key: 'all', label: 'all', match: () => true },
                { key: 'sent', label: 'asked', match: (r) => Boolean(r.request) },
                { key: 'withheld', label: 'withheld', match: (r) => Boolean(r.skipReason) },
                { key: 'pending', label: 'not asked yet', match: (r) => !r.request && !r.skipReason },
              ],
            },
            {
              key: 'view',
              label: 'filter by outcome',
              options: [
                { key: 'all', label: 'any', match: () => true },
                { key: 'reviewed', label: 'reviewed', match: (r) => Boolean(r.review) },
                { key: 'recovery', label: 'recovery open', match: (r) => Boolean(r.recovery && !r.recovery.resolvedAt) },
                { key: 'needs-you', label: 'needs you', match: (r) => Boolean(r.needsHuman) },
              ],
            },
          ]}
          sorts={{
            newest: {
              label: 'newest first',
              compare: (a, b) => String(b.completedAt).localeCompare(String(a.completedAt)),
            },
            lowest: {
              label: 'lowest rated',
              compare: (a, b) => (a.rating ?? 99) - (b.rating ?? 99),
            },
            oldest: {
              label: 'oldest first',
              compare: (a, b) => String(a.completedAt).localeCompare(String(b.completedAt)),
            },
          }}
          defaultSort="newest"
          rowTone={(r) => (r.needsHuman ? 'attention' : null)}
          columns={[
            {
              key: 'customer',
              label: 'customer',
              render: (r) => (
                <span className="ws-table__strong">{r.customer ?? 'unnamed customer'}</span>
              ),
              sub: (r) => r.workType ?? '',
            },
            {
              key: 'completed',
              label: 'completed',
              render: (r) => formatStamp(r.completedAt, tz),
              sub: (r) => (r.tech ? `by ${r.tech}` : ''),
            },
            {
              key: 'request',
              label: 'request',
              render: (r) => {
                const state = requestState(r);
                return (
                  <Pill tone={r.sentimentGated ? 'fail' : REQUEST_TONE[state]}>
                    {r.sentimentGated ? 'withheld on sentiment' : state}
                  </Pill>
                );
              },
              sub: (r) => (r.skipReason && !r.sentimentGated ? r.skipLabel : ''),
            },
            {
              key: 'rating',
              label: 'rating',
              num: true,
              render: (r) => formatRating(r.rating),
              sub: (r) => r.review?.platform ?? '',
            },
            {
              key: 'review',
              label: 'what they said',
              wide: true,
              render: (r) =>
                r.review?.text ? (
                  <span className="ws-clamp">{r.review.text}</span>
                ) : r.review ? (
                  'rating only, no text'
                ) : (
                  '—'
                ),
            },
            {
              key: 'response',
              label: 'response',
              render: (r) => r.responseState ?? '—',
              sub: (r) => (r.response?.by ? `by ${r.response.by}` : ''),
            },
            {
              key: 'recovery',
              label: 'recovery',
              render: (r) =>
                r.recovery ? (
                  <Pill tone={r.recovery.resolvedAt ? 'ok' : 'fail'}>
                    {r.recovery.resolvedAt ? 'resolved' : 'open'}
                  </Pill>
                ) : (
                  '—'
                ),
            },
          ]}
          detail={(r) => (
            <>
              <DetailSteps
                steps={[
                  { label: 'job completed', at: formatStamp(r.completedAt, tz) },
                  ...(r.request
                    ? [
                        {
                          label: `review request ${r.request.delivered ? 'sent' : 'failed'}${
                            r.request.channel ? ` (${r.request.channel})` : ''
                          }`,
                          at: formatStamp(r.request.at, tz),
                          failed: !r.request.delivered,
                        },
                      ]
                    : []),
                  ...(r.review
                    ? [
                        {
                          label: `${formatRating(r.rating)} on ${r.review.platform ?? 'a public profile'}`,
                          at: formatStamp(r.review.at, tz),
                        },
                      ]
                    : []),
                  ...(r.recovery
                    ? [
                        {
                          label: `service recovery opened — ${r.recovery.reason ?? 'service problem'}`,
                          at: formatStamp(r.recovery.openedAt, tz),
                        },
                      ]
                    : []),
                  ...(r.recovery?.resolvedAt
                    ? [
                        {
                          label: `recovery resolved${r.recovery.resolution ? ` — ${r.recovery.resolution}` : ''}`,
                          at: formatStamp(r.recovery.resolvedAt, tz),
                        },
                      ]
                    : []),
                  ...(r.response
                    ? [
                        {
                          label: `response published${r.response.by ? ` by ${r.response.by}` : ''}`,
                          at: formatStamp(r.response.at, tz),
                        },
                      ]
                    : []),
                ]}
              />

              {r.review?.text && <p className="ws-detail__quote">“{r.review.text}”</p>}

              {r.review?.draftResponse && !r.response && (
                <div className="ws-draft">
                  <p className="pt-eyebrow">drafted response — waiting on your approval</p>
                  <p>{r.review.draftResponse}</p>
                  <p className="ws-note">
                    written against this job and what this customer said, not from a template.
                    {r.sensitive &&
                      ' it is held because the rating or the open recovery case makes it sensitive — nothing defensive goes out under your name without a person reading it first.'}
                  </p>
                </div>
              )}

              <DetailFacts
                rows={[
                  { label: 'work type', value: r.workType },
                  { label: 'completed by', value: r.tech },
                  { label: 'contact', value: `${maskPhone(r.phone)} · ${maskEmail(r.email)}` },
                  { label: 'platform', value: r.review?.platform },
                  { label: 'assigned to', value: r.recovery?.assignedTo },
                  { label: 'next action', value: r.nextAction },
                  r.sentimentGated
                    ? {
                        label: 'rule breach',
                        value: (
                          <Withheld>
                            this request was withheld for “{r.skipReason}” — a judgement about
                            how this customer would rate you. that is review gating, and it is
                            against the platforms' terms. the request should have gone out.
                          </Withheld>
                        ),
                      }
                    : null,
                  {
                    label: 'source system',
                    value: r.sourceSystem
                      ? `${r.sourceSystem}${r.externalId ? ` · ${r.externalId}` : ''}`
                      : null,
                  },
                ]}
              />
            </>
          )}
        />

        <Panel title="how responses are written" className="ws-panel--quiet">
          <p className="ws-note">
            a drafted response quotes the job and what the customer actually said — the tech
            who came out, the work that was done, the thing they were unhappy about. a generic
            “thanks for the 5 stars!” under every review is visible to the next person reading
            the profile and reads as a business that did not look.
            <br />
            <br />
            anything on a low rating, or on a job with an open recovery case, waits for one of
            your team to approve or rewrite it. a defensive reply published automatically under
            a business's name is a worse outcome than no reply, and it cannot be taken back.
          </p>
        </Panel>
      </>
    </ModuleGate>
  );
}
