import { getEnvFallback } from '@/lib/settings-store'
import { MINTSOFT_DEFAULT_ADMIN_ORDER_URL_TEMPLATE } from './schema'

/**
 * q66in.7.2 — READ THE ORDER-DISPATCH SETTINGS AS THEY WILL BE OVERWRITTEN, not as they were some
 * time before (Codex r10 #2).
 *
 * `saveMintsoftOrderDispatchSettings` decides two things from the stored values: what the audit
 * entry says changed, and whether the inbound-delta SCOPE moved (which discards the delta cursors).
 * An earlier revision read them with a plain `getMintsoftSettings()` BEFORE the write transaction,
 * which is the mistake `persistMintsoftConnectionAuth` was deliberately restructured to avoid: two
 * saves in flight, both reading `clientId = 89`, one committing `101` and the other committing `89`
 * back — and the second entry says "no change" while the value it actually replaced was `101`. The
 * transition it describes never happened, and the one it caused is recorded nowhere. The same stale
 * read decides `scopeChanged`, so the cursor reset can be skipped for a scope move that did occur.
 *
 * READING INSIDE THE TRANSACTION IS NOT ENOUGH ON ITS OWN. Postgres runs READ COMMITTED here, so a
 * SELECT issued inside a transaction that holds no lock on those rows has exactly the same
 * staleness window as one issued outside it. What closes the window is the ROW LOCK: while this
 * transaction is open, no other transaction can commit an UPDATE or DELETE of these five rows, so
 * the values returned here are provably the values the upserts that follow replace.
 *
 * `FOR UPDATE` locks only rows that EXIST, hence the materialise step first — the same shape, and
 * the same reasoning, as lockIntegrationPluginSelection. Inserting `''` is semantically inert:
 * every reader of these keys goes through `getMintsoftSettings`/`getSettingValue`, and both treat an
 * empty value exactly as they treat an absent row (`if (value)` / `if (!row?.value)`), so the
 * default still applies. Without it a concurrent writer could INSERT a key between the read and the
 * upsert, and the before-image would report "unset" for a value that had just been set.
 *
 * LOCK ORDER. One canonical order (the keys are sorted, and the SELECT re-states `ORDER BY key`),
 * and no path takes a settings row lock and then an advisory lock, so this cannot cycle. The only
 * other transaction that writes Mintsoft settings rows — `persistMintsoftConnectionAuth` — touches
 * a DISJOINT set of keys (auth mode, credentials, secrets, the cached token), so the two cannot
 * block each other at all.
 *
 * NO MIGRATION PASS. `getSettingValues` opportunistically re-encrypts sensitive values as it reads
 * them, through the GLOBAL client. Doing that here would issue a write on a second connection
 * against rows this transaction has locked, and deadlock. None of these five keys is sensitive, so
 * there is nothing to migrate.
 */

/** The five keys this save owns, sorted — the canonical lock order. */
export const MINTSOFT_DISPATCH_SETTING_KEYS = [
  'mintsoft_admin_order_url_template',
  'mintsoft_channel_id',
  'mintsoft_client_id',
  'mintsoft_default_courier_service_id',
  'mintsoft_warehouse_id',
] as const

export type MintsoftDispatchSettingKey = (typeof MINTSOFT_DISPATCH_SETTING_KEYS)[number]

export type MintsoftDispatchSettingsSnapshot = Record<MintsoftDispatchSettingKey, string>

/** The subset of a Prisma transaction client this needs. Structural, so a test can supply it. */
export type MintsoftDispatchSettingsLockTx = {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>
}

const DISPATCH_SETTING_DEFAULTS: MintsoftDispatchSettingsSnapshot = {
  mintsoft_admin_order_url_template: MINTSOFT_DEFAULT_ADMIN_ORDER_URL_TEMPLATE,
  mintsoft_channel_id: '',
  mintsoft_client_id: '',
  mintsoft_default_courier_service_id: '',
  mintsoft_warehouse_id: '',
}

/**
 * Lock the five order-dispatch setting rows and return the values they hold, resolved the same way
 * `getMintsoftSettings` resolves them: an env override wins, then a non-empty stored value, then the
 * default. Resolving identically matters because the caller diffs this against what it is about to
 * write — a raw read would report a blank template as a change away from the default on every save
 * that leaves it blank.
 */
export async function lockMintsoftDispatchSettings(
  tx: MintsoftDispatchSettingsLockTx,
): Promise<MintsoftDispatchSettingsSnapshot> {
  const stored = await lockSettingRows(tx, [...MINTSOFT_DISPATCH_SETTING_KEYS])
  const snapshot = { ...DISPATCH_SETTING_DEFAULTS }
  for (const key of MINTSOFT_DISPATCH_SETTING_KEYS) {
    const envValue = getEnvFallback(key)
    const value = envValue !== null ? envValue : stored.get(key)
    if (value) snapshot[key] = value
  }
  return snapshot
}

/**
 * Materialise the named settings rows, lock them `FOR UPDATE`, and return what they hold.
 *
 * Shared by every Mintsoft configuration writer that audits a before-image, so the materialise step
 * (`FOR UPDATE` locks only rows that EXIST), the canonical sorted lock order and the empty-string
 * convention are stated once rather than re-derived per call site. Callers resolve defaults and env
 * overrides themselves, because "what the row holds" and "what the connector will use" are different
 * questions and only the second one is diffable against what is about to be written.
 */
async function lockSettingRows(
  tx: MintsoftDispatchSettingsLockTx,
  keys: string[],
): Promise<Map<string, string>> {
  const sorted = [...keys].sort()

  // Make the rows exist so they can be row-locked. `''` is what an absent row already means.
  await tx.$executeRaw`
    INSERT INTO settings (key, value, "updatedAt")
    SELECT k, '', now() FROM unnest(${sorted}::text[]) AS k
    ON CONFLICT (key) DO NOTHING`

  const rows = await tx.$queryRaw<Array<{ key: string; value: string | null }>>`
    SELECT key, value FROM settings WHERE key = ANY(${sorted}::text[]) ORDER BY key FOR UPDATE`

  return new Map(rows.map((row) => [row.key, row.value ?? '']))
}

/**
 * q66in.7.2 r4 (Codex r3 finding 3) — THE COURIER MAP'S BEFORE-IMAGE, READ UNDER THE SAME LOCK.
 *
 * `saveMintsoftCourierServiceMap` gained an audit entry in round 1 but kept reading its before-image
 * with a plain `getMintsoftSettings()` OUTSIDE any transaction — precisely the defect the dispatch
 * save was restructured to remove, left standing on the other writer. Two saves in flight both read
 * map A; one commits B; the other commits A back and logs "no change". The B→A transition is a
 * REROUTING of live parcels onto different courier services, and it is then recorded nowhere at all.
 *
 * Same reasoning as `lockMintsoftDispatchSettings`, and it bears repeating because reading inside a
 * transaction looks sufficient and is not: Postgres runs READ COMMITTED here, so an unlocked SELECT
 * inside the transaction is exactly as stale as one outside it. The ROW LOCK is what closes the
 * window.
 *
 * LOCK ORDER. This takes ONE key, and it is DISJOINT from the five `MINTSOFT_DISPATCH_SETTING_KEYS`
 * and from the auth keys `persistMintsoftConnectionAuth` writes, so no two of these three writers
 * can hold a row the other wants — there is nothing to cycle. The key is not sensitive, so the
 * re-encrypting read path that would deadlock against a held row lock is not involved.
 */
export const MINTSOFT_COURIER_SERVICE_MAP_KEY = 'mintsoft_courier_service_map'

export async function lockMintsoftCourierServiceMap(
  tx: MintsoftDispatchSettingsLockTx,
): Promise<string> {
  const stored = await lockSettingRows(tx, [MINTSOFT_COURIER_SERVICE_MAP_KEY])
  const envValue = getEnvFallback(MINTSOFT_COURIER_SERVICE_MAP_KEY)
  return (envValue !== null ? envValue : stored.get(MINTSOFT_COURIER_SERVICE_MAP_KEY)) || ''
}
