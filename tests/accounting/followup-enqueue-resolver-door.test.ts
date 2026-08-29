import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

/**
 * o3d-batch-ret ROUND 9 (Codex MEDIUM) — A MANDATORY FOLD WITH A SECOND DOOR IS NOT MANDATORY.
 *
 * `decideRequestedInvoicePayment` exists for one reason: a discriminated union alone leaves the
 * round-7 conflation available to any caller who wants it. `if (r.kind !== 'amount') return
 * FOLLOW_UPS_ENQUEUED` type-checks perfectly and settles a payload nobody could read. The fold takes
 * that branch ONCE, settles `none` itself, and types the `invalid` handler to return the refused arm
 * — so no connector can write that line.
 *
 * THAT ARGUMENT HOLDS ONLY WHILE THE FOLD IS THE ONLY DOOR. While `requestedInvoicePayment` and its
 * result type were exported, a new connector could import the raw resolver and write exactly the
 * line the fold was built to prevent, and nothing in the module API would have stopped it. The two
 * production callers happening to use the fold is not the invariant; the EXPORT LIST is.
 *
 * ASSERTED AGAINST THE SOURCE, for the reason the refusal-vocabulary guard gives: the defect is the
 * PRESENCE of an export and the ABSENCE of any importer, and a type-level test cannot see either.
 *
 * HOW THE TESTS REACH THE RESOLVER NOW: they do not import it. Every payload shape is driven through
 * a real connector pass — `repairXeroBackReferences` in tests/accounting/xero-payment-mapping-refusal
 * and `processPendingQuickBooksSync` in tests/connectors/quickbooks-payment-mapping-refusal — which
 * is the same door production uses. A test that imported the resolver directly would be re-opening
 * the door in order to check that it is shut.
 *
 * REVERT EVIDENCE: putting `export` back on either the function or the type in
 * lib/domain/accounting/followup-enqueue-outcome.ts fails "the raw resolver does not leave the
 * module"; adding `requestedInvoicePayment` to any import of that module fails "nothing imports the
 * raw resolver".
 */

const ROOT = process.cwd()
const MODULE_REL = 'lib/domain/accounting/followup-enqueue-outcome.ts'
/** How every importer names the module — the alias form the whole repo uses. */
const MODULE_SPECIFIER = 'followup-enqueue-outcome'

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(path.join(ROOT, dir), { withFileTypes: true })
  const found: string[] = []
  for (const entry of entries) {
    const rel = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      found.push(...await sourceFiles(rel))
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      found.push(rel)
    }
  }
  return found
}

test('[o3d-batch-ret r9] the raw resolver does not leave the module, and the fold does', async () => {
  const source = await readFile(path.join(ROOT, MODULE_REL), 'utf8')

  // Non-vacuity FIRST: both declarations must still be here under these exact spellings, or the
  // "not exported" assertions below would pass over a file that no longer says anything.
  assert.match(source, /^function requestedInvoicePayment\(/m, 'the resolver must still be declared')
  assert.match(source, /^type RequestedInvoicePayment =/m, 'its result type must still be declared')
  assert.match(
    source, /^export async function decideRequestedInvoicePayment\(/m,
    'and the fold must still be EXPORTED — a module that exports neither has no door at all',
  )

  assert.doesNotMatch(
    source, /^export (async )?function requestedInvoicePayment\(/m,
    'the raw resolver must not be exported: an importable resolver lets a new caller write '
      + '`if (r.kind !== \'amount\') return FOLLOW_UPS_ENQUEUED` — the round-7 defect longhand — which '
      + 'is precisely what the fold exists to make unwritable',
  )
  assert.doesNotMatch(
    source, /^export type RequestedInvoicePayment =/m,
    'and nor must its result type: a caller that can name the union can switch on it, and the arm it '
      + 'will forget is `invalid`',
  )
})

test('[o3d-batch-ret r9] nothing imports the raw resolver, and the walk really reached the importers', async () => {
  const files = [...await sourceFiles('lib'), ...await sourceFiles('tests')]
    .filter((rel) => rel !== MODULE_REL)
  assert.ok(files.length > 100, 'the walk must actually collect the tree, or this test asserts nothing')

  const importers: string[] = []
  const foldImporters: string[] = []
  for (const rel of files) {
    const text = await readFile(path.join(ROOT, rel), 'utf8')
    // Static imports, including the multi-line brace lists both connectors use.
    for (const match of text.matchAll(
      new RegExp(String.raw`import\s+(?:type\s+)?\{([\s\S]*?)\}\s*from\s+'[^']*${MODULE_SPECIFIER}'`, 'g'),
    )) {
      importers.push(rel)
      const names = match[1].split(',').map((name) => name.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0])
      if (names.includes('decideRequestedInvoicePayment')) foldImporters.push(rel)
      for (const forbidden of ['requestedInvoicePayment', 'RequestedInvoicePayment']) {
        assert.ok(
          !names.includes(forbidden),
          `${rel} imports ${forbidden} from the outcome module. The fold is only mandatory while it is `
            + 'the only door — reach the resolver by driving a connector through '
            + '`decideRequestedInvoicePayment`, the way production does',
        )
      }
    }
    // And the dynamic form, which a brace list would not catch.
    for (const match of text.matchAll(
      new RegExp(String.raw`await import\('[^']*${MODULE_SPECIFIER}'\)\)?\.(\w+)`, 'g'),
    )) {
      assert.ok(
        match[1] !== 'requestedInvoicePayment',
        `${rel} reaches the raw resolver through a dynamic import — the same second door by another route`,
      )
    }
  }

  // The walk must have MATCHED something, or the loop above examined nothing: the module has real
  // importers and both connectors are among them.
  assert.ok(importers.length >= 4, `the outcome module must still be imported somewhere (found ${importers.length})`)
  assert.deepEqual(
    foldImporters.sort(),
    ['lib/connectors/quickbooks/sync-processor.ts', 'lib/connectors/xero/sync-processor.ts'],
    'and the fold is imported by exactly the two connectors that ask the money question',
  )
})
