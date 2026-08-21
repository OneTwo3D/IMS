import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const MAINTENANCE_ENABLED_KEY = 'system_maintenance_mode'
export const MAINTENANCE_REASON_KEY = 'system_maintenance_reason'

/**
 * o3d-hl8l r5 (Codex r4 finding 1) — THE ROW THAT MAKES A HELD WINDOW SOMETHING AN OPERATOR CAN
 * SEE AND END.
 *
 * `disableMaintenanceMode` is not called when a restore times out and its database backend cannot be
 * confirmed gone: the flag deliberately stays on, because releasing the fences while a backend may
 * still be replaying is the state they exist to prevent. Until now that left NOTHING to act on. The
 * flag was a bare `'true'` in `settings` with no screen, so the recovery was an operator finding the
 * error text, reasoning about what it meant, and running SQL — and because the flag was then cleared
 * OUTSIDE `disableMaintenanceMode`, no `wms_booked_in_recheck_due_since` marker was ever stamped, so
 * every callback the fence refused during that window fell all the way back to the watchdog's
 * days-scale alert. The one branch that most needed the recovery was the one branch it skipped.
 *
 * This row is that branch's durable record: WHY the flag is held, WHEN, and — the part that makes
 * ending it checkable rather than a guess — WHICH database backend has to be gone first. The
 * exception inbox renders it and offers the action; the action re-reads this row under a lock,
 * re-checks the backend against `pg_stat_activity`, and refuses if either has moved. See
 * lib/domain/system/maintenance-recovery.ts.
 *
 * IT IS BEST-EFFORT, and the code that writes it says so. It is written after the restore's database client has
 * been SIGKILLed, so `--single-transaction` means the backend rolls back rather than commits — but
 * "rather than commits" is not "cannot still be replaying", and a write issued into that window can
 * be lost. A lost row is a held window with no inbox entry, which is exactly the position this
 * branch was already in, so it degrades to the old behaviour rather than to something worse.
 */
export const MAINTENANCE_HOLD_KEY = 'system_maintenance_hold'

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

/**
 * o3d-hl8l r6 (Codex r5 finding 1) — OPENING A WINDOW SUPERSEDES ANY HOLD RECORDED BEFORE IT.
 *
 * A recorded hold used to outlive the restore it described. The row said "maintenance mode is held
 * because backend 4242 could not be confirmed gone", and it kept saying that while a SECOND restore
 * started, turned the same flag on for its own reasons, and began replaying. The "End the hold"
 * action then re-read that row, found the flag on and backend 4242 long gone, and cleared maintenance
 * mode — over a live restore. Every check it performed passed, because every check was about the
 * FIRST restore.
 *
 * A hold record is now scoped to the window it was recorded in: opening a window deletes it, in the
 * SAME transaction that sets the flag. What survives is the invariant the action already relies on —
 * the flag on with NO hold row is a restore that is still running, and is refused by name. So a
 * second restore starting between the render and the click turns the click into
 * `no_hold_recorded` rather than into an unfenced database.
 *
 * ONE TRANSACTION AND ONE KEY ORDER. The two writes were a `Promise.all` of independent upserts, so
 * a reader could see the flag on with the reason of the previous window (or vice versa). The keys
 * are touched in sorted order, the same order `lockRecoveryRows` locks them in, so this and the
 * recovery actions cannot deadlock against each other — and because the hold delete needs the row
 * lock the recovery action holds, the two are serialized rather than interleaved.
 */
export async function enableMaintenanceMode(reason: string) {
  await db.$transaction(async (tx) => {
    // Sorted: system_maintenance_hold < system_maintenance_mode < system_maintenance_reason.
    await tx.setting.deleteMany({ where: { key: { in: [MAINTENANCE_HOLD_KEY] } } })
    for (const [key, value] of [
      [MAINTENANCE_ENABLED_KEY, 'true'],
      [MAINTENANCE_REASON_KEY, reason],
    ] as ReadonlyArray<readonly [string, string]>) {
      await tx.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
    }
  })
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

/**
 * Persist the hold record described on `MAINTENANCE_HOLD_KEY`. Best-effort by contract: the caller
 * is on a failure path whose whole premise is that the database may still be being written to, and
 * losing the record must not replace the operator's diagnosis with a second failure.
 */
export async function recordMaintenanceHold(detail: {
  reason: string
  backendPid: number
  backendStart: string
  applicationName: string
  heldAt?: string
}): Promise<boolean> {
  try {
    await setSetting(MAINTENANCE_HOLD_KEY, JSON.stringify({
      heldAt: detail.heldAt ?? new Date().toISOString(),
      reason: detail.reason,
      backendPid: detail.backendPid,
      backendStart: detail.backendStart,
      applicationName: detail.applicationName,
    }))
    return true
  } catch (error) {
    console.error('[maintenance-mode] could not record the maintenance hold:', error)
    return false
  }
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
