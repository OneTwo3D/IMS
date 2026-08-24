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
}

/** CASE (b): the old binary found this park by `reason` alone and overwrote it with an invoice hold. */
const overwrittenStampedPark: Row = { ...base, recordKind: 'WC_REFUND_PARK', payload: heldPayload }

const genuineHold: Row = { ...base, recordKind: 'WC_HELD_SALES_INVOICE', payload: heldPayload }
const genuinePark: Row = { ...base, payload: { id: 992, amount: '5.00', reason: 'damaged in transit' } }
const parkWithTypedReason: Row = { ...base, payload: refundPayloadWithTypedReason }
const unstampedHold: Row = { ...base, recordKind: null, payload: heldPayload }
const unstampedPark: Row = { ...base, recordKind: null, payload: refundPayloadWithTypedReason }

test('verify.sql declares three checks in the shape the deploy hook executes', () => {
  const sql = readFileSync(VERIFY, 'utf8')
  const all = statements(sql)

  assert.equal(all.length, 3, 'three mandatory checks: unstamped hold, unstamped park, overwritten park')
  for (const [index, statement] of all.entries()) {
    // The contract in scripts/run-migration-verifications.mjs: exactly one row of
    // (check_name, violations), read-only, and every count must be zero.
    assert.match(statement, /^SELECT '[^']+' AS check_name, count\(\*\) AS violations FROM "shopping_sync_logs"/i,
      `check ${index + 1} must return one row of (check_name, violations) from a plain SELECT`)
    assert.doesNotMatch(statement, /\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/i, 'the checks are read-only')
  }

  const names = all.map((statement) => statement.match(/^SELECT '([^']+)'/i)![1])
  assert.equal(new Set(names).size, 3, 'each check names itself distinctly, so a failure says which one')
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

test('the migration does NOT claim a runner this branch does not have', () => {
  // THE CRITICAL this round answers. The previous revision said, four times over, that
  // scripts/run-migration-verifications.mjs executes these checks after the schema moves and before
  // the new build starts — "ENFORCED, not merely written down". THAT SCRIPT IS NOT IN THIS TREE. It
  // is on o3d-batch-deployseq, which is not an ancestor of HEAD. A migration that promises an
  // automated guard it does not have is worse than one that asks a human, because the human then
  // has no reason to act.
  const migration = readFileSync(`${MIGRATION_DIR}/migration.sql`, 'utf8')
  const verify = readFileSync(VERIFY, 'utf8')

  // The load-bearing fact, checked against the filesystem rather than against prose. The day the
  // sibling merges, this test is what says the wording may be upgraded again.
  assert.equal(
    existsSync('scripts/run-migration-verifications.mjs'),
    false,
    'the runner has landed — the "NOT ON THIS BRANCH" wording in migration.sql and verify.sql is now '
    + 'stale and must be re-tightened to say the checks are enforced',
  )

  for (const [name, text] of [['migration.sql', migration], ['verify.sql', verify]] as const) {
    assert.match(text, /NOT (EXIST IN THIS TREE|ON THIS BRANCH)/, `${name} must say the runner is absent`)
    assert.match(text, /MANUAL/, `${name} must say what the operator has to do instead`)
    assert.match(text, /o3d-batch-deployseq/, `${name} names the branch the runner arrives with`)
  }

  // The merge dependency, stated as a dependency rather than as background reading.
  assert.match(migration, /THE MERGE DEPENDENCY/, 'the dependency is named as one')
  assert.match(
    migration,
    /must not be applied by an automated\s*\n?--\s*deploy until o3d-batch-deployseq/,
    'and says what may not happen until it lands',
  )

  // And the actual order this branch's deploy.sh runs, said out loud, because it is the thing that
  // makes an unattended run the UNSAFE cutover rather than the safe one.
  assert.match(migration, /migrate -> build -> stop -> start/, 'the order in THIS tree is stated')
  assert.match(migration, /failure mode \(b\)/, 'and tied to the failure it produces')

  // The claims that were false are gone, not merely softened.
  assert.doesNotMatch(migration, /ENFORCED, not merely/, 'nothing enforces it here')
  assert.doesNotMatch(migration, /THE DEPLOY SCRIPT RUNS THEM/, 'no script in this tree runs them')

  // What survives: the checks are still declared, still counted, and still not copied back inline.
  assert.match(migration, /run-migration-verifications\.mjs/, 'the runner is still named, as the thing that is absent')
  assert.match(migration, /ALL THREE MUST RETURN 0/)
  assert.doesNotMatch(migration, /SELECT count\(\*\) FROM "shopping_sync_logs"/, 'no second copy of the checks')
})

test('this branch deploy.sh really does migrate before it stops the predecessor', () => {
  // The assertion behind the sentence above — read from the script rather than believed. If the
  // order is ever fixed here, the migration prose describing it becomes wrong and this fails.
  const deploy = readFileSync('scripts/deploy.sh', 'utf8')
  const migrateAt = deploy.indexOf('prisma migrate deploy')
  const stopAt = deploy.indexOf("NEXT_PIDS=$(pgrep -f 'next-server|next start'")
  assert.ok(migrateAt > 0 && stopAt > 0, 'both steps must be found, or this test asserts nothing')
  assert.ok(
    migrateAt < stopAt,
    'deploy.sh now stops the predecessor before migrating — migration.sql must stop saying it does not',
  )
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

test('deploy.sh is deliberately untouched by this branch', () => {
  // o3d-batch-deployseq is rewriting the same script; two branches editing it would conflict and one
  // would silently win. This branch contributes the declared checks and nothing else.
  const deploy = readFileSync('scripts/deploy.sh', 'utf8')
  assert.doesNotMatch(deploy, /run-migration-verifications/, 'the hook is the sibling branch\'s to add')
})
