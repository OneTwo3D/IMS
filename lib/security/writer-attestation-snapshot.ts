/**
 * THE OWNER'S CONFIRMATIONS AS THE PRODUCER DECISION SEES THEM: a synchronous, in-process snapshot.
 *
 * The producer decision (producer-disposition.ts) is pure and synchronous: no database. The confirmation that Qoblex's Xero posting is stopped lives in the
 * database (WriterAttestation), so a long-running server process keeps a snapshot of which kinds are in force and refreshes it in the background
 * (`startAttestationRefresh`, started from instrumentation.ts). FAIL CLOSED: before the first successful read, and after a failed one that leaves nothing
 * known, no kind is in force. A refresh that fails keeps the last good snapshot only for its own lifetime (a confirmation is append-only and never withdrawn).
 * A caller (a test, a command) may hand the decision its own set through `context.attestations`, which wins over the snapshot.
 */

import { WRITER_ATTESTATION_KINDS } from './writer-attestation-constants'

let snapshot: ReadonlySet<string> | null = null
let timer: ReturnType<typeof setInterval> | null = null

export const ATTESTATION_REFRESH_MS = 30_000

export function attestationInForce(kind: string, supplied?: ReadonlySet<string>): boolean {
  const source = supplied ?? snapshot
  return source !== null && source.has(kind)
}

/** For the refresh and for tests. */
export function setAttestationSnapshot(kinds: ReadonlySet<string> | null): void {
  snapshot = kinds
}

type Reader = { writerAttestation: { findFirst(args: { where: { kind: string }; select: { id: true } }): Promise<{ id: string } | null> } }

export async function refreshAttestationSnapshot(db: Reader): Promise<void> {
  const kinds = new Set<string>()
  for (const kind of WRITER_ATTESTATION_KINDS) {
    if (await db.writerAttestation.findFirst({ where: { kind }, select: { id: true } })) kinds.add(kind)
  }
  snapshot = kinds
}

/** Start the background refresh of a server process (idempotent). A read that throws leaves the previous snapshot as it was. */
export function startAttestationRefresh(load: () => Promise<Reader>): void {
  if (timer !== null) return
  const tick = (): void => { void load().then(refreshAttestationSnapshot).catch(() => undefined) }
  tick()
  timer = setInterval(tick, ATTESTATION_REFRESH_MS)
  timer.unref?.()
}
