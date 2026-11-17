import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * o3d-hqvrp.380: where the server-side minimum-margin guard sits in the PO actions. Source-level, in the repo's usual style:
 * the behaviour of each is tested through the real actions elsewhere; this pins the ORDER (guard before any write) and the
 * absence of a client-trusting path.
 */
const src = readFileSync('app/actions/purchase-orders.ts', 'utf8')
const fn = (name: string) => {
  const start = src.indexOf(`export async function ${name}`)
  assert.ok(start > 0, name)
  const next = src.indexOf('\nexport async function ', start + 10)
  return src.slice(start, next < 0 ? undefined : next)
}

test('create: assessed from the stored costs before the transaction, refused before any write, system imports skipped, override recorded in the transaction', () => {
  const body = fn('createPurchaseOrder')
  const guard = body.indexOf('decideGuard(')
  assert.ok(guard > 0)
  assert.ok(body.indexOf('calcLineTotals(') < guard, 'the cost is computed by the server first')
  assert.ok(guard < body.indexOf('db.$transaction'))
  assert.match(body, /if \(session\) \{/)
  assert.match(body, /if \(system\?\.systemImportToken !== SYSTEM_IMPORT\) await requirePermission\('purchasing\.create'\)/)
  assert.match(body, /const session = system\?\.systemImportToken !== SYSTEM_IMPORT \? await requireAuth\(\) : null/)
  assert.ok(body.indexOf('recordMarginOverride(') > body.indexOf('tx.purchaseOrder.create('))
  assert.ok(body.indexOf('recordMarginOverride(') < body.indexOf('postCommitWarnings'))
})

test('update: facts read before the transaction, refusal THROWN inside it (rolls the line delete back), assessed before the lines are written', () => {
  const body = fn('updatePurchaseOrder')
  assert.ok(body.indexOf('loadMarginGuardContext(') < body.indexOf('db.$transaction'))
  assert.match(body, /throw new MarginBlockedError\(outcome\.message\)/)
  assert.ok(body.indexOf('await enforceMargin(lineData)') < body.indexOf('tx.purchaseOrderLine.createMany({ data: lineData })'))
  assert.match(body, /locked\.type !== 'GOODS'/)
  assert.match(body, /catch \(e\) \{\s*if \(e instanceof MarginBlockedError\) return \{ success: false, error: e\.message \}/)
  // an amend assesses only lines it adds or reprices, and before any of its writes
  assert.ok(body.indexOf('await enforceMargin([...amendMarginRows') < body.indexOf('tx.purchaseOrderLine.deleteMany({ where: { poId: id, id: { in: plan.remove'))
})

test('placing the order: assessed under the row lock from the stored line costs, before the status write; only PO_SENT', () => {
  const body = fn('advancePoStatus')
  assert.ok(body.indexOf("targetStatus === 'PO_SENT' && existing.type === 'GOODS'") > 0)
  assert.ok(body.indexOf('reloadMarginGuardContextUnderLock(tx') > body.indexOf('FOR UPDATE') || body.indexOf('lockLandedCostRevaluationScope') >= 0)
  assert.ok(body.indexOf('reloadMarginGuardContextUnderLock(tx') < body.indexOf('decideGuard('))
  assert.ok(body.indexOf('decideGuard(') < body.indexOf('await tx.purchaseOrder.update({ where: { id }, data })'))
  assert.match(body, /tx\.purchaseOrderLine\.findMany\(\{ where: \{ poId: id \}, select: \{ productId: true, unitCostBase: true \}/)
  assert.match(body, /payload\?\.marginOverrideNote/)
  const confirm = fn('confirmAndSendPurchaseOrder')
  assert.match(confirm, /marginOverrideNote/)
})

test('the client never supplies a margin: the guard reads the product price and the stored unit cost, and takes only a note from the caller', () => {
  const guard = readFileSync('lib/domain/purchasing/margin-threshold-guard.ts', 'utf8')
  assert.match(guard, /loadListPriceFacts/)
  assert.doesNotMatch(guard, /marginPct\s*:\s*input|input\.marginPct|clientMargin/)
  assert.match(guard, /hasPermission\(opts\.role, OVERRIDE_PERMISSION\)/)
})

test('amend: a raised quantity on a received, billed or returned line is assessed at its stored cost', () => {
  const body = fn('updatePurchaseOrder')
  assert.match(body, /if \(k\.qtyChanged && req\.qty > k\.fact\.qty\) amendMarginRows\.push\(\{ productId: row\.productId, unitCostBase: k\.fact\.unitCostBase \}\)/)
})
