import { getSettingValues } from '@/lib/settings-store'

/**
 * How we authenticate to Mintsoft (o3d-092).
 *
 * `POST /api/Auth` does NOT hand out a session token — it MINTS A NEW TENANT
 * API KEY and invalidates the previous one. The key belongs to the Mintsoft
 * tenant, not to the caller, and three of our systems share that tenant (this
 * connector, the woocommerce-mintsoft-sync order sweep, and the shipping-label
 * service). So every login here silently knocks the other two offline until
 * their own refresh cycle runs.
 *
 * `api_key` is therefore a HARD guarantee that /api/Auth is never called — not
 * on a cache miss, not on expiry, not on a 401.
 */
export type MintsoftAuthMode = 'credentials' | 'api_key'

export const MINTSOFT_AUTH_MODES: readonly MintsoftAuthMode[] = ['credentials', 'api_key'] as const

/** Narrow an arbitrary stored/submitted value to a MintsoftAuthMode. */
export function parseMintsoftAuthMode(value: string | null | undefined): MintsoftAuthMode | null {
  const trimmed = String(value ?? '').trim().toLowerCase()
  return (MINTSOFT_AUTH_MODES as readonly string[]).includes(trimmed)
    ? (trimmed as MintsoftAuthMode)
    : null
}

export class MintsoftAuthModeError extends Error {}

/**
 * Resolve the effective auth mode, failing CLOSED on a malformed value.
 *
 * `parseMintsoftAuthMode(x) ?? 'credentials'` is wrong on any path that can
 * receive operator input, because it cannot tell "absent" from "present but
 * misspelled" — and mapping a typo like `api-key` onto `credentials` enables
 * exactly the login this mode exists to forbid. That distinction matters more
 * than it looks: `mintsoft_auth_mode` has an env fallback
 * (`MINTSOFT_AUTH_MODE`), so an invalid value can arrive without ever passing
 * through the validated settings action.
 *
 * Absent/blank still means `credentials` — that is the documented default for
 * an install that has never chosen a mode.
 */
export function resolveMintsoftAuthMode(value: string | null | undefined): MintsoftAuthMode {
  const raw = String(value ?? '').trim()
  if (!raw) return 'credentials'

  const parsed = parseMintsoftAuthMode(raw)
  if (!parsed) {
    throw new MintsoftAuthModeError(
      `Mintsoft auth mode "${raw}" is not recognised (expected ${MINTSOFT_AUTH_MODES.join(' or ')}). ` +
      'Refusing to fall back to username/password: logging in would regenerate the tenant ' +
      'API key and break the other Mintsoft integrations.',
    )
  }

  return parsed
}

export type MintsoftSettings = {
  /**
   * The CACHED rotating 24-hour token, not an operator-supplied credential.
   * `credentials` mode overwrites this on every refresh — which is exactly why
   * a fixed key must live in `mintsoft_static_api_key` instead.
   */
  mintsoft_api_key: string
  /** 'credentials' (default) or 'api_key'. See MintsoftAuthMode. */
  mintsoft_auth_mode: string
  /**
   * The operator-supplied FIXED key, used only in `api_key` mode. Deliberately
   * a separate slot from `mintsoft_api_key` so a credentials-mode refresh can
   * never clobber it, and so switching modes back and forth doesn't lose it.
   */
  mintsoft_static_api_key: string
  mintsoft_username: string
  mintsoft_password: string
  mintsoft_webhook_secret: string
  mintsoft_admin_order_url_template: string
  mintsoft_default_courier_service_id: string
  /** JSON map of IMS shipping-service name → Mintsoft CourierServiceId. */
  mintsoft_courier_service_map: string
  /**
   * Our Mintsoft ClientId. REQUIRED to enable the inbound Order/List delta:
   * Mintsoft is a shared 3PL tenant, so an UNSCOPED Order/List returns every
   * client's orders — and an order-number collision could then mark OUR order
   * shipped off a FOREIGN despatch. When blank/invalid the delta stays off and
   * the sweep uses the per-order reconcile. A positive whole number, as a string.
   */
  mintsoft_client_id: string
  /** Optional Mintsoft ChannelId that further scopes the inbound delta. */
  mintsoft_channel_id: string
  /** Optional Mintsoft WarehouseId that further scopes the inbound delta. */
  mintsoft_warehouse_id: string
}

export const MINTSOFT_SETTING_KEYS = [
  'mintsoft_api_key',
  'mintsoft_auth_mode',
  'mintsoft_static_api_key',
  'mintsoft_username',
  'mintsoft_password',
  'mintsoft_webhook_secret',
  'mintsoft_admin_order_url_template',
  'mintsoft_default_courier_service_id',
  'mintsoft_courier_service_map',
  'mintsoft_client_id',
  'mintsoft_channel_id',
  'mintsoft_warehouse_id',
] as const

// `{id}` is substituted with the Mintsoft internal order id. Matches the proven
// woo-mintsoft plugin default; override via the setting for other tenants.
export const MINTSOFT_DEFAULT_ADMIN_ORDER_URL_TEMPLATE = 'https://app.fulfillable.co.uk/Order/Details/{id}'

const MINTSOFT_DEFAULTS: MintsoftSettings = {
  mintsoft_api_key: '',
  // Default to today's behaviour so an existing install is untouched until an
  // operator explicitly opts into the fixed key.
  mintsoft_auth_mode: 'credentials',
  mintsoft_static_api_key: '',
  mintsoft_username: '',
  mintsoft_password: '',
  mintsoft_webhook_secret: '',
  mintsoft_admin_order_url_template: MINTSOFT_DEFAULT_ADMIN_ORDER_URL_TEMPLATE,
  mintsoft_default_courier_service_id: '',
  mintsoft_courier_service_map: '',
  mintsoft_client_id: '',
  mintsoft_channel_id: '',
  mintsoft_warehouse_id: '',
}

/**
 * Parse a Mintsoft scoping id setting (ClientId / ChannelId / WarehouseId) into a
 * positive integer, or null when blank/invalid. Shared by the settings action
 * (validation), the connector (delta scoping), and the sweep (fail-closed gate)
 * so all three agree on what counts as "configured".
 */
export function parseMintsoftPositiveId(value: string | null | undefined): number | null {
  if (value == null) return null
  const trimmed = String(value).trim()
  if (!/^\d+$/.test(trimmed)) return null
  const parsed = Number.parseInt(trimmed, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

/**
 * True when the inbound-delta SCOPE (ClientId / ChannelId / WarehouseId) differs
 * between the incoming values and the persisted settings. A scope change (a tenant
 * correction, a channel/warehouse retarget) invalidates the persisted delta
 * watermark + last-reconcile cursors — they belong to the OLD scope, and reusing
 * them would start the next query from a stale point, so outstanding new-scope
 * orders predating the overlap would never enter the delta. The caller must clear
 * both cursors when this returns true. Compared as already-normalised strings
 * (`''` = unset).
 */
export function mintsoftDeltaScopeChanged(
  next: { clientId: string; channelId: string; warehouseId: string },
  prev: MintsoftDeltaScope,
): boolean {
  return mintsoftDeltaScopeToken({
    mintsoft_client_id: next.clientId,
    mintsoft_channel_id: next.channelId,
    mintsoft_warehouse_id: next.warehouseId,
  }) !== mintsoftDeltaScopeToken(prev)
}

/** The three settings that define which orders the inbound delta can see. */
export type MintsoftDeltaScope = Pick<
  MintsoftSettings,
  'mintsoft_client_id' | 'mintsoft_channel_id' | 'mintsoft_warehouse_id'
>

/**
 * q66in.7.2 r3 (Codex r2 finding 2) — THE SCOPE AS ONE COMPARABLE VALUE.
 *
 * `saveMintsoftOrderDispatchSettings` discards the delta cursors when the scope moves, but the
 * cursors are written by the SWEEP, from a separate process, and an in-flight sweep that started
 * under the OLD scope re-upserts them after the delete — restoring an old-scope watermark and
 * undoing the reset entirely. The sweep therefore has to carry the scope it started under and
 * refuse to write cursors if it has since moved, which needs the scope as a single value it can
 * hold across the run rather than a three-way comparison done at one call site.
 *
 * Values are already normalised (`''` = unset) and joined on NUL, which no setting value contains,
 * so the token is injective: two different scopes can never collapse to one string. It is compared
 * for EQUALITY only and never parsed back — it is an identity, not a serialization format.
 *
 * `mintsoftDeltaScopeChanged` is expressed in terms of it so the save's "did the scope move?" and
 * the sweep's "is the scope still mine?" cannot drift into disagreeing about what the scope is.
 */
export function mintsoftDeltaScopeToken(scope: MintsoftDeltaScope): string {
  return [
    scope.mintsoft_client_id,
    scope.mintsoft_channel_id,
    scope.mintsoft_warehouse_id,
  ].join('\u0000')
}

export async function getMintsoftSettings(): Promise<MintsoftSettings> {
  const map = await getSettingValues([...MINTSOFT_SETTING_KEYS])
  const result = { ...MINTSOFT_DEFAULTS }

  for (const key of Object.keys(result) as (keyof MintsoftSettings)[]) {
    const value = map.get(key)
    if (value) result[key] = value
  }

  return result
}

/**
 * One mode-aware "is there usable auth material?" predicate, shared by the
 * dashboard and onboarding status so they cannot drift apart.
 *
 * Lives HERE and not in app/actions/mintsoft-sync.ts because that file is
 * `'use server'`, where every export must be an async server action — a
 * synchronous export there compiles under tsc but fails `next build`.
 */
export function mintsoftHasAuthMaterial(
  settings: Pick<MintsoftSettings,
    'mintsoft_auth_mode' | 'mintsoft_static_api_key' | 'mintsoft_api_key' | 'mintsoft_username' | 'mintsoft_password'>,
): boolean {
  let mode: MintsoftAuthMode
  try {
    mode = resolveMintsoftAuthMode(settings.mintsoft_auth_mode)
  } catch {
    // A malformed mode is a broken configuration, not a configured one.
    return false
  }

  if (mode === 'api_key') return Boolean(settings.mintsoft_static_api_key.trim())

  return Boolean(
    settings.mintsoft_api_key.trim()
      || (settings.mintsoft_username.trim() && settings.mintsoft_password.trim()),
  )
}

/**
 * o3d-hl8l r5 (Codex r4 finding 2) — THE DELTA-RESET GENERATION.
 *
 * WHY THE SCOPE TOKEN COULD NOT BE THE FENCE. `saveMintsoftDeltaCursors` used to refuse a stale
 * cursor write by comparing the scope token the run started under against the one held at save time.
 * That detects "the scope is different now" and NOT "the cursors were reset while I was running" —
 * and those are not the same question, because the token is a function of the CURRENT scope and can
 * return to a value it already had. The operator corrects ClientId 89 → 101, sees the mistake and
 * puts 89 back: two resets, two cleared cursor pairs, and a token that ends exactly where it began.
 * An in-flight sweep that read its watermark under the first 89 then compares 89 against 89, passes,
 * and writes an old-scope watermark straight back over BOTH resets. The delta then resumes from a
 * point before the correction and the orders the correction was made to see never enter it.
 *
 * A GENERATION HAS NO VALUE TO RETURN TO. It is incremented once per committed reset, by whichever
 * transaction holds the five dispatch setting rows `FOR UPDATE`, so every number comes from ONE
 * SERIALIZED WRITER CHAIN: the lock is held to commit across the read and the increment. The
 * ordering is therefore A LOCK ORDERING RATHER THAN A CLOCK READING, and no host clock — and no
 * database clock either — participates. Two resets that restore the original scope still leave the
 * generation two higher than the sweep is carrying, so the write is refused.
 *
 * The scope token is KEPT, because "did the scope move?" is still the question the save asks to
 * decide whether to reset at all. It is no longer the question the cursor write asks.
 */
export const MINTSOFT_DELTA_GENERATION_KEY = 'mintsoft_order_delta_generation'

/**
 * The stored generation as a number.
 *
 * ABSENT (or empty) IS ZERO, not unknown: only the reset writes this row, so no row means no reset
 * has ever committed, which is a fact and not a gap. A row that is present but NOT a non-negative
 * integer is `null` — genuinely unattributable — and every caller treats that as "apply no change",
 * because a value nobody can order cannot establish that a cursor write is current.
 */
export function parseMintsoftDeltaGeneration(raw: string | null | undefined): number | null {
  if (raw == null) return 0
  const trimmed = String(raw).trim()
  if (trimmed === '') return 0
  if (!/^\d+$/.test(trimmed)) return null
  const parsed = Number.parseInt(trimmed, 10)
  return Number.isSafeInteger(parsed) ? parsed : null
}

/**
 * The generation a committing reset writes. An unreadable current value starts the chain again at 1
 * rather than propagating the garbage — every run holding the unreadable value is refused anyway
 * (it carries `null`), and every run holding a real number disagrees with 1 unless the chain really
 * is that short.
 */
export function nextMintsoftDeltaGeneration(current: number | null): number {
  return (current ?? 0) + 1
}
