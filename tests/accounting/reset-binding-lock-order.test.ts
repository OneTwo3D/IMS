import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { mock } from 'node:test'

import {
  ACCOUNTING_BINDING_PIN_SETTING_KEYS,
  ACCOUNTING_BINDING_ROW_ORDER,
  ACCOUNTING_BINDING_SETTING_KEYS,
  ACCOUNTING_BINDING_WITNESS_SETTING_KEYS,
  type AccountingBindingRow,
} from '@/lib/connectors/accounting-binding-lock-order'

/**
 * o3d-2w2j r2 (Codex MEDIUM) — THE BULK RESET DOES DEADLOCK WITH A RE-CONSENT.
 *
 * The first round routed every writer of more than one binding row through one acquisition order and
 * EXCLUDED `resetDatabase`, on the stated ground that it "deletes whole TABLES, not the named rows of
 * one binding, so there is nothing for the helper to key on".
 *
 * THAT REASON IS WRONG. A whole-table DELETE is not an absence of row acquisitions; it is EVERY row
 * acquisition, taken in scan order — which is the one order nothing else can be aligned with.
 * `setting.deleteMany({})` therefore locks the Xero pin AND the `xero_pin_release_witness` row.
 *
 * THE CYCLE, CONCRETELY. In the legitimate released state the pin row is absent while the token's
 * release receipt and the witness both exist. A concurrent consent INSERTs the pin, which fires
 * `xero_pin_write_consumes_release` (prisma/migrations/20260819210000_xero_pin_write_consumes_release):
 * the trigger UPDATEs `accounting_tokens` — taking the token row — and then DELETEs the witness, which
 * the reset is already holding. The reset then reaches `accountingToken.deleteMany` and waits on that
 * token. Witness-then-token against token-then-witness; PostgreSQL settles it by killing one of the
 * two, on the incident-recovery path this whole branch exists to protect.
 *
 * WHAT THIS FILE PINS, and it is a property of the ACQUISITION SEQUENCE rather than of the source
 * text: the reset takes the three binding rows by name, in `ACCOUNTING_BINDING_ROW_ORDER`, before it
 * wipes anything else, and the bulk delete that follows EXCLUDES them. The trigger's own order is read
 * out of the shipped migration rather than restated here, so a change to the trigger that reintroduced
 * the inversion would turn this red without anybody remembering to update it.
 */

/* ------------------------------------------------------------------------------------------------
 * A CLIENT THAT RECORDS WHICH ROWS EACH STATEMENT WOULD LOCK, IN ORDER.
 *
 * The property under test is an ORDER OF ACQUISITIONS, so the double records the sequence and the
 * predicate of every delete rather than pretending to hold data. A double that only counted calls
 * would report the pre-fix order and the fixed one as identical.
 * ---------------------------------------------------------------------------------------------- */

type Acquisition = { model: string; keys: string[] | null; excluded: string[] | null }

const state = {
  acquisitions: [] as Acquisition[],
  /** True while the binding transaction's callback is running. */
  inTransaction: false,
  /** The acquisitions issued inside it. */
  transactional: [] as Acquisition[],
}

function reset() {
  state.acquisitions = []
  state.inTransaction = false
  state.transactional = []
}

function record(model: string, args?: { where?: unknown }) {
  const key = (args?.where as { key?: unknown } | undefined)?.key
  const inList = (key as { in?: unknown } | undefined)?.in
  const notInList = (key as { notIn?: unknown } | undefined)?.notIn
  const acquisition: Acquisition = {
    model,
    keys: Array.isArray(inList) ? (inList as string[]) : null,
    excluded: Array.isArray(notInList) ? (notInList as string[]) : null,
  }
  state.acquisitions.push(acquisition)
  if (state.inTransaction) state.transactional.push(acquisition)
}

const model = (name: string) => ({
  deleteMany: async (args?: { where?: unknown }) => { record(name, args); return { count: 0 } },
  updateMany: async () => ({ count: 0 }),
  count: async () => 0,
  findMany: async () => [],
  findUnique: async () => null,
  create: async () => ({}),
  upsert: async () => ({}),
})

const client: Record<string, unknown> = new Proxy({}, {
  get(_target, prop: string) {
    if (prop === '$transaction') {
      return async (fn: (tx: unknown) => Promise<unknown>) => {
        state.inTransaction = true
        try {
          return await fn(client)
        } finally {
          state.inTransaction = false
        }
      }
    }
    if (prop === 'then') return undefined
    return model(prop)
  },
})

mock.module('@/lib/db', { namedExports: { db: client } })
mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })
mock.module('@/lib/integration-plugin-selection-lock', {
  namedExports: { lockIntegrationPluginSelection: async () => {} },
})
mock.module('@/lib/auth/server', {
  namedExports: {
    requireFreshAdmin: async () => ({ user: { id: 'admin-1', email: 'admin@example.test' } }),
    freshAuthFailureResult: () => null,
  },
})
mock.module('@/lib/destructive-action-confirm', {
  namedExports: {
    consumeDestructiveActionCode: async () => true,
    issueDestructiveActionCode: async () => ({ success: true }),
  },
})
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })

async function runFullReset() {
  const { resetDatabase } = await import('@/app/actions/reset')
  return resetDatabase('full', 'code-123456')
}

/** Which binding row a recorded acquisition takes, if any. */
function bindingRowOf(acquisition: Acquisition): AccountingBindingRow | null {
  if (acquisition.model === 'accountingToken') return 'token'
  if (acquisition.model !== 'setting' || !acquisition.keys) return null
  if (acquisition.keys.some((key) => (ACCOUNTING_BINDING_PIN_SETTING_KEYS as readonly string[]).includes(key))) return 'pin'
  if (acquisition.keys.some((key) => (ACCOUNTING_BINDING_WITNESS_SETTING_KEYS as readonly string[]).includes(key))) return 'witness'
  return null
}

/* ------------------------------------------------------------------------------------------------
 * THE TRIGGER'S OWN ORDER, READ OUT OF THE SHIPPED MIGRATION.
 * ---------------------------------------------------------------------------------------------- */

/** The acquisitions `xero_pin_write_consumes_release` makes, in the order its body makes them. */
function triggerAcquisitionOrder(): AccountingBindingRow[] {
  const sql = readFileSync(
    'prisma/migrations/20260819210000_xero_pin_write_consumes_release/migration.sql', 'utf8',
  )
  const fn = sql.slice(
    sql.indexOf('CREATE OR REPLACE FUNCTION xero_pin_write_consumes_release()'),
    sql.indexOf('DROP TRIGGER IF EXISTS'),
  )
  const token = fn.indexOf('UPDATE "accounting_tokens"')
  const witness = fn.indexOf('DELETE FROM "settings" WHERE "key" = \'xero_pin_release_witness\'')
  assert.ok(token > -1 && witness > -1, 'the trigger body still takes the token row and the witness row')
  // The pin itself is the row the trigger fires ON, so it is already held when the body runs.
  return (['pin', ...(token < witness ? ['token', 'witness'] : ['witness', 'token'])]) as AccountingBindingRow[]
}

/* ------------------------------------------------------------------------------------------------
 * THE TESTS.
 * ---------------------------------------------------------------------------------------------- */

test('o3d-2w2j r2: the full reset takes the binding rows by name, in the canonical order', async () => {
  reset()

  const result = await runFullReset()
  assert.equal(result.success, true)

  const rows = state.transactional.map(bindingRowOf).filter((row): row is AccountingBindingRow => row !== null)

  // MUTATION THAT KILLS THIS TEST: restore the pre-fix body —
  //   await tx.setting.deleteMany({})
  //   await tx.accountingToken.deleteMany({})
  // The bare settings delete carries no `key.in`, so `bindingRowOf` classifies it as nothing at all
  // and this comes back as ['token'] — the binding rows are no longer taken BY NAME, which is the
  // whole change.
  assert.deepEqual(rows, [...ACCOUNTING_BINDING_ROW_ORDER],
    'pin, then token, then witness — the one order, taken explicitly')
})

test('o3d-2w2j r2: and the bulk settings delete that follows EXCLUDES them', async () => {
  reset()
  await runFullReset()

  const settingsDeletes = state.transactional.filter((a) => a.model === 'setting')
  const bulk = settingsDeletes.filter((a) => a.keys === null)
  assert.equal(bulk.length, 1, 'exactly one delete in this transaction is not addressed to named rows')

  // MUTATION THAT KILLS THIS TEST: drop the `notIn` and go back to `tx.setting.deleteMany({})`. The
  // exclusion is load-bearing rather than tidiness — without it the bulk delete may still block on a
  // binding row held by an uncommitted consent while this transaction already holds the token, which
  // is the same cycle one statement later.
  assert.deepEqual([...(bulk[0].excluded ?? [])].sort(), [...ACCOUNTING_BINDING_SETTING_KEYS].sort(),
    'every binding row in `settings` is excluded from the wholesale wipe')

  // ...and it runs after all three named acquisitions, so nothing it locks can precede the token.
  const lastNamed = state.transactional.reduce(
    (at, acquisition, index) => (bindingRowOf(acquisition) !== null ? index : at), -1,
  )
  assert.ok(state.transactional.indexOf(bulk[0]) > lastNamed,
    'the wholesale wipe is last')
})

test('o3d-2w2j r2: the reset can no longer form a cycle with the release-consuming trigger', async () => {
  reset()
  await runFullReset()

  const resetOrder = state.transactional
    .map(bindingRowOf)
    .filter((row): row is AccountingBindingRow => row !== null)
  const triggerOrder = triggerAcquisitionOrder()

  // A DEADLOCK IS AN INVERTED PAIR, so this looks for one rather than for a particular sequence.
  // Every pair of binding rows both parties acquire must be acquired in the same relative order.
  const inversions: string[] = []
  for (const a of ACCOUNTING_BINDING_ROW_ORDER) {
    for (const b of ACCOUNTING_BINDING_ROW_ORDER) {
      if (a === b) continue
      const resetHasPair = resetOrder.includes(a) && resetOrder.includes(b)
      const triggerHasPair = triggerOrder.includes(a) && triggerOrder.includes(b)
      if (!resetHasPair || !triggerHasPair) continue
      if (resetOrder.indexOf(a) < resetOrder.indexOf(b) && triggerOrder.indexOf(a) > triggerOrder.indexOf(b)) {
        inversions.push(`${a} before ${b} in the reset, after it in the trigger`)
      }
    }
  }

  // MUTATION THAT KILLS THIS TEST: the pre-fix body. `tx.setting.deleteMany({})` locks the witness
  // (and the pin) in scan order before `tx.accountingToken.deleteMany({})` takes the token — while
  // the trigger takes the token and THEN the witness. That is the reported cycle, and with the bare
  // delete classified as unnamed this test instead reports that the reset acquires only the token,
  // i.e. that it no longer takes the binding rows by name at all. Either way it is not green.
  assert.deepEqual(inversions, [], 'no pair of binding rows is acquired in opposite orders')
  assert.deepEqual(resetOrder, [...ACCOUNTING_BINDING_ROW_ORDER],
    'and the reset really did take all three, so the check above was not vacuous')
  assert.ok(triggerOrder.length >= 2, 'and so did the trigger')
})

test('o3d-2w2j r2: the key lists are the ones the writers actually use', async () => {
  // The lock-order module spells the keys as literals, because the modules that define them import
  // IT — a re-export would be a cycle. So the duplication is CHECKED here rather than trusted.
  const { XERO_TENANT_PIN_SETTING_KEY, XERO_PIN_RELEASE_WITNESS_SETTING_KEY } =
    await import('@/lib/connectors/xero/tenant-guard')
  const { QBO_EXPECTED_REALM_KEY } = await import('@/lib/connectors/quickbooks/auth')

  assert.deepEqual([...ACCOUNTING_BINDING_PIN_SETTING_KEYS],
    [XERO_TENANT_PIN_SETTING_KEY, QBO_EXPECTED_REALM_KEY])
  assert.deepEqual([...ACCOUNTING_BINDING_WITNESS_SETTING_KEYS], [XERO_PIN_RELEASE_WITNESS_SETTING_KEY])
  assert.deepEqual([...ACCOUNTING_BINDING_SETTING_KEYS],
    [XERO_TENANT_PIN_SETTING_KEY, QBO_EXPECTED_REALM_KEY, XERO_PIN_RELEASE_WITNESS_SETTING_KEY])
})
