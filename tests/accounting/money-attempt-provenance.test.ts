import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import {
  CUSTODY_MAY_BE_RESTORED,
  STAMPED_MONEY_TYPES,
  attemptProvenNeverMade,
  stampingCustodyOnClaim,
  stampingCustodyOnCreate,
} from '@/lib/domain/accounting/money-attempt-provenance'
import { MONEY_MOVING_SYNC_TYPES } from '@/lib/domain/accounting/followup-retry-guard'

/**
 * o3d-0m56 round 10 (Codex HIGH x3) — "an unstamped money row proves no call ever left it" is now a
 * fact the ROW carries, not a global instant.
 *
 * Round 9 recorded an epoch in `settings` and trusted every row created at or after it. Codex took
 * that apart three ways, and all three were the same defect: the thing that made the premise true
 * lived OUTSIDE the row, where an ordinary operational action could invalidate it.
 *
 *   1. CLOCK SKEW. `createdAt` comes from PostgreSQL and the epoch came from the app process's
 *      `new Date()`. A few seconds of disagreement put a row on the wrong side of the boundary, and
 *      the wrong side is an attempted row read as never-attempted.
 *   2. THE DOCUMENTED RECOVERY DID NOT RECOVER. `DELETE FROM settings WHERE key = …` was advertised
 *      as safe at any time, but a running process had already cached the epoch and never saw the
 *      delete.
 *   3. A ROLLBACK. The epoch is established once, so an older binary posts unstamped rows AFTER it
 *      that the rule reads as never-attempted — and a rollback is a SEQUENTIAL deploy, so the
 *      no-overlap deploy order round 9 leaned on is satisfied throughout.
 *
 * `attemptStampingCustodyAt` replaces it. Its presence says every binary that created or claimed
 * the row stamps before it posts; its absence says something else had it. No clock is consulted,
 * nothing is cached, and a rolled-back binary declares itself by writing nothing.
 */

const PROVENANCE = 'lib/domain/accounting/money-attempt-provenance.ts'

async function source(file: string): Promise<string> {
  return readFile(path.join(process.cwd(), file), 'utf8')
}

/**
 * The source with every `stampingCustodyOnClaim(...)` argument removed, brace/paren-balanced. What
 * remains is the code that writes to `accountingSyncLog` WITHOUT going through the helper.
 */
function withoutHelperCalls(text: string): string {
  const CALL = 'stampingCustodyOnClaim('
  let out = ''
  let cursor = 0
  for (let at = text.indexOf(CALL); at !== -1; at = text.indexOf(CALL, cursor)) {
    out += text.slice(cursor, at)
    let depth = 0
    let i = at + CALL.length - 1
    for (; i < text.length; i += 1) {
      if (text[i] === '(') depth += 1
      else if (text[i] === ')') {
        depth -= 1
        if (depth === 0) break
      }
    }
    cursor = i + 1
  }
  return out + text.slice(cursor)
}

test('custody on CREATE is a presence, and that is all it has to be (o3d-0m56 r10)', () => {
  const custody = stampingCustodyOnCreate(new Date('2026-08-19T10:00:00Z'))

  assert.deepEqual(Object.keys(custody), ['attemptStampingCustodyAt'])
  assert.equal(custody.attemptStampingCustodyAt.toISOString(), '2026-08-19T10:00:00.000Z')
  // Defaulted, so no caller needs a clock of its own to take custody of a row it is creating.
  assert.ok(stampingCustodyOnCreate().attemptStampingCustodyAt instanceof Date)
})

test('custody on CLAIM is written in the same statement as the claim, from the same instant (o3d-0m56 r10)', () => {
  // The pairing is what the database's forfeit trigger reads: a claim that moves
  // `processingStartedAt` without moving this column is a claim by a binary that does not stamp, and
  // loses custody. Returning both fields from one function is what stops the pairing being
  // half-applied at one of the thirteen sites that write a non-null `processingStartedAt`.
  const claimedAt = new Date('2026-08-19T11:22:33.444Z')
  const claim = stampingCustodyOnClaim({
    where: { id: 'log-1' },
    processingStartedAt: claimedAt,
    data: { status: 'PROCESSING' },
  })

  assert.deepEqual(Object.keys(claim).sort(), ['data', 'where'],
    'the helper returns the WHOLE updateMany argument, so the custody stamp cannot be taken without '
    + 'the predicate that makes taking it safe')
  assert.equal(claim.data.processingStartedAt, claimedAt)
  assert.equal((claim.data.attemptStampingCustodyAt as Date).getTime(), claimedAt.getTime(),
    'a claim re-asserts custody at the claim instant; two different values would be two facts')
  assert.equal(claim.data.status, 'PROCESSING', 'the caller\'s own data survives')
})

/**
 * A minimal evaluator for the fragment of Prisma's where-grammar this predicate uses — `AND`, `NOT`,
 * `{ in: [...] }` and equality, including equality with `null`. Enough to ask the question the
 * database will be asked, over rows built here, without a database.
 */
function whereMatches(where: Record<string, unknown>, row: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'AND') return (condition as Record<string, unknown>[]).every((arm) => whereMatches(arm, row))
    if (key === 'NOT') return !whereMatches(condition as Record<string, unknown>, row)
    if (condition !== null && typeof condition === 'object' && 'in' in (condition as object)) {
      return (condition as { in: unknown[] }).in.includes(row[key])
    }
    return row[key] === condition
  })
}

test('a claim arriving after an UNSTAMPED WIRE ATTEMPT does not launder the row back into custody (o3d-anu8 r3)', () => {
  // THE SEQUENCE THIS MODELS, and it is the deployment overlap the whole mechanism exists to
  // support. An OLD binary claimed this INVOICE_PAYMENT row, its request REACHED THE WIRE, and it
  // recorded nothing: the forfeit trigger took custody (NULL) and the old binary never stamps
  // (`remoteAttemptedAt` NULL). That pair means UNDETERMINED — the payment may be in the ledger.
  //
  // The pass-level repair has already run, so nothing will stamp this row before the next pass. A
  // claim by THIS binary then arrives. Restoring custody unconditionally would leave
  // `custody present, no stamp`, which `attemptProvenNeverMade` reads as canonical proof that
  // nothing was ever sent — the capacity guard frees a slot and the planner recycles the payload,
  // and a payment that may have posted is treated as certainly not posted.
  const claimedAt = new Date('2026-08-20T09:00:00.000Z')
  const claim = stampingCustodyOnClaim({
    where: { id: 'log-old-binary' },
    processingStartedAt: claimedAt,
    data: { status: 'PROCESSING' },
  })

  const wentToTheWireUnstamped = {
    id: 'log-old-binary',
    type: 'INVOICE_PAYMENT',
    remoteAttemptedAt: null,
    attemptStampingCustodyAt: null,
  }
  assert.equal(whereMatches(claim.where as Record<string, unknown>, wentToTheWireUnstamped), false,
    'the claim must not land on a money row that carries neither custody nor a stamp')

  // And the conservative reading therefore SURVIVES the claim: the row is untouched, so it still
  // reads undetermined rather than proven.
  assert.equal(attemptProvenNeverMade(wentToTheWireUnstamped), false,
    'a row the claim refused still proves nothing, which is the whole point of refusing it')

  // WHAT MUST STILL CLAIM. Refusing more than this population would strand rows for ever.
  const stillClaimable = [
    // Inside custody: the ordinary case, every row this binary created.
    { case: 'in custody, unstamped', row: { type: 'INVOICE_PAYMENT', remoteAttemptedAt: null, attemptStampingCustodyAt: claimedAt } },
    // Outside custody but STAMPED — the repair has been here, or a real attempt was recorded. There
    // is no silence left to convert into proof.
    { case: 'outside custody, stamped', row: { type: 'INVOICE_PAYMENT', remoteAttemptedAt: claimedAt, attemptStampingCustodyAt: null } },
    // A PDF/e-mail follow-up: nothing ever stamps it, so refusing it would make it permanently
    // unclaimable, and its unstamped state is never read as evidence of anything.
    { case: 'non-money type outside custody', row: { type: 'SALES_INVOICE', remoteAttemptedAt: null, attemptStampingCustodyAt: null } },
  ]
  for (const { case: name, row } of stillClaimable) {
    assert.equal(whereMatches(claim.where as Record<string, unknown>, { id: 'log-old-binary', ...row }), true,
      `a row that is ${name} must still be claimable`)
  }

  // And the caller's own predicate is still AND-ed in, not replaced by the refusal.
  assert.equal(
    whereMatches(claim.where as Record<string, unknown>, { id: 'someone-else', type: 'SALES_INVOICE', remoteAttemptedAt: null, attemptStampingCustodyAt: null }),
    false,
    'the refusal is AND-ed onto the caller\'s predicate, never merged into it',
  )
})

test('every money type the repair reaches is also a type custody may not be laundered onto (o3d-anu8 r3)', () => {
  // The refusal and the repair must cover the SAME population: a money type the refusal skips is a
  // type whose out-of-custody rows can be claimed into a false proof, and a money type the repair
  // skips is one the refusal would strand for ever.
  const types = (CUSTODY_MAY_BE_RESTORED.NOT as { type: { in: string[] } }).type.in
  assert.deepEqual([...types].sort(), [...STAMPED_MONEY_TYPES].sort())
})

test('the repaired types are exactly the ones the fence stamps (o3d-0m56 r9)', () => {
  // A money type in the fence but not in this list is a type the repair never reaches: its
  // out-of-custody rows stay unstamped for ever and stay invisible to the fence's rival query.
  assert.deepEqual([...STAMPED_MONEY_TYPES].sort(), [...MONEY_MOVING_SYNC_TYPES].sort())
})

test('the repair stamps exactly the rows outside custody, with the row\'s own lower bound (o3d-0m56 r10)', async () => {
  const text = await source(PROVENANCE)
  const update = text.slice(text.indexOf('UPDATE "accounting_sync_logs"'))
  assert.ok(update.length > 0, 'the repair statement must exist')
  const statement = update.slice(0, update.indexOf('`'))

  assert.match(statement, /"remoteAttemptedAt" IS NULL/,
    'only unstamped rows may be touched — a stamp claimed by a real call must never move')
  assert.match(statement, /"attemptStampingCustodyAt" IS NULL/,
    'and only rows outside custody, or it would stamp what this binary is about to post')
  assert.match(statement, /COALESCE\("syncedAt", "processingStartedAt", "createdAt"\)/)
  assert.ok(!/now\(\)|CURRENT_TIMESTAMP/i.test(statement),
    'never now(), which would claim an attempt happened at repair time')
  // FINDING 1, structurally: the repair takes no clock and compares no timestamps. A `createdAt <
  // something` arm here would be round 9's boundary, back again.
  assert.ok(!/createdAt"\s*[<>]/.test(statement), 'no timestamp comparison may decide which rows are trusted')
})

test('the epoch, its settings key and its cache are GONE (o3d-0m56 r10)', async () => {
  // FINDING 2 was not that the runbook was wrong, it was that a cached global made the runbook a
  // lie. The fix is not a better runbook: there is now no epoch to record, no key to delete and no
  // process-lifetime memo to be stale — so there is nothing an operator can be told to reset and
  // then not have reset.
  const text = await source(PROVENANCE)
  assert.ok(!text.includes('money-attempt-stamping-since'), 'no settings key may survive')
  assert.ok(!/db\.setting\b|tx\.setting\b/.test(text), 'the module must not read or write settings at all')
  assert.ok(!/^let \w+: Promise/m.test(text), 'no module-level promise cache may hold an answer across calls')
})

test('every accounting sync row this codebase creates is created INSIDE custody (o3d-0m56 r10)', async () => {
  // A row created without custody can never be recycled again — safe, but it silently gives up the
  // revival bookkeeping for that scope, and nothing in the types would say so. Seven creation sites
  // exist; this is what stops the eighth being written without one.
  const { globSync } = await import('node:fs')
  const files = globSync('lib/**/*.ts', { cwd: process.cwd() })
  const offenders: string[] = []
  let sites = 0
  for (const file of files) {
    const text = await source(file)
    for (const match of text.matchAll(/accountingSyncLog\.create\(\{/g)) {
      sites++
      const block = text.slice(match.index, text.indexOf('})', match.index))
      if (!block.includes('stampingCustodyOnCreate()')) offenders.push(`${file}:${match.index}`)
    }
  }
  assert.ok(sites >= 7, `expected the known creation sites, found ${sites}`)
  assert.deepEqual(offenders, [], 'every accountingSyncLog.create must spread stampingCustodyOnCreate()')
})

test('every claim re-asserts custody in the same write (o3d-0m56 r10)', async () => {
  // FINDING 3, structurally. A claim is what precedes a post, so a claim that does not re-assert
  // custody is indistinguishable — to the database — from one made by a rolled-back binary, and the
  // trigger forfeits custody for it. That failure is the safe direction (one ledger read, one
  // un-recycled row) but it is still a defect, so no `processingStartedAt: <non-null>` may be
  // written by hand.
  //
  // Scanned across EVERY module that touches `accountingSyncLog`, not just the two processors: the
  // rule is about the table, and a claim written into a third place would be exactly the one nobody
  // thought to check. `lib/email-outbox.ts` has a `processingStartedAt` of its own on another model
  // and is correctly outside this net.
  const { globSync } = await import('node:fs')
  const files = [...globSync('lib/**/*.ts', { cwd: process.cwd() }), ...globSync('app/**/*.ts', { cwd: process.cwd() })]
    .filter((file) => !file.startsWith('app/generated'))
  let claimers = 0
  for (const file of files) {
    const text = await source(file)
    if (!text.includes('accountingSyncLog')) continue
    // The helper's OWN module is where the pairing is defined — its declaration of the parameter and
    // its one write of the column are the rule, not a site that could skip it. Pinned instead by the
    // unit tests above, which read the returned statement rather than the source text.
    if (file === PROVENANCE) continue
    // Everything a call site hands to `stampingCustodyOnClaim` is removed before scanning, because
    // naming the instant THERE is exactly how a site is supposed to write it now (o3d-anu8 r3): the
    // helper owns the write. What is left is a `processingStartedAt` written by hand, which is the
    // thing that must not exist.
    const handWritten = [...withoutHelperCalls(text).matchAll(/^\s*processingStartedAt: (?!null,)(.+)$/gm)]
      .map((match) => match[1]!.trim())
      // A `where` clause is a READ of the column, not a write: it cannot start a claim.
      .filter((value) => !value.startsWith('{'))
    assert.deepEqual(handWritten, [], `${file} must write a non-null processingStartedAt only via stampingCustodyOnClaim`)
    if (text.includes('stampingCustodyOnClaim(')) claimers++
  }
  assert.ok(claimers >= 2, `both sync processors must claim through the paired helper, found ${claimers}`)
})

test('the repair runs BEFORE either processor claims anything (o3d-0m56 r10)', async () => {
  // What makes a forfeit PERMANENT. Custody is restored by this binary's own claim, so a row an
  // older binary claimed would look trustworthy again the moment this one re-claimed it. It never
  // does: the repair turns "outside custody" into a `remoteAttemptedAt` stamp, and it runs on the
  // first line of the entry point that does the claiming.
  //
  // This ordering is a property of THIS CODE, not of how anything is deployed — which is the whole
  // difference between it and round 9's answer to the same question.
  for (const [file, entry] of [
    ['lib/connectors/xero/sync-processor.ts', 'export async function processPendingXeroSync()'],
    ['lib/connectors/quickbooks/sync-processor.ts', 'export async function processPendingQuickBooksSync()'],
  ] as const) {
    const text = await source(file)
    const start = text.indexOf(entry)
    assert.notEqual(start, -1, `${file} must still export ${entry}`)
    const repair = text.indexOf('repairMoneyAttemptsOutsideStampingCustody()', start)
    const firstClaim = text.indexOf("status: 'PROCESSING'", start)
    assert.notEqual(repair, -1, `${file} must repair before it sweeps`)
    assert.ok(repair < firstClaim || firstClaim === -1,
      `${file} claims a row before repairing rows outside custody`)
  }
})

test('the deploy order is still documented, and documents what it now buys (o3d-0m56 r10)', async () => {
  // Kept, because running two versions against one database is a hazard for more than this fix —
  // but it is no longer what makes the attempt premise true, and the documentation must not go on
  // telling a deployer to clear a setting that no longer exists (FINDING 2). What it must say
  // instead is what the row carries and that the repair heals an overlap by itself.
  for (const file of ['scripts/deploy.sh', 'docs/installation.md', 'CLAUDE.md']) {
    const text = await source(file)
    assert.ok(!text.includes('money-attempt-stamping-since'),
      `${file} must not tell an operator to clear a setting that no longer exists`)
    assert.match(text, /attemptStampingCustodyAt/,
      `${file} must name the column that now carries the proof`)
    assert.match(text, /stopped before|never run two|no overlap/i,
      `${file} must still state that the old process is stopped before the new one starts`)
    assert.match(text, /roll(ing|ed|back| back)/i,
      `${file} must say what a rollback does now`)
  }
})
