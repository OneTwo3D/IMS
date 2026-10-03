import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * o3d-nrl4 PR B — THE IN-TRANSIT RESIDUE REACHES EVERY REVALUATION SITE, AND ONLY THROUGH ONE FUNCTION.
 *
 * The recurring shape of this defect class (audit-jz9i, scjz.14, 6oyu.19) is a rule that reaches some
 * revaluation entry points and not others. Three sites revalue a cost layer and journal its inventory
 * delta: the root loop of `recalculateLandedCosts`, the root loop of `recalculateDirectLandedCosts`
 * (no production caller today, applied anyway), and the output recursion of
 * `propagateLandedCostToOutputs`. A site that forgets `capitaliseInTransitResidue` silently strands that
 * site's in-transit share — the defect itself, with no signal.
 *
 * It reads source, so each function body is cut out BY NAME and must contain the call ITSELF: a call that
 * is deleted from one site and added to another cannot satisfy a whole-file count. Every assertion prints
 * the match count it measured, and a control proves the cutter can find nothing.
 */

const SOURCE = readFileSync('lib/domain/purchasing/landed-cost-service.ts', 'utf8')

/** The text of `export async function <name>(` up to the next top-level `export`/`async function`/`function` (or EOF). */
function bodyOf(name: string, source: string = SOURCE): string {
  const start = source.search(new RegExp(`(?:export )?async function ${name}\\(`))
  if (start < 0) return ''
  const rest = source.slice(start + 1)
  const next = rest.search(/\n(?:export )?(?:async )?function |\nexport (?:const|type|async function) /)
  return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next)
}

const SITES = ['recalculateLandedCosts', 'recalculateDirectLandedCosts', 'propagateLandedCostToOutputs'] as const

test('control: the cutter and the call pattern CAN fail — with the call renamed away, no site matches', () => {
  assert.equal(bodyOf('thisFunctionDoesNotExist'), '')
  const stripped = SOURCE.replaceAll('capitaliseInTransitResidue(', 'someOtherFunction(')
  for (const site of SITES) {
    const body = bodyOf(site, stripped)
    assert.ok(body.length > 200, `control precondition: cut ${body.length} chars of ${site}`)
    assert.equal((body.match(/capitaliseInTransitResidue\(/g) ?? []).length, 0)
  }
})

for (const site of SITES) {
  test(`${site} calls capitaliseInTransitResidue exactly once`, () => {
    const body = bodyOf(site)
    assert.ok(body.length > 200, `precondition: cut a ${body.length}-char body for ${site}`)
    const calls = body.match(/capitaliseInTransitResidue\(/g) ?? []
    console.log(`census: ${site} body ${body.length} chars, capitaliseInTransitResidue( matches = ${calls.length}`)
    assert.equal(calls.length, 1, `${site} must call the shared residue helper exactly once`)
  })
}

test('the helper is defined once and its reader is called only from inside it', () => {
  assert.equal((SOURCE.match(/export async function capitaliseInTransitResidue\(/g) ?? []).length, 1)
  const helper = bodyOf('capitaliseInTransitResidue')
  assert.ok(helper.length > 200, `precondition: cut a ${helper.length}-char helper body`)
  const readerCalls = SOURCE.match(/(?:deps|serviceDeps)\.getInTransitTransferLinesForCostLayer\(/g) ?? []
  assert.equal(readerCalls.length, 1, 'the in-transit reader is invoked once in the whole file')
  assert.match(helper, /deps\.getInTransitTransferLinesForCostLayer\(/, 'and that one call is inside the helper')
  assert.match(helper, /loadTransferLineLandedQty\(tx, /, 'the residue is measured past the LANDED quantity (manual receipts AND alignment credit), through tx')
  assert.match(helper, /sliceTransferSnapshotForReceipt\(/, 'with the receipts\' own slicer')
  assert.doesNotMatch(helper, /\bdb\./, 'no pooled client inside the revaluation transaction')
})

test('the residue is ADDED to the inventory delta at the two root sites', () => {
  for (const site of ['recalculateLandedCosts', 'recalculateDirectLandedCosts'] as const) {
    const body = bodyOf(site)
    const adds = body.match(/totalInventoryDelta = totalInventoryDelta\.add\(deltas\.inventoryDelta\)\.add\(residue\.delta\)/g) ?? []
    console.log(`census: ${site} residue adds = ${adds.length}`)
    assert.equal(adds.length, 1, `${site} must fold residue.delta into totalInventoryDelta`)
  }
  const propagate = bodyOf('propagateLandedCostToOutputs')
  const adds = propagate.match(/outDeltas\.inventoryDelta\.add\(outputResidue\.delta\)/g) ?? []
  console.log(`census: propagateLandedCostToOutputs residue adds = ${adds.length}`)
  assert.equal(adds.length, 1)
})
