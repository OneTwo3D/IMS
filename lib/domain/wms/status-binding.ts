import type { WmsOrderStatus } from '@/lib/connectors/wms/types'

/**
 * o3d-rbyg r4 (Codex r3 finding 2) — IS THIS ANSWER ABOUT *THIS* LINK'S WMS ORDER?
 *
 * `fetchOrderStatus` takes an ORDER NUMBER. A number is a lookup key, not an identity: it is
 * renameable at the WMS, it is reused, and a merge survivor answers under a combined number it has
 * folded several of ours into. So a status record that came back is evidence about SOME order until
 * it has been bound to this one — and every irreversible thing downstream (a shipment, stock
 * consumed, a despatch email that cannot be unsent) is decided from it.
 *
 * The rule, in one place because two callers apply it: `reconcileOneOrder`, which had it inline, and
 * the operator's "record the despatch" remedy in the exception inbox, which read the status itself
 * and had NO binding at all — so a rename or a collision could have it confirm the wrong parcel and
 * then dispatch this link on the strength of it.
 *
 *   • THE STABLE ID IS THE BINDING when we hold one. A different id means a different order.
 *   • A MERGE IS THE ONE LEGITIMATE ID CHANGE, and only when the survivor authoritatively NAMES our
 *     number among the ones it absorbed AND exactly one link claims that number. On a shared number
 *     nobody can say which order was absorbed, so it refuses rather than guessing.
 *   • WHEN THE NUMBER IS ALL WE HAVE — a link with no stored stable id — this can only say that the
 *     record is not DISPROVED. `numberAnsweredAs` is how a caller that looked the order up BY NUMBER
 *     adds the one check that is then available: the answer came back under a different number, so
 *     it is about something else. The sweep does not pass it, and must not: its preloaded rows are
 *     keyed by stable id, and a RENAMED order legitimately answers under a number the link has never
 *     heard of — refusing that would break the rename path this fence was built beside.
 *
 * Refusal is `unresolved`, never "pending and clean": the question was asked and could not be
 * answered, which must hold the watermark rather than age the change out of the window.
 */
export type WmsStatusBinding =
  | { bound: true; mergeProvenByNumber: boolean }
  | { bound: false; reason: string }

export function bindWmsStatusToCandidate(
  status: WmsOrderStatus,
  candidate: { externalOrderNumber: string; externalOrderId?: string | null },
  // Whether this link's order number is claimed by EXACTLY ONE link on the connector.
  // `undefined` = the connector cannot count claimants, which preserves the pre-guard behaviour.
  mergeNumberUnique?: boolean,
  // Set ONLY by a caller whose record came from a by-NUMBER lookup. See the note above: a stable-ID
  // preload may legitimately answer under a different number, so this is the caller's fact to state.
  options?: { lookedUpByNumber?: boolean },
): WmsStatusBinding {
  const mergeProvenByNumber =
    status.isMerged
    && status.mergedOrderNumbers.includes(candidate.externalOrderNumber)
    && mergeNumberUnique !== false

  const expectedExternalOrderId = candidate.externalOrderId || null
  if (expectedExternalOrderId && status.externalOrderId !== expectedExternalOrderId && !mergeProvenByNumber) {
    return {
      bound: false,
      reason: `Order-number lookup returned stable ID ${status.externalOrderId || 'unknown'}; expected ${expectedExternalOrderId}`,
    }
  }

  if (status.isMerged && status.externalOrderNumber !== candidate.externalOrderNumber && !mergeProvenByNumber) {
    return {
      bound: false,
      reason:
        `Merge survivor ${status.externalOrderNumber} does not unambiguously name ${candidate.externalOrderNumber} `
        + '— refusing to repoint on number evidence alone',
    }
  }

  if (
    options?.lookedUpByNumber
    && !expectedExternalOrderId
    && !status.isMerged
    && status.externalOrderNumber
    && status.externalOrderNumber !== candidate.externalOrderNumber
  ) {
    return {
      bound: false,
      reason: `Order-number lookup for ${candidate.externalOrderNumber} answered as ${status.externalOrderNumber}`,
    }
  }

  return { bound: true, mergeProvenByNumber }
}
