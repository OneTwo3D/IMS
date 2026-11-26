/**
 * THE INBOUND-DELTA CURSOR STATE, PER CONNECTOR (o3d-remove-shiphero round 2, Codex HIGH 2).
 *
 * WHAT WENT WRONG. The dispatch sweep wires `getDeltaState`/`saveDeltaState` for ANY connector
 * that implements `fetchOrderDelta`, and it used to wire them to functions that named ONE
 * warehouse's setting rows: `mintsoft_order_delta_since`, `mintsoft_order_reconcile_at`,
 * `mintsoft_order_delta_generation`, guarded by Mintsoft's dispatch-settings row lock. A second
 * connector with a bulk delta therefore inherited MINTSOFT'S WATERMARK. That is not an error an
 * operator can see: a watermark is a claim that "every changed order up to this instant has been
 * applied", so a stale Mintsoft watermark makes the new connector's first sweep SKIP ITS ENTIRE
 * BACKLOG and report a clean pass. Silent non-fulfilment, not a visible failure.
 *
 * THE FIX IS A NAMESPACE, not a check. There is no key a second connector can share with the
 * first, so the mix-up cannot be expressed rather than being detected after the fact. The keys are
 * DERIVED from the connector id, so registering a connector mints its own cursor rows, its own
 * generation chain and its own scope lock with no edit here and no way to forget.
 *
 * The generation/stamp machinery below is unchanged from the Mintsoft-named originals it replaces
 * (o3d-hl8l r5/r6) — it was never Mintsoft-specific, only Mintsoft-named. See the notes on each
 * function for why a cursor that cannot be attributed to the current reset generation is treated as
 * ABSENT rather than trusted.
 */

/** The three Setting rows one connector's inbound delta owns. Never shared, never derivable twice. */
export type WmsDeltaCursorKeys = {
  /** The watermark: every order changed up to this instant has been applied. */
  since: string
  /** The last full-reconcile sweep instant. */
  reconcile: string
  /** The reset generation in force. Bumped once per committed cursor reset. */
  generation: string
}

/**
 * This connector's cursor rows.
 *
 * `mintsoft` reproduces the three key names that already exist in every deployment
 * (`mintsoft_order_delta_since` / `_order_reconcile_at` / `_order_delta_generation`), so this is a
 * pure refactor for the shipped connector and a fresh, empty chain for any other.
 */
export function wmsDeltaCursorKeys(connectorId: string): WmsDeltaCursorKeys {
  return {
    since: `${connectorId}_order_delta_since`,
    reconcile: `${connectorId}_order_reconcile_at`,
    generation: `${connectorId}_order_delta_generation`,
  }
}

/** The connector's own delta settings, also namespaced: enable flag and API timezone. */
export function wmsDeltaSettingKeys(connectorId: string): { enabled: string; timeZone: string } {
  return {
    enabled: `${connectorId}_inbound_delta_enabled`,
    timeZone: `${connectorId}_api_timezone`,
  }
}

/**
 * The stored generation as a number.
 *
 * ABSENT (or empty) IS ZERO, not unknown: only the reset writes this row, so no row means no reset
 * has ever committed, which is a fact and not a gap. A row that is present but NOT a non-negative
 * integer is `null` — genuinely unattributable — and every caller treats that as "apply no change",
 * because a value nobody can order cannot establish that a cursor write is current.
 */
export function parseWmsDeltaGeneration(raw: string | null | undefined): number | null {
  if (raw == null) return 0
  const trimmed = String(raw).trim()
  if (trimmed === '') return 0
  if (!/^\d+$/.test(trimmed)) return null
  const parsed = Number.parseInt(trimmed, 10)
  return Number.isSafeInteger(parsed) ? parsed : null
}

/**
 * The generation a committing reset writes. An unreadable current value starts the chain again at 1
 * rather than propagating the garbage — every run holding the unreadable value is refused anyway
 * (it carries `null`), and every run holding a real number disagrees with 1 unless the chain really
 * is that short.
 */
export function nextWmsDeltaGeneration(current: number | null): number {
  return (current ?? 0) + 1
}

/**
 * o3d-hl8l r6 (Codex r5 finding 3) — THE GENERATION HAS TO TRAVEL WITH THE CLAIM.
 *
 * The fence `saveWmsDeltaCursors` arms is a compare-and-swap inside our own code: a run hands back
 * the generation it read, the write re-reads it under the scope lock, and a mismatch discards the
 * advance. That works for every writer that RUNS THAT CODE. A rolling deploy — or a rollback — puts
 * a second instance in front of the SAME database running a BUILD FROM BEFORE THE FENCE, and that
 * instance does not merely fail to attribute its write: it never asks the question at all.
 *
 * SO THE CHECK MOVES INTO THE VALUE. A cursor row stores the generation it was written under
 * alongside the instant it claims, and the READER refuses a cursor it cannot attribute to the
 * generation currently in force — treating it as ABSENT, which restarts the delta from the lookback
 * window rather than trusting a watermark established under a scope this installation has since
 * abandoned. Discarding a watermark costs one wider, idempotent Order/List window; trusting a stale
 * one that is LATER than anything the current scope fetched skips every order in between, for ever,
 * and nothing says so.
 */
export type WmsDeltaCursorRefusal = 'absent' | 'unstamped' | 'unreadable' | 'superseded'

export type WmsDeltaCursorDecode =
  | { value: string; refusal: null }
  | { value: null; refusal: WmsDeltaCursorRefusal }

/**
 * The stored form of a cursor: the instant it claims, and the reset generation in force when the
 * run that claimed it started. JSON rather than a delimiter because the instant is operator-visible
 * in `settings` and a delimiter would have to be one an ISO timestamp can never contain.
 */
export function encodeWmsDeltaCursor(generation: number, at: string): string {
  return JSON.stringify({ g: generation, at })
}

/**
 * Decode a stored cursor against the generation currently in force.
 *
 * Every "no" is NAMED, because they mean different things to whoever reads the log: `unstamped` is
 * an instance that does not participate in the scheme (a pre-fence build, or the one-time
 * migration); `unreadable` is a stamped value nobody can order; `superseded` is a stamp from a
 * generation the reset chain has moved past. All four produce the same conservative answer.
 */
export function decodeWmsDeltaCursor(
  raw: string | null | undefined,
  currentGeneration: number | null,
): WmsDeltaCursorDecode {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  if (!trimmed) return { value: null, refusal: 'absent' }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    // A bare ISO timestamp lands here: it is what every build before this fence wrote.
    return { value: null, refusal: 'unstamped' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { value: null, refusal: 'unstamped' }
  }

  const record = parsed as Record<string, unknown>
  const at = typeof record.at === 'string' ? record.at.trim() : ''
  const stamped = typeof record.g === 'number' && Number.isSafeInteger(record.g) && record.g >= 0 ? record.g : null
  if (!at || stamped === null) return { value: null, refusal: 'unreadable' }

  // A generation row nobody can order cannot establish that a cursor is current, which is the same
  // rule `saveWmsDeltaCursors` applies to the write side.
  if (currentGeneration === null || stamped !== currentGeneration) {
    return { value: null, refusal: 'superseded' }
  }
  return { value: at, refusal: null }
}
