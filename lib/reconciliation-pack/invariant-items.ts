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

const DOMAINS = ['inventory', 'accounting', 'sales'] as const
type Domain = (typeof DOMAINS)[number]
type Finding = Record<string, unknown> & { severity: string; code: string }
type DomainReport = { findings: Finding[]; summary: { total: number; warning: number; critical: number } }

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const inconclusive = (id: InvariantItemId, ...reasons: PackReasonCode[]): ItemInput => ({ id, outcome: 'inconclusive', reasons, sources: [...getPackItem(id).sources] })

/** One domain's report, or the closed reason it cannot be used. */
function readDomain(evidence: unknown, domain: Domain): DomainReport | PackReasonCode {
  if (!isObject(evidence) || !isObject(evidence.result) || !isObject(evidence.result.reports)) return 'SOURCE_UNREADABLE'
  const report = evidence.result.reports[domain]
  if (!isObject(report) || !Array.isArray(report.findings) || !isObject(report.summary)) return 'SOURCE_UNREADABLE'
  const { total, warning, critical } = report.summary
  if (!isCount(total) || !isCount(warning) || !isCount(critical)) return 'SOURCE_UNREADABLE'
  const findings: Finding[] = []
  for (const finding of report.findings as unknown[]) {
    if (!isObject(finding) || typeof finding.severity !== 'string' || typeof finding.code !== 'string') return 'SOURCE_UNREADABLE'
    findings.push(finding as Finding)
  }
  // Positive proof the report ran to the end: the flag is the boolean false, no marker finding, and the summary counts
  // exactly what is listed (a count above the list means findings that cannot be read one by one).
  if (report.truncated === true || findings.some((finding) => finding.code === INVARIANT_TRUNCATED_CODE)) return 'CAP_EXCEEDED'
  if (report.truncated !== false) return 'READ_INCOMPLETE'
  const count = (severity: string) => findings.filter((finding) => finding.severity === severity).length
  if (findings.length !== total || count('critical') !== critical || count('warning') !== warning) return 'READ_INCOMPLETE'
  return { findings, summary: { total, warning, critical } }
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
  const inventory = readDomain(evidence, 'inventory')
  if (typeof inventory === 'string') return inconclusive(id, inventory)
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
  if (!isObject(evidence) || !isObject(evidence.result)) return inconclusive(id, 'SOURCE_UNREADABLE')
  const result = evidence.result
  // The run as a whole must have finished: a partial run lists whatever it could and says nothing about the rest.
  if (result.status !== 'completed' || !Array.isArray(result.errors) || result.errors.length > 0) return inconclusive(id, 'SOURCE_UNREADABLE')
  const reports: Array<{ domain: Domain; report: DomainReport }> = []
  for (const domain of DOMAINS) {
    const report = readDomain(evidence, domain)
    if (typeof report === 'string') return inconclusive(id, report)
    reports.push({ domain, report })
  }
  // Every critical finding must be enumerated: the run's own totals may not count more than the reports list.
  const total = isObject(result.summary) && isObject(result.summary.total) ? result.summary.total : null
  const listedCritical = reports.reduce((sum, { report }) => sum + report.summary.critical, 0)
  if (total === null || !isCount(total.critical) || total.critical !== listedCritical || !Array.isArray(result.criticalFindings) || result.criticalFindings.length !== listedCritical) return inconclusive(id, 'READ_INCOMPLETE')

  const ims: SideRow[] = []
  const vendor: SideRow[] = []
  const seen = new Set<string>()
  for (const { domain, report } of reports) {
    for (const finding of report.findings) {
      if (finding.severity === 'info') continue
      if (finding.severity !== 'critical' && finding.severity !== 'warning') return inconclusive(id, 'SOURCE_UNREADABLE')
      const token = findingToken(domain, finding)
      if (seen.has(token)) continue // the gate counts one warning per id, and so does the pack
      seen.add(token)
      let allowed = '0'
      if (finding.severity === 'warning') {
        const warning = { id: invariantWarningId(domain, finding as Parameters<typeof invariantWarningId>[1]), message: '' }
        if (dispositionOf(warning, ctx.acceptances, ctx.phase, ctx.now).accepted) allowed = '1'
      }
      const key = [{ kind: 'sku' as const, raw: token }]
      ims.push({ key, value: '1' })
      vendor.push({ key, value: allowed })
    }
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
