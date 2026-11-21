import { logActivityInTransaction } from '@/lib/activity-log'
import { SENSITIVE_SETTING_KEYS } from '@/lib/settings-store'
import { WMS_MERGE_CANDIDATE_MODES, WMS_MERGE_CANDIDATE_MODE_SETTING } from '@/lib/domain/wms/merge-candidate-mode'

/**
 * THE SYSTEM-MANAGED SWITCHES AN OPERATOR MAY SET FROM THE COMMAND LINE (`npm run settings:get` / `settings:set`).
 *
 * These keys have no settings screen (or, for two of them, a screen that does not cover the switchover use), and the switchover runbook used to
 * set them with a hand-written SQL transaction. This module is the one place that decides which keys may be set that way, which values each
 * accepts, and which switch needs another switch on first; scripts/settings-cli.ts only parses arguments and prints.
 *
 * EVERY VALUE RULE HERE IS THE ONE THE READER APPLIES. Each boolean switch reads ON only for the exact string `true` (the owning module's
 * `=== 'true'`): `TRUE`, `1`, `yes` and a typo all read OFF, so this module refuses them instead of storing a value that would silently mean off.
 * The merge-candidate mode accepts the two values its screen accepts (`off`, `flag`; case and surrounding space ignored, stored lower case), and
 * refuses the reserved `hold`, which the reader would store-and-ignore.
 *
 * AN ALLOWLIST, NOT A DENYLIST. A key that is not listed is refused, and so is every key in the encrypted-settings set (a credential), before
 * anything is read or written, with a message that never echoes a stored value.
 *
 * ADMIN SWITCHES. The three supplier switches are ADMIN-with-fresh-sign-in in the screen (the supplier mapping screen), because they
 * change what IMS sends to the LIVE warehouse. A shell has no session, so the command assumes ADMIN authority from shell access to the host and, in
 * exchange, refuses to write one without `--confirm-admin` as well as `--yes`, and records the operator (`--by`) and that assumption in the audit entry.
 *
 * THE STOREFRONT CUSTOMER E-MAIL SWITCH (`storefront_customer_email_enabled`) has two rules the screen has too. (1) Turning it ON is refused unless step W is live and
 * WooCommerce's native customer e-mails are off (lib/domain/storefront-customer-email/switch-on-interlock.ts; it reads the store, so the command runs it, not
 * this db-free module). (2) Turning it ON records the instant in `storefront_customer_email_enabled_at` in the same transaction (`stampOnKey`): every history guard
 * of the e-mails is anchored to it.
 */

export type SwitchKind = 'boolean' | 'enum'

export type SwitchDefinition = {
  readonly key: string
  readonly kind: SwitchKind
  readonly allowed: readonly string[]
  /** What the reader assumes when no row exists. */
  readonly defaultValue: string
  /** Switches that must already be `true` / a given value before this one may be turned on. */
  readonly requires?: ReadonlyArray<{ key: string; value: string; why: string }>
  /** The screen that sets this switch needs ADMIN and a fresh sign-in; the command needs `--confirm-admin` to write it and records that it assumed ADMIN. */
  readonly adminOnly?: boolean
  /** A row stamped with the ISO instant, in the same transaction, whenever the switch changes to ON (not when it is left as it is); the row is deleted when the switch changes to OFF. */
  readonly stampOnKey?: string
  /** Turning ON is refused by this interlock (run by the command, which may read the store; the registry stays free of the database client). */
  readonly turnOnInterlock?: 'storefront-customer-email'
}

const BOOLEAN_VALUES = ['true', 'false'] as const

const booleanSwitch = (key: string, requires?: SwitchDefinition['requires'], adminOnly?: boolean): SwitchDefinition => ({
  key, kind: 'boolean', allowed: BOOLEAN_VALUES, defaultValue: 'false', requires, adminOnly,
})

// Literals, not imports of the connector's constants: that module imports the database client, which this registry (and its tests) must not load.
// tests/settings-cli.test.ts holds them equal to the connector's exported constants.
const SUPPLIER_CREATE_KEY = 'mintsoft_supplier_create_enabled' // wms-connector-boundary-ok: 2026-11-19: operator switch registry names the setting key
const ASN_SEND_SUPPLIER_KEY = 'mintsoft_asn_send_supplier_enabled' // wms-connector-boundary-ok: 2026-11-19: operator switch registry names the setting key
const ASN_SUPPLIER_REQUIRED_KEY = 'mintsoft_asn_supplier_required' // wms-connector-boundary-ok: 2026-11-19: operator switch registry names the setting key

// The screen refuses "required" unless "send the supplier" is on (the field name is unverified until controlled-run step 2), so it is a prerequisite here too.
const ASN_REQUIRED_NEEDS_SEND = {
  key: ASN_SEND_SUPPLIER_KEY,
  value: 'true',
  why: 'refusing an ASN without a mapped supplier needs the supplier to be sent on the ASN as well (only after controlled-run step 2 has verified the field)',
}

const PARENT_SKU_DELETE_NEEDS_PARITY = {
  key: 'mintsoft_product_parity_enabled', // wms-connector-boundary-ok: 2026-11-19: operator switch registry names the setting key
  value: 'true',
  why: 'deleting a parent SKU does nothing unless product parity is also on',
}

// The reader is prepareSalesOrderWrite in app/actions/sales.ts (a literal there too, pinned by tests/domain/sales/sales-order-write-model.test.ts).
export const SALES_DISCOUNT_APPORTION_KEY = 'sales_order_discount_tax_apportion_enabled'

// Literals for the same reason; tests/settings-cli.test.ts holds them equal to lib/domain/storefront-customer-email/constants.ts.
export const STOREFRONT_EMAIL_SWITCH_KEY = 'storefront_customer_email_enabled'
export const STOREFRONT_EMAIL_ENABLED_AT_KEY = 'storefront_customer_email_enabled_at'

export const SYSTEM_SWITCHES: readonly SwitchDefinition[] = [
  booleanSwitch('trackship_refire_enabled'),
  booleanSwitch('wc_withdrawal_outcome_enabled'),
  // The order discount of a manual order is taxed at its lines' rates (and the invoice, refund and VAT report follow). ADMIN: it changes the tax IMS stores on new orders and the lines it posts to the LIVE ledger. Off keeps the header-rate treatment byte for byte.
  booleanSwitch(SALES_DISCOUNT_APPORTION_KEY, undefined, true),
  booleanSwitch('mintsoft_product_parity_enabled'), // wms-connector-boundary-ok: 2026-11-19: operator switch registry names the setting key, as the owning connector does
  booleanSwitch('mintsoft_parent_sku_delete_enabled', [PARENT_SKU_DELETE_NEEDS_PARITY]), // wms-connector-boundary-ok: 2026-11-19: operator switch registry names the setting key
  booleanSwitch('wms_merge_hold_enabled', [
    { key: WMS_MERGE_CANDIDATE_MODE_SETTING, value: 'flag', why: 'the groups to hold come from merge-candidate detection, which only runs in flag mode (lib/domain/wms/merge-hold.ts)' },
  ]),
  { key: WMS_MERGE_CANDIDATE_MODE_SETTING, kind: 'enum', allowed: WMS_MERGE_CANDIDATE_MODES, defaultValue: 'off' },
  booleanSwitch('wms_mixed_warehouse_push_enabled'),
  booleanSwitch('wms_sku_rename_remap_enabled'),
  booleanSwitch('wms_despatch_date_enabled'),
  booleanSwitch('wms_despatch_quantity_check_enabled'),
  booleanSwitch('wc_invoice_note_enabled'),
  booleanSwitch('wc_invoice_document_enabled'),
  booleanSwitch('wms_refund_remainder_task_enabled'),
  booleanSwitch('wc_order_amendment_write_enabled'),
  booleanSwitch('wc_order_amendment_unpaid_rewrite_enabled'),
  // Literal, not an import of the Xero allocation module (it imports the database client); tests hold it equal to CREDIT_NOTE_ALLOCATION_SETTING_KEY.
  booleanSwitch('xero_credit_note_allocation_enabled'),
  // o3d-k26m.17: storefront refund -> credit-note parity with the November 2026 plugin fixes (EAS fee gap and shipping fold, fee repayment hold, store-credit hold,
  // SC- numbering and no allocation). Literal, not an import of lib/domain/sales/refund-cn-parity.ts; tests hold it equal to REFUND_CN_PARITY_SETTING_KEY.
  booleanSwitch('wc_refund_credit_note_parity_enabled'),
  // o3d-0lpnb MED-3 / o3d-pnc8p note 1: before IMS creates a sales credit note, read Xero for one it did not raise that already credits the refund (Xeroom-era, by hand,
  // SC-<refund id>) and hold rather than duplicate it. Literal, not an import of lib/connectors/xero/order-credit-notes.ts; tests hold it equal to its key there.
  booleanSwitch('xero_credit_note_duplicate_check_enabled'),
  booleanSwitch(SUPPLIER_CREATE_KEY, undefined, true),
  booleanSwitch(ASN_SEND_SUPPLIER_KEY, undefined, true),
  booleanSwitch(ASN_SUPPLIER_REQUIRED_KEY, [ASN_REQUIRED_NEEDS_SEND], true),
  { ...booleanSwitch(STOREFRONT_EMAIL_SWITCH_KEY), stampOnKey: STOREFRONT_EMAIL_ENABLED_AT_KEY, turnOnInterlock: 'storefront-customer-email' },
]

export const SYSTEM_SWITCH_KEYS: readonly string[] = SYSTEM_SWITCHES.map((s) => s.key)

export const SWITCH_AUDIT_ACTION = 'system_switch_set'
export const SWITCH_REASON_MAX = 500
export const SWITCH_BY_MAX = 80

export function findSwitch(key: string): SwitchDefinition | undefined {
  return SYSTEM_SWITCHES.find((s) => s.key === key)
}

export type SwitchRefusal = { ok: false; error: string }

/** The key must be on the allowlist and never a credential. The message names the key the caller typed and nothing stored. */
export function resolveSwitchKey(key: string | undefined): { ok: true; def: SwitchDefinition } | SwitchRefusal {
  if (!key) return { ok: false, error: 'A --key is required.' }
  if (SENSITIVE_SETTING_KEYS.has(key)) return { ok: false, error: `${key} is an encrypted credential setting; this command never reads or writes those.` }
  const def = findSwitch(key)
  if (!def) return { ok: false, error: `${key} is not a system-managed switch this command may touch. Allowed: ${SYSTEM_SWITCH_KEYS.join(', ')}.` }
  return { ok: true, def }
}

/** Normalise and validate a proposed value the way the owning reader and screen do. */
export function validateSwitchValue(def: SwitchDefinition, raw: string): { ok: true; value: string } | SwitchRefusal {
  if (def.kind === 'enum') {
    const value = raw.trim().toLowerCase()
    if (!def.allowed.includes(value)) return { ok: false, error: `${def.key} must be one of: ${def.allowed.join(', ')}.` }
    return { ok: true, value }
  }
  // Boolean switches: the reader is `=== 'true'`, so anything else would be stored and read as off. Exact match, no trimming or case folding.
  if (!def.allowed.includes(raw)) return { ok: false, error: `${def.key} must be exactly 'true' or 'false' (anything else reads as off).` }
  return { ok: true, value: raw }
}

/** The value a reader would use for a stored row: the stored value, or the default when unset. */
export function effectiveValue(def: SwitchDefinition, stored: string | null | undefined): string {
  if (stored === null || stored === undefined) return def.defaultValue
  if (def.kind === 'enum') return stored.trim().toLowerCase() === 'flag' ? 'flag' : 'off'
  return stored === 'true' ? 'true' : 'false'
}

function isOn(def: SwitchDefinition, value: string): boolean {
  return def.kind === 'boolean' ? value === 'true' : value !== def.defaultValue
}

type ReadClient = { setting: { findUnique(args: { where: { key: string } }): Promise<{ value: string } | null> } }

/**
 * Cross-key rules. Turning a switch ON needs every prerequisite already satisfied; turning a prerequisite OFF is refused while a switch that needs
 * it is on (otherwise the dependent switch would sit on, reading as consent, while its gate is shut).
 */
export async function crossKeyRefusal(client: ReadClient, def: SwitchDefinition, proposed: string): Promise<string | null> {
  if (isOn(def, proposed)) {
    for (const req of def.requires ?? []) {
      const reqDef = findSwitch(req.key)!
      const row = await client.setting.findUnique({ where: { key: req.key } })
      if (effectiveValue(reqDef, row?.value) !== req.value) {
        return `${def.key} cannot be turned on while ${req.key} is not ${req.value}: ${req.why}. Set ${req.key} first.`
      }
    }
    return null
  }
  for (const other of SYSTEM_SWITCHES) {
    for (const req of other.requires ?? []) {
      if (req.key !== def.key) continue
      if (proposed === req.value) continue
      const row = await client.setting.findUnique({ where: { key: other.key } })
      if (isOn(other, effectiveValue(other, row?.value))) {
        return `${def.key} cannot move away from ${req.value} while ${other.key} is on. Turn ${other.key} off first.`
      }
    }
  }
  return null
}

export function adminRefusal(def: SwitchDefinition): string {
  return `${def.key} needs ADMIN with a fresh sign-in in the screen. This command assumes ADMIN authority from shell access to the host: add --confirm-admin to confirm you act as an ADMIN, and --by names who is accountable.`
}

export type SwitchReading = {
  key: string
  stored: string | null
  effective: string
  defaultValue: string
  lastAudit: { at: Date; by: string | null; reason: string | null; oldValue: string | null; newValue: string | null } | null
}

type AuditReadClient = ReadClient & {
  activityLog: {
    findFirst(args: Record<string, unknown>): Promise<{ createdAt: Date; metadata: unknown } | null>
  }
}

export async function readSwitch(client: AuditReadClient, def: SwitchDefinition): Promise<SwitchReading> {
  const row = await client.setting.findUnique({ where: { key: def.key } })
  const audit = await client.activityLog.findFirst({
    where: { entityType: 'SETTING', entityId: def.key, action: SWITCH_AUDIT_ACTION },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true, metadata: true },
  })
  const meta = (audit?.metadata ?? {}) as Record<string, unknown>
  const text = (v: unknown) => (typeof v === 'string' ? v : null)
  return {
    key: def.key,
    stored: row?.value ?? null,
    effective: effectiveValue(def, row?.value),
    defaultValue: def.defaultValue,
    lastAudit: audit
      ? { at: audit.createdAt, by: text(meta.by), reason: text(meta.reason), oldValue: text(meta.oldValue), newValue: text(meta.newValue) }
      : null,
  }
}

export type SwitchWriteInput = { def: SwitchDefinition; value: string; by: string; reason: string; adminConfirmed?: boolean }

type TxClient = ReadClient & {
  setting: ReadClient['setting'] & { upsert(args: Record<string, unknown>): Promise<unknown>; deleteMany(args: Record<string, unknown>): Promise<unknown> }
  activityLog: { create(args: Record<string, unknown>): Promise<unknown> }
}

export type SwitchWriteClient = {
  $transaction<T>(fn: (tx: TxClient) => Promise<T>, options?: Record<string, unknown>): Promise<T>
}

export type SwitchWriteResult =
  | { ok: true; changed: boolean; oldValue: string | null; newValue: string }
  | SwitchRefusal

class SwitchRefused extends Error {}

/**
 * Upsert the settings row, write the audit entry and read the value back, all in ONE transaction. The audit write is the durable
 * logActivityInTransaction (it does not swallow failure), so a failed audit aborts the upsert; a read-back that differs from what was written
 * aborts both. Serializable, so a concurrent writer of the same key (or of a prerequisite) makes this fail rather than interleave.
 * An unchanged value writes nothing, not even an audit row.
 */
export async function writeSwitch(client: SwitchWriteClient, input: SwitchWriteInput): Promise<SwitchWriteResult> {
  const { def, value, by, reason, adminConfirmed } = input
  if (def.adminOnly && !adminConfirmed) return { ok: false, error: adminRefusal(def) }
  try {
    return await client.$transaction(async (tx) => {
      const refusal = await crossKeyRefusal(tx, def, value)
      if (refusal) throw new SwitchRefused(refusal)
      const before = await tx.setting.findUnique({ where: { key: def.key } })
      const oldValue = before?.value ?? null
      if (oldValue === value) return { ok: true, changed: false, oldValue, newValue: value } as const
      await tx.setting.upsert({ where: { key: def.key }, create: { key: def.key, value }, update: { value } })
      if (def.stampOnKey && isOn(def, value)) {
        const at = new Date().toISOString()
        await tx.setting.upsert({ where: { key: def.stampOnKey }, create: { key: def.stampOnKey, value: at }, update: { value: at } })
      } else if (def.stampOnKey) {
        // Turned OFF: the stamp goes with it, so a later switch-on by a direct write (SQL, a restore) has no stale instant to anchor the guards.
        await tx.setting.deleteMany({ where: { key: def.stampOnKey } })
      }
      await logActivityInTransaction(tx as never, {
        userId: null,
        entityType: 'SETTING',
        entityId: def.key,
        action: SWITCH_AUDIT_ACTION,
        tag: 'settings',
        description: `System switch ${def.key} changed from ${oldValue ?? `(unset, default ${def.defaultValue})`} to ${value} by ${by}: ${reason}`,
        ...(def.adminOnly ? { level: 'WARNING' as const } : {}),
        metadata: { by, reason, oldValue, newValue: value, via: 'settings:set', ...(def.adminOnly ? { adminAuthorityAssumed: true } : {}) },
      })
      const after = await tx.setting.findUnique({ where: { key: def.key } })
      if (after?.value !== value) throw new Error(`Read-back of ${def.key} did not match what was written; nothing was committed.`)
      return { ok: true, changed: true, oldValue, newValue: value } as const
    }, { isolationLevel: 'Serializable', timeout: 30_000 })
  } catch (error) {
    if (error instanceof SwitchRefused) return { ok: false, error: error.message }
    throw error
  }
}
