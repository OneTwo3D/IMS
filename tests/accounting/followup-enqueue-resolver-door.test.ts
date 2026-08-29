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

  // o3d-batch-ret ROUND 10: THE SAME RULE FOR THE CLASSIFIER THAT NOW OWNS THE WHOLE BOUNDARY.
  //
  // Round 9 shut the door on the AMOUNT resolver. Round 10 put the request flag, the method, the
  // currency and the date behind the same fold, and every one of them is a value a caller could
  // read and default for itself if it could name the classifier — which is the round-6-to-round-9
  // defect with a different field in it. So the field classifiers and the combined one are
  // module-private on exactly the argument the resolver is.
  for (const declaration of [
    'function invoicePaymentRequest(',
    'function payloadPaymentRequested(',
    'function payloadPaymentMethod(',
    'function payloadPaymentCurrency(',
    'function payloadPaymentDate(',
  ]) {
    const spelling = declaration.replace('(', '\\(')
    assert.match(
      source, new RegExp(`^${spelling}`, 'm'),
      `${declaration}) must still be declared, or the "not exported" assertion below asserts nothing`,
    )
    assert.doesNotMatch(
      source, new RegExp(`^export (async )?${spelling}`, 'm'),
      `${declaration}) must not be exported: a caller that can classify a field for itself can choose `
        + 'what an unreadable one means, and choosing "nothing was owed" is the defect of every round '
        + 'from 6 to 10',
    )
  }
  assert.match(source, /^type InvoicePaymentRequest =/m, 'the combined union must still be declared')
  assert.doesNotMatch(
    source, /^export type InvoicePaymentRequest =/m,
    'and it must not be exported, for the reason its amount-only predecessor is not',
  )
})

/**
 * o3d-batch-ret ROUND 10 (Codex HIGH) — THE BOUNDARY IS CLOSED ONLY WHILE THE CONNECTORS READ
 * NOTHING OUT OF THE PAYLOAD THEMSELVES.
 *
 * Five consecutive rounds each found one more field being read inline with a default, and each fix
 * was a new expression written next to the last one. The shape that ends that is not another fix: it
 * is that neither connector's payment path contains a payload read AT ALL, so a field added later
 * has nowhere to acquire an ad-hoc truthiness test and must go through the classifier.
 *
 * ASSERTED AGAINST THE SOURCE because the defect is the PRESENCE of a read that no behaviour
 * distinguishes until somebody adds the sixth field. Comments are stripped first: both files discuss
 * `payload._registerPayment` at length in prose, and a guard that matched the discussion would fail
 * on the explanation of its own finding.
 *
 * REVERT EVIDENCE: restoring `const currency = payload.currency as string || 'GBP'` to either
 * connector fails naming that file and that field.
 */
test('[o3d-batch-ret r10] neither connector reads the payment payload itself — the fold is the only reader', async () => {
  const stripComments = (text: string): string => text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')

  for (const rel of ['lib/connectors/xero/sync-processor.ts', 'lib/connectors/quickbooks/sync-processor.ts']) {
    const source = await readFile(path.join(ROOT, rel), 'utf8')
    // SCOPED TO THE PAYMENT DECISION, which is the boundary this is about. Both files legitimately
    // read `payload.currency` on the DOCUMENT-BUILD paths (the invoice and credit-note posts), and a
    // guard that swept the whole file would be asserting something it has not reasoned about.
    const from = source.indexOf('async function decideInvoicePaymentFollowUp(')
    const to = source.indexOf('async function enqueueSalesInvoiceFollowUps(')
    assert.ok(from >= 0 && to > from, `${rel}: the payment decision must still be found, and end where it does`)
    const code = stripComments(source.slice(from, to))
    // Non-vacuity: the strip must leave the body, and leave the call that replaced those reads.
    assert.ok(code.length > 500, `${rel}: the comment strip must not have eaten the function body`)
    assert.match(
      code, /decideRequestedInvoicePayment\(payload, \{/,
      `${rel} must still hand the whole payload to the fold, or there is no reader to be the only one`,
    )
    for (const field of ['_registerPayment', '_paymentMethod', '_paymentDate', 'currency']) {
      assert.doesNotMatch(
        code, new RegExp(`payload\\.${field}\\b`),
        `${rel} reads \`payload.${field}\` inline in decideInvoicePaymentFollowUp. Every such read has had to answer what an ABSENT key `
          + 'means and what a PRESENT UNREADABLE value means, and five rounds running the inline answer '
          + 'was the same one — settle. Classify it in followup-enqueue-outcome.ts instead',
      )
    }
  }
})

/**
 * o3d-batch-ret ROUND 11, TIGHTENED IN ROUND 12 (Codex HIGH) — THE BOUNDARY MAY NOT NAME A CURRENCY
 * OF ITS OWN, AND MAY NOT SUBSTITUTE THE IMS ONE FOR THE LEDGER'S EITHER.
 *
 * Round 10 moved every payload read into this module and left ONE literal behind: the absent-
 * `currency` arm answered `'GBP'`. Round 11 replaced that literal with `getBaseCurrencyCode()` — the
 * IMS base currency — on the warrant that the connect-time guards refuse a ledger whose base
 * currency differs. Round 12 found that warrant covers only the path where the remote base could be
 * READ: both guards are truthy-only comparisons over a reader that answers `null` on failure, so a
 * binding whose equality was never established is stored just the same.
 *
 * SO THERE ARE NOW TWO PROHIBITED SOURCES, NOT ONE. A three-letter literal is a currency this module
 * invented. `getBaseCurrencyCode()` is a currency this module BORROWED from the wrong side of the
 * wire — it describes IMS, and what an absent `currency` settles in is whatever the LEDGER
 * denominated the document in. Neither may appear in the classification code; the absent arm refuses
 * instead (o3d-emus restores a default once the verified remote base is persisted, and when it does
 * the value will come from the BINDING, not from `@/lib/base-currency`).
 *
 * The behavioural proof is in the two connector suites; this is the SOURCE half, because both
 * defects are a value written into this module and the next one would be added the same way.
 *
 * REVERT EVIDENCE: restoring `const BASE_PAYMENT_CURRENCY = 'GBP'` fails "the payload boundary names
 * no currency of its own"; restoring round 11's `resolveBasePaymentCurrency` with its
 * `await import('@/lib/base-currency')` fails "and it does not borrow the IMS base currency for the
 * ledger's".
 */
test('[o3d-batch-ret r12] the payload boundary names no currency of its own and borrows none from IMS either', async () => {
  const source = await readFile(path.join(ROOT, MODULE_REL), 'utf8')
  // Comments FIRST: this module explains the finding at length and quotes the shipped
  // `payload.currency as string || 'GBP'` while doing so. A guard that matched the explanation of
  // its own defect would be unfixable.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
  assert.ok(code.length > 2000, 'the comment strip must not have eaten the module, or this asserts nothing')

  // NON-VACUITY: the strip must have left the classifier that used to hold the literal, AND the
  // refusal the absent arm now takes instead. Both `assert.doesNotMatch`es below pass trivially over
  // an empty string, so the thing they are about has to be shown to still be here.
  assert.match(code, /^function payloadPaymentCurrency\(/m, 'the currency classifier must still be in the stripped source')
  assert.match(
    code, /const LEDGER_BASE_UNVERIFIED\b/,
    'and the absent arm\'s refusal must still be in it — if this constant went away the module took a '
      + 'default again, and the two prohibitions below would be guarding nothing',
  )
  assert.match(
    code, /if \(!declaresField\(payload, 'currency'\)\) return \{ detail: LEDGER_BASE_UNVERIFIED \}/,
    'and the absent arm must be the one that takes it',
  )

  const literals = [...code.matchAll(/'([A-Z]{3})'/g)].map((m) => m[1])
  assert.deepEqual(
    literals, [],
    'a three-letter currency literal in the payload boundary is a currency this module decided for '
      + `itself (found ${literals.join(', ')}). An absent \`currency\` is settled in whatever the LEDGER `
      + 'denominated the document in, which no constant here can know',
  )

  assert.doesNotMatch(
    code, /await import\('@\/lib\/base-currency'\)/,
    'the payload boundary must not read the IMS base currency. It is not the ledger\'s: the '
      + 'connect-time guards compare the two only when the remote one can be READ, and store the '
      + 'binding either way, so substituting one for the other asserts an equality nothing '
      + 'established (o3d-emus)',
  )
  assert.doesNotMatch(
    code, /getBaseCurrencyCode/,
    'and not by name either — a second route to the same value is the same substitution',
  )

  // AND NEITHER CONNECTOR MAY REACH FOR IT ON THIS PATH. Round 11 wanted this so the two could not
  // disagree about a resolved value; round 12 wants it because there is no value to resolve, and a
  // connector that resolved one would be re-introducing the substitution one frame out.
  for (const rel of ['lib/connectors/xero/sync-processor.ts', 'lib/connectors/quickbooks/sync-processor.ts']) {
    const connector = await readFile(path.join(ROOT, rel), 'utf8')
    const from = connector.indexOf('async function decideInvoicePaymentFollowUp(')
    const to = connector.indexOf('async function enqueueSalesInvoiceFollowUps(')
    assert.ok(from >= 0 && to > from, `${rel}: the payment decision must still be found`)
    const body = connector.slice(from, to)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '')
    assert.ok(body.length > 500, `${rel}: the comment strip must not have eaten the function body`)
    assert.doesNotMatch(
      body, /getBaseCurrencyCode/,
      `${rel} reads the IMS base currency inside the payment decision. Nothing on this path may: it `
        + 'is not the currency the ledger denominated the document in, and the fold is the one place '
        + 'that answer is decided — which is what Codex asked for when it asked that the '
        + 'document-post and follow-up paths agree',
    )
  }
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
      for (const forbidden of [
        'requestedInvoicePayment', 'RequestedInvoicePayment',
        // o3d-batch-ret r10: and the classifier that now owns the flag, the method, the currency
        // and the date as well.
        'invoicePaymentRequest', 'InvoicePaymentRequest', 'payloadPaymentRequested',
      ]) {
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
