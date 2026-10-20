import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

import { compareKeyed, type CompareInput, type CompareResult } from '../../lib/reconciliation-pack/compare.ts'
import { PACK_ITEM_IDS, type PackItemId } from '../../lib/reconciliation-pack/constants.ts'
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

export function passItem(id: PackItemId): ItemInput {
  return { id, outcome: 'pass', reasons: [] }
}

/** An item input built from a real comparison, the way a runner will build one. */
export function itemFromComparison(id: PackItemId, input: Partial<CompareInput> & Pick<CompareInput, 'ims' | 'vendor'>): { item: ItemInput; result: CompareResult } {
  const result = compareKeyed({ imsComplete: true, vendorComplete: true, tolerance: { rule: 'exact' }, ...input })
  const verdict = outcomeOfComparison(result)
  return { item: { id, outcome: verdict.outcome, reasons: verdict.reasons, entries: result.status === 'compared' ? result.buckets : undefined }, result }
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
