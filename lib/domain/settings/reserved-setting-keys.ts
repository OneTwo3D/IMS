import { INTEGRATION_PLUGIN_KEYS_IN_LOCK_ORDER } from '@/lib/integration-plugin-keys'
import { ACCOUNTING_BINDING_SETTING_KEYS } from '@/lib/connectors/accounting-binding-lock-order'

/**
 * WHICH WRITER OWNS A SYSTEM-MANAGED `settings` KEY — A MESSAGE TABLE, NOT A GATE (Codex r20 HIGH).
 *
 * THIS MODULE NO LONGER DECIDES ANYTHING. Round 19 made it the generic writers' guard: a DENYLIST of
 * the system-managed families, joined from the modules that own them. Round 20 showed the shape was
 * wrong rather than the contents — a denylist over a growing key space is only ever as complete as
 * the last search for keys, and this one had already missed `MACHINE_MANAGED_SYNC_KEYS`
 * (`wc_initial_import_completed`, the WooCommerce sync cursors) and the WooCommerce credential rows.
 *
 * The gate is now an ALLOWLIST of the ordinary operator preferences, in
 * `lib/domain/settings/writable-setting-keys.ts`, and it SUPERSEDES this list completely: every key
 * named here was already refused by not being a listed preference, before this file was consulted.
 * There are not two half-guards. There is one guard, and this is the table it looks a refused key up
 * in to say WHICH WRITER may make the change — because a refusal that only says "no" sends the next
 * caller looking for a way around it.
 *
 * WHAT THAT MEANS FOR MAINTENANCE. A new system-managed key does NOT need an entry here to be safe;
 * it is safe by default. An entry here buys one thing: a better sentence when someone tries. Add one
 * when the owning writer is non-obvious, and do not treat a missing entry as a hole.
 *
 * Each family below is imported from the module that already owns it wherever that module is
 * import-free, and stated as a literal (checked by `tests/settings/reserved-setting-keys.test.ts`
 * against the owning constant) where importing it would drag `@/lib/db` into a module the server
 * actions load eagerly.
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
 * Families whose keys are BUILT at run time and so can never appear in any exact list.
 *
 * These are the clearest illustration of why the gate had to be inverted: an exact denylist cannot
 * hold a key that does not exist until the moment a process claims it, and BOTH of these families
 * were being written by a running system while no list named them.
 *
 *   • `wms_dispatch_unresolved_drift:<connector>:<date>` — the dispatch sweep claims one alert per
 *     connector per UTC day (`lib/domain/wms/dispatch-sweep.ts`). Writing one by hand silences that
 *     day's primary-admin alert while inbound sync stays held back.
 *   • `wms_dispatch_unresolved_streak:<connector>` — the persisted drift incident itself
 *     (`unresolvedDriftStateKey`, `lib/domain/wms/unresolved-drift.ts`). Its stored value is what the
 *     operator's isolate action compare-and-sets against, so a hand-written one either fabricates a
 *     cohort to isolate or invalidates the page of an operator about to act on a real one.
 *
 * Both are refused because they are not listed preferences. The prefixes are here so the refusal
 * names the family instead of ending at "unrecognised".
 */
const RESERVED_SETTING_KEY_PREFIXES: readonly string[] = [
  'wms_dispatch_unresolved_drift:',
  'wms_dispatch_unresolved_streak:',
]

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
 * The sentence to refuse `key` with when a named writer owns it, or `null` when no entry here does.
 *
 * `null` DOES NOT MEAN WRITABLE. Since round 20 the decision belongs entirely to
 * `settingKeyWriteRefusal` in `writable-setting-keys.ts`, which refuses everything outside its
 * allowlist and calls this only to improve the message. A key this returns `null` for is still
 * refused — it just gets the generic sentence.
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
