import {
  MAINTENANCE_ENABLED_KEY,
  MAINTENANCE_HOLD_KEY,
  MAINTENANCE_REASON_KEY,
  WMS_BOOKED_IN_RECHECK_DUE_KEY,
} from '@/lib/maintenance-mode'

/**
 * o3d-hl8l r5 (Codex r4 finding 1) — A REFUSAL NEEDS A REMEDY AN OPERATOR CAN PERFORM, AND ONE
 * NOBODY CAN SEE IS A SILENT FAILURE.
 *
 * WHAT WAS STILL WRONG AFTER ROUND 4. Round 4 made a refused booked-in callback recover itself:
 * `disableMaintenanceMode` stamps `wms_booked_in_recheck_due_since` when a window closes, and the
 * warehouse webhook sweeper drains that stamp within about five minutes by re-checking every open
 * ASN. That is real, and it covers the ordinary window. It does not cover the branch the whole fence
 * exists for.
 *
 * When a restore times out and its database backend CANNOT be confirmed gone, the endpoint holds the
 * lock, holds maintenance mode, and never calls `disableMaintenanceMode` at all. So on that branch:
 *
 *   • NO STAMP IS EVER WRITTEN, because the only writer of it is the function this branch skips —
 *     so the automatic re-check does not run, not once, no matter how long the operator waits;
 *   • THE FLAG IS CLEARED BY HAND, in SQL, with no screen (`hasOperatorControl` was false), which
 *     also means it is cleared without ANY of the other work `disableMaintenanceMode` does;
 *   • AND NOTHING SAYS SO. The refusals themselves are unrecordable by construction (the fence runs
 *     before signature verification, and rows written into the window are replayed over), so the
 *     only trace was a process-log line — invisible from the application, and gone with the next log
 *     rotation.
 *
 * The intersection was: a held restore, an operator who cleared the flag the only way available to
 * them, and every callback refused during the window recoverable ONLY by the watchdog's days-scale
 * alert or by remembering to press Re-check on each ASN. On the branch that is BY FAR the most
 * likely to have refused something, because it is the branch where the window lasted longest.
 *
 * WHAT THIS MODULE ADDS, in the shape o3d-rbyg used for withdrawals: a durable row the inbox
 * renders, and two operator actions that RE-READ STATE UNDER THE LOCK AND REFUSE IF THE PRECONDITION
 * DOES NOT HOLD, rather than trusting that the button was rendered for a good reason.
 *
 *   1. END THE HOLD (`endMaintenanceHold`). Refuses unless maintenance mode is really still on;
 *      refuses unless a hold record is really there (a flag on for a restore that is simply still
 *      RUNNING must not be cleared — that would unfence the webhooks mid-restore, which is the
 *      original defect); and refuses while the named backend is still attached, checked against
 *      `pg_stat_activity` by `(pid, backend_start)` at the moment of the click. When it does clear
 *      the flag it STAMPS THE RE-CHECK MARKER in the same transaction, so this branch finally gets
 *      the automatic recovery every other window has had since round 4.
 *
 *   2. RUN THE RE-CHECK NOW (`claimPostMaintenanceRecheck`). Refuses while maintenance mode is on
 *      (a re-check issued into the window is fenced at the cron gate anyway, and any row it produced
 *      would be replayed over), and refuses when no window is actually pending. It exists because
 *      the automatic drain lives on a cron: an installation that has disabled or broken that cron
 *      has no other way to run it, and "wait five minutes" is not an answer an operator can verify.
 *
 * THE CHECK IS A RE-READ, NOT A REFRESH OF WHAT THE PAGE SHOWED. Both transitions take the settings
 * rows `FOR UPDATE` first and decide only from what they read there. The inbox row that produced the
 * click may be seconds or hours old; a second operator may have acted already; the backend may have
 * exited or, worse, may not have. None of that is knowable from the button.
 *
 * WHAT THE BACKEND CHECK IS AND IS NOT. `(pid, backend_start)` is the pair the restore endpoint
 * itself uses, and it is the right one: a pid alone is reused, and `application_name` is a GUC the
 * replayed SQL can change. What it cannot do is prove the restore's EFFECTS are finished — only that
 * the backend that was applying them is gone, which is precisely the condition the operator message
 * asks for and the one they would otherwise be eyeballing at a database prompt. It is not a substitute for taking
 * the application out of service; the inbox row says so in the same words the error did.
 */

/** Why a maintenance-recovery transition refused. Each names a precondition that was re-read. */
export const MAINTENANCE_RECOVERY_REFUSALS = {
  notInMaintenance: 'not_in_maintenance',
  noHoldRecorded: 'no_hold_recorded',
  holdUnreadable: 'hold_unreadable',
  backendStillRunning: 'backend_still_running',
  backendIndeterminate: 'backend_indeterminate',
  maintenanceModeOn: 'maintenance_mode_on',
  noRecheckDue: 'no_recheck_due',
} as const

export type MaintenanceRecoveryRefusal =
  (typeof MAINTENANCE_RECOVERY_REFUSALS)[keyof typeof MAINTENANCE_RECOVERY_REFUSALS]

/** The durable record the restore endpoint writes when it holds the gate. */
export type MaintenanceHoldRecord = {
  heldAt: string
  reason: string
  backendPid: number
  backendStart: string
  applicationName: string | null
}

/**
 * Parse the stored hold record, or null when it is absent or unusable.
 *
 * A record without a usable `(pid, backend_start)` is UNUSABLE rather than "a hold with no backend":
 * the pair is the only thing that makes ending the hold checkable, and a transition that skipped the
 * check because the evidence was malformed would be the button deciding for itself.
 */
export function parseMaintenanceHoldRecord(raw: string | null | undefined): MaintenanceHoldRecord | null {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  if (!trimmed) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>
  const pid = typeof record.backendPid === 'number' ? record.backendPid : Number.NaN
  const backendStart = typeof record.backendStart === 'string' ? record.backendStart.trim() : ''
  if (!Number.isInteger(pid) || pid <= 0 || !backendStart) return null
  return {
    heldAt: typeof record.heldAt === 'string' ? record.heldAt : '',
    reason: typeof record.reason === 'string' ? record.reason : '',
    backendPid: pid,
    backendStart,
    applicationName: typeof record.applicationName === 'string' ? record.applicationName : null,
  }
}

/** The minimum of a Prisma transaction client this needs. Structural, so a test can supply one. */
export type MaintenanceRecoveryTx = {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>
  setting: {
    upsert(args: {
      where: { key: string }
      create: { key: string; value: string }
      update: { value: string }
    }): Promise<unknown>
    deleteMany(args: { where: { key: { in: string[] } } }): Promise<unknown>
  }
}

/**
 * Materialise the named rows, lock them `FOR UPDATE`, and return what they hold.
 *
 * Same shape and same reasoning as the dispatch-settings row lock: `FOR UPDATE` locks only rows that
 * EXIST, and reading inside a transaction is not enough on its own — Postgres runs READ COMMITTED
 * here, so an unlocked SELECT inside a transaction is exactly as stale as one outside it. The ROW
 * LOCK is what closes the window between deciding and writing.
 *
 * Inserting `''` is inert for every key this touches: `getMaintenanceModeState` compares the flag
 * against `'true'`, the re-check drain treats an empty marker as absent (`value?.trim()`), and an
 * empty hold record parses to null. Sorted, so this and any future locker share one order.
 */
async function lockRecoveryRows(tx: MaintenanceRecoveryTx, keys: string[]): Promise<Map<string, string>> {
  const sorted = [...keys].sort()
  await tx.$executeRaw`
    INSERT INTO settings (key, value, "updatedAt")
    SELECT k, '', now() FROM unnest(${sorted}::text[]) AS k
    ON CONFLICT (key) DO NOTHING`
  const rows = await tx.$queryRaw<Array<{ key: string; value: string | null }>>`
    SELECT key, value FROM settings WHERE key = ANY(${sorted}::text[]) ORDER BY key FOR UPDATE`
  return new Map(rows.map((row) => [row.key, row.value ?? '']))
}

export type EndMaintenanceHoldResult =
  | { ended: true; hold: MaintenanceHoldRecord; recheckDueSince: string }
  | { ended: false; reason: MaintenanceRecoveryRefusal; hold?: MaintenanceHoldRecord }

export type EndMaintenanceHoldDeps = {
  /**
   * Is the restore's database backend still attached? `null` means the question could not be
   * answered, which is refused rather than assumed either way — assuming "gone" clears the fences
   * over a live restore, and assuming "running" would wedge the only remedy behind a transient
   * error with no way to tell the two apart.
   */
  isRestoreBackendAttached: (identity: { pid: number; backendStart: string }) => Promise<boolean | null>
  now?: () => Date
}

export async function endMaintenanceHold(
  tx: MaintenanceRecoveryTx,
  deps: EndMaintenanceHoldDeps,
): Promise<EndMaintenanceHoldResult> {
  const rows = await lockRecoveryRows(tx, [
    MAINTENANCE_ENABLED_KEY,
    MAINTENANCE_REASON_KEY,
    MAINTENANCE_HOLD_KEY,
    WMS_BOOKED_IN_RECHECK_DUE_KEY,
  ])

  if (rows.get(MAINTENANCE_ENABLED_KEY) !== 'true') {
    return { ended: false, reason: MAINTENANCE_RECOVERY_REFUSALS.notInMaintenance }
  }

  const stored = rows.get(MAINTENANCE_HOLD_KEY) ?? ''
  if (!stored.trim()) {
    // The flag is on and NO hold was recorded, which is what an in-progress restore looks like.
    // Clearing it here would unfence the cron jobs and the webhooks in the middle of one — the exact
    // failure the fence exists to prevent — so this is the refusal that matters most.
    return { ended: false, reason: MAINTENANCE_RECOVERY_REFUSALS.noHoldRecorded }
  }
  const hold = parseMaintenanceHoldRecord(stored)
  if (!hold) return { ended: false, reason: MAINTENANCE_RECOVERY_REFUSALS.holdUnreadable }

  const attached = await deps.isRestoreBackendAttached({ pid: hold.backendPid, backendStart: hold.backendStart })
  if (attached === null) return { ended: false, reason: MAINTENANCE_RECOVERY_REFUSALS.backendIndeterminate, hold }
  if (attached) return { ended: false, reason: MAINTENANCE_RECOVERY_REFUSALS.backendStillRunning, hold }

  // An ALREADY-PENDING marker is kept rather than restamped. Its value is the "window ended at"
  // the drain reports, and an older one describes a window that has been owed a re-check for
  // longer; overwriting it would make an un-drained backlog look newer than it is. Only its
  // presence gates the drain, so keeping the earlier value loses nothing.
  const existingMarker = (rows.get(WMS_BOOKED_IN_RECHECK_DUE_KEY) ?? '').trim()
  const recheckDueSince = existingMarker || (deps.now?.() ?? new Date()).toISOString()

  for (const [key, value] of [
    [MAINTENANCE_ENABLED_KEY, 'false'],
    [MAINTENANCE_REASON_KEY, ''],
    // THE HALF THE MANUAL SQL CLEAR ALWAYS MISSED. Without this the window ends with no marker and
    // every callback it refused is nobody's until the watchdog notices, days later.
    [WMS_BOOKED_IN_RECHECK_DUE_KEY, recheckDueSince],
  ] as ReadonlyArray<readonly [string, string]>) {
    await tx.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
  }
  await tx.setting.deleteMany({ where: { key: { in: [MAINTENANCE_HOLD_KEY] } } })

  return { ended: true, hold, recheckDueSince }
}

export type ClaimPostMaintenanceRecheckResult =
  | { due: true; windowEndedAt: string }
  | { due: false; reason: MaintenanceRecoveryRefusal }

/**
 * Establish, under the lock, that a re-check is genuinely owed before one is run by hand.
 *
 * The marker is NOT cleared here. `runPostMaintenanceBookedInRecheck` owns clearing it and clears it
 * only when every open ASN was attempted, so claiming it here would drop the retry that a truncated
 * page or a failed attempt depends on.
 */
export async function claimPostMaintenanceRecheck(
  tx: MaintenanceRecoveryTx,
): Promise<ClaimPostMaintenanceRecheckResult> {
  const rows = await lockRecoveryRows(tx, [MAINTENANCE_ENABLED_KEY, WMS_BOOKED_IN_RECHECK_DUE_KEY])

  if (rows.get(MAINTENANCE_ENABLED_KEY) === 'true') {
    return { due: false, reason: MAINTENANCE_RECOVERY_REFUSALS.maintenanceModeOn }
  }
  const windowEndedAt = (rows.get(WMS_BOOKED_IN_RECHECK_DUE_KEY) ?? '').trim()
  if (!windowEndedAt) return { due: false, reason: MAINTENANCE_RECOVERY_REFUSALS.noRecheckDue }

  return { due: true, windowEndedAt }
}

/** What the exception inbox renders for the maintenance-recovery section. */
export type MaintenanceRecoveryState = {
  hold: (MaintenanceHoldRecord & { maintenanceEnabled: boolean }) | null
  recheckDueSince: string | null
}

/**
 * Read-only view for the inbox. Unlocked deliberately — this is a render, and the actions re-read
 * everything under the lock before acting, so a stale page can cause a refusal but never a wrong
 * write.
 */
export function buildMaintenanceRecoveryState(
  settings: Map<string, string | null>,
): MaintenanceRecoveryState {
  const maintenanceEnabled = settings.get(MAINTENANCE_ENABLED_KEY) === 'true'
  const hold = parseMaintenanceHoldRecord(settings.get(MAINTENANCE_HOLD_KEY) ?? null)
  return {
    // A hold record with the flag already off is not shown: the window is over and the row is
    // debris. Ending it is the only action the row offers, and there is nothing left to end.
    hold: hold && maintenanceEnabled ? { ...hold, maintenanceEnabled } : null,
    recheckDueSince: (settings.get(WMS_BOOKED_IN_RECHECK_DUE_KEY) ?? '').trim() || null,
  }
}

/**
 * How many actionable maintenance-recovery items there are: the hold, and the owed re-check.
 *
 * Lives here rather than beside the loader because `app/actions/*` is `'use server'`, where every
 * export must be an async server action — a synchronous helper exported from there compiles fine and
 * fails the build.
 */
export function countMaintenanceRecovery(state: MaintenanceRecoveryState): number {
  return (state.hold ? 1 : 0) + (state.recheckDueSince ? 1 : 0)
}
