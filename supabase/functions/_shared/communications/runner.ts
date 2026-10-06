/**
 * ARC-370 — ARC's in-process runner for `send_message`: one message, through one channel.
 *
 * A runner moves authorised work (ARC-210). By the time `dispatch` is called the scheduler
 * has claimed the action, re-read its gate — run, tenant, lifecycle, health, connection —
 * and recorded the attempt as started. What the queue cannot know is whether THIS address
 * may still be written to, so the first thing this runner does is ask: `beginSend` is
 * 0026's `crm_message_begin_send`, which re-reads the do-not-contact list, the consent
 * evidence and Lead Recovery's own state under the message's lock. A STOP that arrived a
 * second ago stops the send here, and the message says why.
 *
 * It holds no credential (the channel gateway resolves one inside ARC-130 for the one call),
 * decides nothing (the two gates did), and writes no state of its own: what happened to the
 * message is recorded by 0026's `crm_message_finish_send`, under that function's rules.
 *
 * What it reports is deliberately narrow:
 *
 *   skipped                      the gate stopped it, or it was already settled. Nothing left.
 *   succeeded                    the provider took it and gave an id.
 *   failed, retryable            it provably did not leave, and later may work.
 *   failed                       it provably did not leave.
 *   failed, ambiguous            it may have left. The scheduler blocks the action for a
 *                                person, and nothing resends it.
 *
 * Anything it does not understand is thrown, and `classifyFailure` gives the contract's safe
 * answer: an effect was possible.
 */

import {
  type AutomationRunner,
  type RunnerCapabilities,
  type RunnerExecutionStatus,
  type RunnerFailure,
  type RunnerRequest,
  runnerRequestProblem,
  type RunnerResult,
} from '../runner/model.ts';
import { type ChannelGateway, ChannelSendError } from './channels.ts';
import { type Channel, isChannel } from './model.ts';

export const MESSAGE_SEND_ACTION = 'send_message';
export const MESSAGE_SEND_RUNNER = 'arc_message_sender';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What `crm_message_begin_send` answers. */
export type BeginSend =
  | { proceed: true; message_id: string; channel: string; address: string; body: string; connection_id: string | null; connector_key: string | null }
  | { proceed: false; code: string; detail?: string | null; status?: string };

/** The two writes around a send. Both are SQL functions that re-check everything themselves. */
export interface MessageSendStore {
  beginSend(tenantId: string, messageId: string, attemptId: string): Promise<BeginSend>;
  finishSend(
    tenantId: string, messageId: string,
    outcome: 'sent' | 'retry' | 'failed' | 'unknown',
    detail: { externalId?: string | null; code?: string | null; message?: string | null },
  ): Promise<{ recorded: boolean; status: string }>;
}

export class MessageSendRunner implements AutomationRunner {
  readonly kind = MESSAGE_SEND_RUNNER;
  private readonly executions = new Map<string, RunnerExecutionStatus['state']>();
  private readonly store: MessageSendStore;
  private readonly gateway: ChannelGateway;

  constructor(deps: { store: MessageSendStore; gateway: ChannelGateway }) {
    this.store = deps.store;
    this.gateway = deps.gateway;
  }

  describeCapabilities(): RunnerCapabilities {
    return Object.freeze({ actionTypes: Object.freeze([MESSAGE_SEND_ACTION]), runModes: Object.freeze(['live' as const]) });
  }

  async dispatch(request: RunnerRequest, _signal: AbortSignal): Promise<RunnerResult> {
    const messageId = typeof request.payload?.message_id === 'string' ? request.payload.message_id : '';
    const problem = runnerRequestProblem(request)
      ?? (request.actionType !== MESSAGE_SEND_ACTION ? `${request.actionType} is not a message send` : null)
      ?? (request.runMode !== 'live' ? 'a message is sent by a live run only' : null)
      ?? (!UUID.test(messageId) ? 'a message send names its message' : null)
      ?? (!request.connection?.connectionId ? 'a message send names its connection' : null);
    const executionId = `${this.kind}:${request.attemptId}`;
    const base = {
      retryable: false, ambiguous: false, errorCode: null, message: null, evidence: {}, evidenceRef: null,
      externalRequestId: null, runnerExecutionId: executionId,
    };
    if (problem) {
      this.executions.set(executionId, 'failed');
      return { ...base, status: 'failed', errorCode: 'runner_request_refused', message: problem };
    }

    this.executions.set(executionId, 'running');

    /* 1. re-read: may this address still be written to. nothing has left yet. */
    const begin = await this.store.beginSend(request.tenantId, messageId, request.attemptId);
    if (!begin.proceed) {
      this.executions.set(executionId, 'cancelled');
      return { ...base, status: 'skipped', errorCode: begin.code, message: begin.detail ?? null, evidence: { message_id: messageId, stopped_by: begin.code } };
    }
    const evidence = { message_id: messageId, channel: begin.channel, connector_key: request.connection!.connectorKey };

    /* the action and the message were queued together with one connection. if they disagree,
       something rewrote one of them — refuse, having sent nothing. */
    if (!isChannel(begin.channel) || begin.connection_id !== request.connection!.connectionId) {
      await this.store.finishSend(request.tenantId, messageId, 'failed', { code: 'connection_mismatch', message: 'the message and its action name different connections' });
      this.executions.set(executionId, 'failed');
      return { ...base, status: 'failed', errorCode: 'connection_mismatch', message: 'the message and its action name different connections', evidence };
    }

    /* 2. the send. */
    let providerMessageId: string;
    try {
      const sent = await this.gateway.send({
        tenantId: request.tenantId,
        connectionId: request.connection!.connectionId,
        connectorKey: request.connection!.connectorKey ?? begin.connector_key ?? '',
        channel: begin.channel as Channel,
        to: begin.address,
        body: begin.body,
        idempotencyKey: request.idempotencyKey,
        correlationId: request.correlationId,
      });
      providerMessageId = sent.providerMessageId;
    } catch (error) {
      if (!(error instanceof ChannelSendError)) throw error;
      const message = error.message && error.message !== error.code ? error.message.slice(0, 300) : null;
      if (error.left === 'unknown') {
        await this.store.finishSend(request.tenantId, messageId, 'unknown', { code: error.code, message });
        this.executions.set(executionId, 'unknown');
        return { ...base, status: 'failed', ambiguous: true, errorCode: error.code, message: 'the provider did not say whether it took the message', evidence };
      }
      await this.store.finishSend(request.tenantId, messageId, error.retryable ? 'retry' : 'failed', { code: error.code, message });
      this.executions.set(executionId, 'failed');
      return { ...base, status: 'failed', retryable: error.retryable, errorCode: error.code, message, evidence };
    }

    /* 3. record it. if this write fails the message did leave, and the exception escaping
       here is classified as "an effect was possible" — ambiguous, never resent. */
    await this.store.finishSend(request.tenantId, messageId, 'sent', { externalId: providerMessageId });
    this.executions.set(executionId, 'succeeded');
    return { ...base, status: 'succeeded', externalRequestId: providerMessageId, evidence: { ...evidence, provider_message_id: providerMessageId } };
  }

  classifyFailure(error: unknown): RunnerFailure {
    /* dispatch returns every failure it understands. what reaches here is not understood —
       and it may be the record of a send that did happen. */
    return { errorCode: error instanceof ChannelSendError ? error.code : 'runner_error', retryable: false, effectPossible: true };
  }

  // deno-lint-ignore require-await
  async queryStatus(runnerExecutionId: string): Promise<RunnerExecutionStatus> {
    const state = this.executions.get(runnerExecutionId);
    return { runnerExecutionId, known: state !== undefined, state: state ?? 'unknown' };
  }

  /** A message handed to a provider cannot be called back; ARC's own cancellation still stands. */
  // deno-lint-ignore require-await
  async requestCancellation(_request: RunnerRequest): Promise<{ acknowledged: boolean }> {
    return { acknowledged: false };
  }
}
