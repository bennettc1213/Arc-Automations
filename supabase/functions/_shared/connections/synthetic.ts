/**
 * ARC-130 — synthetic providers for automated tests. NEVER production.
 *
 * Two connectors that exist nowhere but here, on `.invalid` hosts (RFC 2606: guaranteed
 * never to resolve), served by an in-process transport the tests own
 * (`tests/synthetic-provider.js`). `syntheticCatalog()` refuses to build unless the
 * runtime environment is explicitly development or test (runtime-env.ts), and nothing in
 * a deployed function imports this file.
 *
 *   synthetic_oauth     OAuth 2.0 + PKCE S256 + OIDC, rotating refresh tokens. Provides
 *                       `send_sms` and `receive_sms`, so a Lead Recovery requirement group
 *                       can be satisfied through a tenant connection — the only way to
 *                       prove ARC-120 integration while every real tenant provider is
 *                       still `planned`.
 *   synthetic_api_key   a write-only API key, verified by a provider call. Provides
 *                       `classify_text`.
 */

import { CONNECTORS, type ConnectorDefinition, type ConnectorVersion, validateTenantConnectionSpec } from '../registry/connectors.ts';
import { assertKnownCapabilities } from '../registry/capabilities.ts';
import { oauth2Adapter, type ProviderAdapter, type ProviderTransport } from './adapter.ts';
import { catalogOver, type ConnectorCatalog } from './catalog.ts';
import { ConnectionError } from './model.ts';
import { assertTestDoubleAllowed, type RuntimeEnvironment } from './runtime-env.ts';

export const SYNTHETIC_OAUTH_HOST = 'synthetic-oauth.invalid';
export const SYNTHETIC_KEYS_HOST = 'synthetic-keys.invalid';

export const SYNTHETIC_CONNECTORS: readonly ConnectorDefinition[] = Object.freeze([
  {
    key: 'synthetic_oauth',
    displayName: 'Synthetic OAuth provider (tests only)',
    category: 'messaging',
    status: 'available',
    description: 'A deterministic OAuth 2.0 / OIDC provider that exists only inside the test suite.',
    versions: [
      {
        connectorKey: 'synthetic_oauth',
        version: 1,
        status: 'available',
        capabilities: ['send_sms', 'receive_sms'],
        auth: { type: 'oauth2', owner: 'tenant', supportsReauthorization: true, expectsRefreshToken: true },
        behaviour: {
          webhookSignature: 'none',
          healthCheck: 'provider_api',
          tokenRefresh: 'automatic',
          rateLimit: null,
          supportsReconciliation: false,
          supportsIdempotencyKey: true,
        },
        connection: {
          adapter: 'oauth2_generic',
          reusableAcrossModules: true,
          verification: { identity: 'required', capabilities: 'scopes_only' },
          freshness: { reverifyAfterHours: 24, refreshSkewSeconds: 300 },
          safeMetadataFields: ['workspace'],
          apiHosts: [SYNTHETIC_OAUTH_HOST],
          oauth: {
            authorizationEndpoint: `https://${SYNTHETIC_OAUTH_HOST}/authorize`,
            tokenEndpoint: `https://${SYNTHETIC_OAUTH_HOST}/token`,
            revocationEndpoint: `https://${SYNTHETIC_OAUTH_HOST}/revoke`,
            userinfoEndpoint: `https://${SYNTHETIC_OAUTH_HOST}/userinfo`,
            issuer: `https://${SYNTHETIC_OAUTH_HOST}`,
            jwksEndpoint: `https://${SYNTHETIC_OAUTH_HOST}/jwks`,
            oidc: true,
            pkce: 'S256',
            clientAuth: 'client_secret_basic',
            scopeSeparator: ' ',
            baseScopes: ['openid', 'account.read'],
            capabilityScopes: { send_sms: ['messages.write'], receive_sms: ['messages.read'] },
            clientIdEnv: 'SYNTHETIC_OAUTH_CLIENT_ID',
            clientSecretEnv: 'SYNTHETIC_OAUTH_CLIENT_SECRET',
            extraAuthorizationParams: { access_type: 'offline', prompt: 'consent' },
          },
        },
      },
    ],
  },
  {
    key: 'synthetic_api_key',
    displayName: 'Synthetic API-key provider (tests only)',
    category: 'ai',
    status: 'available',
    description: 'A deterministic API-key provider that exists only inside the test suite.',
    versions: [
      {
        connectorKey: 'synthetic_api_key',
        version: 1,
        status: 'available',
        capabilities: ['classify_text'],
        auth: { type: 'api_key', owner: 'tenant', supportsReauthorization: true, expectsRefreshToken: false },
        behaviour: {
          webhookSignature: 'none',
          healthCheck: 'provider_api',
          tokenRefresh: 'not_applicable',
          rateLimit: null,
          supportsReconciliation: false,
          supportsIdempotencyKey: false,
        },
        connection: {
          adapter: 'synthetic_api_key',
          reusableAcrossModules: true,
          verification: { identity: 'required', capabilities: 'provider_check' },
          freshness: { reverifyAfterHours: 24, refreshSkewSeconds: 0 },
          safeMetadataFields: ['workspace'],
          apiHosts: [SYNTHETIC_KEYS_HOST],
          credentialFields: [
            { name: 'api_key', pattern: '^syn_[a-z0-9]{32}$', minLength: 36, maxLength: 36, hintSafe: true },
          ],
        },
      },
    ],
  },
] as ConnectorDefinition[]);

/** The synthetic API-key adapter: `GET /whoami` with the key, and nothing else. */
export const syntheticApiKeyAdapter: ProviderAdapter = Object.freeze({
  key: 'synthetic_api_key',
  authMethods: ['api_key'] as const,
  authorizationUrl() { throw new ConnectionError('unsupported_auth_method', 'an API-key provider has no authorisation URL'); },
  // deno-lint-ignore require-await
  async exchangeCode() { throw new ConnectionError('unsupported_auth_method', 'an API-key provider has no authorisation code'); },
  // deno-lint-ignore require-await
  async refresh() { throw new ConnectionError('unsupported_auth_method', 'an API key is not refreshed'); },
  // deno-lint-ignore require-await
  async revoke() { return 'unsupported' as const; },
  // deno-lint-ignore require-await
  async identity() { throw new ConnectionError('unsupported_auth_method', 'use verifyApiKey'); },
  normalizeScopes() { return []; },
  // deno-lint-ignore require-await
  async verifyCapabilities() { return []; },
  async verifyApiKey(version: ConnectorVersion, input: Parameters<ProviderAdapter['verifyApiKey']>[1], transport: ProviderTransport) {
    const response = await transport({
      method: 'GET',
      url: `https://${SYNTHETIC_KEYS_HOST}/whoami`,
      headers: { Authorization: `Bearer ${input.fields.reveal().api_key}` },
    });
    if (response.status === 429 || response.status >= 500) throw new ConnectionError('provider_unavailable', 'the provider is unavailable');
    if (response.status === 401 || response.status === 403) throw new ConnectionError('invalid_credential', 'the provider did not accept this key');
    const body = response.body && typeof response.body === 'object' ? response.body as Record<string, unknown> : {};
    const accountId = typeof body.account_id === 'string' ? body.account_id : null;
    if (response.status !== 200 || !accountId) throw new ConnectionError('account_mismatch', 'the provider would not say whose key this is');
    const capabilities = Array.isArray(body.capabilities)
      ? version.capabilities.filter((c) => (body.capabilities as unknown[]).includes(c))
      : [];
    const metadata: Record<string, string> = {};
    if (typeof body.workspace === 'string') metadata.workspace = body.workspace;
    return {
      identity: { accountId, label: typeof body.workspace === 'string' ? body.workspace : null, metadata },
      capabilities,
    };
  },
} satisfies ProviderAdapter);

/**
 * The registry plus the synthetic providers. Throws `environment_forbidden` anywhere that
 * could be production (including an unset environment).
 */
export function syntheticCatalog(environment: RuntimeEnvironment): ConnectorCatalog {
  assertTestDoubleAllowed(environment, 'the synthetic provider catalog');
  for (const connector of SYNTHETIC_CONNECTORS) {
    if (CONNECTORS.some((c) => c.key === connector.key)) throw new Error(`${connector.key} collides with a registry connector`);
    for (const version of connector.versions) {
      assertKnownCapabilities(version.capabilities, `synthetic ${connector.key}@${version.version}`);
      validateTenantConnectionSpec(version);
    }
  }
  const all = [...CONNECTORS, ...SYNTHETIC_CONNECTORS];
  return catalogOver(
    'synthetic',
    (key) => all.find((c) => c.key === key)?.versions ?? [],
    () => all.flatMap((c) => c.versions),
    { [oauth2Adapter.key]: oauth2Adapter, [syntheticApiKeyAdapter.key]: syntheticApiKeyAdapter },
  );
}
