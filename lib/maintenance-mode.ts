import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

const MAINTENANCE_ENABLED_KEY = 'system_maintenance_mode'
const MAINTENANCE_REASON_KEY = 'system_maintenance_reason'

/**
 * o3d-hl8l r4 (Codex r3 finding 1) — THE MARKER THAT MAKES A REFUSED CALLBACK RECOVER ITSELF.
 *
 * The webhook fence refuses booked-in callbacks with a 503 while this flag is on, and writes no row:
 * the fence runs before signature verification, and anything written into the window is being
 * replayed over. Rounds 1–3 bounded the loss with a sender retry, an operator "Re-check" button and
 * the watchdog's overdue alert — and all three are conditional. The sender may not retry; the button
 * existed only on purchase orders; and the watchdog is a cron a default installation does not run,
 * so on a stock-transfer ASN with a non-retrying sender the outcome was an ASN stuck IN_TRANSIT with
 * destination stock never applied and NOTHING that would ever say so.
 *
 * The window's END is the one moment on this path that is both authenticated and safely writable —
 * the restore has finished, so a row written now survives. Stamping it here turns "callbacks may
 * have been dropped" into a durable fact that a cron can act on without knowing anything about who
 * was refused, which is what makes the recovery automatic rather than an operator's to remember.
 *
 * IT IS SET WHENEVER A REAL WINDOW CLOSES, not only when one is known to have refused something.
 * The refusal itself is unrecordable, so the alternative is a marker conditioned on evidence that
 * by construction does not exist. A re-check that finds nothing outstanding books nothing in, so
 * the cost of the false positives this accepts is one WMS read per open ASN.
 */
export const WMS_BOOKED_IN_RECHECK_DUE_KEY = 'wms_booked_in_recheck_due_since'

async function setSetting(key: string, value: string) {
  await db.setting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  })
}

export async function enableMaintenanceMode(reason: string) {
  await Promise.all([
    setSetting(MAINTENANCE_ENABLED_KEY, 'true'),
    setSetting(MAINTENANCE_REASON_KEY, reason),
  ])
}

export async function disableMaintenanceMode() {
  // Was a window actually open? This is called unconditionally from the restore endpoint's
  // `finally`, including on paths where `enableMaintenance` itself never applied, and a marker
  // stamped for a window that never happened would re-check every open ASN for nothing.
  const wasEnabled = (await getMaintenanceModeState()).enabled

  // One transaction: a cleared flag with no marker is precisely the state this exists to prevent —
  // callbacks are accepted again and the ones refused during the window are silently nobody's.
  await db.$transaction(async (tx) => {
    for (const [key, value] of [
      [MAINTENANCE_ENABLED_KEY, 'false'],
      [MAINTENANCE_REASON_KEY, ''],
      ...(wasEnabled ? [[WMS_BOOKED_IN_RECHECK_DUE_KEY, new Date().toISOString()] as const] : []),
    ] as ReadonlyArray<readonly [string, string]>) {
      await tx.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
    }
  })
}

export async function getMaintenanceModeState(): Promise<{ enabled: boolean; reason: string | null }> {
  const rows = await db.setting.findMany({
    where: { key: { in: [MAINTENANCE_ENABLED_KEY, MAINTENANCE_REASON_KEY] } },
  })
  const map = new Map(rows.map((row) => [row.key, row.value]))
  return {
    enabled: map.get(MAINTENANCE_ENABLED_KEY) === 'true',
    reason: map.get(MAINTENANCE_REASON_KEY)?.trim() || null,
  }
}

/**
 * o3d-hl8l r3 (Codex r2 finding 1): how long a fenced webhook sender is asked to wait.
 *
 * The fence's whole defence for refusing a callback rather than persisting it is that a 503 is the
 * standard retry signal — but a 503 with no `Retry-After` leaves the schedule to the sender, and a
 * sender that backs off aggressively can spend its retry budget inside the window. Five minutes is
 * short enough to retry several times across a restore and long enough not to hammer a database
 * that is being replayed over. It is a hint, not a guarantee: nothing here knows how long the
 * restore will take, and a sender that does not retry at all is still covered only by the recovery
 * named at the fence.
 */
export const MAINTENANCE_MODE_RETRY_AFTER_SECONDS = 300

/** Split from the settings read so the response shape is testable without a database. */
export function buildMaintenanceModeResponse(
  kind: 'cron' | 'webhook',
  state: { reason: string | null },
): NextResponse {
  const body = {
    skipped: true,
    reason: 'maintenance_mode',
    detail: state.reason ?? 'System maintenance in progress.',
  }

  return NextResponse.json(body, {
    status: kind === 'webhook' ? 503 : 423,
    ...(kind === 'webhook'
      ? { headers: { 'Retry-After': String(MAINTENANCE_MODE_RETRY_AFTER_SECONDS) } }
      : {}),
  })
}

export async function getMaintenanceModeResponse(kind: 'cron' | 'webhook'): Promise<NextResponse | null> {
  const state = await getMaintenanceModeState()
  if (!state.enabled) return null
  return buildMaintenanceModeResponse(kind, state)
}
