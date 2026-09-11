/**
 * o3d-alnk r6 (Codex HIGH x2) — THE DRAIN'S DEPENDENCIES ARE ALL-OR-NOTHING, AND NO MIXTURE IS
 * EITHER SPELLABLE OR RUNNABLE.
 *
 * EIGHT HIGHS, ONE DEFECT. Rounds 2, 3 and 5 each found new ways to recombine this drain's
 * dependencies into "fake sender, real data" or "real sender, tampered clock":
 *
 *   r2  `{ sendEmail: fake }`                — a fake sender over the GLOBAL queue
 *   r2  `{ client: double }`                 — a fixture handed to the REAL mailer
 *   r3  `{ sendEmail: fake, referenceIdPrefix }` — a scoping predicate that narrowed nothing
 *   r3  `{ now: futureClock }`               — reclaims rows no predicate mentioned
 *   r3  `{ prepareQueuedEmail: fake }`       — decides the recipient, the body and the PDF
 *   r5  `{ now: futureClock }` past the union
 *   r5  `{ client: null, sendEmail: fake }`  — `null` was "present" to the pair guard and
 *   r5  `{ client: real, sendEmail: null }`    "absent" to `??`; the two disagreed about one object
 *
 * Every fix was correct about its own pairing and left the next one open, because independently
 * optional dependency fields CANNOT express the invariant that matters: either everything comes
 * from production, or everything comes from the harness, never a mixture.
 *
 * ROUND 6 CHANGES THE SHAPE INSTEAD OF ADDING A NINTH RULE. There is now ONE field, `harness`,
 * carrying a COMPLETE `EmailOutboxHarness` with no optional members. Absent is pure production;
 * present is pure harness; there is no third state to construct. `{ now: futureClock }` is not a
 * shape that exists. `{ client: null, sendEmail: fake }` is not a shape that exists. And a cast
 * that forces `harness` past tsc has to supply ALL FIVE members, which is the safe direction.
 *
 * SO THIS FILE PROVES FOUR THINGS, IN FOUR DIFFERENT WAYS:
 *
 *   COMPILE TIME. Each negative carries `@ts-expect-error`. Widen the type and the line compiles,
 *   the directive becomes unused, and `tsc --noEmit` fails with TS2578. The proof is carried by
 *   the gate's type-check step, not by an assertion anyone can weaken.
 *
 *   RUNTIME, THROUGH THE SHIPPED FUNCTION. Every pairing named above is actually EXECUTED here
 *   behind `as unknown as`, which is only safe because `@/lib/db`, `@/lib/mailer`,
 *   `@/lib/order-email` and `@/lib/activity-log` are mocked to modules that THROW BY NAME on any
 *   use. That is what makes "refused before the first query" an observation rather than a claim:
 *   if the guard were removed, the failure is not a missing throw, it is the drain reaching the
 *   global database or the real mailer, and the tripwire says which.
 *
 *   Note the SPELLING of those casts: `as unknown as ProcessEmailOutboxOptions`. Unlike r4's
 *   union, a single `as` would now be ACCEPTED by tsc — every property of the new options type is
 *   optional, so a stray-keyed literal is comparable to it. The double cast is written out
 *   because the runtime path is the thing under test, and because pretending the type refuses the
 *   cast would be exactly the false comfort three rounds of guards already gave.
 *
 *   A COMPLETE HARNESS MAY NOT NAME A PRODUCTION DEPENDENCY. The one mixture a caller can still
 *   build by hand — importing the real mailer and putting it IN the harness — is refused by
 *   identity, before any property of the value is read.
 *
 *   NON-VACUITY. The legal shapes resolve, and they resolve to DIFFERENT dependency sets, so the
 *   refusals above are not passing because everything is refused.
 */

import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * THE GLOBALS THE HAZARD REACHES FOR, REPLACED BY TRIPWIRES. Nothing here is a stub that quietly
 * returns: every one throws with a name, so a regression reports WHICH production dependency the
 * mixture got to, instead of a generic assertion failure.
 */
const reached: string[] = []

function tripwire(what: string): never {
  reached.push(what)
  throw new Error(`the mixed drain reached ${what}`)
}

mock.module('@/lib/db', {
  namedExports: {
    db: new Proxy({}, {
      get: () => tripwire('the GLOBAL database (@/lib/db)'),
    }),
  },
})

mock.module('@/lib/mailer', {
  namedExports: {
    sendEmail: async () => tripwire('the REAL mailer (@/lib/mailer)'),
  },
})

mock.module('@/lib/order-email', {
  namedExports: {
    prepareQueuedEmail: async () => tripwire('the REAL preparer (@/lib/order-email)'),
  },
})

mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async () => tripwire('the REAL activity log (@/lib/activity-log)'),
  },
})

/**
 * Loaded INSIDE the tests, never at the top level: a static import is hoisted above the
 * `mock.module` calls and would pull in the real `@/lib/db`, and a top-level `await import` is
 * rejected outright by the tsx/CJS transform this suite runs under.
 */
const loadOutbox = () => import('@/lib/email-outbox')

type EmailOutboxClient = import('@/lib/email-outbox').EmailOutboxClient
type EmailOutboxHarness = import('@/lib/email-outbox').EmailOutboxHarness
type EmailOutboxHarnessClient = import('@/lib/email-outbox').EmailOutboxHarnessClient
type ProcessEmailOutboxOptions = import('@/lib/email-outbox').ProcessEmailOutboxOptions

/**
 * MINT ONE, THROUGH THE SHIPPED FUNCTION. Dynamic, like everything else here: a static import would
 * be hoisted above the `mock.module` calls and pull in the real `@/lib/db`.
 */
async function mintClient(delegates: {
  emailOutbox: EmailOutboxClient['emailOutbox']
  emailSuppression: EmailOutboxClient['emailSuppression']
}): Promise<EmailOutboxHarnessClient> {
  const { createEmailOutboxHarnessClient } = await loadOutbox()
  return await createEmailOutboxHarnessClient(
    delegates as unknown as Parameters<typeof createEmailOutboxHarnessClient>[0],
  )
}

/**
 * THE WITNESS EVERY MINTABLE DOUBLE IN THIS FILE CARRIES (r26). The mint no longer takes a
 * `writesTo` field's word for where a client's writes land: it puts a row of its own into the
 * array a delegate reports and asks the delegate to hand it back. A double that keeps its rows in
 * this process can do that; `db.emailOutbox` cannot, which is the point.
 */
const witnessSymbol = async (): Promise<symbol> => (await loadOutbox()).EMAIL_OUTBOX_IN_MEMORY_ROWS

/**
 * A TYPE-ONLY handle on the shipped function, for the negatives that must never be executed.
 * `declare const` emits nothing, so this cannot accidentally become a call at runtime.
 */
declare const processPendingEmailOutbox: typeof import('@/lib/email-outbox').processPendingEmailOutbox

/**
 * A client that records the first query it is asked for. It is the instrument for "before the
 * first query": the guard has to fire while this is still empty.
 */
async function spyClient(): Promise<{ client: EmailOutboxHarnessClient; queries: string[] }> {
  const queries: string[] = []
  const rows: Record<string, unknown>[] = []
  const suppressions: Record<string, unknown>[] = []
  const record = (name: string) => async (): Promise<never> => {
    queries.push(name)
    throw new Error(`the guard did not fire: the drain issued ${name}`)
  }
  const witness = await witnessSymbol()
  // THE TWO READS THE MINT'S PROBE USES SERVE IT (r26) — a delegate that threw at the mint could
  // never be minted at all, and this file needs minted clients to measure refusals with. Everything
  // the DRAIN would issue still throws, and `queries` is cleared below so the probe's own reads are
  // not mistaken for the drain's.
  const client = await mintClient({
    emailOutbox: {
      async findMany(args: unknown) {
        queries.push('emailOutbox.findMany')
        const { where } = args as { where?: { id?: unknown } }
        return rows.filter((row) => row.id === where?.id) as never
      },
      updateMany: record('emailOutbox.updateMany'),
      create: record('emailOutbox.create'),
      [witness]: () => rows,
    },
    emailSuppression: {
      async findUnique(args: unknown) {
        queries.push('emailSuppression.findUnique')
        const { where } = args as { where?: { email?: unknown } }
        return (suppressions.find((row) => row.email === where?.email) ?? null) as never
      },
      upsert: record('emailSuppression.upsert'),
      [witness]: () => suppressions,
    },
  } as unknown as EmailOutboxClient)
  queries.length = 0
  return { queries, client }
}

/**
 * DELEGATES THAT KEEP THEIR ROWS HERE AND WILL SHOW THEM — the shape the mint accepts (r26).
 * Used by the tests below that need a mint to SUCCEED before they can measure anything else.
 */
async function mintableDelegates(): Promise<EmailOutboxClient> {
  const rows: Record<string, unknown>[] = []
  const suppressions: Record<string, unknown>[] = []
  const witness = await witnessSymbol()
  return {
    emailOutbox: {
      async findMany(args: unknown) {
        const { where } = args as { where?: { id?: unknown } }
        return rows.filter((row) => row.id === where?.id) as never
      },
      async updateMany() { return { count: 0 } },
      async create() { return {} },
      [witness]: () => rows,
    },
    emailSuppression: {
      async findUnique(args: unknown) {
        const { where } = args as { where?: { email?: unknown } }
        return (suppressions.find((row) => row.email === where?.email) ?? null) as never
      },
      async upsert() { return {} },
      [witness]: () => suppressions,
    },
  } as unknown as EmailOutboxClient
}

/** The same delegates, NOT minted: a structurally perfect client that was never admitted (r18). */
function unmintedClient(): EmailOutboxClient {
  const record = (name: string) => async (): Promise<never> => {
    throw new Error(`the guard did not fire: the drain issued ${name}`)
  }
  return {
    emailOutbox: {
      findMany: record('emailOutbox.findMany'),
      updateMany: record('emailOutbox.updateMany'),
      create: record('emailOutbox.create'),
    },
    emailSuppression: {
      findUnique: record('emailSuppression.findUnique'),
      upsert: record('emailSuppression.upsert'),
    },
  } as unknown as EmailOutboxClient
}

const fakeSender = async () => ({ success: true as const })
const fakePrepare = async () => null
const fakeLog = async () => undefined

/** A COMPLETE harness. Nothing in it is optional, which is the whole point of the type. */
function completeHarness(client: EmailOutboxHarnessClient): EmailOutboxHarness {
  return {
    client,
    sendEmail: fakeSender,
    prepareQueuedEmail: fakePrepare,
    logActivity: fakeLog,
    now: () => new Date('2026-09-10T09:00:00.000Z'),
  }
}

/** NEVER CALLED. Executing it is exactly the destructive act it exists to forbid. */
async function refusedShapes(): Promise<void> {
  const client = (await spyClient()).client

  // --- THE EIGHT RECOMBINATIONS. None of them is a shape that exists any more: dependencies are
  // --- not spelled one per field, so each is an unknown property on the options type.

  // @ts-expect-error r2: a fake sender may not be pointed at the GLOBAL queue
  void processPendingEmailOutbox({ sendEmail: fakeSender })

  // @ts-expect-error r2 mirror: a test's own rows may not be handed to the REAL mailer
  void processPendingEmailOutbox({ client })

  // @ts-expect-error r3/r5: `now` decides eligibility AND stale reclamation — a future clock
  void processPendingEmailOutbox({ now: () => new Date() })

  // @ts-expect-error r3: `prepareQueuedEmail` decides the recipient, the body and the PDF
  void processPendingEmailOutbox({ prepareQueuedEmail: fakePrepare })

  // @ts-expect-error r3: and the activity log is not a top-level override either
  void processPendingEmailOutbox({ logActivity: fakeLog })

  // @ts-expect-error r5: `null` is not "absent". There is no field here for it to be null ON.
  void processPendingEmailOutbox({ client: null, sendEmail: fakeSender })

  // @ts-expect-error r5 mirror: nor on the other half
  void processPendingEmailOutbox({ client, sendEmail: null })

  // @ts-expect-error r5: the old "legal" injected shape is not legal either — it is a mixture
  void processPendingEmailOutbox({ client, sendEmail: fakeSender })

  // --- AND A HARNESS IS COMPLETE OR IT IS NOT A HARNESS.

  // @ts-expect-error a harness missing `prepareQueuedEmail`, `logActivity` and `now`
  void processPendingEmailOutbox({ harness: { client, sendEmail: fakeSender } })

  // @ts-expect-error an empty harness is not a cheap way to say "production"
  void processPendingEmailOutbox({ harness: {} })

  // @ts-expect-error `null` is not a harness; only ABSENCE means production
  void processPendingEmailOutbox({ harness: null })

  // @ts-expect-error a null member is not an "unset" member
  void processPendingEmailOutbox({ harness: { ...completeHarness(client), now: null } })

  // @ts-expect-error and the members cannot be smuggled alongside a harness either
  void processPendingEmailOutbox({ harness: completeHarness(client), sendEmail: fakeSender })

  // --- AND THE CLIENT IS MINTED, NOT ASSEMBLED (r18, Codex HIGH). `EmailOutboxHarnessClient`
  // --- carries a declare-only brand, so a hand-built client — including the structural wrapper of
  // --- the production client that passed the old identity check — is not spellable here either.

  // @ts-expect-error an assembled client is not a minted one, whatever it holds
  void processPendingEmailOutbox({ harness: { ...completeHarness(client), client: unmintedClient() } })
}

/** ALSO NEVER CALLED: `acceptedShapes` would run a real drain. Only its TYPES are the proof. */
async function acceptedShapes(): Promise<void> {
  // (a) THE CRON: nothing at all — the global client, the real sender, the real clock.
  void processPendingEmailOutbox()
  void processPendingEmailOutbox({})

  // (b) A CALLER THAT BROUGHT ITS WHOLE WORLD — with a client this module MINTED for it.
  void processPendingEmailOutbox({ harness: completeHarness((await spyClient()).client) })
}

test('the option type admits exactly two shapes, and no mixture is one of them', async () => {
  // The real proof is above and is enforced by `tsc --noEmit`; this body exists so the file is a
  // test rather than a comment, and so the two functions are REFERENCED (an unreferenced one is a
  // lint error away from being deleted, taking the proof with it).
  assert.equal(typeof refusedShapes, 'function')
  assert.equal(typeof acceptedShapes, 'function')

  // Building the object first and passing it second does not help: there is one field to fill.
  const cron: ProcessEmailOutboxOptions = {}
  const injected: ProcessEmailOutboxOptions = { harness: completeHarness((await spyClient()).client) }
  assert.equal(cron.harness, undefined)
  assert.equal(injected.harness?.sendEmail, fakeSender)
})

/**
 * EVERY PAIRING CODEX NAMED, CAST PAST THE TYPE AND ACTUALLY RUN.
 *
 * The assertion that matters comes FIRST in each case, and it is about WHAT DID NOT HAPPEN.
 * Without the guard these calls select the twenty-five oldest eligible rows from the global
 * database and stamp them SENT, so the failure to report is "it reached the global database" — not
 * "it did not throw". Asserting the throw first would report the wrong thing.
 */
const NAMED_RECOMBINATIONS: { name: string; options: unknown; expect: RegExp }[] = [
  {
    name: '{ now: futureClock } — Codex r5 HIGH 1',
    options: { now: () => new Date('2099-01-01T00:00:00.000Z') },
    expect: /unknown option\(s\) "now"/,
  },
  {
    name: '{ prepareQueuedEmail: fake } — Codex r5 HIGH 1',
    options: { prepareQueuedEmail: fakePrepare },
    expect: /unknown option\(s\) "prepareQueuedEmail"/,
  },
  {
    name: '{ client: null, sendEmail: fake } — Codex r5 HIGH 2',
    options: { client: null, sendEmail: fakeSender },
    expect: /unknown option\(s\) "client", "sendEmail"/,
  },
  {
    name: '{ client: testClient, sendEmail: null } — Codex r5 HIGH 2 mirror',
    options: { client: unmintedClient(), sendEmail: null },
    expect: /unknown option\(s\) "client", "sendEmail"/,
  },
  {
    name: '{ sendEmail: fake } — Codex r2, the original',
    options: { sendEmail: fakeSender },
    expect: /unknown option\(s\) "sendEmail"/,
  },
]

for (const recombination of NAMED_RECOMBINATIONS) {
  test(`REFUSED before the first query: ${recombination.name}`, async () => {
    const { processPendingEmailOutbox: drain } = await loadOutbox()
    reached.length = 0

    const refusal = await drain(recombination.options as ProcessEmailOutboxOptions)
      .then(() => null, (error: unknown) => error)

    assert.deepEqual(reached, [], `the drain reached a production dependency before refusing: ${reached.join(', ')}`)
    assert.ok(refusal instanceof Error, 'the cast reached the drain and the drain accepted it')
    assert.match(refusal.message, recombination.expect)
    assert.match(refusal.message, /ALL-OR-NOTHING/)
  })
}

test('a PARTIAL harness cast past the type is refused before the first query, by member name', async () => {
  const { processPendingEmailOutbox: drain } = await loadOutbox()
  reached.length = 0
  const spy = await spyClient()

  // This is the shape a cast CAN still build, and it is the one the r4 union called legal.
  const refusal = await drain({ harness: { client: spy.client, sendEmail: fakeSender } } as unknown as ProcessEmailOutboxOptions)
    .then(() => null, (error: unknown) => error)

  // "Before the first query" is MEASURED, not asserted in prose: the spy client records every call
  // it is asked for, and the guard has to fire while that record is still empty.
  assert.deepEqual(spy.queries, [], `the drain issued a query before refusing: ${spy.queries.join(', ')}`)
  assert.deepEqual(reached, [], `the drain reached a production dependency before refusing: ${reached.join(', ')}`)

  assert.ok(refusal instanceof Error, 'a partial harness was accepted')
  assert.match(refusal.message, /`harness\.prepareQueuedEmail` is missing/)
})

test('a NULL member is refused BY NAME, not read as "absent" and filled from production (r5 HIGH 2)', async () => {
  const { processPendingEmailOutbox: drain } = await loadOutbox()
  const spy = await spyClient()

  for (const member of ['client', 'sendEmail', 'prepareQueuedEmail', 'logActivity', 'now'] as const) {
    reached.length = 0
    spy.queries.length = 0
    const harness = { ...completeHarness(spy.client), [member]: null }

    const refusal = await drain({ harness } as unknown as ProcessEmailOutboxOptions)
      .then(() => null, (error: unknown) => error)

    assert.deepEqual(spy.queries, [], `${member}: the drain issued a query before refusing`)
    assert.deepEqual(reached, [], `${member}: the drain reached ${reached.join(', ')} before refusing`)
    assert.ok(refusal instanceof Error, `${member}: a null member was accepted`)
    assert.match(refusal.message, new RegExp(`\`harness\\.${member}\` is null`))
  }

  // And `harness: null` itself is refused rather than treated as "no harness".
  reached.length = 0
  const nullHarness = await drain({ harness: null } as unknown as ProcessEmailOutboxOptions)
    .then(() => null, (error: unknown) => error)
  assert.deepEqual(reached, [], 'the drain reached production before refusing a null harness')
  assert.ok(nullHarness instanceof Error)
  assert.match(nullHarness.message, /`harness` must be an object; received null/)
})

test('a harness may not NAME a production dependency, and the refusal beats the tripwire to it', async () => {
  const { processPendingEmailOutbox: drain } = await loadOutbox()
  const spy = await spyClient()
  const [{ db }, { sendEmail }, { prepareQueuedEmail }, { logActivity }] = await Promise.all([
    import('@/lib/db'),
    import('@/lib/mailer'),
    import('@/lib/order-email'),
    import('@/lib/activity-log'),
  ])

  // `client` IS NOT IN THIS LOOP ANY MORE (r18). It used to be refused by identity against `db`,
  // which is the adjacent question rather than the right one — a structural wrapper of `db` is not
  // `db` and reaches the same rows. It is refused by the MINT rule instead, which is proved on its
  // own below against `db`, against a wrapper of it, and against a copy of a minted client.
  void db
  const productionValues: Record<string, unknown> = {
    sendEmail,
    prepareQueuedEmail,
    logActivity,
  }

  for (const [member, production] of Object.entries(productionValues)) {
    reached.length = 0
    spy.queries.length = 0
    const harness = { ...completeHarness(spy.client), [member]: production }

    const refusal = await drain({ harness } as unknown as ProcessEmailOutboxOptions)
      .then(() => null, (error: unknown) => error)

    assert.deepEqual(reached, [], `${member}: the drain reached ${reached.join(', ')} before refusing`)
    assert.deepEqual(spy.queries, [], `${member}: the drain issued a query before refusing`)
    assert.ok(refusal instanceof Error, `${member}: a production dependency inside a harness was accepted`)
    assert.match(refusal.message, new RegExp(`\`harness\\.${member}\` IS the production dependency`))
  }
})

test('NON-VACUITY: the legal shapes resolve, and to DIFFERENT dependency sets', async () => {
  const { resolveEmailOutboxDependencies } = await loadOutbox()
  const spy = await spyClient()
  const harness = completeHarness(spy.client)
  reached.length = 0

  // (b) A HARNESS resolves to the CALLER'S OWN VALUES, member for member. Nothing is blended in.
  //
  // `client` is compared by DELEGATE rather than by identity because r7 HIGH 2 made the resolver
  // return a SNAPSHOT: the object is fresh, and it carries the two delegates the check read —
  // which are the values `settleClaimedEmail` and the suppression lookup would otherwise re-read
  // off the caller's client on every write.
  const injected = resolveEmailOutboxDependencies({ harness })
  assert.notEqual(injected.client as unknown, spy.client as unknown, 'the resolver handed back the caller\'s own object')
  assert.equal(injected.client.emailOutbox, spy.client.emailOutbox)
  assert.equal(injected.client.emailSuppression, spy.client.emailSuppression)
  assert.equal(injected.sendEmail, fakeSender)
  assert.equal(injected.prepareQueuedEmail, fakePrepare)
  assert.equal(injected.logActivity, fakeLog)
  assert.equal(injected.now, harness.now)

  // (a) THE CRON resolves to the PRODUCTION set — complete, and none of it the caller's. This is
  // the branch that must never be reachable from a mixture, so it is exercised here (where the
  // production modules are tripwires) rather than through the drain (which would run it).
  const [{ db }, { sendEmail }, { prepareQueuedEmail }, { logActivity }] = await Promise.all([
    import('@/lib/db'),
    import('@/lib/mailer'),
    import('@/lib/order-email'),
    import('@/lib/activity-log'),
  ])
  const production = resolveEmailOutboxDependencies({})
  assert.equal(production.client, db as unknown)
  assert.equal(production.sendEmail, sendEmail)
  assert.equal(production.prepareQueuedEmail, prepareQueuedEmail)
  assert.equal(production.logActivity, logActivity)
  assert.equal(typeof production.now, 'function')
  assert.ok(production.now() instanceof Date)

  // RESOLVING IS NOT USING: neither branch touched a production dependency.
  assert.deepEqual(reached, [], `resolution reached ${reached.join(', ')}`)
  assert.deepEqual(spy.queries, [])

  // The two sets share NOTHING. That is the "no mixture" property, stated as a measurement.
  for (const member of ['client', 'sendEmail', 'prepareQueuedEmail', 'logActivity'] as const) {
    assert.notEqual(
      injected[member] as unknown,
      production[member] as unknown,
      `${member} is the same value in both sets, so the sets are not disjoint`,
    )
  }
})

// ===========================================================================================
// ROUND 7 — TIME-OF-CHECK/TIME-OF-USE. The guard has to READ EACH FACT ONCE, and it has to be
// able to SEE every fact that is there. Both r7 HIGHs were that one sentence broken.
// ===========================================================================================

/**
 * A client that WORKS, unlike `spyClient` above, because these proofs have to let the drain RUN.
 * "Refused before the first query" is not the property here — "the drain that ran never touched a
 * production dependency, even though the harness offered it one on the second read" is.
 */
async function workingClient(rows: { id: string; status: string }[]): Promise<{
  client: EmailOutboxHarnessClient
  store: Record<string, Record<string, unknown>>
}> {
  const store: Record<string, Record<string, unknown>> = {}
  for (const row of rows) {
    store[row.id] = {
      id: row.id,
      kind: 'ACCOUNTING_INVOICE',
      toEmail: 'fixture@example.invalid',
      subject: 'fixture',
      html: '<p>fixture</p>',
      attachments: null,
      referenceType: 'SalesOrder',
      referenceId: row.id,
      status: row.status,
      attempts: 0,
      availableAt: new Date('2026-01-01T00:00:00.000Z'),
      processingStartedAt: null,
      lockedBy: null,
    }
  }
  // THE SAME ROW OBJECTS, IN AN ARRAY (r26): `store` is what the assertions read by id, and this is
  // what the delegate reads and what it hands the mint to prove its rows live in this process.
  const rowList: Record<string, unknown>[] = Object.values(store)
  const suppressions: Record<string, unknown>[] = []
  const witness = await witnessSymbol()
  return {
    store,
    client: await mintClient({
      emailOutbox: {
        async findMany() {
          return rowList
            .filter((row) => row.status === 'PENDING')
            .map((row) => ({ ...row })) as never
        },
        async updateMany(args: unknown) {
          const { where, data } = args as { where: Record<string, unknown>; data: Record<string, unknown> }
          const row = store[String(where.id)]
          if (!row) return { count: 0 }
          // Only the fencing columns matter for these proofs; the full predicate is exercised by
          // tests/email-outbox-claim-fence.test.ts.
          if ('lockedBy' in where && row.lockedBy !== where.lockedBy) return { count: 0 }
          Object.assign(row, data)
          return { count: 1 }
        },
        async create() { return {} },
        [witness]: () => rowList,
      },
      emailSuppression: {
        async findUnique(args: unknown) {
          const { where } = args as { where?: { email?: unknown } }
          return (suppressions.find((row) => row.email === where?.email) ?? null) as never
        },
        async upsert() { return {} },
        [witness]: () => suppressions,
      },
    } as unknown as EmailOutboxClient),
  }
}

/**
 * A HARNESS THAT ANSWERS DIFFERENTLY ON THE SECOND READ — Codex r7 HIGH 2, built.
 *
 * Every member is an accessor. The FIRST read hands over the caller's own world (a fixture client,
 * a fake sender, a fixture clock); every read after that hands over PRODUCTION. Nothing here is
 * exotic: a class with `get client()`, a Proxy, or an object that memoises lazily behaves exactly
 * like this without anybody intending it.
 *
 * `reads` is the instrument. The property under test is not "it threw" — it is THE CALLER'S OBJECT
 * WAS READ EXACTLY ONCE PER MEMBER, which is what makes the second answer unreachable.
 */
function twoFacedHarness(
  first: EmailOutboxHarness,
  second: Record<string, unknown>,
): { harness: object; reads: Record<string, number> } {
  const reads: Record<string, number> = { client: 0, sendEmail: 0, prepareQueuedEmail: 0, logActivity: 0, now: 0 }
  const answer = (member: keyof typeof reads): unknown => {
    reads[member] += 1
    return reads[member] === 1 ? (first as unknown as Record<string, unknown>)[member] : second[member]
  }
  return {
    reads,
    harness: {
      get client() { return answer('client') },
      get sendEmail() { return answer('sendEmail') },
      get prepareQueuedEmail() { return answer('prepareQueuedEmail') },
      get logActivity() { return answer('logActivity') },
      get now() { return answer('now') },
    },
  }
}

test('r7 HIGH 2: a harness that flips to PRODUCTION on the second read is read only ONCE', async () => {
  const { resolveEmailOutboxDependencies } = await loadOutbox()
  const [{ db }, { sendEmail }, { prepareQueuedEmail }, { logActivity }] = await Promise.all([
    import('@/lib/db'),
    import('@/lib/mailer'),
    import('@/lib/order-email'),
    import('@/lib/activity-log'),
  ])
  reached.length = 0

  const fixture = await workingClient([])
  const { harness, reads } = twoFacedHarness(completeHarness(fixture.client), {
    client: db,
    sendEmail,
    prepareQueuedEmail,
    logActivity,
    now: () => new Date('2099-01-01T00:00:00.000Z'),
  })

  const resolved = resolveEmailOutboxDependencies({ harness } as unknown as ProcessEmailOutboxOptions)

  // (a) EXACTLY ONE READ PER MEMBER. This is the whole fix stated as a measurement: the validated
  // reading is what is returned, so there is no second read for the second answer to ride in on.
  assert.deepEqual(
    reads,
    { client: 1, sendEmail: 1, prepareQueuedEmail: 1, logActivity: 1, now: 1 },
    `the resolver read the caller's harness more than once: ${JSON.stringify(reads)}`,
  )

  // (b) AND THE SNAPSHOT HOLDS THE FIRST ANSWERS, not the production ones the getters were poised
  // to serve. `client` is a fresh object by design — identity is asserted per DELEGATE, because
  // the delegates are what `settleClaimedEmail` and the suppression lookup re-read.
  assert.notEqual(resolved.client as unknown, db as unknown, 'the snapshot carried the production client')
  assert.equal(resolved.client.emailOutbox, fixture.client.emailOutbox)
  assert.equal(resolved.client.emailSuppression, fixture.client.emailSuppression)
  assert.equal(resolved.sendEmail, fakeSender)
  assert.equal(resolved.prepareQueuedEmail, fakePrepare)
  assert.equal(resolved.logActivity, fakeLog)
  assert.equal(resolved.now().toISOString(), '2026-09-10T09:00:00.000Z')

  // (c) RESOLVING TOUCHED NO PRODUCTION DEPENDENCY. `db` is a Proxy that tripwires on ANY property
  // read, so had the resolver read `client` a second time this would name it.
  assert.deepEqual(reached, [], `resolution reached ${reached.join(', ')}`)
})

test('r7 HIGH 2: the DRAIN consumes only the snapshot — a two-faced harness cannot reach production', async () => {
  const { processPendingEmailOutbox: drain } = await loadOutbox()
  const [{ db }, { sendEmail }, { prepareQueuedEmail }, { logActivity }] = await Promise.all([
    import('@/lib/db'),
    import('@/lib/mailer'),
    import('@/lib/order-email'),
    import('@/lib/activity-log'),
  ])
  reached.length = 0

  // A real row to work on, so the drain runs its whole body: findMany, claim, suppression lookup,
  // prepare, send, terminal write, activity log. Every one of those is a chance to re-read.
  const fixture = await workingClient([{ id: 'row-1', status: 'PENDING' }])
  const delivered: string[] = []
  const recordingSender = async (message: { to: string }) => {
    delivered.push(message.to)
    return { success: true as const }
  }

  const { harness, reads } = twoFacedHarness(
    { ...completeHarness(fixture.client), sendEmail: recordingSender },
    { client: db, sendEmail, prepareQueuedEmail, logActivity, now: () => new Date('2099-01-01T00:00:00.000Z') },
  )

  const result = await drain({ harness } as unknown as ProcessEmailOutboxOptions)

  // THE ASSERTION THAT MATTERS COMES FIRST, and it is about WHAT DID NOT HAPPEN. Without the
  // snapshot the drain re-reads `client` and gets the GLOBAL database, then stamps whatever it
  // finds SENT through the fake sender it was handed at validation time.
  assert.deepEqual(reached, [], `the drain reached ${reached.join(', ')} through the second read`)
  assert.deepEqual(
    reads,
    { client: 1, sendEmail: 1, prepareQueuedEmail: 1, logActivity: 1, now: 1 },
    `the drain re-read the caller's harness: ${JSON.stringify(reads)}`,
  )

  // NON-VACUITY: the drain really ran, against the FIXTURE, all the way to a delivery and a SENT
  // row. A green above with nothing processed would prove nothing at all.
  assert.deepEqual(result, { processed: 1, sent: 1, failed: 0, conflicted: 0, conflictedWithoutSend: 0 })
  assert.deepEqual(delivered, ['fixture@example.invalid'])
  assert.equal(fixture.store['row-1'].status, 'SENT')
})

/**
 * MEMBERS WITH NOWHERE TO HIDE — Codex r7 HIGH 1, built.
 *
 * Each shape below carries a `sendEmail` (or a `harness`) that a property READ resolves and that
 * `Object.keys` cannot see. The old guard therefore found an EMPTY options object, concluded "no
 * harness", and ran the GLOBAL database through the REAL mailer — while the caller believed they
 * had injected a fake. The refusal must arrive instead, and it must arrive before any query.
 */
const HIDDEN_MEMBER_SHAPES: { name: string; build: () => object | Promise<object>; expect: RegExp }[] = [
  {
    name: 'Object.create({ sendEmail: fake }) — the member lives on the PROTOTYPE',
    build: () => Object.create({ sendEmail: fakeSender }) as object,
    expect: /the options object must be a PLAIN object/,
  },
  {
    name: 'a NON-ENUMERABLE `sendEmail` on an ordinary object',
    build: () => {
      const options = {}
      Object.defineProperty(options, 'sendEmail', { value: fakeSender, enumerable: false, configurable: true })
      return options
    },
    expect: /unknown option\(s\) "sendEmail"/,
  },
  {
    name: 'a NON-ENUMERABLE `sendEmail` on a NULL-prototype object (a prototype rule alone misses this)',
    build: () => {
      const options = Object.create(null) as object
      Object.defineProperty(options, 'sendEmail', { value: fakeSender, enumerable: false, configurable: true })
      return options
    },
    expect: /unknown option\(s\) "sendEmail"/,
  },
  {
    name: 'a class instance whose `harness` is a prototype accessor — the BUILDER accident',
    build: () => {
      class HarnessBuilder {
        get harness(): unknown { return { sendEmail: fakeSender } }
      }
      return new HarnessBuilder()
    },
    expect: /the options object must be a PLAIN object/,
  },
  {
    name: 'a SYMBOL-keyed member, which `Object.keys` never reports',
    build: () => ({ [Symbol.for('sendEmail')]: fakeSender }),
    expect: /unknown option\(s\) Symbol\(sendEmail\)/,
  },
  {
    name: 'a harness built on a PROTOTYPE carrying the members',
    build: async () => ({ harness: Object.create(completeHarness((await spyClient()).client)) as object }),
    expect: /`harness` must be a PLAIN object/,
  },
  {
    name: 'a harness carrying a NON-ENUMERABLE extra member',
    build: async () => {
      const harness: Record<string, unknown> = { ...completeHarness((await spyClient()).client) }
      Object.defineProperty(harness, 'referenceIdPrefix', { value: 'alnk-', enumerable: false, configurable: true })
      return { harness }
    },
    expect: /`harness` carries unknown member\(s\) "referenceIdPrefix"/,
  },
]

for (const shape of HIDDEN_MEMBER_SHAPES) {
  test(`r7 HIGH 1: REFUSED, not silently run against production: ${shape.name}`, async () => {
    const { processPendingEmailOutbox: drain } = await loadOutbox()
    reached.length = 0

    const refusal = await drain(await shape.build() as unknown as ProcessEmailOutboxOptions)
      .then(() => null, (error: unknown) => error)

    // FIRST, AND IT IS THE POINT OF THE FINDING. The old failure was not "no throw" — it was the
    // drain sweeping the GLOBAL queue with the REAL mailer while the caller thought otherwise.
    assert.deepEqual(
      reached,
      [],
      `the hidden member read as "no harness" and the drain ran PRODUCTION: ${reached.join(', ')}`,
    )
    assert.ok(refusal instanceof Error, 'the hidden member was accepted as "no harness" — that means production')
    assert.match(refusal.message, shape.expect)
  })
}

test('r7 HIGH 1 NON-VACUITY: the plain-object rule refuses hidden members, not ordinary callers', async () => {
  const { resolveEmailOutboxDependencies } = await loadOutbox()
  reached.length = 0
  const spy = await spyClient()

  // The two shapes every real caller uses: `{}` from the default parameter, and an object literal
  // carrying a literal harness. Both have `Object.prototype`, so both resolve.
  assert.doesNotThrow(() => resolveEmailOutboxDependencies({}))
  assert.doesNotThrow(() => resolveEmailOutboxDependencies({ harness: completeHarness(spy.client) }))

  // And a NULL prototype is allowed too — it inherits nothing, so its own keys ARE its members.
  const bare = Object.create(null) as Record<string, unknown>
  bare.harness = Object.assign(Object.create(null) as object, completeHarness(spy.client))
  assert.doesNotThrow(() => resolveEmailOutboxDependencies(bare as unknown as ProcessEmailOutboxOptions))

  assert.deepEqual(reached, [], `resolution reached ${reached.join(', ')}`)
  assert.deepEqual(spy.queries, [])
})

test('r7 HIGH 2, one level down: the CLIENT DELEGATES are read once too', async () => {
  const { processPendingEmailOutbox: drain } = await loadOutbox()
  reached.length = 0

  // `settleClaimedEmail` reads `client.emailOutbox` on EVERY terminal write and the drain reads
  // `client.emailSuppression` once per row, so a client whose delegates are accessors is the same
  // time-of-check/time-of-use one level below the harness: pass the probe as a fixture, serve the
  // real delegate to the writes. The delegates the probe read are therefore snapshotted as well.
  const fixture = await workingClient([{ id: 'row-1', status: 'PENDING' }])
  const delegateReads = { emailOutbox: 0, emailSuppression: 0 }
  const poison = (what: string): unknown => new Proxy({}, { get: () => tripwire(`a POISONED ${what} delegate`) })

  // The accessors are handed to the MINT (r18): that is now the one place a caller's delegates are
  // read, and the client the drain receives is the frozen snapshot it built out of that single read.
  // The measurement is unchanged and still the point — one read per delegate, so the second answer
  // has no turn — it has simply moved to the door.
  const twoFacedClient = await mintClient({
    get emailOutbox() {
      delegateReads.emailOutbox += 1
      return delegateReads.emailOutbox === 1 ? fixture.client.emailOutbox : poison('emailOutbox')
    },
    get emailSuppression() {
      delegateReads.emailSuppression += 1
      return delegateReads.emailSuppression === 1 ? fixture.client.emailSuppression : poison('emailSuppression')
    },
  } as unknown as EmailOutboxClient)

  const delivered: string[] = []
  const result = await drain({
    harness: {
      ...completeHarness(twoFacedClient),
      sendEmail: async (message: { to: string }) => {
        delivered.push(message.to)
        return { success: true as const }
      },
    },
  } as unknown as ProcessEmailOutboxOptions)

  assert.deepEqual(reached, [], `the drain re-read a delegate and got ${reached.join(', ')}`)
  assert.deepEqual(
    delegateReads,
    { emailOutbox: 1, emailSuppression: 1 },
    `the drain re-read the caller's client: ${JSON.stringify(delegateReads)}`,
  )

  // NON-VACUITY: the drain ran the whole body against the fixture — findMany, the claim, the
  // suppression lookup and the fenced terminal write are four separate delegate uses.
  assert.deepEqual(result, { processed: 1, sent: 1, failed: 0, conflicted: 0, conflictedWithoutSend: 0 })
  assert.deepEqual(delivered, ['fixture@example.invalid'])
  assert.equal(fixture.store['row-1'].status, 'SENT')
})

// ===========================================================================================
// ROUND 18 — A WRAPPED PRODUCTION CLIENT. Codex HIGH: the guard asked `value === db`, which is
// ADJACENT to "is this the production client" and is not the same question. `{ emailOutbox:
// db.emailOutbox, emailSuppression: db.emailSuppression }` is a different object that reaches the
// same customer rows, so it PASSED — and with the fake sender, preparer and logger that complete a
// harness, the drain then claimed genuine queued email, delivered nothing, and stamped it SENT.
//
// The fix does not recognise wrappers; it accepts only a client this module MINTED. These proofs
// are therefore about a CLASS, not about the two or three shapes anybody has thought of: every
// case below is structurally perfect and every one is refused, because none of them was minted.
// ===========================================================================================

/**
 * THE DELEGATES A WRAPPER WOULD CARRY, READ LAZILY.
 *
 * `@/lib/db` is mocked here as a Proxy that tripwires on ANY property read, which is what makes
 * "the refusal beat the tripwire to it" measurable. So the wrapper reads `db.emailOutbox` from a
 * getter rather than eagerly: if the guard ever touches the delegates it was offered, `reached`
 * names the global database and the test says so. It never should — `WeakSet.has` reads nothing.
 */
async function productionWrapper(): Promise<[object]> {
  const { db } = await import('@/lib/db')
  const production = db as unknown as Record<string, unknown>
  return [{
    get emailOutbox() { return production.emailOutbox },
    get emailSuppression() { return production.emailSuppression },
  }]
}

/**
 * EACH CASE HANDS BACK A ONE-TUPLE, not the value itself. `return value` from an async function
 * RESOLVES it, and resolving reads `.then` — which on the mocked `@/lib/db` Proxy fires the
 * tripwire before the test has even started. The box keeps the client untouched until the drain
 * touches it (which is the thing being measured).
 */
const UNMINTED_CLIENTS: { name: string; build: () => Promise<[unknown]> }[] = [
  {
    name: 'the bare production client (`client: db`) — refused by the MINT rule now, not by identity',
    build: async () => [(await import('@/lib/db')).db],
  },
  {
    name: 'THE FINDING: `{ emailOutbox: db.emailOutbox, emailSuppression: db.emailSuppression }` — a '
      + 'structural wrapper that is not `db` and writes to the same rows',
    build: productionWrapper,
  },
  {
    name: 'a COPY of a minted client (`{ ...minted }`) — the brand is not a property that travels',
    build: async () => [{ ...(await spyClient()).client }],
  },
  {
    name: 'a Proxy over a minted client — same delegates, same answers, different object',
    build: async () => [new Proxy((await spyClient()).client as object, {})],
  },
  {
    name: 'a client that is structurally PERFECT and simply was never minted',
    build: async () => [unmintedClient()],
  },
]

for (const shape of UNMINTED_CLIENTS) {
  test(`r18 HIGH: REFUSED, and nothing of it is read: ${shape.name}`, async () => {
    const { processPendingEmailOutbox: drain } = await loadOutbox()
    reached.length = 0
    const spy = await spyClient()

    const [client] = await shape.build()
    const harness = { ...completeHarness(spy.client), client }
    const refusal = await drain({ harness } as unknown as ProcessEmailOutboxOptions)
      .then(() => null, (error: unknown) => error)

    // FIRST, AND IT IS THE FINDING. Without the mint rule this call selects the twenty-five oldest
    // eligible rows through the wrapped production delegates and stamps them SENT via `fakeSender`.
    assert.deepEqual(
      reached,
      [],
      `the drain reached ${reached.join(', ')} — the client it was handed was USED, not refused`,
    )
    assert.deepEqual(spy.queries, [], 'the drain issued a query before refusing')
    assert.ok(refusal instanceof Error, 'an unminted client was accepted as a harness client')
    assert.match(refusal.message, /`harness\.client` was NOT MINTED/)
    assert.match(refusal.message, /ALL-OR-NOTHING/)
  })
}

test('r18 NON-VACUITY: a MINTED client is accepted, and the drain runs to a SENT row through it', async () => {
  // Without this the block above could be green because every client is refused, which would be a
  // guard that forbids the harness rather than the mixture.
  const { processPendingEmailOutbox: drain } = await loadOutbox()
  reached.length = 0
  const fixture = await workingClient([{ id: 'row-1', status: 'PENDING' }])
  const delivered: string[] = []

  const result = await drain({
    harness: {
      ...completeHarness(fixture.client),
      sendEmail: async (message: { to: string }) => {
        delivered.push(message.to)
        return { success: true as const }
      },
    },
  } as unknown as ProcessEmailOutboxOptions)

  assert.deepEqual(reached, [], `the accepted drain reached ${reached.join(', ')}`)
  assert.deepEqual(result, { processed: 1, sent: 1, failed: 0, conflicted: 0, conflictedWithoutSend: 0 })
  assert.deepEqual(delivered, ['fixture@example.invalid'])
  assert.equal(fixture.store['row-1'].status, 'SENT')
})

test('r26 THE FINDING: production delegates are REFUSED, and no declaration can change that', async () => {
  // CODEX r25 HIGH, BUILT. The mint used to take a `writesTo: { kind: 'in-memory' }` field and
  // BELIEVE IT, so the call below — the real delegates, declared in-memory — produced a REGISTERED
  // client the drain accepted, and the whole r22-r24 attestation edifice was bypassed without being
  // touched. There is no such field any more: a delegate has to SHOW the array its rows live in and
  // answer a query about a row the mint has just put there, which production cannot do.
  //
  // `@/lib/db` is a tripwire Proxy in this file, so the delegates are modelled here by what the mint
  // can see of a Prisma delegate: every method present, no store to show. The literal
  // `db.emailOutbox` case is driven against the REAL client in
  // tests/email-outbox-claim-fence.test.ts, where `@/lib/db` is not mocked.
  const { createEmailOutboxHarnessClient } = await loadOutbox()
  const production = unmintedClient()

  await assert.rejects(
    () => createEmailOutboxHarnessClient(production as unknown as Parameters<typeof createEmailOutboxHarnessClient>[0]),
    /does not present an in-process row store/,
    'delegates with no store were minted',
  )

  // AND SAYING IT IS IN-MEMORY CHANGES NOTHING, because the word is not read: the field does not
  // exist, and an unknown member is refused BY NAME so a stale caller cannot believe it declared
  // something.
  await assert.rejects(
    () => createEmailOutboxHarnessClient({
      ...production,
      writesTo: { kind: 'in-memory' },
    } as unknown as Parameters<typeof createEmailOutboxHarnessClient>[0]),
    /unknown member\(s\) writesTo/,
    'a `writesTo` declaration was accepted',
  )
})

test('r26: a delegate that REPORTS a store it does not read is refused by the round trip', async () => {
  // The second line of the fix, and the one that matters for a wrapper rather than a bare delegate.
  // A caller can fabricate the witness member — it is exported, not secret — but the sentinel the
  // mint pushes exists ONLY in this process, so a delegate whose reads come from anywhere else
  // cannot hand it back. This double is exactly that: a real array is reported, and `findMany`
  // answers out of a different one (which is what "it reads a database" looks like from here).
  const { createEmailOutboxHarnessClient, EMAIL_OUTBOX_IN_MEMORY_ROWS } = await loadOutbox()
  const reported: Record<string, unknown>[] = []
  const elsewhere: Record<string, unknown>[] = []
  const mintable = await mintableDelegates()

  await assert.rejects(
    () => createEmailOutboxHarnessClient({
      emailOutbox: {
        async findMany(args: unknown) {
          const { where } = args as { where?: { id?: unknown } }
          return elsewhere.filter((row) => row.id === where?.id) as never
        },
        async updateMany() { return { count: 0 } },
        async create() { return {} },
        [EMAIL_OUTBOX_IN_MEMORY_ROWS]: () => reported,
      },
      emailSuppression: mintable.emailSuppression,
    } as unknown as Parameters<typeof createEmailOutboxHarnessClient>[0]),
    /did not return the row this mint had just put into the store it reported/,
    'a delegate that does not read the store it reported was minted',
  )

  // NON-VACUITY: the same shape, reading the array it reports, mints.
  const honest = await createEmailOutboxHarnessClient(
    mintable as unknown as Parameters<typeof createEmailOutboxHarnessClient>[0],
  )
  assert.equal(honest.emailOutbox, mintable.emailOutbox)
})

test('r26: a reported store must be THE store — a fresh copy each call is refused', async () => {
  // A delegate that answers `[EMAIL_OUTBOX_IN_MEMORY_ROWS]` with a snapshot would let the mint push
  // its sentinel into an array nobody reads, and the round trip would then be measuring nothing.
  const { createEmailOutboxHarnessClient, EMAIL_OUTBOX_IN_MEMORY_ROWS } = await loadOutbox()
  const rows: Record<string, unknown>[] = []
  const mintable = await mintableDelegates()

  await assert.rejects(
    () => createEmailOutboxHarnessClient({
      emailOutbox: {
        async findMany(args: unknown) {
          const { where } = args as { where?: { id?: unknown } }
          return rows.filter((row) => row.id === where?.id) as never
        },
        async updateMany() { return { count: 0 } },
        async create() { return {} },
        [EMAIL_OUTBOX_IN_MEMORY_ROWS]: () => [...rows],
      },
      emailSuppression: mintable.emailSuppression,
    } as unknown as Parameters<typeof createEmailOutboxHarnessClient>[0]),
    /returned a DIFFERENT array the second time/,
    'a snapshot was accepted as a store',
  )
})

test('r26: the probe leaves the store exactly as it found it', async () => {
  // The mint writes into a caller's array, which is only acceptable if it puts it back. A sentinel
  // left behind would be a row the drain could claim and "send".
  const { createEmailOutboxHarnessClient } = await loadOutbox()
  const mintable = await mintableDelegates()
  const { EMAIL_OUTBOX_IN_MEMORY_ROWS } = await loadOutbox()
  const outboxStore = (mintable.emailOutbox as unknown as Record<symbol, () => unknown[]>)[EMAIL_OUTBOX_IN_MEMORY_ROWS]()
  const suppressionStore = (mintable.emailSuppression as unknown as Record<symbol, () => unknown[]>)[EMAIL_OUTBOX_IN_MEMORY_ROWS]()
  outboxStore.push({ id: 'pre-existing' })

  await createEmailOutboxHarnessClient(mintable as unknown as Parameters<typeof createEmailOutboxHarnessClient>[0])

  assert.deepEqual(outboxStore, [{ id: 'pre-existing' }], 'the probe left something behind in the outbox store')
  assert.deepEqual(suppressionStore, [], 'the probe left something behind in the suppression store')
})

test('r24: the lane client refuses a destination that is not a string at all', async () => {
  // The door to the replacement, checked here because it needs no server: a call that names no
  // destination cannot be attested and must not reach a pool.
  const { createEmailOutboxLaneClient } = await loadOutbox()
  for (const [why, url] of [
    ['nothing at all', undefined],
    ['null', null],
    ['an empty string', ''],
    ['whitespace', '   '],
    ['a number', 5],
  ] as [string, unknown][]) {
    await assert.rejects(
      () => createEmailOutboxLaneClient({ url } as { url: string }),
      /`url` must be the lane's connection string/,
      `the lane client accepted ${why}`,
    )
  }
})

test('r18: the mint refuses an incomplete client, and r26 refuses one proven only in half', async () => {
  const { createEmailOutboxHarnessClient } = await loadOutbox()
  const mintable = await mintableDelegates()

  await assert.rejects(
    () => createEmailOutboxHarnessClient({
      emailOutbox: mintable.emailOutbox,
      emailSuppression: null,
    } as unknown as Parameters<typeof createEmailOutboxHarnessClient>[0]),
    /`emailSuppression` is null/,
  )
  // BOTH DELEGATES OR NEITHER. A client proven in-memory on one side and taken on trust on the
  // other is the production/harness mixture this surface exists to forbid, one level down.
  await assert.rejects(
    () => createEmailOutboxHarnessClient({
      emailOutbox: mintable.emailOutbox,
      emailSuppression: unmintedClient().emailSuppression,
    } as unknown as Parameters<typeof createEmailOutboxHarnessClient>[0]),
    /`emailSuppression` does not present an in-process row store/,
  )
})

test('r18: a minted client is FROZEN, so its delegates cannot be swapped after the door', async () => {
  // The mint reads each delegate once and returns its own object. If that object were mutable, a
  // caller could hand over a fixture, pass the check, and then assign the production delegate onto
  // the very client the drain holds — the r7 time-of-check/time-of-use defect with an extra step.
  const { createEmailOutboxHarnessClient } = await loadOutbox()
  const delegates = await mintableDelegates()
  const minted = await createEmailOutboxHarnessClient(
    delegates as unknown as Parameters<typeof createEmailOutboxHarnessClient>[0],
  )

  assert.throws(() => {
    'use strict'
    ;(minted as unknown as Record<string, unknown>).emailOutbox = { findMany: async () => [] }
  }, TypeError)
  assert.equal(minted.emailOutbox, delegates.emailOutbox)
})
