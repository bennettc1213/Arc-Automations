/**
 * ARC-370 — what the two doors (`ops`, `crm`) hand the conversation actions, built once so
 * the operator's console and a client's dashboard cannot be wired differently.
 *
 * Nothing here reads the environment: the function that calls it passes what it read, the
 * same values the `connections` function and ARC-320's connection test use — the same
 * environment rule (unset = production), the same credential store (Vault, or nothing).
 *
 * The gateway is ARC-130's credential path around `PRODUCTION_CHANNEL_ADAPTERS`. That list is
 * empty today, so `serves()` answers no, the route says there is no channel, and no credential
 * store is ever asked for anything. When a provider's adapter is registered, this file does
 * not change.
 */

import { fetchTransport } from '../connections/adapter.ts';
import { selectCredentialStore } from '../connections/credential-store.ts';
import { SecretValue } from '../connections/redact.ts';
import type { RuntimeEnvironment } from '../connections/runtime-env.ts';
import { SupabaseVaultCredentialStore } from '../connections/supabase-connection-store.ts';
import { supabaseSchedulerStore } from '../scheduler/supabase-scheduler-store.ts';
import { supabaseStore } from '../supabase-store.ts';
import { connectionChannelGateway, PRODUCTION_CHANNEL_ADAPTERS } from './channels.ts';
import type { CommunicationsStore, SendingDeps } from './service.ts';
import { supabaseCommunicationsStore } from './supabase-communications-store.ts';

export interface ConversationWiring {
  environment: RuntimeEnvironment;
  siteUrl: string | null;
  oauthRedirectUrl: string | null;
  /** reads one server environment variable by name, or undefined. */
  env(name: string): string | undefined;
  /** names the lease holder on every claim this door makes. */
  worker: string;
}

// deno-lint-ignore no-explicit-any
export function conversationDeps(db: any, wiring: ConversationWiring): { comms: CommunicationsStore; sending: SendingDeps } {
  const engine = supabaseStore(db);
  const credentials = selectCredentialStore({
    environment: wiring.environment,
    vault: () => new SupabaseVaultCredentialStore(db, { environment: wiring.environment }),
  });
  const gateway = connectionChannelGateway({
    store: { ...engine, credentials },
    transport: fetchTransport(),
    environment: wiring.environment,
    lifecycle: engine,
    oauth: {
      siteUrl: wiring.siteUrl,
      redirectUrl: wiring.oauthRedirectUrl,
      clientCredentials: (oauth) => {
        const clientId = wiring.env(oauth.clientIdEnv) ?? '';
        const clientSecret = wiring.env(oauth.clientSecretEnv) ?? '';
        return clientId && clientSecret ? { clientId, clientSecret: new SecretValue(clientSecret) } : null;
      },
    },
  }, PRODUCTION_CHANNEL_ADAPTERS);
  return {
    comms: supabaseCommunicationsStore(db),
    sending: { engine, scheduler: supabaseSchedulerStore(db), gateway, worker: wiring.worker },
  };
}
