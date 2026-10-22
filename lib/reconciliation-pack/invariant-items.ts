/**
 * ITEMS R3, R4 AND R15, FROM THE INVARIANT REPORT.
 *
 * The readiness gate already runs the invariant report and reads these three claims off it (lib/ops/readiness-gate.ts
 * derivePackItemFromInvariant). The pack reads the SAME report but turns each claim into a keyed comparison, so a finding
 * is an identity in the evidence, not a sentence.
 *
 *   R3  each stock level the report flags (code stock_cost_layer_quantity_mismatch) is the pair
 *       (product id, warehouse id) with the stock quantity and the remaining cost-layer quantity that disagree.
 *   R4  the same, for stock_reserved_source_mismatch: the reserved quantity and the known reservation sources.
 *   R15 each critical finding and each warning is named by a DIGEST of the gate's warning id (the id carries product, order
 *       and sync-log ids and is never printed). The IMS side is 1 (the finding is in the report). The other side is the
 *       number the claim ALLOWS: 0 for a critical finding (an acceptance never applies to a failure) and for a warning with
 *       no current written acceptance, 1 for a warning the acceptance file covers. A finding the claim does not allow
 *       differs; an accepted warning is an equal identity, so a report whose only findings are accepted warnings passes
 *       on "compared", and a report with none passes on the named proof that it ran to the end and lists nothing.
 *
 * A pass needs POSITIVE proof that the report ran to the end: the domain is present, not truncated (the flag must be the
 * boolean false, an absent flag is not a "no"), carries no truncation marker, and its summary counts exactly the findings
 * it lists. Anything else is inconclusive with a closed code, never a pass and never a fail on a partial list. The
 * module is total: whatever shape `evidence` has, it returns an item and never throws.
 */

import { createHash } from 'node:crypto'

import { Prisma } from '@/app/generated/prisma/client'
import type { ReadinessPhase } from '@/lib/ops/readiness-gate-constants'
import { INVARIANT_TRUNCATED_CODE, R3_CODE, R4_CODE, dispositionOf, invariantWarningId, type AcceptanceFile } from '@/lib/ops/readiness-gate'
import { compareItem, outcomeOfComparison, type CompareResult, type SideRow } from '@/lib/reconciliation-pack/compare'
import { getPackItem, type PackReasonCode } from '@/lib/reconciliation-pack/constants'
import type { ItemInput } from '@/lib/reconciliation-pack/report'

export type InvariantItemContext = { phase: ReadinessPhase; now: Date; acceptances: AcceptanceFile }
export type InvariantItemId = 'R3' | 'R4' | 'R15'

/** Findings that say a scan stopped at its cap: the list is a prefix, so nothing may pass on it. */
const CAP_MARKER_CODES: ReadonlySet<string> = new Set([INVARIANT_TRUNCATED_CODE, 'refund_status_reconciliation_row_cap_reached', 'refund_basis_audit_row_cap_reached'])

/** The ids that name a finding's subject in the gate's identity (lib/ops/readiness-gate.ts findingSubject). */
const SUBJECT_KEYS = ['productId', 'warehouseId', 'orderId', 'shipmentId', 'refundId', 'syncLogId'] as const

/**
 * Every subject id is absent (undefined, or null as the inventory SQL rows carry it) or a NON-EMPTY string. The gate's identity
 * drops a falsy id, so an empty string would read as absent and could match an acceptance written for another identity.
 */
const hasReadableSubject = (finding: Record<string, unknown>) => SUBJECT_KEYS.every((key) => finding[key] === undefined || finding[key] === null || (typeof finding[key] === 'string' && finding[key] !== ''))

/** The codes R3 and R4 compare; only the inventory report may list them. */
const STOCK_CLAIM_CODES: ReadonlySet<string> = new Set([R3_CODE, R4_CODE])

const SEVERITIES: ReadonlySet<string> = new Set(['info', 'warning', 'critical'])

const DOMAINS = ['inventory', 'accounting', 'sales'] as const
type Domain = (typeof DOMAINS)[number]
type Finding = Record<string, unknown> & { severity: string; code: string }

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const inconclusive = (id: InvariantItemId, ...reasons: PackReasonCode[]): ItemInput => ({ id, outcome: 'inconclusive', reasons, sources: [...getPackItem(id).sources] })

type Counts = { total: number; info: number; warning: number; critical: number }
const COUNT_KEYS = ['total', 'info', 'warning', 'critical'] as const
type DomainReport = { findings: Finding[]; summary: Counts }

/** All four counts of a summary, each a whole number, or null: a missing or malformed count is never zero. */
function readCounts(value: unknown): Counts | null {
  if (!isObject(value)) return null
  const { total, info, warning, critical } = value
  return isCount(total) && isCount(info) && isCount(warning) && isCount(critical) ? { total, info, warning, critical } : null
}
const sameCounts = (left: Counts, right: Counts) => COUNT_KEYS.every((key) => left[key] === right[key])

/** One domain's report, or the closed reason it cannot be used. Every count it states must equal what it lists. */
function readDomain(reports: Record<string, unknown>, domain: Domain): DomainReport | PackReasonCode {
  const report = reports[domain]
  if (!isObject(report) || !Array.isArray(report.findings)) return 'SOURCE_UNREADABLE'
  const summary = readCounts(report.summary)
  if (summary === null) return 'SOURCE_UNREADABLE'
  const findings: Finding[] = []
  for (const finding of report.findings as unknown[]) {
    if (!isObject(finding) || typeof finding.severity !== 'string' || typeof finding.code !== 'string' || finding.code === '') return 'SOURCE_UNREADABLE'
    // A severity this module does not know is a finding it cannot judge: no item may pass beside it.
    if (!SEVERITIES.has(finding.severity)) return 'SOURCE_UNREADABLE'
    // The subject ids make up the finding's identity; one present but not a string is an identity nobody can read.
    if (!hasReadableSubject(finding)) return 'SOURCE_UNREADABLE'
    findings.push(finding as Finding)
  }
  // Positive proof the report ran to the end: the flag is the boolean false, no marker finding, and the summary counts
  // exactly what is listed (a count above the list means findings that cannot be read one by one).
  if (report.truncated === true || findings.some((finding) => CAP_MARKER_CODES.has(finding.code))) return 'CAP_EXCEEDED'
  // Only the inventory report carries the flag, and for it a missing flag is not a "no". The accounting and sales reports have
  // no such field (they say so with a marker finding, above), so for them it may be absent but never anything but false.
  if (domain === 'inventory' ? report.truncated !== false : report.truncated !== undefined && report.truncated !== false) return 'READ_INCOMPLETE'
  // A cursor left over means there was more to read.
  if (report.nextCursor !== undefined && report.nextCursor !== null && report.nextCursor !== '') return 'READ_INCOMPLETE'
  const count = (severity: string) => findings.filter((finding) => finding.severity === severity).length
  if (!sameCounts(summary, { total: findings.length, info: count('info'), warning: count('warning'), critical: count('critical') })) return 'READ_INCOMPLETE'
  return { findings, summary }
}

/**
 * The whole run, validated field by field. It read one snapshot (the proof the CLI attaches); every domain's counts equal its listed findings; the run's own summary (the total
 * and each domain's) equals the sum of what the reports list, count by count; the critical findings it lists are exactly the
 * reports' critical findings, identity by identity; and `ok` is a boolean that says what the findings say. Anything else is inconclusive, never a pass.
 */
function readRun(evidence: unknown): { reports: Record<Domain, DomainReport>; run: Record<string, unknown> } | PackReasonCode {
  if (!isObject(evidence) || !isObject(evidence.result) || !isObject(evidence.result.reports)) return 'SOURCE_UNREADABLE'
  // The run must have read ONE database state (invariant-snapshot.ts): reports taken at different instants can each be clean while
  // no single state was. No proof, or any part of it different, is never a pass.
  const proof = (evidence as Record<string, unknown>).snapshot
  if (!isObject(proof) || proof.isolation !== 'repeatable read' || proof.readOnly !== true || proof.boundToApplicationClient !== true || typeof proof.snapshot !== 'string' || proof.snapshot === '') return 'READ_INCOMPLETE'
  const result = evidence.result
  if (result.status !== 'completed' || !Array.isArray(result.errors) || result.errors.length > 0) return 'SOURCE_UNREADABLE'
  const reports = {} as Record<Domain, DomainReport>
  for (const domain of DOMAINS) {
    const report = readDomain(result.reports as Record<string, unknown>, domain)
    if (typeof report === 'string') return report
    reports[domain] = report
  }
  // R3 and R4 read their claims from the inventory report alone (the only producer of these codes). One listed under another
  // domain is a report this module cannot place: the readiness gate would see it there, the pack would not, so nothing passes.
  for (const domain of DOMAINS) {
    if (domain !== 'inventory' && reports[domain].findings.some((finding) => STOCK_CLAIM_CODES.has(finding.code))) return 'SOURCE_UNREADABLE'
  }
  if (!isObject(result.summary)) return 'READ_INCOMPLETE'
  const sum: Counts = { total: 0, info: 0, warning: 0, critical: 0 }
  for (const domain of DOMAINS) {
    const stated = readCounts(result.summary[domain])
    if (stated === null || !sameCounts(stated, reports[domain].summary)) return 'READ_INCOMPLETE'
    for (const key of COUNT_KEYS) sum[key] += reports[domain].summary[key]
  }
  const total = readCounts(result.summary.total)
  if (total === null || !sameCounts(total, sum)) return 'READ_INCOMPLETE'
  // The critical findings the run lists must be EXACTLY the critical findings the reports list, as a multiset of the gate's
  // finding identity (domain, code and subject ids), duplicates included. Equal counts are not enough: a list naming one
  // finding twice and another not at all has the right length and still hides a failure.
  if (!Array.isArray(result.criticalFindings)) return 'READ_INCOMPLETE'
  const owed = new Map<string, number>()
  for (const domain of DOMAINS) {
    for (const finding of reports[domain].findings) {
      if (finding.severity !== 'critical') continue
      const identity = invariantWarningId(domain, finding as Parameters<typeof invariantWarningId>[1])
      owed.set(identity, (owed.get(identity) ?? 0) + 1)
    }
  }
  for (const entry of result.criticalFindings as unknown[]) {
    if (!isObject(entry) || typeof entry.domain !== 'string' || !(DOMAINS as readonly string[]).includes(entry.domain) || typeof entry.code !== 'string' || entry.code === '') return 'READ_INCOMPLETE'
    // A subject id that is present must be a string: anything else would print as some other identity.
    if (!hasReadableSubject(entry)) return 'READ_INCOMPLETE'
    const identity = invariantWarningId(entry.domain, entry as Parameters<typeof invariantWarningId>[1])
    const left = owed.get(identity) ?? 0
    if (left === 0) return 'READ_INCOMPLETE'
    owed.set(identity, left - 1)
  }
  if ([...owed.values()].some((left) => left !== 0)) return 'READ_INCOMPLETE'
  // `ok` must be exactly the boolean the findings imply (a missing or non-boolean value is never equal to it).
  if ((evidence as Record<string, unknown>).ok !== (sum.critical === 0)) return 'READ_INCOMPLETE'
  return { reports, run: result }
}

/** A plain decimal text for a stored quantity, or undefined (the comparator then refuses the row; nothing is defaulted). */
function quantityText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return new Prisma.Decimal(value).toFixed()
  return undefined
}

function fromComparison(id: InvariantItemId, result: CompareResult): ItemInput {
  const verdict = outcomeOfComparison(result)
  const proof = verdict.outcome === 'pass' && result.status === 'compared' ? result.proof : null
  return { id, outcome: verdict.outcome, reasons: verdict.reasons, proof, sources: [...getPackItem(id).sources], entries: result.status === 'compared' ? result.buckets : undefined }
}

const CLAIMS: Record<'R3' | 'R4', { code: string; ims: string; vendor: string }> = {
  R3: { code: R3_CODE, ims: 'quantity', vendor: 'remainingCostLayerQty' },
  R4: { code: R4_CODE, ims: 'reservedQty', vendor: 'knownReservedQty' },
}

function stockClaim(id: 'R3' | 'R4', evidence: unknown): ItemInput {
  const run = readRun(evidence)
  if (typeof run === 'string') return inconclusive(id, run)
  const inventory = run.reports.inventory
  const claim = CLAIMS[id]
  const ims: SideRow[] = []
  const vendor: SideRow[] = []
  for (const finding of inventory.findings) {
    if (finding.code !== claim.code) continue
    const details = isObject(finding.details) ? finding.details : {}
    const key = [{ kind: 'ims-id' as const, raw: finding.productId }, { kind: 'ims-id' as const, raw: finding.warehouseId }]
    ims.push({ key, value: quantityText(details[claim.ims]) })
    vendor.push({ key, value: quantityText(details[claim.vendor]) })
  }
  const result = compareItem(id, { ims, vendor, imsComplete: true, vendorComplete: true, emptyProof: 'invariant-report-clean' })
  // The report flagged these pairs. If the pack's own comparison calls one EQUAL, the two disagree about the same numbers and
  // nothing may pass on that: it is unreadable, not a pass and not a finding the evidence could show.
  if (result.status === 'compared' && result.buckets.bothEqual.length > 0) return inconclusive(id, 'SOURCE_UNREADABLE')
  return fromComparison(id, result)
}

/** The name R15 gives a finding: a digest of the gate's warning id, in the form of a SKU token the sanitiser prints as it is. */
export function findingToken(domain: string, finding: { code: string }): string {
  return `finding-${createHash('sha256').update(invariantWarningId(domain, finding as Parameters<typeof invariantWarningId>[1]), 'utf8').digest('hex').slice(0, 20)}`
}

function allFindings(id: 'R15', evidence: unknown, ctx: InvariantItemContext): ItemInput {
  const run = readRun(evidence)
  if (typeof run === 'string') return inconclusive(id, run)
  const reports = DOMAINS.map((domain) => ({ domain, report: run.reports[domain] }))

  // The gate counts one finding per identity, and so does the pack. The identity carries no severity, so a warning and a
  // critical finding can share one: the claim then allows the STRICTEST of them (0 if any is critical or unaccepted), never
  // whichever came first, so an accepted warning can never hide a critical finding.
  const allowedByToken = new Map<string, '0' | '1'>()
  for (const { domain, report } of reports) {
    for (const finding of report.findings) {
      if (finding.severity === 'info') continue
      if (finding.severity !== 'critical' && finding.severity !== 'warning') return inconclusive(id, 'SOURCE_UNREADABLE')
      const token = findingToken(domain, finding)
      let allowed: '0' | '1' = '0'
      if (finding.severity === 'warning') {
        const warning = { id: invariantWarningId(domain, finding as Parameters<typeof invariantWarningId>[1]), message: '' }
        if (dispositionOf(warning, ctx.acceptances, ctx.phase, ctx.now).accepted) allowed = '1'
      }
      allowedByToken.set(token, allowedByToken.get(token) === '0' ? '0' : allowed)
    }
  }
  const ims: SideRow[] = []
  const vendor: SideRow[] = []
  for (const [token, allowed] of allowedByToken) {
    const key = [{ kind: 'sku' as const, raw: token }]
    ims.push({ key, value: '1' })
    vendor.push({ key, value: allowed })
  }
  return fromComparison(id, compareItem(id, { ims, vendor, imsComplete: true, vendorComplete: true, emptyProof: 'invariant-report-clean' }))
}

export function runInvariantItem(id: InvariantItemId, evidence: unknown, ctx: InvariantItemContext): ItemInput {
  try {
    return id === 'R15' ? allFindings(id, evidence, ctx) : stockClaim(id, evidence)
  } catch {
    return inconclusive(id, 'INTERNAL_ERROR')
  }
}
