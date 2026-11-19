import assert from 'node:assert/strict'
import test from 'node:test'

import { listSwitchoverGaps, takeOverGapOrder, type TakeOverDeps } from '@/lib/connectors/mintsoft/switchover/gaps'
import { handBackOne, listHandBackCandidates, runHandBack, type HandBackCandidate, type HandBackDeps } from '@/lib/connectors/mintsoft/switchover/hand-back'
import { runSwitchoverGapsCli } from '../../scripts/switchover-gaps'
import { runHandBackCli } from '../../scripts/switchover-hand-back'

const S = new Date('2027-01-04T00:00:00.000Z')

// ---------------------------------------------------------------- gap list
test('the gap list asks for paid-before-S, unlinked, still-wanted orders and for SHIPPED orders despatched before S, and carries no customer data', async () => {
  const wheres: unknown[] = []
  const db = { salesOrder: { findMany: async (args: { where: Record<string, unknown>; select: Record<string, unknown> }) => { wheres.push(args); return [{ id: 'o1', orderNumber: 'N1', externalOrderNumber: 'W1', paidAt: new Date('2027-01-03T00:00:00Z'), shippedAt: new Date('2027-01-03T12:00:00Z'), shoppingLinks: [{ externalOrderId: '501' }] }] } } }
  const gaps = await listSwitchoverGaps({ since: S, db, readStorefront: async () => ({ status: 'processing', trackingItems: 0 }), pauseMs: 0 })
  assert.deepEqual(gaps.create.map((g) => [g.kind, g.reference]), [['G_create', 'N1']])
  assert.deepEqual(gaps.despatch.map((g) => [g.kind, g.reference]), [['G_despatch', 'N1']])
  const [createArgs, despatchArgs] = wheres as Array<{ where: Record<string, unknown>; select: Record<string, unknown> }>
  assert.deepEqual(createArgs!.where.paidAt, { not: null, lt: S }, 'paid before S')
  assert.deepEqual(createArgs!.where.status, { in: ['PROCESSING', 'ALLOCATED'] }, 'the create fences are the push sweep\'s own')
  assert.equal(createArgs!.where.withdrawalHoldAt, null)
  assert.deepEqual(createArgs!.where.refundStatus, { not: 'FULL' })
  assert.ok(JSON.stringify(createArgs!.where.OR).includes('"wmsOrderPush":{"is":null}'), 'unlinked')
  assert.equal(despatchArgs!.where.status, 'SHIPPED')
  assert.deepEqual(Object.keys(createArgs!.select).sort(), ['externalOrderNumber', 'id', 'orderNumber', 'paidAt', 'shippedAt'])
  assert.deepEqual(despatchArgs!.where.OR, [{ shippedAt: { gte: new Date(S.getTime() - 14 * 86_400_000), lt: S } }, { shippedAt: null, createdAt: { gte: new Date(S.getTime() - 14 * 86_400_000), lt: S } }], 'despatched before S, inside the look-back window; a row with no shippedAt is bounded by createdAt in the same window')
  assert.deepEqual(despatchArgs!.where.refundStatus, { not: 'FULL' })
  assert.equal(gaps.truncated, false)
})

test('G_despatch lists ONLY the shipped orders whose storefront order is still open (completed with or without tracking, refunded and cancelled are closed); an unreadable storefront order is listed and marked', async () => {
  const row = (id: string, link: string) => ({ id, orderNumber: id, externalOrderNumber: null, paidAt: null, shippedAt: new Date('2027-01-03T12:00:00Z'), shoppingLinks: [{ externalOrderId: link }] })
  const rows = [row('done', '1'), row('noTracking', '2'), row('processing', '3'), row('unreadable', '4'), { ...row('nolink', '5'), shoppingLinks: [] }, row('refunded', '6'), row('cancelled', '7')]
  const db = { salesOrder: { findMany: async (args: { where: { status?: string } }) => (args.where.status === 'SHIPPED' ? rows : []) } }
  const states: Record<string, { status: string; trackingItems: number } | null> = { 1: { status: 'completed', trackingItems: 2 }, 2: { status: 'completed', trackingItems: 0 }, 3: { status: 'processing', trackingItems: 0 }, 4: null, 6: { status: 'refunded', trackingItems: 0 }, 7: { status: 'cancelled', trackingItems: 0 } }
  const asked: string[] = []
  const gaps = await listSwitchoverGaps({ since: S, db, pauseMs: 0, readStorefront: async (id) => { asked.push(id); return states[id] ?? null } })
  assert.deepEqual(gaps.despatch.map((g) => [g.reference, g.unreadable === true]), [['processing', false], ['unreadable', true]])
  assert.deepEqual(asked, ['1', '2', '3', '4', '6', '7'], 'every candidate is READ before it is listed')
})

// ---------------------------------------------------------------- take-over
type OrderRow = NonNullable<Awaited<ReturnType<TakeOverDeps['db']['salesOrder']['findUnique']>>>
const order = (over: Partial<OrderRow> = {}): OrderRow => ({ id: 'o1', status: 'PROCESSING', orderNumber: 'N1', externalOrderNumber: 'W1', paidAt: new Date('2027-01-03T00:00:00Z'), shippedAt: null, shipFromWarehouseId: 'wh1', shoppingLinks: [{ externalOrderId: '501' }], wmsOrderPush: null, ...over })
function deps(row: OrderRow | null, over: Partial<TakeOverDeps> = {}) {
  const events: string[] = []
  const d: TakeOverDeps = {
    db: {
      salesOrder: { findUnique: async () => row },
      wmsOrderPushLink: { upsert: async (a: unknown) => { events.push(`upsert ${JSON.stringify(a)}`) } },
      $transaction: async (fn) => fn({}),
    },
    clientId: 89,
    fetchParts: async () => { events.push('read mintsoft'); return [{ externalId: '9001' }] },
    readStorefrontOrder: async () => { events.push('read storefront'); return { status: 'processing', trackingItems: 0 } },
    queueCompletion: async (_tx, input) => { events.push(`queue ${input.orderId} ${input.keyPart}`); return 'key' },
    now: () => new Date('2027-01-04T05:00:00Z'),
    ...over,
  }
  return { d, events }
}

test('G_create dry run reads Mintsoft and writes nothing; --apply adopts the order Mintsoft holds as PENDING_VERIFY (nothing is sent to Mintsoft)', async () => {
  const dry = deps(order())
  assert.deepEqual(await takeOverGapOrder('o1', S, false, dry.d), { outcome: 'would-adopt', kind: 'G_create', externalOrderId: '9001' })
  assert.deepEqual(dry.events, ['read mintsoft'])
  const live = deps(order())
  assert.deepEqual(await takeOverGapOrder('o1', S, true, live.d), { outcome: 'adopted', kind: 'G_create', externalOrderId: '9001' })
  assert.equal(live.events[0], 'read mintsoft', 'READ BEFORE WRITE')
  const write = JSON.parse(live.events[1]!.slice('upsert '.length)) as { create: Record<string, unknown> }
  assert.equal(write.create.state, 'PENDING_VERIFY', 'the push sweep still proves the id is ours')
  assert.equal(write.create.externalOrderId, '9001')
})

test('G_create refuses: nothing in Mintsoft (IMS never creates a pre-S order), several parts (split or merged), already linked, or paid at/after S', async () => {
  const none = deps(order(), { fetchParts: async () => [] })
  const missing = await takeOverGapOrder('o1', S, true, none.d)
  assert.equal(missing.outcome, 'refused')
  assert.match('why' in missing ? missing.why : '', /by hand/)
  assert.equal(none.events.some((e) => e.startsWith('upsert')), false)
  assert.equal((await takeOverGapOrder('o1', S, true, deps(order(), { fetchParts: async () => [{ externalId: '1' }, { externalId: '2' }] }).d)).outcome, 'refused')
  assert.equal((await takeOverGapOrder('o1', S, true, deps(order({ wmsOrderPush: { externalOrderId: '77', state: 'SYNCED' } })).d)).outcome, 'nothing-to-do')
  assert.equal((await takeOverGapOrder('o1', S, true, deps(order({ paidAt: S })).d)).outcome, 'refused', 'paid exactly at S is IMS\'s own')
  assert.equal((await takeOverGapOrder('o1', S, true, deps(null).d)).outcome, 'refused')
})

test('G_create re-checks eligibility at take-over: a cancelled, fully refunded, withdrawal-held, withdrawn or erased order is refused and nothing is read or written', async () => {
  for (const over of [{ status: 'CANCELLED' }, { refundStatus: 'FULL' }, { withdrawalHoldAt: new Date() }, { withdrawalApprovedAt: new Date() }, { erasedAt: new Date() }, { paymentRemovedForeign: {} }] as Array<Partial<OrderRow>>) {
    const d = deps(order(over))
    const r = await takeOverGapOrder('o1', S, true, d.d)
    assert.equal(r.outcome, 'refused', JSON.stringify(over))
    assert.match('why' in r ? r.why : '', /no longer eligible/)
    assert.deepEqual(d.events, [], 'no Mintsoft read, no write')
  }
})

test('G_despatch reads the storefront first: already completed with tracking is nothing to do; otherwise it queues the completion with the obligation time NOW', async () => {
  const done = deps(order({ status: 'SHIPPED', shippedAt: new Date('2027-01-03T00:00:00Z') }), { readStorefrontOrder: async () => ({ status: 'completed', trackingItems: 1 }) })
  assert.equal((await takeOverGapOrder('o1', S, true, done.d)).outcome, 'nothing-to-do')
  assert.equal(done.events.some((e) => e.startsWith('queue')), false)
  const dry = deps(order({ status: 'SHIPPED', shippedAt: new Date('2027-01-03T00:00:00Z') }))
  assert.equal((await takeOverGapOrder('o1', S, false, dry.d)).outcome, 'would-queue')
  assert.deepEqual(dry.events, ['read storefront'])
  const live = deps(order({ status: 'SHIPPED', shippedAt: new Date('2027-01-03T00:00:00Z') }))
  assert.equal((await takeOverGapOrder('o1', S, true, live.d)).outcome, 'queued')
  assert.deepEqual(live.events, ['read storefront', `queue o1 takeover:${S.getTime()}`], 'the key part is stable (S), not the time of the run: --apply twice queues one job')
})

test('G_despatch refuses: storefront unreadable, a shadowed (held) completion, a despatch at or after S, no storefront link', async () => {
  const shipped = order({ status: 'SHIPPED', shippedAt: new Date('2027-01-03T00:00:00Z') })
  assert.equal((await takeOverGapOrder('o1', S, true, deps(shipped, { readStorefrontOrder: async () => null }).d)).outcome, 'refused')
  const shadow = await takeOverGapOrder('o1', S, true, deps(shipped, { queueCompletion: async () => null }).d)
  assert.equal(shadow.outcome, 'refused')
  assert.match('why' in shadow ? shadow.why : '', /hold/)
  assert.equal((await takeOverGapOrder('o1', S, true, deps(order({ status: 'SHIPPED', shippedAt: S })).d)).outcome, 'refused')
  assert.equal((await takeOverGapOrder('o1', S, true, deps(order({ status: 'SHIPPED', shoppingLinks: [] })).d)).outcome, 'refused')
})

// ---------------------------------------------------------------- hand-back
const cand: HandBackCandidate = { orderId: 'o1', reference: 'N1', storefrontId: '501', mintsoftOrderId: '9001', mintsoftOrderNumber: 'N1' }
function handDeps(read: { status: string; metas: Record<string, string | null> } | null, write: { ok: boolean; held?: boolean } = { ok: true }) {
  const writes: Array<Record<string, string>> = []
  const d: HandBackDeps = { readOrder: async () => read, writeMetas: async (_id, metas) => { writes.push(metas); return write } }
  return { d, writes }
}

test('hand-back: an open order with no metas gets BOTH, only with --apply; the dry run reads and writes nothing', async () => {
  const open = { status: 'processing', metas: {} }
  const dry = handDeps(open)
  assert.equal(await handBackOne(cand, false, dry.d), 'would-write')
  assert.equal(dry.writes.length, 0)
  const live = handDeps(open)
  assert.equal(await handBackOne(cand, true, live.d), 'written')
  assert.deepEqual(live.writes, [{ _mintsoft_order_id: '9001', _mintsoft_order_number: 'N1' }])
})

test('hand-back: closed orders are skipped, already-set ones are left alone, and a DIFFERENT value is a conflict that is never overwritten', async () => {
  for (const status of ['completed', 'cancelled', 'refunded', 'failed']) assert.equal(await handBackOne(cand, true, handDeps({ status, metas: {} }).d), 'closed', status)
  const set = handDeps({ status: 'processing', metas: { _mintsoft_order_id: '9001', _mintsoft_order_number: 'N1' } })
  assert.equal(await handBackOne(cand, true, set.d), 'already-set')
  assert.equal(set.writes.length, 0)
  const conflict = handDeps({ status: 'processing', metas: { _mintsoft_order_id: '123', _mintsoft_order_number: null } })
  assert.equal(await handBackOne(cand, true, conflict.d), 'conflict')
  assert.equal(conflict.writes.length, 0)
  assert.equal(await handBackOne(cand, true, handDeps(null).d), 'unreadable')
  assert.equal(await handBackOne(cand, true, handDeps({ status: 'processing', metas: {} }, { ok: false }).d), 'failed')
})

test('hand-back: one held write stops the run (the hold stands for every order) and is reported', async () => {
  const d = handDeps({ status: 'processing', metas: {} }, { ok: false, held: true })
  const result = await runHandBack([cand, { ...cand, orderId: 'o2', storefrontId: '502' }, { ...cand, orderId: 'o3', storefrontId: '503' }], true, d.d)
  assert.equal(result.counts.held, 1)
  assert.equal(d.writes.length, 1, 'no second write was tried')
  assert.equal(result.results.length, 1)
})

test('hand-back candidates: Mintsoft link made by IMS at or after S, open order, WooCommerce link; the select carries no customer data', async () => {
  type Args = { where: Record<string, unknown>; select: Record<string, unknown> }
  let seen: Args | null = null
  const rows = await listHandBackCandidates({ since: S, db: { wmsOrderPushLink: { findMany: async (a: unknown) => { seen = a as Args; return [{ externalOrderId: '9001', externalOrderNumber: 'N1', order: { id: 'o1', orderNumber: 'N1', externalOrderNumber: 'W1', shoppingLinks: [{ externalOrderId: '501' }] } }, { externalOrderId: '9002', externalOrderNumber: null, order: { id: 'o2', orderNumber: null, externalOrderNumber: null, shoppingLinks: [] } }] } } } })
  assert.deepEqual(rows, [cand])
  assert.deepEqual(seen!.where.createdAt, { gte: S })
  assert.deepEqual(seen!.where.externalOrderId, { not: null })
  assert.ok(!JSON.stringify(seen!.select).includes('email') && !JSON.stringify(seen!.select).includes('address'))
})

// ---------------------------------------------------------------- the CLIs
const sink = () => { const lines: string[] = []; return { lines, log: (m: string) => { lines.push(m) }, error: (m: string) => { lines.push(m) } } }

test('switchover:gaps CLI: usage errors exit 3; --apply needs --take-over; S must be readable; a list exits 0', async () => {
  const run = async (argv: string[], env: Record<string, string | undefined> = { MINTSOFT_WRITES_LIVE_FROM: S.toISOString() }) => { const o = sink(); const code = await runSwitchoverGapsCli({ argv, env, stdout: o, stderr: o, disconnect: async () => {}, deps: async () => ({ list: { salesOrder: { findMany: async () => [] } }, takeOver: deps(null).d }) }); return { code, out: o.lines.join('\n') } }
  assert.equal((await run([])).code, 3)
  assert.equal((await run(['--step', 'woocommerce'])).code, 3)
  assert.equal((await run(['--step', 'mintsoft', '--apply'])).code, 3)
  assert.equal((await run(['--step', 'mintsoft', '--bogus'])).code, 3)
  assert.equal((await run(['--step', 'mintsoft'], {})).code, 3)
  const ok = await run(['--step', 'mintsoft'])
  assert.equal(ok.code, 0)
  assert.match(ok.out, /G_create .*: 0/)
  assert.match(ok.out, /G_despatch .*: 0/)
  assert.equal((await run(['--step', 'mintsoft', '--take-over', 'nope'])).code, 1, 'a refused take-over exits 1')
})

test('switchover:hand-back CLI: dry run by default (apply false), exit 1 when a person is needed', async () => {
  const run = async (argv: string[], read: { status: string; metas: Record<string, string | null> } | null) => {
    const o = sink(); const hd = handDeps(read)
    const code = await runHandBackCli({ argv, env: { MINTSOFT_WRITES_LIVE_FROM: S.toISOString() }, stdout: o, stderr: o, disconnect: async () => {}, now: () => new Date('2027-01-05T00:00:00Z'), audit: async () => {}, load: async () => ({ candidates: [cand], deps: hd.d }) })
    return { code, out: o.lines.join('\n'), writes: hd.writes.length }
  }
  const dry = await run([], { status: 'processing', metas: {} })
  assert.deepEqual([dry.code, dry.writes], [0, 0])
  assert.match(dry.out, /DRY RUN/)
  const apply = await run(['--apply', '--writers-stopped'], { status: 'processing', metas: {} })
  assert.deepEqual([apply.code, apply.writes], [0, 1])
  assert.equal((await run(['--apply', '--writers-stopped'], { status: 'processing', metas: { _mintsoft_order_id: '1' } })).code, 1, 'a conflict needs a person')
  assert.equal((await run(['--wat'], null)).code, 3)
})

test('switchover:hand-back CLI: --apply is refused unless the step-M live-from is still set and reached AND the writers are confirmed stopped (hand back FIRST, then unset); an applied run is audited', async () => {
  const audits: unknown[] = []
  const run = async (argv: string[], env: Record<string, string | undefined>) => {
    const o = sink(); const hd = handDeps({ status: 'processing', metas: {} })
    const code = await runHandBackCli({ argv, env, stdout: o, stderr: o, disconnect: async () => {}, now: () => new Date('2027-01-05T00:00:00Z'), audit: async (e) => { audits.push(e) }, load: async () => ({ candidates: [cand], deps: hd.d }) })
    return { code, out: o.lines.join('\n'), writes: hd.writes.length }
  }
  const live = { MINTSOFT_WRITES_LIVE_FROM: S.toISOString() }
  const unset = await run(['--apply', '--writers-stopped', '--since', S.toISOString()], {})
  assert.deepEqual([unset.code, unset.writes], [4, 0])
  assert.match(unset.out, /FIRST, then unset/)
  assert.deepEqual([(await run(['--apply', '--writers-stopped'], {})).code, (await run(['--apply', '--writers-stopped', '--since', S.toISOString()], live)).code], [3, 4], 'no S at all is a usage error; only a --since (the live-from not set) is refused')
  assert.equal((await run(['--apply', '--writers-stopped'], { MINTSOFT_WRITES_LIVE_FROM: '2027-02-01T00:00:00Z' })).code, 4, 'a live-from not yet reached keeps the hold shut')
  const noConfirm = await run(['--apply'], live)
  assert.deepEqual([noConfirm.code, noConfirm.writes], [4, 0])
  assert.match(noConfirm.out, /writers-stopped/)
  assert.equal(audits.length, 0, 'a refused run leaves no audit entry')
  const ok = await run(['--apply', '--writers-stopped'], live)
  assert.deepEqual([ok.code, ok.writes, audits.length], [0, 1, 2], 'an intent row and a completion row')
  assert.deepEqual((audits as Array<{ phase: string }>).map((a) => a.phase), ['intent', 'completed'])
  assert.equal((await run([], {})).code, 3, 'a dry run still needs a readable S')
})

test('switchover:hand-back CLI: the intent row is written BEFORE the writes (a failing one stops them), and a failing completion row does not turn applied writes into a failure', async () => {
  const live = { MINTSOFT_WRITES_LIVE_FROM: S.toISOString() }
  const go = async (audit: (e: { phase: string }) => Promise<void>) => {
    const o = sink(); const hd = handDeps({ status: 'processing', metas: {} })
    const code = await runHandBackCli({ argv: ['--apply', '--writers-stopped'], env: live, stdout: o, stderr: o, disconnect: async () => {}, now: () => new Date('2027-01-05T00:00:00Z'), audit: audit as never, load: async () => ({ candidates: [cand], deps: hd.d }) })
    return { code, writes: hd.writes.length, out: o.lines.join('\n') }
  }
  const noIntent = await go(async () => { throw new Error('db down') })
  assert.deepEqual([noIntent.code, noIntent.writes], [5, 0], 'no intent row, no writes')
  const noCompletion = await go(async (e) => { if (e.phase === 'completed') throw new Error('db down') })
  assert.deepEqual([noCompletion.code, noCompletion.writes], [0, 1])
  assert.match(noCompletion.out, /completion audit row could not be written/)
})
