import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { DocumentNumberingError } from '../../../lib/domain/numbering/mint.ts'
import { parsePattern } from '../../../lib/domain/numbering/pattern.ts'
import { describeSalesInvoiceNumberOwner } from '../../../lib/domain/numbering/invoice-number-owner.ts'

/**
 * OPERATOR WORDING. What an operator reads on the numbering screen and in a refusal speaks of documents, numbers,
 * patterns and counters, not of locks, transactions, tables or tracker ids; every refusal says what to do; and the
 * invoice owner is named the same way everywhere.
 */
const JARGON = /advisory|\btx\b|transaction|row lock|FOR UPDATE|prisma|\bSQL\b|constraint|\bo3d-|\bbead|\bsetting row\b|document_number_sequences/i
const strings = (file: string) => [...readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8').matchAll(/(?:>|`|')([^<>`'{}\n]{20,})(?:<|`|')/g)].map((m) => m[1]!.trim())

test('the screen speaks plainly: no lock, transaction, table or tracker vocabulary in what it shows', () => {
  const shown = readFileSync(new URL('../../../components/settings/document-numbering.tsx', import.meta.url), 'utf8')
  const visible = [...shown.matchAll(/>\s*([^<>{}\n][^<>{}]*?)\s*</g)].map((m) => m[1]!).concat(strings('components/settings/document-numbering.tsx'))
  assert.ok(visible.length > 10, 'precondition: the scan found the screen text')
  for (const text of visible) assert.doesNotMatch(text, JARGON, text)
})

test('every refusal of a pattern says what is wrong in plain words', () => {
  for (const bad of ['', 'PO-', 'PO-{SEQ', 'PO-{NOPE}', 'PO-{SEQ:99}', 'PO {SEQ}', 'x'.repeat(80) + '{SEQ}']) {
    const r = parsePattern(bad)
    assert.equal(r.ok, false)
    if (!r.ok) {
      assert.doesNotMatch(r.error, JARGON, bad)
      assert.match(r.error, /\.$/, 'a full sentence')
    }
  }
})

test('the refusals of the counter name the number in use and the number to choose', () => {
  const e = new DocumentNumberingError('COUNTER_BELOW_USED', 'The next number cannot be 3: sales order number 5 is already in use. Choose 6 or higher.')
  assert.doesNotMatch(e.message, JARGON)
  const source = readFileSync(new URL('../../../lib/domain/numbering/mint.ts', import.meta.url), 'utf8')
  for (const m of source.matchAll(/new DocumentNumberingError\('[A-Z_]+', `([^`]+)`\)/g)) {
    assert.doesNotMatch(m[1]!.replace(/\$\{[^}]+\}/g, ''), JARGON, m[1])
  }
  assert.match(source, /Choose \$\{highestUsed \+ 1\} or higher/)
  assert.match(source, /Reset the counter past the numbers in use/)
  assert.match(source, /Add \{SEQ\} to the pattern first/)
})

test('the invoice owner is named as the owner everywhere it is shown', () => {
  const owner = describeSalesInvoiceNumberOwner()
  assert.doesNotMatch(owner.message, JARGON)
  assert.match(owner.message, /Xeroom/)
  const shown = readFileSync(new URL('../../../components/settings/document-numbering.tsx', import.meta.url), 'utf8')
  assert.match(shown, /Owned by \{overview\.salesInvoice\.ownerLabel\}/)
  assert.doesNotMatch(shown, /Sales invoice[\s\S]{0,400}<Input/, 'the invoice row has no input: it is read-only')
})
