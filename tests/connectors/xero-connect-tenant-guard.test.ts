import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { beforeEach, mock } from 'node:test'

/**
 * o3d-9tbz, end to end through the real OAuth callback path: exchangeCodeForTokens() and
 * getAccessToken() with Xero, the database and the settings store doubled.
 *
 * The doubles are deliberately stateful rather than canned, because the states this bug lives between
 * are database states: NO token row and NO pin (a fresh e2e rig, the state the o3d-t74p incident
 * happened in), a token row without a pin, and a pinned instance. A double that could only answer one
 * fixed shape could not express the difference — which is the failure mode that let the original
 * `connections[0]` line stand.
 *
 * THE DATABASE DOUBLE HAS A PRIMARY KEY AND TRANSACTIONS (o3d-9tbz r3), for the same reason. The race
 * being fixed is two OAuth callbacks that both read "no pin" and both write; the fix is that
 * `settings.key` is a PRIMARY KEY, so only one INSERT survives. A double whose `setting.upsert` always
 * succeeds cannot tell the fix from the bug — both pass — so this one models what actually decides it:
 *
 *   - `setting.create` raises P2002 when the key already exists, INCLUDING when it was committed by
 *     another transaction after this one started reading. That is the unique index, and it is the only
 *     thing standing between the two callbacks.
 *   - `$transaction(fn)` stages every write and applies it only if the callback returns. A rollback
 *     therefore leaves nothing behind, which is what lets "nothing was stored" be asserted rather than
 *     assumed. The array form is still supported, because `disconnect()` uses it.
 *   - reads inside a transaction see committed data (READ COMMITTED, as Postgres runs by default), so a
 *     callback that starts after the other has committed sees the pin rather than a stale snapshot.
 *
 * `gateSettingReads` is what lets a test put two callbacks in flight AT THE SAME TIME rather than one
 * after the other: it holds every in-transaction pin read until N of them have arrived, so both
 * callbacks have provably read "no pin" before either writes. Without it the second callback simply
 * runs after the first has committed, which is a different (and much easier) case.
 *
 * THE TOKEN ROW HAS A LOCK AND A WRITE-TIME PREDICATE (o3d-9tbz r4), for exactly the same reason the
 * settings key has a primary key. The race being fixed there is a REFRESH in flight across a rebinding:
 * it read the token row minutes ago, went to Xero, and comes back to write. What decides it is that the
 * organisation is in the WHERE clause of the UPDATE, so:
 *
 *   - `accountingToken.updateMany` matches the row AS IT IS AT THE WRITE, not as the caller last saw it,
 *     and answers `{ count: 0 }` when it no longer matches. Every field in the `where` is compared, so
 *     the same double covers the encryption migration's compare-and-swap on the ciphertext it read.
 *   - a write from OUTSIDE a transaction — `updateMany` or `upsert` alike — WAITS while an uncommitted
 *     transaction holds the token row, and then re-evaluates its predicate against what that transaction
 *     committed. This is what tells the fix from the bug: without the wait, the reverted upsert simply
 *     lands first and the binding overwrites it, so the test passes against the bug too. The lock belongs
 *     to the ROW, not to the API used to write it, which is why the doubled `upsert` waits as well.
 *   - `gateRefreshGrant` / `gateBindingTokenWrite` are what put those two in flight at once: the first
 *     holds the refresh at its call to Xero, the second holds a binding transaction with the token row
 *     staged and UNCOMMITTED.
 *
 * THE ROW HAS AN IDENTITY AND A GENERATION (o3d-9tbz r5), because a tenant is not a connection. Two
 * states this double could not previously express are now the ones under test:
 *
 *   - TWO GENERATIONS OF ONE ORGANISATION. `accountingToken.deleteMany` really deletes and the following
 *     `upsert` really INSERTS, with a NEW primary key — so disconnect-then-reconnect to the same
 *     organisation produces a different row, as it does in Postgres. A double that recycled `row-1`
 *     forever made the two generations indistinguishable and passed against the bug. The `upsert` also
 *     keeps the existing id on the UPDATE path, which is what makes the in-place re-consent case (same
 *     row, new generation) a genuinely different test rather than the same one twice.
 *   - AN INSTANCE THAT STARTS SPLIT. `mismatched()` builds a database whose pin and token name different
 *     organisations without any callback ever having run — the deployed state rounds 3 and 4 do nothing
 *     about, and the one a restored dump arrives in.
 *
 * THE TWO TABLES MOVE INDEPENDENTLY (o3d-9tbz r6), which is what an absent pin is about. `settings` and
 * the token row are separate state here and can be manipulated separately, so the double can express
 * the three states an absent pin comes in and which r5 could not tell apart: `pinDeleted()` (the
 * bypass — a bound row whose settings entry was removed), `releasedPin()` (the documented recovery,
 * which stamps the token row in the same breath), and `unpinnedLegacyRow()` (a connection older than
 * any of it). A double that only ever deleted the pin would pass against the bug, because under r5 all
 * three are the same state.
 *
 * AND THE TOKEN ROW CAN ARRIVE FROM SOMEWHERE ELSE (o3d-9tbz r8), which the same independence expresses
 * without any new machinery. `restoredMidReleaseTokenRow()` puts a whole released row — receipt,
 * qualifiers, generation and tenant, all internally consistent because they came from one dump — onto an
 * instance that never performed that release, which is the case the r7 checks cannot see: every value
 * they compare travelled together. `legacyUnqualifiedRelease()` is the other one, a receipt written by
 * a version of IMS that recorded only a timestamp — the shape the r7 migration was asked to backfill,
 * and the shape the OLD `--clear-tenant-pin` also left behind when it deleted no pin at all.
 *
 * `fetchedUrls` records every call that reached Xero, so "no Xero request was made" can be asserted
 * rather than assumed — the refusal claims it, and an expired token makes the claim load-bearing.
 */

type TokenRow = {
  id: string
  connector: string
  accessToken: string
  refreshToken: string | null
  expiresAt: Date
  tenantId: string
  tenantName: string | null
  grantedScopes: string | null
  tenantIsDemo: boolean | null
  connectionGeneration: string | null
  pinReleasedAt: Date | null
  pinReleasedGeneration: string | null
  pinReleasedTenantId: string | null
}

const LIVE = { id: 'c-live', tenantId: 'e7fb4378-live-org', tenantName: 'OneTwo3D Ltd', tenantType: 'ORGANISATION' }
const DEMO = { id: 'c-demo', tenantId: '5c949ed5-demo-org', tenantName: 'Demo Company (UK)', tenantType: 'ORGANISATION' }

let tokenRow: TokenRow | null = null
let settings: Record<string, string | null> = {}
let connectionsBody: unknown = []
/**
 * Per-consent organisation lists and access tokens, keyed by the OAuth `code`.
 *
 * Two callbacks in flight at once are two DIFFERENT consents, each with its own code, its own token and
 * its own organisation list. A single shared `connectionsBody` cannot express that — whichever callback
 * reaches the fetch last decides what BOTH of them saw — and a race test built on it is testing one
 * consent twice. The double therefore threads the code through: the token endpoint mints an access
 * token for it, and /connections answers according to the bearer it is presented with.
 */
let connectionsByCode: Record<string, unknown> = {}
let accessTokenByCode: Record<string, string> = {}
let organisationBody: unknown = { Organisations: [{ BaseCurrency: 'GBP' }] }
let organisationCalls = 0
let notifications: Array<{ title: string; message: string }> = []
let activity: Array<{ action: string; description: string }> = []
/** Every URL that reached Xero, so a refusal that claims it made no request can be held to it. */
let fetchedUrls: string[] = []
/** Cached-lookup ids `disconnect()` clears, so the remedy can be exercised rather than simulated. */
let clearedIdColumns: string[] = []

/**
 * Primary keys, minted as Postgres mints them: never reused, and a row that is deleted and re-inserted
 * comes back with a different one. This is what makes two generations of a connection to ONE
 * organisation distinguishable at all.
 */
let rowSequence = 0
function newRowId(): string {
  rowSequence += 1
  return `row-${rowSequence}`
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
}

/**
 * A barrier that holds the first N in-transaction pin reads until all N have arrived.
 *
 * This is the whole point of the race tests: it is what makes both callbacks read "no pin" BEFORE either
 * of them writes one. Left unset it does nothing, so every other test in this file is untouched.
 */
let settingReadGate: ((key: string) => Promise<void>) | null = null
let organisationFetchGate: (() => Promise<void>) | null = null
/** Holds a REFRESH grant at the identity endpoint — the long round trip the stale write comes back from. */
let refreshGrantGate: (() => Promise<void>) | null = null
/** Holds a binding transaction with the token row written but NOT committed, i.e. holding its row lock. */
let bindingTokenWriteGate: (() => Promise<void>) | null = null

/**
 * A one-shot gate a test drives by hand: `reached` resolves when the code under test arrives at it, and
 * nothing continues past it until `release()` is called. Two of these are what interleave a refresh and
 * a rebinding deterministically instead of hoping the timings fall the right way.
 */
function latch(): { reached: Promise<void>; release: () => void; wait: () => Promise<void> } {
  let arrive: () => void = () => {}
  const reached = new Promise<void>((resolve) => { arrive = resolve })
  let open: () => void = () => {}
  const opened = new Promise<void>((resolve) => { open = resolve })
  return {
    reached,
    release: open,
    wait: async () => { arrive(); await opened },
  }
}

/** Let every pending continuation run, so "still blocked" means blocked rather than merely not yet run. */
async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 25; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

/** Hold every arrival until `count` of them have arrived, then let them all go. */
function barrier(count: number): () => Promise<void> {
  let release: () => void = () => {}
  const released = new Promise<void>((resolve) => { release = resolve })
  let seen = 0
  return async () => {
    seen += 1
    if (seen >= count) { release(); return }
    await released
  }
}

/**
 * Hold the in-transaction PIN READ, so both callbacks provably read "no pin" before either writes one.
 *
 * This is the interleaving Postgres resolves with the primary key: two INSERTs of the same key, the
 * second blocked until the first commits and then rejected.
 */
function gateSettingReads(count: number): void {
  const wait = barrier(count)
  settingReadGate = async (key: string) => {
    if (key !== 'xero_expected_tenant_id') return
    await wait()
  }
}

/**
 * Hold the GET /Organisation call, so both callbacks have chosen their organisation — against a pin
 * they both read as absent — before either reaches the write. The second one's transaction then finds
 * the first's committed pin, which is the same race arriving by the other route.
 */
function gateOrganisationFetch(count: number): void {
  const wait = barrier(count)
  organisationFetchGate = async () => { await wait() }
}

function uniqueViolation(key: string) {
  return Object.assign(new Error(`Unique constraint failed on the fields: (\`key\`)`), {
    code: 'P2002',
    meta: { target: ['key'], modelName: 'Setting' },
  })
}

type SettingRow = { key: string; value: string }

/**
 * In-flight INSERTs of a settings key, and how they ended.
 *
 * A unique index does not merely reject a key that is already COMMITTED — a second INSERT of a key an
 * uncommitted transaction is holding BLOCKS until that transaction ends, and is then rejected if it
 * committed. Without this the double lets both racing callbacks insert, both commit, and the test
 * passes against the bug as happily as against the fix.
 */
const pendingSettingInserts = new Map<string, Promise<boolean>>()

/**
 * Holds the FULL RESET between its two binding deletes — the window an OAuth callback commits into.
 *
 * Hooked on the token delete, which both versions of the code perform: a gate that only exists in the
 * fixed version cannot show what the bug did. In the fixed version it fires INSIDE the reset's
 * transaction, after the settings wipe; in the reverted one it fires six statements earlier and outside
 * any transaction, which is the whole difference the test is measuring.
 */
let resetTokenDeleteGate: (() => Promise<void>) | null = null
/** Makes the full reset's settings wipe fail, so a reset that dies part-way is a testable state. */
let settingsWipeFails = false

/**
 * The token row's WRITE LOCK, held by an uncommitted transaction (o3d-9tbz r4).
 *
 * Resolves when that transaction commits or rolls back. Any writer outside it waits here first — which
 * is what a real UPDATE does, and the only reason a test can tell "the refresh was rejected because the
 * rebinding won" from "the refresh happened to run first and was overwritten".
 */
let pendingTokenWrite: Promise<boolean> | null = null

async function awaitTokenRowLock(): Promise<void> {
  const held = pendingTokenWrite
  if (held) await held
}

/**
 * Every field in the `where` compared against the row AS IT IS NOW — the write-time predicate.
 *
 * Timestamps are compared BY VALUE, as Postgres compares them, not by object identity. `pinReleasedAt`
 * is in the predicate as of r6, and a double that compared Dates with === would pass a refresh that a
 * real database rejects (and, worse, fail one it accepts) purely on which Date instance was handed
 * around.
 */
function tokenRowMatches(where: Record<string, unknown>): boolean {
  if (!tokenRow) return false
  const row = tokenRow as unknown as Record<string, unknown>
  return Object.entries(where).every(([field, value]) => {
    const actual = row[field]
    if (actual instanceof Date || value instanceof Date) {
      return actual instanceof Date && value instanceof Date && actual.getTime() === value.getTime()
    }
    return actual === value
  })
}

/**
 * One interactive transaction: staged writes, committed together, discarded on throw.
 *
 * It now stages DELETIONS as well as writes (o3d-9tbz r7), because the second writer of a binding is
 * `resetDatabase`, which removes both halves rather than replacing them. A double that could only stage
 * writes had to let the reset delete straight through, which is exactly the non-atomic behaviour under
 * test — the test would then be asserting the bug.
 */
async function runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
  const staged: Record<string, string> = {}
  const stagedDeletes = new Set<string>()
  let stagedToken: TokenRow | null | undefined
  /** The primary key a staged DELETE saw, so the commit removes that row and not a later one. */
  let stagedTokenDeleteId: string | null | undefined
  let settle: (committed: boolean) => void = () => {}
  const settled = new Promise<boolean>((resolve) => { settle = resolve })
  const claimed: string[] = []
  const visibleSetting = (key: string): string | undefined =>
    staged[key] ?? (stagedDeletes.has(key) ? undefined : settings[key])
  const tx = {
    // The raw SQL the plugin-selection lock issues on its way past: an advisory lock, a materialising
    // INSERT and a `FOR UPDATE` read of the plugin_* keys. Inert here — that lock has its own tests
    // (tests/accounting/plugin-selection-lock), and what this file is measuring is the ORDER of the two
    // binding deletes, which no lock takes part in.
    $executeRaw: async () => 0,
    $queryRaw: async () => [],
    setting: {
      findUnique: async ({ where }: { where: { key: string } }): Promise<SettingRow | null> => {
        if (settingReadGate) await settingReadGate(where.key)
        // READ COMMITTED: a row another transaction has already committed IS visible here.
        const value = visibleSetting(where.key)
        return value == null ? null : { key: where.key, value }
      },
      create: async ({ data }: { data: SettingRow }) => {
        // The primary key. This is the statement the whole fix rests on: the loser of the race is
        // rejected here, by the database, not by anything the process checked earlier.
        if (visibleSetting(data.key) != null) throw uniqueViolation(data.key)
        const inFlight = pendingSettingInserts.get(data.key)
        if (inFlight && (await inFlight)) throw uniqueViolation(data.key)
        if (settings[data.key] != null) throw uniqueViolation(data.key)
        staged[data.key] = data.value
        claimed.push(data.key)
        pendingSettingInserts.set(data.key, settled)
        return data
      },
      update: async ({ where, data }: { where: { key: string }; data: { value: string } }) => {
        staged[where.key] = data.value
        return { key: where.key, value: data.value }
      },
      // The whole settings table, as the full reset deletes it.
      //
      // STAGED, so nothing outside this transaction sees the rows go until it commits — and scoped to
      // the keys this STATEMENT can see, which is the part that decides the reset race. `DELETE FROM
      // settings` removes the rows visible to its own snapshot; a row another transaction commits
      // afterwards is not retroactively deleted by it. A double that applied the wipe at COMMIT time
      // would swallow a pin written in between, i.e. it would produce the bug's outcome no matter which
      // order the production code deletes in, and the test would be measuring the double.
      deleteMany: async (args?: { where?: { key?: unknown } }) => {
        if (args?.where?.key == null && settingsWipeFails) {
          // A reset that dies part-way is a state, not a story: with both deletes in one transaction
          // it must leave the binding WHOLE, and with them apart it leaves half of it behind.
          throw new Error('settings wipe failed (injected)')
        }
        if (args?.where?.key != null) {
          const keys = typeof args.where.key === 'string'
            ? [args.where.key]
            : ((args.where.key as { in?: string[] }).in ?? [])
          let count = 0
          for (const key of keys) {
            if (visibleSetting(key) == null) continue
            delete staged[key]
            stagedDeletes.add(key)
            count += 1
          }
          return { count }
        }
        let count = 0
        for (const key of new Set([...Object.keys(settings), ...Object.keys(staged)])) {
          if (visibleSetting(key) == null) continue
          delete staged[key]
          stagedDeletes.add(key)
          count += 1
        }
        return { count }
      },
    },
    accountingToken: {
      // The row lock, taken by a delete exactly as it is by a write: from here until this transaction
      // ends, every writer outside it waits.
      //
      // And it deletes THE ROW THIS STATEMENT SAW, identified by its primary key — not "whatever is
      // there at commit". A binding committed by a concurrent callback after this point inserts a row
      // with a new id (r5 models that faithfully), and Postgres would not delete it; a double that
      // cleared the table at commit would, and would then report the reset race as broken whichever
      // order the production code used.
      deleteMany: async () => {
        pendingTokenWrite = settled
        const seen = stagedToken === undefined ? tokenRow : stagedToken
        stagedTokenDeleteId = seen ? seen.id : null
        stagedToken = null
        if (resetTokenDeleteGate) await resetTokenDeleteGate()
        return { count: seen ? 1 : 0 }
      },
      upsert: async (
        { create, update }: { create: Omit<TokenRow, 'id'>; update: Partial<TokenRow> },
      ) => {
        // Taking the row lock: from here until this transaction ends, every writer outside it waits.
        pendingTokenWrite = settled
        // INSERT mints a new primary key; UPDATE keeps the one the row already has. The two branches
        // are the two ways a rebinding happens, and they are only different states if the double says
        // so — which is why the row's own generation, not its id, is what has to decide the refresh.
        stagedToken = tokenRow ? { ...tokenRow, ...update } as TokenRow : { id: newRowId(), ...create }
        if (bindingTokenWriteGate) await bindingTokenWriteGate()
        return stagedToken
      },
    },
  }
  try {
    const result = await fn(tx)
    for (const key of stagedDeletes) delete settings[key]
    for (const [key, value] of Object.entries(staged)) settings[key] = value
    if (stagedTokenDeleteId !== undefined) {
      if (tokenRow && tokenRow.id === stagedTokenDeleteId) tokenRow = null
    } else if (stagedToken !== undefined) {
      tokenRow = stagedToken
    }
    settle(true)
    return result
  } catch (error) {
    settle(false)
    throw error
  } finally {
    for (const key of claimed) {
      if (pendingSettingInserts.get(key) === settled) pendingSettingInserts.delete(key)
    }
    if (pendingTokenWrite === settled) pendingTokenWrite = null
  }
}

/**
 * EVERY MODEL THE FULL RESET SWEEPS, and the four this file actually models (o3d-9tbz r7).
 *
 * `resetDatabase('full')` deletes from about fifty tables, and the interesting thing it does is delete
 * TWO of them — the token row and the settings table — as the two halves of one binding. Modelling the
 * other forty-eight would be noise, but stubbing the db per-test would lose the only property under
 * test: that the OAuth callback and the reset are writing to the SAME database and can be interleaved.
 * So the models this file cares about are real, and everything else answers "deleted nothing".
 */
const inertModel = {
  deleteMany: async () => ({ count: 0 }),
  updateMany: async () => ({ count: 0 }),
  // The transaction scope counts what its activity-log delete deliberately kept — the records of Xero
  // documents IMS could never record (Codex r3, medium). This file models none, so: nothing kept.
  count: async () => 0,
}

const dbDouble: Record<string, unknown> = {
    accountingToken: {
      findUnique: async () => tokenRow,
      // The compare-and-swap the refresh now writes through. The predicate is evaluated HERE, after
      // the lock is released, against whatever the winner committed — never against the caller's
      // snapshot. No create branch, because there is none in the statement it doubles.
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<TokenRow> }) => {
        await awaitTokenRowLock()
        if (!tokenRowMatches(where)) return { count: 0 }
        tokenRow = { ...(tokenRow as TokenRow), ...data }
        return { count: 1 }
      },
      upsert: async (
        { create, update }: { create: Omit<TokenRow, 'id'>; update: Partial<TokenRow> },
      ) => {
        await awaitTokenRowLock()
        tokenRow = tokenRow ? { ...tokenRow, ...update } as TokenRow : { id: newRowId(), ...create }
        return tokenRow
      },
      // It really deletes. `disconnect()` is the remedy the split-binding refusal tells operators to
      // perform, and a no-op double would let that refusal recommend something unproven.
      //
      // The reset gate is honoured HERE as well as inside a transaction, deliberately: the version of
      // `resetDatabase` this round replaces deleted the token row from outside any transaction, and a
      // gate that only existed on the transactional path would let the reverted code sail past the
      // interleaving instead of demonstrating it.
      deleteMany: async () => {
        const had = tokenRow ? 1 : 0
        tokenRow = null
        // AFTER the delete, because outside a transaction the delete is COMMITTED the moment it runs —
        // and it is that committed gap, with the settings wipe still to come, that the callback used to
        // land in. Pausing before the statement would model a different (and harmless) interleaving.
        if (resetTokenDeleteGate) await resetTokenDeleteGate()
        return { count: had }
      },
    },
    // The cached lookup ids disconnect() clears alongside the token. Recorded rather than modelled:
    // what matters here is that the remedy runs to completion, which it cannot do without them.
    // They spread `inertModel` because the full reset DELETES from these same tables: a model that
    // answered only the call this file was written for would make the reset throw rather than run.
    customer: { ...inertModel, updateMany: async () => { clearedIdColumns.push('customer'); return { count: 0 } } },
    supplier: { ...inertModel, updateMany: async () => { clearedIdColumns.push('supplier'); return { count: 0 } } },
    product: { ...inertModel, updateMany: async () => { clearedIdColumns.push('product'); return { count: 0 } } },
    setting: {
      findUnique: async ({ where }: { where: { key: string } }): Promise<SettingRow | null> => {
        const value = settings[where.key]
        return value == null ? null : { key: where.key, value }
      },
      upsert: async ({ where, create }: { where: { key: string }; create: { value: string } }) => {
        settings[where.key] = create.value
        return { key: where.key, value: create.value }
      },
      // It really deletes, for the same reason accountingToken.deleteMany does: disconnect() clearing
      // BOTH halves of the binding is the whole content of the remedy the split-binding refusal gives.
      deleteMany: async (args?: { where?: { key?: unknown } }) => {
        const key = args?.where?.key
        const keys = key == null
          ? Object.keys(settings)
          : typeof key === 'string' ? [key] : ((key as { in?: string[] }).in ?? [])
        let count = 0
        for (const k of keys) {
          if (settings[k] == null) continue
          delete settings[k]
          count += 1
        }
        return { count }
      },
    },
  // Both forms: disconnect() passes an array, the tenant binding passes a callback.
  $transaction: async (arg: unknown) =>
    typeof arg === 'function'
      ? runTransaction(arg as (tx: unknown) => Promise<unknown>)
      : Promise.all(arg as Array<Promise<unknown>>),
}

mock.module('@/lib/db', {
  namedExports: {
    db: new Proxy(dbDouble, {
      get: (target, prop) => {
        if (prop in target) return target[prop as string]
        // A `$`-prefixed member this double does not implement is a REAL gap — returning an inert model
        // for it would turn "the code called something we never modelled" into a silent no-op.
        if (typeof prop !== 'string' || prop.startsWith('$') || prop === 'then') return undefined
        return inertModel
      },
    }),
  },
})
mock.module('@/lib/settings-store', {
  namedExports: {
    getSettingValue: async (key: string) => settings[key] ?? null,
    serializeSettingValue: (_key: string, value: string) => value,
    deserializeSettingValue: (_key: string, value: string) => value,
  },
})
mock.module('@/lib/secrets', {
  namedExports: {
    decryptSecret: (v: string) => v,
    encryptSecret: (v: string) => v,
    hasEncryptionKey: () => false,
    isEncryptedValue: () => true,
  },
})
mock.module('@/lib/base-currency', {
  namedExports: { getBaseCurrencyCode: async () => 'GBP' },
})
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (params: { action: string; description: string }) => {
      activity.push({ action: params.action, description: params.description })
    },
  },
})
mock.module('@/lib/notifications', {
  namedExports: {
    notify: async (params: { title: string; message: string }) => {
      notifications.push({ title: params.title, message: params.message })
    },
  },
})
mock.module('@/lib/auth/token-store', {
  namedExports: { setAuthToken: async () => {}, consumeAuthToken: async () => null },
})
// `resetDatabase` is the OTHER writer of both halves of a binding, and it is exercised here rather than
// against a database of its own precisely so that it and the OAuth callback write to the SAME one.
// These are its scaffolding — an authenticated admin, a consumed confirmation code, a revalidate and
// the plugin-selection lock (which has its own tests) — none of which is what the reset tests are about.
mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })
mock.module('@/lib/auth/server', {
  namedExports: {
    requireFreshAdmin: async () => ({ user: { id: 'admin-1', email: 'admin@example.com' } }),
    freshAuthFailureResult: () => null,
  },
})
mock.module('@/lib/destructive-action-confirm', {
  namedExports: {
    issueDestructiveActionCode: async () => ({ success: true, email: 'admin@example.com', expiresInSec: 600 }),
    consumeDestructiveActionCode: async () => true,
  },
})
mock.module('@/lib/integration-plugin-selection-lock', {
  namedExports: {
    lockIntegrationPluginSelection: async () => ({ xero: false, quickbooks: false, woocommerce: false }),
  },
})
mock.module('@/lib/connectors/xero/api', {
  namedExports: { clearXeroReferenceCache: () => {} },
})
mock.module('@/lib/security/connector-fetch', {
  namedExports: {
    connectorFetch: async (url: string, init?: { headers?: Record<string, string>; body?: URLSearchParams }) => {
      fetchedUrls.push(url)
      if (url.includes('identity.xero.com/connect/token')) {
        const code = init?.body?.get('code') ?? ''
        // A refresh is the LONG round trip: the token row was read before it, and the write comes after.
        if (init?.body?.get('grant_type') === 'refresh_token' && refreshGrantGate) await refreshGrantGate()
        return jsonResponse({
          access_token: accessTokenByCode[code] ?? 'access-1',
          refresh_token: 'refresh-1',
          expires_in: 1800,
          token_type: 'Bearer',
          scope: 'accounting.transactions accounting.contacts',
        })
      }
      if (url.includes('api.xero.com/connections')) {
        const bearer = (init?.headers?.Authorization ?? '').replace('Bearer ', '')
        const code = Object.keys(accessTokenByCode).find((key) => accessTokenByCode[key] === bearer)
        return jsonResponse(code != null ? connectionsByCode[code] : connectionsBody)
      }
      if (url.includes('Organisation')) {
        organisationCalls += 1
        if (organisationFetchGate) await organisationFetchGate()
        return jsonResponse(organisationBody)
      }
      throw new Error(`unexpected connectorFetch: ${url}`)
    },
  },
})

async function loadAuth() {
  return await import('@/lib/connectors/xero/auth')
}

beforeEach(() => {
  tokenRow = null
  settings = { xero_client_id: 'client-id', xero_client_secret: 'client-secret' }
  connectionsBody = []
  connectionsByCode = {}
  accessTokenByCode = {}
  organisationBody = { Organisations: [{ BaseCurrency: 'GBP' }] }
  organisationCalls = 0
  settingReadGate = null
  organisationFetchGate = null
  resetTokenDeleteGate = null
  settingsWipeFails = false
  refreshGrantGate = null
  bindingTokenWriteGate = null
  pendingSettingInserts.clear()
  pendingTokenWrite = null
  notifications = []
  activity = []
  fetchedUrls = []
  clearedIdColumns = []
  rowSequence = 0
  delete process.env.XERO_REQUIRE_DEMO_ORG
  delete process.env.XERO_ALLOWED_TENANT_IDS
  delete process.env.XERO_ALLOWED_TENANT_NAMES
  delete process.env.XERO_BLOCKED_TENANT_IDS
  // XERO_TENANT_ID is READ as of o3d-9tbz. It has to be cleared here like the others, or a value left
  // in the developer's own environment silently narrows the allow-list for every test in this file.
  delete process.env.XERO_TENANT_ID
  // o3d-iaqy. Every test in this file that predates that issue is about an instance with a legitimate
  // reason to run with whatever tenant control it has — including none — so the default here is the one
  // environment for which "no tenant control" is a permitted state: production. The non-production
  // instance, which is the whole subject of o3d-iaqy, is asked for explicitly by the tests that mean it
  // (see `nonProductionInstance()`), so a test that does not say so cannot silently be exercising it.
  setNodeEnv('production')
  delete process.env.E2E_TEST_MODE
})

/** `process.env.NODE_ENV` is typed readonly; this is the repo's usual way round it (see tests/cron/*). */
function setNodeEnv(value: string) {
  ;(process.env as Record<string, string | undefined>).NODE_ENV = value
}

/**
 * This instance says it is not production (o3d-iaqy) — the state the e2e rig was in for o3d-t74p.
 *
 * Two spellings, because the two signals are not interchangeable: the full-chain rig serves a PRODUCTION
 * build and so reports NODE_ENV=production, and E2E_TEST_MODE=1 is the only thing that distinguishes it.
 */
function nonProductionInstance(via: 'node-env' | 'e2e-flag' = 'node-env') {
  if (via === 'e2e-flag') {
    setNodeEnv('production')
    process.env.E2E_TEST_MODE = '1'
    return
  }
  setNodeEnv('development')
  delete process.env.E2E_TEST_MODE
}

/** A fresh database: no token row, no pin. The exact state the e2e rig connected in. */
function freshDatabase() {
  tokenRow = null
  delete settings.xero_expected_tenant_id
}

/** Two independent consents in flight at once, each offering its own organisation. */
function twoConsents(a: { code: string; org: typeof DEMO }, b: { code: string; org: typeof DEMO }) {
  connectionsByCode = { [a.code]: [a.org], [b.code]: [b.org] }
  accessTokenByCode = { [a.code]: `access-${a.code}`, [b.code]: `access-${b.code}` }
}

/** An instance already bound to an organisation: token row AND pin, as a real connection leaves it. */
function pinnedTo(conn: typeof DEMO) {
  settings.xero_expected_tenant_id = conn.tenantId
  tokenRow = {
    id: newRowId(),
    connector: 'xero',
    accessToken: 'stored-access',
    refreshToken: 'stored-refresh',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    tenantId: conn.tenantId,
    tenantName: conn.tenantName,
    grantedScopes: 'accounting.transactions',
    tenantIsDemo: null,
    connectionGeneration: 'generation-before',
    pinReleasedAt: null,
    pinReleasedGeneration: null,
    pinReleasedTenantId: null,
  }
}

/**
 * THE BYPASS (o3d-9tbz r6): a bound instance whose PIN HAS BEEN DELETED, token row untouched.
 *
 * One `DELETE FROM settings WHERE key = 'xero_expected_tenant_id'` reaches this state from an ordinary
 * connected instance, and so does restoring `settings` and `accounting_tokens` from different backups —
 * which is the scenario the split-binding refusal was written for, so under r5 the refusal was absent
 * exactly when it mattered. The token row is left carrying the generation its binding minted, which is
 * the whole evidence: that transaction wrote the pin too, and only `disconnect()` removes both.
 */
function pinDeleted(conn: typeof DEMO) {
  pinnedTo(conn)
  delete settings.xero_expected_tenant_id
}

/**
 * THE DOCUMENTED RECOVERY: `provision-xero-demo.ts --clear-tenant-pin`.
 *
 * It deletes the pin and stamps the token row in ONE transaction, so the release leaves a receipt that
 * a deletion cannot. Written here as the script writes it, because the point under test is that the two
 * states are distinguishable — not that some flag can be set.
 *
 * ALL THREE COLUMNS, as one statement writes them (r7): the timestamp, the connection the row carried
 * at the release, and the organisation the DELETED pin named. A receipt with only the timestamp is not
 * a smaller version of this — it is the r7 defect, and it has its own state below.
 */
function releasedPin(conn: typeof DEMO) {
  pinDeleted(conn)
  stampReleaseReceipt(conn.tenantId, new Date('2026-08-19T09:00:00.000Z'))
}

/**
 * The UPDATE `--clear-tenant-pin` issues, in the same transaction as the DELETE above it.
 *
 * One helper rather than three hand-written literals, because the point of the receipt is that its
 * fields are written TOGETHER and copied from the row itself — a test that set them independently could
 * write a combination the script cannot produce and then prove something about it.
 */
function stampReleaseReceipt(deletedPinTenantId: string, at: Date) {
  tokenRow!.pinReleasedAt = at
  tokenRow!.pinReleasedGeneration = tokenRow!.connectionGeneration
  tokenRow!.pinReleasedTenantId = deletedPinTenantId
  // ...and the half that stays in `settings`, written by the same transaction (o3d-9tbz r8). It is what
  // a copied token row cannot bring with it, so it is what separates a release this instance performed
  // from one it merely inherited.
  settings.xero_pin_release_witness = JSON.stringify({
    generation: tokenRow!.connectionGeneration, tenantId: deletedPinTenantId,
  })
}

/**
 * A WHOLESALE-RESTORED TOKEN ROW (o3d-9tbz r8 finding 2).
 *
 * `accounting_tokens` put back from a dump taken while a release was outstanding, onto an instance that
 * never performed it. Everything r7 compares is on that row and came out of that one dump, so the row
 * corroborates itself perfectly — this helper writes the release exactly as the recovery would and then
 * removes only the half that lives in the other table, which is precisely what a restore of one table
 * does. A double that also removed something from the token row would be testing a different bug.
 */
function restoredMidReleaseTokenRow(conn: typeof DEMO) {
  releasedPin(conn)
  delete settings.xero_pin_release_witness
}

/**
 * A RECEIPT FROM BEFORE THE QUALIFIERS EXISTED (o3d-9tbz r8 finding 1).
 *
 * A timestamp and nothing else — which is what every release recorded before r7 looks like, AND what
 * the pre-r7 `--clear-tenant-pin` stamped when it deleted no pin at all. The two are the same row, and
 * that is why the r7 migration cannot fill the qualifiers in from it.
 */
function legacyUnqualifiedRelease(conn: typeof DEMO) {
  pinDeleted(conn)
  tokenRow!.pinReleasedAt = new Date('2026-08-19T09:00:00.000Z')
}

/**
 * A RECEIPT THAT OUTLIVED WHAT IT RELEASED (o3d-9tbz r7) — the state r6 could not express at all,
 * because its receipt recorded only that a release had happened.
 *
 * Reached the way the r6 bypass was reached: not by anyone forging anything, but by a RESTORE. A dump
 * of accounting_tokens taken while a release was outstanding, put back over an instance that has been
 * re-consented since, brings the exemption with it and leaves it sitting on a connection it knows
 * nothing about — while the pin, which lives in the other table, does not come back with it.
 *
 * The token row here is therefore a LATER connection (a different generation) carrying an EARLIER
 * release's paperwork.
 */
function staleReleaseFromRestore(conn: typeof DEMO) {
  releasedPin(conn)
  tokenRow!.connectionGeneration = 'generation-after-restore'
}

/**
 * A release performed on an instance whose two halves ALREADY named different organisations.
 *
 * `--clear-tenant-pin` deletes the pin, so the split-binding refusal (r5) has nothing left to compare —
 * and under r6 the receipt then exempted the row from the missing-pin refusal too, which is a way to
 * end a refusal by deleting one side of the contradiction it is about. The receipt records the pin it
 * actually deleted, so the two organisations stay visibly different.
 */
function releasedSplitBinding(params: { pin: typeof DEMO; token: typeof DEMO }) {
  mismatched(params)
  delete settings.xero_expected_tenant_id
  stampReleaseReceipt(params.pin.tenantId, new Date('2026-08-19T09:00:00.000Z'))
}

/**
 * A CONNECTION FROM BEFORE ANY OF THIS: no pin, and a token row with no generation to prove there ever
 * was one. Every installation connected before r5 shipped is in this state, and none of them may go
 * offline on the deploy that starts reading the marker.
 */
function unpinnedLegacyRow(conn: typeof DEMO) {
  pinDeleted(conn)
  tokenRow!.connectionGeneration = null
}

/**
 * An instance whose two halves name DIFFERENT organisations, with no callback in its history.
 *
 * This is not a race outcome — it is the state a machine is already in when this code ships: one that
 * connected under a build predating the atomic binding, or one that was handed a database from another
 * environment. Rounds 3 and 4 close the doors that create it and do nothing whatever for an instance
 * standing on the other side of them.
 */
function mismatched(params: { pin: typeof DEMO; token: typeof DEMO }) {
  pinnedTo(params.token)
  settings.xero_expected_tenant_id = params.pin.tenantId
}

/**
 * A split instance whose organisations belong to this test alone.
 *
 * The once-per-offending-tenant dedupe in auth.ts is MODULE state and the module is loaded once for the
 * whole file, so two tests that refuse the same tenantId leave the second one silently un-logged. Every
 * test here that looks at the record therefore names its own organisations — which is also closer to
 * life, where one machine has one binding.
 */
function splitBinding(label: string): { pin: typeof DEMO; token: typeof DEMO } {
  const pin = { ...DEMO, tenantId: `5c949ed5-demo-${label}` }
  const token = { ...LIVE, tenantId: `e7fb4378-live-${label}` }
  mismatched({ pin, token })
  return { pin, token }
}


test('FRESH DATABASE + several organisations: refused, and NOTHING is stored', async () => {
  freshDatabase()
  connectionsBody = [LIVE, DEMO]
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('code-1', 'https://ims.example/api/accounting/callback')

  assert.equal(result.success, false)
  assert.equal(tokenRow, null, 'no token row was written')
  assert.equal(settings.xero_expected_tenant_id, undefined, 'no tenant was pinned')
  assert.equal(organisationCalls, 0, 'not even a read was made against the organisation')
  assert.match(result.error ?? '', /OneTwo3D Ltd/)
  assert.match(result.error ?? '', /Demo Company \(UK\)/)
  assert.match(result.error ?? '', /XERO_ALLOWED_TENANT_IDS/)
  assert.ok(activity.some((entry) => entry.action === 'xero_connect_refused'), 'the refusal is recorded')
})

test('FRESH DATABASE + a single organisation: ordinary first-time setup still connects', async () => {
  // This case outranks the bug. If it breaks, the fix is worse than what it fixes.
  freshDatabase()
  connectionsBody = [DEMO]
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('code-1', 'https://ims.example/api/accounting/callback')

  assert.equal(result.success, true)
  assert.equal(result.tenantName, 'Demo Company (UK)')
  assert.equal(tokenRow?.tenantId, DEMO.tenantId)
  assert.equal(tokenRow?.accessToken, 'access-1')
  assert.equal(settings.xero_expected_tenant_id, DEMO.tenantId, 'and the connection pins itself')
})

test('the allow-list chooses among several organisations on a fresh database', async () => {
  // The only control that survives a database reset. LIVE is first in the list — the old code took it.
  freshDatabase()
  connectionsBody = [LIVE, DEMO]
  process.env.XERO_ALLOWED_TENANT_IDS = DEMO.tenantId
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('code-1', 'https://ims.example/api/accounting/callback')

  assert.equal(result.success, true)
  assert.equal(tokenRow?.tenantId, DEMO.tenantId, 'the allowed org, not connections[0]')
})

test('an organisation outside the allow-list is refused even when it is the ONLY one offered', async () => {
  freshDatabase()
  connectionsBody = [LIVE]
  process.env.XERO_ALLOWED_TENANT_NAMES = 'Demo Company (UK)'
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('code-1', 'https://ims.example/api/accounting/callback')

  assert.equal(result.success, false)
  assert.equal(tokenRow, null)
  assert.equal(organisationCalls, 0)
  assert.match(result.error ?? '', /Demo Company \(UK\)/)
})

test('a pinned instance reconnects to its pinned organisation, not the first one offered', async () => {
  pinnedTo(DEMO)
  connectionsBody = [LIVE, DEMO]
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('code-1', 'https://ims.example/api/accounting/callback')

  assert.equal(result.success, true)
  assert.equal(tokenRow?.tenantId, DEMO.tenantId)
})

test('a REVOKED authorisation (200 with an empty array) is reported as a revocation', async () => {
  freshDatabase()
  connectionsBody = []
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('code-1', 'https://ims.example/api/accounting/callback')

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /REVOKED/)
  assert.equal(tokenRow, null)
})

test('a connections body that is not an array is refused, not crashed on', async () => {
  freshDatabase()
  connectionsBody = { Message: 'AuthenticationUnsuccessful' }
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('code-1', 'https://ims.example/api/accounting/callback')

  assert.equal(result.success, false)
  assert.equal(tokenRow, null)
  assert.match(result.error ?? '', /REVOKED/, 'and diagnosed like an empty list, not as a crash')
})


// --- the stored token, which is what every sync actually uses ----------------

test('a STORED token outside the allow-list stops the sync and says why', async () => {
  // The restored-dump case, and the shape the incident really took: the callback ran once, days of
  // syncs followed, and none of them went anywhere near the callback.
  pinnedTo(LIVE)
  process.env.XERO_ALLOWED_TENANT_IDS = DEMO.tenantId
  const { getAccessToken } = await loadAuth()

  assert.equal(await getAccessToken(), null)
  assert.equal(notifications.length, 1, 'the operator is told once')
  assert.match(notifications[0].message, /OneTwo3D Ltd/)
  assert.match(notifications[0].message, new RegExp(DEMO.tenantId))
  assert.ok(activity.some((entry) => entry.action === 'xero_stored_tenant_refused'))

  await getAccessToken()
  assert.equal(notifications.length, 1, 'and not once per sync tick')
})

test('a stored token ON the allow-list is handed out untouched', async () => {
  pinnedTo(DEMO)
  process.env.XERO_ALLOWED_TENANT_IDS = DEMO.tenantId
  const { getAccessToken } = await loadAuth()

  const auth = await getAccessToken()
  assert.equal(auth?.tenantId, DEMO.tenantId)
  assert.equal(auth?.accessToken, 'stored-access')
  assert.equal(notifications.length, 0)
})

test('with no allow-list configured the stored token is handed out exactly as before', async () => {
  pinnedTo(LIVE)
  const { getAccessToken } = await loadAuth()

  const auth = await getAccessToken()
  assert.equal(auth?.tenantId, LIVE.tenantId)
  assert.equal(notifications.length, 0)
})

test('the block reason travels with the failure, so "Not connected" is not the only clue', async () => {
  // Every Xero call reports a missing token as "Not connected to Xero". For an allow-list block that
  // sends the operator hunting for a lost token instead of reading the message that explains it.
  pinnedTo(LIVE)
  process.env.XERO_ALLOWED_TENANT_IDS = DEMO.tenantId
  const { getStoredTenantBlockReason } = await loadAuth()

  const reason = await getStoredTenantBlockReason()
  assert.match(reason ?? '', /OneTwo3D Ltd/)
  assert.match(reason ?? '', /allow-list forbids/)
})

test('no block reason when the stored token is allowed, or when there is no token at all', async () => {
  pinnedTo(DEMO)
  process.env.XERO_ALLOWED_TENANT_IDS = DEMO.tenantId
  const { getStoredTenantBlockReason } = await loadAuth()
  assert.equal(await getStoredTenantBlockReason(), null)

  freshDatabase()
  assert.equal(await getStoredTenantBlockReason(), null, 'a disconnected instance is not "blocked"')
})


// --- XERO_TENANT_ID, end to end ------------------------------------------------
//
// The documented control that nothing read. An operator who set it to their live org and connected an
// e2e rig got precisely the incident it looks like it prevents. These run it through the real callback
// and the real token path, because that is where the belief was false.

test('XERO_TENANT_ID ALONE stops the incident at the callback: nothing stored, nothing read', async () => {
  freshDatabase()
  connectionsBody = [LIVE, DEMO]
  process.env.XERO_TENANT_ID = DEMO.tenantId
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('code-1', 'https://ims.example/api/accounting/callback')

  // LIVE is connections[0] and there is no pin — the exact state of the e2e rig in o3d-t74p.
  assert.equal(result.success, true)
  assert.equal(tokenRow?.tenantId, DEMO.tenantId, 'the org XERO_TENANT_ID names, not the first offered')
  assert.equal(settings.xero_expected_tenant_id, DEMO.tenantId)
})

test('XERO_TENANT_ID ALONE refuses a consent that offers only the forbidden org', async () => {
  freshDatabase()
  connectionsBody = [LIVE]
  process.env.XERO_TENANT_ID = DEMO.tenantId
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('code-1', 'https://ims.example/api/accounting/callback')

  assert.equal(result.success, false)
  assert.equal(tokenRow, null, 'no token row was written')
  assert.equal(organisationCalls, 0, 'not even a read against the live organisation')
  assert.match(result.error ?? '', /OneTwo3D Ltd/)
  assert.match(result.error ?? '', /replace the XERO_TENANT_ID line/, 'a remedy that does not create a conflict')
})

test('XERO_TENANT_ID ALONE halts a STORED token from a restored dump', async () => {
  // The days-of-syncs half of the incident, and the only half a callback check cannot reach.
  pinnedTo(LIVE)
  process.env.XERO_TENANT_ID = DEMO.tenantId
  const { getAccessToken } = await loadAuth()

  assert.equal(await getAccessToken(), null, 'genuinely protected, not merely warned')
  assert.equal(notifications.length, 1)
  assert.match(notifications[0].message, /XERO_TENANT_ID/)
})

test('a blank XERO_TENANT_ID — as .env.example and install.sh ship it — changes nothing', async () => {
  freshDatabase()
  connectionsBody = [DEMO]
  process.env.XERO_TENANT_ID = ''
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('code-1', 'https://ims.example/api/accounting/callback')
  assert.equal(result.success, true, 'first-time setup on a stock .env is untouched')
  assert.equal(tokenRow?.tenantId, DEMO.tenantId)
})


// --- the two keys disagreeing, end to end ---------------------------------------

test('a contradictory configuration refuses the callback even for a single-org consent', async () => {
  freshDatabase()
  connectionsBody = [DEMO]
  process.env.XERO_TENANT_ID = DEMO.tenantId
  process.env.XERO_ALLOWED_TENANT_IDS = LIVE.tenantId
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('code-1', 'https://ims.example/api/accounting/callback')

  assert.equal(result.success, false)
  assert.equal(tokenRow, null)
  assert.match(result.error ?? '', /contradict each other/)
  assert.ok(
    activity.some((entry) => entry.action === 'xero_connect_refused'),
    'and the refusal is on the record, not just on the operator’s screen',
  )
})

test('a contradictory configuration also halts an ALREADY-CONNECTED instance', async () => {
  // Config drift on a running box: the contradiction arrives by .env edit, with no callback in sight.
  pinnedTo(DEMO)
  process.env.XERO_TENANT_ID = DEMO.tenantId
  process.env.XERO_ALLOWED_TENANT_IDS = LIVE.tenantId
  const { getAccessToken } = await loadAuth()

  assert.equal(await getAccessToken(), null)
  assert.match(notifications[0].message, /contradict each other/)
  assert.match(notifications[0].message, /delete that line/)
})

test('the same organisation spelled in both keys is NOT a conflict', async () => {
  // A migration off the deprecated name, done belt-and-braces, must not be an outage.
  pinnedTo(DEMO)
  process.env.XERO_TENANT_ID = DEMO.tenantId
  process.env.XERO_ALLOWED_TENANT_IDS = DEMO.tenantId
  const { getAccessToken } = await loadAuth()

  const auth = await getAccessToken()
  assert.equal(auth?.tenantId, DEMO.tenantId)
  assert.equal(notifications.length, 0)
})


// --- isConnected: a blocked token is not a connection -----------------------------

test('an allow-list-blocked token reports NOT connected, with the reason', async () => {
  // It used to report a healthy green connection on /sync while every sync failed — the one screen an
  // operator checks to find out whether Xero works told them it did.
  pinnedTo(LIVE)
  process.env.XERO_ALLOWED_TENANT_IDS = DEMO.tenantId
  const { isConnected } = await loadAuth()

  const status = await isConnected()
  assert.equal(status.connected, false)
  assert.match(status.blockedReason ?? '', /allow-list forbids/)
  assert.match(status.blockedReason ?? '', /OneTwo3D Ltd/)
})

test('a blocked token still reports hasStoredToken, so Disconnect stays on screen', async () => {
  // The refusal says "disconnect Xero on /sync". /sync only offers that button when something is
  // stored, so dropping this flag would make the remedy name a control that is not there.
  pinnedTo(LIVE)
  process.env.XERO_ALLOWED_TENANT_IDS = DEMO.tenantId
  const { isConnected } = await loadAuth()

  const status = await isConnected()
  assert.equal(status.hasStoredToken, true)
  assert.match(status.blockedReason ?? '', /disconnect Xero on \/sync/i)
})

test('isConnected does NOT notify — it runs on every render of /sync', async () => {
  // Minting an activity row and a notification per page view would bury the one that matters.
  pinnedTo(LIVE)
  process.env.XERO_ALLOWED_TENANT_IDS = DEMO.tenantId
  const { isConnected } = await loadAuth()

  await isConnected()
  await isConnected()
  assert.equal(notifications.length, 0)
  assert.equal(activity.length, 0)
})

test('an allowed token reports connected, and a fresh database reports neither', async () => {
  pinnedTo(DEMO)
  process.env.XERO_ALLOWED_TENANT_IDS = DEMO.tenantId
  const { isConnected } = await loadAuth()

  const connectedStatus = await isConnected()
  assert.equal(connectedStatus.connected, true)
  assert.equal(connectedStatus.tenantName, 'Demo Company (UK)')
  assert.equal(connectedStatus.blockedReason, undefined)

  freshDatabase()
  const freshStatus = await isConnected()
  assert.equal(freshStatus.connected, false)
  assert.equal(freshStatus.hasStoredToken, undefined, 'never connected is not the same as blocked')
  assert.equal(freshStatus.blockedReason, undefined)
})

test('a contradictory configuration is reported by isConnected too, not just by the sync', async () => {
  pinnedTo(DEMO)
  process.env.XERO_TENANT_ID = DEMO.tenantId
  process.env.XERO_ALLOWED_TENANT_IDS = LIVE.tenantId
  const { isConnected } = await loadAuth()

  const status = await isConnected()
  assert.equal(status.connected, false)
  assert.equal(status.hasStoredToken, true)
  assert.match(status.blockedReason ?? '', /contradict each other/)
})


// --- XERO_BLOCKED_TENANT_IDS, end to end ---------------------------------------
//
// The rig's answer to the rotating Demo tenantId (r2 finding 1). Xero re-issues the Demo company's
// tenantId at every ~28-day reset, so an id ALLOW-list has to be re-edited every cycle; the LIVE
// organisation's id is the stable one, and blocking it is identity-strength rather than name-strength.

test('BLOCKING the live org stops the incident at the callback and connects to Demo instead', async () => {
  // The incident's own state: fresh database, no pin, LIVE first in the consent.
  freshDatabase()
  connectionsBody = [LIVE, DEMO]
  process.env.XERO_BLOCKED_TENANT_IDS = LIVE.tenantId
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('code-1', 'https://ims.example/api/accounting/callback')

  assert.equal(result.success, true)
  assert.equal(tokenRow?.tenantId, DEMO.tenantId, 'the org that is not blocked, not connections[0]')
  assert.equal(settings.xero_expected_tenant_id, DEMO.tenantId)
})

test('the deny-list needs no edit when the Demo company comes back with a NEW tenantId', async () => {
  // The reason the runbook reached for names in the first place. Same .env line, next cycle.
  freshDatabase()
  const rotated = { ...DEMO, id: 'c-demo-2', tenantId: '5c949ed5-demo-cycle-2' }
  connectionsBody = [LIVE, rotated]
  process.env.XERO_BLOCKED_TENANT_IDS = LIVE.tenantId
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('code-1', 'https://ims.example/api/accounting/callback')

  assert.equal(result.success, true)
  assert.equal(tokenRow?.tenantId, rotated.tenantId)
})

test('a BLOCKED stored token halts every sync — the restored-dump half of the incident', async () => {
  pinnedTo(LIVE)
  process.env.XERO_BLOCKED_TENANT_IDS = LIVE.tenantId
  const { getAccessToken } = await loadAuth()

  assert.equal(await getAccessToken(), null, 'genuinely stopped, not merely warned')
  assert.match(notifications[0].message, /XERO_BLOCKED_TENANT_IDS/)
  assert.ok(activity.some((entry) => entry.action === 'xero_stored_tenant_refused'))
})

test('a consent that offers only blocked organisations is refused with nothing stored', async () => {
  freshDatabase()
  connectionsBody = [LIVE]
  process.env.XERO_BLOCKED_TENANT_IDS = LIVE.tenantId
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('code-1', 'https://ims.example/api/accounting/callback')

  assert.equal(result.success, false)
  assert.equal(tokenRow, null)
  assert.equal(organisationCalls, 0, 'not even a read against the live organisation')
  assert.match(result.error ?? '', /XERO_BLOCKED_TENANT_IDS/)
})


// --- a name is not an identity, end to end -------------------------------------

test('two organisations sharing a NAME refuse the callback, and nothing is stored', async () => {
  freshDatabase()
  connectionsBody = [DEMO, { ...DEMO, id: 'c-other', tenantId: 'aa000000-other-demo' }]
  process.env.XERO_ALLOWED_TENANT_NAMES = 'Demo Company (UK)'
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('code-1', 'https://ims.example/api/accounting/callback')

  assert.equal(result.success, false)
  assert.equal(tokenRow, null)
  assert.equal(organisationCalls, 0)
  assert.match(result.error ?? '', /does not identify/)
  assert.ok(activity.some((entry) => entry.action === 'xero_connect_refused'))
})

test('an organisation RENAMED to the allow-listed name does not get past the id list', async () => {
  // Under the old union this connected: the name admitted an organisation the ids excluded.
  freshDatabase()
  connectionsBody = [{ ...LIVE, tenantName: 'Demo Company (UK)' }]
  process.env.XERO_ALLOWED_TENANT_IDS = DEMO.tenantId
  process.env.XERO_ALLOWED_TENANT_NAMES = 'Demo Company (UK)'
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('code-1', 'https://ims.example/api/accounting/callback')

  assert.equal(result.success, false)
  assert.equal(tokenRow, null)
  assert.equal(organisationCalls, 0)
})

test('an id and that same organisation NAME connect — two spellings are not a contradiction', async () => {
  // r2 finding 2. This pair used to be refused as a conflict.
  freshDatabase()
  connectionsBody = [LIVE, DEMO]
  process.env.XERO_TENANT_ID = DEMO.tenantId
  process.env.XERO_ALLOWED_TENANT_NAMES = 'Demo Company (UK)'
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('code-1', 'https://ims.example/api/accounting/callback')

  assert.equal(result.success, true)
  assert.equal(tokenRow?.tenantId, DEMO.tenantId)
})

test('an id and a name selecting DIFFERENT organisations still refuses, quoting both', async () => {
  freshDatabase()
  connectionsBody = [LIVE, DEMO]
  process.env.XERO_ALLOWED_TENANT_IDS = DEMO.tenantId
  process.env.XERO_ALLOWED_TENANT_NAMES = 'OneTwo3D Ltd'
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('code-1', 'https://ims.example/api/accounting/callback')

  assert.equal(result.success, false)
  assert.equal(tokenRow, null)
  assert.match(result.error ?? '', /contradict each other/)
  assert.match(result.error ?? '', /no organisation satisfies both/)
})

test('a NAME-ONLY guard is recorded as weaker than it looks — once, not once per sync', async () => {
  // Not a refusal: refusing would switch off the only tenant control the rig has today. But an operator
  // who believes a name pins the ledger is in the position this whole branch exists to end.
  const soleDemo = { ...DEMO, id: 'c-warn', tenantId: '5c949ed5-demo-warn' }
  pinnedTo(soleDemo)
  process.env.XERO_ALLOWED_TENANT_NAMES = 'Demo Company (UK)'
  const { getAccessToken } = await loadAuth()

  assert.equal((await getAccessToken())?.tenantId, soleDemo.tenantId, 'still permitted')
  const warnings = activity.filter((entry) => entry.action === 'xero_tenant_guard_name_only')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0].description, /XERO_BLOCKED_TENANT_IDS=/)

  await getAccessToken()
  await getAccessToken()
  assert.equal(activity.filter((e) => e.action === 'xero_tenant_guard_name_only').length, 1, 'not per tick')
})

test('adding an id-based control clears the name-only warning', async () => {
  const soleDemo = { ...DEMO, id: 'c-warn2', tenantId: '5c949ed5-demo-warn2' }
  pinnedTo(soleDemo)
  process.env.XERO_ALLOWED_TENANT_NAMES = 'Demo Company (UK)'
  process.env.XERO_BLOCKED_TENANT_IDS = LIVE.tenantId
  const { getAccessToken } = await loadAuth()

  assert.equal((await getAccessToken())?.tenantId, soleDemo.tenantId)
  assert.equal(activity.filter((e) => e.action === 'xero_tenant_guard_name_only').length, 0)
})


// --- two callbacks racing for the binding (r3 finding 1) -------------------------
//
// Every check in tenant-guard.ts is computed from a snapshot: the pin is read, the choice is made, and
// the write happens later. Two callbacks in flight at once — a double-clicked Connect, two operators,
// a replayed redirect — both read "no pin" on a fresh database, both pass, and the second write lands on
// top of the first. The pin is the only thing that makes a later consent to a different organisation
// refuse, so a race that rewrites it does not trip the guard, it deletes it. What decides the winner is
// the PRIMARY KEY on settings.key, which is why the double models one.

test('TWO CALLBACKS AT ONCE on a fresh database: exactly one binds, the other stores nothing', async () => {
  // The rig's operator can reach both organisations, and consents to one in each of two browser tabs.
  freshDatabase()
  twoConsents({ code: 'code-demo', org: DEMO }, { code: 'code-live', org: LIVE })
  gateSettingReads(2)
  const { exchangeCodeForTokens } = await loadAuth()

  const [first, second] = await Promise.all([
    exchangeCodeForTokens('code-demo', 'https://ims.example/api/accounting/callback'),
    exchangeCodeForTokens('code-live', 'https://ims.example/api/accounting/callback'),
  ])

  const succeeded = [first, second].filter((r) => r.success)
  const refused = [first, second].filter((r) => !r.success)
  assert.equal(succeeded.length, 1, 'exactly one callback established the binding')
  assert.equal(refused.length, 1, 'and the other was refused rather than overwriting it')

  // The binding is one thing, not two that can disagree: the pin and the token name one organisation.
  assert.equal(settings.xero_expected_tenant_id, tokenRow?.tenantId)
  assert.equal(tokenRow?.tenantName, succeeded[0].tenantName)
  assert.equal(
    tokenRow?.accessToken,
    tokenRow?.tenantId === DEMO.tenantId ? 'access-code-demo' : 'access-code-live',
    'and the stored token is the WINNER’s, not the other consent’s',
  )
})

test('the loser of the race is told which organisation won, and how to take it over', async () => {
  freshDatabase()
  twoConsents({ code: 'c1', org: DEMO }, { code: 'c2', org: LIVE })
  gateSettingReads(2)
  const { exchangeCodeForTokens } = await loadAuth()

  const results = await Promise.all([
    exchangeCodeForTokens('c1', 'https://ims.example/cb'),
    exchangeCodeForTokens('c2', 'https://ims.example/cb'),
  ])

  const refusal = results.find((r) => !r.success)
  const winner = results.find((r) => r.success)
  assert.ok(refusal && winner)
  assert.match(refusal.error ?? '', /another Xero connection finished first/i)
  assert.match(refusal.error ?? '', new RegExp(settings.xero_expected_tenant_id ?? 'never'), 'names the winner')
  assert.match(refusal.error ?? '', /nothing from it was stored/i)
  assert.match(refusal.error ?? '', /disconnect Xero on \/sync/i, 'a remedy, not just a complaint')
  assert.ok(
    activity.some((entry) => entry.action === 'xero_connect_refused'),
    'and the losing callback is on the record, not only on that operator’s screen',
  )
})

test('the loser writes NO token — a rolled-back binding leaves nothing behind', async () => {
  // The refusal says "nothing from it was stored". Pinning inside the transaction but writing the token
  // outside it would leave that sentence false AND leave the LOSER's token in the database under the
  // WINNER's pin — a stored credential for one organisation labelled as another. So this asserts on the
  // access token, which is the only thing that tells the two consents apart.
  freshDatabase()
  twoConsents({ code: 'c1', org: DEMO }, { code: 'c2', org: LIVE })
  gateSettingReads(2)
  const { exchangeCodeForTokens } = await loadAuth()

  const results = await Promise.all([
    exchangeCodeForTokens('c1', 'https://ims.example/cb'),
    exchangeCodeForTokens('c2', 'https://ims.example/cb'),
  ])

  const winner = results.find((r) => r.success)
  assert.ok(winner, 'one consent bound')
  assert.ok(results.find((r) => !r.success), 'and the other was rolled back')

  const winnerCode = winner.tenantName === DEMO.tenantName ? 'c1' : 'c2'
  const loserCode = winnerCode === 'c1' ? 'c2' : 'c1'
  assert.equal(settings.xero_expected_tenant_id, tokenRow?.tenantId, 'one binding, not two halves')
  assert.equal(tokenRow?.accessToken, `access-${winnerCode}`)
  assert.notEqual(
    tokenRow?.accessToken, `access-${loserCode}`,
    'the refused consent’s credential never reached the database',
  )
})

test('a callback that CHOSE before another finished is refused by the committed pin', async () => {
  // The same race arriving the other way round: both read "no pin" at the top, but the second one's
  // transaction opens after the first has committed, so it meets the pin rather than the unique index.
  freshDatabase()
  twoConsents({ code: 'c1', org: DEMO }, { code: 'c2', org: LIVE })
  gateOrganisationFetch(2)
  const { exchangeCodeForTokens } = await loadAuth()

  const results = await Promise.all([
    exchangeCodeForTokens('c1', 'https://ims.example/cb'),
    exchangeCodeForTokens('c2', 'https://ims.example/cb'),
  ])

  assert.equal(results.filter((r) => r.success).length, 1)
  const refusal = results.find((r) => !r.success)
  assert.match(refusal?.error ?? '', /another Xero connection finished first/i)
  assert.equal(settings.xero_expected_tenant_id, tokenRow?.tenantId)
})

test('two callbacks for the SAME organisation both succeed — a double-click is not an error', async () => {
  // The common case by far, and the one a "refuse anything concurrent" fix would break: an operator who
  // double-clicks Connect ends up bound to exactly the organisation they asked for, so putting a
  // refusal on their screen would be crying wolf on the ordinary path.
  freshDatabase()
  twoConsents({ code: 'c1', org: DEMO }, { code: 'c2', org: DEMO })
  gateSettingReads(2)
  const { exchangeCodeForTokens } = await loadAuth()

  const results = await Promise.all([
    exchangeCodeForTokens('c1', 'https://ims.example/cb'),
    exchangeCodeForTokens('c2', 'https://ims.example/cb'),
  ])

  assert.deepEqual(results.map((r) => r.success), [true, true])
  assert.deepEqual(results.map((r) => r.tenantName), ['Demo Company (UK)', 'Demo Company (UK)'])
  assert.equal(settings.xero_expected_tenant_id, DEMO.tenantId)
  assert.equal(tokenRow?.tenantId, DEMO.tenantId)
  assert.equal(
    activity.filter((e) => e.action === 'xero_connect_refused').length, 0,
    'and nothing was recorded as a refusal — a discarded duplicate is not an incident',
  )
})

test('an ordinary sequential re-consent to the SAME organisation still works', async () => {
  // The Demo-reset path and every routine re-authorisation. The binding must be re-establishable, or
  // the fix locks the rig out of the organisation it is protecting.
  pinnedTo(DEMO)
  connectionsBody = [DEMO]
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('code-1', 'https://ims.example/cb')
  assert.equal(result.success, true)
  assert.equal(tokenRow?.accessToken, 'access-1', 'the fresh token replaced the stored one')
  assert.equal(settings.xero_expected_tenant_id, DEMO.tenantId)
})


// --- XERO_REQUIRE_DEMO_ORG (r3 finding 2) ----------------------------------------
//
// Blocking the live org's id fences out ONE organisation. It never constrained the rig TO a demo
// organisation: a third org an operator also administers is neither blocked nor allow-listed, and a
// name cannot close that because a name is not an identity. Xero's own IsDemoCompany can.

function organisation(fields: Record<string, unknown>) {
  organisationBody = { Organisations: [{ BaseCurrency: 'GBP', ...fields }] }
}

test('a THIRD organisation passes a deny-list and is stopped by XERO_REQUIRE_DEMO_ORG', async () => {
  // The finding, exactly: XERO_BLOCKED_TENANT_IDS=<live> does not stop this consent.
  const THIRD = { id: 'c-third', tenantId: '9aa10000-third-org', tenantName: 'Bookkeeper Sandbox', tenantType: 'ORGANISATION' }
  freshDatabase()
  connectionsBody = [THIRD]
  process.env.XERO_BLOCKED_TENANT_IDS = LIVE.tenantId
  organisation({ IsDemoCompany: false })
  const { exchangeCodeForTokens } = await loadAuth()

  const withoutTheKey = await exchangeCodeForTokens('c1', 'https://ims.example/cb')
  assert.equal(withoutTheKey.success, true, 'the deny-list alone lets a third organisation through')

  freshDatabase()
  process.env.XERO_REQUIRE_DEMO_ORG = 'true'
  const withTheKey = await exchangeCodeForTokens('c2', 'https://ims.example/cb')
  assert.equal(withTheKey.success, false)
  assert.equal(tokenRow, null, 'nothing stored')
  assert.equal(settings.xero_expected_tenant_id, undefined, 'and nothing pinned')
  assert.match(withTheKey.error ?? '', /Bookkeeper Sandbox/)
  assert.match(withTheKey.error ?? '', /XERO_REQUIRE_DEMO_ORG/)
  assert.match(withTheKey.error ?? '', /IsDemoCompany=false/)
  assert.ok(activity.some((e) => e.action === 'xero_connect_refused'))
})

test('a Demo organisation connects under the key, and its demo status is RECORDED', async () => {
  freshDatabase()
  connectionsBody = [DEMO]
  process.env.XERO_REQUIRE_DEMO_ORG = 'true'
  organisation({ IsDemoCompany: true })
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('c1', 'https://ims.example/cb')
  assert.equal(result.success, true)
  assert.equal(tokenRow?.tenantId, DEMO.tenantId)
  assert.equal(tokenRow?.tenantIsDemo, true, 'so the STORED token can be checked without another API call')
  assert.equal(organisationCalls, 1, 'and it cost no call the callback was not already making')
})

test('the demo status is recorded even when the key is OFF, so switching it on needs no reconnect', async () => {
  freshDatabase()
  connectionsBody = [DEMO]
  organisation({ IsDemoCompany: true })
  const { exchangeCodeForTokens } = await loadAuth()

  assert.equal((await exchangeCodeForTokens('c1', 'https://ims.example/cb')).success, true)
  assert.equal(tokenRow?.tenantIsDemo, true)
})

test('Class: DEMO is accepted when IsDemoCompany is absent, and an unknown Class is not', async () => {
  freshDatabase()
  connectionsBody = [DEMO]
  process.env.XERO_REQUIRE_DEMO_ORG = 'true'
  organisation({ Class: 'DEMO' })
  const { exchangeCodeForTokens } = await loadAuth()
  assert.equal((await exchangeCodeForTokens('c1', 'https://ims.example/cb')).success, true)

  freshDatabase()
  organisation({ Class: 'PREMIUM' })
  const unknown = await exchangeCodeForTokens('c2', 'https://ims.example/cb')
  assert.equal(unknown.success, false, 'an unrecognised Class is not evidence of a demo organisation')
  assert.match(unknown.error ?? '', /could not read whether/i)
})

test('an organisation whose demo status Xero did not report is refused as UNVERIFIED, not as live', async () => {
  // Different remedy: nothing is wrong with the operator's choice, so "go and pick the Demo company"
  // would send them round the same loop.
  freshDatabase()
  connectionsBody = [DEMO]
  process.env.XERO_REQUIRE_DEMO_ORG = 'true'
  organisation({})
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('c1', 'https://ims.example/cb')
  assert.equal(result.success, false)
  assert.equal(tokenRow, null)
  assert.match(result.error ?? '', /could not read whether/i)
  assert.match(result.error ?? '', /Try connecting again/i)
  assert.match(result.error ?? '', /delete the XERO_REQUIRE_DEMO_ORG line/)
  assert.ok(activity.some((e) => e.action === 'xero_connect_refused'))
})

test('the demo requirement is answered BEFORE the base-currency comparison', async () => {
  // A live organisation whose base currency also differs must hear about the ledger it was about to
  // invoice into, not about currencies.
  freshDatabase()
  connectionsBody = [LIVE]
  process.env.XERO_REQUIRE_DEMO_ORG = 'true'
  organisation({ BaseCurrency: 'USD', IsDemoCompany: false })
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('c1', 'https://ims.example/cb')
  assert.equal(result.success, false)
  assert.match(result.error ?? '', /XERO_REQUIRE_DEMO_ORG/)
  assert.doesNotMatch(result.error ?? '', /base currency/i)
})

test('a STORED live token is halted by the key alone — the restored-dump half', async () => {
  // No callback runs when a production database is restored onto the rig. Only a read-time check sees
  // it, and this is the case the deny-list can only cover for organisations somebody remembered to list.
  const stray = { ...LIVE, tenantId: 'e7fb4378-live-restored', tenantName: 'Third Party Books' }
  pinnedTo(stray)
  process.env.XERO_REQUIRE_DEMO_ORG = 'true'
  const { getAccessToken } = await loadAuth()

  assert.equal(await getAccessToken(), null, 'genuinely stopped, not merely warned')
  assert.equal(notifications.length, 1)
  assert.match(notifications[0].message, /never verified with Xero/i)
  assert.match(notifications[0].message, /Third Party Books/)
  assert.match(notifications[0].message, /Disconnect Xero on \/sync/i)
  assert.ok(activity.some((e) => e.action === 'xero_stored_tenant_refused'))
})

test('a stored token RECORDED as a demo organisation keeps working', async () => {
  const demo = { ...DEMO, tenantId: '5c949ed5-demo-stored-ok' }
  pinnedTo(demo)
  tokenRow!.tenantIsDemo = true
  process.env.XERO_REQUIRE_DEMO_ORG = 'true'
  const { getAccessToken } = await loadAuth()

  assert.equal((await getAccessToken())?.tenantId, demo.tenantId)
  assert.equal(notifications.length, 0)
})

test('a stored token Xero said is NOT a demo organisation is refused with its own wording', async () => {
  const live = { ...LIVE, tenantId: 'e7fb4378-live-known' }
  pinnedTo(live)
  tokenRow!.tenantIsDemo = false
  process.env.XERO_REQUIRE_DEMO_ORG = 'true'
  const { getAccessToken } = await loadAuth()

  assert.equal(await getAccessToken(), null)
  assert.match(notifications[0].message, /Xero reports is NOT a demo organisation/i)
})

test('a demo-blocked token reports NOT connected on /sync, with the reason and a Disconnect button', async () => {
  const stray = { ...LIVE, tenantId: 'e7fb4378-live-isconnected' }
  pinnedTo(stray)
  process.env.XERO_REQUIRE_DEMO_ORG = 'true'
  const { isConnected, getStoredTenantBlockReason } = await loadAuth()

  const status = await isConnected()
  assert.equal(status.connected, false)
  assert.equal(status.hasStoredToken, true, 'so the remedy it names is on screen')
  assert.match(status.blockedReason ?? '', /XERO_REQUIRE_DEMO_ORG/)
  assert.match(await getStoredTenantBlockReason() ?? '', /XERO_REQUIRE_DEMO_ORG/)
})

test('a token refresh does not forget that the organisation was verified', async () => {
  // A refresh talks to the identity endpoint only. Clearing the flag there would turn a verified
  // connection into an unverified one at every expiry — an outage roughly every half hour.
  const demo = { ...DEMO, tenantId: '5c949ed5-demo-refresh' }
  pinnedTo(demo)
  tokenRow!.tenantIsDemo = true
  tokenRow!.expiresAt = new Date(Date.now() - 1000)
  process.env.XERO_REQUIRE_DEMO_ORG = 'true'
  const { getAccessToken } = await loadAuth()

  assert.equal((await getAccessToken())?.accessToken, 'access-1', 'it refreshed')
  assert.equal(tokenRow?.tenantIsDemo, true)
  assert.equal((await getAccessToken())?.tenantId, demo.tenantId, 'and the next read is still permitted')
})

test('a malformed XERO_REQUIRE_DEMO_ORG refuses everything instead of silently meaning "off"', async () => {
  // The XERO_TENANT_ID mistake in a new place: a line in the .env that reads like a guard, and no guard.
  freshDatabase()
  connectionsBody = [DEMO]
  process.env.XERO_REQUIRE_DEMO_ORG = 'Demo Company (UK)'
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('c1', 'https://ims.example/cb')
  assert.equal(result.success, false)
  assert.equal(tokenRow, null)
  assert.equal(organisationCalls, 0, 'refused before any Xero organisation was read')
  assert.match(result.error ?? '', /is not a yes\/no value/)
  assert.match(result.error ?? '', /XERO_REQUIRE_DEMO_ORG=true/)
})

test('XERO_REQUIRE_DEMO_ORG=false, and a blank value, change nothing', async () => {
  freshDatabase()
  connectionsBody = [LIVE]
  process.env.XERO_REQUIRE_DEMO_ORG = 'false'
  organisation({ IsDemoCompany: false })
  const { exchangeCodeForTokens } = await loadAuth()
  assert.equal((await exchangeCodeForTokens('c1', 'https://ims.example/cb')).success, true)

  freshDatabase()
  process.env.XERO_REQUIRE_DEMO_ORG = ''
  assert.equal((await exchangeCodeForTokens('c2', 'https://ims.example/cb')).success, true)
})

test('XERO_REQUIRE_DEMO_ORG is an anchor, so a name alongside it is not a name-ONLY guard', async () => {
  const demo = { ...DEMO, tenantId: '5c949ed5-demo-anchored' }
  pinnedTo(demo)
  tokenRow!.tenantIsDemo = true
  process.env.XERO_ALLOWED_TENANT_NAMES = 'Demo Company (UK)'
  process.env.XERO_REQUIRE_DEMO_ORG = 'true'
  const { getAccessToken } = await loadAuth()

  assert.equal((await getAccessToken())?.tenantId, demo.tenantId)
  assert.equal(activity.filter((e) => e.action === 'xero_tenant_guard_name_only').length, 0)
})

/**
 * THE REFRESH PATH WENT ROUND THE ATOMIC BINDING (o3d-9tbz r4).
 *
 * Round 3 made the binding itself atomic: of two consents, only one leaves a pin and a token behind. A
 * REFRESH is not a consent and never touched that machinery — it read the token row, spent a round trip
 * at Xero, and then wrote back keyed on `connector` alone. Anything that rebound this instance in
 * between was simply overwritten, leaving the pin naming one organisation and the token naming another.
 *
 * The token is the half that decides where invoices are posted, so that state is the o3d-t74p incident
 * again: 150 invoices into a live ledger from a rig that believed it was pointed at the Demo company.
 *
 * A rebinding to a DIFFERENT organisation only gets past the pin after a disconnect, so that is the
 * shape these tests use — and it is the ordinary one, because Xero re-creates the Demo company with a
 * new tenantId roughly every 28 days and the rig is reconnected by hand when it does.
 */

/** A second consent, offering the Demo company, with a token of its own so the two are never confused. */
function reconsentTo(conn: typeof DEMO, code: string) {
  connectionsByCode = { [code]: [conn] }
  accessTokenByCode = { [code]: `access-${code}` }
}

/** A connection that is due a refresh: pinned, stored, and past its expiry. */
function dueForRefresh(conn: typeof DEMO) {
  pinnedTo(conn)
  tokenRow!.expiresAt = new Date(Date.now() - 1000)
}

test('an ordinary refresh still writes the refreshed token to the row it refreshed', async () => {
  // This case outranks the bug, and it runs every ~30 minutes on every connected instance. A refresh
  // that stops storing anything is an outage at the next expiry, not a guard.
  const demo = { ...DEMO, tenantId: '5c949ed5-demo-ordinary-refresh' }
  dueForRefresh(demo)
  const { getAccessToken } = await loadAuth()

  const result = await getAccessToken()

  assert.equal(result?.accessToken, 'access-1')
  assert.equal(result?.tenantId, demo.tenantId)
  assert.equal(tokenRow?.accessToken, 'access-1', 'the row carries the refreshed access token')
  assert.equal(tokenRow?.refreshToken, 'refresh-1', 'and the rotated refresh token')
  assert.ok((tokenRow?.expiresAt.getTime() ?? 0) > Date.now(), 'with an expiry in the future')
  assert.equal(tokenRow?.tenantId, demo.tenantId, 'still the same organisation')
  assert.equal(activity.filter((e) => e.action === 'xero_refresh_discarded').length, 0)
  assert.equal(notifications.length, 0)
})

test('a refresh that lands AFTER a rebinding cannot overwrite the new organisation', async () => {
  const live = { ...LIVE, tenantId: 'e7fb4378-live-rotated-away' }
  dueForRefresh(live)
  const { getAccessToken, exchangeCodeForTokens } = await loadAuth()

  // The refresh is now AT XERO, holding a token for the live organisation and nothing else.
  const refreshHeld = latch()
  refreshGrantGate = refreshHeld.wait
  const refreshing = getAccessToken()
  await refreshHeld.reached

  // Meanwhile the operator disconnects (token row and pin both go) and re-consents to the Demo company.
  freshDatabase()
  reconsentTo(DEMO, 'c2')
  const reconnected = await exchangeCodeForTokens('c2', 'https://ims.example/cb')
  assert.equal(reconnected.success, true, 'the rebinding committed')
  assert.equal(tokenRow?.tenantId, DEMO.tenantId)

  refreshHeld.release()

  assert.equal(await refreshing, null, 'the stale refresh yields no usable token')
  assert.equal(tokenRow?.tenantId, DEMO.tenantId, 'the row still names the organisation just bound')
  assert.equal(tokenRow?.accessToken, 'access-c2', "and still holds THAT organisation's token")
  assert.equal(settings.xero_expected_tenant_id, DEMO.tenantId, 'pin and token name the same ledger')
  assert.ok(activity.some((e) => e.action === 'xero_refresh_discarded'), 'the blip is explainable')
  assert.equal(notifications.length, 0, 'a rebinding is not an incident to alarm the operator with')
})

test('a refresh whose write meets an UNCOMMITTED rebinding waits for it, then finds itself stale', async () => {
  // The genuinely concurrent case, and the one a check in this process cannot close: the refresh reaches
  // its write while the rebinding transaction is still open. It must not race the lock, and it must be
  // judged against what that transaction COMMITS rather than against the row it saw on the way in.
  const live = { ...LIVE, tenantId: 'e7fb4378-live-locked-out' }
  dueForRefresh(live)
  const { getAccessToken, exchangeCodeForTokens } = await loadAuth()

  const refreshHeld = latch()
  refreshGrantGate = refreshHeld.wait
  const refreshing = getAccessToken()
  let refreshSettled = false
  void refreshing.then(() => { refreshSettled = true }, () => { refreshSettled = true })
  await refreshHeld.reached

  // A consent that gets as far as writing the token row and stops there, holding its row lock.
  freshDatabase()
  reconsentTo(DEMO, 'c2')
  const bindingHeld = latch()
  bindingTokenWriteGate = bindingHeld.wait
  const binding = exchangeCodeForTokens('c2', 'https://ims.example/cb')
  await bindingHeld.reached

  refreshHeld.release()
  await drainMicrotasks()
  assert.equal(refreshSettled, false, 'the refresh is waiting on the row the binding holds, not racing it')

  bindingHeld.release()

  assert.equal((await binding).success, true)
  assert.equal(await refreshing, null, 'and once it can see the committed row, it is stale')
  assert.equal(tokenRow?.tenantId, DEMO.tenantId)
  assert.equal(tokenRow?.accessToken, 'access-c2', 'the winner of the binding still owns the token row')
  assert.equal(settings.xero_expected_tenant_id, DEMO.tenantId)
})

test('a refresh that lands after a DISCONNECT does not resurrect the connection', async () => {
  // The upsert had a `create` branch. A refresh completing seconds after Disconnect re-inserted the row
  // it had just deleted — reconnecting the instance to the organisation somebody had just detached it
  // from, with no pin to constrain what the next sync did with it.
  const demo = { ...DEMO, tenantId: '5c949ed5-demo-disconnected' }
  dueForRefresh(demo)
  const { getAccessToken } = await loadAuth()

  const refreshHeld = latch()
  refreshGrantGate = refreshHeld.wait
  const refreshing = getAccessToken()
  await refreshHeld.reached

  freshDatabase() // exactly what disconnect() leaves behind: no token row, no pin
  refreshHeld.release()

  assert.equal(await refreshing, null)
  assert.equal(tokenRow, null, 'no token row was re-created')
  assert.equal(settings.xero_expected_tenant_id, undefined, 'and nothing re-pinned')
})

/**
 * AN INSTANCE THAT IS ALREADY SPLIT (o3d-9tbz r5 finding 1).
 *
 * Rounds 3 and 4 stopped a pin/token mismatch being CREATED — the binding is one transaction the
 * database arbitrates, and the refresh names its organisation in the WHERE clause of its own write.
 * Neither does anything for a machine that already has one, and nothing runs on deploy to look. Such an
 * instance keeps syncing, off the token, into whichever ledger the token belongs to — which is the
 * o3d-t74p incident exactly: not a consent going wrong, but days of ordinary syncs off a binding nobody
 * had checked.
 *
 * The state is reachable without any race at all: every connection made under a build predating round 3,
 * a database restored here from another environment, a settings table and an accounting_tokens table
 * restored from different backups.
 */

test('an instance that ALREADY has a pin and a token for different organisations stops syncing', async () => {
  splitBinding('halts-the-sync')
  const { getAccessToken } = await loadAuth()

  assert.equal(await getAccessToken(), null, 'no token is handed out')
  assert.deepEqual(fetchedUrls, [], 'and nothing was asked of Xero')
})

test('a mismatch on an EXPIRED token is refused before the refresh, not after it', async () => {
  // The refusal claims "No Xero request was made", and an expired token is where that claim earns its
  // keep: the refresh path would otherwise present the live organisation's credentials to Xero and
  // store what came back, extending the very binding that is in question.
  splitBinding('expired-token')
  tokenRow!.expiresAt = new Date(Date.now() - 1000)
  const before = { ...tokenRow! }
  const { getAccessToken } = await loadAuth()

  assert.equal(await getAccessToken(), null)
  assert.deepEqual(fetchedUrls, [], 'the identity endpoint was never called')
  assert.deepEqual({ ...tokenRow! }, before, 'and the row was not touched')
})

test('the refusal names BOTH organisations, and where the posting actually went', async () => {
  const { pin, token } = splitBinding('names-both')
  const { getAccessToken } = await loadAuth()

  await getAccessToken()

  const refusal = activity.find((e) => e.action === 'xero_stored_tenant_refused')
  assert.ok(refusal, 'the refusal is on the record, not only on somebody\'s screen')
  assert.match(refusal.description, /bound to two different Xero organisations at once/)
  assert.match(refusal.description, new RegExp(pin.tenantId), 'the pin')
  assert.match(refusal.description, /OneTwo3D Ltd/, 'the token\'s organisation, by name')
  assert.match(refusal.description, new RegExp(token.tenantId), 'and by id')
  assert.match(refusal.description, /everything it wrote went to the token's organisation/)
  assert.match(refusal.description, /press Disconnect/)
  assert.equal(notifications.length, 1, 'and the operator is told once, not once per sync tick')
})

test('a split binding reports NOT connected, with the reason and a Disconnect button', async () => {
  // The remedy is "press Disconnect on /sync", and /sync only draws that button when there is something
  // to disconnect. A plain `connected: false` would hide it and make the remedy unperformable.
  splitBinding('not-connected')
  const { isConnected, getStoredTenantBlockReason } = await loadAuth()

  const status = await isConnected()

  assert.equal(status.connected, false)
  assert.equal(status.hasStoredToken, true)
  assert.match(status.blockedReason ?? '', /two different Xero organisations/)
  assert.equal(notifications.length, 0, 'isConnected runs on every render and must not notify')
  assert.match(await getStoredTenantBlockReason() ?? '', /two different Xero organisations/,
    'and the reason travels with the api layer\'s failure too')
})

test('the remedy WORKS: disconnect clears both halves and the reconnect binds one organisation', async () => {
  // A refusal is only as good as the instruction attached to it. This runs the instruction.
  const { pin } = splitBinding('remedy-works')
  const { getAccessToken, disconnect, exchangeCodeForTokens } = await loadAuth()
  assert.equal(await getAccessToken(), null, 'halted to begin with')

  await disconnect()
  const afterDisconnect = tokenRow
  assert.equal(afterDisconnect, null, 'the token is gone')
  assert.equal(settings.xero_expected_tenant_id, undefined, 'and so is the pin — neither half survives')
  assert.deepEqual(clearedIdColumns.sort(), ['customer', 'product', 'supplier'])

  reconsentTo(pin, 'c2')
  const reconnected = await exchangeCodeForTokens('c2', 'https://ims.example/cb')

  assert.equal(reconnected.success, true)
  assert.equal(tokenRow?.tenantId, pin.tenantId)
  assert.equal(settings.xero_expected_tenant_id, pin.tenantId, 'one organisation, named twice')
  assert.equal((await getAccessToken())?.tenantId, pin.tenantId, 'and the sync runs again')
})

/**
 * AN ABSENT PIN IS NOT A LICENCE (o3d-9tbz r6).
 *
 * r5 exempted a token with no pin beside it, deliberately: that is what every pre-pin connection looks
 * like and what `--clear-tenant-pin` produces. But the exemption was reachable by DELETING something.
 * `DELETE FROM settings WHERE key = 'xero_expected_tenant_id'` switched the split-binding refusal off,
 * and restoring `settings` and `accounting_tokens` from different backups arrives in the same state
 * without anybody deleting anything — which is the scenario the refusal exists for, so it was absent
 * precisely when it was needed.
 *
 * The token row can tell the two apart, because IMS wrote both halves of it: a `connectionGeneration`
 * was minted by the binding transaction that also wrote the pin, and `disconnect()` deletes the token
 * and the pin together. A deletion in `settings` cannot forge a value in `accounting_tokens`.
 */

test('a token whose PIN WAS DELETED stops syncing — an absent pin is not a licence', async () => {
  const demo = { ...DEMO, tenantId: '5c949ed5-demo-pin-deleted' }
  pinDeleted(demo)
  const { getAccessToken } = await loadAuth()

  assert.equal(await getAccessToken(), null, 'no token is handed out')
  assert.deepEqual(fetchedUrls, [], 'and nothing was asked of Xero')

  const refusal = activity.find((e) => e.action === 'xero_stored_tenant_refused')
  assert.ok(refusal, 'the refusal is on the record, not only on somebody\'s screen')
  assert.match(refusal.description, /has lost its pin/)
  assert.match(refusal.description, new RegExp(demo.tenantId), 'the organisation the token belongs to')
  assert.match(refusal.description, /press Disconnect/)
  assert.match(refusal.description, /--clear-tenant-pin/, 'and the supported way to be unpinned')
  assert.equal(notifications.length, 1, 'the operator is told once, not once per sync tick')
})

test('a deleted pin on an EXPIRED token is refused before the refresh, not after it', async () => {
  // The claim "No Xero request was made" earns its keep here: the refresh path would otherwise present
  // an unverifiable connection's credentials to Xero and store what came back.
  const demo = { ...DEMO, tenantId: '5c949ed5-demo-pin-deleted-expired' }
  pinDeleted(demo)
  tokenRow!.expiresAt = new Date(Date.now() - 1000)
  const before = { ...tokenRow! }
  const { getAccessToken } = await loadAuth()

  assert.equal(await getAccessToken(), null)
  assert.deepEqual(fetchedUrls, [], 'the identity endpoint was never called')
  assert.deepEqual({ ...tokenRow! }, before, 'and the row was not touched')
})

test('a deleted pin reports NOT connected, with a Disconnect button to press', async () => {
  const demo = { ...DEMO, tenantId: '5c949ed5-demo-pin-deleted-status' }
  pinDeleted(demo)
  const { isConnected, getStoredTenantBlockReason } = await loadAuth()

  const status = await isConnected()

  assert.equal(status.connected, false)
  assert.equal(status.hasStoredToken, true, 'or the remedy would be a button that is not drawn')
  assert.match(status.blockedReason ?? '', /has lost its pin/)
  assert.equal(notifications.length, 0, 'isConnected runs on every render and must not notify')
  assert.match(await getStoredTenantBlockReason() ?? '', /has lost its pin/)
})

test('the deleted-pin remedy WORKS: disconnect, then connect, and the sync runs again', async () => {
  // A refusal is only as good as the instruction attached to it. This runs the instruction.
  const demo = { ...DEMO, tenantId: '5c949ed5-demo-pin-deleted-remedy' }
  pinDeleted(demo)
  const { getAccessToken, disconnect, exchangeCodeForTokens } = await loadAuth()
  assert.equal(await getAccessToken(), null, 'halted to begin with')

  await disconnect()
  reconsentTo(demo, 'c2')
  assert.equal((await exchangeCodeForTokens('c2', 'https://ims.example/cb')).success, true)

  assert.equal(settings.xero_expected_tenant_id, demo.tenantId, 'the pin is back')
  assert.equal((await getAccessToken())?.tenantId, demo.tenantId, 'and the halt lifts')
})

test('a genuine FIRST connection is untouched — there is no token row to have lost a pin', async () => {
  // The state that must never be refused: nothing stored at all. This is also the o3d-t74p rig's state.
  freshDatabase()
  const { isConnected, getStoredTenantBlockReason, exchangeCodeForTokens } = await loadAuth()

  assert.equal((await isConnected()).connected, false)
  assert.equal((await isConnected()).blockedReason, undefined, 'not connected is not "blocked"')
  assert.equal(await getStoredTenantBlockReason(), null)

  connectionsBody = [DEMO]
  assert.equal((await exchangeCodeForTokens('code-1', 'https://ims.example/cb')).success, true)
  assert.equal(settings.xero_expected_tenant_id, DEMO.tenantId, 'and it pins itself on the way in')
  assert.equal(tokenRow?.pinReleasedAt, null, 'with no release outstanding')
})

test('a connection RELEASED by the documented recovery keeps syncing', async () => {
  // --clear-tenant-pin deletes the pin and stamps the token row in ONE transaction. That receipt is the
  // difference between a deliberate release and a deletion, and it is what keeps the runbook working.
  const demo = { ...DEMO, tenantId: '5c949ed5-demo-released' }
  releasedPin(demo)
  const { getAccessToken, isConnected } = await loadAuth()

  assert.equal((await getAccessToken())?.tenantId, demo.tenantId)
  assert.equal((await isConnected()).connected, true)
  assert.equal(activity.length, 0, 'and it is not an event worth recording')
})

test('a connection from before the binding marker keeps working with no pin', async () => {
  // Every installation connected before that column shipped is in this state. A deploy that halted them
  // all would be a far larger outage than the one being prevented, and it would be caused by the fix.
  const demo = { ...DEMO, tenantId: '5c949ed5-demo-legacy-unpinned' }
  unpinnedLegacyRow(demo)
  const { getAccessToken, isConnected } = await loadAuth()

  assert.equal((await getAccessToken())?.tenantId, demo.tenantId)
  assert.equal((await isConnected()).connected, true)
  assert.equal(activity.length, 0)
})

test('THE DEMO-RESET RECOVERY, end to end: release, re-consent to the NEW tenantId, sync', async () => {
  // Xero re-creates the Demo company with a NEW tenantId every ~28 days, which is why --clear-tenant-pin
  // exists at all. The consent must therefore be free to land on an organisation the stored token has
  // never seen — so the release has to silence the "fall back to the token's own tenantId" rule as well
  // as the pin itself, or the reconnect is refused as pinned-not-offered and the runbook cannot be
  // completed by anybody following it exactly.
  const retired = { ...DEMO, tenantId: '5c949ed5-demo-retired-cycle' }
  const rebuilt = { ...DEMO, tenantId: '5c949ed5-demo-rebuilt-cycle' }
  releasedPin(retired)
  const { getAccessToken, exchangeCodeForTokens, isConnected } = await loadAuth()
  assert.equal((await isConnected()).connected, true, 'released, not halted, while it waits')
  assert.ok(settings.xero_pin_release_witness, 'and the release is recorded in BOTH tables (r8)')

  reconsentTo(rebuilt, 'c2')
  const result = await exchangeCodeForTokens('c2', 'https://ims.example/cb')

  assert.equal(result.success, true, 'the re-consent is accepted')
  assert.equal(tokenRow?.tenantId, rebuilt.tenantId, 'the token now belongs to the rebuilt organisation')
  assert.equal(settings.xero_expected_tenant_id, rebuilt.tenantId, 'and the pin is re-established')
  assert.equal(tokenRow?.pinReleasedAt, null, 'the release ends at the connect that answers it')
  assert.equal(tokenRow?.pinReleasedGeneration, null, 'and so does the receipt that qualified it (r7)')
  assert.equal(tokenRow?.pinReleasedTenantId, null,
    'the whole receipt goes, not just its timestamp — a half-cleared one would be paperwork for a '
    + 'connection that no longer exists')
  assert.equal(settings.xero_pin_release_witness, undefined,
    'and so does the half in settings — both halves are written together and cleared together (r8)')
  assert.equal((await getAccessToken())?.tenantId, rebuilt.tenantId)
})

test('a released connection still refuses to guess between two organisations', async () => {
  // A release says "I am waiting to be told which organisation I belong to". It does not say "take the
  // first one offered" — that line is what put 150 invoices in the live ledger.
  releasedPin({ ...DEMO, tenantId: '5c949ed5-demo-released-ambiguous' })
  const { exchangeCodeForTokens } = await loadAuth()

  connectionsByCode = { c2: [LIVE, DEMO] }
  accessTokenByCode = { c2: 'access-c2' }
  const result = await exchangeCodeForTokens('c2', 'https://ims.example/cb')

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /will not guess which ledger to invoice into/)
})

test('an ordinary REFRESH on a released connection carries the release forward', async () => {
  // Otherwise the halt re-arms itself about half an hour after an operator performed the documented
  // recovery correctly — an outage manufactured by the guard, aimed at somebody who did the right thing.
  const demo = { ...DEMO, tenantId: '5c949ed5-demo-released-refresh' }
  releasedPin(demo)
  const released = tokenRow!.pinReleasedAt
  tokenRow!.expiresAt = new Date(Date.now() - 1000)
  const { getAccessToken } = await loadAuth()

  assert.equal((await getAccessToken())?.accessToken, 'access-1', 'the refresh lands')
  assert.deepEqual(tokenRow?.pinReleasedAt, released, 'and the row is still released')

  tokenRow!.expiresAt = new Date(Date.now() - 1000)
  assert.equal((await getAccessToken())?.accessToken, 'access-1', 'and again at the next expiry')
  assert.equal(activity.length, 0, 'no halt, no discarded refresh, nothing to explain')
})

test('a refresh in flight across a RELEASE cannot un-release the connection', async () => {
  // The refresh read the row before --clear-tenant-pin ran and would write its own "not released" back
  // over it — re-arming the halt from behind the operator. The release is in the write-time predicate
  // for that reason, so the stale write matches nothing.
  const demo = { ...DEMO, tenantId: '5c949ed5-demo-release-race' }
  dueForRefresh(demo)
  const { getAccessToken, isConnected } = await loadAuth()

  const refreshHeld = latch()
  refreshGrantGate = refreshHeld.wait
  const refreshing = getAccessToken()
  await refreshHeld.reached

  // --clear-tenant-pin, mid-flight: one transaction, the pin and the whole receipt.
  delete settings.xero_expected_tenant_id
  stampReleaseReceipt(demo.tenantId, new Date('2026-08-19T10:00:00.000Z'))

  refreshHeld.release()

  assert.equal(await refreshing, null, 'the stale write is discarded')
  assert.notEqual(tokenRow?.pinReleasedAt, null, 'the release survives it')
  assert.equal(tokenRow?.accessToken, 'stored-access', 'and the row was not written at all')
  assert.equal((await isConnected()).connected, true, 'so the recovery is not halted by its own refresh')
  assert.ok(activity.some((e) => e.action === 'xero_refresh_discarded'), 'the blip is explainable')
  assert.equal(notifications.length, 0, 'and it is not an incident to alarm anybody with')
})

/**
 * A RELEASE RECEIPT CANNOT OUTLIVE WHAT IT RELEASED (o3d-9tbz r7).
 *
 * r6 made the release a receipt on the token row, which is what a deletion in another table cannot
 * forge. But the receipt recorded only THAT a release happened — never what it was for — so nothing
 * that happened to the row afterwards could invalidate it. Restore an accounting_tokens dump taken
 * while a release was outstanding and the exemption comes back with it, onto whatever binding is here
 * now, while the pin (in the other table) does not: the cross-backup restore r6 exists to catch,
 * arriving through the escape hatch r6 built.
 */

test('a receipt from a RESTORED dump does not exempt the connection it landed on', async () => {
  const demo = { ...DEMO, tenantId: '5c949ed5-demo-stale-receipt' }
  staleReleaseFromRestore(demo)
  const { getAccessToken, isConnected } = await loadAuth()

  assert.equal(await getAccessToken(), null, 'the sync is halted')
  assert.deepEqual(fetchedUrls, [], 'and no Xero request was made on the way to refusing')
  const status = await isConnected()
  assert.equal(status.connected, false)
  assert.equal(status.hasStoredToken, true, 'or /sync would not draw the Disconnect the remedy names')
  assert.match(status.blockedReason ?? '', /release receipt that does not describe it/)
})

test('the stale receipt is refused in ITS OWN words, and the remedy runs', async () => {
  const demo = { ...DEMO, tenantId: '5c949ed5-demo-stale-receipt-remedy' }
  staleReleaseFromRestore(demo)
  const { getStoredTenantBlockReason, disconnect, exchangeCodeForTokens, getAccessToken } = await loadAuth()

  const reason = await getStoredTenantBlockReason() ?? ''
  assert.match(reason, /generation-after-restore/, 'the connection this token belongs to')
  assert.match(reason, /generation-before/, 'and the one the receipt released')
  assert.match(reason, /press Disconnect/)
  assert.match(reason, /--clear-tenant-pin will not clear this/,
    'the next thing an operator would try, answered before they try it')

  // Run the instruction, exactly as written.
  await disconnect()
  reconsentTo(demo, 'c2')
  assert.equal((await exchangeCodeForTokens('c2', 'https://ims.example/cb')).success, true)
  assert.equal(tokenRow?.pinReleasedAt, null, 'the receipt is gone with the row it was stuck to')
  assert.equal((await getAccessToken())?.tenantId, demo.tenantId, 'and the sync runs again')
})

test('a stale receipt does not let the next consent name ANY organisation it likes', async () => {
  // A valid release suspends the "fall back to the token's own organisation" rule — that is what lets
  // the Demo-reset re-consent land on a tenantId this instance has never seen. The suspension is a
  // privilege, so it is granted on the same evidence the exemption is: a receipt that no longer
  // describes this row buys neither. Otherwise a restored dump would arrive not merely unhalted but
  // UNPINNED, free to bind whatever the next consent offered — which is the o3d-t74p incident.
  const demo = { ...DEMO, tenantId: '5c949ed5-demo-stale-receipt-consent' }
  const stranger = { ...LIVE, tenantId: 'e7fb4378-live-stranger' }
  staleReleaseFromRestore(demo)
  const { exchangeCodeForTokens, getAccessToken } = await loadAuth()

  reconsentTo(stranger, 'c2')
  const refused = await exchangeCodeForTokens('c2', 'https://ims.example/cb')

  assert.equal(refused.success, false, 'the consent to a stranger is refused')
  assert.equal(tokenRow?.tenantId, demo.tenantId, 'and nothing was rebound')

  // Re-consenting to the organisation the token names still repairs it, exactly as a lost pin does.
  reconsentTo(demo, 'c3')
  assert.equal((await exchangeCodeForTokens('c3', 'https://ims.example/cb')).success, true)
  assert.equal(settings.xero_expected_tenant_id, demo.tenantId, 'the pin is back')
  assert.equal(tokenRow?.pinReleasedAt, null, 'and the stale receipt is gone with it')
  assert.equal((await getAccessToken())?.tenantId, demo.tenantId)
})

test('releasing one half of a SPLIT binding does not end the split-binding refusal', async () => {
  // --clear-tenant-pin on an instance whose pin and token already named different organisations. The
  // pin is gone, so r5 has nothing left to compare — and under r6 the receipt exempted the row from the
  // missing-pin refusal as well, which made "delete one side of the contradiction" a way out of a
  // refusal about the contradiction.
  const pin = { ...DEMO, tenantId: '5c949ed5-demo-released-split' }
  const token = { ...LIVE, tenantId: 'e7fb4378-live-released-split' }
  releasedSplitBinding({ pin, token })
  const { getAccessToken, getStoredTenantBlockReason } = await loadAuth()

  assert.equal(await getAccessToken(), null, 'still halted')
  const reason = await getStoredTenantBlockReason() ?? ''
  assert.match(reason, new RegExp(pin.tenantId), 'the organisation whose pin was deleted')
  assert.match(reason, /OneTwo3D Ltd/, 'and the one the token actually belongs to')
})

/**
 * A RECEIPT CANNOT BE ITS OWN WITNESS (o3d-9tbz r8).
 *
 * r7 qualified the receipt with the connection it released and the pin it deleted — and put both on the
 * SAME ROW as the receipt. That closes the case where something removed the pin, because a deletion in
 * `settings` cannot write a value into `accounting_tokens`. It closes nothing at all in the case where
 * the token row itself arrives from elsewhere: a wholesale restore brings the receipt, the qualifiers,
 * the generation and the tenant together, so every comparison r7 makes is the dump against itself.
 *
 * And the receipts that predate r7 have no qualifiers to compare. They cannot be filled in from the row
 * either, because the pre-r7 recovery stamped one for a pin it never deleted — the laundering r7 found —
 * and on the row alone that is the same state as an honest outstanding release.
 */

test('a token row restored WHOLESALE mid-release is halted, not exempted', async () => {
  // The r8 finding. The row is internally perfect: the receipt names the generation the row carries and
  // the pin names the organisation the token belongs to. What it cannot produce is the half that never
  // left the instance that performed the release.
  const demo = { ...DEMO, tenantId: '5c949ed5-demo-restored-row' }
  restoredMidReleaseTokenRow(demo)
  const { getAccessToken, isConnected } = await loadAuth()

  assert.equal(await getAccessToken(), null, 'the sync is halted')
  assert.deepEqual(fetchedUrls, [], 'and no Xero request was made on the way to refusing')
  const status = await isConnected()
  assert.equal(status.connected, false)
  assert.equal(status.hasStoredToken, true, 'or /sync would not draw the Disconnect the remedy names')
  assert.match(status.blockedReason ?? '', /no record of writing/)
})

test('the same row WITH its witness is the legitimate recovery, and keeps syncing', async () => {
  // The control for the test above: identical token row, one settings row apart. If both were halted the
  // guard would simply have broken the runbook, and if neither were the finding would be unfixed.
  const demo = { ...DEMO, tenantId: '5c949ed5-demo-restored-control' }
  releasedPin(demo)
  const { getAccessToken, isConnected } = await loadAuth()

  assert.equal((await getAccessToken())?.tenantId, demo.tenantId)
  assert.equal((await isConnected()).connected, true)
  assert.equal(activity.length, 0, 'and it is not an event worth recording')
})

test('a restored released row does not get the unpinned privilege either', async () => {
  // A valid release suspends the "fall back to the token's own organisation" rule, which is what lets
  // the Demo re-consent land on a tenantId this instance has never seen. Granting that to a restored row
  // would leave it not merely unhalted but UNPINNED and free to bind whatever the next consent offered —
  // the o3d-t74p incident. The privilege is granted on exactly the evidence the exemption is.
  const demo = { ...DEMO, tenantId: '5c949ed5-demo-restored-consent' }
  const stranger = { ...LIVE, tenantId: 'e7fb4378-live-restored-stranger' }
  restoredMidReleaseTokenRow(demo)
  const { exchangeCodeForTokens, getAccessToken } = await loadAuth()

  reconsentTo(stranger, 'c2')
  assert.equal((await exchangeCodeForTokens('c2', 'https://ims.example/cb')).success, false)
  assert.equal(tokenRow?.tenantId, demo.tenantId, 'nothing was rebound')

  // And the remedy in the message runs: re-consent to the organisation the token names repairs it.
  reconsentTo(demo, 'c3')
  assert.equal((await exchangeCodeForTokens('c3', 'https://ims.example/cb')).success, true)
  assert.equal(settings.xero_expected_tenant_id, demo.tenantId, 'the pin is back')
  assert.equal(tokenRow?.pinReleasedAt, null, 'and the inherited receipt is gone with it')
  assert.equal((await getAccessToken())?.tenantId, demo.tenantId)
})

test('a pre-r7 receipt is halted rather than backfilled into an exemption', async () => {
  // The migration could have stamped this row's own generation and tenant into its receipt so that a rig
  // mid-recovery stayed exempt across the deploy. It must not: the old --clear-tenant-pin wrote this
  // exact row when it deleted no pin at all, so qualifying it re-legitimises the laundering r7 closed.
  const demo = { ...DEMO, tenantId: '5c949ed5-demo-unqualified-receipt' }
  legacyUnqualifiedRelease(demo)
  const { getAccessToken, isConnected, getStoredTenantBlockReason } = await loadAuth()

  assert.equal(await getAccessToken(), null, 'the sync is halted')
  assert.deepEqual(fetchedUrls, [], 'and no Xero request was made')
  assert.equal((await isConnected()).connected, false)
  const reason = await getStoredTenantBlockReason() ?? ''
  assert.match(reason, /but not WHAT was released/)
  assert.doesNotMatch(reason, /has lost its pin/, 'a different history from a pin that vanished')
})

test('the mid-recovery operator can finish with Disconnect and one consent', async () => {
  // The bounded cost of not backfilling, run end to end. It is the step the release was waiting for, and
  // the message says so; if it did not work, the honest default would be an unrecoverable instance.
  const retired = { ...DEMO, tenantId: '5c949ed5-demo-unqualified-retired' }
  const rebuilt = { ...DEMO, tenantId: '5c949ed5-demo-unqualified-rebuilt' }
  legacyUnqualifiedRelease(retired)
  const { disconnect, exchangeCodeForTokens, getAccessToken, getStoredTenantBlockReason } = await loadAuth()
  const reason = await getStoredTenantBlockReason() ?? ''
  assert.match(reason, /but not WHAT was released/, 'halted for the reason this round introduces...')
  assert.match(reason, /press Disconnect/, '...and told the step that ends it')

  await disconnect()
  assert.equal(tokenRow, null, 'both halves go')
  reconsentTo(rebuilt, 'c2')

  assert.equal((await exchangeCodeForTokens('c2', 'https://ims.example/cb')).success, true,
    'and the consent is free to land on the REBUILT organisation, which the retired pin never named')
  assert.equal(settings.xero_expected_tenant_id, rebuilt.tenantId)
  assert.equal((await getAccessToken())?.tenantId, rebuilt.tenantId)
})

test('Disconnect removes the release witness too', async () => {
  // A witness left behind is half a receipt waiting for a token row to corroborate, and the next restore
  // would supply one. Disconnect is the remedy every one of these refusals names, so it has to end the
  // whole state and not most of it.
  const demo = { ...DEMO, tenantId: '5c949ed5-demo-witness-disconnect' }
  releasedPin(demo)
  const { disconnect } = await loadAuth()

  await disconnect()

  assert.equal(settings.xero_pin_release_witness, undefined)
  assert.equal(settings.xero_expected_tenant_id, undefined)
  assert.equal(tokenRow, null)
})

test('a witness with no receipt on the token row is still a LOST pin', async () => {
  // The r6 bypass, re-tried with the r8 machinery: deleting the pin and writing a witness beside it does
  // not exempt anything, because the exemption needs BOTH halves. The witness only ever narrows.
  const demo = { ...DEMO, tenantId: '5c949ed5-demo-witness-only' }
  pinDeleted(demo)
  settings.xero_pin_release_witness = JSON.stringify({ generation: 'generation-before', tenantId: demo.tenantId })
  const { getAccessToken, getStoredTenantBlockReason } = await loadAuth()

  assert.equal(await getAccessToken(), null)
  assert.match(await getStoredTenantBlockReason() ?? '', /has lost its pin/)
})

/**
 * THE OTHER WRITER OF BOTH HALVES: `resetDatabase('full')` (o3d-9tbz r7, finding 2).
 *
 * The missing-pin halt reads a token row carrying a connection generation, with no pin beside it, as
 * evidence that something removed the pin on its own. That is only sound while every writer moves the
 * two halves together — and the full reset did not: it deleted `accounting_tokens` six statements
 * before it deleted `settings`, outside the transaction. A consent committing in between wrote a whole
 * binding and then had its pin wiped, leaving the tamper state on an instance where nobody had tampered
 * with anything.
 *
 * A reset is not told apart from tampering by a marker — the tamper case can carry a marker too. It is
 * told apart by leaving NO TOKEN ROW, so the halt has nothing to ask about; and by ordering the two
 * deletes so that no interleaving can leave the dangerous half.
 */

const RESET_CODE = '123456'

test('a full reset removes BOTH halves, so the halt has nothing to ask about', async () => {
  pinnedTo({ ...DEMO, tenantId: '5c949ed5-demo-reset-clean' })
  const { getStoredTenantBlockReason } = await loadAuth()
  const { resetDatabase } = await import('@/app/actions/reset')

  const outcome = await resetDatabase('full', RESET_CODE)
  assert.equal(outcome.success, true, outcome.error)

  assert.equal(tokenRow, null, 'no token row')
  assert.equal(settings.xero_expected_tenant_id, undefined, 'and no pin')
  assert.equal(await getStoredTenantBlockReason(), null, 'so nothing to halt')
})

test('a reset that DIES part-way leaves the binding whole, not half of one', async () => {
  // Both deletes in one transaction, so a failure rolls back to a coherent instance. With them apart
  // the token was already gone when the settings wipe failed, and the operator was left holding a pin
  // for a connection that no longer existed.
  const demo = { ...DEMO, tenantId: '5c949ed5-demo-reset-failed' }
  pinnedTo(demo)
  settingsWipeFails = true
  const { resetDatabase } = await import('@/app/actions/reset')

  const result = await resetDatabase('full', RESET_CODE)

  assert.equal(result.success, false, 'the reset reports the failure')
  assert.equal(tokenRow?.tenantId, demo.tenantId, 'and the token row is still here')
  assert.equal(settings.xero_expected_tenant_id, demo.tenantId, 'beside the pin it was bound with')
})

test('A CONSENT COMMITTING MID-RESET is never left as a token whose pin was wiped', async () => {
  // The two legitimate operations that produced the tamper state between them. The consent lands in the
  // window between the reset's two binding deletes — the only place it can do any harm — and both
  // finish. Whatever survives, the two halves must agree.
  const demo = { ...DEMO, tenantId: '5c949ed5-demo-reset-race' }
  pinnedTo(demo)
  const { exchangeCodeForTokens, getStoredTenantBlockReason, isConnected } = await loadAuth()
  const { resetDatabase } = await import('@/app/actions/reset')

  const held = latch()
  resetTokenDeleteGate = held.wait
  const resetting = resetDatabase('full', RESET_CODE)
  await held.reached

  // A human finishes connecting Xero, right now, while the reset is mid-flight.
  reconsentTo(demo, 'c2')
  const consent = await exchangeCodeForTokens('c2', 'https://ims.example/cb')
  assert.equal(consent.success, true, 'the consent itself succeeds — it did nothing wrong')

  held.release()
  assert.equal((await resetting).success, true)

  assert.equal(
    await getStoredTenantBlockReason(), null,
    'the reset must not manufacture the tamper halt on an instance nobody tampered with',
  )
  const pinned = settings.xero_expected_tenant_id
  assert.ok(
    (tokenRow === null && pinned === undefined) || (tokenRow !== null && pinned === tokenRow.tenantId),
    `the two halves must agree: token=${tokenRow?.tenantId ?? 'none'} pin=${pinned ?? 'none'}`,
  )
  assert.equal((await isConnected()).blockedReason, undefined, 'and nothing is blocked')
})

test('an ordinary pinned instance is unaffected — pin and token name one organisation', async () => {
  pinnedTo({ ...DEMO, tenantId: '5c949ed5-demo-ordinary-pinned' })
  const { getAccessToken, isConnected } = await loadAuth()

  assert.equal((await getAccessToken())?.accessToken, 'stored-access')
  assert.equal((await isConnected()).connected, true)
  assert.equal(notifications.length, 0)
})

test('a re-consent to the PINNED organisation is still allowed to repair a split instance', async () => {
  // The blunt remedy is disconnect-then-reconnect, and it is what the message says. But an operator who
  // simply reconnects to the organisation their pin already names must not be refused for doing the
  // right thing: that consent ends with both halves naming one organisation, which is the whole point.
  const { pin } = splitBinding('reconsent-repairs')
  const { getAccessToken, exchangeCodeForTokens } = await loadAuth()

  reconsentTo(pin, 'c2')
  const result = await exchangeCodeForTokens('c2', 'https://ims.example/cb')

  assert.equal(result.success, true)
  assert.equal(tokenRow?.tenantId, pin.tenantId)
  assert.equal(settings.xero_expected_tenant_id, pin.tenantId)
  assert.equal((await getAccessToken())?.tenantId, pin.tenantId, 'and the halt lifts')
})

/**
 * TWO GENERATIONS OF ONE ORGANISATION (o3d-9tbz r5 finding 2).
 *
 * Round 4 put the ORGANISATION in the WHERE clause of the refresh. That distinguishes organisation A
 * from organisation B and nothing else — and the operation this rig performs most often is not a switch
 * between organisations, it is a disconnect and reconnect to the SAME one, because Xero re-creates the
 * Demo company with a new tenantId roughly every 28 days and somebody reconnects by hand. A re-consent
 * without a disconnect — the usual way to widen a granted scope — is the same event again.
 *
 * A refresh in flight across either of those matches `connector + tenantId` perfectly, and writes: the
 * new connection's tokens are replaced by a retired chain, `grantedScopes` reverts to the grant that was
 * just widened, and `tenantIsDemo` reverts — which under XERO_REQUIRE_DEMO_ORG turns a verified
 * connection back into an unverified one and halts every sync.
 */

test('a refresh that lands after a DISCONNECT AND RECONNECT to the SAME organisation is discarded', async () => {
  const demo = { ...DEMO, tenantId: '5c949ed5-demo-two-generations' }
  dueForRefresh(demo)
  const { getAccessToken, disconnect, exchangeCodeForTokens } = await loadAuth()
  const retired = { id: tokenRow!.id, generation: tokenRow!.connectionGeneration }

  const refreshHeld = latch()
  refreshGrantGate = refreshHeld.wait
  const refreshing = getAccessToken()
  await refreshHeld.reached

  await disconnect()
  reconsentTo(demo, 'c2')
  assert.equal((await exchangeCodeForTokens('c2', 'https://ims.example/cb')).success, true)
  assert.notEqual(tokenRow!.id, retired.id, 'a deleted row comes back with a new primary key')
  assert.notEqual(tokenRow!.connectionGeneration, retired.generation, 'and a new generation')

  refreshHeld.release()

  assert.equal(await refreshing, null, 'the retired generation yields no usable token')
  assert.equal(tokenRow?.accessToken, 'access-c2', 'the new connection still owns the row')
  assert.equal(tokenRow?.tenantId, demo.tenantId, 'one organisation throughout — that is the point')
  assert.ok(activity.some((e) => e.action === 'xero_refresh_discarded'), 'the blip is explainable')
  assert.equal(notifications.length, 0, 'and it is not an incident to alarm anybody with')
})

test('a refresh that lands after an IN-PLACE re-consent is discarded, though the row never moved', async () => {
  // The case the primary key cannot see. No disconnect, so the binding takes the update path: same
  // organisation, same pin, SAME ROW. Only the generation changed, and only because a consent mints one.
  const demo = { ...DEMO, tenantId: '5c949ed5-demo-reconsent-in-place' }
  dueForRefresh(demo)
  const { getAccessToken, exchangeCodeForTokens } = await loadAuth()
  const retired = { id: tokenRow!.id, generation: tokenRow!.connectionGeneration }

  const refreshHeld = latch()
  refreshGrantGate = refreshHeld.wait
  const refreshing = getAccessToken()
  await refreshHeld.reached

  reconsentTo(demo, 'c2')
  assert.equal((await exchangeCodeForTokens('c2', 'https://ims.example/cb')).success, true)
  assert.equal(tokenRow!.id, retired.id, 'the row was updated in place: its id cannot tell the two apart')
  assert.notEqual(tokenRow!.connectionGeneration, retired.generation, 'the generation can')

  refreshHeld.release()

  assert.equal(await refreshing, null)
  assert.equal(tokenRow?.accessToken, 'access-c2', 'the consent the operator just gave still owns the row')
  assert.ok(activity.some((e) => e.action === 'xero_refresh_discarded'))
})

test('the stale generation cannot revert the scopes or the demo proof the re-consent just recorded', async () => {
  // Why a "same organisation, both tokens valid" overwrite is not harmless. The retired row was recorded
  // before XERO_REQUIRE_DEMO_ORG had any evidence and with a narrower grant; letting it land would put
  // both back, and under that key an unverified connection is an outage roughly every 30 minutes.
  const demo = { ...DEMO, tenantId: '5c949ed5-demo-grant-widened' }
  dueForRefresh(demo)
  tokenRow!.grantedScopes = 'accounting.transactions'
  tokenRow!.tenantIsDemo = null
  organisationBody = { Organisations: [{ BaseCurrency: 'GBP', IsDemoCompany: true }] }
  const { getAccessToken, exchangeCodeForTokens } = await loadAuth()

  const refreshHeld = latch()
  refreshGrantGate = refreshHeld.wait
  const refreshing = getAccessToken()
  await refreshHeld.reached

  reconsentTo(demo, 'c2')
  assert.equal((await exchangeCodeForTokens('c2', 'https://ims.example/cb')).success, true)

  refreshHeld.release()
  assert.equal(await refreshing, null)

  assert.equal(tokenRow?.grantedScopes, 'accounting.transactions accounting.contacts', 'the widened grant stands')
  assert.equal(tokenRow?.tenantIsDemo, true, 'and the demo proof the consent read from Xero')
})

test('a row written before the generation column existed still refreshes', async () => {
  // Every connected installation is in this state on the deploy that adds the column. A predicate that
  // treated a null generation as "no longer matches" would be an outage at the next token expiry —
  // roughly half an hour — everywhere at once.
  const demo = { ...DEMO, tenantId: '5c949ed5-demo-legacy-row' }
  dueForRefresh(demo)
  tokenRow!.connectionGeneration = null
  const { getAccessToken } = await loadAuth()

  const result = await getAccessToken()

  assert.equal(result?.accessToken, 'access-1')
  assert.equal(tokenRow?.accessToken, 'access-1', 'the row carries the refreshed token')
  assert.equal(tokenRow?.connectionGeneration, null, 'and a refresh does not pretend to be a new consent')
  assert.equal(activity.filter((e) => e.action === 'xero_refresh_discarded').length, 0)
})

test('a refresh carries its generation forward, so the NEXT refresh still matches', async () => {
  // A refresh that minted a generation would make every refresh look like a rebinding to the one behind
  // it, and re-open this hole from the other side — as a permanent outage rather than a race.
  const demo = { ...DEMO, tenantId: '5c949ed5-demo-consecutive-refreshes' }
  dueForRefresh(demo)
  const { getAccessToken } = await loadAuth()

  assert.equal((await getAccessToken())?.accessToken, 'access-1')
  assert.equal(tokenRow?.connectionGeneration, 'generation-before')

  tokenRow!.expiresAt = new Date(Date.now() - 1000)
  assert.equal((await getAccessToken())?.accessToken, 'access-1', 'and again')
  assert.equal(activity.filter((e) => e.action === 'xero_refresh_discarded').length, 0)
})


// --- o3d-iaqy, end to end: a non-production instance with nothing configured ----------------------
//
// o3d-9tbz enforced the allow-list at BOTH points o3d-iaqy asked for — the callback and every use of
// the stored token — but left the third requirement open: "fail CLOSED when the config is absent on a
// non-production instance. A missing allowlist must not read as 'anything is allowed' — that is
// precisely the state that produced o3d-t74p." These are that state, driven through the real callback
// and the real getAccessToken.

test('o3d-iaqy: the e2e rig connecting to the LIVE organisation is refused, and NOTHING is stored', async () => {
  // The incident, with the rig's own environment: a production build (NODE_ENV=production), the e2e
  // flag set, nothing else. Under o3d-9tbz alone this single-organisation consent succeeded — the case
  // deliberately left working — and bound the rig to the live ledger.
  nonProductionInstance('e2e-flag')
  freshDatabase()
  connectionsBody = [LIVE]
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('code-1', 'https://ims.example/api/accounting/callback')

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /not marked as production and has no Xero tenant control set/)
  assert.equal(tokenRow, null, 'no token row was written')
  assert.equal(settings.xero_expected_tenant_id, undefined, 'no tenant was pinned')
  assert.equal(organisationCalls, 0, 'and not one read was made against the organisation')
  assert.ok(activity.some((entry) => entry.action === 'xero_connect_refused'), 'the refusal is recorded')
})

test('o3d-iaqy: an unguarded dev instance is refused the same way', async () => {
  nonProductionInstance('node-env')
  freshDatabase()
  connectionsBody = [DEMO]
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('code-1', 'https://ims.example/api/accounting/callback')

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /not marked as production and has no Xero tenant control set/)
  assert.equal(tokenRow, null)
})

test('o3d-iaqy: a LIVE token restored onto a dev box stops syncing, with no callback in sight', async () => {
  // The route the callback check cannot see at all: a production dump on a laptop. The token is already
  // in the database, already pinned, and agrees with itself perfectly.
  nonProductionInstance('node-env')
  pinnedTo(LIVE)
  const { getAccessToken, getStoredTenantBlockReason } = await loadAuth()

  assert.equal(await getAccessToken(), null, 'no token is handed out')
  assert.match(await getStoredTenantBlockReason() ?? '', /not marked as production and has no Xero tenant control set/)
  assert.equal(notifications.length, 1, 'and the operator is told once, not once per sync tick')
})

test('o3d-iaqy: naming the ledger is enough — the configured rig connects and syncs as before', async () => {
  // The remedy, performed. Everything o3d-9tbz decided still decides.
  nonProductionInstance('e2e-flag')
  process.env.XERO_ALLOWED_TENANT_IDS = DEMO.tenantId
  freshDatabase()
  connectionsBody = [LIVE, DEMO]
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('code-1', 'https://ims.example/api/accounting/callback')

  assert.equal(result.success, true)
  assert.equal(tokenRow?.tenantId, DEMO.tenantId, 'and it is Demo, not the organisation listed first')
  assert.equal(settings.xero_expected_tenant_id, DEMO.tenantId)
})

test('o3d-iaqy: XERO_REQUIRE_DEMO_ORG alone satisfies it — the rotation-proof answer', async () => {
  // The rig's real problem is that Demo's tenantId is re-issued every ~28 days, so an id list has to be
  // re-edited every cycle and a control that is annoying enough gets switched off. This one needs no
  // editing, and it is an identity anchor, so it clears the o3d-iaqy refusal too.
  nonProductionInstance('e2e-flag')
  process.env.XERO_REQUIRE_DEMO_ORG = 'true'
  freshDatabase()
  connectionsBody = [DEMO]
  organisationBody = { Organisations: [{ BaseCurrency: 'GBP', Name: 'Demo Company (UK)', IsDemoCompany: true }] }
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('code-1', 'https://ims.example/api/accounting/callback')

  assert.equal(result.success, true)
  assert.equal(tokenRow?.tenantId, DEMO.tenantId)
})

test('o3d-iaqy: PRODUCTION with nothing configured is completely unaffected', async () => {
  // The case that outranks the fix. Production legitimately runs with no allow-list — it is the
  // organisation every other instance is being kept away from — so nothing about it may change.
  freshDatabase()
  connectionsBody = [LIVE]
  const { exchangeCodeForTokens, getAccessToken } = await loadAuth()

  const result = await exchangeCodeForTokens('code-1', 'https://ims.example/api/accounting/callback')
  assert.equal(result.success, true)
  assert.equal(tokenRow?.tenantId, LIVE.tenantId)

  const auth = await getAccessToken()
  assert.equal(auth?.tenantId, LIVE.tenantId)
  assert.equal(notifications.length, 0)
})

/**
 * THE ACQUISITION ORDER IS READ OUT OF THE SOURCE (o3d-2w2j).
 *
 * A lock-ordering inversion is not a behaviour. It is which row each writer touches FIRST, and the
 * deadlock it causes only happens when two of them interleave on a real Postgres — so there is nothing
 * for the doubles above to observe. Worse, they would happily model either order: the database double
 * applies an array transaction statement by statement and never blocks, so `disconnect()` passed
 * identically before and after the fix. A test that asserted behaviour here would be a test that cannot
 * fail, which is the exact defect class this branch spent its time on.
 *
 * So this reads the order out of `auth.ts` and compares the two writers of both halves of a binding
 * against each other. COMMENTS ARE STRIPPED FIRST, deliberately: the file is dense with prose that names
 * these rows in every order there is ("the pin is therefore INSERTed first", "token row and the pin go
 * together"), and a guard that matched documentation instead of code has produced false positives here
 * twice already. Only real `tx.`/`db.` write calls are counted, and only the classified ones — an
 * unrecognised settings write fails the test by name rather than being silently skipped, because a
 * fourth row joining the transaction is precisely the change this should be re-read for.
 */
function xeroAuthSource(): string {
  const raw = readFileSync(new URL('../../lib/connectors/xero/auth.ts', import.meta.url), 'utf8')
  return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** The body of a named function, brace-matched out of already-comment-stripped code. */
function functionBody(code: string, signature: string): string {
  const start = code.indexOf(signature)
  assert.notEqual(start, -1, `${signature} is no longer in lib/connectors/xero/auth.ts`)
  // The body brace, not the first one after the signature: these return types carry braces of their own
  // (`Promise<{ ok: true } | { ok: false }>`), and only the body's opens a line.
  const afterParams = code.indexOf(')', start)
  const open = afterParams + code.slice(afterParams).search(/\{[ \t]*\r?\n/)
  let depth = 0
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++
    else if (code[i] === '}' && --depth === 0) return code.slice(open, i + 1)
  }
  throw new Error(`unbalanced braces after ${signature}`)
}

/**
 * The binding rows this function locks, in the order it locks them.
 *
 * Reads only, and `findUnique` in particular, are NOT counted: they take no row lock, so they cannot
 * take part in an inversion. Consecutive touches of the same row collapse — the two pin branches of
 * `bindXeroTenant` (update on the re-consent path, create on the fresh one) are one acquisition, and
 * only one of them ever runs.
 */
function bindingRowAcquisitions(body: string): string[] {
  const call = /\b(?:tx|db)\.(setting|accountingToken)\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\(/g
  const order: string[] = []
  for (let m = call.exec(body); m; m = call.exec(body)) {
    const statement = body.slice(m.index, body.indexOf('\n', m.index) === -1 ? undefined : body.indexOf('\n', m.index))
    let row: string
    if (m[1] === 'accountingToken') row = 'token'
    else if (statement.includes('XERO_EXPECTED_TENANT_KEY')) row = 'pin'
    else if (statement.includes('XERO_PIN_RELEASE_WITNESS_KEY')) row = 'witness'
    else row = `UNCLASSIFIED settings write: ${statement.trim()}`
    if (order[order.length - 1] !== row) order.push(row)
  }
  return order
}

test('disconnect acquires the binding rows in the PIN WRITERS order, not the reverse', () => {
  const code = xeroAuthSource()
  const bind = bindingRowAcquisitions(functionBody(code, 'async function bindXeroTenant'))
  const disconnect = bindingRowAcquisitions(functionBody(code, 'export async function disconnect'))

  // Stated rather than derived from `bind`, so that reversing BOTH writers together still fails.
  assert.deepEqual(bind, ['pin', 'token', 'witness'],
    'the binding transaction takes the pin first — that is what makes the P2002 the arbiter')
  assert.deepEqual(disconnect, ['pin', 'token', 'witness'],
    'and disconnect must take them the same way round; token-then-pin is the inversion o3d-2w2j filed')
  assert.deepEqual(disconnect, bind, 'ONE canonical order, so no two writers can hold what the other needs next')
})

test('the OTHER writers of both halves take the pin first too', async () => {
  // The rule is only worth anything if it holds everywhere, and these two are the writers that can be
  // in flight against a consent: the full reset, and the raw-SQL pin establishment the provisioner and
  // the recovery script share. Comments stripped here for the same reason as above — reset.ts argues
  // about this ordering at length in prose.
  const reset = readFileSync(new URL('../../app/actions/reset.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const wipe = reset.slice(reset.indexOf('lockIntegrationPluginSelection(tx)'))
  assert.ok(wipe.indexOf('tx.setting.deleteMany') < wipe.indexOf('tx.accountingToken.deleteMany'),
    'resetDatabase deletes the settings (the pin among them) before the token row')

  const { xeroPinEstablishmentStatements } = await import('@/lib/connectors/xero/tenant-guard')
  const statements = xeroPinEstablishmentStatements('5c949ed5-demo-order')
  assert.match(statements[0].text, /insert into settings/, 'pin first')
  assert.match(statements[1].text, /update accounting_tokens/, 'then the token row')
  assert.match(statements[2].text, /delete from settings/, 'then the witness')
})
