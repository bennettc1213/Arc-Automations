import RecordTable, { DetailFacts, DetailSteps } from '../../components/RecordTable';
import { Panel, Pill, StatCard } from '../../components/ui';
import { Freshness, ModuleGate, RuleCheck, RuleList, Withheld } from '../../components/ModuleUI';
import { formatCount, formatDate, formatDays, formatStamp, maskPhone } from '../../lib/format';

/**
 * installation closeout and warranty registration.
 *
 * the whole module turns on one refusal: a registration is not complete because a workflow
 * finished. it is complete when the manufacturer has confirmed it and we are holding the
 * confirmation number and the certificate. anything short of that reads as `submitted`, with
 * the missing piece named.
 *
 * that sounds pedantic until the compressor fails in year four, the homeowner calls, and the
 * manufacturer has no record of the registration. at that point the difference between "our
 * system said it was done" and "here is the confirmation number" is a warranty claim the
 * contractor either wins or pays for out of their own pocket. this page exists to make sure
 * it is the first one.
 */

const STATE_TONE = {
  verified: 'ok',
  submitted: 'neutral',
  'ready to register': 'warn',
  'deadline approaching': 'warn',
  'data needed': 'warn',
  blocked: 'fail',
  'not required': 'idle',
};

export default function Installs({ data, base }) {
  const module = data.availability.installs;
  const { records, recordTotal, metrics } = data.installs;
  const tz = data.tenant.timezone;

  return (
    <ModuleGate module={module}>
      <>
        <div className="ws-stats">
          <StatCard
            label="registrations confirmed"
            value={metrics.registrationsVerified}
            animate
            format={formatCount}
            sub="confirmation number and certificate both on file"
            tone="lead"
          />

          <StatCard
            label="installs completed"
            value={metrics.installsCompleted}
            animate
            format={formatCount}
            sub={`${formatCount(metrics.closeoutsCompleted)} fully closed out`}
          />

          <StatCard
            label="waiting on equipment data"
            value={metrics.missingData}
            animate
            format={formatCount}
            sub="a serial, model or manufacturer nobody captured on site"
          />

          <StatCard
            label="deadlines approaching"
            value={metrics.deadlinesApproaching}
            animate
            format={formatCount}
            sub="manufacturer registration windows closing soon"
          />
        </div>

        <div className="ws-stats ws-stats--four">
          <StatCard
            label="blocked"
            value={metrics.blocked}
            compact
            sub="something is stopping the registration"
          />
          <StatCard
            label="customer packets sent"
            value={metrics.packetsDelivered}
            compact
            sub="paperwork the homeowner actually received"
          />
          <StatCard
            label="maintenance booked"
            value={metrics.maintenanceCreated}
            compact
            sub="required service visits on the calendar"
          />
          <StatCard
            label="confirmed without proof"
            value={metrics.evidenceMissing}
            compact
            sub="reported registered, but no confirmation on file — still counted as submitted"
          />
        </div>

        <Freshness at={records[0]?.installedAt ?? null} timezone={tz} label="newest install" />

        <RuleList note="what this module will and will not assert">
          <RuleCheck
            rule="a registration is only confirmed with evidence behind it"
            breaches={metrics.evidenceMissing}
            detail="a confirmation number and a certificate, both stored. without them the record stays at submitted no matter what the workflow reported"
            to={`${base}/installs?state=submitted`}
          />
          <RuleCheck
            rule="missing equipment data stops the job rather than guessing at it"
            breaches={0}
            detail="a registration submitted with the wrong serial is worse than one not submitted — it looks done and is not"
          />
          <RuleCheck
            rule="a blocked registration stays visible until somebody clears it"
            breaches={0}
            detail={`${formatCount(metrics.blocked)} currently blocked, each with the reason attached`}
          />
        </RuleList>

        <RecordTable
          title="installation closeout"
          records={records}
          recordTotal={recordTotal}
          csvName={`${data.tenant.slug ?? 'arc'}-installs`}
          csv={[
            { label: 'customer', value: (r) => r.customer },
            { label: 'job', value: (r) => r.job },
            { label: 'installed', value: (r) => r.installedAt },
            { label: 'address', value: (r) => r.address },
            { label: 'jurisdiction', value: (r) => r.jurisdiction },
            { label: 'manufacturer', value: (r) => r.manufacturer },
            { label: 'category', value: (r) => r.category },
            { label: 'model', value: (r) => r.modelNumber },
            { label: 'serial', value: (r) => r.serialNumber },
            { label: 'registration required', value: (r) => (r.registrationRequired ? 'yes' : 'no') },
            { label: 'deadline', value: (r) => r.registrationDeadline },
            { label: 'state', value: (r) => r.state },
            { label: 'confirmation number', value: (r) => r.confirmationNumber },
            { label: 'packet sent', value: (r) => (r.packetDelivered ? 'yes' : 'no') },
            { label: 'maintenance booked', value: (r) => r.maintenanceScheduledAt },
            { label: 'responsible', value: (r) => r.tech },
          ]}
          search={(r) =>
            [r.customer, r.job, r.manufacturer, r.modelNumber, r.serialNumber, r.tech, r.address].join(
              ' ',
            )
          }
          searchPlaceholder="customer, model, serial, address or tech"
          searchLabel="filter installs"
          noMatchNoun="installs"
          emptyTitle="no installs yet"
          emptyBody="once completed installs are syncing, each one shows here with its equipment details, registration state and the proof behind it."
          filters={[
            {
              key: 'state',
              label: 'filter by state',
              options: [
                { key: 'all', label: 'all', match: () => true },
                { key: 'data', label: 'data needed', match: (r) => r.state === 'data needed' },
                { key: 'ready', label: 'ready to register', match: (r) => r.state === 'ready to register' },
                { key: 'submitted', label: 'submitted', match: (r) => r.state === 'submitted' },
                { key: 'blocked', label: 'blocked', match: (r) => r.state === 'blocked' },
                { key: 'deadline', label: 'deadline near', match: (r) => r.deadlineApproaching },
                { key: 'verified', label: 'confirmed', match: (r) => r.state === 'verified' },
              ],
            },
          ]}
          sorts={{
            deadline: {
              label: 'deadline first',
              compare: (a, b) => (a.deadlineInDays ?? 9999) - (b.deadlineInDays ?? 9999),
            },
            newest: {
              label: 'newest install',
              compare: (a, b) => String(b.installedAt).localeCompare(String(a.installedAt)),
            },
            customer: {
              label: 'customer name',
              compare: (a, b) => String(a.customer ?? '').localeCompare(String(b.customer ?? '')),
            },
          }}
          defaultSort="deadline"
          rowTone={(r) => (r.needsHuman ? 'attention' : null)}
          columns={[
            {
              key: 'customer',
              label: 'customer',
              render: (r) => (
                <span className="ws-table__strong">{r.customer ?? 'unnamed customer'}</span>
              ),
              sub: (r) => r.address ?? r.job ?? '',
            },
            {
              key: 'equipment',
              label: 'equipment',
              wide: true,
              render: (r) =>
                r.manufacturer || r.category
                  ? `${r.manufacturer ?? 'unknown make'}${r.category ? ` · ${r.category}` : ''}`
                  : '—',
              sub: (r) =>
                r.modelNumber || r.serialNumber
                  ? `${r.modelNumber ?? 'no model'} / ${r.serialNumber ?? 'no serial'}`
                  : 'no model or serial captured',
            },
            {
              key: 'installed',
              label: 'installed',
              render: (r) => formatDate(r.installedAt, tz),
              sub: (r) => r.tech ?? '',
            },
            {
              key: 'deadline',
              label: 'deadline',
              num: true,
              render: (r) =>
                r.registrationDeadline ? formatDays(r.deadlineInDays) : r.registrationRequired ? '—' : 'n/a',
              sub: (r) => (r.registrationDeadline ? formatDate(r.registrationDeadline, tz) : ''),
            },
            {
              key: 'state',
              label: 'registration',
              render: (r) => <Pill tone={STATE_TONE[r.state] ?? 'neutral'}>{r.state}</Pill>,
              sub: (r) => r.confirmationNumber ?? r.blockedReason ?? '',
            },
            {
              key: 'closeout',
              label: 'closeout',
              render: (r) =>
                r.closeoutComplete ? (
                  <Pill tone="ok">complete</Pill>
                ) : (
                  <Pill tone="neutral">open</Pill>
                ),
              sub: (r) => (r.packetDelivered ? 'packet sent' : 'packet not sent'),
            },
            {
              key: 'next',
              label: 'next action',
              wide: true,
              render: (r) => r.nextAction ?? '—',
            },
          ]}
          detail={(r) => (
            <>
              <DetailSteps
                steps={[
                  { label: 'installation completed', at: formatStamp(r.installedAt, tz) },
                  ...(r.serialNumber
                    ? [{ label: `serial captured — ${r.serialNumber}` }]
                    : [{ label: 'serial not captured yet', failed: true }]),
                  ...(r.submittedAt
                    ? [{ label: 'registration submitted', at: formatStamp(r.submittedAt, tz) }]
                    : []),
                  ...(r.blockedReason
                    ? [{ label: `blocked — ${r.blockedReason}`, failed: true }]
                    : []),
                  ...(r.verifiedAt
                    ? [
                        {
                          label: `confirmed by the manufacturer — ${r.confirmationNumber}`,
                          at: formatStamp(r.verifiedAt, tz),
                        },
                      ]
                    : []),
                  ...(r.packetDelivered ? [{ label: 'customer packet delivered' }] : []),
                  ...(r.maintenanceScheduledAt
                    ? [
                        {
                          label: 'maintenance visit booked',
                          at: formatDate(r.maintenanceScheduledAt, tz),
                        },
                      ]
                    : []),
                ]}
              />

              <DetailFacts
                rows={[
                  { label: 'job', value: r.job },
                  { label: 'address', value: r.address },
                  { label: 'jurisdiction', value: r.jurisdiction },
                  { label: 'manufacturer', value: r.manufacturer },
                  { label: 'equipment', value: r.category },
                  { label: 'model number', value: r.modelNumber },
                  { label: 'serial number', value: r.serialNumber },
                  { label: 'photos on file', value: r.photos ? `${r.photos}` : null },
                  { label: 'contact', value: maskPhone(r.phone) },
                  {
                    label: 'registration',
                    value: r.registrationRequired
                      ? `required · deadline ${
                          r.registrationDeadline ? formatDate(r.registrationDeadline, tz) : 'not set'
                        }`
                      : 'not required for this equipment',
                  },
                  {
                    label: 'proof on file',
                    value: r.confirmationNumber ? (
                      <>
                        {r.confirmationNumber}
                        {r.certificateRef && ` · ${r.certificateRef}`}
                      </>
                    ) : r.evidenceMissing ? (
                      <Withheld>
                        the workflow reported this registered, but no confirmation number or
                        certificate arrived with it. it is held at submitted until they do —
                        a registration nobody can produce evidence for is not one you can
                        claim against.
                      </Withheld>
                    ) : null,
                  },
                  {
                    label: 'missing before this can be submitted',
                    value: r.missingData.length ? r.missingData.join(', ') : null,
                  },
                  { label: 'responsible', value: r.tech },
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

        <Panel title="the states, and what each one means" className="ws-panel--quiet">
          <dl className="ws-facts">
            <div className="ws-facts__row">
              <dt>data needed</dt>
              <dd>a serial, model or manufacturer is missing. nothing can be submitted without it.</dd>
            </div>
            <div className="ws-facts__row">
              <dt>ready to register</dt>
              <dd>everything needed is on file and the submission has not gone in yet.</dd>
            </div>
            <div className="ws-facts__row">
              <dt>submitted</dt>
              <dd>sent to the manufacturer, waiting on their confirmation.</dd>
            </div>
            <div className="ws-facts__row">
              <dt>deadline approaching</dt>
              <dd>
                inside {records[0]?.deadlineWarnDays ?? 14} days of the manufacturer's registration
                window closing.
              </dd>
            </div>
            <div className="ws-facts__row">
              <dt>blocked</dt>
              <dd>
                something is stopping it — an unreadable serial plate, a portal rejection, a
                jurisdiction we do not have a route into. the reason is on the row.
              </dd>
            </div>
            <div className="ws-facts__row">
              <dt>confirmed</dt>
              <dd>
                the manufacturer confirmed it and we are holding the confirmation number and
                the certificate. this is the only state that means the warranty is safe.
              </dd>
            </div>
            <div className="ws-facts__row">
              <dt>not required</dt>
              <dd>this equipment carries no registration requirement.</dd>
            </div>
          </dl>
        </Panel>
      </>
    </ModuleGate>
  );
}
