/**
 * ARC-370 — channels: how a message leaves ARC, and what ARC may say about whether it did.
 *
 * A channel adapter is the provider-specific half of a send: given a credential ARC-130
 * resolved for this one call and a transport fenced to the provider's registered hosts, hand
 * one message over and return the provider's id for it. It never sees the connection row,
 * never chooses the recipient, and never decides whether the message may be sent — by the
 * time it is called the queue's gate (0017) and the message's own (`crm_message_begin_send`)
 * have both been re-read.
 *
 * The only thing an adapter is trusted to know that nobody else can: **did it leave?**
 *
 *   `left: 'no'`       the provider refused it, or nothing was ever sent to it. Safe to say
 *                      "failed" — and, when `retryable`, safe to try again.
 *   `left: 'unknown'`  a request went out and no clear answer came back. Nothing resends it.
 *
 * Anything an adapter throws that is not a `ChannelSendError` is treated as unknown.
 *
 * **There are no production adapters yet**, and that is the honest state of the registry:
 * Twilio is ARC's own platform account (`arc_managed`), so no client has a messaging
 * connection of their own, and every other messaging provider is still `planned`. A send
 * through ARC's Twilio is a Lead Recovery provider action and belongs to its later prompts.
 * Until an adapter is registered here with its connector, the conversation screen says there
 * is no channel to send through — it does not pretend to queue something that cannot leave.
 * Tests use `synthetic-channel.ts`, on the synthetic connector's `.invalid` host.
 */

import { ConnectionError } from '../connections/model.ts';
import { type ConnectionServiceDeps, type CredentialUse, withProviderCredential } from '../connections/service.ts';
import type { Channel } from './model.ts';

export class ChannelSendError extends Error {
  readonly code: string;
  /** whether the message can have left ARC. */
  readonly left: 'no' | 'unknown';
  /** only meaningful with `left: 'no'`: trying again later is the right answer. */
  readonly retryable: boolean;
  constructor(code: string, left: 'no' | 'unknown', options: { retryable?: boolean; message?: string } = {}) {
    super(options.message ?? code);
    this.name = 'ChannelSendError';
    this.code = code;
    this.left = left;
    this.retryable = left === 'no' && options.retryable === true;
  }
}

export interface ChannelMessage {
  to: string;
  body: string;
  /** stable across every retry of this message: the key a provider dedupes on, where it can. */
  idempotencyKey: string;
}

export interface ChannelAdapter {
  /** the registry connector this adapter sends through. */
  readonly connectorKey: string;
  readonly channel: Channel;
  /** the capability the connection must have verified (`registry/capabilities.ts`). */
  readonly capability: string;
  send(use: CredentialUse, message: ChannelMessage): Promise<{ providerMessageId: string }>;
}

/** A real provider's adapter is added here, with its registry connector version. */
export const PRODUCTION_CHANNEL_ADAPTERS: readonly ChannelAdapter[] = Object.freeze([]);

export interface ChannelSendRequest extends ChannelMessage {
  tenantId: string;
  connectionId: string;
  connectorKey: string;
  channel: Channel;
  correlationId: string;
}

export interface ChannelGateway {
  /** can this runtime send on this channel through this connector. */
  serves(connectorKey: string, channel: Channel): boolean;
  send(request: ChannelSendRequest): Promise<{ providerMessageId: string }>;
}

/** Connection trouble that says nothing about the message: nothing left, and later may work. */
const TRANSIENT = new Set(['provider_unavailable', 'refresh_in_progress', 'rate_limited', 'vault_unavailable']);

/**
 * The gateway every environment uses: ARC-130's `withProviderCredential` — the only way to
 * hold a credential — around the connector's adapter. A failure before the credential was
 * handed to the adapter cannot have sent anything; any failure after it that the adapter did
 * not explain is unknown.
 */
export function connectionChannelGateway(connections: ConnectionServiceDeps, adapters: readonly ChannelAdapter[]): ChannelGateway {
  const find = (connectorKey: string, channel: Channel) => adapters.find((a) => a.connectorKey === connectorKey && a.channel === channel) ?? null;
  return {
    serves: (connectorKey, channel) => find(connectorKey, channel) !== null,
    async send(request) {
      const adapter = find(request.connectorKey, request.channel);
      if (!adapter) throw new ChannelSendError('channel_adapter_missing', 'no', { message: `nothing in this runtime sends ${request.channel} through ${request.connectorKey}` });
      let handed = false;
      try {
        const sent = await withProviderCredential(connections, {
          tenantId: request.tenantId,
          connectionId: request.connectionId,
          capability: adapter.capability,
          correlationId: request.correlationId,
        }, async (use) => {
          handed = true;
          return await adapter.send(use, { to: request.to, body: request.body, idempotencyKey: request.idempotencyKey });
        });
        if (!sent || typeof sent.providerMessageId !== 'string' || !sent.providerMessageId.trim()) {
          throw new ChannelSendError('provider_reply_unreadable', 'unknown');
        }
        return { providerMessageId: sent.providerMessageId.trim().slice(0, 200) };
      } catch (error) {
        if (error instanceof ChannelSendError) throw error;
        if (!handed) {
          /* ARC's own code and sentence: a provider's body never reaches a ConnectionError. */
          const code = error instanceof ConnectionError ? error.code : 'connection_unavailable';
          throw new ChannelSendError(code, 'no', { retryable: TRANSIENT.has(code), message: error instanceof ConnectionError ? error.message.slice(0, 300) : undefined });
        }
        throw new ChannelSendError('provider_outcome_unknown', 'unknown');
      }
    },
  };
}
