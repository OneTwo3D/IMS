import assert from 'node:assert/strict'
import test from 'node:test'
import { decideCreditNoteVoid, voidCreditNote } from '@/lib/connectors/xero/credit-notes'

// o3d-ngmt.22 — voiding the credit note of a deleted refund. No network: every call goes through injected deps.

const ID = 'a1b2c3d4-0000-4000-8000-000000000001'
const note = (over: Record<string, unknown> = {}) => ({ CreditNoteID: ID, CreditNoteNumber: 'CN-2026-00001', Type: 'ACCRECCREDIT', Status: 'AUTHORISED', Allocations: [], Payments: [], ...over })

function deps(reads: Array<{ ok: boolean; status: number; data?: unknown; error?: string }>, postOutcomes: Array<{ ok: boolean; status: number; error?: string }> = [{ ok: true, status: 200 }]) {
  const calls = { get: [] as string[], post: [] as Array<{ path: string; body: unknown; key?: string }> }
  let r = 0
  let p = 0
  return {
    calls,
    deps: {
      get: async <T,>(path: string) => { calls.get.push(path); return reads[Math.min(r++, reads.length - 1)] as { ok: boolean; status: number; data?: T; error?: string } },
      post: async <T,>(path: string, body: unknown, opts?: { idempotencyKey?: string }) => { calls.post.push({ path, body, key: opts?.idempotencyKey }); return postOutcomes[Math.min(p++, postOutcomes.length - 1)] as { ok: boolean; status: number; data?: T; error?: string } },
    },
  }
}

test('decision: an authorised, unallocated credit note is voided; a draft is deleted; a finished one is left alone', () => {
  assert.deepEqual(decideCreditNoteVoid(note(), ID, 'CN-2026-00001'), { action: 'set-status', status: 'VOIDED' })
  assert.deepEqual(decideCreditNoteVoid(note({ Status: 'DRAFT' }), ID), { action: 'set-status', status: 'DELETED' })
  assert.deepEqual(decideCreditNoteVoid(note({ Status: 'SUBMITTED' }), ID), { action: 'set-status', status: 'DELETED' })
  assert.deepEqual(decideCreditNoteVoid(note({ Status: 'VOIDED' }), ID), { action: 'already-done' })
  assert.deepEqual(decideCreditNoteVoid(note({ Status: 'DELETED' }), ID), { action: 'already-done' })
})

test('decision: allocated, paid, wrong type, wrong number, wrong id and unknown status all refuse', () => {
  const refused = (n: unknown, number?: string) => decideCreditNoteVoid(n as never, ID, number)
  assert.equal(refused(note({ Allocations: [{ Amount: 5 }] })).action, 'refuse')
  assert.equal(refused(note({ Payments: [{ Amount: 5 }] })).action, 'refuse')
  assert.equal(refused(note({ Status: 'PAID' })).action, 'refuse')
  assert.equal(refused(note({ Type: 'ACCPAYCREDIT' })).action, 'refuse')
  assert.equal(refused(note(), 'CN-2026-99999').action, 'refuse')
  assert.equal(refused(note({ CreditNoteID: 'someone-else' })).action, 'refuse')
  assert.equal(refused(undefined).action, 'refuse')
  assert.equal(refused(note({ Status: 'WEIRD' })).action, 'refuse')
  const allocated = refused(note({ Allocations: [{ Amount: 5 }] }))
  assert.equal(allocated.action === 'refuse' && allocated.permanent, true)
  assert.match(allocated.action === 'refuse' ? allocated.error : '', /allocated to an invoice or paid out/)
})

test('void: reads first, then writes the status to the document\'s own id, once, under the row\'s idempotency key', async () => {
  const { calls, deps: d } = deps([{ ok: true, status: 200, data: { CreditNotes: [note()] } }])
  const result = await voidCreditNote({ creditNoteId: ID, creditNoteNumber: 'CN-2026-00001' }, { idempotencyKey: 'k-1' }, d)
  assert.deepEqual(result, { success: true })
  assert.deepEqual(calls.get, [`CreditNotes/${ID}`])
  assert.equal(calls.post.length, 1)
  assert.equal(calls.post[0].path, `CreditNotes/${ID}`)
  assert.deepEqual(calls.post[0].body, { CreditNotes: [{ CreditNoteID: ID, Status: 'VOIDED' }] })
  assert.equal(calls.post[0].key, 'k-1')
})

test('void is idempotent: an already voided credit note sends nothing and succeeds (a retry after a lost response)', async () => {
  const { calls, deps: d } = deps([{ ok: true, status: 200, data: { CreditNotes: [note({ Status: 'VOIDED' })] } }])
  const result = await voidCreditNote({ creditNoteId: ID }, undefined, d)
  assert.deepEqual(result, { success: true, alreadyDone: true })
  assert.equal(calls.post.length, 0)
})

test('partial failure resumes: the first write fails, the retry reads the document again and converges', async () => {
  const first = deps([{ ok: true, status: 200, data: { CreditNotes: [note()] } }], [{ ok: false, status: 503, error: 'unavailable' }])
  const failed = await voidCreditNote({ creditNoteId: ID }, undefined, first.deps)
  assert.equal(failed.success, false)
  assert.match(failed.error ?? '', /unavailable/)
  // The retry: the write had in fact landed (a lost response), so the read now says VOIDED and nothing is sent.
  const retry = deps([{ ok: true, status: 200, data: { CreditNotes: [note({ Status: 'VOIDED' })] } }])
  assert.deepEqual(await voidCreditNote({ creditNoteId: ID }, undefined, retry.deps), { success: true, alreadyDone: true })
  assert.equal(retry.calls.post.length, 0)
  // Or it had not landed: the retry writes once and succeeds.
  const again = deps([{ ok: true, status: 200, data: { CreditNotes: [note()] } }], [{ ok: true, status: 200 }])
  assert.equal((await voidCreditNote({ creditNoteId: ID }, undefined, again.deps)).success, true)
  assert.equal(again.calls.post.length, 1)
})

test('a failed or throwing read sends nothing; an unusable id is refused before any call', async () => {
  const bad = deps([{ ok: false, status: 500, error: 'boom' }])
  const failed = await voidCreditNote({ creditNoteId: ID }, undefined, bad.deps)
  assert.equal(failed.success, false)
  assert.equal(bad.calls.post.length, 0)
  const throwing = { get: async () => { throw new Error('socket') }, post: async () => { throw new Error('must not be called') } }
  const thrown = await voidCreditNote({ creditNoteId: ID }, undefined, throwing as never)
  assert.equal(thrown.success, false)
  const noId = deps([])
  assert.equal((await voidCreditNote({ creditNoteId: 'a/b?c' }, undefined, noId.deps)).success, false)
  assert.equal(noId.calls.get.length, 0)
})

test('an allocated credit note is never written to', async () => {
  const { calls, deps: d } = deps([{ ok: true, status: 200, data: { CreditNotes: [note({ Allocations: [{ Amount: 1 }] })] } }])
  const result = await voidCreditNote({ creditNoteId: ID }, undefined, d)
  assert.equal(result.success, false)
  assert.equal(result.permanent, true)
  assert.equal(calls.post.length, 0)
})

test('#1132 R2-MED-2: notSent only when no void can have reached Xero: a failed read, a transport refusal, a 429; never for a timeout after the send', async () => {
  const standing = { ok: true, status: 200, data: { CreditNotes: [note()] } }
  const unreadable = await voidCreditNote({ creditNoteId: ID }, undefined, deps([{ ok: false, status: 0, error: 'Not sent: budget' }]).deps)
  assert.equal(unreadable.success, false)
  assert.equal(unreadable.notSent, true)
  const refusedByTransport = deps([standing], [{ ok: false, status: 0, error: 'held', notSent: 'outbound-write-held' } as never])
  const held = await voidCreditNote({ creditNoteId: ID }, undefined, refusedByTransport.deps)
  assert.equal(held.notSent, true)
  assert.equal(refusedByTransport.calls.post.length, 1)
  const limited = await voidCreditNote({ creditNoteId: ID }, undefined, deps([standing], [{ ok: false, status: 429, error: 'Rate limited' }]).deps)
  assert.equal(limited.notSent, true)
  const rejected = await voidCreditNote({ creditNoteId: ID }, undefined, deps([standing], [{ ok: false, status: 400, error: 'validation' }]).deps)
  assert.equal(rejected.success, false)
  assert.equal(rejected.notSent, undefined, 'a reply Xero gave to a sent void is not a not-sent')
  const thrown = await voidCreditNote({ creditNoteId: ID }, undefined, { get: deps([standing]).deps.get, post: async () => { throw new Error('socket reset') } })
  assert.equal(thrown.notSent, undefined, 'a throw after the request may have left is unknown')
  const allocated = await voidCreditNote({ creditNoteId: ID }, undefined, deps([{ ok: true, status: 200, data: { CreditNotes: [note({ Allocations: [{ Amount: 1 }] })] } }]).deps)
  assert.equal(allocated.notSent, undefined, 'a refusal decided from the document fails as before, it is not a wait')
})

test('#1132 beforePost: asked after the read decided a void, before the POST; a sentence or a throw sends nothing (notSent); an already voided note never asks', async () => {
  const standing = { ok: true, status: 200, data: { CreditNotes: [note()] } }
  const refused = deps([standing])
  let asked = 0
  const r1 = await voidCreditNote({ creditNoteId: ID }, { beforePost: async () => { asked++; return 'the books are locked' } }, refused.deps)
  assert.equal(asked, 1)
  assert.equal(refused.calls.post.length, 0)
  assert.equal(r1.notSent, true)
  assert.match(r1.error ?? '', /the books are locked/)
  const thrown = deps([standing])
  const r2 = await voidCreditNote({ creditNoteId: ID }, { beforePost: async () => { throw new Error('stamp failed') } }, thrown.deps)
  assert.equal(thrown.calls.post.length, 0)
  assert.equal(r2.notSent, true)
  const voided = deps([{ ok: true, status: 200, data: { CreditNotes: [note({ Status: 'VOIDED' })] } }])
  await voidCreditNote({ creditNoteId: ID }, { beforePost: async () => { asked++; return 'never' } }, voided.deps)
  assert.equal(asked, 1, 'not asked: nothing is posted for a credit note already voided')
  const passes = deps([standing])
  const r3 = await voidCreditNote({ creditNoteId: ID }, { idempotencyKey: 'k-2', beforePost: async () => null }, passes.deps)
  assert.deepEqual(r3, { success: true })
  assert.equal(passes.calls.post[0].key, 'k-2')
})
