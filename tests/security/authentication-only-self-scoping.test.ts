import assert from 'node:assert/strict'
import path from 'node:path'
import test, { before, mock } from 'node:test'

import { createRecordingDb, type QueryContext } from './recording-db'
import {
  createRepoGraph,
  scanActionsDir,
  scanAuthenticationOnlyActions,
} from './server-action-guard-scan'

/**
 * o3d-512h round 4, Codex finding 4 — WHAT THE MODEL-SURFACE PIN CANNOT SAY.
 *
 * Round 3 answered "the inventory pins the gate but not the data" by pinning the
 * Prisma models each authentication-only endpoint reaches, and described that pin
 * as covering the supplier-isolation class. It does not, and no static pin can:
 *
 *   db.user.findUnique({ where: { id: session.user.id } })   // yours
 *   db.user.findUnique({ where: { id } })                    // anyone's
 *
 * reach the same model, through the same call, and differ only in the VALUE of a
 * `where` clause that may be assembled two modules away. Which tables an endpoint
 * touches is a static fact. Whether a row belongs to the caller is a runtime one.
 * A pin that claimed the second while measuring the first is the same defect this
 * branch has been chasing — crediting a property nobody verified — so the claim
 * is withdrawn where it was made (see reachedPrismaModels) and the property is
 * proved HERE, where it is decidable: by running each endpoint and looking at the
 * queries it actually issued.
 *
 * The inventory exists because `requireAuth` is accepted as sufficient for these
 * nine endpoints, on ONE argument: they are self-scoped to session.user.id, so an
 * external principal — a SUPPLIER, which is a third-party company we issue a
 * login to — reaches nothing but its own row. That argument is what is executed
 * below. Every endpoint is called AS A SUPPLIER, with foreign ids where it takes
 * one, and every query it issues must carry the caller's own user id.
 *
 * WHAT THIS PROVES, and what it does not:
 *   * proves — the caller's id was present as a constraint in the query that was
 *     actually sent, for every read this endpoint performed on this path;
 *   * does NOT prove that the constraint is conjunctive (a `where` with an `OR`
 *     would satisfy it), and does not reach paths this call did not take. It is a
 *     lower bound on scoping, observed rather than assumed — which is strictly
 *     more than a static pin can offer, and stated as a bound rather than sold as
 *     a guarantee.
 */

const CALLER_ID = 'u1'
const FOREIGN_PASSKEY_ID = 'pk-belonging-to-someone-else'
const FOREIGN_EMAIL = 'victim@example.test'

// A real bcrypt hash of a password that is NOT the one the tests present, so
// changePassword performs its read and then refuses on the comparison.
const SOME_BCRYPT_HASH = '$2b$12$Q7QxTQqR0p6vJY9Yx1m8JOkjH3J0mD6G4jY6YtV2v0mL4YvM1gM9S'

mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })

/**
 * The external principal. SUPPLIER is deliberate: these endpoints are gated on
 * authentication alone, and a supplier is authenticated.
 */
mock.module('@/lib/auth', {
  namedExports: {
    auth: async () => ({
      user: {
        id: CALLER_ID,
        email: 'supplier-user@example.test',
        name: 'Supplier User',
        role: 'SUPPLIER',
        supplierId: 'supplier-A',
        totpEnabled: false,
        totpVerified: false,
        sessionInvalidReason: null,
        sessionVersion: 1,
        // Fresh, so the endpoints that step up (updateProfile on an email change)
        // run their whole path instead of stopping at the freshness check — the
        // interesting query is on the far side of it.
        sessionAuthTime: Math.floor(Date.now() / 1000),
      },
    }),
  },
})

const queries: QueryContext[] = []

const recorder = createRecordingDb((ctx: QueryContext) => {
  queries.push(ctx)

  if (ctx.model === 'setting') {
    // Application configuration, not anybody's row. Answered so the endpoints
    // that need the public app URL get past it and reach the reads that matter.
    const row = { key: 'public_app_url', value: 'https://ims.example.test' }
    return ctx.op === 'findMany' ? [row] : row
  }
  if (ctx.model === 'user' && (ctx.op === 'findUnique' || ctx.op === 'findFirst')) {
    return {
      id: CALLER_ID,
      name: 'Supplier User',
      email: 'supplier-user@example.test',
      role: 'SUPPLIER',
      pictureUrl: null,
      totpEnabled: false,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      passwordHash: SOME_BCRYPT_HASH,
      passkeys: [],
    }
  }
  if (ctx.op === 'findUnique' || ctx.op === 'findFirst') return null
  if (ctx.op === 'findMany') return []
  return { count: 0 }
})
mock.module('@/lib/db', { namedExports: { db: recorder.db } })

before(async () => {
  const { getProfileData } = await import('@/app/actions/profile')
  await recorder.prove(() => getProfileData())
})

// ---------------------------------------------------------------------------
// The queries an endpoint issued, described precisely enough to pin
// ---------------------------------------------------------------------------

/** `user.findUnique where {email}` — model, operation, and the filter's shape. */
function describe(ctx: QueryContext): string {
  const arg = ctx.args[0]
  const where = (arg as { where?: Record<string, unknown> } | undefined)?.where
  const keys = where && typeof where === 'object' ? Object.keys(where).sort() : []
  return `${ctx.model}.${ctx.op} where {${keys.join(',')}}`
}

/** Does the query carry the CALLER's own identity? */
function mentionsCaller(ctx: QueryContext): boolean {
  try {
    return JSON.stringify(ctx.args)?.includes(CALLER_ID) ?? false
  } catch {
    return false
  }
}

/**
 * Client-level operations (`$transaction`) carry no `where` of their own — the
 * statements inside them are recorded individually, and those are what get
 * checked. Including the wrapper would pin a string that says nothing.
 */
const isClientLevelOp = (ctx: QueryContext) => ctx.model.startsWith('$')

type Endpoint = {
  /** The key used by the coverage test's inventory. */
  key: string
  module: string
  call: (m: Record<string, (...a: never[]) => Promise<unknown>>) => Promise<unknown>
}

const ENDPOINTS: Endpoint[] = [
  { key: 'passkey.ts:deletePasskey', module: 'passkey', call: (m) => m.deletePasskey(...([FOREIGN_PASSKEY_ID] as never[])) },
  { key: 'passkey.ts:getPasskeyRegistrationOptions', module: 'passkey', call: (m) => m.getPasskeyRegistrationOptions() },
  { key: 'passkey.ts:listPasskeys', module: 'passkey', call: (m) => m.listPasskeys() },
  { key: 'passkey.ts:renamePasskey', module: 'passkey', call: (m) => m.renamePasskey(...([FOREIGN_PASSKEY_ID, 'Renamed'] as never[])) },
  { key: 'passkey.ts:verifyPasskeyRegistration', module: 'passkey', call: (m) => m.verifyPasskeyRegistration(...([{ id: 'x', rawId: 'x', response: {}, type: 'public-key', clientExtensionResults: {} }] as never[])) },
  { key: 'profile.ts:changePassword', module: 'profile', call: (m) => m.changePassword(...([{ currentPassword: 'not-the-password', newPassword: 'C0rrect-horse-battery!' }] as never[])) },
  { key: 'profile.ts:getProfileData', module: 'profile', call: (m) => m.getProfileData() },
  { key: 'profile.ts:updatePictureUrl', module: 'profile', call: (m) => m.updatePictureUrl(...(['https://ims.example.test/p.png'] as never[])) },
  { key: 'profile.ts:updateProfile', module: 'profile', call: (m) => m.updateProfile(...([{ name: 'Renamed', email: FOREIGN_EMAIL }] as never[])) },
]

/**
 * The reads an endpoint issues that are NOT scoped to the caller, each with the
 * argument for why that is acceptable. Pinned by deepEqual, so an entry that
 * stops being true fails just as loudly as a new unscoped read appearing.
 *
 * An empty list is the expected state for a self-scoped endpoint. Two are not
 * empty, and both are stated rather than hidden.
 */
const NON_SELF_SCOPED_READS: Record<string, string[]> = {
  // getPublicAppUrl -> getSettingValue('public_app_url'). Application
  // configuration — the WebAuthn relying-party origin — not a row belonging to
  // any user. Returning it to a signed-in principal discloses the URL they are
  // already talking to.
  'passkey.ts:getPasskeyRegistrationOptions': ['setting.findUnique where {key}'],
  'passkey.ts:verifyPasskeyRegistration': ['setting.findUnique where {key}'],

  // THE ONE THAT IS NOT CONFIGURATION, and the reason this file exists.
  //
  // updateProfile checks its new email for uniqueness with
  // db.user.findUnique({ where: { email: newEmail } }) — a lookup of a row that
  // by definition is NOT the caller's, keyed on a value the caller supplies. The
  // result is not returned, but the outcome is: 'Email already in use' tells the
  // caller whether an account exists at any address they care to name, and the
  // caller may be an external supplier. It is an account-enumeration oracle, not
  // a data leak: no field of the other row reaches the response.
  //
  // Left as it is rather than "fixed" quietly, because the read is load-bearing —
  // it is what keeps the unique constraint from failing as a 500 — and narrowing
  // it is a product decision about a rate limit or a generic error, not a
  // one-line security patch. It is pinned here so it is a decision on the record
  // instead of an assumption, and it is exactly the class the model-surface pin
  // could not see: same model, same operation, same table, different subject.
  'profile.ts:updateProfile': ['user.findUnique where {email}'],
}

for (const endpoint of ENDPOINTS) {
  test(`${endpoint.key} scopes every query it issues to the CALLER's own row`, async () => {
    recorder.reset()
    queries.length = 0

    const mod = await import(`@/app/actions/${endpoint.module}`)
    await endpoint.call(mod as Record<string, (...a: never[]) => Promise<unknown>>)

    assert.ok(
      queries.length > 0,
      `${endpoint.key} issued no query at all — the call returned before reaching the database, `
      + 'so this test would pass without proving anything. Fix the fixture, not the assertion.',
    )

    const unscoped = queries
      .filter((q) => !isClientLevelOp(q) && !mentionsCaller(q))
      .map(describe)

    assert.deepEqual(
      unscoped,
      NON_SELF_SCOPED_READS[endpoint.key] ?? [],
      `${endpoint.key} is on the authentication-only inventory, which is accepted ONLY because it `
      + 'is self-scoped: every principal who can sign in can call it, including an external '
      + 'SUPPLIER. A query here that does not carry the caller\'s own id reads somebody else\'s '
      + 'row. Either scope it, give the endpoint an authorization gate (which removes it from the '
      + 'inventory), or add it above with the argument for why it is not the caller\'s data.',
    )
  })
}

test('a foreign resource id is never the SOLE constraint — it is conjoined with the caller', async () => {
  // The sharper half of the question. deletePasskey and renamePasskey take an id
  // straight from the caller; scoping means that id is ANDed with the session's
  // user id, not trusted on its own.
  for (const key of ['passkey.ts:deletePasskey', 'passkey.ts:renamePasskey']) {
    const endpoint = ENDPOINTS.find((e) => e.key === key)
    assert.ok(endpoint)
    recorder.reset()
    queries.length = 0

    const mod = await import(`@/app/actions/${endpoint.module}`)
    await endpoint.call(mod as Record<string, (...a: never[]) => Promise<unknown>>)

    const usingForeignId = queries.filter((q) => {
      try {
        return JSON.stringify(q.args)?.includes(FOREIGN_PASSKEY_ID) ?? false
      } catch {
        return false
      }
    })
    assert.ok(usingForeignId.length > 0, `${key} never used the id it was given — fixture problem`)

    for (const q of usingForeignId) {
      assert.ok(
        mentionsCaller(q),
        `${key} issued ${describe(q)} constrained by the CALLER-SUPPLIED id alone. `
        + 'Any signed-in principal could then name another user\'s passkey.',
      )
    }
  }
})

// ---------------------------------------------------------------------------
// The list above must BE the inventory — not a subset of it
// ---------------------------------------------------------------------------

test('every authentication-only endpoint in the tree is covered by a self-scoping proof here', () => {
  // Without this, the self-scoping argument holds for nine endpoints and the
  // tenth arrives with the argument assumed. The scanner is the same one the
  // coverage test pins its inventory with, so the two cannot drift apart: adding
  // an authentication-only endpoint turns THIS file red until somebody executes
  // it and shows what it reads.
  const root = process.cwd()
  const graph = createRepoGraph(root, ['app', 'lib', 'components'])
  const inventory = scanActionsDir(
    path.join(root, 'app', 'actions'),
    {},
    scanAuthenticationOnlyActions,
    graph,
    'app/actions',
  ).sort()

  assert.deepEqual(
    ENDPOINTS.map((e) => e.key).sort(),
    inventory,
    'The authentication-only inventory and the endpoints proved self-scoping here have diverged. '
    + 'An endpoint gated on authentication alone is one an external SUPPLIER may call, and the only '
    + 'reason that is acceptable is that it reads nothing but the caller\'s own row — which is a '
    + 'claim, until it is executed.',
  )
})

test('the non-self-scoped pin names no endpoint that has left the inventory', () => {
  // Same dead-entry rule the allowlist carries: an exemption written for code
  // that no longer exists is an exemption waiting for code that does not deserve
  // it.
  const keys = new Set(ENDPOINTS.map((e) => e.key))
  for (const key of Object.keys(NON_SELF_SCOPED_READS)) {
    assert.ok(keys.has(key), `${key} is pinned as having a non-self-scoped read but is no longer covered`)
  }
})
