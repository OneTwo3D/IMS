import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import test, { mock } from 'node:test'

import { ACCOUNTING_CONNECTOR_SELECTION_LOCK_KEY } from '@/lib/db/advisory-locks'
import {
  INTEGRATION_PLUGIN_KEYS_IN_LOCK_ORDER,
  INTEGRATION_PLUGIN_SETTING_KEYS,
} from '@/lib/integration-plugin-keys'
import { resolveActiveAccountingConnector } from '@/lib/integration-plugin-selection-lock'
import { SETTING_ENV_FALLBACKS } from '@/lib/settings-store'

// ---------------------------------------------------------------------------
// o3d-osl8 round 6, finding 1 — the exclusivity rule was validated BEFORE the lock was acquired.
//
// THE BUG. saveIntegrationPluginState accepts a PARTIAL payload, so it checked the rule against the
// RESULTING state: current state, overlaid with the keys being written. Correct in shape, and
// worthless in practice, because "current state" was read through the ordinary pooled client
// BEFORE the locked transaction opened. Two concurrent partial requests each observed both
// accounting connectors disabled, one enabled Xero and the other QuickBooks, their writes
// serialized behind the lock — and the committed result was BOTH ENABLED. Nothing revisits that
// state afterwards, and getActiveConnector resolves Xero-first, so the invalid state is silent:
// the operator sees the connector they did not choose, and the orphan-cancel sweep decides what to
// discard from it. WooCommerce/Shopify had the identical race.
//
// THE FIX. lockIntegrationPluginSelection: acquire the advisory lock, materialise the plugin rows,
// row-lock them FOR UPDATE, and read the state THROUGH the transaction client — then validate, then
// write, then commit. The state validated is the state written against.
//
// THE DOUBLE. `db` here is a real (in-memory) settings store with a real serialization discipline:
// $transaction runs callbacks one at a time, which is what pg_advisory_xact_lock does to writers
// that take it. That is deliberate — a double whose $transaction ran callbacks concurrently would
// let the fixed code produce the bug, and a double that ran them serially but let the read happen
// outside would let the broken code pass. Both halves have to be modelled or the test proves
// nothing.
// ---------------------------------------------------------------------------

type UpsertArgs = { where: { key: string }; create: { key: string; value: string }; update: { value: string } }

const store = new Map<string, string>()

const state = {
  /** Every settings key written, in commit order. */
  writes: [] as string[],
  /** Raw statements issued inside transactions, in order. */
  raw: [] as string[],
  /** Reads that went through the POOLED client rather than a transaction. Must stay at zero. */
  pooledReads: [] as string[][],
  /** How many transactions were open at once. The lock means: never more than one. */
  openTransactions: 0,
  maxConcurrentTransactions: 0,
}

function reset() {
  store.clear()
  state.writes = []
  state.raw = []
  state.pooledReads = []
  state.openTransactions = 0
  state.maxConcurrentTransactions = 0
}

const setting = {
  findMany: async ({ where }: { where?: { key?: { in?: string[] } } }) => {
    const keys = where?.key?.in ?? [...store.keys()]
    state.pooledReads.push(keys)
    return keys.filter((key) => store.has(key)).map((key) => ({ key, value: store.get(key)! }))
  },
  findUnique: async ({ where }: { where: { key: string } }) => {
    state.pooledReads.push([where.key])
    return store.has(where.key) ? { key: where.key, value: store.get(where.key)! } : null
  },
  upsert: async ({ where, create, update }: UpsertArgs) => {
    const value = store.has(where.key) ? update.value : create.value
    store.set(where.key, value)
    state.writes.push(`${where.key}=${value}`)
    return { key: where.key, value }
  },
}

/** The same models, reached through a transaction. Reads here are NOT counted as pooled. */
const txSetting = {
  ...setting,
  findMany: async ({ where }: { where?: { key?: { in?: string[] } } }) => {
    const keys = where?.key?.in ?? [...store.keys()]
    return keys.filter((key) => store.has(key)).map((key) => ({ key, value: store.get(key)! }))
  },
}

function renderSql(strings: TemplateStringsArray, values: unknown[]) {
  return strings.raw.map((s, i) => s + (i < values.length ? JSON.stringify(values[i]) : '')).join('')
}

const txClient = {
  setting: txSetting,
  $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = renderSql(strings, values)
    state.raw.push(sql)
    // Model the materialising INSERT: rows that do not exist appear at their default.
    if (/INSERT INTO settings/i.test(sql)) {
      for (const key of INTEGRATION_PLUGIN_KEYS_IN_LOCK_ORDER) if (!store.has(key)) store.set(key, 'false')
    }
    return 1
  },
  $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = renderSql(strings, values)
    state.raw.push(sql)
    return [...INTEGRATION_PLUGIN_KEYS_IN_LOCK_ORDER]
      .filter((key) => store.has(key))
      .map((key) => ({ key, value: store.get(key)! }))
  },
}

/**
 * Serialized, because that is what the advisory lock does. Every transaction queues behind the one
 * before it, and `maxConcurrentTransactions` records that the model actually held.
 */
let txChain: Promise<unknown> = Promise.resolve()
async function runTransaction(callback: (tx: typeof txClient) => Promise<unknown>) {
  const run = txChain.then(async () => {
    state.openTransactions += 1
    state.maxConcurrentTransactions = Math.max(state.maxConcurrentTransactions, state.openTransactions)
    try {
      return await callback(txClient)
    } finally {
      state.openTransactions -= 1
    }
  })
  txChain = run.then(() => undefined, () => undefined)
  return run
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting,
      $transaction: (arg: unknown) =>
        typeof arg === 'function'
          ? runTransaction(arg as (tx: typeof txClient) => Promise<unknown>)
          : Promise.all(arg as unknown[]),
    },
  },
})

mock.module('@/lib/auth/server', {
  namedExports: {
    requireAuth: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
    requirePermission: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
    requireAdmin: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
    requireFreshAdmin: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
    freshAuthFailureResult: () => null,
  },
})

mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })
mock.module('@/app/actions/cron', { namedExports: { syncCrontab: async () => ({ success: true }) } })

async function savePlugins(patch: Record<string, boolean>) {
  const { saveIntegrationPluginState } = await import('@/app/actions/settings')
  return saveIntegrationPluginState(patch)
}

async function saveOnboarding(full: {
  woocommerce: boolean; shopify: boolean; xero: boolean; quickbooks: boolean; mintsoft: boolean
}) {
  const { saveOnboardingPluginState } = await import('@/app/actions/onboarding')
  return saveOnboardingPluginState(full)
}

function enabled(id: keyof typeof INTEGRATION_PLUGIN_SETTING_KEYS) {
  return store.get(INTEGRATION_PLUGIN_SETTING_KEYS[id]) === 'true'
}

test.beforeEach(reset)

// ---------------------------------------------------------------------------
// Finding 1 — the race itself.
// ---------------------------------------------------------------------------

test('two concurrent PARTIAL enables cannot leave BOTH accounting connectors on', async () => {
  // Both start from "neither enabled" — the state each one used to read, unlocked, before deciding
  // its write was legal.
  const [xero, quickbooks] = await Promise.all([
    savePlugins({ xero: true }),
    savePlugins({ quickbooks: true }),
  ])

  const outcomes = [xero, quickbooks]
  assert.equal(outcomes.filter((r) => r.success).length, 1, 'exactly one of them succeeds')
  const refused = outcomes.find((r) => !r.success)!
  assert.match(refused.error ?? '', /either Xero or QuickBooks/, 'and the other is REFUSED, with the reason')

  assert.ok(
    !(enabled('xero') && enabled('quickbooks')),
    'the committed state is valid — this is the assertion that fails when the validation moves back '
      + 'outside the transaction, because both requests then read "neither enabled" and both write',
  )
  assert.equal(state.maxConcurrentTransactions, 1, 'the lock is being modelled: transactions ran one at a time')
})

test('the same race on the COMMERCE pair is closed too — it was never accounting-only', async () => {
  const results = await Promise.all([
    savePlugins({ woocommerce: true }),
    savePlugins({ shopify: true }),
  ])

  assert.equal(results.filter((r) => r.success).length, 1)
  assert.match(results.find((r) => !r.success)!.error ?? '', /either WooCommerce or Shopify/)
  assert.ok(!(enabled('woocommerce') && enabled('shopify')))
})

test('a partial write racing the ONBOARDING step cannot produce both either', async () => {
  // The onboarding step writes every exclusivity-bearing key at once, so its own payload is always
  // self-consistent. That is not enough: a partial write committing AFTER it can still add the
  // second connector. Both go through the same lock and the same resulting-state check.
  //
  // Whichever way this interleaves, the INVARIANT holds — which is the assertion, because whether
  // anything is refused depends on the order: onboarding-then-partial is a genuine conflict, and
  // partial-then-onboarding is not (onboarding writes xero=false itself). Asserting a refusal here
  // would be asserting a scheduling accident. The deterministic conflict is the test below.
  await Promise.all([
    saveOnboarding({ woocommerce: true, shopify: false, xero: false, quickbooks: true, mintsoft: false }),
    savePlugins({ xero: true }),
  ])

  assert.ok(!(enabled('xero') && enabled('quickbooks')), 'never both')
})

test('a partial enable is refused against the state the ONBOARDING step just committed', async () => {
  const onboarding = await saveOnboarding({
    woocommerce: true, shopify: false, xero: false, quickbooks: true, mintsoft: false,
  })
  assert.equal(onboarding.success, true)

  const partial = await savePlugins({ xero: true })

  assert.equal(partial.success, false, 'the second connector is refused')
  assert.match(partial.error ?? '', /either Xero or QuickBooks/)
  assert.ok(!enabled('xero'))
  assert.ok(enabled('quickbooks'), 'and the connector that was already on is untouched')
})

test('the validation reads through the TRANSACTION, not the pooled client', async () => {
  // The structural half of finding 1: a pooled read is unlocked by construction, so if one is used
  // to decide, the decision is unfenced however well the write is locked.
  await savePlugins({ xero: true })

  assert.deepEqual(state.pooledReads, [], 'nothing was read outside the transaction')
  assert.ok(
    state.raw.some((sql) => sql.includes(String(ACCOUNTING_CONNECTOR_SELECTION_LOCK_KEY))),
    'the connector-selection advisory lock was taken',
  )
  assert.ok(state.raw.some((sql) => /FOR UPDATE/i.test(sql)), 'and the plugin rows were row-locked')
  // Lock first, read second, write third. Any other order and the check is advisory.
  const lockAt = state.raw.findIndex((sql) => /pg_advisory_xact_lock/.test(sql))
  const readAt = state.raw.findIndex((sql) => /FOR UPDATE/i.test(sql))
  assert.ok(lockAt >= 0 && readAt > lockAt, 'the locked read follows the lock')
  assert.deepEqual(state.writes, ['plugin_xero_enabled=true'], 'and only the key that was asked for is written')
})

test('an unchanged-but-legal partial write still succeeds — the check must not refuse ordinary use', async () => {
  store.set(INTEGRATION_PLUGIN_SETTING_KEYS.xero, 'true')

  const result = await savePlugins({ woocommerce: true })

  assert.deepEqual(result, { success: true })
  assert.ok(enabled('xero') && enabled('woocommerce'))
})

test('a refused write commits NOTHING — not even the keys that were individually legal', async () => {
  store.set(INTEGRATION_PLUGIN_SETTING_KEYS.xero, 'true')

  const result = await savePlugins({ quickbooks: true, mintsoft: true })

  assert.equal(result.success, false)
  assert.ok(!enabled('quickbooks'))
  assert.ok(!enabled('mintsoft'), 'mintsoft was legal on its own and must not have slipped through a partial commit')
})

// ---------------------------------------------------------------------------
// The lock protocol itself.
// ---------------------------------------------------------------------------

test('the plugin rows are materialised before they are locked — FOR UPDATE cannot lock what does not exist', async () => {
  assert.equal(store.size, 0, 'starting from a database that has never had these rows')

  await savePlugins({ xero: true })

  for (const key of INTEGRATION_PLUGIN_KEYS_IN_LOCK_ORDER) {
    assert.ok(store.has(key), `${key} exists, so a bypassing writer cannot INSERT it mid-transaction`)
  }
  const insertAt = state.raw.findIndex((sql) => /INSERT INTO settings/i.test(sql))
  const lockAt = state.raw.findIndex((sql) => /FOR UPDATE/i.test(sql))
  assert.ok(insertAt >= 0 && lockAt > insertAt, 'materialise, then lock')
})

test('all SIX plugin keys are locked, in one canonical order', async () => {
  // Not just the accounting pair: exclusivity spans WooCommerce/Shopify as well, and one order for
  // one lock set is what stops two callers taking the same rows in opposite orders and deadlocking.
  assert.deepEqual(
    [...INTEGRATION_PLUGIN_KEYS_IN_LOCK_ORDER],
    [...Object.values(INTEGRATION_PLUGIN_SETTING_KEYS)].sort(),
    'every plugin key, sorted',
  )
  assert.equal(INTEGRATION_PLUGIN_KEYS_IN_LOCK_ORDER.length, 6)
})

test('the plugin keys have NO environment fallback — the locked row is the whole truth', async () => {
  // getSettingValue/getSettingValues answer from process.env for keys in SETTING_ENV_FALLBACKS,
  // ahead of the database. A plugin key gaining one would make getIntegrationPluginState (which
  // honours fallbacks) and the locked row read (which cannot) disagree about which connector is
  // active — and a row lock on a value nothing reads protects nothing.
  for (const key of INTEGRATION_PLUGIN_KEYS_IN_LOCK_ORDER) {
    assert.equal(
      SETTING_ENV_FALLBACKS[key],
      undefined,
      `${key} must not be env-overridable: the lock can only fence a database row`,
    )
  }
})

test('the Xero-first resolution rule is one rule', () => {
  assert.equal(resolveActiveAccountingConnector({ xero: true, quickbooks: true }), 'xero', 'xero wins, as getActiveConnector does')
  assert.equal(resolveActiveAccountingConnector({ xero: true, quickbooks: false }), 'xero')
  assert.equal(resolveActiveAccountingConnector({ xero: false, quickbooks: true }), 'quickbooks')
  assert.equal(resolveActiveAccountingConnector({ xero: false, quickbooks: false }), null)
})

// ---------------------------------------------------------------------------
// Finding 2 — the INVENTORY of plugin-key writers.
//
// The lock only binds writers that take it, and round 5 asserted that "both writers take it" by
// grepping two files for the constant's NAME. That was a spelling check over an inventory of two,
// and the inventory was wrong: the full-chain quiesce harness, two e2e fixture scripts, the e2e
// mintsoft route and the full database reset all write these rows and none of them took anything.
//
// So the inventory is DISCOVERED here rather than listed. Any file that writes settings and names a
// plugin key — or wipes the settings table wholesale — must route through the lock helper.
// ---------------------------------------------------------------------------

const REPO = process.cwd()
const SCANNED_ROOTS = ['app', 'lib', 'scripts', 'e2e']

/** Files that DEFINE the mechanism rather than use it. */
const MECHANISM_FILES = new Set([
  'lib/integration-plugin-keys.ts',
  'lib/integration-plugin-selection-lock.ts',
])

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      if (entry === 'node_modules' || entry === 'generated' || entry === '.next') continue
      sourceFiles(path, found)
      continue
    }
    if (path.endsWith('.ts') || path.endsWith('.tsx')) found.push(path)
  }
  return found
}

const NAMES_A_PLUGIN_KEY = /plugin_\w+_enabled|INTEGRATION_PLUGIN_SETTING_KEYS|INTEGRATION_PLUGIN_KEYS_IN_LOCK_ORDER/
const WRITES_SETTINGS = /setting\.upsert|setting\.update|setting\.create|setting\.delete|insert into settings|update settings set/i
/** An unconditional wipe writes every plugin key without naming one. */
const WIPES_SETTINGS = /setting\.deleteMany\(\{\s*\}\)/
const TAKES_THE_LOCK = /lockIntegrationPluginSelection|writeSettingsUnderPluginSelectionLock/

test('every plugin-key writer in the repo goes through the selection lock', () => {
  const offenders: string[] = []
  const covered: string[] = []

  for (const root of SCANNED_ROOTS) {
    for (const path of sourceFiles(join(REPO, root))) {
      const rel = relative(REPO, path)
      if (MECHANISM_FILES.has(rel)) continue
      const src = readFileSync(path, 'utf8')
      const writesPluginKeys = (NAMES_A_PLUGIN_KEY.test(src) && WRITES_SETTINGS.test(src)) || WIPES_SETTINGS.test(src)
      if (!writesPluginKeys) continue
      if (TAKES_THE_LOCK.test(src)) covered.push(rel)
      else offenders.push(rel)
    }
  }

  assert.deepEqual(
    offenders.sort(),
    [],
    'these write the plugin selection rows without taking the lock — route them through '
      + `lockIntegrationPluginSelection (or, for a raw pg client, the harness helper):\n${offenders.join('\n')}`,
  )

  // Pinned, so that a writer DISAPPEARING from the inventory is as visible as one appearing. The
  // scan is only reassuring if it is actually finding things.
  assert.deepEqual(covered.sort(), [
    'app/actions/onboarding.ts',
    'app/actions/reset.ts',
    'app/actions/settings.ts',
    'app/api/e2e/mintsoft/route.ts',
    'e2e/full-chain/harness/quiesce.ts',
    'scripts/commerce-accounting-e2e-fixture.ts',
    'scripts/landed-cost-e2e-fixture.ts',
  ])
})

test('the quiesce harness takes the SAME advisory key and the SAME row locks, in the same order', () => {
  // It writes plugin_xero_enabled on the STAGE database over a raw `pg` client, so it cannot use
  // the Prisma helper — it has to reproduce the protocol. Reproducing it in the WRONG ORDER (rows
  // before the advisory lock) is the one way these can deadlock against the app, so the order is
  // asserted, not just the presence.
  const src = readFileSync(join(REPO, 'e2e/full-chain/harness/quiesce.ts'), 'utf8')
  const helper = src.slice(src.indexOf('async function writeSettingsUnderPluginSelectionLock'))
  const body = helper.slice(0, helper.indexOf('\n}\n'))

  // Anchored on the QUERY text, not on a bare `for update` — the comment above the materialising
  // insert mentions `for update`, and matching that would compare a comment's position instead.
  const advisoryAt = body.indexOf("client.query('select pg_advisory_xact_lock")
  const materialiseAt = body.search(/insert into settings/i)
  const rowLockAt = body.search(/order by key for update/i)

  assert.ok(advisoryAt > 0, 'it takes the advisory lock')
  assert.ok(body.includes('ACCOUNTING_CONNECTOR_SELECTION_LOCK_KEY'), 'the shared constant, not a copied number')
  assert.ok(materialiseAt > advisoryAt, 'materialises after taking the advisory lock')
  assert.ok(rowLockAt > materialiseAt, 'and row-locks after materialising')
  assert.ok(body.includes('INTEGRATION_PLUGIN_KEYS_IN_LOCK_ORDER'), 'over the same key set, in the same order')
  assert.ok(body.includes("client.query('begin')"), 'and all of it in one transaction — an advisory XACT lock outside one is released immediately')
})

test('no path takes a settings row lock and THEN the selection advisory lock', () => {
  // The only ordering that can deadlock against this helper. Every caller goes through
  // lockIntegrationPluginSelection (or the harness twin), which takes them the other way round; this
  // asserts nobody has hand-rolled the inverse.
  const offenders: string[] = []
  for (const root of SCANNED_ROOTS) {
    for (const path of sourceFiles(join(REPO, root))) {
      const rel = relative(REPO, path)
      if (MECHANISM_FILES.has(rel)) continue
      const src = readFileSync(path, 'utf8')
      if (!/ACCOUNTING_CONNECTOR_SELECTION_LOCK_KEY/.test(src)) continue
      const lockAt = src.indexOf('ACCOUNTING_CONNECTOR_SELECTION_LOCK_KEY')
      const rowLockBefore = src.slice(0, lockAt).search(/settings[\s\S]{0,200}?FOR UPDATE/i)
      if (rowLockBefore >= 0) offenders.push(rel)
    }
  }
  assert.deepEqual(offenders, [], 'these lock settings rows before taking the advisory lock — an inverted order deadlocks')
})
