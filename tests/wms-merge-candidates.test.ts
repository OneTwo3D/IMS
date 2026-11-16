import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MERGE_SNAPSHOT_MAX_AGE_MS,
  MERGE_WARNING_EU,
  MERGE_WARNING_FEDEX,
  findMergeCandidateGroups,
  mergeIneligibleReason,
  mergeMatchKey,
  normaliseMergeCountry,
  normaliseMergeEmail,
  normaliseMergeText,
  type MergeCandidateContext,
  type MergeCandidateOrder,
  type MergeGroup,
} from '../lib/domain/wms/merge-candidate-match.ts'
import { parseWmsMergeCandidateMode } from '../lib/domain/wms/merge-candidate-mode.ts'
import { mergeCandidateQuery, wmsOperatorTaskHash } from '../lib/domain/wms/operator-tasks.ts'
import {
  MERGE_TASK_REASON,
  MERGE_TASK_SYSTEM_ACTOR,
  listMergeCandidateGroups,
  mergeGroupTaskText,
  runMergeCandidateDetection,
  runMergeCandidateDetectionSafe,
  type MergeCandidatePort,
  type MergeTaskOutcome,
} from '../lib/domain/wms/merge-candidates.ts'

/**
 * MERGE CANDIDATES (flag mode). Synthetic data only; no database, no network. The port is an in-memory double that records every write, so
 * "mode off writes nothing" is an assertion on the record, not on a mock call count.
 */

const NOW = new Date('2026-11-16T12:00:00Z')
const CTX: MergeCandidateContext = { connectorId: 'mintsoft', tenantScoped: true, now: NOW }

let counter = 0
function order(over: Partial<MergeCandidateOrder> & { extId?: string; email?: string; street?: string; line2?: string; city?: string; postcode?: string; country?: string } = {}): MergeCandidateOrder {
  counter += 1
  const { extId, email, street, line2, city, postcode, country, ...rest } = over
  const id = `o${counter}`
  const address = { address1: street ?? '1 Test Street', line2: line2 ?? '', city: city ?? 'Testville', postcode: postcode ?? 'AB1 2CD', country: country ?? 'GB' }
  return {
    orderId: id,
    orderNumber: `T-${1000 + counter}`,
    createdAt: new Date(NOW.getTime() - 60_000 * (100 - counter)),
    status: 'PROCESSING',
    shippedAt: null,
    refundStatus: 'NONE',
    withdrawalHoldAt: null,
    withdrawalApprovedAt: null,
    erasedAt: null,
    archived: false,
    customerName: 'Test Customer',
    customerEmail: email ?? 'buyer@example.test',
    billingAddress: { ...address, email: email ?? 'buyer@example.test' },
    shippingAddress: { ...address },
    courierText: ['Royal Mail'],
    link: { connector: 'mintsoft', state: 'SYNCED', externalOrderId: extId ?? `w-${id}`, externalOrderNumber: `W${counter}` },
    snapshot: {
      connector: 'mintsoft', status: 'NEW', externalOrderId: extId ?? `w-${id}`, externalOrderNumber: `W${counter}`,
      isSplit: false, fetchedAt: new Date(NOW.getTime() - 5 * 60_000), lastError: null,
    },
    ...rest,
  }
}

const ids = (groups: MergeGroup[]) => groups.map((group) => group.members.map((member) => member.orderId))

test('normalisation ignores case, spacing, punctuation and accents', () => {
  assert.equal(normaliseMergeText('  12-A,  Rue de l\'Église. '), '12aruedeleglise')
  assert.equal(normaliseMergeText('AB1 2CD'), normaliseMergeText('ab12cd'))
  assert.equal(normaliseMergeEmail('  Buyer@Example.TEST '), 'buyer@example.test')
  assert.equal(normaliseMergeCountry('uk'), 'GB')
  for (const code of ['GB', 'XI', 'NI', 'JE', 'GG', 'IM']) assert.equal(normaliseMergeCountry(code), 'GB', `${code} counts as UK`)
  assert.equal(normaliseMergeCountry('el'), 'GR')
  assert.equal(normaliseMergeCountry('fr'), 'FR')
})

test('same email and address in different case, spacing and punctuation form a group; a different value does not', () => {
  const a = order({})
  const b = order({ email: 'BUYER@example.test', street: '1  TEST street.', postcode: 'ab1-2cd', city: 'testville' })
  const c = order({ street: '2 Test Street' })
  const d = order({ email: 'other@example.test' })
  assert.deepEqual(ids(findMergeCandidateGroups([a, b, c, d], CTX)), [[a.orderId, b.orderId]])
})

test('line 2, city, postcode and country each separate groups', () => {
  const base = order({})
  for (const change of [{ line2: 'Flat 2' }, { city: 'Elsewhere' }, { postcode: 'ZZ9 9ZZ' }, { country: 'FR' }]) {
    assert.deepEqual(findMergeCandidateGroups([base, order(change)], CTX), [], JSON.stringify(change))
  }
})

test('the billing email is used, falling back to the customer email', () => {
  const a = order({})
  const b = order({ billingAddress: { address1: '1 Test Street', city: 'Testville', postcode: 'AB1 2CD', country: 'GB' }, customerEmail: 'Buyer@Example.test' })
  assert.equal(findMergeCandidateGroups([a, b], CTX).length, 1)
  const noEmail = order({ billingAddress: { address1: '1 Test Street', city: 'Testville', postcode: 'AB1 2CD', country: 'GB' }, customerEmail: null })
  assert.equal(mergeMatchKey(noEmail), null)
})

test('the delivery address falls back to billing when the shipping address has no street line; the UK-like countries are one country', () => {
  const a = order({})
  const b = order({ shippingAddress: { address1: '', city: 'Nowhere', postcode: 'ZZ1 1ZZ', country: 'FR' } })
  assert.equal(findMergeCandidateGroups([a, b], CTX).length, 1, 'billing used for b')
  const c = order({ country: 'JE' })
  const d = order({ country: 'GB' })
  assert.equal(findMergeCandidateGroups([c, d], CTX).length, 1, 'JE and GB are both UK')
  const noStreet = order({ billingAddress: { address1: '', email: 'buyer@example.test' }, shippingAddress: { address1: '' } })
  assert.equal(mergeMatchKey(noStreet), null)
})

test('every exclusion removes the order from the group', () => {
  const partner = order({})
  const cases: Array<[string, Partial<MergeCandidateOrder>]> = [
    ['not open: shipped', { shippedAt: NOW }],
    ['not open: on hold', { status: 'ON_HOLD' }],
    ['not open: cancelled', { status: 'CANCELLED' }],
    ['not open: draft', { status: 'DRAFT' }],
    ['not open: archived', { archived: true }],
    ['not open: erased', { erasedAt: NOW }],
    ['fully refunded', { refundStatus: 'FULL' }],
    ['pending withdrawal', { withdrawalHoldAt: NOW }],
    ['approved withdrawal', { withdrawalApprovedAt: NOW }],
    ['no warehouse status', { snapshot: null }],
    ['not live in the warehouse', { link: { connector: 'mintsoft', state: 'CANCELLED', externalOrderId: 'x', externalOrderNumber: 'x' } }],
  ]
  for (const [label, change] of cases) {
    const excluded = order(change)
    assert.notEqual(mergeIneligibleReason(excluded, CTX), null, label)
    assert.deepEqual(findMergeCandidateGroups([partner, excluded], CTX), [], label)
  }
  // The caller excludes a backordered order.
  const backordered = order({})
  assert.deepEqual(findMergeCandidateGroups([partner, backordered], { ...CTX, excludedOrderIds: new Set([backordered.orderId]) }), [])
  assert.equal(mergeIneligibleReason(backordered, { ...CTX, excludedOrderIds: new Set([backordered.orderId]) }), 'backordered line')
})

test('the warehouse gate: only NEW, fresh, unsplit, error-free snapshots that agree with the link', () => {
  const partner = order({})
  const snap = (over: Partial<NonNullable<MergeCandidateOrder['snapshot']>>) => {
    const o = order({})
    return { ...o, snapshot: { ...o.snapshot!, ...over } }
  }
  for (const [label, o] of [
    ['picking', snap({ status: 'PICKING' })],
    ['despatched', snap({ status: 'DESPATCHED' })],
    ['empty status', snap({ status: '' })],
    ['split', snap({ isSplit: true })],
    ['lookup error', snap({ lastError: 'Order not found in WMS' })],
    ['stale', snap({ fetchedAt: new Date(NOW.getTime() - MERGE_SNAPSHOT_MAX_AGE_MS - 1) })],
    ['other connector', snap({ connector: 'other' })],
    ['id differs from the link', snap({ externalOrderId: 'different' })],
    ['no warehouse id', snap({ externalOrderId: '' })],
  ] as const) {
    assert.deepEqual(findMergeCandidateGroups([partner, o], CTX), [], label)
  }
  const lower = snap({ status: ' new ' })
  assert.equal(findMergeCandidateGroups([partner, lower], CTX).length, 1, 'status is read case-insensitively')
})

test('tenancy: nothing is flagged unless the warehouse client is configured, and a link of another connector is ignored', () => {
  const a = order({})
  const b = order({})
  assert.equal(findMergeCandidateGroups([a, b], CTX).length, 1)
  assert.deepEqual(findMergeCandidateGroups([a, b], { ...CTX, tenantScoped: false }), [])
  assert.deepEqual(findMergeCandidateGroups([a, b], { ...CTX, connectorId: 'other' }), [])
  const foreign = order({})
  foreign.link = { ...foreign.link!, connector: 'other' }
  assert.deepEqual(findMergeCandidateGroups([a, foreign], CTX), [])
})

test('duplicate warehouse ids collapse: orders already merged into one warehouse order are one member, and one order alone is no group', () => {
  const a = order({ extId: 'W-SURVIVOR' })
  const b = order({ extId: 'W-SURVIVOR' })
  assert.deepEqual(findMergeCandidateGroups([a, b], CTX), [], 'already one warehouse order')
  const c = order({})
  const groups = findMergeCandidateGroups([a, b, c], CTX)
  assert.deepEqual(ids(groups), [[a.orderId, c.orderId]], 'the oldest IMS order stands for the survivor')
})

test('a chain of three is one group', () => {
  const a = order({})
  const b = order({})
  const c = order({})
  const groups = findMergeCandidateGroups([c, a, b], CTX)
  assert.deepEqual(ids(groups), [[a.orderId, b.orderId, c.orderId]])
})

test('EU orders are flagged with a customs/IOSS warning; UK and Crown Dependency orders are not', () => {
  const eu = findMergeCandidateGroups([order({ country: 'FR' }), order({ country: 'FR' })], CTX)
  assert.equal(eu.length, 1)
  assert.deepEqual(eu[0].warnings, [MERGE_WARNING_EU])
  assert.match(MERGE_WARNING_EU, /customs/)
  assert.match(MERGE_WARNING_EU, /IOSS/)
  for (const country of ['GB', 'NI', 'JE', 'GG', 'IM']) {
    const uk = findMergeCandidateGroups([order({ country }), order({ country })], CTX)
    assert.equal(uk.length, 1)
    assert.deepEqual(uk[0].warnings, [], `${country} is UK: no customs warning`)
  }
  assert.deepEqual(findMergeCandidateGroups([order({ country: 'EL' }), order({ country: 'GR' })], CTX)[0].warnings, [MERGE_WARNING_EU], 'Greece, both spellings')
})

test('a FedEx group gets the label-by-hand warning', () => {
  const a = order({ courierText: ['FedEx International Priority'] })
  const b = order({})
  const group = findMergeCandidateGroups([a, b], CTX)[0]
  assert.deepEqual(group.warnings, [MERGE_WARNING_FEDEX])
  const viaKey = findMergeCandidateGroups([order({ courierText: [null, 'calcurates:fedex_1', null] }), order({})], CTX)[0]
  assert.deepEqual(viaKey.warnings, [MERGE_WARNING_FEDEX])
  assert.deepEqual(findMergeCandidateGroups([order({}), order({})], CTX)[0].warnings, [])
  const both = findMergeCandidateGroups([order({ country: 'DE', courierText: ['FEDEX'] }), order({ country: 'DE' })], CTX)[0]
  assert.deepEqual(both.warnings, [MERGE_WARNING_EU, MERGE_WARNING_FEDEX])
})

test('the task text names order numbers and the instruction, never a customer detail', () => {
  const a = order({ country: 'FR' })
  const b = order({ country: 'FR' })
  const group = findMergeCandidateGroups([a, b], CTX)[0]
  const text = mergeGroupTaskText(group, 'Mintsoft')
  assert.match(text, /check these orders in Mintsoft and merge them there if appropriate/)
  assert.match(text, /IMS does not merge/)
  assert.ok(text.includes(a.orderNumber!) && text.includes(b.orderNumber!))
  assert.doesNotMatch(text, /buyer@|Test Street|AB1|Test Customer/)
  assert.equal(text, mergeCandidateQuery(group.members, group.warnings, 'Mintsoft'))
})

test('the mode: only `flag` is on; off, blank, unknown and the reserved `hold` all read as off', () => {
  assert.equal(parseWmsMergeCandidateMode('flag'), 'flag')
  assert.equal(parseWmsMergeCandidateMode(' FLAG '), 'flag')
  for (const value of [undefined, null, '', 'off', 'hold', 'HOLD', 'true', 'on', 'flagg']) assert.equal(parseWmsMergeCandidateMode(value), 'off', String(value))
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// The orchestrator, on an in-memory port that mirrors the real port's task rules.
// ---------------------------------------------------------------------------------------------------------------------------------------

type Task = { key: string; basis: string; status: 'OPEN' | 'DONE'; doneBy: string | null; queryText: string; orderId: string; externalOrderId: string }
function fakePort(opts: { mode: 'off' | 'flag'; orders: MergeCandidateOrder[]; backordered?: string[]; tenantScoped?: boolean; environment?: { skipped: string }; lockHeld?: boolean }) {
  const state = { mode: opts.mode, orders: opts.orders, backordered: new Set(opts.backordered ?? []), tenantScoped: opts.tenantScoped ?? true }
  const tasks: Task[] = []
  const log: string[] = []
  const writes: string[] = []
  const reads: string[] = []
  const port: MergeCandidatePort = {
    now: () => NOW,
    withLock: async (_connector, fn) => (opts.lockHeld ? null : fn()),
    readMode: async () => { reads.push('mode'); return state.mode },
    environment: async () => { reads.push('environment'); return opts.environment ?? { connectorId: 'mintsoft', connectorLabel: 'Mintsoft', tenantScoped: state.tenantScoped } },
    loadOrders: async () => { reads.push('orders'); return state.orders },
    backorderedAmong: async (orderIds) => new Set(orderIds.filter((id) => state.backordered.has(id))),
    async raiseGroupTask(connector, group, queryText): Promise<MergeTaskOutcome> {
      writes.push('raise')
      const anchor = group.members[0]
      const key = [connector, anchor.orderId, anchor.externalOrderId, MERGE_TASK_REASON, wmsOperatorTaskHash({ reason: MERGE_TASK_REASON, queryText, dedupeBasis: group.basis })].join('|')
      const existing = tasks.find((task) => task.key === key)
      if (!existing) {
        tasks.push({ key, basis: group.basis, status: 'OPEN', doneBy: null, queryText, orderId: anchor.orderId, externalOrderId: anchor.externalOrderId })
        log.push(`flagged:${group.members.map((m) => m.orderId).join(',')}`)
        return 'created'
      }
      if (existing.status === 'DONE' && existing.doneBy === MERGE_TASK_SYSTEM_ACTOR) {
        existing.status = 'OPEN'; existing.doneBy = null; existing.queryText = queryText
        log.push(`flagged:${group.members.map((m) => m.orderId).join(',')}`)
        return 'reopened'
      }
      if (existing.status === 'OPEN') existing.queryText = queryText
      return 'unchanged'
    },
    async resolveTasksNotIn(_connector, keepBases) {
      writes.push('resolve')
      let n = 0
      for (const task of tasks) {
        if (task.status === 'OPEN' && !keepBases.includes(task.basis)) { task.status = 'DONE'; task.doneBy = MERGE_TASK_SYSTEM_ACTOR; log.push(`cleared:${task.orderId}`); n += 1 }
      }
      return n
    },
  }
  return { port, state, tasks, log, writes, reads }
}

test('mode off (the default): nothing is computed and nothing is written', async () => {
  const a = order({})
  const b = order({})
  const f = fakePort({ mode: 'off', orders: [a, b] })
  const result = await runMergeCandidateDetection(f.port)
  assert.deepEqual(result, { mode: 'off', groups: [] })
  assert.deepEqual(f.writes, [])
  assert.deepEqual(f.tasks, [])
  assert.deepEqual(f.log, [])
  assert.deepEqual(f.reads, ['mode'], 'not even the orders are read')
  assert.deepEqual(await listMergeCandidateGroups(f.port), { mode: 'off', groups: [] })
})

test('flag mode raises ONE task per group, deduplicated across runs, and writes an activity entry once', async () => {
  const a = order({})
  const b = order({})
  const c = order({ street: '9 Other Road' })
  const d = order({ street: '9 Other Road' })
  const f = fakePort({ mode: 'flag', orders: [a, b, c, d] })
  const first = await runMergeCandidateDetection(f.port)
  assert.equal(first.mode === 'flag' && 'created' in first ? first.created : -1, 2)
  assert.equal(f.tasks.length, 2)
  const second = await runMergeCandidateDetection(f.port)
  assert.equal(second.mode === 'flag' && 'created' in second ? second.created : -1, 0, 'the same group is not a second task')
  assert.equal(f.tasks.length, 2)
  assert.equal(f.log.filter((line) => line.startsWith('flagged')).length, 2, 'one activity entry per group, not per run')
  assert.ok(f.tasks.every((task) => /check these orders in Mintsoft and merge them there/.test(task.queryText)))
})

test('a group that stops qualifying has its open task resolved; when it qualifies again the system-resolved task is re-opened', async () => {
  const a = order({})
  const b = order({})
  const f = fakePort({ mode: 'flag', orders: [a, b] })
  await runMergeCandidateDetection(f.port)
  assert.equal(f.tasks[0].status, 'OPEN')
  // b leaves NEW in the warehouse.
  f.state.orders = [a, { ...b, snapshot: { ...b.snapshot!, status: 'PICKING' } }]
  const gone = await runMergeCandidateDetection(f.port)
  assert.equal(gone.mode === 'flag' && 'resolved' in gone ? gone.resolved : -1, 1)
  assert.equal(f.tasks[0].status, 'DONE')
  assert.equal(f.tasks[0].doneBy, MERGE_TASK_SYSTEM_ACTOR)
  // It qualifies again.
  f.state.orders = [a, b]
  const back = await runMergeCandidateDetection(f.port)
  assert.equal(back.mode === 'flag' && 'reopened' in back ? back.reopened : -1, 1)
  assert.equal(f.tasks.length, 1, 'the same task, not a new one')
  assert.equal(f.tasks[0].status, 'OPEN')
})

test('a task a person marked Done is not re-opened; a chain that grows is a new task and the old one is resolved', async () => {
  const a = order({})
  const b = order({})
  const f = fakePort({ mode: 'flag', orders: [a, b] })
  await runMergeCandidateDetection(f.port)
  f.tasks[0].status = 'DONE'; f.tasks[0].doneBy = 'user-1'
  await runMergeCandidateDetection(f.port)
  assert.equal(f.tasks[0].status, 'DONE', 'left as the person left it')
  assert.equal(f.tasks[0].doneBy, 'user-1')
  const c = order({})
  f.state.orders = [a, b, c]
  const grown = await runMergeCandidateDetection(f.port)
  assert.equal(grown.mode === 'flag' && 'created' in grown ? grown.created : -1, 1)
  assert.equal(f.tasks.length, 2)
  assert.deepEqual(f.tasks[1].basis, grown.groups[0].basis)
})

test('the backordered order is left out of the group in the run', async () => {
  const a = order({})
  const b = order({})
  const c = order({})
  const f = fakePort({ mode: 'flag', orders: [a, b, c], backordered: [c.orderId] })
  const result = await runMergeCandidateDetection(f.port)
  assert.deepEqual(ids(result.groups), [[a.orderId, b.orderId]])
  const f2 = fakePort({ mode: 'flag', orders: [a, c], backordered: [c.orderId] })
  assert.deepEqual((await runMergeCandidateDetection(f2.port)).groups, [])
  assert.deepEqual(f2.tasks, [])
})

test('flag mode with no client scope or no connector writes nothing', async () => {
  const f = fakePort({ mode: 'flag', orders: [order({}), order({})], tenantScoped: false })
  const result = await runMergeCandidateDetection(f.port)
  assert.deepEqual(result.groups, [])
  assert.deepEqual(f.tasks, [])
  const g = fakePort({ mode: 'flag', orders: [order({}), order({})], environment: { skipped: 'No WMS connector is enabled' } })
  const skipped = await runMergeCandidateDetection(g.port)
  assert.equal('skipped' in skipped, true)
  assert.deepEqual(g.writes, [])
})

test('a pass that cannot get the connector lock skips and writes nothing', async () => {
  const f = fakePort({ mode: 'flag', orders: [order({}), order({})], lockHeld: true })
  const result = await runMergeCandidateDetection(f.port)
  assert.equal('skipped' in result, true)
  assert.deepEqual(f.writes, [])
  assert.deepEqual(f.tasks, [])
})

test('a detection failure never throws out of the safe wrapper (it must not affect the push)', async () => {
  const f = fakePort({ mode: 'flag', orders: [] })
  f.port.loadOrders = async () => { throw new Error('database unavailable') }
  const originalError = console.error
  console.error = () => {}
  try {
    const result = await runMergeCandidateDetectionSafe('the order push', f.port)
    assert.deepEqual(result, { error: 'database unavailable' })
  } finally {
    console.error = originalError
  }
})

test('the detection reads and writes no Mintsoft or WooCommerce: the modules import no connector client and call no fetch', async () => {
  const { readFileSync } = await import('node:fs')
  for (const file of ['lib/domain/wms/merge-candidates.ts', 'lib/domain/wms/merge-candidate-match.ts', 'lib/domain/wms/merge-candidate-mode.ts']) {
    const text = readFileSync(file, 'utf8')
    assert.doesNotMatch(text, /mintsoftRequest|getWmsConnector\(|\bfetch\(|addOrderComment|connectors\/woocommerce|@\/lib\/shopping/, file)
  }
})
