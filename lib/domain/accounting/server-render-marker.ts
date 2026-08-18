/**
 * THE SERVER-RENDER MARKER, and exactly what a client may conclude from it
 * (o3d-osl8 round 7 finding 3, corrected in round 8 finding 4).
 *
 * `router.refresh()` returns void. It reports no completion, it can be served from cache, and it
 * can fail — so after calling it a client component knows only that it ASKED. Round 7 gave the
 * server-rendered page a per-render marker and let the banner compare the marker it currently has
 * against the one in effect when the refresh was requested, so that "the rows were reloaded" became
 * an observation instead of an assumption.
 *
 * WHAT THAT COMPARISON ACTUALLY PROVED, and what it was read as proving. `a !== b` establishes that
 * a DIFFERENT render's payload has arrived. It does not establish that the render happened AFTER
 * the cancel: a render already in flight when the operator pressed the button carries a marker
 * generated before the cancel ran, and arrives afterwards — satisfying the check while showing rows
 * that were read before anything was cancelled. The banner then described those rows as the
 * server's current answer, in the one branch where a destructive action may have committed.
 *
 * TWO CHANGES, one mechanical and one honest.
 *
 *   1. ORDERING. The marker is a monotonically increasing number rather than an opaque string, and
 *      the comparison is `>`, not `!==`. An OLDER payload arriving late — a cached RSC response, an
 *      out-of-order delivery — can no longer count as a refresh merely by differing.
 *
 *   2. THE CLAIM IS WEAKER, because genuine causality is not achievable here and pretending
 *      otherwise is the defect being fixed. To prove the rows were read after the cancel, the
 *      client would need an upper bound, in SERVER time, on when the cancel finished. The branch
 *      that needs this is the one where the action REJECTED — no return value, and in production an
 *      opaque digest — and its worst case is a reply lost after the server transaction committed,
 *      which by construction can land at any point after the client gave up, including after any
 *      later render. There is no value the server can hand back for an attempt whose reply never
 *      arrived. So the banner now says a NEWER render arrived, says plainly that this is not proof
 *      the rows reflect the attempt, and keeps sending the operator to the activity log.
 *
 * A render marker rather than a hash of the rows, for the same reason as before: a cancellation
 * that changed nothing legitimately leaves identical rows, and content equality would report a
 * completed refresh as never having happened.
 */

/**
 * A source of strictly increasing markers.
 *
 * Wall-clock-seeded so markers from different server workers stay comparable (they read the same
 * machine clock), and clamped upward so an NTP step backwards — or two renders inside the same
 * millisecond — cannot produce a value that is not greater than the last one this worker issued.
 * Across workers that clamp is per-process, which is the honest limit of it: the ordering is exact
 * within a worker and clock-accurate between them.
 */
export function createServerRenderMarkerSource(now: () => number = Date.now): () => number {
  let last = 0
  return () => {
    const candidate = now()
    last = candidate > last ? candidate : last + 1
    return last
  }
}

/** The process-wide source. One per server worker; see the note above. */
export const nextServerRenderMarker = createServerRenderMarkerSource()

export type ServerRenderObservation = {
  /**
   * A render STRICTLY NEWER than the one in effect when the refresh was requested has reached this
   * component.
   *
   * This is NOT "the rows reflect the action". It rules out the two things it can rule out — that
   * nothing arrived at all, and that what arrived was older than what was already on screen — and
   * nothing else. Wording that goes further is the round-7 defect.
   */
  newerRenderArrived: boolean
}

export function observeServerRender(input: {
  /** The marker on the payload currently rendered. */
  current: number
  /** The marker in effect at the moment `router.refresh()` was called. */
  whenRequested: number
}): ServerRenderObservation {
  return { newerRenderArrived: input.current > input.whenRequested }
}
