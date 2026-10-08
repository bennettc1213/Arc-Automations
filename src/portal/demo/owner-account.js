/* ARC-MK-200 — the demo's account screen: written example settings for the made-up company.
 *
 * built through the same `accountSettingsView` a signed-in client's settings come through,
 * from a configuration-shaped example and a few example stop-list rows. so the demo shows
 * exactly the fields a real account shows — a field the projection leaves out cannot be
 * typed in here — and the addresses arrive as hints, the way they do from the server.
 *
 * the numbers are fictional: 555-01xx is reserved for examples and reaches nobody.
 */

import { accountSettingsView } from '../../../supabase/functions/_shared/account/model.ts';

const WEEKDAY = [{ open: '07:30', close: '17:00' }];

const EXAMPLE_CONFIG = {
  timezone: 'America/New_York',
  business_hours: {
    mon: WEEKDAY,
    tue: WEEKDAY,
    wed: WEEKDAY,
    thu: WEEKDAY,
    fri: WEEKDAY,
    sat: [{ open: '08:00', close: '12:00' }],
    sun: [],
  },
  service_area: {
    zips: ['43085', '43202', '43214', '43221'],
    cities: ['Columbus', 'Worthington', 'Upper Arlington'],
    note: null,
  },
  staff_alerts: [
    { name: 'Dana (owner)', channel: 'sms', address: '+16145550188' },
    { name: 'office', channel: 'email', address: 'office@halstead.example' },
  ],
  after_hours: { behaviour: 'after_hours_response', callback_window: 'first thing in the morning' },
};

const EXAMPLE_STOP_LIST = [
  { channel: 'sms', address: '+16145550142', reason: 'opt_out', created_at: null },
  { channel: 'sms', address: '+16145550117', reason: 'wrong_contact', created_at: null },
];

export function buildDemoAccountSettings() {
  return accountSettingsView(EXAMPLE_CONFIG, EXAMPLE_STOP_LIST);
}
