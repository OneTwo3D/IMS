/**
 * o3d-alnk r3 (Codex HIGH) — THE HALF-INJECTED DRAIN MUST NOT COMPILE.
 *
 * Round 2 fixed the TEST and left the HAZARD representable. `client` and `sendEmail` were
 * independently optional on `ProcessEmailOutboxOptions`, each defaulting to the global when
 * absent, so this still type-checked:
 *
 *   processPendingEmailOutbox({ sendEmail: fake })
 *
 * `processPendingEmailOutbox` is a SWEEP — it selects the globally oldest eligible rows, not the
 * caller's rows — so that call drains REAL queued customer email through a sender that delivers
 * nothing and stamps every row SENT. The row afterwards is indistinguishable from a delivery, so
 * the loss is silent and unrecoverable. The mirror, `{ client: double }`, hands a test's rows to
 * the REAL mailer.
 *
 * WHY THIS FILE AND NOT A RUNTIME GUARD. A runtime guard still lets the call be WRITTEN, and only
 * objects once execution has reached it — but reaching it IS the damage, and the drain is a cron
 * body that nobody watches. The option type is a discriminated union instead, so the omission is
 * unrepresentable rather than defaulted.
 *
 * HOW THIS FILE FAILS. Each negative below carries `@ts-expect-error`. If the union is ever
 * relaxed back to two optional fields, the line COMPILES, the directive becomes unused, and
 * `tsc --noEmit` fails with TS2578 "Unused '@ts-expect-error' directive". The proof is therefore
 * carried by the type-check step of the gate, not by an assertion anyone can weaken.
 *
 * NOTHING IN `refusedShapes` IS EVER CALLED. It is a type-level fixture: executing it is exactly
 * the destructive act it exists to forbid, so it is declared and referenced, never invoked.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  processPendingEmailOutbox,
  type EmailOutboxClient,
  type ProcessEmailOutboxOptions,
} from '@/lib/email-outbox'

/** Never dereferenced — only its TYPE is used, in calls that never run. */
const someClient = null as unknown as EmailOutboxClient
const fakeSender = async () => ({ success: true as const })

function refusedShapes(): void {
  // @ts-expect-error a fake sender may not be pointed at the GLOBAL queue: `client` is required alongside it
  void processPendingEmailOutbox({ sendEmail: fakeSender })

  // @ts-expect-error and the mirror — a test's own rows may not be handed to the REAL mailer
  void processPendingEmailOutbox({ client: someClient })

  // @ts-expect-error the same half-injection dressed up with the harness overrides is still a half-injection
  void processPendingEmailOutbox({ sendEmail: fakeSender, now: () => new Date(), logActivity: async () => undefined })

  // @ts-expect-error an explicit `client: undefined` does not buy the injected arm out of its client either
  void processPendingEmailOutbox({ client: undefined, sendEmail: fakeSender })
}

function acceptedShapes(): void {
  // (a) THE CRON: nothing injected — the global client and the real sender, together.
  void processPendingEmailOutbox()
  void processPendingEmailOutbox({})

  // (b) A TEST: both halves, together. The harness overrides ride along on either arm.
  void processPendingEmailOutbox({ client: someClient, sendEmail: fakeSender })
  void processPendingEmailOutbox({
    client: someClient,
    sendEmail: fakeSender,
    now: () => new Date(),
    prepareQueuedEmail: async () => null,
    logActivity: async () => undefined,
  })
}

test('the option type admits exactly two shapes, and neither half-injection is one of them', () => {
  // The real proof is above and is enforced by `tsc --noEmit`; this body exists so the file is a
  // test rather than a comment, and so the two functions are REFERENCED (an unreferenced one is a
  // lint error away from being deleted, taking the proof with it). Neither is CALLED: calling
  // `acceptedShapes` would run a real drain against the real database with the real mailer.
  assert.equal(typeof refusedShapes, 'function')
  assert.equal(typeof acceptedShapes, 'function')

  // A variable of the union type still has to pick an arm, so the hazard is not reachable by
  // building the object first and passing it second either.
  const cron: ProcessEmailOutboxOptions = { now: () => new Date() }
  const injected: ProcessEmailOutboxOptions = { client: someClient, sendEmail: fakeSender }
  assert.equal(cron.client, undefined)
  assert.equal(injected.sendEmail, fakeSender)
})
