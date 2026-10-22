import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

import { compareItem, type CompareInput, type CompareResult } from '../../lib/reconciliation-pack/compare.ts'
import { PACK_ITEM_IDS, getPackItem, type PackItemId } from '../../lib/reconciliation-pack/constants.ts'
import { outcomeOfComparison } from '../../lib/reconciliation-pack/compare.ts'
import type { ItemInput } from '../../lib/reconciliation-pack/report.ts'
import type { KeyPart } from '../../lib/reconciliation-pack/identity.ts'

// Report directories must sit under ancestors only root or this account can modify; the unit runner's private
// TMPDIR is group/other-writable, so these live under /var/tmp (a root-owned sticky directory).
export function scratchDir(bases: string[], prefix = 'recon-pack-'): string {
  const dir = mkdtempSync(path.join('/var/tmp', prefix))
  chmodSync(dir, 0o700)
  bases.push(dir)
  return dir
}
export function cleanup(bases: string[]): void {
  for (const dir of bases.splice(0)) rmSync(dir, { recursive: true, force: true })
}

export const NOW = new Date('2026-10-20T12:00:00.000Z')
export const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000)

export const key = (sku: string, warehouse = 'MAIN'): KeyPart[] => [{ kind: 'sku', raw: sku }, { kind: 'warehouse', raw: warehouse }]

/** A pass that carries the proof, the sources and (with allBrackets) the stream stamps a real pass would. */
export function passItem(id: PackItemId): ItemInput {
  return { id, outcome: 'pass', reasons: [], proof: { kind: 'proven-empty', source: 'snapshot-run-row-present' }, sources: [...getPackItem(id).sources] }
}
export const STAMP = '2026-10-19T00:00:00.000Z'
export const allBrackets = (stamp: string = STAMP) => (['woocommerce-order-sweep', 'mintsoft-stock-sync', 'mintsoft-dispatch-poll', 'mintsoft-order-status', 'xero-balance-snapshots', 'xero-tax-rates'] as const).map((stream) => ({ stream, start: stamp, end: stamp }))

/** An item input built from a real comparison, the way a runner will build one. */
export function itemFromComparison(id: PackItemId, input: Partial<Omit<CompareInput, 'mode' | 'tolerance'>> & Pick<CompareInput, 'ims' | 'vendor'>): { item: ItemInput; result: CompareResult } {
  const result = compareItem(id, { imsComplete: true, vendorComplete: true, ...input })
  const verdict = outcomeOfComparison(result)
  const proof = verdict.outcome === 'pass' && result.status === 'compared' ? result.proof : null
  return { item: { id, outcome: verdict.outcome, reasons: verdict.reasons, proof, sources: [...getPackItem(id).sources], entries: result.status === 'compared' ? result.buckets : undefined }, result }
}

export function allFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? allFiles(full) : [full]
  })
}
export function readAll(dir: string): Array<{ file: string; text: string }> {
  return allFiles(dir).map((file) => ({ file, text: readFileSync(file, 'utf8') }))
}
export function mode(file: string): number {
  return statSync(file).mode & 0o777
}
export { PACK_ITEM_IDS }

type Finding = Record<string, unknown>
/** An invariant result in the REAL shape (every count consistent), carrying the given inventory findings. */
export function realEvidence(inventoryFindings: Finding[] = []): Record<string, unknown> {
  const n = (severity: string) => inventoryFindings.filter((f) => f.severity === severity).length
  const counts = { total: inventoryFindings.length, info: n('info'), warning: n('warning'), critical: n('critical') }
  const empty = { total: 0, info: 0, warning: 0, critical: 0 }
  const plain = { findings: [], summary: empty }
  return {
    ok: counts.critical === 0,
    // The proof lib/reconciliation-pack/invariant-snapshot.ts attaches when the run read one REPEATABLE READ READ ONLY snapshot.
    snapshot: { isolation: 'repeatable read', readOnly: true, snapshot: '812:812:', boundToApplicationClient: true },
    result: {
      status: 'completed', errors: [],
      // As lib/cron/invariant-check.ts toCriticalFinding builds them (JSON drops the undefined ids).
      criticalFindings: inventoryFindings.filter((f) => f.severity === 'critical').map((f) => JSON.parse(JSON.stringify({ domain: 'inventory', code: f.code, message: f.message, details: f.details, productId: f.productId, warehouseId: f.warehouseId, orderId: f.orderId, shipmentId: f.shipmentId, refundId: f.refundId, syncLogId: f.syncLogId }))),
      summary: { total: counts, inventory: counts, accounting: empty, sales: empty },
      reports: { inventory: { findings: inventoryFindings, truncated: false, nextCursor: null, summary: counts }, accounting: plain, sales: plain },
    },
  }
}
