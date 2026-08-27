import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

// ---------------------------------------------------------------------------
// o3d-xnwu r8 + Codex MEDIUM — THE CUTOVER CHECKS ARE A FILE THE DEPLOY RUNS, AND ONE OF THEM
// CATCHES THE CASE THE MIGRATION CALLED UNDETECTABLE.
//
// The migration used to end in a comment block: "run both verification queries below; the cutover
// fails unless both return zero". Nothing ran them. o3d-2sm1.1 (branch o3d-batch-deployseq) adds the
// hook that does — every prisma/migrations/<name>/verify.sql is executed after the schema has moved
// and before the new build is started, and any non-zero count stops the deploy. This migration's
// half of that contract is the verify.sql asserted here.
//
// AND THE THIRD CHECK IS NEW. The migration claimed that an old binary OVERWRITING an already-stamped
// refund park with an invoice hold was invisible — "a non-NULL recordKind and every column of a
// park". That is wrong, and it mattered, because it told an operator not to bother looking. The
// overwritten row does not have every column of a park: it KEEPS THE PARK STAMP and ACQUIRES THE
// HELD-INVOICE PAYLOAD SHAPE, which no legitimate writer produces. The tests below model exactly that
// row and prove the shipped query selects it — and that the two pre-existing checks do not, which is
// why a third one was needed rather than a wider one.
// ---------------------------------------------------------------------------

const MIGRATION_DIR = 'prisma/migrations/20260822120000_shopping_sync_log_record_kind'
const VERIFY = `${MIGRATION_DIR}/verify.sql`

/** Strip `--` line comments; the checks themselves carry no block comments or quoted `--`. */
function stripComments(sql: string): string {
  return sql
    .split(/\r?\n/)
    .map((line) => {
      const at = line.indexOf('--')
      return at === -1 ? line : line.slice(0, at)
    })
    .join('\n')
}

function statements(sql: string): string[] {
  return stripComments(sql)
    .split(';')
    .map((statement) => statement.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

// ---------------------------------------------------------------------------
// A deliberately tiny evaluator for the subset of SQL these checks use, so the assertions below are
// about THE SHIPPED TEXT rather than about a copy of it. It reads the WHERE clause out of verify.sql
// and applies it to modelled rows; if somebody weakens a clause, the query stops selecting the row it
// is here to catch and these tests fail.
// ---------------------------------------------------------------------------

type Row = {
  recordKind: string | null
  connector: string
  direction: string
  entityType: string
  entityId: string | null
  /** o3d-xnwu: check 2 now requires one — every park has it, several other row families do not. */
  externalId: string | null
  status: string
  payload: Record<string, unknown> | null
  /**
   * o3d-xnwu (Codex MEDIUM): checks 4 and 5 read it. A landing clears it, the refund-park recovery
   * action replaces it with a note beginning REFUND_PARK_RECOVERY_NOTE_PREFIX.
   */
  errorMessage: string | null
}

/** SQL NULL. Distinguished from JS undefined so `IS NULL` and a missing key behave alike. */
const NULL = Symbol('sql-null')
type Value = string | typeof NULL

function whereClauseOf(statement: string): string {
  const at = statement.toUpperCase().indexOf(' WHERE ')
  assert.notEqual(at, -1, `statement has no WHERE clause: ${statement}`)
  return statement.slice(at + ' WHERE '.length)
}

/** Split on top-level AND, ignoring anything inside parentheses or string literals. */
function conjuncts(clause: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quoted = false
  let current = ''
  for (let index = 0; index < clause.length; index += 1) {
    const char = clause[index]
    if (quoted) {
      current += char
      if (char === "'") quoted = false
      continue
    }
    if (char === "'") { quoted = true; current += char; continue }
    if (char === '(') depth += 1
    if (char === ')') depth -= 1
    if (depth === 0 && clause.slice(index, index + 5).toUpperCase() === ' AND ') {
      parts.push(current.trim())
      current = ''
      index += 4
      continue
    }
    current += char
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

function jsonType(value: unknown): Value {
  if (value === undefined) return NULL
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  switch (typeof value) {
    case 'object': return 'object'
    case 'string': return 'string'
    case 'number': return 'number'
    case 'boolean': return 'boolean'
    default: return NULL
  }
}

/** `->>` — the text form of a json member, or SQL NULL when it is absent or a json null. */
function jsonText(value: unknown): Value {
  if (value === undefined || value === null) return NULL
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function term(expression: string, row: Row): Value {
  const trimmed = expression.trim()

  const literal = trimmed.match(/^'([\s\S]*)'$/)
  if (literal) return literal[1]

  const typeOfMember = trimmed.match(/^jsonb_typeof\(\s*payload\s*->\s*'([^']+)'\s*\)$/i)
  if (typeOfMember) return row.payload === null ? NULL : jsonType(row.payload[typeOfMember[1]])

  if (/^jsonb_typeof\(\s*payload\s*\)$/i.test(trimmed)) return jsonType(row.payload ?? undefined)

  const member = trimmed.match(/^payload\s*->>\s*'([^']+)'$/i)
  if (member) return row.payload === null ? NULL : jsonText(row.payload[member[1]])

  const column = trimmed.replace(/^"(.*)"$/, '$1')
  assert.ok(column in row, `verify.sql refers to a column this test does not model: ${column}`)
  const value = row[column as keyof Row]
  return value === null || value === undefined ? NULL : String(value)
}

/** SQL LIKE, for the one prefix match check 4 uses. `%` is any run, `_` any single character. */
function likeRegex(pattern: string): RegExp {
  let source = '^'
  for (const char of pattern) {
    if (char === '%') source += '[\\s\\S]*'
    else if (char === '_') source += '[\\s\\S]'
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`${source}$`)
}

function matchesConjunct(condition: string, row: Row): boolean {
  const isNotNull = condition.match(/^(.*?)\s+IS\s+NOT\s+NULL$/i)
  if (isNotNull) return term(isNotNull[1], row) !== NULL

  const isNull = condition.match(/^(.*?)\s+IS\s+NULL$/i)
  if (isNull) return term(isNull[1], row) === NULL

  const inList = condition.match(/^(.*?)\s+IN\s*\((.*)\)$/i)
  if (inList) {
    const left = term(inList[1], row)
    if (left === NULL) return false
    const options = inList[2].split(',').map((option) => term(option, row))
    return options.includes(left)
  }

  // `IS DISTINCT FROM` and not `<>` in check 5, because a hold-shaped payload that has LOST its
  // salesOrderId is the same contradiction and `<>` against a missing member is UNKNOWN.
  const distinct = condition.match(/^(.*?)\s+IS\s+DISTINCT\s+FROM\s+(.*)$/i)
  if (distinct) return term(distinct[1], row) !== term(distinct[2], row)

  const like = condition.match(/^(.*?)\s+LIKE\s+(.*)$/i)
  if (like) {
    const left = term(like[1], row)
    const pattern = term(like[2], row)
    if (left === NULL || pattern === NULL) return false
    return likeRegex(pattern).test(left)
  }

  const equality = condition.match(/^(.*?)\s*=\s*(.*)$/)
  assert.ok(equality, `verify.sql uses a comparison this test does not model: ${condition}`)
  const left = term(equality[1], row)
  const right = term(equality[2], row)
  // SQL three-valued logic: NULL = anything is UNKNOWN, which does not select the row.
  if (left === NULL || right === NULL) return false
  return left === right
}

/** Does the numbered check in verify.sql select this row? */
function selects(checkIndex: number, row: Row): boolean {
  const statement = statements(readFileSync(VERIFY, 'utf8'))[checkIndex]
  return conjuncts(whereClauseOf(statement)).every((condition) => matchesConjunct(condition, row))
}

// ---------------------------------------------------------------------------
// The rows. `held` is the payload buildHeldSalesInvoicePayload writes; `refund` is a raw WooCommerce
// refund body, whose `reason` is free text an operator types into the refund dialog.
// ---------------------------------------------------------------------------

const heldPayload = {
  reason: 'missing_wc_invoice_number',
  connector: 'woocommerce',
  externalOrderId: '4021',
  externalOrderNumber: '4021',
  salesOrderId: 'order-1',
  orderNumber: 'SO-1',
  metaKey: '_wcpdf_invoice_number',
  accountingPayload: { salesOrderId: 'order-1', currency: 'GBP' },
}

/** A refund a human issued in WooCommerce, having typed the hold's reason string into the box. */
const refundPayloadWithTypedReason = {
  id: 991,
  amount: '12.00',
  reason: 'missing_wc_invoice_number',
  refunded_by: 7,
  line_items: [],
}

const base: Row = {
  recordKind: 'WC_REFUND_PARK',
  connector: 'woocommerce',
  direction: 'FROM_CONNECTOR',
  entityType: 'SalesOrder',
  entityId: 'order-1',
  // upsertRefundPark always supplies one, and the partial unique index requires it.
  externalId: '991',
  status: 'PENDING',
  payload: refundPayloadWithTypedReason,
  errorMessage: null,
}

/** The exact prefix REFUND_PARK_RECOVERY_NOTE_PREFIX writes; check 4 keys on it. */
const RECOVERY_NOTE = 'Recovered by operator: dismissed as a stale cross-order park. WooCommerce '
  + 'order 4021 did NOT list refund 991 at 2026-08-22T09:00:00.000Z, so this park does not describe '
  + 'this order.'

/** CASE (b): the old binary found this park by `reason` alone and overwrote it with an invoice hold. */
const overwrittenStampedPark: Row = { ...base, recordKind: 'WC_REFUND_PARK', payload: heldPayload }

const genuineHold: Row = { ...base, recordKind: 'WC_HELD_SALES_INVOICE', payload: heldPayload }
const genuinePark: Row = { ...base, payload: { id: 992, amount: '5.00', reason: 'damaged in transit' } }
const parkWithTypedReason: Row = { ...base, payload: refundPayloadWithTypedReason }
const unstampedHold: Row = { ...base, recordKind: null, payload: heldPayload }
const unstampedPark: Row = { ...base, recordKind: null, payload: refundPayloadWithTypedReason }

test('verify.sql declares five checks in the shape the deploy hook executes', () => {
  const sql = readFileSync(VERIFY, 'utf8')
  const all = statements(sql)

  assert.equal(
    all.length,
    5,
    'five mandatory checks: unstamped hold, unstamped park, overwritten park, recovery note on a '
    + 'hold, and a hold payload naming another order',
  )
  for (const [index, statement] of all.entries()) {
    // The contract in scripts/run-migration-verifications.mjs: exactly one row of
    // (check_name, violations), read-only, and every count must be zero.
    assert.match(statement, /^SELECT '[^']+' AS check_name, count\(\*\) AS violations FROM "shopping_sync_logs"/i,
      `check ${index + 1} must return one row of (check_name, violations) from a plain SELECT`)
    assert.doesNotMatch(statement, /\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/i, 'the checks are read-only')
  }

  const names = all.map((statement) => statement.match(/^SELECT '([^']+)'/i)![1])
  assert.equal(new Set(names).size, 5, 'each check names itself distinctly, so a failure says which one')
})

test('CASE (b) IS DETECTABLE: check 3 finds a stamped park overwritten with a held-invoice payload', () => {
  // The row the migration said nothing could see. It still says WC_REFUND_PARK — the old binary does
  // not know the column — while its payload is the shape only buildHeldSalesInvoicePayload writes.
  assert.equal(overwrittenStampedPark.recordKind, 'WC_REFUND_PARK', 'the stamp survives the overwrite')
  assert.equal(overwrittenStampedPark.payload, heldPayload, 'and the payload is now an invoice hold')

  assert.equal(selects(2, overwrittenStampedPark), true, 'so the third check selects it, and the cutover fails')
})

test('and the two pre-existing checks DO NOT see it — which is why a third one was needed', () => {
  // This is the sentence the old prose got right and then drew the wrong conclusion from: both
  // original queries key on `recordKind IS NULL`, and an overwritten row is stamped. They catch a
  // predecessor that CREATED rows; only check 3 catches one that OVERWROTE them.
  assert.equal(selects(0, overwrittenStampedPark), false)
  assert.equal(selects(1, overwrittenStampedPark), false)
})

test('check 3 does not fire on anything a legitimate writer produces', () => {
  // A GENUINE HOLD carries the hold stamp — backfill step 1 runs before step 2, and the new writer
  // stamps at write time. Without this the check would fail every deploy that has any held invoice.
  assert.equal(selects(2, genuineHold), false, 'a real held sales invoice is not an overwritten park')

  // A GENUINE PARK carries a raw refund body. The operator controls `reason` and nothing else, so a
  // park whose reason happens to read 'missing_wc_invoice_number' STILL does not match: it has no
  // accountingPayload object, no salesOrderId, no metaKey. That is the forgery argument the backfill
  // already relies on, asserted rather than assumed.
  assert.equal(selects(2, parkWithTypedReason), false, 'the operator-typed reason alone must not accuse anybody')
  assert.equal(selects(2, genuinePark), false)

  // And an unstamped row is somebody else's check.
  assert.equal(selects(2, unstampedHold), false)
  assert.equal(selects(2, unstampedPark), false)
})

test('check 3 needs the WHOLE held-invoice shape, not the reason and not the stamp alone', () => {
  // Each clause carries weight: drop any one of the three unforgeable ones and a genuine refund park
  // with a typed reason starts matching, which would fail the cutover on an undamaged database.
  const { accountingPayload: _dropped, ...withoutAccountingPayload } = heldPayload
  assert.equal(selects(2, { ...base, payload: withoutAccountingPayload }), false, 'accountingPayload is required')

  const { metaKey: _noKey, ...withoutMetaKey } = heldPayload
  assert.equal(selects(2, { ...base, payload: withoutMetaKey }), false, 'metaKey is required')

  assert.equal(
    selects(2, { ...base, payload: { ...heldPayload, salesOrderId: 'some-other-order' } }),
    false,
    'and salesOrderId must equal the row\'s own entityId — a hold names the order it holds',
  )

  // A nested accountingPayload that is a STRING, not an object: the jsonb_typeof clause is doing work.
  assert.equal(
    selects(2, { ...base, payload: { ...heldPayload, accountingPayload: 'not-an-object' } }),
    false,
    'jsonb_typeof(payload->\'accountingPayload\') = \'object\' is not satisfied by a string',
  )
})

// ---------------------------------------------------------------------------
// o3d-xnwu (Codex MEDIUM) — THE CHECKS MISSED TRANSITIONS AFTER, AND OPPOSITE TO, THE MODELLED
// OVERWRITE.
//
// Three checks modelled ONE predecessor act (the held-invoice writer overwriting a park) in ONE
// state (PENDING). The predecessor does not stop there:
//
//   * its release sweep settles the same row to SYNCED or FAILED, which switched check 3 off while
//     the corruption stood — a check with an off switch the damage itself controls;
//   * its refund-park recovery action, whose predicate has no recordKind clause, admits a HELD
//     SALES INVOICE and lets an operator DISMISS it (SYNCED + a recovery note: the invoice is never
//     posted) or REASSIGN it (a new entityId over an untouched payload). All three original checks
//     returned zero for both.
//
// Checks 4 and 5 are those two signatures, and check 3 no longer reads `status`.
// ---------------------------------------------------------------------------

/** The recovery note a REASSIGN writes; same prefix, different sentence. */
const REASSIGN_NOTE = 'Recovered by operator: reassigned from a stale cross-order park. WooCommerce '
  + 'confirmed refund 991 on order 4022 at 2026-08-22T09:00:00.000Z. The refund has NOT been applied '
  + 'yet — retry it here.'

const heldPayloadWithoutOrderId = (() => {
  const { salesOrderId: _dropped, ...rest } = heldPayload
  return rest
})()

/** CASE (c), DISMISS: the old recovery inbox listed a hold, and an operator retired it. */
const dismissedStampedHold: Row = {
  ...genuineHold, status: 'SYNCED', errorMessage: RECOVERY_NOTE,
}
/** The same act on a hold case (a) had already left unstamped — no stamp to key on. */
const dismissedUnstampedHold: Row = {
  ...unstampedHold, status: 'SYNCED', errorMessage: RECOVERY_NOTE,
}
/** The LEGITIMATE version of the same act: a real refund park, dismissed on purpose. */
const dismissedGenuinePark: Row = {
  ...genuinePark, status: 'SYNCED', errorMessage: RECOVERY_NOTE,
}
/** CASE (c), REASSIGN: the hold now sits on order-2 while its payload still names order-1. */
const reassignedStampedHold: Row = {
  ...genuineHold, entityId: 'order-2', status: 'PENDING', errorMessage: REASSIGN_NOTE,
}
/** And the same act applied to a row check 3 WAS catching, which moves it out of check 3's reach. */
const reassignedOverwrittenPark: Row = {
  ...overwrittenStampedPark, entityId: 'order-2', status: 'PENDING', errorMessage: REASSIGN_NOTE,
}

test('check 3 keeps seeing the overwritten park after the old release sweep settles it', () => {
  // The status clause was the off switch. The SAME predecessor that wrote the contradiction goes on
  // running and flips the row out of PENDING; the stamp still lies and the refund evidence is still
  // gone, so the check must still say so.
  for (const status of ['PENDING', 'FAILED', 'QUARANTINED', 'SYNCED']) {
    assert.equal(
      selects(2, { ...overwrittenStampedPark, status }),
      true,
      `a park stamp over a held-invoice payload is a contradiction in ${status} too`,
    )
  }
})

test('check 4 catches a legacy DISMISS of a held sales invoice — an invoice nothing will ever post', () => {
  // Nothing about this row is NULL, nothing is unstamped, and its payload is untouched. It has just
  // left the release sweep's PENDING selector for ever.
  assert.equal(selects(3, dismissedStampedHold), true, 'the recovery note on a hold payload is the signature')

  // And it is invisible to every check that existed before it.
  assert.equal(selects(0, dismissedStampedHold), false, 'check 1 wants a NULL stamp and PENDING')
  assert.equal(selects(1, dismissedStampedHold), false, 'check 2 wants a NULL stamp')
  assert.equal(selects(2, dismissedStampedHold), false, 'check 3 wants the PARK stamp')
  assert.equal(selects(4, dismissedStampedHold), false, 'a DISMISS does not move entityId — that is check 5')
})

test('check 4 catches the same act on a hold the predecessor never stamped', () => {
  // Case (a) then case (c): created unstamped by the old binary, then dismissed by its own inbox.
  // This is why check 4 deliberately does not read recordKind — there is no stamp to read.
  assert.equal(selects(3, dismissedUnstampedHold), true, 'an unstamped hold can be dismissed too')
})

test('check 4 does not accuse the LEGITIMATE dismissal of a real refund park', () => {
  // The same note, over a raw WooCommerce refund body. This is the normal operator act the recovery
  // action exists for, and it happens on healthy databases — so a check that fired here would fail
  // every later deploy.
  assert.equal(selects(3, dismissedGenuinePark), false, 'a dismissed park is not a dismissed hold')
  assert.equal(
    selects(3, { ...base, status: 'SYNCED', errorMessage: RECOVERY_NOTE }),
    false,
    'not even when the operator typed the hold\'s reason string into the refund dialog',
  )
  assert.equal(selects(3, genuineHold), false, 'and a hold with no note is just a hold')
  assert.equal(
    selects(3, { ...dismissedStampedHold, errorMessage: 'Sync failed: connection reset' }),
    false,
    'an ordinary error message is not a recovery note — the prefix is doing the work',
  )
})

test('check 5 catches a legacy REASSIGN that moved a held invoice onto another order', () => {
  assert.equal(selects(4, reassignedStampedHold), true, 'a hold naming an order it does not sit on')
  assert.equal(selects(3, reassignedStampedHold), true, 'and the note catches it independently')
})

test('check 5 stays silent on every row whose hold payload still names its own row', () => {
  assert.equal(selects(4, genuineHold), false, 'a real hold names the order it holds')
  assert.equal(selects(4, overwrittenStampedPark), false, 'the overwrite copies the row\'s own order id')
  assert.equal(selects(4, genuinePark), false, 'a refund body has no accountingPayload or metaKey')
  assert.equal(selects(4, parkWithTypedReason), false, 'and neither does one with a typed reason')
  assert.equal(selects(4, unstampedPark), false)
})

test('a REASSIGN moves a case-(b) row OUT of check 3 and INTO check 5 — which is why both exist', () => {
  // Check 3's identity clause is payload->>'salesOrderId' = "entityId". The reassign changes the
  // very column it compares, so on its own check 3 would go quiet on damage it had already found.
  assert.equal(selects(2, reassignedOverwrittenPark), false, 'check 3 loses it the moment it is moved')
  assert.equal(selects(4, reassignedOverwrittenPark), true, 'check 5 is where it lands')
})

test('check 5 treats a hold payload that has LOST its order id as the same contradiction', () => {
  // IS DISTINCT FROM, not `<>`: a missing member compares UNKNOWN and would select nothing, so the
  // one state that says "this payload no longer names anything" would be the one state ignored.
  assert.equal(
    selects(4, { ...genuineHold, payload: heldPayloadWithoutOrderId }),
    true,
    'a hold-shaped payload with no salesOrderId names no order at all',
  )
})

test('checks 1 and 2 still catch what they always caught', () => {
  // The pre-existing pair, unchanged in meaning by the move out of the comment block: an old binary
  // that CREATED a hold or a park after the backfill leaves it NULL and invisible to both new
  // predicates.
  assert.equal(selects(0, unstampedHold), true, 'an unstamped hold would never be released')
  assert.equal(selects(1, unstampedPark), true, 'an unstamped park is invisible to the recovery inbox')

  // And they do not fire on a correctly stamped database, which is what makes them safe to run on
  // every later deploy.
  assert.equal(selects(0, genuineHold), false)
  assert.equal(selects(1, genuinePark), false)

  // Check 2 is deliberately wider than check 1 — every actionable status, not just PENDING.
  for (const status of ['PENDING', 'FAILED', 'QUARANTINED']) {
    assert.equal(selects(1, { ...unstampedPark, status }), true, `an unstamped ${status} park is still a violation`)
  }
  assert.equal(selects(1, { ...unstampedPark, status: 'SYNCED' }), false, 'a settled row is not actionable')
})

test('the migration prose no longer tells an operator that case (b) is invisible', () => {
  const migration = readFileSync(`${MIGRATION_DIR}/migration.sql`, 'utf8')

  assert.doesNotMatch(
    migration,
    /AND THE VERIFICATION QUERIES CANNOT SEE \(b\)/,
    'the claim that started this: it stopped anybody looking for damage that is one query away',
  )
  assert.doesNotMatch(
    migration,
    /nothing catches one\s*--?\s*that OVERWROTE them/,
    'and the generalisation drawn from it',
  )
  assert.match(migration, /AND IT IS DETECTABLE/, 'the correction is stated where the wrong claim was')
  assert.match(migration, /verify\.sql/, 'and points at the file the deploy script executes')
  assert.match(
    migration,
    /o3d-batch-deployseq/,
    'the sibling branch that owns the deploy ORDER is named, because check 3 is the second line not the first',
  )
  assert.match(
    migration,
    /WHAT IS STILL NOT COVERED/,
    'and the correction does not overclaim: the errorMessage rewrite has no contradictory shape to query',
  )
})

// ---------------------------------------------------------------------------
// THE ORDERING DEPENDENCY, ASSERTED AGAINST THE TREE RATHER THAN AGAINST PROSE.
//
// The previous revision of this file contained the defect it was written to prevent. Round 2 had
// correctly established that scripts/run-migration-verifications.mjs was NOT in this tree, and then
// froze that fact into three tests that asserted the runner was ABSENT, that deploy.sh did NOT
// mention it, and that deploy.sh migrated BEFORE it stopped the predecessor. Every one of them
// passed by confirming the unsafe arrangement, so the arrangement could not be fixed without
// "breaking" the suite — a test locking in a defect.
//
// It is fixed by a COMMIT ORDER, not by a comment: this branch is rebased onto o3d-batch-deployseq,
// so every commit that reorders the deploy is an ancestor of the commit that adds this migration.
// The tests below now assert the safe arrangement, on all three supported entrypoints, and each one
// fails if the migration is ever un-stacked from the ordering work.
// ---------------------------------------------------------------------------

test('the runner that executes these checks is IN this tree, and the migration says so', () => {
  const migration = readFileSync(`${MIGRATION_DIR}/migration.sql`, 'utf8')
  const verify = readFileSync(VERIFY, 'utf8')

  // The load-bearing fact, checked against the filesystem rather than against prose. Un-stack this
  // branch from o3d-batch-deployseq and this is the first thing that fails.
  assert.equal(
    existsSync('scripts/run-migration-verifications.mjs'),
    true,
    'this migration is only safe when the runner is an ancestor — rebase it back onto o3d-batch-deployseq',
  )

  // And the prose no longer says the opposite. The round-2 wording was accurate then and is a
  // falsehood now, which is exactly how stale safety documentation gets believed.
  for (const [name, text] of [['migration.sql', migration], ['verify.sql', verify]] as const) {
    assert.doesNotMatch(text, /NOT (EXIST IN THIS TREE|ON THIS BRANCH)/, `${name} must not still call the runner absent`)
    assert.doesNotMatch(text, /YOU RUN THEM BY HAND/, `${name} must not still ask an operator to run these`)
    assert.match(text, /o3d-batch-deployseq/, `${name} still names where the order comes from`)
  }

  // The dependency is stated as the mechanism it now is, not as a request to a reviewer.
  assert.match(migration, /THE ORDER IS AN ANCESTOR, NOT A REQUEST/, 'the dependency is a commit order')
  assert.match(migration, /REBASED ONTO o3d-batch-deployseq/, 'and says how it is enforced')
  assert.doesNotMatch(migration, /THE MERGE DEPENDENCY, STATED AS A DEPENDENCY/, 'a comment was never a dependency')

  // What survives from every earlier round: the checks are declared, counted, and not copied inline.
  assert.match(migration, /run-migration-verifications\.mjs/, 'the runner is named as the thing that runs them')
  assert.match(migration, /ALL FIVE MUST RETURN 0/)
  assert.doesNotMatch(migration, /SELECT count\(\*\) FROM "shopping_sync_logs"/, 'no second copy of the checks')
})

test('this migration is NAMED in verification-required.txt, so deleting verify.sql fails CI', () => {
  // Without this line the checks are only as durable as the file: remove verify.sql and the runner
  // reports "nothing declared" and exits 0. With it, the same removal is a coverage gap that is
  // fatal under --strict.
  const required = readFileSync('prisma/migrations/verification-required.txt', 'utf8')
  const declared = required
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter(Boolean)

  assert.ok(
    declared.includes('20260822120000_shopping_sync_log_record_kind'),
    'the migration whose safety argument is "which binary was serving" must declare a verify.sql',
  )
  assert.equal(existsSync(VERIFY), true, 'and the file it declares must exist')
})

test('EVERY supported entrypoint stops the writers before this migration, and verifies after it', () => {
  // The round-2 version of this test asserted the OPPOSITE for deploy.sh — that it migrated before
  // it stopped anything — and a second one asserted deploy.sh did not mention the runner at all.
  // Both passed. install.sh is in the list because it explicitly supports being re-run over an
  // existing installation, which is the path a person who does not know the deploy order will take.
  for (const script of ['scripts/deploy.sh', 'scripts/update.sh', 'scripts/install.sh']) {
    const source = readFileSync(script, 'utf8')
    const code = source
      .split(/\r?\n/)
      .map((line) => (/^\s*#/.test(line) ? '' : line))
      .join('\n')

    // Scoped to the APP unit. `systemctl start postgresql` in install.sh's prerequisites is not a
    // release of this application, and matching it made the ordering assertion below meaningless.
    // tests/scripts/deploy-order.test.ts owns the rigorous per-script ordering; this one exists so
    // that un-stacking THIS migration from the ordering work fails in the migration's own suite.
    const stopAt = code.search(/systemctl stop "\$\{?(unit|SERVICE_UNIT|APP_NAME)/)
    const migrateAt = code.indexOf('prisma migrate deploy')
    const verifyAt = code.indexOf('run-migration-verifications.mjs')
    const startAt = code.search(/systemctl (start|enable --now) "\$\{?(unit|SERVICE_UNIT|APP_NAME)/)

    assert.ok(migrateAt > 0, `${script} must run the migration`)
    assert.ok(stopAt > 0, `${script} must stop the predecessor`)
    assert.ok(verifyAt > 0, `${script} must execute the declared verification checks`)
    assert.ok(startAt > 0, `${script} must start the new build`)

    assert.ok(stopAt < migrateAt, `${script} must stop the predecessor BEFORE the schema moves`)
    assert.ok(migrateAt < verifyAt, `${script} must verify AFTER the schema has moved`)
    assert.ok(verifyAt < startAt, `${script} must verify BEFORE anything is started`)
  }
})

test('an install.sh RERUN over an existing installation takes the cutover, not the greenfield path', () => {
  // Codex HIGH: `systemctl enable --now` does not restart an already-active unit, so an installer
  // rerun that only ever called it would have migrated underneath a live predecessor and then left
  // the OLD process serving the NEW schema. The fix is that a rerun is detected and stopped first.
  const install = readFileSync('scripts/install.sh', 'utf8')
  const code = install.split(/\r?\n/).map((line) => (/^\s*#/.test(line) ? '' : line)).join('\n')

  const detectAt = code.indexOf('if upgrade_in_place; then')
  assert.ok(detectAt > 0, 'a rerun over an existing installation must be detected')

  const stopAt = code.indexOf('systemctl stop', detectAt)
  const legacyAt = code.indexOf('stop_legacy_launchers', detectAt)
  const drainAt = code.indexOf('check-db-writers.mjs', detectAt)
  const migrateAt = code.indexOf('prisma migrate deploy', detectAt)

  for (const [what, at] of [
    ['stop the service', stopAt],
    ['stop the launchers systemd does not own', legacyAt],
    ['prove with the database that nothing else is connected', drainAt],
  ] as const) {
    assert.ok(at > detectAt, `an installer rerun must ${what}`)
    assert.ok(at < migrateAt, `an installer rerun must ${what} BEFORE the schema moves`)
  }
})

test('check 2 is described as the SUPERSET it is, and its repair is not unconditional', () => {
  // MEDIUM. The header claimed the only thing that could make any check non-zero was a predecessor
  // writing the table. Check 2 counts ANY unstamped row of park shape, so the next row family with
  // an entityId trips it on every deploy — written by the CURRENT binary. And the prescribed
  // response, "re-run the two updates", stamps such a row 'WC_REFUND_PARK', which puts it in the
  // recovery inbox with "Wrong order" / "Dismiss" refund actions on it: the r8 defect, recreated by
  // the remedy.
  const verify = readFileSync(VERIFY, 'utf8')
  const migration = readFileSync(`${MIGRATION_DIR}/migration.sql`, 'utf8')

  assert.match(verify, /CHECK 2 IS A SUPERSET/, 'the header no longer gives all three the narrow meaning')
  assert.match(verify, /READ THIS BEFORE ACTING ON A NON-ZERO ANSWER/, 'and check 2 carries its own caveat')
  assert.match(verify, /Wrong order/, 'the caveat names what the blind repair would do to the row')
  assert.match(verify, /CHECK 2 IS REPAIRABLE ONLY AFTER THE ROWS HAVE\s*\n?--\s*BEEN IDENTIFIED|REPAIRABLE ONLY AFTER THE ROWS HAVE/,
    'and the header says the repair is conditional')
  assert.match(migration, /repairable ONLY once the rows\s*\n?-- have been confirmed|repairable ONLY once the rows/,
    'and so does the migration summary')

  // Narrowed as far as the columns allow: a row family that carries an order id but no store-side
  // id no longer trips it.
  const withoutExternalId: Row = { ...base, recordKind: null, externalId: null }
  assert.equal(selects(1, withoutExternalId), false, 'no externalId, no park — the narrowing is real')
  assert.equal(selects(1, { ...withoutExternalId, externalId: '991' }), true, 'and it still catches a real one')
})

test('deploy.sh carries the hook, which is the whole reason verify.sql is executable at all', () => {
  // The inverse of the round-2 assertion. That one said the hook was "the sibling branch's to add"
  // and asserted deploy.sh did NOT mention it — true while the branches were separate, and a
  // guarantee that the unsafe order could never be fixed here without a red suite.
  const deploy = readFileSync('scripts/deploy.sh', 'utf8')
  assert.match(deploy, /run-migration-verifications/, 'the hook this migration depends on is present')
})
