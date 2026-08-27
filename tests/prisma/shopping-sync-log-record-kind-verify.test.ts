import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

import {
  HELD_SALES_INVOICE_ORDER_MISSING_MESSAGE,
  HELD_SALES_INVOICE_SUPERSEDED_PREFIX,
  HELD_SALES_INVOICE_UNREADABLE_MESSAGE,
} from '@/lib/connectors/woocommerce/sync/held-sales-invoice'

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
const MIGRATION = `${MIGRATION_DIR}/migration.sql`

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

/**
 * Split on a top-level operator, ignoring anything inside parentheses or string literals.
 *
 * o3d-xnwu r9: generalised from AND-only. Check 6 is a conjunction with one disjunctive term — the
 * three sentences the predecessor's release sweep writes — so the evaluator has to understand OR and
 * parentheses or it cannot be run against the shipped text at all. The quote tracking is what keeps
 * an ' OR ' inside a message literal from being read as an operator.
 */
function splitTopLevel(clause: string, operator: 'AND' | 'OR'): string[] {
  const needle = ` ${operator} `
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
    if (depth === 0 && clause.slice(index, index + needle.length).toUpperCase() === needle) {
      parts.push(current.trim())
      current = ''
      index += needle.length - 1
      continue
    }
    current += char
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

/** Strip one pair of parentheses that encloses the WHOLE expression, and nothing else. */
function unwrap(expression: string): string {
  const trimmed = expression.trim()
  if (!trimmed.startsWith('(')) return trimmed
  let depth = 0
  for (let index = 0; index < trimmed.length; index += 1) {
    if (trimmed[index] === '(') depth += 1
    else if (trimmed[index] === ')') {
      depth -= 1
      if (depth === 0) return index === trimmed.length - 1 ? unwrap(trimmed.slice(1, -1)) : trimmed
    }
  }
  return trimmed
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
  // o3d-xnwu r10 — `(<held shape>) IS NOT TRUE`, the null-safe negation backfill statement 2 and
  // check 6 now use. SQL's three-valued logic is what makes the spelling load-bearing: every member
  // being compared may be ABSENT, absent is NULL, and `NOT (UNKNOWN)` is UNKNOWN — so a plain NOT
  // would drop such a row out of BOTH the hold side and the park side. `IS NOT TRUE` folds UNKNOWN
  // in with FALSE. This evaluator is two-valued by construction (every leaf returns false for both
  // FALSE and UNKNOWN, see the `=` handler below), so "not TRUE" is exactly its complement.
  const isNotTrue = condition.match(/^([\s\S]*?)\s+IS\s+NOT\s+TRUE$/i)
  if (isNotTrue) return !matchesCondition(isNotTrue[1], row)

  // ...and the mutation this is here to stop. `NOT (…)` parses in Postgres and is WRONG, so it is
  // rejected by name rather than falling through to an unhelpful "comparison not modelled".
  assert.ok(
    !/^NOT\s*\(/i.test(condition.trim()),
    `verify.sql negates with NOT, which is UNKNOWN over an absent json member and drops the row from `
      + `BOTH sides of the classification. Use "(…) IS NOT TRUE": ${condition}`,
  )

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

/** AND / OR / parentheses over the leaf comparisons above. */
function matchesCondition(expression: string, row: Row): boolean {
  const trimmed = unwrap(expression)
  const ors = splitTopLevel(trimmed, 'OR')
  if (ors.length > 1) return ors.some((part) => matchesCondition(part, row))
  const ands = splitTopLevel(trimmed, 'AND')
  if (ands.length > 1) return ands.every((part) => matchesCondition(part, row))
  return matchesConjunct(trimmed, row)
}

/** Does the numbered check in verify.sql select this row? */
function selects(checkIndex: number, row: Row): boolean {
  const statement = statements(readFileSync(VERIFY, 'utf8'))[checkIndex]
  return matchesCondition(whereClauseOf(statement), row)
}

/* ------------------------------------------------------------------------------------------------
 * ...AND THE SAME EVALUATOR OVER THE BACKFILL, WHICH NOTHING USED TO RUN (o3d-xnwu r9, Codex HIGH).
 *
 * The two UPDATE statements in migration.sql are a CLASSIFIER, and until this round no test applied
 * them to a row. The HIGH was inside one of them: statement 1 recognised a hold only while PENDING,
 * so a hold the predecessor's own release sweep had settled to FAILED fell through to statement 2 —
 * the catch-all — and was stamped a refund park.
 * ---------------------------------------------------------------------------------------------- */

/** The two UPDATE statements, in file order. The ALTER carries no WHERE and is not one of them. */
function backfillStatements(): string[] {
  return statements(readFileSync(MIGRATION, 'utf8'))
    .filter((statement) => /^UPDATE "shopping_sync_logs"/i.test(statement))
}

function backfillSelects(step: 0 | 1, row: Row): boolean {
  return matchesCondition(whereClauseOf(backfillStatements()[step]), row)
}

/**
 * What the backfill leaves in `recordKind`, running the statements IN ORDER.
 *
 * Statement 2 requires `recordKind IS NULL`, so a row statement 1 stamped is already out of its
 * reach — which is modelled by returning at the first match rather than by mutating a copy.
 */
function backfillStamp(row: Row): string | null {
  if (backfillSelects(0, row)) return 'WC_HELD_SALES_INVOICE'
  if (backfillSelects(1, row)) return 'WC_REFUND_PARK'
  return row.recordKind
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

test('verify.sql declares six checks in the shape the deploy hook executes', () => {
  const sql = readFileSync(VERIFY, 'utf8')
  const all = statements(sql)

  assert.equal(
    all.length,
    6,
    'six mandatory checks: unstamped hold, unstamped park, overwritten park, recovery note on a '
    + 'hold, a hold payload naming another order, and a held-release outcome on a row that is not a hold',
  )
  for (const [index, statement] of all.entries()) {
    // The contract in scripts/run-migration-verifications.mjs: exactly one row of
    // (check_name, violations), read-only, and every count must be zero.
    assert.match(statement, /^SELECT '[^']+' AS check_name, count\(\*\) AS violations FROM "shopping_sync_logs"/i,
      `check ${index + 1} must return one row of (check_name, violations) from a plain SELECT`)
    assert.doesNotMatch(statement, /\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/i, 'the checks are read-only')
  }

  const names = all.map((statement) => statement.match(/^SELECT '([^']+)'/i)![1])
  assert.equal(new Set(names).size, 6, 'each check names itself distinctly, so a failure says which one')
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
  assert.equal(selects(0, dismissedStampedHold), false, 'check 1 wants a NULL stamp')
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
  // r9: the paragraph that used to END here now says why that admission was not enough. The claim
  // it made — that a settled mis-selected park "has no contradictory shape to query for" — was
  // wrong: the MESSAGE is the shape, and check 6 queries it.
  assert.match(
    migration,
    /WHAT IS STILL NOT COVERED/,
    'the earlier admission is quoted rather than deleted, so the correction is legible',
  )
  assert.match(
    migration,
    /IT HAS ONE, AND IT IS THE MESSAGE/,
    'and it is answered rather than restated — an acknowledged blind spot is still a blind spot',
  )
})

/* ================================================================================================
 * o3d-xnwu r9 (Codex HIGH) — THE BACKFILL TURNED FAILED HOLDS INTO REFUND PARKS.
 *
 * Statement 1 recognised a hold only while PENDING. That is the status a hold is WRITTEN in, not the
 * status it is always FOUND in: the predecessor's own release sweep settles a hold to FAILED when
 * its order cannot be found or its payload will not read, and its recovery inbox settles one to
 * SYNCED. Statement 1 skipped every one of those; statement 2 — the catch-all, which DOES read
 * FAILED — then stamped them 'WC_REFUND_PARK'.
 *
 * A gate keyed on state the damage itself can change. It is the same defect the previous round
 * removed from check 3, and check 1 in verify.sql had the third instance of it.
 * ============================================================================================== */

/** A legacy hold the release sweep already closed because its order was gone. */
const failedPredecessorHold: Row = {
  ...unstampedHold, status: 'FAILED', errorMessage: HELD_SALES_INVOICE_ORDER_MISSING_MESSAGE,
}
/** ...and one it closed because the order was already invoiced by another route. */
const syncedPredecessorHold: Row = {
  ...unstampedHold,
  status: 'SYNCED',
  errorMessage: `${HELD_SALES_INVOICE_SUPERSEDED_PREFIX}INV-2026-0088, so the held sales invoice was not released.`,
}

test('the backfill classifies a held invoice by its SHAPE, in every status a hold can be found in', () => {
  // ROUTE PROOF: these go through the two UPDATE statements read out of the shipped migration.sql,
  // in file order, with statement 2 unreachable for anything statement 1 stamped — which is what
  // makes "step 1 skipped it" and "step 2 caught it" a single measurable outcome.
  assert.equal(backfillStatements().length, 2, 'the backfill is the two UPDATE statements')

  for (const status of ['PENDING', 'FAILED', 'SYNCED', 'QUARANTINED']) {
    // MUTATION THAT KILLS THIS TEST: put `AND status = 'PENDING'` back on statement 1. FAILED and
    // QUARANTINED then fall through to statement 2 and come back 'WC_REFUND_PARK'; SYNCED comes back
    // null. Three of the four rows change answer.
    assert.equal(
      backfillStamp({ ...unstampedHold, status }),
      'WC_HELD_SALES_INVOICE',
      `a held-invoice payload in ${status} is a held sales invoice`,
    )
  }
})

test('a hold the predecessor already settled is never stamped a refund park', () => {
  // The two rows the HIGH is actually about — a hold carrying the release sweep's own closing
  // message. Before the fix the FAILED one came back 'WC_REFUND_PARK': stamped a park over a
  // held-invoice payload, which is precisely what check 3 exists to catch, so the CUTOVER FAILS
  // after the service has been stopped and the schema has moved — an outage caused by the migration
  // itself.
  assert.equal(backfillStamp(failedPredecessorHold), 'WC_HELD_SALES_INVOICE')
  assert.equal(backfillStamp(syncedPredecessorHold), 'WC_HELD_SALES_INVOICE')

  // And the self-inflicted check-3 failure is gone with it: the row the backfill produces is not a
  // park stamp over a held-invoice payload, because it is not stamped a park.
  assert.equal(
    selects(2, { ...failedPredecessorHold, recordKind: backfillStamp(failedPredecessorHold) }),
    false,
    'the backfill no longer manufactures the contradiction check 3 stops the deploy for',
  )
  assert.equal(
    selects(2, { ...failedPredecessorHold, recordKind: 'WC_REFUND_PARK' }),
    true,
    '...and check 3 really would have stopped it — the assertion above is not vacuous',
  )
})

test('statement 2 refuses the held shape ON ITS OWN, not merely because statement 1 ran first', () => {
  // The catch-all declares everything it does not recognise a refund park. Its only protection used
  // to be that some earlier statement had been broad enough — which is one narrowing away from
  // mis-stamping an invoice hold.
  //
  // MUTATION THAT KILLS THIS TEST: drop the negated held-shape conjunct from statement 2. (It used
  // to be `AND payload->>'metaKey' IS NULL` — one field, which r10 showed the store can forge; the
  // clause is now the null-safe negation of the complete predicate statement 1 asserts.)
  for (const status of ['PENDING', 'FAILED', 'QUARANTINED']) {
    assert.equal(
      backfillSelects(1, { ...unstampedHold, status }),
      false,
      `the catch-all does not claim a held-invoice payload in ${status}`,
    )
  }

  // ...while it still claims every park it is there for, which is what stops the clause being a
  // narrowing that empties the recovery inbox.
  for (const status of ['PENDING', 'FAILED', 'QUARANTINED']) {
    assert.equal(backfillSelects(1, { ...unstampedPark, status }), true, `an unstamped ${status} park is a park`)
  }
  assert.equal(backfillSelects(1, { ...unstampedPark, status: 'SYNCED' }), false, 'a settled park is not actionable')
})

test('check 1 and backfill statement 1 are the SAME predicate — the repair must match the report', () => {
  // THE THIRD INSTANCE of the status-gated defect, and the reason it had to move with the backfill.
  // The prescribed repair for check 1 is "re-run the two UPDATE statements", so anything check 1
  // reports must be something statement 1 will stamp. Fix one and not the other and the repair falls
  // through to statement 2 — which stamps an invoice hold 'WC_REFUND_PARK'.
  const check = whereClauseOf(statements(readFileSync(VERIFY, 'utf8'))[0])
  const backfill = whereClauseOf(backfillStatements()[0])

  const normalise = (clause: string) => splitTopLevel(clause, 'AND').map((part) => part.trim()).sort()
  // MUTATION THAT KILLS THIS TEST: restore `status = 'PENDING'` to either one alone.
  assert.deepEqual(normalise(check), normalise(backfill),
    'check 1 is backfill statement 1 written as a SELECT — they may not drift')
})

test('check 1 keeps seeing an unstamped hold after the predecessor settles it', () => {
  for (const row of [failedPredecessorHold, syncedPredecessorHold]) {
    // MUTATION THAT KILLS THIS TEST: restore `AND status = 'PENDING'` to check 1.
    assert.equal(selects(0, row), true, `an unstamped hold in ${row.status} is still an unstamped hold`)
  }
  // ...and it still says nothing about a correctly stamped one, in any status.
  for (const status of ['PENDING', 'FAILED', 'SYNCED']) {
    assert.equal(selects(0, { ...genuineHold, status }), false, `a stamped hold in ${status} is fine`)
  }
  // ...nor about a park, which is check 2's business.
  assert.equal(selects(0, unstampedPark), false)
})

/* ================================================================================================
 * o3d-xnwu r9 (Codex MEDIUM) — A LEGACY RELEASE THAT RETIRES A REFUND PARK.
 *
 * The predecessor's release sweep selects a hold by payload->>'reason' — operator-controlled text —
 * so it picks up genuine refund parks. It then writes ONLY status, syncedAt and errorMessage. The
 * payload and the stamp stay consistent, so all five earlier checks return zero; and the
 * 'Superseded' outcome writes SYNCED, which activeRefundParkWhere does not list. The park, carrying
 * a real unrefunded amount, is hidden for ever.
 *
 * The migration's own comments already ACKNOWLEDGED this transition and enforced nothing about it.
 * ============================================================================================== */

const SUPERSEDED_NOTE = `${HELD_SALES_INVOICE_SUPERSEDED_PREFIX}INV-2026-0088, so the held sales invoice was not released.`

/** THE ONE THAT HIDES MONEY: a genuine park, settled SYNCED by a sweep with no business selecting it. */
const supersededPark: Row = { ...parkWithTypedReason, status: 'SYNCED', errorMessage: SUPERSEDED_NOTE }
const missingOrderPark: Row = {
  ...parkWithTypedReason, status: 'FAILED', errorMessage: HELD_SALES_INVOICE_ORDER_MISSING_MESSAGE,
}
const unreadablePark: Row = {
  ...parkWithTypedReason, status: 'FAILED', errorMessage: HELD_SALES_INVOICE_UNREADABLE_MESSAGE,
}

test('check 6 catches all three held-release outcomes landing on a row that is not a hold', () => {
  // MUTATION THAT KILLS THIS TEST: delete check 6 from verify.sql, or narrow its message list. Each
  // row below is selected by exactly one of the three disjuncts, so dropping any one goes red.
  assert.equal(selects(5, supersededPark), true, 'the SYNCED outcome — the one that hides the refund')
  assert.equal(selects(5, missingOrderPark), true, 'the missing-order outcome')
  assert.equal(selects(5, unreadablePark), true, 'the unreadable-payload outcome — what a refund body looks like to the hold validator')
})

test('and NONE of the five earlier checks sees the superseded park — which is why check 6 exists', () => {
  // The payload is untouched, so 3, 4 and 5 (all keyed on the held-invoice shape) see nothing. The
  // stamp is untouched, so 1 and 2 (both keyed on a NULL stamp) see nothing. Every count is zero
  // while an unresolved monetary refund has left the inbox.
  for (const check of [0, 1, 2, 3, 4]) {
    assert.equal(selects(check, supersededPark), false, `check ${check + 1} returns zero over it`)
  }
})

test('check 6 stays silent on a GENUINE hold settled by the very same sweep', () => {
  // This is the legitimate, everyday act: the sweep closing a hold it really did select. It happens
  // on healthy databases, so a check that fired here would fail every later deploy. What separates
  // them is the COMPLETE held-invoice shape — the reason, the accountingPayload object, the identity
  // and the key together. It was `metaKey` alone until r10, which is exactly what a store-supplied
  // member could forge.
  for (const note of [HELD_SALES_INVOICE_ORDER_MISSING_MESSAGE, HELD_SALES_INVOICE_UNREADABLE_MESSAGE, SUPERSEDED_NOTE]) {
    assert.equal(
      selects(5, { ...genuineHold, status: 'FAILED', errorMessage: note }),
      false,
      'a hold settled by the hold sweep is not a contradiction',
    )
    assert.equal(
      selects(5, { ...unstampedHold, status: 'FAILED', errorMessage: note }),
      false,
      'and neither is an UNSTAMPED hold settled by it — that is check 1',
    )
  }
})

test('check 6 covers the blind spot check 2 deliberately keeps', () => {
  // THE SWEEP OF THE WHOLE FILE for gates keyed on state the damage can change. Check 2 still reads
  // status, and that is kept on purpose: its list is exactly activeRefundParkWhere's, so an
  // unstamped SYNCED row is invisible to the recovery inbox whether it is stamped or not and there
  // is nothing stamping would fix. What makes that a decision rather than the same defect a third
  // time is that check 6 reads NEITHER the status NOR the stamp, and catches the act that produced
  // the SYNCED row.
  const unstampedSupersededPark: Row = { ...unstampedPark, status: 'SYNCED', errorMessage: SUPERSEDED_NOTE }

  assert.equal(selects(1, unstampedSupersededPark), false, 'check 2 does not see it, by design')
  assert.equal(selects(1, { ...unstampedSupersededPark, status: 'PENDING' }), true,
    '...and it is the STATUS that closes check 2, so the assertion above is about the right clause')
  // MUTATION THAT KILLS THIS TEST: give check 6 a status or a recordKind clause.
  assert.equal(selects(5, unstampedSupersededPark), true, 'check 6 has neither clause, and catches it')
})

test('check 6 stays silent on every ordinary park', () => {
  assert.equal(selects(5, genuinePark), false, 'no message, no accusation')
  assert.equal(selects(5, parkWithTypedReason), false, 'a typed reason is not a sweep outcome')
  assert.equal(
    selects(5, { ...parkWithTypedReason, status: 'SYNCED', errorMessage: RECOVERY_NOTE }),
    false,
    'an operator dismissal is check 4\'s business, and a legitimate act on a park besides',
  )
  assert.equal(
    selects(5, { ...parkWithTypedReason, status: 'FAILED', errorMessage: 'Sync failed: connection reset' }),
    false,
    'an ordinary error is not one of the three sentences',
  )
  assert.equal(
    selects(5, { ...parkWithTypedReason, status: 'SYNCED', errorMessage: 'Superseded: something else entirely' }),
    false,
    'and the LIKE is anchored on the sweep\'s own wording, not on the word "Superseded"',
  )
})

test('check 6 keys on the message the CODE writes, so the writer cannot drift away from it', () => {
  // A check that matches a string literal and a writer that types one are two copies of one fact,
  // and the copy in the migration cannot be recompiled. So the three sentences are exported
  // constants, and this is the link between them.
  const verify = readFileSync(VERIFY, 'utf8')
  for (const message of [
    HELD_SALES_INVOICE_ORDER_MISSING_MESSAGE,
    HELD_SALES_INVOICE_UNREADABLE_MESSAGE,
    HELD_SALES_INVOICE_SUPERSEDED_PREFIX,
  ]) {
    assert.ok(verify.includes(message), `verify.sql must carry the exact sentence the sweep writes: ${message}`)
  }

  // ...and the sweep really does write them, by the route check 6 assumes: the settle-and-close arms
  // of retryHeldWcSalesInvoiceReleases and the unreadable arm of releaseHeldWcSalesInvoice.
  const importer = readFileSync('lib/connectors/woocommerce/sync/order-import.ts', 'utf8')
  for (const name of [
    'HELD_SALES_INVOICE_ORDER_MISSING_MESSAGE',
    'HELD_SALES_INVOICE_UNREADABLE_MESSAGE',
    'HELD_SALES_INVOICE_SUPERSEDED_PREFIX',
  ]) {
    assert.ok(importer.includes(`errorMessage: ${name}`) || importer.includes(`\${${name}}`),
      `${name} is what the importer writes, not a second copy of the sentence`)
  }
})

/* ================================================================================================
 * o3d-xnwu r10 (Codex HIGH) — A STORE-SUPPLIED `metaKey` USED TO DEFEAT BOTH THE BACKFILL AND THE
 * SETTLED-PARK CHECK.
 *
 * Backfill statement 2 and check 6 both treated `payload->>'metaKey' IS NULL` as PROOF that a row is
 * not a hold. A refund payload is cast from the store's API response and persisted UNCHANGED, so an
 * extension that decorates the refund object — or a malformed response — can put an unrelated
 * top-level `metaKey` on a genuine refund body. One forged field then:
 *
 *   1. made statement 2 refuse to stamp a genuine park (it left the recovery inbox, which selects on
 *      the stamp), and
 *   2. made check 6 blind to the predecessor's sweep superseding that same park — while check 2 was
 *      off because of the status and checks 1 and 3-5 were off because the payload is a raw refund
 *      body. Verification returned zero over a real unrefunded park permanently outside the inbox.
 *
 * A SINGLE FIELD IS NOT A SHAPE. Both negating readers now negate the COMPLETE held-invoice
 * predicate that statement 1 and check 1 already assert positively.
 * ============================================================================================== */

/** The conjuncts of a WHERE clause that speak about the payload — i.e. the held-invoice SHAPE. */
function heldShapeOf(clause: string): string[] {
  return splitTopLevel(clause, 'AND')
    .map((part) => part.trim())
    .filter((part) => /payload/i.test(part))
    .sort()
}

/** The shape inside `(<shape>) IS NOT TRUE`, for the two readers that ask the question backwards. */
function negatedHeldShapeOf(clause: string): string[] {
  const negations = splitTopLevel(clause, 'AND')
    .map((part) => part.trim())
    .filter((part) => /\sIS\s+NOT\s+TRUE$/i.test(part))
  assert.equal(negations.length, 1, `expected exactly one "(…) IS NOT TRUE" conjunct in: ${clause}`)
  const inner = negations[0].replace(/\sIS\s+NOT\s+TRUE$/i, '')
  return splitTopLevel(unwrap(inner), 'AND').map((part) => part.trim()).sort()
}

test('the held-invoice shape is ONE predicate and all FOUR readers carry the same text', () => {
  // ROUTE: pure text, read out of the two shipped .sql files and split on top-level AND. No row is
  // evaluated here on purpose — this is the assertion that the four copies cannot drift, which is
  // the only thing that makes the row-level tests below transferable between them.
  //
  // MUTATION THAT KILLS THIS TEST: change, add or drop any payload clause in ANY ONE of the four —
  // e.g. put `payload->>'metaKey' IS NULL` back into statement 2, or drop the identity clause from
  // check 6's negation. The four lists stop being equal.
  const verifyStatements = statements(readFileSync(VERIFY, 'utf8'))
  const positives = [
    ['check 1', heldShapeOf(whereClauseOf(verifyStatements[0]))],
    ['backfill statement 1', heldShapeOf(whereClauseOf(backfillStatements()[0]))],
  ] as const
  const negatives = [
    ['backfill statement 2', negatedHeldShapeOf(whereClauseOf(backfillStatements()[1]))],
    ['check 6', negatedHeldShapeOf(whereClauseOf(verifyStatements[5]))],
  ] as const

  const expected = [
    "jsonb_typeof(payload) = 'object'",
    "payload->>'reason' = 'missing_wc_invoice_number'",
    "jsonb_typeof(payload->'accountingPayload') = 'object'",
    'payload->>\'salesOrderId\' = "entityId"',
    "payload->>'metaKey' IS NOT NULL",
  ].sort()

  for (const [name, shape] of [...positives, ...negatives]) {
    assert.deepEqual(shape, expected, `${name} must read the complete held-invoice shape, not one field of it`)
  }
})

test('the negation is spelled IS NOT TRUE, so an ABSENT member lands on the not-a-hold side', () => {
  // ROUTE: the evaluator refuses `NOT (…)` by name (see matchesConjunct), so this is BOTH a text
  // assertion and a semantic one — and then a row proves the semantics that spelling buys.
  //
  // MUTATION THAT KILLS THIS TEST: rewrite either negation as `NOT (…)`. Postgres accepts it; the
  // evaluator names it as the null-safety defect, and the row below stops being classified at all.
  const migration = readFileSync(MIGRATION, 'utf8')
  const verify = readFileSync(VERIFY, 'utf8')
  for (const [name, sql] of [['migration.sql', migration], ['verify.sql', verify]] as const) {
    assert.ok(sql.includes(') IS NOT TRUE'), `${name} must negate the shape null-safely`)
    assert.ok(!/\bNOT\s*\(\s*$/m.test(sql), `${name} must not negate with a bare NOT (…)`)
  }

  // A row with NO payload at all: every conjunct of the shape is UNKNOWN, so the whole conjunction
  // is UNKNOWN. `IS NOT TRUE` says "not a hold" and the catch-all claims it; `NOT (…)` would say
  // UNKNOWN and NEITHER statement would touch it — an actionable row left with no recordKind, which
  // is precisely the invisibility the discriminator exists to end.
  const payloadless: Row = { ...unstampedPark, payload: null }
  assert.equal(backfillStamp(payloadless), 'WC_REFUND_PARK', 'an absent payload is not a hold')
  assert.equal(backfillSelects(0, payloadless), false, '...and statement 1 does not claim it either')
})

/** THE HOSTILE ROW: a real WooCommerce refund body an extension has decorated with a `metaKey`. */
const forgedMetaKeyRefundPayload = {
  ...refundPayloadWithTypedReason,
  // Not IMS's `_wcpdf_invoice_number` and not in an accountingPayload — just a top-level member the
  // store's response happened to carry. Nothing validates it, because nothing built it.
  metaKey: 'wc_some_extension_meta',
}

const forgedMetaKeyPark: Row = { ...base, recordKind: null, payload: forgedMetaKeyRefundPayload }

test('a genuine park whose refund body carries a forged metaKey is still STAMPED a park', () => {
  // ROUTE: backfillStamp — the two UPDATE statements read out of the shipped migration.sql, in file
  // order, statement 2 unreachable for anything statement 1 stamped.
  //
  // MUTATION THAT KILLS THIS TEST: restore `AND payload->>'metaKey' IS NULL` to statement 2. All
  // three rows below come back null — unstamped, therefore outside activeRefundParkWhere, therefore
  // outside the recovery inbox with a real unrefunded amount on them.
  for (const status of ['PENDING', 'FAILED', 'QUARANTINED']) {
    assert.equal(
      backfillStamp({ ...forgedMetaKeyPark, status }),
      'WC_REFUND_PARK',
      `a ${status} refund body with an unrelated top-level metaKey is still a refund park`,
    )
  }

  // ...and the assertion is not vacuous about WHICH clause did it: statement 1 still refuses the row
  // (it is not a hold), so the stamp above came from the catch-all recognising it as a park.
  assert.equal(backfillSelects(0, forgedMetaKeyPark), false, 'statement 1 does not mistake it for a hold')

  // ...while the exclusion it replaced still does its job: a REAL hold is refused by the catch-all.
  assert.equal(backfillSelects(1, unstampedHold), false, 'the complete shape still excludes a genuine hold')
})

test('check 6 FAILS verification on a superseded park whose refund body carries a forged metaKey', () => {
  // THE SERIOUS HALF. The predecessor's release sweep picks this park up by its typed `reason`,
  // finds the order already invoiced, and writes SYNCED + 'Superseded:'. activeRefundParkWhere lists
  // only PENDING/FAILED/QUARANTINED, so the park is gone from the inbox for ever.
  //
  // ROUTE: selects(5, …) — check 6's WHERE clause read out of the shipped verify.sql.
  //
  // MUTATION THAT KILLS THIS TEST: restore `AND payload->>'metaKey' IS NULL` to check 6. All three
  // outcomes go to false and the whole file returns zero over a park nobody will ever be shown.
  const forgedSupersededPark: Row = {
    ...forgedMetaKeyPark, recordKind: 'WC_REFUND_PARK', status: 'SYNCED', errorMessage: SUPERSEDED_NOTE,
  }
  assert.equal(selects(5, forgedSupersededPark), true, 'the SYNCED outcome — the one that hides the refund')
  assert.equal(
    selects(5, { ...forgedMetaKeyPark, status: 'FAILED', errorMessage: HELD_SALES_INVOICE_ORDER_MISSING_MESSAGE }),
    true,
    'the missing-order outcome',
  )
  assert.equal(
    selects(5, { ...forgedMetaKeyPark, status: 'FAILED', errorMessage: HELD_SALES_INVOICE_UNREADABLE_MESSAGE }),
    true,
    'the unreadable-payload outcome',
  )

  // AND THE OTHER FIVE ARE STILL BLIND TO IT, which is what makes check 6 the only thing standing
  // between this row and a green cutover — the same argument as the unforged case, re-proved for the
  // row that used to slip past all six.
  for (const check of [0, 1, 2, 3, 4]) {
    assert.equal(selects(check, forgedSupersededPark), false, `check ${check + 1} returns zero over it`)
  }
})

test('the identity clause is IN the negation, and check 5 is what makes that safe', () => {
  // WHAT NEGATING THE *COMPLETE* PREDICATE COSTS, stated as a test rather than as a comment. The
  // shape includes `payload->>'salesOrderId' = "entityId"`, so a DEGRADED hold — one a legacy
  // REASSIGN moved onto another order, leaving the payload naming the first — no longer matches the
  // shape, falls to the catch-all, and is STAMPED A REFUND PARK. Under the old one-field exclusion
  // it stayed unstamped instead. Neither outcome is good; this one is the one that is SEEN.
  //
  // ROUTE: backfillStamp (the two shipped UPDATE statements, in file order) and then selects(4, …)
  // — check 5's shipped WHERE clause, which reads neither the stamp nor the status.
  //
  // MUTATION THAT KILLS THIS TEST: drop `AND payload->>'salesOrderId' = "entityId"` from statement
  // 2's negated shape. The degraded hold then matches the shape, the negation goes false, and the
  // first assertion comes back null.
  const reassignedHold: Row = { ...unstampedHold, entityId: 'order-2' }

  assert.equal(backfillSelects(0, reassignedHold), false, 'statement 1 will not stamp it a hold — the identity is broken')
  assert.equal(backfillStamp(reassignedHold), 'WC_REFUND_PARK', 'so the catch-all claims it')

  // ...and that is not silent: check 5 exists for exactly this row, in every status, stamped or not.
  for (const status of ['PENDING', 'FAILED', 'SYNCED', 'QUARANTINED']) {
    assert.equal(
      selects(4, { ...reassignedHold, status, recordKind: 'WC_REFUND_PARK' }),
      true,
      `check 5 stops the cutover over a hold-shaped payload naming another order in ${status}`,
    )
  }

  // The assertion above is about the identity, not about some other clause of check 5: put the
  // payload back on its own order and check 5 goes quiet.
  assert.equal(selects(4, { ...unstampedHold, recordKind: 'WC_REFUND_PARK' }), false)

  // And the alternative the old clause gave — unstamped, therefore only ever reaching check 2, the
  // superset whose own answer is not diagnostic — is what this trade replaces.
  assert.equal(selects(1, { ...reassignedHold, recordKind: null }), true,
    'check 2 is all the old exclusion left; it cannot say WHAT the row is')
})

test('...and the shape must not DRIFT, or check 6 accuses every hold on a healthy database', () => {
  // The complete shape is a narrowing as well as a widening. A genuine hold carries the WHOLE shape,
  // so check 6's negation is FALSE and the check does not select it — in every status, stamped or
  // not. This is the direction that fails EVERY LATER DEPLOY if the shape stops matching what
  // buildHeldSalesInvoicePayload writes.
  //
  // ROUTE: selects(5, …) over the shipped check 6.
  //
  // MUTATION THAT KILLS THIS TEST: drift the reason literal inside check 6's negation (e.g.
  // 'missing_wc_invoice_numbers'). A genuine hold stops matching the shape, the negation becomes
  // true, and every settled hold is reported as a contradiction.
  for (const note of [HELD_SALES_INVOICE_ORDER_MISSING_MESSAGE, HELD_SALES_INVOICE_UNREADABLE_MESSAGE, SUPERSEDED_NOTE]) {
    for (const row of [genuineHold, unstampedHold]) {
      assert.equal(selects(5, { ...row, status: 'FAILED', errorMessage: note }), false,
        'the sweep closing a hold it really did select is not a contradiction')
    }
  }

  // ...and the shape is the reason it is quiet, not the message list: strip the payload back to a
  // refund body and the very same message is reported.
  assert.equal(
    selects(5, { ...unstampedPark, status: 'FAILED', errorMessage: HELD_SALES_INVOICE_UNREADABLE_MESSAGE }),
    true,
    'the assertions above are not vacuous — check 6 does fire on these messages',
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
  assert.match(migration, /ALL SIX MUST RETURN 0/)
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
  // The whole invocation, not the stem: a name that no longer resolves to a file is the same
  // absence with a green test over it.
  assert.match(
    deploy,
    /node scripts\/run-migration-verifications\.mjs/,
    'the hook this migration depends on is invoked, by the path that actually exists',
  )
  assert.equal(existsSync('scripts/run-migration-verifications.mjs'), true, 'and it resolves to a file')
})

/* ================================================================================================
 * o3d-xnwu r11 (Codex HIGH) — CHECKS 4 AND 5 TRUSTED TWO FIELDS AND CALLED IT A SHAPE.
 *
 * Both read only `jsonb_typeof(payload->'accountingPayload') = 'object'` and
 * `payload->>'metaKey' IS NOT NULL`, on the argument that the PAIR is unforgeable. The r10 HIGH one
 * check over had already established the opposite: a refund payload is cast from the store's
 * response and stored UNCHANGED, so a decorating extension controls every top-level member of it —
 * which is exactly why check 6 and backfill statement 2 stopped testing one field. Calling a pair
 * of them unforgeable does not create a trust boundary.
 *
 * AND CHECK 5 CARRIED THE NULL-SAFETY TRAP ONE CHECK OVER. `IS DISTINCT FROM` was chosen so that a
 * hold payload which has LOST its salesOrderId still counts — correct there. Here it means an
 * ABSENT `salesOrderId` SATISFIES the identity clause, so a decorated refund body with no
 * salesOrderId at all — which is every raw WooCommerce refund body — was selected.
 *
 * BEING CAUGHT BY THESE CHECKS IS NOT A SAFE DEGRADATION. verify.sql is the post-migration
 * verification hook: it runs after the schema has moved, with the application and the database both
 * still fenced. A non-zero count there is a deployment outage, every retry fails identically over
 * the same untouched row, and the only way out is hand-editing a customer's refund evidence.
 *
 * The fix is the maximal immutable shape: every member buildHeldSalesInvoicePayload writes that
 * NEITHER recovery action touches. buildRefundParkDismissData writes status, errorMessage and
 * syncedAt; buildRefundParkReassignData adds entityId. Neither writes `payload`, so every payload
 * member is recovery-proof — and the one omission is the identity equality, which is the
 * contradiction these two checks exist to find.
 * ============================================================================================== */

/** Every payload member the two checks may rely on, with the value the writer puts there. */
const RECOVERY_PROOF_MEMBERS = {
  reason: 'missing_wc_invoice_number',
  connector: 'woocommerce',
  externalOrderId: '4021',
  externalOrderNumber: '4021',
  orderNumber: 'SO-1',
  metaKey: '_wcpdf_invoice_number',
  accountingPayload: { salesOrderId: 'order-1', currency: 'GBP' },
} as const

/**
 * THE HOSTILE ROW Codex named: a genuine refund park an extension decorated with BOTH of the fields
 * checks 4 and 5 used to trust, and — like every raw WooCommerce refund body — carrying no
 * `salesOrderId` at all, which is what made `IS DISTINCT FROM` select it.
 */
const decoratedRefundPayload = {
  ...refundPayloadWithTypedReason,
  metaKey: 'wc_some_extension_meta',
  accountingPayload: { plugin: 'some-extension', total: '12.00' },
}

const decoratedPark: Row = { ...base, recordKind: null, payload: decoratedRefundPayload }
const dismissedDecoratedPark: Row = { ...decoratedPark, status: 'SYNCED', errorMessage: RECOVERY_NOTE }
const reassignedDecoratedPark: Row = {
  ...decoratedPark, entityId: 'order-2', status: 'PENDING', errorMessage: REASSIGN_NOTE,
}

test('checks 4 and 5 stay ZERO on a genuine park decorated with both fields they used to trust', () => {
  // ROUTE: the shipped verify.sql, parsed and evaluated over the row. Not a text assertion — the
  // point is what the SQL SELECTS.
  //
  // MUTATION THAT KILLS THIS TEST: drop any one of the six added conjuncts from check 4 or check 5
  // (the reason, the connector, either external-order field, the order number, the metaKey TYPE, or
  // the accountingPayload type). Each removal readmits this row, because a decorated refund body
  // satisfies everything that is left.
  assert.equal(
    selects(3, dismissedDecoratedPark),
    false,
    'a dismissed refund park whose store payload carries an accountingPayload and a metaKey is not a dismissed hold',
  )
  assert.equal(
    selects(4, decoratedPark),
    false,
    'and a decorated refund body with NO salesOrderId must not satisfy IS DISTINCT FROM as a "hold naming another order"',
  )
  assert.equal(selects(4, reassignedDecoratedPark), false, 'not even once an operator has reassigned it')

  // The whole point of the finding: the SAME row is a healthy-database row. Every other check must
  // be quiet over it too, or the deploy fails from somewhere else for the same wrong reason.
  for (const index of [0, 1, 2, 3, 4, 5]) {
    assert.equal(
      selects(index, decoratedPark),
      index === 1,
      `only check 2 (an unstamped actionable park) may see this row, not check ${index + 1}`,
    )
  }
})

test('checks 4 and 5 require EVERY payload member neither recovery action can touch', () => {
  // ROUTE: for each member in turn, remove it from the genuine hold payload and re-evaluate. A
  // check that still fires without a member is a check that is not reading it, so this is what
  // proves each added conjunct is load-bearing rather than decorative.
  //
  // MUTATION THAT KILLS THIS TEST: delete any one conjunct from either check. The corresponding
  // iteration below then still selects, and the assertion fails naming the member.
  for (const member of Object.keys(RECOVERY_PROOF_MEMBERS)) {
    const { [member as keyof typeof heldPayload]: _dropped, ...without } = heldPayload
    assert.equal(
      selects(3, { ...dismissedStampedHold, payload: without }),
      false,
      `check 4 must read payload.${member} — without it the check fires on a payload that is not the writer's`,
    )
    assert.equal(
      selects(4, { ...reassignedStampedHold, payload: without }),
      false,
      `check 5 must read payload.${member} — without it the check fires on a payload that is not the writer's`,
    )
  }

  // ...and the members must be read by TYPE where the writer's type is what identifies them: a
  // metaKey that is a number, or an accountingPayload that is an array, is not what the writer put
  // there. (`payload->>'metaKey' IS NOT NULL` — the clause that used to be here — is satisfied by
  // both.)
  assert.equal(selects(3, { ...dismissedStampedHold, payload: { ...heldPayload, metaKey: 7 } }), false)
  assert.equal(selects(4, { ...reassignedStampedHold, payload: { ...heldPayload, accountingPayload: [] } }), false)

  // AND THE POSITIVE HALF, or "require everything" would pass by selecting nothing at all.
  assert.equal(selects(3, dismissedStampedHold), true, 'the genuine DISMISS of a hold is still caught')
  assert.equal(selects(3, dismissedUnstampedHold), true, 'including on a hold that was never stamped')
  assert.equal(selects(4, reassignedStampedHold), true, 'the genuine REASSIGN of a hold is still caught')
  assert.equal(selects(4, reassignedOverwrittenPark), true, 'and the case-(b) row a REASSIGN moved')
  assert.equal(
    selects(4, { ...genuineHold, payload: heldPayloadWithoutOrderId }),
    true,
    'and a hold-shaped payload that has LOST its order id — the one member whose type is deliberately not asserted',
  )
})

test('checks 4 and 5 carry the complete held-invoice shape MINUS exactly the identity clause', () => {
  // ROUTE: pure text out of the shipped verify.sql, so the two cannot drift apart or drift away
  // from the one thing they are allowed to omit.
  //
  // MUTATION THAT KILLS THIS TEST: add the identity clause back to either (they would then go quiet
  // on the REASSIGN they exist to catch), or drop a shape clause from one and not the other.
  const verifyStatements = statements(readFileSync(VERIFY, 'utf8'))
  const IDENTITY = 'payload->>\'salesOrderId\' = "entityId"'

  const complete = heldShapeOf(whereClauseOf(verifyStatements[0]))
  assert.ok(complete.includes(IDENTITY), 'precondition: check 1 carries the identity clause')

  const shapeOf = (index: number) =>
    heldShapeOf(whereClauseOf(verifyStatements[index])).filter(
      (clause) => clause !== 'payload->>\'salesOrderId\' IS DISTINCT FROM "entityId"',
    )

  const expected = [
    "jsonb_typeof(payload) = 'object'",
    "payload->>'reason' = 'missing_wc_invoice_number'",
    "payload->>'connector' = 'woocommerce'",
    "jsonb_typeof(payload->'externalOrderId') = 'string'",
    "jsonb_typeof(payload->'externalOrderNumber') = 'string'",
    "jsonb_typeof(payload->'orderNumber') = 'string'",
    "jsonb_typeof(payload->'metaKey') = 'string'",
    "jsonb_typeof(payload->'accountingPayload') = 'object'",
  ].sort()

  assert.deepEqual(shapeOf(3), expected, 'check 4 must read the maximal recovery-proof shape')
  assert.deepEqual(shapeOf(4), expected, 'check 5 must read the same one')

  // The identity equality is the ONE omission, and it must be omitted from both: it is the clause a
  // REASSIGN breaks, which is the damage these two exist to catch.
  for (const index of [3, 4]) {
    assert.ok(
      !heldShapeOf(whereClauseOf(verifyStatements[index])).includes(IDENTITY),
      `check ${index + 1} must NOT require salesOrderId = entityId — a REASSIGN moves that column`,
    )
  }
  // ...and check 5 keeps the null-safe spelling of its contradiction, which is what makes a payload
  // that has LOST its order id count.
  assert.ok(
    heldShapeOf(whereClauseOf(verifyStatements[4])).includes(
      'payload->>\'salesOrderId\' IS DISTINCT FROM "entityId"',
    ),
    'check 5 must compare the identity with IS DISTINCT FROM, not <>',
  )
})

test('every member checks 4 and 5 rely on is one no recovery action can write', () => {
  // ROUTE: read the two recovery patches out of the shipped module and assert what they set. A
  // check may only trust a payload member if the act it is detecting cannot have produced it.
  //
  // MUTATION THAT KILLS THIS TEST: make either builder write `payload` (or connector/direction/
  // entityType). The union below stops being the four columns named here.
  const source = readFileSync(`${process.cwd()}/lib/domain/sales/refund-park-recovery.ts`, 'utf8')
  const bodyOf = (fn: string) => {
    const start = source.indexOf(`export function ${fn}(`)
    assert.notEqual(start, -1, `${fn} must exist`)
    const open = source.indexOf('{', start)
    return source.slice(open, source.indexOf('\n}', open))
  }
  const written = new Set<string>()
  for (const fn of ['buildRefundParkReassignData', 'buildRefundParkDismissData']) {
    for (const match of bodyOf(fn).matchAll(/^\s{4}(\w+):/gm)) written.add(match[1])
  }
  assert.deepEqual(
    [...written].sort(),
    ['entityId', 'errorMessage', 'status', 'syncedAt'].sort(),
    'a recovery action that wrote anything else would invalidate the shape checks 4 and 5 rely on',
  )
  for (const column of ['payload', 'connector', 'direction', 'entityType', 'externalId']) {
    assert.ok(!written.has(column), `neither recovery action may write ${column}`)
  }
})
