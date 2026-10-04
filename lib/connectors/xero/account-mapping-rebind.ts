/**
 * o3d-6thk1 — A XERO TENANT REBIND MUST NOT LEAVE ORGANISATION-KEYED MAPPING ON THE PREVIOUS ORGANISATION,
 * AND MUST NOT DESTROY A MAPPING IT CANNOT PROVE IS WRONG.
 *
 * IMS's account codes, payment-account map and tax-type mappings are per-CONNECTOR, not per-tenant: they
 * hold ONE organisation's chart. `bindXeroTenant` pinned the new organisation and touched none of them, so
 * after a rebind every document raised afterwards was stamped with the NEW tenant, passed the egress tenant
 * verdict, and posted the PREVIOUS organisation's codes and tax types. Two organisations on Xero's standard
 * chart make that SILENT.
 *
 * THREE ANSWERS, because there are three different things the instance can know about whose mapping it is:
 *
 *   • KNOWN SAME (the stamp, or failing it the token row's tenant, names the bound organisation): nothing
 *     is touched.
 *   • KNOWN DIFFERENT (the stamp or the token row names ANOTHER organisation): the mapping is wrong, so it
 *     is CLEARED in the binding transaction and sync is switched OFF. Readiness then names every missing
 *     piece when the operator re-maps and tries to re-enable.
 *   • UNKNOWN (no stamp, no token row — an instance bound before the stamp existed, then disconnected;
 *     Disconnect deletes the token and the pin and PRESERVES the mapping) WITH a mapping present: the
 *     mapping is KEPT, sync is switched OFF, and NOTHING is stamped. "Could not show it is the same
 *     organisation" is not "it is another organisation", and deleting a working configuration on that
 *     ground turns the ordinary Disconnect-and-reconnect recovery into a configuration loss and an outage
 *     (Codex round 1, HIGH). The operator clears it with an explicit, audited confirmation
 *     (`confirmMappingOwnership`), or re-maps; readiness refuses to enable sync until one of those.
 *
 * The stamp (`xero_account_mapping_tenant_id`) is the durable evidence: written by every bind that leaves
 * ownership known, and by every mapping SAVE made while the mapping's ownership is not in doubt, so it
 * survives a Disconnect.
 *
 * EVERY ORGANISATION-KEYED SETTING AND TABLE COLUMN, and what happens to each (one list, kept here so the
 * next one is added to it rather than discovered):
 *
 *   settings
 *     xero_*_account (15 roles)                         CLEAR on known change   (XERO_ACCOUNT_ROLE_KEYS)
 *     accounting_payment_account_map                    CLEAR                   (Xero bank-account ids)
 *     accounting_reverse_charge_sales_tax_type          CLEAR                   (Xero tax-type code)
 *     accounting_reverse_charge_purchase_tax_type       CLEAR                   (Xero tax-type code)
 *     xero_tax_rate_drift_current / _last_checked_at    CLEAR                   (derived: IMS rates vs the old org's)
 *     xero_account_mapping_tenant_id                    the stamp itself
 *     xero_sync_enabled                                 OFF on known change AND on unknown-with-mapping
 *     xero_expected_tenant_id / xero_pin_release_witness the binding, owned by bindXeroTenant
 *     xero_client_id / xero_client_secret               LEAVE: the app's own credentials, valid for any org
 *     xero_sync_* modes, xero_daily_batch_enabled,
 *       xero_payment_polling_enabled, xero_sync_attach_pdf  LEAVE: behaviour switches, not keyed to an org
 *     xero_last_payment_poll                            LEAVE: a time cursor; the new org's payments are
 *                                                       dated after it, and the poller is gated on sync
 *     accounting_invoice_url_template / bill_url_template LEAVE: operator-typed deep links, cosmetic; they
 *                                                       post nothing
 *   tables
 *     tax_rates.accounting_tax_type                     CLEAR (the second HIGH): readiness only checked
 *     tax_rate_components.accounting_tax_type           CLEAR  non-empty, so old types passed it
 *     accounting_accounts (cached chart, connector xero) CLEAR (o3d-fgrcx, folded in: it is a cache and the
 *                                                       Sync accounts action refills it from the new org)
 *     customers/suppliers.accountingContactId,
 *       products.accountingItemId (+ provenance)        LEAVE: "<connector>:<tenantId>" provenance makes
 *                                                       readers ignore another organisation's ids;
 *                                                       Disconnect already clears them
 *     purchase_invoices/sales_orders/refunds/... external document ids, accounting_sync_logs,
 *       accounting_events, account balance snapshots    LEAVE: history of what was posted where; the
 *                                                       tenant stamp on each row is what refuses it at
 *                                                       egress
 *     accounting_tokens                                 owned by bindXeroTenant
 *
 * NOT an auto-remap (matching old codes to a new chart is a guess that posts silently) and NOT a data
 * migration (nothing stored is rewritten, only cleared or kept).
 */

import { XERO_SETTING_KEYS } from './settings'

/** Which organisation the account mapping is OWNED by. Written by the binding and by an owned save. */
export const XERO_ACCOUNT_MAPPING_TENANT_KEY = 'xero_account_mapping_tenant_id'

/** The shared payment-account map: one row, but its VALUES are Xero's own bank-account ids. */
export const PAYMENT_ACCOUNT_MAP_KEY = 'accounting_payment_account_map'

const SYNC_ENABLED_KEY = 'xero_sync_enabled'

/** The fifteen account roles, derived from the settings module's own key list so a sixteenth is covered. */
export const XERO_ACCOUNT_ROLE_KEYS: readonly string[] = XERO_SETTING_KEYS.filter(
  (key) => key.startsWith('xero_') && key.endsWith('_account'),
)

/** The reverse-charge tax-type settings: Xero tax-type CODES, the second kind of org-keyed code. */
export const REVERSE_CHARGE_TAX_TYPE_KEYS = [
  'accounting_reverse_charge_sales_tax_type',
  'accounting_reverse_charge_purchase_tax_type',
] as const

/** Settings whose presence means "a mapping exists that belongs to some organisation". */
export const XERO_ACCOUNT_MAPPING_KEYS: readonly string[] = [
  ...XERO_ACCOUNT_ROLE_KEYS,
  PAYMENT_ACCOUNT_MAP_KEY,
  ...REVERSE_CHARGE_TAX_TYPE_KEYS,
]

/** Derived from the old organisation's data; cleared with it, never evidence of a mapping. */
const DERIVED_ORG_KEYED_KEYS = ['xero_tax_rate_drift_current', 'xero_tax_rate_drift_last_checked_at'] as const

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
    findUnique(args: { where: { connector: string }; select: { tenantId: true; tenantName?: true } }): Promise<{ tenantId: string | null; tenantName?: string | null } | null>
  }
  taxRate: {
    count(args: { where: { accountingTaxType: { not: null } } }): Promise<number>
    updateMany(args: { where: { accountingTaxType: { not: null } }; data: { accountingTaxType: null } }): Promise<{ count: number }>
  }
  taxRateComponent: {
    count(args: { where: { accountingTaxType: { not: null } } }): Promise<number>
    updateMany(args: { where: { accountingTaxType: { not: null } }; data: { accountingTaxType: null } }): Promise<{ count: number }>
  }
  accountingAccount: {
    deleteMany(args: { where: { connector: string } }): Promise<{ count: number }>
  }
}

export type PreviousMappingOrganisation = { tenantId: string | null; basis: 'stamp' | 'token' | 'unknown' }

/**
 * Who the mapping currently belongs to, as far as the instance can tell. MUST be read BEFORE the binding
 * writes the new token row, which overwrites the only other record of it.
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

/** A mapping row counts as present when it holds something other than the empty defaults. */
function holdsMapping(key: string, value: string): boolean {
  const trimmed = value.trim()
  if (trimmed === '') return false
  return !(key === PAYMENT_ACCOUNT_MAP_KEY && trimmed === '{}')
}

export type MappingPresence = { settingKeys: string[]; taxRates: number; taxRateComponents: number; any: boolean }

/** What organisation-keyed mapping is currently stored. Read under the mapping lock where the caller holds it. */
export async function readMappingPresence(tx: AccountMappingRebindTx): Promise<MappingPresence> {
  const rows = await tx.setting.findMany({ where: { key: { in: [...XERO_ACCOUNT_MAPPING_KEYS] } } })
  const settingKeys = rows.filter((row) => holdsMapping(row.key, row.value)).map((row) => row.key)
  const [taxRates, taxRateComponents] = await Promise.all([
    tx.taxRate.count({ where: { accountingTaxType: { not: null } } }),
    tx.taxRateComponent.count({ where: { accountingTaxType: { not: null } } }),
  ])
  return { settingKeys, taxRates, taxRateComponents, any: settingKeys.length > 0 || taxRates > 0 || taxRateComponents > 0 }
}

export type AccountMappingResetOutcome =
  | { kind: 'none' }
  | {
    kind: 'cleared'
    previous: PreviousMappingOrganisation
    clearedKeys: string[]
    taxRatesCleared: number
    taxRateComponentsCleared: number
    chartRowsCleared: number
    syncWasEnabled: boolean
  }
  | { kind: 'unconfirmed'; previous: PreviousMappingOrganisation; keptKeys: string[]; syncWasEnabled: boolean }

async function writeStamp(tx: AccountMappingRebindTx, tenantId: string): Promise<void> {
  const stamped = await tx.setting.findUnique({ where: { key: XERO_ACCOUNT_MAPPING_TENANT_KEY } })
  if (stamped) {
    if (stamped.value !== tenantId) await tx.setting.update({ where: { key: XERO_ACCOUNT_MAPPING_TENANT_KEY }, data: { value: tenantId } })
  } else {
    await tx.setting.create({ data: { key: XERO_ACCOUNT_MAPPING_TENANT_KEY, value: tenantId } })
  }
}

async function readSyncEnabled(tx: AccountMappingRebindTx): Promise<boolean> {
  return (await tx.setting.findUnique({ where: { key: SYNC_ENABLED_KEY } }))?.value?.trim() === 'true'
}

/**
 * Apply the rebind rule inside the binding transaction. Call it AFTER the binding rows are written and
 * pass the organisation read BEFORE them.
 */
export async function resetAccountMappingForOrganisationChange(
  tx: AccountMappingRebindTx,
  params: { previous: PreviousMappingOrganisation; newTenantId: string; connector: string },
): Promise<AccountMappingResetOutcome> {
  const { previous, newTenantId, connector } = params
  const presence = await readMappingPresence(tx)

  // KNOWN SAME, or nothing mapped: ownership is not in doubt (or there is nothing to own).
  if (previous.tenantId === newTenantId || !presence.any) {
    await writeStamp(tx, newTenantId)
    return { kind: 'none' }
  }

  const syncWasEnabled = await readSyncEnabled(tx)

  // UNKNOWN with a mapping: keep it, hold sync, stamp nothing.
  if (previous.tenantId === null) {
    if (syncWasEnabled) await tx.setting.deleteMany({ where: { key: { in: [SYNC_ENABLED_KEY] } } })
    return { kind: 'unconfirmed', previous, keptKeys: presence.settingKeys, syncWasEnabled }
  }

  // KNOWN DIFFERENT: clear every organisation-keyed piece, switch sync off, then own the (now empty) slate.
  // An ABSENT settings row is the default for every key here (empty account, sync 'false'), so deleting is
  // the clear.
  await tx.setting.deleteMany({ where: { key: { in: [...presence.settingKeys, ...DERIVED_ORG_KEYED_KEYS, SYNC_ENABLED_KEY] } } })
  const [taxRates, taxRateComponents, chart] = await Promise.all([
    tx.taxRate.updateMany({ where: { accountingTaxType: { not: null } }, data: { accountingTaxType: null } }),
    tx.taxRateComponent.updateMany({ where: { accountingTaxType: { not: null } }, data: { accountingTaxType: null } }),
    tx.accountingAccount.deleteMany({ where: { connector } }),
  ])
  await writeStamp(tx, newTenantId)
  return {
    kind: 'cleared',
    previous,
    clearedKeys: presence.settingKeys,
    taxRatesCleared: taxRates.count,
    taxRateComponentsCleared: taxRateComponents.count,
    chartRowsCleared: chart.count,
    syncWasEnabled,
  }
}

// ---------------------------------------------------------------------------
// Ownership as a readiness fact, and the writes that must respect it
// ---------------------------------------------------------------------------

export type MappingOwnership = {
  /** 'owned': nothing to own, or the stamp names the bound organisation. */
  state: 'owned' | 'unconfirmed' | 'other-organisation'
  boundTenantId: string | null
  boundTenantName: string | null
  /** The organisation the stamp names, when it names one. */
  stampedTenantId: string | null
}

/** Pure: the verdict from its three inputs, so the rule has one spelling. */
export function mappingOwnershipVerdict(params: {
  boundTenantId: string | null
  stampedTenantId: string | null
  mappingPresent: boolean
}): MappingOwnership['state'] {
  const { boundTenantId, stampedTenantId, mappingPresent } = params
  if (!boundTenantId || !mappingPresent) return 'owned'
  if (stampedTenantId === null) return 'unconfirmed'
  return stampedTenantId === boundTenantId ? 'owned' : 'other-organisation'
}

/**
 * THE ONE SPELLING of "may sync be enabled": connected, every account mapped, every tax rate mapped, AND the
 * stored mapping is known to belong to the connected organisation. Pure so the truth table is testable.
 */
export function syncReadinessVerdict(params: {
  connected: boolean
  missingAccounts: number
  missingTaxTypes: number
  ownership: MappingOwnership['state']
}): boolean {
  return params.connected && params.missingAccounts === 0 && params.missingTaxTypes === 0 && params.ownership === 'owned'
}

export async function readMappingOwnership(tx: AccountMappingRebindTx, connector: string): Promise<MappingOwnership> {
  const token = await tx.accountingToken.findUnique({ where: { connector }, select: { tenantId: true, tenantName: true } })
  const stamp = (await tx.setting.findUnique({ where: { key: XERO_ACCOUNT_MAPPING_TENANT_KEY } }))?.value?.trim() || null
  const presence = await readMappingPresence(tx)
  const boundTenantId = token?.tenantId ?? null
  return {
    state: mappingOwnershipVerdict({ boundTenantId, stampedTenantId: stamp, mappingPresent: presence.any }),
    boundTenantId,
    boundTenantName: token?.tenantName ?? null,
    stampedTenantId: stamp,
  }
}

export type MappingWriteGate =
  | { ok: true; boundTenantId: string | null; stampAfterWrite: boolean }
  | { ok: false; error: string }

/**
 * Decide, UNDER THE MAPPING LOCK, whether a mapping save may proceed and whether it may stamp ownership.
 *
 * `expectedTenantId` is the organisation the operator's page was rendered against. A save composed for a
 * DIFFERENT organisation (a tab left open across a rebind) would restore the previous organisation's
 * values over the cleared mapping, stamped as the new one's, so it is refused. `undefined` skips the
 * check (a caller with no page); `null` means the page saw no connection.
 *
 * It stamps only when ownership is not in doubt: the stamp already names the bound organisation, or
 * there is no mapping yet and no stamp. A save cannot confirm the provenance of values it did not
 * write, so on an UNCONFIRMED mapping the explicit confirmation is the one way to take ownership.
 */
export async function gateMappingSave(
  tx: AccountMappingRebindTx,
  params: { connector: string; expectedTenantId?: string | null },
): Promise<MappingWriteGate> {
  const ownership = await readMappingOwnership(tx, params.connector)
  const bound = ownership.boundTenantId
  if (params.expectedTenantId !== undefined && (params.expectedTenantId ?? null) !== bound) {
    return {
      ok: false,
      error: 'The connected Xero organisation changed after this page was loaded, so this save was NOT applied '
        + '(it could restore the previous organisation\'s account mapping). Reload the page, review the mapping and save again.',
    }
  }
  const noMappingYet = ownership.state === 'owned' && ownership.stampedTenantId === null
  const stampAfterWrite = bound !== null && (ownership.stampedTenantId === bound || noMappingYet)
  return { ok: true, boundTenantId: bound, stampAfterWrite }
}

export async function stampMappingOwner(tx: AccountMappingRebindTx, tenantId: string): Promise<void> {
  await writeStamp(tx, tenantId)
}

export type MappingConfirmation =
  | { ok: true; tenantId: string; tenantName: string | null; previousStamp: string | null; changed: boolean }
  | { ok: false; error: string }

/**
 * The explicit, audited confirmation that the stored mapping belongs to the bound organisation. The caller
 * records who and when (activity log). Idempotent: already owned changes nothing.
 */
export async function confirmMappingOwnership(
  tx: AccountMappingRebindTx,
  params: { connector: string; expectedTenantId: string },
): Promise<MappingConfirmation> {
  const ownership = await readMappingOwnership(tx, params.connector)
  if (!ownership.boundTenantId) return { ok: false, error: 'Xero is not connected, so there is no organisation to confirm the mapping against.' }
  if (ownership.boundTenantId !== params.expectedTenantId) {
    return { ok: false, error: 'The connected Xero organisation changed since this page was loaded. Reload and confirm again.' }
  }
  const changed = ownership.stampedTenantId !== ownership.boundTenantId
  if (changed) await writeStamp(tx, ownership.boundTenantId)
  return { ok: true, tenantId: ownership.boundTenantId, tenantName: ownership.boundTenantName, previousStamp: ownership.stampedTenantId, changed }
}

// ---------------------------------------------------------------------------
// Operator text. It says what IMS did and what it did NOT establish: nothing here is a claim about documents
// already queued or posted (that is the tenant check's and the ledger's), so it makes none.
// ---------------------------------------------------------------------------

export function xeroAccountMappingResetMessage(params: {
  tenantName: string | null
  outcome: Exclude<AccountMappingResetOutcome, { kind: 'none' }>
}): string {
  const { tenantName, outcome } = params
  const org = tenantName ?? 'this Xero organisation'
  if (outcome.kind === 'unconfirmed') {
    return (
      `Connected to ${org}. IMS could not confirm which organisation this mapping was set up for: sync is OFF until you confirm `
      + `the mapping belongs to ${org} or re-map it. The mapping (accounts, payment map and tax types) was kept exactly as it was; `
      + 'open Sync settings to confirm it, or re-map the accounts and save, then switch sync back on.'
    )
  }
  const was = outcome.previous.tenantId ?? 'an organisation IMS has no record of'
  const parts = [
    `${outcome.clearedKeys.length} mapping setting${outcome.clearedKeys.length === 1 ? '' : 's'}`,
    `${outcome.taxRatesCleared + outcome.taxRateComponentsCleared} tax-type mapping${outcome.taxRatesCleared + outcome.taxRateComponentsCleared === 1 ? '' : 's'}`,
  ]
  return (
    `Connected to ${org}, which is not the organisation the account mapping was set up for (${was}). `
    + `${parts.join(' and ')} described that other organisation's chart, so they were cleared`
    + `${outcome.syncWasEnabled ? ' and Xero sync was switched off' : ''}: IMS will not post to Xero until the accounts and tax types are re-mapped. `
    + 'Open Sync settings, sync the chart of accounts, choose the account for each role and the Xero tax type for each IMS tax rate, then switch sync back on.'
  )
}
