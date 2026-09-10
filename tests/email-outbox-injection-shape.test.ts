/**
 * o3d-alnk r3/r4 (Codex HIGH) — THE HALF-INJECTED DRAIN MUST NOT COMPILE, AND MUST NOT RUN.
 *
 * THE HAZARD. `client` and `sendEmail` were once independently optional on
 * `ProcessEmailOutboxOptions`, each defaulting to the global when absent, so this type-checked:
 *
 *   processPendingEmailOutbox({ sendEmail: fake })
 *
 * `processPendingEmailOutbox` is a SWEEP — it selects the globally oldest eligible rows, not the
 * caller's rows — so that call drains REAL queued customer email through a sender that delivers
 * nothing and stamps every row SENT. The row afterwards is indistinguishable from a delivery, so
 * the loss is silent and unrecoverable. The mirror, `{ client: double }`, hands a test's rows to
 * the REAL mailer, and that one actually puts a message on the wire.
 *
 * ROUND 3 MADE IT A UNION AND ARGUED THAT WAS ENOUGH: "a runtime guard still lets the call be
 * WRITTEN, and only objects once execution has reached it — but reaching it IS the damage."
 * That is an argument for having the type. It is not an argument against ALSO having the check,
 * and Codex was right that it left a hole: a type-only negative protects nothing from
 * `as ProcessEmailOutboxOptions`, from `any`, from an options object widened through a helper, or
 * from a JavaScript caller. Round 4 keeps the union and adds `assertBothOrNeitherInjected`, which
 * runs BEFORE the first query.
 *
 * ROUND 4 ALSO TOOK THE HARNESS OVERRIDES OFF THE AMBIENT ARM. `now`, `prepareQueuedEmail` and
 * `logActivity` used to ride on both arms on the reasoning that none of them decides which rows
 * the drain reaches or whether a message leaves the building. Both halves of that were false:
 * `now` IS the eligibility and stale-reclaim predicate (a future `now` reclaims a row whose
 * holder is still on the socket and mails a second copy), and `prepareQueuedEmail` IS the
 * recipient, the body and the PDF (returning `null` sends the stored placeholder without its
 * attachment). Neither has a production caller, so neither is spellable on the cron's arm now.
 *
 * SO THE FILE PROVES THREE THINGS, IN THREE DIFFERENT WAYS:
 *
 *   COMPILE TIME. Each negative carries `@ts-expect-error`. Relax the union and the line
 *   compiles, the directive becomes unused, and `tsc --noEmit` fails with TS2578. The proof is
 *   carried by the gate's type-check step, not by an assertion anyone can weaken.
 *
 *   RUNTIME, THROUGH THE SHIPPED FUNCTION. The two casts are actually EXECUTED here, which is
 *   only safe because `@/lib/db` and `@/lib/mailer` are mocked to modules that THROW on any use.
 *   That is what makes "refused before the first query" an observation rather than a claim: if
 *   the guard were removed, the failure is not a missing throw, it is the drain reaching the
 *   global database or the real mailer, and the mock says so by name.
 *
 *   Note the SPELLING of those casts: `as unknown as ProcessEmailOutboxOptions`. A plain
 *   `as ProcessEmailOutboxOptions` is itself refused by tsc (TS2352 — neither arm sufficiently
 *   overlaps a half-injection), which is a further point in the union's favour and is why the
 *   double cast is written out here rather than tidied away. `any`, a JavaScript caller and an
 *   options object widened through a helper get to the same place without even that much.
 *
 *   NON-VACUITY. The two legal shapes are accepted by the same guard, so the assertions above
 *   are not passing because everything is refused.
 */

import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * THE GLOBALS THE HAZARD REACHES FOR, REPLACED BY TRIPWIRES. Nothing here is a stub that quietly
 * returns: every one throws with a name, so a regression reports WHICH production dependency the
 * half-injected drain got to, instead of a generic assertion failure.
 */
const reached: string[] = []

function tripwire(what: string): never {
  reached.push(what)
  throw new Error(`the half-injected drain reached ${what}`)
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

mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => undefined } })
mock.module('@/lib/order-email', { namedExports: { prepareQueuedEmail: async () => null } })

/**
 * Loaded INSIDE the tests, never at the top level: a static import is hoisted above the
 * `mock.module` calls and would pull in the real `@/lib/db`, and a top-level `await import` is
 * rejected outright by the tsx/CJS transform this suite runs under.
 */
const loadOutbox = () => import('@/lib/email-outbox')

type EmailOutboxClient = import('@/lib/email-outbox').EmailOutboxClient
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

const someClient = null as unknown as EmailOutboxClient
const fakeSender = async () => ({ success: true as const })

/** NEVER CALLED. Executing it is exactly the destructive act it exists to forbid. */
function refusedShapes(): void {
  // @ts-expect-error a fake sender may not be pointed at the GLOBAL queue: `client` is required alongside it
  void processPendingEmailOutbox({ sendEmail: fakeSender })

  // @ts-expect-error and the mirror — a test's own rows may not be handed to the REAL mailer
  void processPendingEmailOutbox({ client: someClient })

  // @ts-expect-error the same half-injection dressed up with a harness override is still a half-injection
  void processPendingEmailOutbox({ sendEmail: fakeSender, now: () => new Date(), logActivity: async () => undefined })

  // @ts-expect-error an explicit `client: undefined` does not buy the injected arm out of its client either
  void processPendingEmailOutbox({ client: undefined, sendEmail: fakeSender })

  // @ts-expect-error r4: `now` decides eligibility and stale reclamation, so the CRON may not carry one
  void processPendingEmailOutbox({ now: () => new Date() })

  // @ts-expect-error r4: `prepareQueuedEmail` decides the recipient, the body and the PDF
  void processPendingEmailOutbox({ prepareQueuedEmail: async () => null })

  // @ts-expect-error r4: and the activity log is not an ambient override either
  void processPendingEmailOutbox({ logActivity: async () => undefined })
}

/** ALSO NEVER CALLED: `acceptedShapes` would run a real drain. Only its TYPES are the proof. */
function acceptedShapes(): void {
  // (a) THE CRON: nothing injected at all — the global client, the real sender, the real clock.
  void processPendingEmailOutbox()
  void processPendingEmailOutbox({})

  // (b) A TEST: both halves together, and only then may the clock and the preparer ride along.
  void processPendingEmailOutbox({ client: someClient, sendEmail: fakeSender })
  void processPendingEmailOutbox({
    client: someClient,
    sendEmail: fakeSender,
    now: () => new Date(),
    prepareQueuedEmail: async () => null,
    logActivity: async () => undefined,
  })
}

test('the option type admits exactly two shapes, and no half-injection is one of them', () => {
  // The real proof is above and is enforced by `tsc --noEmit`; this body exists so the file is a
  // test rather than a comment, and so the two functions are REFERENCED (an unreferenced one is a
  // lint error away from being deleted, taking the proof with it).
  assert.equal(typeof refusedShapes, 'function')
  assert.equal(typeof acceptedShapes, 'function')

  // A variable of the union type still has to pick an arm, so the hazard is not reachable by
  // building the object first and passing it second either.
  const cron: ProcessEmailOutboxOptions = {}
  const injected: ProcessEmailOutboxOptions = { client: someClient, sendEmail: fakeSender }
  assert.equal(cron.client, undefined)
  assert.equal(injected.sendEmail, fakeSender)
})

test('a FAKE SENDER cast past the union is refused before the drain reads a single row (o3d-alnk r4)', async () => {
  const { processPendingEmailOutbox } = await loadOutbox()
  reached.length = 0

  const refusal = await processPendingEmailOutbox({ sendEmail: fakeSender } as unknown as ProcessEmailOutboxOptions)
    .then(() => null, (error: unknown) => error)

  // THE ASSERTION THAT MATTERS COMES FIRST, and it is about WHAT DID NOT HAPPEN. Without the
  // guard this call selects the twenty-five oldest eligible rows from the global database and
  // stamps them SENT, so the failure to report is "it reached the global database" — not
  // "it did not throw". Asserting the throw first would report the wrong thing.
  assert.deepEqual(reached, [], `the drain reached a production dependency before refusing: ${reached.join(', ')}`)

  assert.ok(refusal instanceof Error, 'the cast reached the drain and the drain accepted it')
  assert.match(refusal.message, /must be injected TOGETHER or not at all/)
  assert.match(refusal.message, /a sendEmail with no client/)
})

test('a TEST CLIENT cast past the union is refused before the real mailer is reached (o3d-alnk r4)', async () => {
  const { processPendingEmailOutbox } = await loadOutbox()
  reached.length = 0
  const spy = spyClient()

  const refusal = await processPendingEmailOutbox({ client: spy.client } as unknown as ProcessEmailOutboxOptions)
    .then(() => null, (error: unknown) => error)

  // "Before the first query" is MEASURED, not asserted in prose: the spy client records every call
  // it is asked for, and the guard has to fire while that record is still empty. Both measurements
  // come before the assertion about the error, so a regression names the damage rather than the
  // missing throw.
  assert.deepEqual(spy.queries, [], `the drain issued a query before refusing: ${spy.queries.join(', ')}`)
  assert.deepEqual(reached, [], `the drain reached a production dependency before refusing: ${reached.join(', ')}`)

  assert.ok(refusal instanceof Error, 'the mirror cast reached the drain and the drain accepted it')
  assert.match(refusal.message, /must be injected TOGETHER or not at all/)
  assert.match(refusal.message, /a client with no sendEmail/)
})

test('the runtime guard accepts both legal shapes, so it is not refusing everything (o3d-alnk r4)', async () => {
  const { assertBothOrNeitherInjected } = await loadOutbox()
  // NON-VACUITY. `assertBothOrNeitherInjected` is called directly here rather than through the
  // drain, because the accepted shapes are exactly the ones it would be destructive to run.
  assert.doesNotThrow(() => assertBothOrNeitherInjected({}))
  assert.doesNotThrow(() => assertBothOrNeitherInjected({ client: someClient, sendEmail: fakeSender }))
  assert.doesNotThrow(() => assertBothOrNeitherInjected({
    client: someClient,
    sendEmail: fakeSender,
    now: () => new Date(),
    prepareQueuedEmail: async () => null,
    logActivity: async () => undefined,
  }))

  // And an explicit `undefined` on either half is the ABSENT case, not the present one — the
  // guard reads values, not keys, so `{ client: undefined, sendEmail: fake }` is still refused.
  assert.throws(
    () => assertBothOrNeitherInjected({ client: undefined, sendEmail: fakeSender } as unknown as ProcessEmailOutboxOptions),
    /a sendEmail with no client/,
  )
  assert.throws(
    () => assertBothOrNeitherInjected({ client: someClient, sendEmail: undefined } as unknown as ProcessEmailOutboxOptions),
    /a client with no sendEmail/,
  )
})
