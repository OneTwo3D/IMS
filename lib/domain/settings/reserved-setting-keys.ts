import { INTEGRATION_PLUGIN_KEYS_IN_LOCK_ORDER } from '@/lib/integration-plugin-keys'
import { ACCOUNTING_BINDING_SETTING_KEYS } from '@/lib/connectors/accounting-binding-lock-order'

/**
 * THE `settings` KEYS A GENERIC WRITER MAY NOT WRITE (Codex r19 HIGH).
 *
 * `settings` is one key/value table serving two completely different kinds of row, and until this
 * module existed only one of them was defended:
 *
 *   • OPERATOR PREFERENCES — a retention window, a financial year start, an invoice trigger. A
 *     screen offers them, an operator chooses a value, and `setSettings` writes whatever was chosen.
 *     Any value is as legitimate as any other.
 *   • SYSTEM-MANAGED ROWS — a lock lease, a connector binding pin, a maintenance fence, a record of
 *     something that happened. No screen offers them. Their value is a FACT the system established,
 *     and a caller-supplied value is not a choice, it is a falsified fact.
 *
 * `setSetting`/`setSettings` are exported server actions taking an arbitrary key, so they are their
 * own addressable endpoints: a principal holding `settings.company` — the gate the retention screen
 * needs — could name a system-managed key and write it. Round 18's cutoff row was found that way,
 * but the hole was never about that row. It is that the generic writer had a list of exactly ONE
 * refused family (the integration plugin flags), hand-written inline, so every system-managed key
 * added since has been writable and every one added next would be too.
 *
 * SO THE RULE IS A LIST, JOINED, NOT A MEMORY. Each family below is imported from the module that
 * already owns it wherever that module is import-free, and stated as a literal (checked by
 * `tests/settings/reserved-setting-keys.test.ts` against the owning constant) where importing it
 * would drag `@/lib/db` into a module the server actions load eagerly. Protecting a NEW
 * system-managed key is one line here, not a rediscovery of this reasoning.
 *
 * WHAT THIS IS NOT. It is an application-level choke point on the two writers that accept a
 * caller-supplied key. It does not stop the owning module writing its own row — that is the point —
 * and it is not a database constraint. See `docs/installation.md` for why a database-enforced
 * version needs a migration, and what that migration would have to be.
 */

/**
 * The maintenance fence and the marker its recovery consumes (`lib/maintenance-mode.ts`,
 * `lib/domain/system/maintenance-recovery.ts`).
 *
 * LITERALS, not imports: `lib/maintenance-mode.ts` imports `@/lib/db`, and this module is loaded by
 * `app/actions/settings.ts` on every settings render. The test named above asserts these against
 * that module's own constants, so the duplication is checked rather than trusted — the same
 * discipline `lib/connectors/accounting-binding-lock-order.ts` uses for the binding keys.
 */
const MAINTENANCE_FENCE_SETTING_KEYS = [
  'system_maintenance_mode',
  'system_maintenance_reason',
  'system_maintenance_hold',
  'wms_booked_in_recheck_due_since',
] as const

/**
 * Token-refresh leases. Named as the literal rows they are, which is what the refusal has to match.
 *
 * The connector name is unavoidable here and is not a WMS flow: this list is an authorization rule
 * about `settings` keys, and a generic WMS facade has no key to offer it. Checked against the owning
 * module's exported constant by `tests/settings/reserved-setting-keys.test.ts`.
 */
// wms-connector-boundary-ok: o3d-j7y4: a settings-key authorization list must name the concrete row, not a connector facade
const LEASE_SETTING_KEYS = ['mintsoft_auth_lock'] as const

/**
 * Families whose keys are BUILT at run time and so cannot appear in any exact list.
 *
 * The dispatch sweep claims one alert per connector per UTC day by inserting
 * `wms_dispatch_unresolved_drift:<connector>:<date>` (`lib/domain/wms/dispatch-sweep.ts`). Writing
 * one by hand silences that day's primary-admin alert while inbound sync stays held back. An exact
 * list cannot hold a key that does not exist until the day it is claimed, so the prefix is what
 * joins the list instead.
 */
const RESERVED_SETTING_KEY_PREFIXES: readonly string[] = ['wms_dispatch_unresolved_drift:']

/**
 * Every reserved key, mapped to the sentence a refusal states.
 *
 * The message names the writer that MAY make the change wherever one exists, because a refusal that
 * only says "no" sends the next caller looking for a way around it.
 */
const RESERVED_SETTING_KEY_REASONS: ReadonlyMap<string, string> = new Map([
  ...INTEGRATION_PLUGIN_KEYS_IN_LOCK_ORDER.map((key) => [
    key,
    // The message round 5 established, kept verbatim: it is what the plugins UI's call sites were
    // corrected against, and it names the atomicity and the lock, which are the actual reasons.
    `Use saveIntegrationPluginState to change ${key} — it must be written atomically and under the connector-selection lock.`,
  ] as [string, string]),
  ...ACCOUNTING_BINDING_SETTING_KEYS.map((key) => [
    key,
    `${key} is an accounting binding row. It records which organisation this instance is bound to and is written only by the connector consent and disconnect paths, in the order lib/connectors/accounting-binding-lock-order.ts fixes.`,
  ] as [string, string]),
  ...MAINTENANCE_FENCE_SETTING_KEYS.map((key) => [
    key,
    `${key} is part of the maintenance fence. Use enableMaintenanceMode/disableMaintenanceMode — the window's end and the booked-in re-check marker are stamped in one transaction, and writing either half alone leaves callbacks refused with nothing recording that they were.`,
  ] as [string, string]),
  ...LEASE_SETTING_KEYS.map((key) => [
    key,
    `${key} is a lease, not a setting. Its value is a claim one process holds; writing it by hand hands the same claim to two.`,
  ] as [string, string]),
])

/** Every exactly-named reserved key, sorted. Exported for the tests and for documentation. */
export const RESERVED_SETTING_KEYS: readonly string[] = [...RESERVED_SETTING_KEY_REASONS.keys()].sort()

export { RESERVED_SETTING_KEY_PREFIXES }

/**
 * The refusal for `key`, or `null` when a generic writer may write it.
 *
 * Exact match first, then prefix — a run-time-built key has no entry of its own, so its family's
 * reason is the one that applies.
 */
export function reservedSettingKeyRefusal(key: string): string | null {
  const exact = RESERVED_SETTING_KEY_REASONS.get(key)
  if (exact) return exact
  const prefix = RESERVED_SETTING_KEY_PREFIXES.find((p) => key.startsWith(p))
  if (prefix) {
    return `${key} belongs to the system-managed '${prefix}*' family and is written only by the process that claims it.`
  }
  return null
}

/**
 * Refuse a write that names a reserved key, BEFORE anything is committed.
 *
 * THROWN, not returned, for the reason the integration-plugin check was: no screen offers any of
 * these keys, so reaching here is either a call-site bug or a server action invoked directly by
 * hand. Neither is an outcome an operator can act on, and a returned `refused` would ask fourteen
 * settings screens to render a message none of them can ever produce.
 */
export function assertWritableSettingKeys(keys: Iterable<string>): void {
  for (const key of keys) {
    const refusal = reservedSettingKeyRefusal(key)
    if (refusal) throw new Error(refusal)
  }
}
