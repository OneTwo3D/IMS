import { sweepUnprocessedMintsoftBookedInEvents } from '@/lib/connectors/mintsoft/sync/booked-in-handler'

export type ProcessMintsoftBookedInEventsResult = Awaited<ReturnType<typeof sweepUnprocessedMintsoftBookedInEvents>>

export async function processMintsoftBookedInEvents(): Promise<ProcessMintsoftBookedInEventsResult> {
  return sweepUnprocessedMintsoftBookedInEvents()
}
