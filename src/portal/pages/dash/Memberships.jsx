import RecordTable, { DetailFacts, DetailSteps } from '../../components/RecordTable';
import { Panel, Pill, StatCard } from '../../components/ui';
import {
  Coverage,
  Freshness,
  ModuleGate,
  ModuleStat,
  RuleCheck,
  RuleList,
} from '../../components/ModuleUI';
import {
  formatCount,
  formatDate,
  formatDays,
  formatMoney,
  formatStamp,
  maskPhone,
} from '../../lib/format';

/**
 * service agreements, and specifically the handful of them that are stuck.
 *
 * the deliberate omission on this page is a book of business. your billing provider already
 * knows who is on what plan and already retries its own failed cards; your crm already books
 * its own visits. rebuilding either of those here would produce a second copy that is wrong
 * within a week, and a client reconciling two membership counts trusts neither.
 *
 * what neither system does is notice the gaps between them: a card the provider gave up on,
 * a visit that came due and was never booked, a cancellation nobody answered before the
 * renewal date. those are the rows here. everything else is counted and left alone.
 */

const PAYMENT_TONE = { ok: 'ok', failed: 'fail', recovered: 'ok' };

export default function Memberships({ data, base }) {
  const module = data.availability.memberships;
  const { records, recordTotal, metrics } = data.memberships;
  const tz = data.tenant.timezone;
  const retained = metrics.retainedCoverage;

  return (
    <ModuleGate module={module}>
      <>
        <div className="ws-stats">
          <StatCard
            label="needs your team"
            value={metrics.exceptions}
            animate
            format={formatCount}
            sub="exceptions neither your billing provider nor your crm will resolve on their own"
            tone="lead"
          />

          <StatCard
            label="active memberships"
            value={metrics.active}
            animate
            format={formatCount}
            sub={`${formatCount(metrics.renewalsDue)} renewing in the next ${metrics.renewalHorizonDays} days`}
          />

          <StatCard
            label="failed payments open"
            value={metrics.failedPayments}
            animate
            format={formatCount}
            sub={`${formatCount(metrics.recoveredByProvider)} recovered by your billing provider's own retries`}
          />

          <ModuleStat
            label="membership revenue retained"
            value={formatMoney(metrics.retainedRevenueCents)}
            compact
            available={metrics.retainedRevenueCents !== null}
            unavailable="recovery events have not carried an amount, so there is nothing to total"
            sub={
              <>
                only recoveries that came with a real amount ·{' '}
                <Coverage of={retained.withAmount} total={retained.total} noun="recoveries" />
              </>
            }
          />
        </div>

        <div className="ws-stats ws-stats--four">
          <StatCard
            label="visits due"
            value={metrics.upcomingVisits}
            compact
            sub="included visits not yet on the calendar"
          />
          <StatCard
            label="visits overdue"
            value={metrics.overdueVisits}
            compact
            sub="past their due date with no appointment"
          />
          <StatCard
            label="cancellation requests"
            value={metrics.cancellations}
            compact
            sub="open, with renewal messaging stopped"
          />
          <StatCard
            label="renewals due"
            value={metrics.renewalsDue}
            compact
            sub={`inside ${metrics.renewalHorizonDays} days`}
          />
        </div>

        <Freshness
          at={records[0]?.lastCommunicationAt ?? null}
          timezone={tz}
          label="last membership sync"
        />

        <RuleList note="how this module behaves around your other systems">
          <RuleCheck
            rule="a cancellation request stops automated renewal messaging immediately"
            breaches={0}
            detail="the member drops out of every renewal sequence the moment they ask, and a human review task is raised in its place"
          />
          <RuleCheck
            rule="your billing provider's own retries are left to run"
            breaches={0}
            detail={`${formatCount(metrics.recoveredByProvider)} card${metrics.recoveredByProvider === 1 ? '' : 's'} recovered without us touching them — we only surface the ones it has given up on`}
          />
          <RuleCheck
            rule="retained revenue is only counted where a real amount was recovered"
            breaches={0}
            detail="a plan price multiplied by a recovered count would be a model, not a measurement"
          />
        </RuleList>

        <RecordTable
          title="membership exceptions"
          records={records}
          recordTotal={recordTotal}
          csvName={`${data.tenant.slug ?? 'arc'}-memberships`}
          csv={[
            { label: 'customer', value: (r) => r.customer },
            { label: 'plan', value: (r) => r.plan },
            { label: 'status', value: (r) => r.status },
            { label: 'renewal date', value: (r) => r.renewalDate },
            { label: 'payment state', value: (r) => r.payment.state },
            { label: 'provider retry', value: (r) => r.payment.providerRetryState },
            { label: 'visit due', value: (r) => r.visit.dueAt },
            { label: 'visit booked', value: (r) => r.visit.bookedAt },
            { label: 'cancellation', value: (r) => r.cancellation?.at },
            { label: 'next action', value: (r) => r.nextAction },
          ]}
          search={(r) => [r.customer, r.plan, r.status, r.assignedTo].join(' ')}
          searchPlaceholder="customer, plan or status"
          searchLabel="filter memberships"
          noMatchNoun="memberships"
          emptyTitle="no memberships yet"
          emptyBody="once your service agreements are syncing, renewals, failed payments and the visits still owed will show here."
          filters={[
            {
              key: 'view',
              label: 'filter by state',
              options: [
                { key: 'all', label: 'all', match: () => true },
                { key: 'exceptions', label: 'needs your team', match: (r) => r.exception },
                { key: 'payment', label: 'payment failed', match: (r) => r.payment.state === 'failed' },
                { key: 'visits', label: 'visit owed', match: (r) => r.visit.open },
                { key: 'cancelling', label: 'cancelling', match: (r) => Boolean(r.cancellation) },
                {
                  key: 'renewing',
                  label: 'renewing soon',
                  match: (r) =>
                    r.renewalInDays !== null && r.renewalInDays >= 0 && r.renewalInDays <= 30,
                },
              ],
            },
          ]}
          sorts={{
            renewal: {
              label: 'renewal date',
              compare: (a, b) => String(a.renewalDate ?? '').localeCompare(String(b.renewalDate ?? '')),
            },
            exceptions: {
              label: 'exceptions first',
              compare: (a, b) => Number(b.exception) - Number(a.exception),
            },
            customer: {
              label: 'customer name',
              compare: (a, b) => String(a.customer ?? '').localeCompare(String(b.customer ?? '')),
            },
          }}
          defaultSort="exceptions"
          rowTone={(r) => (r.needsHuman ? 'attention' : null)}
          columns={[
            {
              key: 'customer',
              label: 'member',
              render: (r) => (
                <span className="ws-table__strong">{r.customer ?? 'unnamed member'}</span>
              ),
              sub: (r) => r.plan ?? '',
            },
            {
              key: 'renewal',
              label: 'renews',
              render: (r) => (r.renewalDate ? formatDate(r.renewalDate, tz) : '—'),
              sub: (r) => (r.renewalInDays === null ? '' : formatDays(r.renewalInDays)),
            },
            {
              key: 'payment',
              label: 'payment',
              render: (r) => (
                <Pill tone={PAYMENT_TONE[r.payment.state] ?? 'neutral'}>{r.payment.state}</Pill>
              ),
              sub: (r) =>
                r.payment.state === 'failed'
                  ? `provider: ${r.payment.providerRetryState ?? 'unknown'}`
                  : r.payment.recoveredBy
                    ? `by ${r.payment.recoveredBy}`
                    : '',
            },
            {
              key: 'visit',
              label: 'included visit',
              render: (r) =>
                r.visit.overdue ? (
                  <Pill tone="fail">overdue</Pill>
                ) : r.visit.bookedAt ? (
                  <Pill tone="ok">booked</Pill>
                ) : r.visit.open ? (
                  <Pill tone="warn">due</Pill>
                ) : (
                  '—'
                ),
              sub: (r) => (r.visit.dueAt ? formatDate(r.visit.dueAt, tz) : ''),
            },
            {
              key: 'status',
              label: 'status',
              render: (r) => r.status,
            },
            {
              key: 'next',
              label: 'next action',
              wide: true,
              render: (r) => r.nextAction ?? '—',
              sub: (r) => r.assignedTo ?? '',
            },
          ]}
          detail={(r) => (
            <>
              <DetailSteps
                steps={[
                  ...(r.payment.failedAt
                    ? [
                        {
                          label: `payment failed${
                            r.payment.amountCents !== null
                              ? ` · ${formatMoney(r.payment.amountCents)}`
                              : ''
                          }`,
                          at: formatStamp(r.payment.failedAt, tz),
                          failed: true,
                        },
                      ]
                    : []),
                  ...(r.payment.recoveredAt
                    ? [
                        {
                          label: `payment recovered${
                            r.payment.recoveredBy ? ` by ${r.payment.recoveredBy}` : ''
                          }`,
                          at: formatStamp(r.payment.recoveredAt, tz),
                        },
                      ]
                    : []),
                  ...(r.visit.dueAt
                    ? [{ label: `included visit due${r.visit.type ? ` — ${r.visit.type}` : ''}`, at: formatDate(r.visit.dueAt, tz) }]
                    : []),
                  ...(r.visit.bookedAt
                    ? [{ label: 'visit booked', at: formatStamp(r.visit.bookedAt, tz) }]
                    : []),
                  ...(r.cancellation
                    ? [
                        {
                          label: `cancellation requested${
                            r.cancellation.reason ? ` — ${r.cancellation.reason}` : ''
                          }`,
                          at: formatStamp(r.cancellation.at, tz),
                          failed: true,
                        },
                      ]
                    : []),
                ]}
              />

              <DetailFacts
                rows={[
                  { label: 'plan', value: r.plan },
                  { label: 'plan price', value: formatMoney(r.priceCents) },
                  { label: 'renews', value: r.renewalDate ? formatDate(r.renewalDate, tz) : null },
                  { label: 'contact', value: maskPhone(r.phone) },
                  {
                    label: 'your provider',
                    value:
                      r.payment.state === 'failed'
                        ? `${r.payment.attempts ?? 1} attempt${r.payment.attempts === 1 ? '' : 's'} · ${
                            r.payment.providerExhausted
                              ? 'it has stopped retrying — this one needs a person'
                              : `still retrying (${r.payment.providerRetryState ?? 'unknown'})`
                          }`
                        : null,
                  },
                  { label: 'assigned to', value: r.assignedTo },
                  { label: 'next action', value: r.nextAction },
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
          footNote={
            <>
              a membership only appears as an exception when something has genuinely stalled:
              your billing provider has stopped retrying a card, an included visit is past its
              due date with nothing booked, or a member has asked to cancel and nobody has
              answered them yet. renewals still running normally are counted above and left
              where they are.
            </>
          }
        />

        <Panel title="what this module does not do" className="ws-panel--quiet">
          <p className="ws-note">
            it does not take payments, cancel plans, or change anything in your billing
            provider. it does not re-book visits on its own. what it does is watch both
            systems, notice what fell between them, and put it in front of a person with the
            context attached — and record every one of those so the gap can be measured rather
            than argued about.
          </p>
        </Panel>
      </>
    </ModuleGate>
  );
}
