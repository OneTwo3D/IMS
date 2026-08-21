import { deserializeSettingValue } from '@/lib/settings-store'
import type { ConnectorCredentials } from '../types'
import { validateWooCommerceBaseUrl } from './url-safety'

/**
 * THE resolver for WooCommerce API credentials (o3d-ecbj).
 *
 * There are two ways credentials reach `wcFetch`/`wcPost`/`wcPut`:
 *
 *   - `getWcCredentials()` (api.ts), used by the order import, the FX push, the
 *     partial-shipment push, links.ts, delivery.ts and every bare call that passes no
 *     `creds` argument; and
 *   - the advisory-lock SNAPSHOTS in `sync/stock-sync.ts` and `sync/product-sync.ts`,
 *     which must read the credentials and `wc_settings_version` together inside ONE
 *     locked transaction (o3d-mlc7) and therefore cannot go through `getSettingValues`.
 *
 * Those two built their credentials independently, and diverged: `getSettingValues`
 * PREFERS the environment, so with `WC_CONSUMER_KEY`/`WC_CONSUMER_SECRET` in
 * `SETTING_ENV_FALLBACKS` an installation with a stale secret in `.env` imported orders
 * under the environment's credential and pushed stock under the database's, with no error
 * on either side. The environment override has been removed (see the note in
 * `lib/settings-store.ts`; `scripts/provision-instance.mjs` now SEEDS the rows instead),
 * and both paths now build their credentials HERE so they cannot drift apart again.
 *
 * This module owns exactly three decisions — which settings keys are the credentials,
 * whether they are configured, and what a valid/normalised store URL is. It deliberately
 * does NOT read the database: the snapshot callers must read through their own transaction
 * client, so the read stays theirs and only the interpretation is shared.
 */
export const WC_CREDENTIAL_SETTING_KEYS = ['wc_url', 'wc_consumer_key', 'wc_consumer_secret'] as const

export type WcCredentialSettingKey = typeof WC_CREDENTIAL_SETTING_KEYS[number]

export type WcCredentialResolution =
  | { ok: true; credentials: ConnectorCredentials }
  /** One or more of the three settings is absent or empty — the connector is not set up. */
  | { ok: false; reason: 'not_configured' }
  /** All three are present but `wc_url` failed the SSRF/base-URL check. */
  | { ok: false; reason: 'invalid_url'; error: string }

type WcCredentialPlaintext = {
  url?: string | null
  key?: string | null
  secret?: string | null
}

/**
 * Turn raw `settings` ROWS into the plaintext trio.
 *
 * `wc_consumer_secret` is a SENSITIVE_SETTING_KEY, so the stored value may be ciphertext;
 * `deserializeSettingValue` is the same decryption the settings store applies on its own
 * reads, which is what keeps a snapshot's view identical to `getSettingValues`'.
 */
export function readWcCredentialSettingRows(
  rows: Iterable<{ key: string; value: string }>,
): WcCredentialPlaintext {
  const raw = new Map<string, string>()
  for (const row of rows) raw.set(row.key, row.value)
  const read = (key: WcCredentialSettingKey) => {
    const value = raw.get(key)
    return value === undefined ? undefined : deserializeSettingValue(key, value)
  }
  return { url: read('wc_url'), key: read('wc_consumer_key'), secret: read('wc_consumer_secret') }
}

/**
 * Build `ConnectorCredentials` from the three plaintext values.
 *
 * An empty string counts as absent, matching what `getSettingValues` yields for a row that
 * was never written — a half-configured connector must be `not_configured`, never a request
 * to WooCommerce with an empty Basic auth pair.
 */
export function resolveWcCredentials(values: WcCredentialPlaintext): WcCredentialResolution {
  const url = values.url ?? ''
  const key = values.key ?? ''
  const secret = values.secret ?? ''
  if (!url || !key || !secret) return { ok: false, reason: 'not_configured' }

  const validated = validateWooCommerceBaseUrl(url)
  if (!validated.ok) return { ok: false, reason: 'invalid_url', error: validated.error }

  return { ok: true, credentials: { url: validated.normalizedUrl, key, secret } }
}

/**
 * The snapshot form: rows in, credentials or `null` out.
 *
 * The snapshots treat an unusable URL exactly like an unconfigured connector — they run
 * inside an advisory-lock transaction where throwing would abort the lock and the caller
 * reports "WooCommerce not configured" either way. `getWcCredentials` keeps its own
 * behaviour of THROWING the URL error, because it is the interactive path where the operator
 * needs to be told what is wrong with the URL they typed.
 */
export function resolveWcCredentialsFromRows(
  rows: Iterable<{ key: string; value: string }>,
): ConnectorCredentials | null {
  const resolution = resolveWcCredentials(readWcCredentialSettingRows(rows))
  return resolution.ok ? resolution.credentials : null
}
