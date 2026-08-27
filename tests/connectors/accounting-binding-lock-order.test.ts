import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  ACCOUNTING_BINDING_ROW_ORDER,
  orderedAccountingBindingWrites,
  runOrderedAccountingBindingWrites,
} from '@/lib/connectors/accounting-binding-lock-order'

/**
 * o3d-2w2j — ONE ACQUISITION ORDER FOR THE ROWS OF A BINDING, ENFORCED BY A FUNCTION.
 *
 * `disconnect()` took the token row before the pin, which is the reverse of every writer that
 * establishes a binding: a disconnect and a concurrent consent each end up holding the row the other
 * needs next, and Postgres resolves that by killing one of them as a deadlock victim. Not a
 * correctness hole — the pin/receipt/witness logic is untouched by the order — but a LIVENESS hazard
 * on the auth path, which is the path an operator reaches for when they are already mid-incident.
 *
 * THE FIRST FIX REORDERED THE STATEMENTS AND WROTE THE RULE DOWN BESIDE THEM. This one makes the rule
 * uncallable-and-then-ignorable: the order lives in `ACCOUNTING_BINDING_ROW_ORDER`, and every writer
 * of more than one binding row hands its statements to `orderedAccountingBindingWrites` KEYED BY ROW.
 * A caller cannot express an order at all, so it cannot express the wrong one — which matters because
 * this rule has already been broken twice by writers who did not know it existed.
 */

test('o3d-2w2j: the canonical order is pin, then token row, then witness', () => {
  // STATED, not derived from a caller — so reversing the constant AND every caller together still
  // fails. The pin is first because `settings.key` is a PRIMARY KEY and the P2002 on it is the
  // ARBITER that decides which of two concurrent consents wins; it can only arbitrate if it happens
  // before either transaction has touched anything else.
  assert.deepEqual([...ACCOUNTING_BINDING_ROW_ORDER], ['pin', 'token', 'witness'])
})

test('o3d-2w2j: the order comes from the helper, not from how the caller spelt it', () => {
  // THE POINT OF THE HELPER. A future editor who moves these properties around — or who adds one in
  // the wrong place — cannot change the acquisition order, because the spelling is not what decides
  // it. This is the property a comment beside the statements could never have.
  const spelt = orderedAccountingBindingWrites({ witness: 'W', token: 'T', pin: 'P' })
  assert.deepEqual(spelt, ['P', 'T', 'W'])
  assert.deepEqual(orderedAccountingBindingWrites({ pin: 'P', token: 'T', witness: 'W' }), spelt,
    'both spellings produce the same sequence')
})

test('o3d-2w2j: a writer that touches only some of the rows gets back only those, still ordered', () => {
  // QuickBooks has no release witness, so it supplies two of the three. Omitting a row must not
  // insert a hole or reorder what is left.
  assert.deepEqual(orderedAccountingBindingWrites({ token: 'T', pin: 'P' }), ['P', 'T'])
  assert.deepEqual(orderedAccountingBindingWrites({ witness: 'W' }), ['W'])
  assert.deepEqual(orderedAccountingBindingWrites({}), [])
})

test('o3d-2w2j: the interactive runner awaits each step before starting the next', async () => {
  // SEQUENTIAL BY CONSTRUCTION. A `Promise.all` here would hand the acquisitions back to the
  // scheduler, which is the same defect with no order at all rather than the wrong one — so this
  // records ENTRY and EXIT and asserts they never interleave.
  const trace: string[] = []
  const step = (name: string) => async () => {
    trace.push(`${name}:start`)
    await new Promise((resolve) => setTimeout(resolve, name === 'pin' ? 5 : 0))
    trace.push(`${name}:end`)
  }

  await runOrderedAccountingBindingWrites({ witness: step('witness'), token: step('token'), pin: step('pin') })

  assert.deepEqual(trace, [
    'pin:start', 'pin:end', 'token:start', 'token:end', 'witness:start', 'witness:end',
  ])
})

test('o3d-2w2j: a step that throws stops the sequence, so nothing after it is acquired', async () => {
  // Load-bearing for `bindXeroTenant`: the pin step is the one that throws `XeroBindingRace`, and the
  // refusal it produces says "nothing was stored". That is only true if the token row was never
  // touched — which is what this asserts, at the runner rather than at the caller.
  const trace: string[] = []
  await assert.rejects(
    runOrderedAccountingBindingWrites({
      pin: async () => { trace.push('pin'); throw new Error('another callback won the race') },
      token: async () => { trace.push('token') },
      witness: async () => { trace.push('witness') },
    }),
    /won the race/,
  )
  assert.deepEqual(trace, ['pin'], 'the token row and the witness were never reached')
})

/* ------------------------------------------------------------------------------------------------
 * AND EVERY ACQUIRER GOES THROUGH IT — INCLUDING THE THIRD ONE.
 * ---------------------------------------------------------------------------------------------- */

test('o3d-2w2j: every writer of more than one binding row acquires them through the helper', () => {
  const xeroAuth = readFileSync('lib/connectors/xero/auth.ts', 'utf8')
  const qboAuth = readFileSync('lib/connectors/quickbooks/auth.ts', 'utf8')
  const guard = readFileSync('lib/connectors/xero/tenant-guard.ts', 'utf8')

  const body = (source: string, from: string, to: string) => {
    const start = source.indexOf(from)
    assert.ok(start > -1, `could not locate ${from}`)
    const end = source.indexOf(to, start)
    return source.slice(start, end === -1 ? undefined : end)
  }

  // 1. The binding transaction — interactive, so it uses the awaiting runner.
  const bind = body(xeroAuth, 'async function bindXeroTenant(', 'class XeroBindingRace')
  assert.match(bind, /await runOrderedAccountingBindingWrites\(\{/)
  for (const row of ACCOUNTING_BINDING_ROW_ORDER) {
    assert.match(bind, new RegExp(`${row}: async \\(\\) => \\{`), `the binding names its ${row} step`)
  }

  // 2. The Xero disconnect — the inversion this issue was filed for. Prisma promises are lazy, so the
  //    array `$transaction` receives is the helper's output whatever order the properties are in.
  const disconnect = body(xeroAuth, 'export async function disconnect(', 'clearXeroReferenceCache()')
  assert.match(disconnect, /\.\.\.orderedAccountingBindingWrites\(\{/)
  assert.match(disconnect, /pin: db\.setting\.deleteMany\(\{ where: \{ key: XERO_EXPECTED_TENANT_KEY \} \}\)/)
  assert.match(disconnect, /token: db\.accountingToken\.deleteMany\(\{ where: \{ connector: XERO_CONNECTOR \} \}\)/)
  assert.match(disconnect, /witness: db\.setting\.deleteMany\(\{ where: \{ key: XERO_PIN_RELEASE_WITNESS_KEY \} \}\)/)
  // MUTATION THAT KILLS THIS TEST: spelling the three back into the `$transaction` array by hand, in
  // any order. That is exactly the shape the first fix left behind, and the shape that was wrong
  // before it.
  assert.ok(!/\$transaction\(\[\s*\n\s*db\.(setting|accountingToken)\./.test(disconnect),
    'the binding rows must not be spelt straight into the transaction array')

  // 3. THE THIRD ACQUIRER, found by this branch: the QuickBooks disconnect had the SAME inversion —
  //    `accountingToken.deleteMany` and then the realm pin, in one transaction. It is a smaller
  //    hazard (the QuickBooks consent writes its two rows in separate auto-commit statements, so it
  //    never holds both at once) but it is the same rule, and "no writer contends today" is a fact
  //    about the current callback rather than a property of the rows.
  const qbo = body(qboAuth, 'export async function disconnect(', 'export async function refreshToken(')
  assert.match(qbo, /\.\.\.orderedAccountingBindingWrites\(\{/)
  const pinAt = qbo.indexOf('pin: db.setting.deleteMany({ where: { key: QBO_EXPECTED_REALM_KEY } })')
  const tokenAt = qbo.indexOf('token: db.accountingToken.deleteMany({ where: { connector: QBO_CONNECTOR } })')
  assert.ok(pinAt > -1 && tokenAt > -1, 'both QuickBooks binding rows are named')
  assert.ok(!/\$transaction\(\[\s*\n\s*db\.accountingToken\.deleteMany/.test(qbo),
    'and the token row is no longer taken first')

  // 4. The raw-SQL writer the provisioner and the recovery script share.
  assert.match(guard, /return orderedAccountingBindingWrites<XeroPinSqlStatement>\(\{/)
})

test('o3d-2w2j: the raw-SQL pin establishment really emits pin, token, witness', async () => {
  // Behavioural, not structural: the helper decides the order, so this proves the keys were attached
  // to the right statements. Reversing pin/token in the source object leaves this test red.
  const { xeroPinEstablishmentStatements } = await import('@/lib/connectors/xero/tenant-guard')
  const statements = xeroPinEstablishmentStatements('5c949ed5-demo-order')

  assert.equal(statements.length, 3)
  assert.match(statements[0].text, /insert into settings/, 'pin first — the trigger consumes the release from it')
  assert.match(statements[1].text, /update accounting_tokens/, 'then the token row')
  assert.match(statements[2].text, /delete from settings/, 'then the witness')
})

test('o3d-2w2j: the two writers that are DELIBERATELY not routed through it, and why', () => {
  // Said out loud so the next reader does not "fix" them into inconsistency.
  //
  // `resetDatabase` deletes whole TABLES, not the named rows of one binding, so there is nothing for
  // the helper to key on; it keeps its hand-written settings-before-tokens order and its own test.
  const reset = readFileSync('app/actions/reset.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const wipe = reset.slice(reset.indexOf('lockIntegrationPluginSelection(tx)'))
  assert.ok(wipe.indexOf('tx.setting.deleteMany') < wipe.indexOf('tx.accountingToken.deleteMany'),
    'it still deletes the settings (the pin among them) before the token row')

  // The provisioner's `clearTenantPin` acquires in the canonical order too, but its sequence is
  // forced by data dependence — the pin DELETE's `RETURNING` feeds the token UPDATE, whose own
  // `RETURNING` feeds the witness INSERT — so there is no order left for a helper to choose.
  const provision = readFileSync('scripts/provision-xero-demo.ts', 'utf8')
  const clear = provision.slice(provision.indexOf('async function clearTenantPin('))
  const del = clear.indexOf("delete from settings where key = 'xero_expected_tenant_id'")
  const upd = clear.indexOf('update accounting_tokens')
  assert.ok(del > -1 && upd > del, 'the pin is deleted before the token row is stamped')
})
