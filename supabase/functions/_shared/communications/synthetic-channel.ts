/**
 * ARC-370 — a text-message adapter for the synthetic provider. NEVER production.
 *
 * `synthetic_oauth` (connections/synthetic.ts) is the one tenant-connected provider with
 * `send_sms`, and it exists only inside the test suite, on a `.invalid` host that cannot
 * resolve. This adapter is how the suite proves a message travels the whole way — queue,
 * gate, credential, transport, provider id, delivery report — while every real messaging
 * provider is still `planned`. Building it throws unless the environment says, in so many
 * words, that this is development or test, and nothing in a deployed function imports it.
 */

import { SYNTHETIC_OAUTH_HOST } from '../connections/synthetic.ts';
import { assertTestDoubleAllowed, type RuntimeEnvironment } from '../connections/runtime-env.ts';
import { type ChannelAdapter, ChannelSendError } from './channels.ts';

export function syntheticSmsAdapter(environment: RuntimeEnvironment): ChannelAdapter {
  assertTestDoubleAllowed(environment, 'the synthetic text-message adapter');
  return Object.freeze({
    connectorKey: 'synthetic_oauth',
    channel: 'sms' as const,
    capability: 'send_sms',
    async send(use, message) {
      if (!use.token) throw new ChannelSendError('credential_unavailable', 'no');
      let response;
      try {
        response = await use.transport({
          method: 'POST',
          url: `https://${SYNTHETIC_OAUTH_HOST}/messages`,
          headers: { Authorization: `Bearer ${use.token.reveal()}`, 'Idempotency-Key': message.idempotencyKey },
          form: { to: message.to, body: message.body },
        });
      } catch {
        /* the request was on its way: a timeout or a dropped connection says nothing. */
        throw new ChannelSendError('provider_outcome_unknown', 'unknown');
      }
      if (response.status === 429) throw new ChannelSendError('rate_limited', 'no', { retryable: true });
      if (response.status === 401 || response.status === 403) throw new ChannelSendError('reauthorization_required', 'no');
      if (response.status >= 400 && response.status < 500) throw new ChannelSendError('provider_refused', 'no');
      const body = response.body && typeof response.body === 'object' ? response.body as Record<string, unknown> : {};
      if (response.status >= 500 || typeof body.id !== 'string' || !body.id) throw new ChannelSendError('provider_outcome_unknown', 'unknown');
      return { providerMessageId: body.id };
    },
  } satisfies ChannelAdapter);
}
