/**
 * o3d-6thk1 — A XERO TENANT REBIND MUST NOT LEAVE THE ACCOUNT MAPPING ON THE PREVIOUS ORGANISATION.
 *
 * IMS's account codes are per-CONNECTOR, not per-tenant: `xero_sales_account` and its fourteen
 * siblings (lib/connectors/xero/settings.ts) and the payment-account map hold ONE organisation's
 * chart. `bindXeroTenant` pinned the new organisation and touched none of them, so after a deliberate
 * rebind every document raised afterwards was stamped with the NEW tenant, passed the egress tenant
 * verdict, and posted the PREVIOUS organisation's account codes. Two organisations on Xero's standard
 * chart make that SILENT: the stale code exists in the new ledger and the posting lands in whatever
 * account carries it.
 *
 * THE SMALLEST SAFE BEHAVIOUR, and why it is this one:
 *
 *   • CLEAR the mapping (the account roles and the payment map), in the transaction that writes the
 *     new binding. An unmapped role is something every consumer already refuses on its own terms
 *     (the empty-string default) and `getXeroSyncReadiness` already reports it, by label, as
 *     `missingAccounts`; nothing new has to learn to read a marker.
 *   • TURN SYNC OFF in the same transaction. Readiness is only consulted on the OFF to ON
 *     transition (saveXeroSettings), so on an instance that is already enabled, clearing alone would
 *     leave the toggle on over an empty mapping. The toggle is the one gate both claim paths and the
 *     enqueue check (queue.ts `connectorSyncGate`) pass through, and re-enabling it runs the readiness
 *     gate, which then names the missing accounts to the operator.
 *   • NOT an auto-remap: matching old codes to a new chart is a guess about which account is which,
 *     and a wrong guess posts silently. NOT a data migration: nothing already stored is rewritten.
 *   • A reconnect to the SAME organisation (a refresh, a re-consent, a disconnect and reconnect)
 *     touches none of it.
 *
 * WHAT "THE PREVIOUS ORGANISATION" IS. `disconnect()` deletes the token row AND the pin, so on the
 * ordinary route to a rebind (disconnect, then connect elsewhere) there is no record left of who the
 * mapping was for. This module therefore keeps one: `xero_account_mapping_tenant_id`, stamped by every
 * binding with the organisation it bound. The previous organisation is that stamp; absent it (an
 * instance bound before this existed) it is the token row's tenant; absent both it is UNKNOWN, and an
 * unknown previous organisation with a mapping present is treated as a change. An unproven "same
 * organisation" is exactly the thing this must not assume.
 */

import { XERO_SETTING_KEYS } from './settings'

/** Which organisation the account mapping was last bound to. Written only by the binding transaction. */
export const XERO_ACCOUNT_MAPPING_TENANT_KEY = 'xero_account_mapping_tenant_id'

/** The shared payment-account map: one row, but its VALUES are Xero's own bank-account ids. */
const PAYMENT_ACCOUNT_MAP_KEY = 'accounting_payment_account_map'

const SYNC_ENABLED_KEY = 'xero_sync_enabled'

/**
 * Every setting that holds one organisation's chart: the account roles (derived from the settings
 * module's own key list, not restated, so a sixteenth role is covered the day it is added) and the
 * payment map.
 */
export const XERO_ACCOUNT_MAPPING_KEYS: readonly string[] = [
  ...XERO_SETTING_KEYS.filter((key) => key.startsWith('xero_') && key.endsWith('_account')),
  PAYMENT_ACCOUNT_MAP_KEY,
]

/** The part of a Prisma transaction client this module uses. */
export type AccountMappingRebindTx = {
  setting: {
    findUnique(args: { where: { key: string } }): Promise<{ value: string } | null>
    findMany(args: { where: { key: { in: string[] } } }): Promise<Array<{ key: string; value: string }>>
    create(args: { data: { key: string; value: string } }): Promise<unknown>
    update(args: { where: { key: string }; data: { value: string } }): Promise<unknown>
    deleteMany(args: { where: { key: { in: string[] } } }): Promise<{ count: number }>
  }
  accountingToken: {
    findUnique(args: { where: { connector: string }; select: { tenantId: true } }): Promise<{ tenantId: string | null } | null>
  }
}

export type PreviousMappingOrganisation = { tenantId: string | null; basis: 'stamp' | 'token' | 'unknown' }

/**
 * Who the mapping currently belongs to. MUST be read BEFORE the binding writes the new token row,
 * which overwrites the only other record of it.
 */
export async function readPreviousMappingOrganisation(
  tx: AccountMappingRebindTx,
  connector: string,
): Promise<PreviousMappingOrganisation> {
  const stamp = (await tx.setting.findUnique({ where: { key: XERO_ACCOUNT_MAPPING_TENANT_KEY } }))?.value?.trim()
  if (stamp) return { tenantId: stamp, basis: 'stamp' }
  const token = await tx.accountingToken.findUnique({ where: { connector }, select: { tenantId: true } })
  if (token?.tenantId) return { tenantId: token.tenantId, basis: 'token' }
  return { tenantId: null, basis: 'unknown' }
}

export type AccountMappingResetOutcome =
  | { reset: false }
  | { reset: true; previous: PreviousMappingOrganisation; clearedKeys: string[]; syncWasEnabled: boolean }

/** A mapping row counts as present when it holds something other than the empty defaults. */
function holdsMapping(key: string, value: string): boolean {
  const trimmed = value.trim()
  if (trimmed === '') return false
  return !(key === PAYMENT_ACCOUNT_MAP_KEY && trimmed === '{}')
}

/**
 * Apply the rebind rule inside the binding transaction. Call it AFTER the binding rows are written and
 * pass the organisation read BEFORE them.
 */
export async function resetAccountMappingForOrganisationChange(
  tx: AccountMappingRebindTx,
  params: { previous: PreviousMappingOrganisation; newTenantId: string },
): Promise<AccountMappingResetOutcome> {
  const { previous, newTenantId } = params
  let outcome: AccountMappingResetOutcome = { reset: false }

  if (previous.tenantId !== newTenantId) {
    const rows = await tx.setting.findMany({ where: { key: { in: [...XERO_ACCOUNT_MAPPING_KEYS, SYNC_ENABLED_KEY] } } })
    const present = rows.filter((row) => row.key !== SYNC_ENABLED_KEY && holdsMapping(row.key, row.value)).map((row) => row.key)
    if (present.length > 0) {
      const syncWasEnabled = rows.some((row) => row.key === SYNC_ENABLED_KEY && row.value.trim() === 'true')
      // An ABSENT row is the default for every key here (empty account, sync 'false'), so deleting is
      // the clear, and it needs no write semantics the statement does not already have.
      await tx.setting.deleteMany({ where: { key: { in: [...present, SYNC_ENABLED_KEY] } } })
      outcome = { reset: true, previous, clearedKeys: present, syncWasEnabled }
    }
  }

  // The stamp always names the organisation just bound, changed or not, so the NEXT rebind has an
  // answer even after a disconnect has deleted the token row and the pin.
  const stamped = await tx.setting.findUnique({ where: { key: XERO_ACCOUNT_MAPPING_TENANT_KEY } })
  if (stamped) {
    if (stamped.value !== newTenantId) {
      await tx.setting.update({ where: { key: XERO_ACCOUNT_MAPPING_TENANT_KEY }, data: { value: newTenantId } })
    }
  } else {
    await tx.setting.create({ data: { key: XERO_ACCOUNT_MAPPING_TENANT_KEY, value: newTenantId } })
  }
  return outcome
}

/**
 * The operator-facing sentence. It says what IMS did and what it did NOT establish: nothing here is a
 * claim about documents already queued or posted (that is the tenant check's and the ledger's), so it
 * makes none.
 */
export function xeroAccountMappingResetMessage(params: {
  tenantName: string | null
  outcome: Extract<AccountMappingResetOutcome, { reset: true }>
}): string {
  const { tenantName, outcome } = params
  const was = outcome.previous.tenantId ?? 'an organisation IMS has no record of'
  return (
    `Connected to ${tenantName ?? 'a different Xero organisation'}, which is not the organisation the account mapping was set up for (${was}). `
    + `The mapping (${outcome.clearedKeys.length} setting${outcome.clearedKeys.length === 1 ? '' : 's'}) described that other organisation's chart of accounts, so it was cleared`
    + `${outcome.syncWasEnabled ? ' and Xero sync was switched off' : ''}: IMS will not post to Xero until the accounts are re-mapped. `
    + 'Open Sync settings, choose the account for each role from this organisation, then switch sync back on.'
  )
}
