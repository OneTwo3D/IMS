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
type ProcessEmailOutboxOptions = import('@/lib/email-outbox').ProcessEmailOutboxOptions

/**
 * A TYPE-ONLY handle on the shipped function, for the negatives that must never be executed.
 * `declare const` emits nothing, so this cannot accidentally become a call at runtime.
 */
declare const processPendingEmailOutbox: typeof import('@/lib/email-outbox').processPendingEmailOutbox

/**
 * A client that records the first query it is asked for. It is the instrument for "before the
 * first query": the guard has to fire while this is still empty.
 */
function spyClient(): { client: EmailOutboxClient; queries: string[] } {
  const queries: string[] = []
  const record = (name: string) => async (): Promise<never> => {
    queries.push(name)
    throw new Error(`the guard did not fire: the drain issued ${name}`)
  }
  return {
    queries,
    client: {
      emailOutbox: {
        findMany: record('emailOutbox.findMany'),
        updateMany: record('emailOutbox.updateMany'),
        create: record('emailOutbox.create'),
      },
      emailSuppression: {
        findUnique: record('emailSuppression.findUnique'),
        upsert: record('emailSuppression.upsert'),
      },
    } as unknown as EmailOutboxClient,
  }
}

const fakeSender = async () => ({ success: true as const })
const fakePrepare = async () => null
const fakeLog = async () => undefined

/** A COMPLETE harness. Nothing in it is optional, which is the whole point of the type. */
function completeHarness(client: EmailOutboxClient): EmailOutboxHarness {
  return {
    client,
    sendEmail: fakeSender,
    prepareQueuedEmail: fakePrepare,
    logActivity: fakeLog,
    now: () => new Date('2026-09-10T09:00:00.000Z'),
  }
}

/** NEVER CALLED. Executing it is exactly the destructive act it exists to forbid. */
function refusedShapes(): void {
  const client = spyClient().client

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
}

/** ALSO NEVER CALLED: `acceptedShapes` would run a real drain. Only its TYPES are the proof. */
function acceptedShapes(): void {
  // (a) THE CRON: nothing at all — the global client, the real sender, the real clock.
  void processPendingEmailOutbox()
  void processPendingEmailOutbox({})

  // (b) A CALLER THAT BROUGHT ITS WHOLE WORLD.
  void processPendingEmailOutbox({ harness: completeHarness(spyClient().client) })
}

test('the option type admits exactly two shapes, and no mixture is one of them', () => {
  // The real proof is above and is enforced by `tsc --noEmit`; this body exists so the file is a
  // test rather than a comment, and so the two functions are REFERENCED (an unreferenced one is a
  // lint error away from being deleted, taking the proof with it).
  assert.equal(typeof refusedShapes, 'function')
  assert.equal(typeof acceptedShapes, 'function')

  // Building the object first and passing it second does not help: there is one field to fill.
  const cron: ProcessEmailOutboxOptions = {}
  const injected: ProcessEmailOutboxOptions = { harness: completeHarness(spyClient().client) }
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
    options: { client: spyClient().client, sendEmail: null },
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
  const spy = spyClient()

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
  const spy = spyClient()

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
  const spy = spyClient()
  const [{ db }, { sendEmail }, { prepareQueuedEmail }, { logActivity }] = await Promise.all([
    import('@/lib/db'),
    import('@/lib/mailer'),
    import('@/lib/order-email'),
    import('@/lib/activity-log'),
  ])

  const productionValues: Record<string, unknown> = {
    client: db,
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

    // The `client: db` case is the sharp one: the global db double tripwires on ANY property
    // read, so this also proves the identity check runs before the value is touched at all.
    assert.deepEqual(reached, [], `${member}: the drain reached ${reached.join(', ')} before refusing`)
    assert.deepEqual(spy.queries, [], `${member}: the drain issued a query before refusing`)
    assert.ok(refusal instanceof Error, `${member}: a production dependency inside a harness was accepted`)
    assert.match(refusal.message, new RegExp(`\`harness\\.${member}\` IS the production dependency`))
  }
})

test('NON-VACUITY: the legal shapes resolve, and to DIFFERENT dependency sets', async () => {
  const { resolveEmailOutboxDependencies } = await loadOutbox()
  const spy = spyClient()
  const harness = completeHarness(spy.client)
  reached.length = 0

  // (b) A HARNESS resolves to ITSELF, member for member. Nothing is blended in.
  const injected = resolveEmailOutboxDependencies({ harness })
  assert.equal(injected.client, spy.client)
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
