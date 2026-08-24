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

test('[o3d-peh1 r4] every declared refusal reason is constructed somewhere', async () => {
  const outcome = await source('lib/domain/accounting/followup-enqueue-outcome.ts')
  const union = outcome.slice(
    outcome.indexOf('export type FollowUpEnqueueRefusalReason'),
    outcome.indexOf('export type FollowUpEnqueueRefusal ='),
  )
  const declared = [...union.matchAll(/\|\s*'([a-z_]+)'/g)].map((m) => m[1])
  assert.ok(declared.length > 0, 'the union must actually be parsed, or this test asserts nothing')

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
