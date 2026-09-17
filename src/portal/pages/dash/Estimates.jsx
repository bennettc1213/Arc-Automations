import RecordTable, { DetailFacts, DetailSteps } from '../../components/RecordTable';
import { Panel, Pill, StatCard } from '../../components/ui';
import {
  Coverage,
  Freshness,
  ModuleGate,
  ModuleStat,
  RuleCheck,
  RuleList,
  Withheld,
} from '../../components/ModuleUI';
import {
  formatCount,
  formatDays,
  formatMoney,
  formatMoneyShort,
  formatPct,
  formatStamp,
  maskPhone,
} from '../../lib/format';

/**
 * the estimate book, and what follow-up actually got back.
 *
 * this is the page the product is judged on, because it is the only one that talks about
 * money. so it is also the page with the strictest rule: the word "recovered" appears
 * against an estimate only when four separate things are in the log — the original quote
 * with an amount, a follow-up that actually left, a decision that came back after it, and
 * the value on that decision. an approved estimate that never received a follow-up is shown
 * as approved and explicitly not attributed, because it would have closed anyway and
 * claiming it is the fastest way to make every other number here worthless.
 *
 * gross profit is stricter still: it needs a margin figure the client's system sent us. we
 * do not assume one, and where it is missing the card says how many jobs it is missing on
 * rather than quietly averaging over the ones that had it.
 */

const STAGE_TONE = {
  suppressed: 'idle',
  decided: 'ok',
  replied: 'warn',
  contacted: 'neutral',
  open: 'neutral',
};

const DECISION_TONE = { approved: 'ok', declined: 'idle', deferred: 'warn' };

export default function Estimates({ data, base }) {
  const module = data.availability.estimates;
  const { records, recordTotal, metrics } = data.estimates;
  const tz = data.tenant.timezone;

  const newest = records[0]?.createdAt ?? null;
  const gp = metrics.grossProfitCoverage;

  return (
    <ModuleGate module={module}>
      <>
        <div className="ws-stats">
          <StatCard
            label="open, still eligible"
            value={metrics.eligibleOpen}
            animate
            format={formatCount}
            sub={`${formatMoney(metrics.eligibleValueCents)} of quoted work waiting on a decision`}
            tone="lead"
          />

          <StatCard
            label="decisions received"
            value={metrics.decisions}
            animate
            format={formatCount}
            sub={
              metrics.decisions === 0
                ? 'nothing decided in this window'
                : `${metrics.approved} approved · ${metrics.declined} declined · ${metrics.deferred} deferred`
            }
          />

          <ModuleStat
            label="recovered revenue"
            value={formatMoneyShort(metrics.recoveredRevenueCents)}
            compact
            available={metrics.recoveredRevenueCents !== null}
            unavailable="no estimate yet has all four links — quote, follow-up, reply and a decision with a value on it"
            sub={
              <>
                approved after a follow-up that we sent ·{' '}
                <Coverage of={metrics.recoveredCount} total={metrics.approved} noun="approvals" />
              </>
            }
          />

          <ModuleStat
            label="recovered gross profit"
            value={formatMoneyShort(metrics.recoveredGrossProfitCents)}
            compact
            available={metrics.recoveredGrossProfitCents !== null}
            unavailable="your system has not sent us a margin figure, so there is nothing to compute this from"
            sub={
              gp.withMargin < gp.total ? (
                <Withheld>
                  covers {gp.withMargin} of {gp.total} recovered jobs — the rest arrived without a
                  margin figure
                </Withheld>
              ) : (
                'from the margin your system sent with each approval'
              )
            }
          />
        </div>

        <div className="ws-stats ws-stats--four">
          <StatCard
            label="customers contacted"
            value={metrics.contacted}
            compact
            sub={`${formatCount(metrics.replies)} replied`}
          />
          <StatCard
            label="opt-out rate"
            value={formatPct(metrics.optOutPct)}
            compact
            sub="of everyone we contacted"
          />
          <StatCard
            label="messages that failed"
            value={formatPct(metrics.followupFailurePct)}
            compact
            sub="carrier or provider rejections"
          />
          <StatCard
            label="held back"
            value={metrics.suppressed}
            compact
            sub="excluded from the sequence, each with a reason"
          />
        </div>

        <Freshness at={newest} timezone={tz} label="newest estimate" />

        <RuleList note="checked against the log, not asserted">
          <RuleCheck
            rule="the sequence stops the moment a customer replies"
            breaches={metrics.stopViolations}
            detail="no scheduled follow-up leaves after a reply has landed — the conversation belongs to a person from that point"
            to={`${base}/estimates?stage=replied`}
          />
          <RuleCheck
            rule="every exclusion carries a reason we recognise"
            breaches={metrics.unknownSuppressions}
            detail="approved, declined, duplicate, disputed, no consent, opted out, cannot be fulfilled, or one of your own rules"
            to={`${base}/estimates?stage=suppressed`}
          />
          <RuleCheck
            rule="“recovered” requires a decision, not a delivered message"
            breaches={0}
            detail={`${metrics.recoveredCount} of ${metrics.approved} approvals followed a follow-up we sent and are counted; the rest are not`}
          />
        </RuleList>

        <RecordTable
          title="the recovery queue"
          records={records}
          recordTotal={recordTotal}
          csvName={`${data.tenant.slug ?? 'arc'}-estimates`}
          csv={[
            { label: 'customer', value: (r) => r.customer },
            { label: 'work type', value: (r) => r.workType },
            { label: 'amount', value: (r) => (r.amountCents === null ? '' : r.amountCents / 100) },
            { label: 'estimate date', value: (r) => r.estimateDate },
            { label: 'age days', value: (r) => r.ageDays },
            { label: 'crm status', value: (r) => r.crmStatus },
            { label: 'follow-ups sent', value: (r) => r.sentCount },
            { label: 'last signal', value: (r) => r.lastSignalAt },
            { label: 'reply', value: (r) => r.reply?.classification },
            { label: 'decision', value: (r) => r.decision?.decision },
            { label: 'stage', value: (r) => r.stage },
            { label: 'attribution', value: (r) => r.attribution },
            { label: 'assigned to', value: (r) => r.assignedTo },
            { label: 'held back', value: (r) => r.suppression?.label },
            { label: 'next action', value: (r) => r.nextAction },
          ]}
          search={(r) => [r.customer, r.workType, r.crmStatus, r.assignedTo].join(' ')}
          searchPlaceholder="customer, work type or who it is assigned to"
          searchLabel="filter estimates"
          noMatchNoun="estimates"
          emptyTitle="no estimates yet"
          emptyBody="once your estimates are syncing, every open quote shows here with its age, what we have sent, and what came back."
          filters={[
            {
              key: 'stage',
              label: 'filter by stage',
              options: [
                { key: 'all', label: 'all', match: () => true },
                { key: 'open', label: 'not contacted', match: (r) => r.stage === 'open' },
                { key: 'contacted', label: 'in sequence', match: (r) => r.stage === 'contacted' },
                { key: 'replied', label: 'replied', match: (r) => r.stage === 'replied' },
                { key: 'decided', label: 'decided', match: (r) => r.stage === 'decided' },
                { key: 'suppressed', label: 'held back', match: (r) => r.stage === 'suppressed' },
              ],
            },
            {
              key: 'view',
              label: 'filter by outcome',
              options: [
                { key: 'all', label: 'any outcome', match: () => true },
                { key: 'needs-you', label: 'needs you', match: (r) => Boolean(r.needsHuman) },
                { key: 'approved', label: 'approved', match: (r) => r.decision?.decision === 'approved' },
                { key: 'recovered', label: 'recovered', match: (r) => r.attributed },
              ],
            },
          ]}
          sorts={{
            oldest: {
              label: 'oldest first',
              compare: (a, b) => String(a.estimateDate).localeCompare(String(b.estimateDate)),
            },
            newest: {
              label: 'newest first',
              compare: (a, b) => String(b.estimateDate).localeCompare(String(a.estimateDate)),
            },
            largest: {
              label: 'largest value',
              compare: (a, b) => (b.amountCents ?? -1) - (a.amountCents ?? -1),
            },
          }}
          defaultSort="oldest"
          rowTone={(r) => (r.needsHuman ? 'attention' : null)}
          columns={[
            {
              key: 'customer',
              label: 'customer',
              render: (r) => (
                <span className="ws-table__strong">{r.customer ?? 'unnamed customer'}</span>
              ),
              sub: (r) => r.workType ?? maskPhone(r.phone),
            },
            {
              key: 'amount',
              label: 'amount',
              num: true,
              render: (r) => formatMoney(r.amountCents),
            },
            {
              key: 'age',
              label: 'age',
              num: true,
              render: (r) => formatDays(r.ageDays),
            },
            {
              key: 'status',
              label: 'in your crm',
              render: (r) => r.crmStatus ?? '—',
            },
            {
              key: 'sequence',
              label: 'follow-up',
              render: (r) =>
                r.suppression ? (
                  <Pill tone="idle">held back</Pill>
                ) : r.sentCount === 0 ? (
                  '—'
                ) : (
                  `${r.sentCount} sent`
                ),
              sub: (r) => (r.suppression ? r.suppression.label : (r.followupStage ?? '')),
            },
            {
              key: 'signal',
              label: 'latest signal',
              wide: true,
              /* whichever actually happened last. a decision supersedes the reply that
                 preceded it, and showing the reply under a heading that says "latest"
                 would be wrong on every estimate that has since closed. */
              render: (r) => {
                const decidedLast = r.decision && (!r.reply || r.decision.at >= r.reply.at);
                if (decidedLast) {
                  return (
                    <Pill tone={DECISION_TONE[r.decision.decision] ?? 'neutral'}>
                      {r.decision.decision}
                    </Pill>
                  );
                }
                if (r.reply) {
                  return (
                    <Pill tone={r.needsHuman ? 'warn' : 'neutral'}>{r.reply.classification}</Pill>
                  );
                }
                return <Pill tone={STAGE_TONE[r.stage] ?? 'neutral'}>{r.stage}</Pill>;
              },
              sub: (r) => (r.lastSignalAt ? formatStamp(r.lastSignalAt, tz) : ''),
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
                  { label: 'estimate raised', at: formatStamp(r.createdAt, tz) },
                  ...r.followups.map((f) => ({
                    label: `follow-up${f.stage ? ` · ${f.stage}` : ''}${f.channel ? ` (${f.channel})` : ''}`,
                    at: formatStamp(f.at, tz),
                    failed: f.failed,
                  })),
                  ...(r.reply
                    ? [
                        {
                          label: `customer replied — ${r.reply.classification}`,
                          at: formatStamp(r.reply.at, tz),
                        },
                      ]
                    : []),
                  ...(r.decision
                    ? [
                        {
                          label: `${r.decision.decision}${
                            r.decision.amountCents !== null
                              ? ` · ${formatMoney(r.decision.amountCents)}`
                              : ''
                          }`,
                          at: formatStamp(r.decision.at, tz),
                        },
                      ]
                    : []),
                  ...(r.suppression
                    ? [
                        {
                          label: `held back — ${r.suppression.label}${
                            r.suppression.by ? ` (${r.suppression.by})` : ''
                          }`,
                          at: formatStamp(r.suppression.at, tz),
                        },
                      ]
                    : []),
                ]}
              />

              {r.reply?.body && (
                <p className="ws-detail__quote">“{r.reply.body}”</p>
              )}

              <DetailFacts
                rows={[
                  { label: 'work type', value: r.workType },
                  { label: 'quoted', value: formatMoney(r.amountCents) },
                  { label: 'estimate date', value: formatStamp(r.estimateDate, tz) },
                  { label: 'status in your crm', value: r.crmStatus },
                  { label: 'assigned to', value: r.assignedTo },
                  { label: 'contact', value: maskPhone(r.phone) },
                  {
                    label: 'attribution',
                    value:
                      /* the sentence that keeps the money column honest, printed on the
                         record itself rather than only in a footnote nobody opens. */
                      r.attributed ? (
                        <>
                          counted as recovered — {formatMoney(r.recoveredRevenueCents)}
                          {r.recoveredGrossProfitCents !== null &&
                            ` · ${formatMoney(r.recoveredGrossProfitCents)} gross profit`}
                        </>
                      ) : (
                        <Withheld>
                          {r.attribution}
                          {r.decision?.decision === 'approved' &&
                            ' — it was approved without a follow-up from us, so we make no claim on it'}
                        </Withheld>
                      ),
                  },
                  {
                    label: 'source system',
                    value: r.sourceSystem
                      ? `${r.sourceSystem}${r.externalId ? ` · ${r.externalId}` : ''}`
                      : null,
                  },
                  r.stopViolations > 0
                    ? {
                        label: 'rule breach',
                        value: (
                          <Withheld>
                            {r.stopViolations} follow-up
                            {r.stopViolations === 1 ? '' : 's'} left after this customer had
                            already replied
                          </Withheld>
                        ),
                      }
                    : null,
                ]}
              />
            </>
          )}
          footNote={
            <>
              an estimate leaves this queue when a decision arrives, when your team closes or
              pauses it, or when one of the exclusions applies — already approved, declined
              with no follow-up wanted, a duplicate, in dispute, no messaging consent on file,
              opted out, or work you cannot take right now. every excluded row stays visible
              with its reason attached rather than disappearing, because a quote that silently
              left the queue is the one nobody notices was dropped.
            </>
          }
        />

        <Panel title="how a recovery is counted" className="ws-panel--quiet">
          <ol className="ws-steps">
            <li>
              <b>the original estimate</b> — raised in your system, with an amount on it.
            </li>
            <li>
              <b>a follow-up that left</b> — accepted by the carrier, not merely scheduled.
            </li>
            <li>
              <b>the customer's answer</b> — a reply, or a decision in your system after the
              follow-up went out.
            </li>
            <li>
              <b>the value</b> — the approved amount, from your system rather than from the
              quote, so a renegotiated job counts at what it actually sold for.
            </li>
          </ol>
          <p className="ws-note">
            miss any one of those and the estimate is reported as approved, not as recovered.
            gross profit needs a fifth thing — the margin on that job — and where your system
            does not send one, no profit figure is shown for it and the card says how many
            jobs that applies to.
          </p>
        </Panel>
      </>
    </ModuleGate>
  );
}
