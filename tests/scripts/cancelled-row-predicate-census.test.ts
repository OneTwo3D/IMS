import assert from 'node:assert/strict'
import test from 'node:test'

import ts from 'typescript'

import { collectStatusClauses } from '../../scripts/check-accounting-cancelled-row-predicates.mjs'

/**
 * o3d-f709 round 2 (Codex MEDIUM) — THE CENSUS THAT EXISTS TO TELL AN `AND` FROM AN `OR` COMMITTED
 * THE CONFUSION ITSELF.
 *
 * Round 1's HIGH was an AND read as an OR in the code: two CANCELLED-excluding predicates conjoined
 * where the reason claimed they alternated, so a cancelled row carrying the id Xero issued matched
 * nothing and a blocker disappeared. Round 2 answered it by making the structural half of every
 * owner's argument DATA — each declares how many of its clauses are ORed with the post-evidence arm
 * — and the walk that checks it asked whether `externalTransactionId: { not: null }` occurs
 * ANYWHERE INSIDE an OR element. Presence, not alternation. So the same defect, spelt as one object
 * instead of two, still earned a green `orPostEvidence`:
 *
 *   OR: [{ status: { in: LIVE }, externalTransactionId: { not: null } }]
 *
 * Prisma ANDs two properties of one object. That reads `status IN (…) AND id IS NOT NULL` and
 * excludes every CANCELLED row, exactly as the round-1 defect did.
 *
 * THESE ASSERTIONS ARE ABOUT SHAPES THIS TREE DOES NOT CONTAIN, deliberately. Nothing asserted over
 * the current sources can establish what the census REFUSES — both real owners are spelt with
 * genuine sibling arms and pass either version of the check. A guard is worth what it turns down.
 */

/** Parse `const where = <source>` and hand the walk the object literal, as the checker does. */
function clausesOf(source: string): Array<{ rescued: boolean; text: string }> {
  const sf = ts.createSourceFile('where.ts', `const where = ${source}\n`, ts.ScriptTarget.ES2022, true)
  const statement = sf.statements[0]
  assert.ok(ts.isVariableStatement(statement), 'the precondition: the fixture parsed as a declaration')
  const initializer = statement.declarationList.declarations[0].initializer
  assert.ok(initializer, 'the precondition: it has an initializer to walk')
  const out: Array<{ prop: ts.PropertyAssignment; rescued: boolean }> = []
  collectStatusClauses(initializer, out)
  return out.map((c) => ({ rescued: c.rescued, text: c.prop.getText(sf).replace(/\s+/g, ' ') }))
}

const LIVE = "['PENDING', 'PROCESSING', 'SYNCED', 'FAILED']"

test('[o3d-f709] the shape both real owners are spelt in earns the post-evidence tag', () => {
  // The control, and it is what stops the fix from being "tag nothing": order-delete-guard and
  // readPaymentRegistrations both write exactly this, and a CANCELLED row with a document id really
  // does match the second arm.
  const clauses = clausesOf(`{
    OR: [
      { status: { in: ${LIVE} } },
      { externalTransactionId: { not: null } },
    ],
  }`)
  assert.equal(clauses.length, 1, 'the precondition: the walk found the status clause')
  assert.equal(clauses[0].rescued, true)
})

test('[o3d-f709] post evidence in the SAME OR element cannot rescue — Prisma ANDs it', () => {
  // THE FINDING. One element, two properties, conjoined by Prisma. `status IN (…) AND id IS NOT
  // NULL` admits no CANCELLED row whatever its id — the round-1 defect under a different spelling.
  //
  // MUTATION: restore `isPostEvidenceArm` to "does `externalTransactionId: { not: null }` occur
  // anywhere within this element", and this element is tagged rescued again.
  const clauses = clausesOf(`{
    OR: [
      { status: { in: ${LIVE} }, externalTransactionId: { not: null } },
    ],
  }`)
  assert.equal(clauses.length, 1, 'the precondition: the walk found the status clause')
  assert.equal(clauses[0].rescued, false)
})

test('[o3d-f709] a sibling arm that ALSO restricts the status cannot rescue', () => {
  // NESTED-AND. A real sibling this time, so "different element" alone would clear it — and it
  // still admits no cancelled row, because the id is conjoined with a status of its own.
  //
  // MUTATION: drop the `restrictsStatus` half of `isPostEvidenceArm` and this arm rescues.
  const clauses = clausesOf(`{
    OR: [
      { status: { in: ${LIVE} } },
      { AND: [{ externalTransactionId: { not: null } }, { status: 'SYNCED' }] },
    ],
  }`)
  assert.equal(clauses.length, 2, 'the precondition: BOTH status clauses were walked')
  assert.deepEqual(clauses.map((c) => c.rescued), [false, false])
})

test('[o3d-f709] a sibling arm that narrows on something OTHER than status still rescues', () => {
  // THE OVER-STRICTNESS THIS MUST NOT HAVE. The rule is about status restrictions, not about ANDs:
  // an arm scoping to a type while guaranteeing a non-null id is still an alternative that admits
  // the cancelled row. Refusing it would push a sound query into `bare` and teach the next reader
  // that the declaration means nothing.
  const clauses = clausesOf(`{
    OR: [
      { status: { in: ${LIVE} } },
      { AND: [{ externalTransactionId: { not: null } }, { type: 'INVOICE_PAYMENT' }] },
    ],
  }`)
  assert.equal(clauses.length, 1, 'the precondition: the walk found the one status clause')
  assert.equal(clauses[0].rescued, true)
})

test('[o3d-f709] a nested OR arm rescues only when EVERY branch guarantees the id', () => {
  // An OR inside an arm is an alternative inside an alternative: one branch with no id requirement
  // and the arm admits a row with no post evidence, so it cannot stand for the escape.
  const everyBranch = clausesOf(`{
    OR: [
      { status: { in: ${LIVE} } },
      { OR: [{ externalTransactionId: { not: null } }, { externalTransactionId: { not: null } }] },
    ],
  }`)
  assert.equal(everyBranch.length, 1)
  assert.equal(everyBranch[0].rescued, true)

  const oneBranchOnly = clausesOf(`{
    OR: [
      { status: { in: ${LIVE} } },
      { OR: [{ externalTransactionId: { not: null } }, { connector: 'xero' }] },
    ],
  }`)
  assert.equal(oneBranchOnly.length, 1)
  assert.equal(oneBranchOnly[0].rescued, false)
})

test('[o3d-f709] the round-1 defect itself — a top-level AND — is still bare', () => {
  // The shape that produced the live money defect: the exclusion conjoined with everything else in
  // the where, with post evidence nowhere in an alternative.
  const clauses = clausesOf(`{
    referenceType: 'SalesOrder',
    status: { in: ${LIVE} },
    externalTransactionId: { not: null },
  }`)
  assert.equal(clauses.length, 1)
  assert.equal(clauses[0].rescued, false)
})

test('[o3d-f709] a status clause nested under an AND inside a rescued OR stays bare', () => {
  // Conservative on purpose, and unchanged by this round: `rescued` is never inherited INTO an AND.
  // Recorded here so the next edit knows it is a decision rather than an oversight.
  const clauses = clausesOf(`{
    OR: [
      { AND: [{ status: { in: ${LIVE} } }, { connector: 'xero' }] },
      { externalTransactionId: { not: null } },
    ],
  }`)
  assert.equal(clauses.length, 1)
  assert.equal(clauses[0].rescued, false)
})

// ---------------------------------------------------------------------------
// o3d-f709 round 3 (Codex MEDIUM 2) — THE SIBLING LOOP WAS NOT REDUNDANT, AND THE DEPTH CUTOFFS
// WERE WHY NOBODY COULD SEE IT.
//
// Round 2 recorded, beside the sibling loop, that reverting it alone "turns no test red" — a
// conclusion drawn from a mutation with no counterexample. `restrictsStatus` stopped at depth 6
// while `collectStatusClauses` ran to depth 8, and the walk that gave up answered FALSE, i.e. "this
// arm restricts no status", i.e. the permissive answer. So an arm could guarantee a document id at
// its very top and bury a status restriction four `AND`s down: the arm was accepted, the exclusion
// beside it was tagged `rescued`, and the predicate still admitted no cancelled row at all.
// ---------------------------------------------------------------------------

/** Wrap `body` in `depth` nested single-element ANDs — `{ AND: [{ AND: [ … ] }] }`. */
function nestedAnds(depth: number, body: string): string {
  let out = body
  for (let i = 0; i < depth; i++) out = `{ AND: [${out}] }`
  return out
}

test('[o3d-f709 r3] a sibling arm restricting the status FOUR ANDs down cannot rescue either', () => {
  // The counterexample the M7 mutation lacked. The arm names a non-null document id at its top —
  // `guaranteesPostEvidence` sees that immediately — and restricts the status below the old
  // `restrictsStatus` cutoff of 6, so the old code called it an alternative. It is not: the whole
  // predicate is `status IN (LIVE) OR (id IS NOT NULL AND status = 'SYNCED')`, which admits no
  // CANCELLED row whatever its id, exactly like the round-1 money defect.
  //
  // MUTATION: restore `if (depth > 6) return false` in `restrictsStatus` and the first clause is
  // tagged `rescued: true` again — and the deep clause vanishes from the walk entirely.
  const clauses = clausesOf(`{
    OR: [
      { status: { in: ${LIVE} } },
      {
        externalTransactionId: { not: null },
        AND: [${nestedAnds(4, "{ status: 'SYNCED' }")}],
      },
    ],
  }`)
  assert.equal(clauses.length, 2, 'the precondition: BOTH status clauses were walked, deep one included')
  assert.deepEqual(clauses.map((c) => c.rescued), [false, false],
    'an arm that restricts the status ANYWHERE within it is not an alternative, at any depth')
})

test('[o3d-f709 r3] the same shape at a depth the OLD walk could still reach is refused too', () => {
  // THE CONTROL, and it is what makes the test above a statement about the CUTOFF rather than about
  // the rule. One AND down, the old `restrictsStatus` saw the status and refused the arm, and it
  // still does. If this one had flipped, the fix would have changed what the census means instead of
  // how far it looks. (Reverting the cutoff turns the deep case red and leaves this one green — the
  // difference between them IS the finding.)
  const clauses = clausesOf(`{
    OR: [
      { status: { in: ${LIVE} } },
      {
        externalTransactionId: { not: null },
        AND: [${nestedAnds(1, "{ status: 'SYNCED' }")}],
      },
    ],
  }`)
  assert.equal(clauses[0].rescued, false)
})

test('[o3d-f709 r3] a walk that runs out of depth reports UNKNOWN instead of answering', () => {
  // The limit is now unreachable by anything a human writes, and reaching it is a CENSUS FAILURE
  // rather than a verdict — the opposite polarity to the cutoff it replaced, which answered "no
  // status restriction here" and let the exclusion be marked rescued.
  const sf = ts.createSourceFile(
    'where.ts',
    `const where = ${nestedAnds(200, "{ status: 'SYNCED' }")}\n`,
    ts.ScriptTarget.ES2022,
    true,
  )
  const statement = sf.statements[0]
  assert.ok(ts.isVariableStatement(statement))
  const initializer = statement.declarationList.declarations[0].initializer
  assert.ok(initializer)
  const ctx = { truncated: false }
  const out: Array<{ prop: ts.PropertyAssignment; rescued: boolean }> = []
  collectStatusClauses(initializer, out, 0, false, ctx)
  assert.equal(ctx.truncated, true, 'the walk says it did not finish')
  assert.equal(out.length, 0, 'and it did NOT reach the clause — which is why the caller must fail')
})
