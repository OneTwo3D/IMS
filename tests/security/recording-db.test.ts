import assert from 'node:assert/strict'
import test from 'node:test'

import { createRecordingDb, type QueryContext } from './recording-db'

/**
 * o3d-512h round 3, Codex finding 6 — tests for the RECORDER itself.
 *
 * The finding was that the refusal tests in this directory "assert a refusal but
 * the recording proxy does not actually establish that no read occurred". An
 * empty touch list is also what an unwired mock produces, so `assert.deepEqual(
 * dbTouches, [])` was passing on the strength of nothing having been observed.
 *
 * The same lesson as o3d-hic9 applies to the fix: a mechanism whose own logic is
 * untested is one you are trusting rather than checking. These fixtures pin the
 * two properties the refusal tests now rely on — that an unproved recorder
 * REFUSES to certify silence, and that a proved one notices a read that never
 * became a call.
 */

test('assertNoReads REFUSES to certify silence before the recorder has proved itself', async () => {
  // The whole finding, executable. Without this, an unwired mock and a genuine
  // refusal are indistinguishable.
  const recorder = createRecordingDb()
  assert.throws(
    () => recorder.assertNoReads('a refusal nobody was watching'),
    /has not been proved to observe/,
  )
})

test('prove() fails loudly when the call it was given reads nothing', async () => {
  const recorder = createRecordingDb()
  await assert.rejects(
    () => recorder.prove(async () => 'no database here'),
    /observed NOTHING/,
  )
  // …and the recorder stays unproved, so nothing downstream silently passes.
  assert.throws(() => recorder.assertNoReads('still unproved'), /has not been proved/)
})

test('once proved, assertNoReads passes on a genuinely untouched path', async () => {
  const recorder = createRecordingDb()
  const db = recorder.db as Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>>
  await recorder.prove(() => db.setting.findMany({}))
  recorder.reset()
  recorder.assertNoReads('a refusal that really refused')
})

test('once proved, assertNoReads FAILS on a path that did read', async () => {
  const recorder = createRecordingDb()
  const db = recorder.db as Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>>
  await recorder.prove(() => db.setting.findMany({}))
  recorder.reset()
  await db.user.findMany({})
  assert.throws(() => recorder.assertNoReads('leaky guard'), /user\.findMany/)
})

test('a model REACHED but never queried is still recorded — a guard that throws mid-expression', async () => {
  // `db.setting` resolved and then the guard threw before `.findMany(...)` ran.
  // Nothing leaked, but a recorder that only counted invocations would report the
  // same empty list as one that saw nothing at all, and the two are not the same
  // fact.
  const recorder = createRecordingDb()
  const db = recorder.db as Record<string, unknown>
  await recorder.prove(() => (db.setting as Record<string, (...a: unknown[]) => Promise<unknown>>).findMany({}))
  recorder.reset()
  void db.setting
  assert.throws(() => recorder.assertNoReads('half a query'), /reached \[setting\]/)
})

test('the result may be a function of the query, so row-ownership can be tested', async () => {
  // What makes the supplier cross-tenant probe expressible: hand the action a row
  // that belongs to someone else and watch the ownership check, rather than the
  // permission check, decide.
  const recorder = createRecordingDb((ctx: QueryContext) => ({ model: ctx.model, op: ctx.op }))
  const db = recorder.db as Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>>
  assert.deepEqual(await db.purchaseOrder.findUnique({ where: { id: 'x' } }), {
    model: 'purchaseOrder',
    op: 'findUnique',
  })
  recorder.assertCalls(['purchaseOrder.findUnique'])
})

type Client = Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>>

test('$transaction hands the callback a recording client too', async () => {
  const recorder = createRecordingDb()
  const db = recorder.db as { $transaction: (cb: (tx: Client) => unknown) => Promise<unknown> }
  await db.$transaction(async (tx: Client) => {
    await tx.passkey.create({})
  })
  assert.deepEqual(recorder.calls, ['$transaction', 'passkey.create'])
})
