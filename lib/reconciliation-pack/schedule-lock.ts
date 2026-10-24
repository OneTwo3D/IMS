import { RECONCILIATION_PACK_SCHEDULE_SETTINGS_LOCK_KEY } from '@/lib/db/advisory-locks'

/**
 * The settings fence of the scheduled pack: call FIRST inside a transaction that writes (or reads, for the runner's final read) the
 * job's enable switch, schedule, phase or vendor-reads option. Transaction-scoped, so it is released at commit or rollback.
 */
export async function lockPackScheduleSettings(tx: { $executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => PromiseLike<unknown> }): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${RECONCILIATION_PACK_SCHEDULE_SETTINGS_LOCK_KEY})`
}
