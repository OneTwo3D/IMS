import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * A COUNT OF THE REMOTE WRITES ONE UNIT OF WORK ACTUALLY DISPATCHED, kept in async context so the transport can feed it without knowing who is asking.
 *
 * A queued job can make more than one write in one claim (a completion sends tracking, then the status; a stock push sends a batch). When a LATER
 * write is refused by the outbound-write hold, the job's error is a hold, but an EARLIER write of the same claim already left, so "the only outcome is a
 * hold" is false. The hold branch of the outbox may withdraw the job's first-attempt stamp only on proof that this claim sent NOTHING, and this ledger
 * is that proof: the transport counts a write immediately BEFORE it dispatches (so a count can only be too high, never too low), and a claim that
 * ran outside a ledger has no proof and keeps its stamp.
 */
export type WriteLedger = { writes: number }

const storage = new AsyncLocalStorage<WriteLedger>()

export function createWriteLedger(): WriteLedger {
  return { writes: 0 }
}

export function runInWriteLedger<T>(ledger: WriteLedger, fn: () => Promise<T>): Promise<T> {
  return storage.run(ledger, fn)
}

/** Called by the transport immediately before it dispatches a request that is not a read. A no-op outside a ledger. */
export function noteRemoteWriteDispatched(method: string): void {
  const upper = method.toUpperCase()
  if (upper === 'GET' || upper === 'HEAD' || upper === 'OPTIONS') return
  const ledger = storage.getStore()
  if (ledger) ledger.writes += 1
}
