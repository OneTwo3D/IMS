/**
 * LOST EVIDENCE, SAID OUT LOUD: a shadow IMS could not record.
 *
 * Every producer seam that shadows work writes a row to `outbound_shadow_writes`, and a failed write is LOST EVIDENCE, never lost work:
 * the producer still queues nothing and the business change still commits. That is the right trade, but it must not be silent.
 * This is the one place the failure is reported: to the process log, and to the activity log under a fixed action, which
 * `npm run outbound:status` counts (exit code `shadow-unrecorded`) so an installation that is losing its shadow evidence cannot look clean.
 *
 * Best-effort by construction: it never throws and never waits for the activity log (a caller may be inside a transaction on the same
 * pool), so reporting cannot itself turn lost evidence into a failed business change.
 */

export const OUTBOUND_SHADOW_UNRECORDED_ACTION = 'outbound_shadow_unrecorded'

export function reportUnrecordedShadow(input: { destination: string; operation: string; subject: string; error: unknown }): void {
  const reason = input.error instanceof Error ? input.error.message : String(input.error)
  console.error(`[producer-hold] could not record the shadow of ${input.destination}.${input.operation} for ${input.subject}: ${reason}`)
  void (async () => {
    try {
      const { logActivity } = await import('@/lib/activity-log')
      await logActivity({
        entityType: 'SYSTEM',
        action: OUTBOUND_SHADOW_UNRECORDED_ACTION,
        tag: 'sync',
        level: 'WARNING',
        description: `IMS did not send ${input.destination}.${input.operation} for ${input.subject} and could not keep a record that it would have: ${reason}`,
        metadata: { destination: input.destination, operation: input.operation, subject: input.subject },
        resolveUser: false,
      })
    } catch {
      // The process log above is the record of last resort.
    }
  })()
}
