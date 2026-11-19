import { logActivityPersisted } from '@/lib/activity-log'
import type { ReadinessOverrideAuditEntry } from '@/lib/ops/rollout-readiness'

export const READINESS_OVERRIDE_AUDIT_ACTION = 'rollout_readiness.allow_warnings_override'
export const READINESS_OVERRIDE_AUDIT_TAG = 'rollout-readiness'

/**
 * o3d-65f4b: the audit row an `?allowWarnings=true` override writes: who (actor), when, and which warnings.
 * Goes through the activity log, which redacts the description and every metadata value. Resolves to whether
 * the row was actually persisted; the handler does not apply the override when it was not.
 */
export function recordReadinessOverride(entry: ReadinessOverrideAuditEntry): Promise<boolean> {
  return logActivityPersisted({
    entityType: 'SYSTEM',
    action: READINESS_OVERRIDE_AUDIT_ACTION,
    tag: READINESS_OVERRIDE_AUDIT_TAG,
    level: 'WARNING',
    userId: entry.actorId,
    resolveUser: false,
    description: `Administrator overrode ${entry.warnings.length} rollout readiness warning(s) with allowWarnings=true`,
    metadata: { actorId: entry.actorId, at: entry.at, warnings: entry.warnings },
  })
}
