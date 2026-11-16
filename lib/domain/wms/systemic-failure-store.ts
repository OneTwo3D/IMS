import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { notify } from '@/lib/notifications'
import {
  parseSystemicState,
  type SystemicFailureStore,
  type SystemicIncident,
  type SystemicState,
} from '@/lib/domain/wms/systemic-failure'

/** The sweeps the breaker guards. The name is part of the persisted key, so it is a contract. */
export const SYSTEMIC_SWEEPS = ['order-push', 'order-push-verify', 'dispatch'] as const
export type SystemicSweep = (typeof SYSTEMIC_SWEEPS)[number]

/** Where a sweep's breaker state persists, per connector. One row, and the row IS the incident. Reserved: see reserved-setting-keys.ts. */
export function systemicFailureStateKey(connector: string, sweep: string): string {
  return `wms_systemic_failure:${connector}:${sweep}`
}

const SWEEP_LABEL: Record<(typeof SYSTEMIC_SWEEPS)[number], string> = {
  'order-push': 'Order push',
  'order-push-verify': 'Order push verification',
  dispatch: 'Dispatch sync',
}

/**
 * The database side of the breaker.
 *
 * ONE incident per sweep per connector: the state row carries the open marker, so a fault that lasts a hundred passes announces
 * itself once (and once more if the suppression bound runs out), not a hundred times. Admins are notified individually, never
 * broadcast: a broadcast would expose connector detail to READONLY and SUPPLIER users.
 */
export function createDbSystemicFailureStore(connector: string): SystemicFailureStore {
  return {
    async load(sweep) {
      const row = await db.setting.findUnique({ where: { key: systemicFailureStateKey(connector, sweep) }, select: { value: true } })
      return parseSystemicState(row?.value)
    },
    async save(sweep, state) {
      const key = systemicFailureStateKey(connector, sweep)
      const value = JSON.stringify(state)
      await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
      return true
    },
    async raise(incident: SystemicIncident) {
      const label = (SWEEP_LABEL as Record<string, string>)[incident.sweep] ?? incident.sweep
      await logActivity({
        entityType: 'SYSTEM',
        tag: 'sync',
        action: incident.kind === 'escalate' ? 'wms_systemic_failure_isolating' : 'wms_systemic_failure',
        level: 'ERROR',
        description: `${label} (${incident.connector}): ${incident.message}`,
        metadata: {
          connector: incident.connector,
          sweep: incident.sweep,
          consecutive: incident.consecutive,
          attempted: incident.outcomes.attempted,
          failed: incident.outcomes.failed,
          exhausted: incident.outcomes.exhausted,
          reason: incident.reason,
        },
        resolveUser: false,
      })
      const admins = await db.user.findMany({ where: { role: 'ADMIN', active: true }, select: { id: true } })
      await Promise.all(admins.map((admin) => notify({
        userId: admin.id,
        type: 'error',
        title: incident.kind === 'escalate' ? `${label}: isolating records again` : `${label}: connector-wide failure`,
        message: incident.message,
        actionUrl: '/sync/exceptions',
      })))
    },
    async resolve({ sweep, connector: resolvedConnector, consecutive }) {
      const label = (SWEEP_LABEL as Record<string, string>)[sweep] ?? sweep
      await logActivity({
        entityType: 'SYSTEM',
        tag: 'sync',
        action: 'wms_systemic_failure_resolved',
        description: `${label} (${resolvedConnector}) is working again after ${consecutive} connector-wide failure pass(es); records that were left alone were retried automatically.`,
        metadata: { connector: resolvedConnector, sweep, consecutive },
        resolveUser: false,
      })
    },
  }
}

export type SystemicFailureIncidentRow = {
  connector: string
  sweep: string
  label: string
  openedAt: string
  lastSeenAt: string | null
  consecutive: number
  attempted: number
  failed: number
  exhausted: number
  /** True once the suppression bound ran out and the sweep is isolating per record again. */
  isolating: boolean
  reason: string | null
}

/** The open incidents for the given connectors: what /sync/exceptions shows. An incident exists exactly while its state row carries the open marker. */
export async function loadSystemicFailureIncidents(connectors: readonly string[]): Promise<SystemicFailureIncidentRow[]> {
  if (connectors.length === 0) return []
  const keys = systemicIncidentKeys(connectors)
  const rows = await db.setting.findMany({ where: { key: { in: keys.map((entry) => entry.key) } }, select: { key: true, value: true } })
  return buildSystemicIncidents(keys, new Map(rows.map((row) => [row.key, row.value])))
}

/** Every state key the inbox reads: one per connector per sweep in SYSTEMIC_SWEEPS, so a sweep added there cannot be missed. */
export function systemicIncidentKeys(connectors: readonly string[]) {
  return connectors.flatMap((connector) => SYSTEMIC_SWEEPS.map((sweep) => ({ connector, sweep, key: systemicFailureStateKey(connector, sweep) })))
}

/** Pure: the open incidents among the stored rows. */
export function buildSystemicIncidents(
  keys: ReadonlyArray<{ connector: string; sweep: string; key: string }>,
  byKey: ReadonlyMap<string, string>,
): SystemicFailureIncidentRow[] {
  const incidents: SystemicFailureIncidentRow[] = []
  for (const entry of keys) {
    const state: SystemicState = parseSystemicState(byKey.get(entry.key))
    if (state.incidentOpenedAt === null) continue
    incidents.push({
      connector: entry.connector,
      sweep: entry.sweep,
      label: (SWEEP_LABEL as Record<string, string>)[entry.sweep] ?? entry.sweep,
      openedAt: state.incidentOpenedAt,
      lastSeenAt: state.lastSeenAt,
      consecutive: state.consecutive,
      attempted: state.attempted,
      failed: state.failed,
      exhausted: state.exhausted,
      isolating: state.isolating,
      reason: state.reason,
    })
  }
  return incidents
}
