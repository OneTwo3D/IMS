import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

/**
 * o3d-peh1 ROUND 4 (Codex LOW) — A VOCABULARY MUST NOT ADVERTISE A WORD NOTHING SAYS.
 *
 * `FollowUpEnqueueRefusalReason` declared `slot_lost` — "a live row owns the scope under a different
 * idempotency token, or the enqueue race was lost". Nothing constructed it. That path is
 * `resolveLostFollowUpRevival`, which either answers FOLLOW_UPS_ENQUEUED (a live row carries OUR
 * token, so the work IS queued) or THROWS. So a caller could branch on `slot_lost` for ever without
 * ever seeing it, and a reader would believe there was a refusal outcome where in fact there is an
 * exception — the opposite of the property the union exists to guarantee, which is that "there is a
 * refusal" and "this was not enqueued" are the same fact.
 *
 * Asserted against the SOURCE rather than against a type, because the defect is a declaration with
 * no construction: a type-level test cannot see the absence of a constructor.
 *
 * REVERT EVIDENCE: putting `| 'slot_lost'` back into the union in
 * lib/domain/accounting/followup-enqueue-outcome.ts fails "every declared refusal reason is
 * constructed somewhere".
 */

const ROOT = process.cwd()

async function source(rel: string): Promise<string> {
  return await readFile(path.join(ROOT, rel), 'utf8')
}

/**
 * Every reason literal the vocabulary declares, across BOTH sub-unions.
 *
 * o3d-batch-ret r6 split the vocabulary in two — `FollowUpEnqueueDeclineReason` for what the enqueue
 * itself refuses, `FollowUpPreEnqueueRefusalReason` for what a connector refuses before the enqueue
 * is reached — because THREE prose sites state how many ways THE ENQUEUE declines, and folding a
 * caller-side refusal into that one union would have made all three wrong in the direction that
 * looks safe (a number too big describes refusals the enqueue does not have). The
 * "is it constructed?" rule below is about the WHOLE vocabulary and so reads both; the count rule
 * further down is about the enqueue and so reads one.
 *
 * The pre-enqueue arm is matched WITHOUT a leading `|`, because a one-member union has none.
 */
async function declaredReasons(): Promise<{ decline: string[]; preEnqueue: string[]; all: string[] }> {
  const outcome = await source('lib/domain/accounting/followup-enqueue-outcome.ts')
  const cut = (from: string, to: string): string[] => {
    const start = outcome.indexOf(from)
    const end = outcome.indexOf(to)
    assert.ok(start >= 0 && end > start, `the vocabulary must still declare ${from} before ${to}`)
    return [...outcome.slice(start, end).matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
  }
  const decline = cut('export type FollowUpEnqueueDeclineReason', 'export type FollowUpPreEnqueueRefusalReason')
  const preEnqueue = cut('export type FollowUpPreEnqueueRefusalReason', 'export type FollowUpEnqueueRefusalReason =')
  assert.ok(decline.length > 0, 'the decline union must actually be parsed, or this test asserts nothing')
  assert.ok(preEnqueue.length > 0, 'the pre-enqueue union must actually be parsed, or this test asserts nothing')
  return { decline, preEnqueue, all: [...decline, ...preEnqueue] }
}

test('[o3d-peh1 r4] every declared refusal reason is constructed somewhere', async () => {
  const { all: declared, preEnqueue } = await declaredReasons()
  // Non-vacuity in BOTH halves: the walk must reach the connector-side arm as well, which is the one
  // o3d-batch-ret r6 added and the one whose absence was reported as success for four rounds.
  assert.ok(preEnqueue.includes('payment_account_unmapped'), 'the pre-enqueue arm must still be in the walk')

  const constructors = [
    await source('lib/connectors/xero/sync-processor.ts'),
    await source('lib/connectors/quickbooks/sync-processor.ts'),
    await source('lib/domain/accounting/followup-revival.ts'),
  ].join('\n')

  for (const reason of declared) {
    assert.ok(
      constructors.includes(`reason: '${reason}'`),
      `${reason} is declared but no connector ever constructs it — an unconstructible refusal is a `
      + 'branch that never runs and a refusal an operator will never see',
    )
  }
})

test('[o3d-peh1 r4] the lost-slot path throws rather than returning a refusal, which is why it has no code', async () => {
  const revival = await source('lib/domain/accounting/followup-revival.ts')
  const resolver = revival.slice(revival.indexOf('export async function resolveLostFollowUpRevival'))
  // A live row under a DIFFERENT token: the unique index gave the slot away, retrying cannot recover
  // it, and silently accepting it would be the duplicate the guard exists to prevent.
  assert.match(resolver, /a live follow-up already owns this/)
  assert.match(resolver, /reference under a different idempotency token/)
  assert.match(resolver, /throw new Error\(/)
  assert.doesNotMatch(resolver, /refusedFollowUpEnqueue/, 'it constructs no outcome at all')
})

/**
 * The same defect in the other direction: a comment that justifies a removed refusal with an
 * argument that is only true on ONE connector, in a file that reads as connector-general.
 *
 * REVERT EVIDENCE: restoring the round-3 wording ("`attemptRevision` only ever moves UP … a claim
 * mints 1") without the QuickBooks paragraph fails "the revision-0 revival argument is marked
 * Xero-only".
 */
test('[o3d-peh1 r4] the revision-0 revival argument is marked Xero-only, and the QuickBooks gap is filed', async () => {
  const xero = await source('lib/connectors/xero/sync-processor.ts')
  const paragraph = xero.slice(
    xero.indexOf('AND REVISION 0 IS FENCED BY THE REVISION ITSELF'),
    xero.indexOf('o3d-0m56 asks MAY THIS BE RE-POSTED AT ALL'),
  )
  assert.ok(paragraph.length > 0, 'the paragraph must be found, or this test asserts nothing')
  assert.match(paragraph, /XERO-ONLY|Xero-only|A XERO CLAIM MINTS 1/, 'the argument is scoped to this connector')
  assert.match(paragraph, /o3d-rw0w/, 'and the QuickBooks gap is filed rather than left implicit')

  // The gap itself, asserted against the QuickBooks code rather than against the comment: its
  // revival CAS carries no revision clause at all, which is the ABA the paragraph calls impossible.
  const qbo = await source('lib/connectors/quickbooks/sync-processor.ts')
  const cas = qbo.slice(qbo.indexOf("if (plan.action === 'reuse')"))
  const predicate = cas.slice(cas.indexOf('updateMany'), cas.indexOf('data:'))
  assert.match(predicate, /status: 'FAILED'/)
  assert.doesNotMatch(
    predicate,
    /attemptRevision/,
    'if this ever gains a revision clause the comment and o3d-rw0w both need updating',
  )
})

/**
 * o3d-batch-ret ROUND 5 (Codex MEDIUM) — AND THE PROSE MUST COUNT THE SAME SET.
 *
 * The test at the top of this file parses the UNION DECLARATION. That is exactly what let the defect
 * it was written for survive in the same two files: `back-reference-sweep.ts` and
 * `xero/sync-processor.ts` both went on describing "three deliberate refusals … a slot lost to a
 * live row under another token" for two rounds after `slot_lost` was deleted, because nothing reads
 * a comment. A reader taking either file at its word believes in a refusal that cannot be
 * constructed — the precise property the union test exists to guarantee, asserted one layer up.
 *
 * The count is derived from the union rather than hard-coded, so ADDING a member (round 5 added
 * `unprobed_unfenced_reuse`) fails every prose site that was not updated with it.
 *
 * REVERT EVIDENCE: changing any one of the three sites back to "three"/"THREE" while the union holds
 * two members, or leaving one at "TWO" now that it holds three, fails
 * "every prose description of the refusal set counts the same set".
 */

/** The files that state the size of the refusal set in prose, and the phrase that introduces it. */
const PROSE_SITES: ReadonlyArray<{ file: string; marker: RegExp }> = [
  { file: 'lib/domain/accounting/back-reference-sweep.ts', marker: /enqueue has ([A-Z]+) deliberate refusals/ },
  { file: 'lib/connectors/xero/sync-processor.ts', marker: /([A-Z]+) of them decline deliberately/ },
  { file: 'tests/accounting/back-reference-sweep.test.ts', marker: /declines on purpose in ([A-Z]+) cases/ },
]

const NUMBER_WORDS = ['ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX']

test('[round 5] every prose description of the refusal set counts the same set', async () => {
  // THE ENQUEUE'S OWN REFUSALS, which is what all three sites are describing. Counting the whole
  // vocabulary here would make every site wrong the moment a connector-side refusal is added.
  const { decline: declared } = await declaredReasons()
  const expected = NUMBER_WORDS[declared.length]
  assert.ok(expected, `no word for ${declared.length} refusals — extend NUMBER_WORDS`)

  for (const site of PROSE_SITES) {
    const text = await source(site.file)
    const found = site.marker.exec(text)
    assert.ok(found, `${site.file} no longer states how many refusals there are — the marker must match, or this asserts nothing`)
    assert.equal(
      found[1],
      expected,
      `${site.file} says ${found[1]} refusals; the union declares ${declared.length} (${declared.join(', ')})`,
    )
  }
})

/**
 * o3d-batch-ret ROUND 6 — AND NONE OF THEM MAY CLAIM ITS COUNT IS THE WHOLE VOCABULARY.
 *
 * This is the same defect as the count itself, one clause along. All three sites said their three
 * refusals "are exactly the members of" / "are the whole of" `FollowUpEnqueueRefusalReason`. Adding
 * a connector-side refusal to that union makes the SENTENCE false while leaving the NUMBER true, so
 * the count test above would still pass — and a reader would believe a payment refused for missing
 * configuration cannot exist, because the vocabulary they were pointed at does not contain it.
 *
 * The rule is about the CLAIM'S GRAMMAR, not about proximity to a correction: naming the wider union
 * as the set the count exhausts is the offence, wherever the corrective sentence happens to sit.
 *
 * REVERT EVIDENCE: change any one site back to `the whole of \`FollowUpEnqueueRefusalReason\`` and
 * this fails naming that file.
 */
test('[round 6] no prose site claims the enqueue refusals exhaust the WIDER vocabulary', async () => {
  const { decline, preEnqueue } = await declaredReasons()
  assert.ok(
    preEnqueue.length > 0 && decline.length > 0,
    'PRECONDITION: the vocabulary must be genuinely wider than the enqueue set, or this rule is vacuous',
  )
  let checked = 0
  for (const site of PROSE_SITES) {
    const text = await source(site.file)
    const found = site.marker.exec(text)
    assert.ok(found, `${site.file}: the marker must match, or this asserts nothing`)
    // The sentence the count introduces, and a little past it — the claim always sits in the same
    // thought as the number it qualifies.
    const listing = text.slice(found.index, found.index + 600)
    assert.doesNotMatch(
      listing,
      /(the whole of|exactly the members of)\s+`?FollowUpEnqueueRefusalReason/,
      `${site.file} says its ${decline.length} enqueue refusals are the whole of FollowUpEnqueueRefusalReason, `
      + `which also carries ${preEnqueue.join(', ')} — refusals a CONNECTOR raises before the enqueue is reached`,
    )
    checked++
  }
  assert.equal(checked, PROSE_SITES.length, 'every prose site was read')
})

test('[round 5] and none of them lists the lost slot as one of the refusals', async () => {
  // The specific ghost: `resolveLostFollowUpRevival` answers FOLLOW_UPS_ENQUEUED or THROWS, so it
  // constructs no outcome at all. Naming it beside the real refusals is what made the count wrong.
  for (const site of PROSE_SITES) {
    const text = await source(site.file)
    const found = site.marker.exec(text)
    assert.ok(found, `${site.file}: the marker must match, or this asserts nothing`)
    // The sentence the count introduces — the list itself, up to the end of that thought.
    const listing = text.slice(found.index, found.index + 600)
    const claimsItIsOne = /a slot lost to a live row under another token[^.]*\)/.test(listing)
      || /, and a slot lost to a live row/.test(listing)
    assert.equal(claimsItIsOne, false, `${site.file} still lists the lost slot among the refusals`)
  }
})
