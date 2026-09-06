/* the shared vocabulary. every other portal module builds on these. */

export const EVENT_TYPES = [
  // business events, client-facing
  'lead_received',
  'call_missed',
  'sms_sent',
  'routed',
  'reply_received',
  // verification events, internal. never shown in the client feed.
  'canary_expectation',
  'canary_check',
  'watermark_check',
  'schema_assert',
];

export const CLIENT_VISIBLE_EVENT_TYPES = [
  'lead_received',
  'call_missed',
  'sms_sent',
  'routed',
  'reply_received',
];
