/**
 * COMPACTION KEEPS THE PER-ACCOUNT NET THE A2 POSTING PROOF NEEDS.
 *
 * The posting proof (`proveAllocationDebitPosting`, `proveJournalPosting`) asks ONE question of a
 * journal's lines: the NET movement of ONE account code in ONE direction. Retention's compaction
 * (`backReferenceEvidenceCompactedAt`) drops the whole payload from a journal row it keeps, so a
 * legitimately old journal used to become permanently unprovable and the proof failed closed.
 *
 * The answer to that question is two numbers per account the journal touched, not the journal. So
 * compaction now writes `AccountingSyncLog.payloadAccountNets` in the SAME statement that empties the
 * payload, and the proof reads it when the payload is gone.
 *
 * Properties this module guarantees, each pinned by a test:
 *   - the summary is derived by calling `extractPayloadNetMovement` itself, per account and per
 *     direction, so a summary read gives the SAME NUMBER the full payload would (no second spelling of
 *     the arithmetic to drift);
 *   - it holds account codes and two totals each, nothing personal (the journal's descriptions and
 *     references are not kept), which is why it may outlive the payload;
 *   - a summary that is not exactly the shape written here is NOT READABLE (`null`), never a partial or
 *     a zero: an unreadable row is one that cannot be checked, which the proof refuses.
 *
 * Rows compacted BEFORE this column existed have neither payload nor summary and stay unprovable (the
 * proof fails closed, as before). There is no backfill: the payload they would be derived from no
 * longer exists.
 */

/**
 * The account's NET movement across a journal payload's own lines, in the direction the caller
 * names. Net, never gross: a batch journal can touch one account on BOTH sides (two settings roles
 * mapped to the same code, a reconciliation rounding line), and a gross read lets a share be
 * "inside its batch" against a journal that moved the account a fraction of that.
 *
 * An empty account code is not a match — an unconfigured account would otherwise sum every line
 * whose own accountCode is blank (o3d-o97 r2).
 */
export function extractPayloadNetMovement(
  payload: unknown,
  accountCode: string,
  side: 'credit' | 'debit',
): number {
  if (!accountCode) return 0
  const linesPayload = (payload as { lines?: Array<{ accountCode?: string; debit?: number; credit?: number }> } | null)?.lines
  if (!Array.isArray(linesPayload)) return 0
  return linesPayload.reduce((sum, line) => {
    if (line.accountCode !== accountCode) return sum
    const debit = boundaryNumber(line.debit ?? 0)
    const credit = boundaryNumber(line.credit ?? 0)
    return sum + (side === 'credit' ? credit - debit : debit - credit)
  }, 0)
}

function boundaryNumber(value: unknown): number {
  if (value === null || value === undefined) return 0
  const parsed = typeof value === 'number' ? value : Number((value as { toString(): string }).toString())
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Whether a sync row still carries readable journal lines. Compaction drops `payload` from a row it
 * keeps, so a settled row can be present with nothing readable on it — which is an ANSWER ("finished,
 * outcome no longer legible"), not an error.
 */
export function payloadLinesLegible(payload: unknown): boolean {
  return Array.isArray((payload as { lines?: unknown } | null)?.lines)
}

/** Version of the stored summary shape. A reader refuses any other value. */
export const ACCOUNT_NETS_VERSION = 1

export type AccountNetSummary = {
  version: typeof ACCOUNT_NETS_VERSION
  /** Keyed by account code. An account the journal did not touch is absent (its net is 0). */
  accounts: Record<string, { credit: number; debit: number }>
}

/**
 * Sync-row types whose payload is a journal (`lines` carrying debit/credit) that a proof or relief
 * reader consumes. Compaction REQUIRES a summary for these before it drops the payload; every other
 * type (invoices, bills, credit notes ...) is compacted as before and has no summary.
 *
 * The three reversals are read by the refund relief arithmetic; the DAILY_BATCH_* family are the
 * batch journals (A2 is DAILY_BATCH_INVENTORY_ALLOC); the *_JOURNAL types are per-document journals.
 */
export const JOURNAL_PAYLOAD_SYNC_TYPES: readonly string[] = [
  'DAILY_BATCH_INVENTORY_ALLOC',
  'DAILY_BATCH_GROUP_B',
  'DAILY_BATCH_REVENUE_DEFERRAL',
  'DAILY_BATCH_INVENTORY_RECONCILIATION',
  'DAILY_BATCH_COGS_RECONCILIATION',
  'DAILY_BATCH_TRANSIT_RECONCILIATION',
  'ALLOCATION_REVERSAL',
  'COGS_REVERSAL',
  'UNEARNED_REV_REVERSAL',
  'COGS_JOURNAL',
  'MANUFACTURING_JOURNAL',
  'REALISED_FX_JOURNAL',
  'UNREALISED_FX_JOURNAL',
]

export function isJournalPayloadSyncType(type: string): boolean {
  return JOURNAL_PAYLOAD_SYNC_TYPES.includes(type)
}

/**
 * The summary of a journal payload, or `null` when the payload is not a legible journal (no `lines`
 * array, or a line that is not an object, which `extractPayloadNetMovement` could not read either).
 * `null` is "cannot summarise", and the caller must then NOT drop the payload.
 */
export function summariseAccountNets(payload: unknown): AccountNetSummary | null {
  if (!payloadLinesLegible(payload)) return null
  const lines = (payload as { lines: unknown[] }).lines
  const codes = new Set<string>()
  for (const line of lines) {
    if (line === null || typeof line !== 'object' || Array.isArray(line)) return null
    const code = (line as { accountCode?: unknown }).accountCode
    if (typeof code === 'string' && code !== '') codes.add(code)
  }
  const accounts: AccountNetSummary['accounts'] = {}
  for (const code of codes) {
    accounts[code] = {
      credit: normaliseZero(extractPayloadNetMovement(payload, code, 'credit')),
      debit: normaliseZero(extractPayloadNetMovement(payload, code, 'debit')),
    }
  }
  return { version: ACCOUNT_NETS_VERSION, accounts }
}

// JSON has no negative zero; keep the in-memory value equal to what a database round trip returns.
function normaliseZero(value: number): number {
  return value === 0 ? 0 : value
}

/**
 * Strictly parse a stored summary. Anything that is not exactly `{ version: 1, accounts: { code:
 * { credit: finite, debit: finite } } }` is `null` (unreadable), so a damaged or foreign value can
 * never be read as a smaller or a zero movement.
 */
export function readAccountNets(raw: unknown): AccountNetSummary | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const candidate = raw as { version?: unknown; accounts?: unknown }
  if (candidate.version !== ACCOUNT_NETS_VERSION) return null
  const accounts = candidate.accounts
  if (accounts === null || typeof accounts !== 'object' || Array.isArray(accounts)) return null
  const out: AccountNetSummary['accounts'] = {}
  for (const [code, entry] of Object.entries(accounts as Record<string, unknown>)) {
    if (code === '' || entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null
    const { credit, debit } = entry as { credit?: unknown; debit?: unknown }
    if (typeof credit !== 'number' || !Number.isFinite(credit)) return null
    if (typeof debit !== 'number' || !Number.isFinite(debit)) return null
    out[code] = { credit, debit }
  }
  return { version: ACCOUNT_NETS_VERSION, accounts: out }
}

/** A journal row as the net readers see it: the payload and, once compacted, its preserved summary. */
export type JournalNetSource = { payload: unknown; payloadAccountNets?: unknown }

/** True when the row's net movement can be read: from its own lines, or failing that its summary. */
export function journalNetsReadable(row: JournalNetSource): boolean {
  return payloadLinesLegible(row.payload) || readAccountNets(row.payloadAccountNets) !== null
}

/**
 * The account's NET movement in the named direction for one journal row: from the payload's own
 * lines while they exist, else from the preserved summary. `null` when neither is readable. With the
 * payload gone and a valid summary the result equals what the payload gave, including 0 for an
 * account the journal never touched.
 */
export function journalNetMovement(
  row: JournalNetSource,
  accountCode: string,
  side: 'credit' | 'debit',
): number | null {
  if (payloadLinesLegible(row.payload)) return extractPayloadNetMovement(row.payload, accountCode, side)
  const summary = readAccountNets(row.payloadAccountNets)
  if (!summary) return null
  if (!accountCode) return 0
  return summary.accounts[accountCode]?.[side] ?? 0
}
