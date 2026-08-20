import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

const MAINTENANCE_ENABLED_KEY = 'system_maintenance_mode'
const MAINTENANCE_REASON_KEY = 'system_maintenance_reason'

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
  await Promise.all([
    setSetting(MAINTENANCE_ENABLED_KEY, 'false'),
    setSetting(MAINTENANCE_REASON_KEY, ''),
  ])
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
