/**
 * THE STOREFRONT CREDENTIALS, READ FOR THE VENDOR TRANSPORT AND NOTHING ELSE.
 *
 * Only when a run was started with --vendor-reads-only, and only on the first request. Three settings rows are read in a READ ONLY
 * REPEATABLE READ transaction on a connection the command already opened (never the application's client: lib/settings-store
 * imports it, and its reader also migrates rows, which is a write). The consumer key and secret are decrypted with the same helper
 * the settings store uses (lib/security/encrypted-settings, which has no database in it); the URL goes through the same base-URL
 * validator the connector uses. Anything missing, repeated, undecryptable or unsafe is `null`: no request is made on a guess.
 * Nothing here is ever returned in text: the result is an object handed to the transport and to nothing else.
 */

import { WOO_CREDENTIAL_SETTING_KEYS } from '@/lib/reconciliation-pack/constants'
import type { ImsQueryClient } from '@/lib/reconciliation-pack/ims-readers'
import { decryptSettingValue } from '@/lib/security/encrypted-settings'
import { validateExternalBaseUrl } from '@/lib/security/external-url-safety'

export type WooCredentials = { baseUrl: string; key: string; secret: string }

const SENSITIVE: ReadonlySet<string> = new Set(['wc_consumer_key', 'wc_consumer_secret'])

export async function readWooCredentials(client: ImsQueryClient, env: Readonly<Record<string, string | undefined>> = process.env): Promise<WooCredentials | null> {
  let open = false
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    open = true
    const mode = await client.query(`SELECT current_setting('transaction_read_only') AS read_only`)
    if (mode.rows.length !== 1 || mode.rows[0]!.read_only !== 'on') return null
    const read = await client.query('SELECT key, value FROM settings WHERE key = ANY($1::text[])', [[...WOO_CREDENTIAL_SETTING_KEYS]])
    const values = new Map<string, string>()
    for (const row of read.rows) {
      if (typeof row.key !== 'string' || typeof row.value !== 'string' || values.has(row.key) || !(WOO_CREDENTIAL_SETTING_KEYS as readonly string[]).includes(row.key)) return null
      values.set(row.key, SENSITIVE.has(row.key) ? decryptSettingValue(row.key, row.value) : row.value)
    }
    const url = values.get('wc_url')
    const key = values.get('wc_consumer_key')
    const secret = values.get('wc_consumer_secret')
    if (!url || !key || !secret) return null
    const validated = validateExternalBaseUrl(url, { connectorName: 'WooCommerce', allowE2eLocalHttp: true, env })
    if (!validated.ok) return null
    return { baseUrl: validated.normalizedUrl, key, secret }
  } catch {
    return null
  } finally {
    if (open) { try { await client.query('ROLLBACK') } catch { /* nothing was written; the caller closes the connection */ } }
  }
}
