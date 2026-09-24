import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  compareMintsoftAsnAgainstExpectation,
  describeMintsoftAsnDifference,
  isProofThatMintsoftAsnIsNotThisOne,
  requireMintsoftAsnCreationVerdict,
  MINTSOFT_ASN_DIFFERENCE_KINDS,
  type MintsoftAsnDifference,
  type MintsoftAsnExpectation,
} from '@/lib/connectors/mintsoft/api/asn-creation-rule'
import { normalizeMintsoftAsnListRowForRecovery } from '@/lib/connectors/mintsoft/api/client'
import type { WmsAsnRef } from '@/lib/connectors/wms/types'

/**
 * o3d-bhvu ROUND 6: THE RULE, IN ONE PLACE, AND WHAT CANNOT BYPASS IT.
 *
 * Six review rounds each found the same class of defect in a different branch: an unreadable, unprovable or
 * merely DIFFERENT remote state read as permission to create an ASN at a live warehouse. The rule is now
 * asserted once, in lib/connectors/mintsoft/api/asn-creation-rule.ts:
 *
 *   a create proceeds ONLY on a positive proof of absence — every candidate ruled out by
 *   `isProofThatMintsoftAsnIsNotThisOne` — and every other outcome refuses by name, naming the ASN id.
 *
 * This file pins the rule itself (which differences are proof, and that every difference the comparison can
 * actually produce is in that table) and pins that nothing else decides: the duplicate matcher and the
 * post-create read-back are the only two consumers, and neither can answer "create one" on its own.
 */

const EXPECTATION: MintsoftAsnExpectation = {
  reference: 'PO-1',
  externalWarehouseId: '6',
  lines: [{ sourceLineId: 'line-a', expectedQty: 10 }, { sourceLineId: 'line-b', expectedQty: 2.5 }],
}

type Item = { ID?: number | string | null; SourceLineId?: unknown; QuantityExpected?: unknown }
function row(poReference: string, warehouseId: number, items: Item[]): WmsAsnRef {
  return normalizeMintsoftAsnListRowForRecovery({ ID: 900, POReference: poReference, WarehouseId: warehouseId, Items: items })
}
const OURS: Item[] = [{ ID: 1, SourceLineId: 'line-a', QuantityExpected: 10 }, { ID: 2, SourceLineId: 'line-b', QuantityExpected: 2.5 }]

/** One live-shaped row per difference kind, so the tables below are about states that really occur. */
const CASES: ReadonlyArray<{ kind: MintsoftAsnDifference['kind']; asn: WmsAsnRef }> = [
  { kind: 'same', asn: row('PO-1', 6, OURS) },
  { kind: 'reference', asn: row('PO-2', 6, OURS) },
  { kind: 'lineIdentityUnreadable', asn: row('PO-1', 6, [OURS[0]!, { ID: 2, SourceLineId: null, QuantityExpected: 2.5 }]) },
  { kind: 'lines', asn: row('PO-1', 6, [OURS[0]!, { ID: 2, SourceLineId: 'line-z', QuantityExpected: 2.5 }]) },
  { kind: 'quantityUnreadable', asn: row('PO-1', 6, [OURS[0]!, { ID: 2, SourceLineId: 'line-b', QuantityExpected: 'two and a half' }]) },
  { kind: 'quantity', asn: row('PO-1', 6, [{ ID: 1, SourceLineId: 'line-a', QuantityExpected: 12 }, OURS[1]!]) },
  { kind: 'quantityRounded', asn: row('PO-1', 6, [OURS[0]!, { ID: 2, SourceLineId: 'line-b', QuantityExpected: 3 }]) },
  { kind: 'warehouse', asn: row('PO-1', 5, OURS) },
]

test('every difference kind the union declares is one the comparison can actually reach', () => {
  const reached = CASES.map(({ asn, kind }) => {
    const difference = compareMintsoftAsnAgainstExpectation(asn, EXPECTATION)
    assert.equal(difference.kind, kind, `the ${kind} row compares as ${difference.kind}`)
    return difference.kind
  })
  // UNIVERSAL, not existential: every declared kind must appear, so a kind nobody can produce cannot sit in
  // the proof table unnoticed, and a kind added later without a case here fails.
  assert.deepEqual([...MINTSOFT_ASN_DIFFERENCE_KINDS].sort(), [...reached].sort())
  assert.equal(new Set(reached).size, MINTSOFT_ASN_DIFFERENCE_KINDS.length, 'and each case reaches a different kind')
})

test('ONLY a different reference and a different line set are proof that a remote ASN is not this one', () => {
  const proof = MINTSOFT_ASN_DIFFERENCE_KINDS.filter((kind) => {
    const difference = compareMintsoftAsnAgainstExpectation(CASES.find((entry) => entry.kind === kind)!.asn, EXPECTATION)
    return isProofThatMintsoftAsnIsNotThisOne(difference)
  })
  assert.deepEqual([...proof], ['reference', 'lines'])
  // The ones that are NOT proof are the six this branch's six rounds were about, named so a future reader
  // has to argue with the list rather than with a scattered set of branches.
  assert.deepEqual(
    MINTSOFT_ASN_DIFFERENCE_KINDS.filter((kind) => !proof.includes(kind as never)),
    ['same', 'lineIdentityUnreadable', 'quantityUnreadable', 'quantity', 'quantityRounded', 'warehouse'],
  )
})

test('the gate is the only thing that can answer "create one", and it says so for one verdict only', () => {
  const asn = row('PO-1', 6, OURS)
  assert.equal(requireMintsoftAsnCreationVerdict({ kind: 'absenceProven' }), null, 'absence proven, and nothing else, permits a create')
  assert.equal(requireMintsoftAsnCreationVerdict({ kind: 'existingAsn', asn }), asn)
  const refusal = new Error('named refusal')
  assert.throws(() => requireMintsoftAsnCreationVerdict({ kind: 'refused', error: refusal }), (error: unknown) => error === refusal)
})

test('every refusal describes the difference in terms of what was sent', () => {
  for (const { kind, asn } of CASES) {
    if (kind === 'same') continue
    const difference = compareMintsoftAsnAgainstExpectation(asn, EXPECTATION)
    const description = describeMintsoftAsnDifference(difference, EXPECTATION)
    assert.ok(description.length > 20, `${kind} is described`)
    assert.ok(/PO-1|line-|warehouse|item/.test(description), `${kind} names the reference, the line, the warehouse or the item set: ${description}`)
  }
})

/**
 * THE STRUCTURAL PINS. The decision is source-level: the creators are server actions inside database
 * transactions with no unit harness, so what is asserted here is that no OTHER code reaches a verdict.
 * Universal counts and absence checks over whole files, so a stale branch beside a new one fails.
 */
test('nothing outside the rule can conclude that no ASN exists', () => {
  const read = (relative: string) => readFileSync(path.join(process.cwd(), relative), 'utf8')
  const rule = read('lib/connectors/mintsoft/api/asn-creation-rule.ts')
  const recovery = read('lib/connectors/mintsoft/api/asn-recovery.ts')
  const client = read('lib/connectors/mintsoft/api/client.ts')
  const action = read('app/actions/mintsoft-sync.ts')

  // The gate exists once, in the rule, and the create arm is the only `null` it can return.
  assert.equal((rule.match(/export function requireMintsoftAsnCreationVerdict\(/g) ?? []).length, 1)
  assert.equal((rule.match(/case 'absenceProven':/g) ?? []).length, 1)

  // The matcher decides through the gate and has no other exit: no `return null` anywhere in the file.
  assert.equal((recovery.match(/return requireMintsoftAsnCreationVerdict\(/g) ?? []).length, 1)
  assert.equal((recovery.match(/return null/g) ?? []).length, 0, 'a bare "no match" return is how five rounds of this bug were written')
  assert.equal((recovery.match(/kind: 'absenceProven' \}/g) ?? []).length, 1, 'exactly one place concludes absence')
  // …and it reaches every verdict through the shared comparison, never its own field reads.
  assert.equal((recovery.match(/compareMintsoftAsnAgainstExpectation\(/g) ?? []).length, 1)
  // An ABSENCE check, which is universal: the matcher reads no remote field for itself at all, so it cannot
  // grow a second opinion about what a row means beside the shared comparison. (`POReference` and
  // `QuantityExpected` appear in its prose; `.raw` is how either would be READ.)
  assert.equal((recovery.match(/\.raw/g) ?? []).length, 0, 'the matcher no longer reads raw fields itself')
  assert.equal((recovery.match(/readMintsoftAsnItemLineIdentity\(/g) ?? []).length, 0, 'nor re-reads line identities')

  // The post-create read-back goes through the same rule, with no comparison of its own.
  assert.equal((client.match(/requireMintsoftAsnIsTheOneRequested\(/g) ?? []).length, 1)
  const verification = client.slice(client.indexOf('export function requireCreatedMintsoftAsnMatchesRequest('))
  const body = verification.slice(0, verification.indexOf('\n}\n') + 2)
  assert.ok(body.includes('requireMintsoftAsnIsTheOneRequested('), 'it delegates')
  assert.equal((body.match(/if \(/g) ?? []).length, 0, 'and decides nothing itself')
  assert.equal((body.match(/return/g) ?? []).length, 1)

  // No caller of either one keeps a copy of the comparison, and the creators cannot answer "create" for
  // themselves: they have no reference, quantity or warehouse comparison at all.
  for (const [label, source] of [['the action', action], ['the client', client]] as const) {
    assert.equal((source.match(/isProofThatMintsoftAsnIsNotThisOne\(/g) ?? []).length, 0, `${label} does not re-decide what is proof`)
    assert.equal((source.match(/kind: 'absenceProven'/g) ?? []).length, 0, `${label} cannot conclude absence`)
  }
  assert.equal((action.match(/QuantityExpected/g) ?? []).length, 0, 'the action does not compare remote quantities')

  // ROUND 6, HIGH 1: the unrecorded remote ASN id is retained by BOTH creators, not just logged.
  assert.equal((action.match(/const unrecordedExternalAsnId = error instanceof MintsoftAsnCreateVerificationError/g) ?? []).length, 2)
  assert.equal((action.match(/await recordUnverifiedMintsoftAsnCreate\(/g) ?? []).length, 2)
  assert.equal((action.match(/\.\.\.\(unrecordedExternalAsnId \? \{ unrecordedExternalAsnId \} : \{\}\)/g) ?? []).length, 2)
})
