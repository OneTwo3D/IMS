/**
 * THE STORED XERO CONNECTION, READ FOR THE VENDOR TRANSPORT AND NOTHING ELSE.
 *
 * Only when a run was started with --vendor-reads-only, and only on the first request. The access token is read from the connection's
 * token row in a READ ONLY REPEATABLE READ transaction on a connection the command already opened (never the application's client:
 * its token reader REFRESHES an expiring token, which writes the database and rotates the refresh token at Xero, and the pack writes
 * nothing anywhere). So the pack uses a token only while it is still current (at least XERO_TOKEN_MIN_REMAINING_MS to live); an expired
 * one is `null` and the item is inconclusive until the ordinary read-sync has refreshed it. The refresh token is never selected.
 *
 * The connection is judged by the tenant guard's own pure function (lib/connectors/xero/tenant-guard.ts storedXeroConnectionRefusal),
 * with the same inputs the connector gives it (the allow-list from the environment, the pin setting, the release witness, the row's
 * binding columns), so a connection the connector would refuse is a connection the pack refuses. Anything missing, repeated,
 * undecryptable or refused is `null`: no request is made on a guess. Nothing here is ever returned in text.
 *
 * `readXeroBinding` reads only the tenant and the connection generation, for the check at the END of a run that the connection
 * the walks were served by is still the one that is stored.
 */

import { XERO_TOKEN_MIN_REMAINING_MS } from '@/lib/reconciliation-pack/constants'
import type { ImsQueryClient } from '@/lib/reconciliation-pack/ims-readers'
import {
  parseXeroReleaseWitness, readXeroTenantAllowList, storedXeroConnectionRefusal,
  XERO_PIN_RELEASE_WITNESS_SETTING_KEY, XERO_TENANT_PIN_SETTING_KEY,
} from '@/lib/connectors/xero/tenant-guard'
import { decryptSecret } from '@/lib/secrets'

export type XeroAccess = { accessToken: string; tenantId: string; connectionGeneration: string | null }
export type XeroBinding = { tenantId: string; connectionGeneration: string | null }

const XERO_TENANT_RE = /^[0-9A-Za-z][0-9A-Za-z-]{0,63}$/

async function inReadOnlyTransaction<T>(client: ImsQueryClient, fn: () => Promise<T | null>): Promise<T | null> {
  let open = false
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    open = true
    const mode = await client.query(`SELECT current_setting('transaction_read_only') AS read_only`)
    if (mode.rows.length !== 1 || mode.rows[0]!.read_only !== 'on') return null
    return await fn()
  } catch {
    return null
  } finally {
    if (open) { try { await client.query('ROLLBACK') } catch { /* nothing was written; the caller closes the connection */ } }
  }
}

function binding(row: Record<string, unknown>): XeroBinding | null {
  if (typeof row.tenant !== 'string' || !XERO_TENANT_RE.test(row.tenant)) return null
  if (row.generation !== null && typeof row.generation !== 'string') return null
  return { tenantId: row.tenant, connectionGeneration: row.generation as string | null }
}

export async function readXeroBinding(client: ImsQueryClient): Promise<XeroBinding | null> {
  return await inReadOnlyTransaction(client, async () => {
    const rows = await client.query(`SELECT "tenantId" AS tenant, "connectionGeneration" AS generation FROM accounting_tokens WHERE connector = 'xero'`)
    return rows.rows.length === 1 ? binding(rows.rows[0]!) : null
  })
}

export async function readXeroAccess(client: ImsQueryClient, options: { now: Date; env?: Readonly<Record<string, string | undefined>> }): Promise<XeroAccess | null> {
  return await inReadOnlyTransaction(client, async () => {
    const tokens = await client.query(
      `SELECT "accessToken" AS token, to_char("expiresAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires, "tenantId" AS tenant, "tenantName" AS tenant_name, "tenantIsDemo" AS demo, "connectionGeneration" AS generation, "pinReleasedAt" AS released_at, "pinReleasedGeneration" AS released_generation, "pinReleasedTenantId" AS released_tenant FROM accounting_tokens WHERE connector = 'xero'`,
    )
    if (tokens.rows.length !== 1) return null
    const row = tokens.rows[0]!
    const bound = binding(row)
    if (bound === null || typeof row.token !== 'string' || row.token === '') return null
    if (row.tenant_name !== null && typeof row.tenant_name !== 'string') return null
    if (row.demo !== null && typeof row.demo !== 'boolean') return null
    if (row.released_generation !== null && typeof row.released_generation !== 'string') return null
    if (row.released_tenant !== null && typeof row.released_tenant !== 'string') return null
    const expires = typeof row.expires === 'string' ? Date.parse(row.expires) : Number.NaN
    // Never refreshed here: a token that is not current is a token the read-sync has to renew first.
    if (!Number.isFinite(expires) || expires < options.now.getTime() + XERO_TOKEN_MIN_REMAINING_MS) return null
    let releasedAt: Date | null = null
    if (row.released_at !== null) {
      if (!(row.released_at instanceof Date) || Number.isNaN(row.released_at.getTime())) return null
      releasedAt = row.released_at
    }
    const settings = await client.query('SELECT key, value FROM settings WHERE key = ANY($1::text[])', [[XERO_TENANT_PIN_SETTING_KEY, XERO_PIN_RELEASE_WITNESS_SETTING_KEY]])
    const byKey = new Map<string, string | null>()
    for (const setting of settings.rows) {
      if (typeof setting.key !== 'string' || byKey.has(setting.key) || (setting.value !== null && typeof setting.value !== 'string')) return null
      byKey.set(setting.key, setting.value as string | null)
    }
    // The connector's own question, answered by the connector's own pure function.
    const refusal = storedXeroConnectionRefusal(
      { tenantId: bound.tenantId, tenantName: row.tenant_name as string | null, isDemoCompany: row.demo as boolean | null },
      readXeroTenantAllowList(options.env ?? process.env),
      byKey.get(XERO_TENANT_PIN_SETTING_KEY) ?? null,
      { connectionGeneration: bound.connectionGeneration, pinReleasedAt: releasedAt, pinReleasedGeneration: row.released_generation as string | null, pinReleasedTenantId: row.released_tenant as string | null },
      parseXeroReleaseWitness(byKey.get(XERO_PIN_RELEASE_WITNESS_SETTING_KEY) ?? null),
    )
    if (refusal !== null) return null
    return { accessToken: decryptSecret(row.token), tenantId: bound.tenantId, connectionGeneration: bound.connectionGeneration }
  })
}
