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

export async function getMaintenanceModeResponse(kind: 'cron' | 'webhook'): Promise<NextResponse | null> {
  const state = await getMaintenanceModeState()
  if (!state.enabled) return null

  const body = {
    skipped: true,
    reason: 'maintenance_mode',
    detail: state.reason ?? 'System maintenance in progress.',
  }

  return NextResponse.json(body, { status: kind === 'webhook' ? 503 : 423 })
}
