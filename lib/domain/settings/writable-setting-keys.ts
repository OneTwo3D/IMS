import { reservedSettingKeyRefusal } from '@/lib/domain/settings/reserved-setting-keys'

/**
 * THE ONLY `settings` KEYS A GENERIC WRITER MAY WRITE (Codex r20 HIGH).
 *
 * Round 19 answered "which keys must `setSetting`/`setSettings` refuse?" with a DENYLIST — the
 * families that had been found unsafe, joined from the modules that own them. Round 20 showed why
 * that shape cannot hold: the list covered what had been looked for, and `MACHINE_MANAGED_SYNC_KEYS`
 * (`app/actions/wc-sync.ts`) had never been looked for. So `wc_initial_import_completed` and the
 * WooCommerce sync cursors were still writable by any principal holding `settings.company`:
 *
 *   • `wc_initial_import_completed = true` makes `startInitialImport()` return without importing,
 *     so the existing orders are never brought in and nothing says so. This branch had just made
 *     that flag REFUSAL-BLOCKING — the import withholds it when a refusal could not be persisted —
 *     and one generic settings write put it back.
 *   • `last_wc_order_sync_at` set into the future makes the next clean poll ask for changes after
 *     that instant and then advance the cursor to now. Every order in between is skipped
 *     permanently, with no error and no gap anyone can see.
 *   • `wc_url` / `wc_consumer_key` / `wc_consumer_secret` written here bypass `saveWcCredentials`
 *     entirely: no URL validation, no fresh-authentication gate, no advisory lock, no product-id
 *     cache wipe, no `wc_settings_version` bump — so an in-flight stock sync keeps writing
 *     old-store ids against the new store.
 *
 * A DENYLIST OVER A GROWING KEY SPACE FAILS THE DAY SOMEONE ADDS A KEY, and it had already failed.
 * So the rule is inverted: this module ENUMERATES THE ORDINARY OPERATOR PREFERENCES, and the generic
 * writers refuse everything else. A new system-managed key is then safe the moment it exists,
 * because nobody had to remember it. A new PREFERENCE fails loudly the first time someone tries to
 * save it from its screen — which is the failure you want, because it is caught by the developer
 * who added the screen, in front of the screen, rather than by nobody.
 *
 * THE LIST IS DERIVED FROM THE SETTINGS UI, and grouped by the screen that offers each key. A
 * preference no screen can set has no business arriving at this endpoint, so the grouping is not
 * decoration: `tests/settings/writable-setting-keys.test.ts` walks `app/` and `components/` for
 * every file that imports `setSetting`/`setSettings`, and fails unless the set of importing files is
 * EXACTLY the set of screens named below — a new screen cannot be added without declaring its keys,
 * and a screen that is deleted cannot leave its keys behind. It also asserts each key really appears
 * in the file it is filed under.
 *
 * WHAT IS DELIBERATELY ABSENT, and where it is written instead:
 *   • the WooCommerce sync settings and credentials — `app/actions/wc-sync.ts` (`saveSyncSettings`,
 *     `saveWcCredentials`), behind the `sync` permission, not `settings.company`.
 *   • `public_app_url` — `savePublicAppUrl`, which validates the URL and reconciles the crontab that
 *     embeds it. Writing it here stored an unvalidated URL and left every managed job line stale.
 *   • the integration plugin flags, accounting binding pins, maintenance fence and lock leases —
 *     each has an owning writer; see `reserved-setting-keys.ts`, which is now only where the
 *     refusal MESSAGE names that writer.
 *   • onboarding progress rows — `app/actions/onboarding.ts`, key-specific writers of their own.
 *
 * WHAT THIS IS NOT. It is an application-level choke point on the two writers that accept a
 * caller-supplied key. It does not stop an owning module writing its own row — that is the point —
 * and it is not a database constraint. See `docs/installation.md`.
 */
const PREFERENCE_KEYS_BY_SCREEN: Readonly<Record<string, readonly string[]>> = {
  'components/settings/activity-log-retention.tsx': [
    'activity_log_retention_info',
    'activity_log_retention_warning',
    'activity_log_retention_error',
  ],
  'components/settings/backup-remote-settings.tsx': [
    'backup_s3_endpoint',
    'backup_s3_region',
    'backup_s3_bucket',
    'backup_s3_access_key',
    'backup_s3_secret_key',
    'backup_s3_prefix',
    'backup_sftp_host',
    'backup_sftp_port',
    'backup_sftp_user',
    'backup_sftp_password',
    'backup_sftp_private_key',
    'backup_sftp_host_fingerprint',
    'backup_sftp_path',
  ],
  'components/settings/backup-schedule.tsx': [
    'backup_schedule_enabled',
    'backup_retention_days',
    'backup_max_count',
    'backup_auto_upload',
  ],
  'components/settings/data-retention.tsx': [
    'retention_sales_orders_months',
    'retention_purchase_orders_months',
    'retention_customers_months',
    'retention_stock_movements_months',
    'retention_sync_logs_months',
    'retention_webhook_events_months',
    'retention_wms_events_months',
    'retention_wms_sync_jobs_months',
  ],
  'components/settings/delivery-tracking.tsx': [
    'delivery_tracking_enabled',
    'delivery_tracking_source',
    'trackship_api_key',
    'shipping_carriers',
  ],
  'components/settings/dispatch-email.tsx': ['dispatch_email_enabled'],
  'components/settings/financial-year-start.tsx': ['financial_year_start'],
  'components/settings/fx-schedule.tsx': ['fx_schedule_enabled', 'fx_schedule_interval_hours'],
  'components/settings/invoice-trigger.tsx': ['invoice_trigger'],
  'components/settings/landed-cost-method.tsx': ['default_landed_cost_method'],
}

export { PREFERENCE_KEYS_BY_SCREEN }

/** Every allowlisted preference key, sorted. Exported for the tests and for documentation. */
export const WRITABLE_SETTING_KEYS: readonly string[] = [
  ...new Set(Object.values(PREFERENCE_KEYS_BY_SCREEN).flat()),
].sort()

const WRITABLE_SETTING_KEY_SET: ReadonlySet<string> = new Set(WRITABLE_SETTING_KEYS)

/** The screen a key is filed under, or `null`. Used by the refusal message and by the tests. */
export function screenOfferingSettingKey(key: string): string | null {
  for (const [screen, keys] of Object.entries(PREFERENCE_KEYS_BY_SCREEN)) {
    if (keys.includes(key)) return screen
  }
  return null
}

/**
 * The refusal for `key`, or `null` when a generic writer may write it.
 *
 * WHAT HAPPENS TO A KEY THAT IS NEITHER a listed preference nor a known system-managed row: it is
 * REFUSED, exactly like a known one. That is the whole point of the inversion — the writer does not
 * have to recognise a key to refuse it, only to recognise it to ALLOW it. The difference an
 * unrecognised key makes is to the message, not to the outcome: `reserved-setting-keys.ts` still
 * knows which writer owns the families we have already named, so a refusal for one of those points
 * at that writer instead of ending at "no".
 */
export function settingKeyWriteRefusal(key: string): string | null {
  if (WRITABLE_SETTING_KEY_SET.has(key)) return null

  const owned = reservedSettingKeyRefusal(key)
  if (owned) return owned

  return (
    `${key} is not a writable preference key. setSetting/setSettings accept only the operator ` +
    `preferences a settings screen offers, listed in lib/domain/settings/writable-setting-keys.ts. ` +
    `If ${key} is system-managed, write it through the module that owns it. If it is a new ` +
    `preference, add it there under the screen that offers it.`
  )
}

/**
 * Refuse a write that names a key outside the allowlist, BEFORE anything is committed.
 *
 * THROWN, not returned, for the reason the round-19 denylist was: no screen offers a key that is not
 * on this list — that is what being on this list means — so reaching here is a call-site bug or a
 * server action invoked directly by hand. Neither is an outcome an operator can act on, and a
 * returned `refused` would ask fourteen settings screens to render a message none of them can
 * produce from anything an operator typed.
 *
 * SO WHAT DOES THE OPERATOR SEE? Their screen's ordinary failed-save message, and nothing more
 * specific — the sentence above is for the server log and the developer reading it. That is the
 * honest description of a state that only a bug or a hand-invoked action can reach, and it is why
 * the repository test that keeps this list level with the UI matters more than the message does: a
 * preference missing from the list is a screen that cannot save, and the test is what catches it
 * before the screen ships.
 */
export function assertWritableSettingKeys(keys: Iterable<string>): void {
  for (const key of keys) {
    const refusal = settingKeyWriteRefusal(key)
    if (refusal) throw new Error(refusal)
  }
}
