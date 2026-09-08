/* generates the public demo dashboard as a small json file, run before every build.
 *
 * two things this buys. first, size: the generator produces ~6,400 events and the portal
 * renders a bounded slice of them, so only the computed dashboard ships — the same mistake
 * in the old repo put 3.26MB on the wire for a dozen visible rows. second, freshness: the
 * demo is anchored to the moment it is generated, so regenerating on every deploy stops
 * "leads this month" from drifting toward zero as the calendar moves away from the last run.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DateTime } from 'luxon';
import { generateDemoData } from '../src/portal/demo/generate.js';
import { buildDashboardData } from '../src/portal/lib/dashboard-data.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'src', 'portal', 'demo');
const outFile = join(outDir, 'demo-data.json');

const { tenant, events, alerts } = generateDemoData();
const data = buildDashboardData(tenant, events, DateTime.now().setZone(tenant.timezone), alerts);

mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, JSON.stringify({ ...data, generatedAt: new Date().toISOString() }, null, 2));

const kb = (JSON.stringify(data).length / 1024).toFixed(1);
console.log(
  `  demo data: ${events.length} events computed down to ${data.threads.length} threads, ` +
    `${data.automations.length} automations, ${data.incidents.length} incidents (${kb}kb)`,
);
