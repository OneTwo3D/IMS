import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const skip = !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1'

async function loadDb() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const { db } = await import('@/lib/db')
  return db
}

const NAME = 'Zebediah Quillfeather'
const EMAIL = `zebediah.quillfeather+${randomUUID().slice(0, 8)}@example.test`
const THIRD_PARTY = 'Hortensia Blumenthal-Okafor'
const PLACEHOLDER = 'GDPR Anonymised'
const MARKER = 'Text removed by GDPR erasure'

type Fixture = { orderId: string; customerId: string; refundId: string; other: { orderId: string; eventId: string; syncId: string }; ids: { pendingEvent: string; postedEvent: string; refundEvent: string; syncFailed: string; syncSynced: string; refundSync: string }; cleanup(): Promise<void> }

const contactDoc = (name: string, email: string | null) => ({
  kind: 'accounting-document', schemaVersion: 1, documentType: 'INVOICE', contact: { name, ...(email ? { email } : {}) }, date: '2026-11-02', currency: 'GBP', lines: [{ description: 'Widget', quantity: 1, unitAmount: 100 }],
})

async function makeOrder(db: Awaited<ReturnType<typeof loadDb>>, customerId: string | null, name: string, email: string) {
  return db.salesOrder.create({ data: { orderNumber: `DER-${randomUUID().slice(0, 8)}`, status: 'DRAFT', currency: 'GBP', customerId, customerName: name, customerEmail: email, subtotalForeign: 1, totalForeign: 1, subtotalBase: 1, totalBase: 1 } })
}

async function fixture(db: Awaited<ReturnType<typeof loadDb>>): Promise<Fixture> {
  const customer = await db.customer.create({ data: { firstName: 'Zebediah', lastName: 'Quillfeather', email: EMAIL } })
  const order = await makeOrder(db, customer.id, NAME, EMAIL)
  const refund = await db.salesOrderRefund.create({ data: { orderId: order.id, reason: 'Item arrived damaged', totalForeign: 1, totalBase: 1 } as never })
  const key = () => `derived-${randomUUID()}`
  const event = (sourceEntityType: string, sourceEntityId: string, status: string, extra: Record<string, unknown> = {}) =>
    db.accountingEvent.create({ data: { type: 'INVOICE', sourceEntityType, sourceEntityId, businessDate: new Date('2026-11-02'), status, idempotencyKey: key(), linesJson: contactDoc(NAME, EMAIL), currency: 'GBP', ...extra } as never })
  const pendingEvent = await event('SalesOrder', order.id, 'PENDING')
  const postedEvent = await event('SalesOrder', order.id, 'POSTED', { externalSystem: 'xero', externalId: `xero-${randomUUID()}` })
  const refundEvent = await event('SalesOrderRefund', refund.id, 'PENDING')
  // The superseded body kept on an event log: a third copy of the contact block, on an unposted and on a posted event.
  for (const e of [pendingEvent, postedEvent]) {
    await db.accountingEventLog.create({ data: { accountingEventId: e.id, action: 'payload_superseded', message: 'payload changed', metadata: { syncType: 'SALES_INVOICE', enqueuedLinesJson: contactDoc(NAME, EMAIL) } } })
  }
  const sync = (referenceType: string, referenceId: string, status: string, errorMessage: string | null) =>
    db.accountingSyncLog.create({ data: { connector: 'xero', type: 'SALES_INVOICE', referenceType, referenceId, status, errorMessage, payload: { contactName: NAME, contactEmail: EMAIL, reference: 'SO-1' } } as never })
  const syncFailed = await sync('SalesOrder', order.id, 'FAILED', `Invoice number already used by contact "${THIRD_PARTY}" and ${NAME} <${EMAIL}>`)
  const syncSynced = await sync('SalesOrder', order.id, 'SYNCED', `Earlier attempt named ${THIRD_PARTY}`)
  const refundSync = await sync('SalesOrderRefund', refund.id, 'FAILED', `Credit note for ${NAME}`)
  await db.notification.create({ data: { type: 'info', title: `Payment for ${NAME}`, message: `${NAME} paid`, actionUrl: `/sales/${order.id}` } })
  // Another subject, untouched by the erasure.
  const otherOrder = await makeOrder(db, null, 'Other Person', 'other@example.test')
  const otherEvent = await event('SalesOrder', otherOrder.id, 'PENDING', { linesJson: contactDoc('Other Person', 'other@example.test') })
  const otherSync = await sync('SalesOrder', otherOrder.id, 'FAILED', 'Other Person failed')
  return {
    orderId: order.id, customerId: customer.id, refundId: refund.id,
    other: { orderId: otherOrder.id, eventId: otherEvent.id, syncId: otherSync.id },
    ids: { pendingEvent: pendingEvent.id, postedEvent: postedEvent.id, refundEvent: refundEvent.id, syncFailed: syncFailed.id, syncSynced: syncSynced.id, refundSync: refundSync.id },
    async cleanup() {
      const orders = [order.id, otherOrder.id]
      await db.accountingEventLog.deleteMany({ where: { accountingEvent: { sourceEntityId: { in: [...orders, refund.id] } } } })
      await db.accountingEvent.deleteMany({ where: { sourceEntityId: { in: [...orders, refund.id] } } })
      await db.accountingSyncLog.deleteMany({ where: { referenceId: { in: [...orders, refund.id] } } })
      await db.notification.deleteMany({ where: { actionUrl: { startsWith: `/sales/${order.id}` } } })
      await db.salesOrderRefund.deleteMany({ where: { orderId: order.id } })
      await db.activityLog.deleteMany({ where: { OR: [{ entityId: { in: [...orders, customer.id] } }] } })
      await db.salesOrder.deleteMany({ where: { id: { in: orders } } })
      await db.customer.deleteMany({ where: { id: customer.id } })
    },
  }
}

const dump = (v: unknown) => JSON.stringify(v ?? null)

test('[derived copies] the erasure scrubs events, event-log bodies, sync error text and notifications; keeps what the ledger holds; leaves others alone', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await fixture(db)
  t.after(() => fx.cleanup())
  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')

  // PRECONDITION: every copy really holds the name, the email and the third party's name, so "gone" cannot pass vacuously.
  assert.match(dump((await db.accountingEvent.findUniqueOrThrow({ where: { id: fx.ids.pendingEvent } })).linesJson), new RegExp(NAME))
  assert.match(dump((await db.accountingEventLog.findFirstOrThrow({ where: { accountingEventId: fx.ids.pendingEvent } })).metadata), new RegExp(EMAIL.replace(/[+.]/g, '\\$&')))
  assert.match((await db.accountingSyncLog.findUniqueOrThrow({ where: { id: fx.ids.syncFailed } })).errorMessage ?? '', new RegExp(THIRD_PARTY))
  assert.match((await db.notification.findFirstOrThrow({ where: { actionUrl: `/sales/${fx.orderId}` } })).title, new RegExp(NAME))

  const result = await eraseCustomerPersonalData(fx.customerId, { trigger: 'ON_REQUEST', userId: null })
  assert.equal(result.success, true, JSON.stringify(result))

  // UNPOSTED event: the name is the placeholder and the email is gone; the financial lines are untouched.
  const pending = await db.accountingEvent.findUniqueOrThrow({ where: { id: fx.ids.pendingEvent } })
  assert.deepEqual((pending.linesJson as { contact: unknown }).contact, { name: PLACEHOLDER })
  assert.deepEqual((pending.linesJson as { lines: unknown }).lines, contactDoc(NAME, EMAIL).lines)
  assert.equal(pending.status, 'PENDING')
  // POSTED event (it carries a document id): the name stays, the ledger holds it; the email goes.
  const posted = await db.accountingEvent.findUniqueOrThrow({ where: { id: fx.ids.postedEvent } })
  assert.deepEqual((posted.linesJson as { contact: unknown }).contact, { name: NAME })
  assert.ok(posted.externalId)
  // The refund's event is reached through the refund id.
  assert.deepEqual(((await db.accountingEvent.findUniqueOrThrow({ where: { id: fx.ids.refundEvent } })).linesJson as { contact: unknown }).contact, { name: PLACEHOLDER })
  // Event logs follow their event.
  const pendingLog = await db.accountingEventLog.findFirstOrThrow({ where: { accountingEventId: fx.ids.pendingEvent } })
  assert.deepEqual((pendingLog.metadata as { enqueuedLinesJson: { contact: unknown } }).enqueuedLinesJson.contact, { name: PLACEHOLDER })
  assert.equal((pendingLog.metadata as { syncType: string }).syncType, 'SALES_INVOICE', 'the non-personal evidence on the log survives')
  const postedLog = await db.accountingEventLog.findFirstOrThrow({ where: { accountingEventId: fx.ids.postedEvent } })
  assert.deepEqual((postedLog.metadata as { enqueuedLinesJson: { contact: unknown } }).enqueuedLinesJson.contact, { name: NAME })
  // Sync error text is the fixed marker, status and payload money fields survive, for the order and its refund.
  for (const id of [fx.ids.syncFailed, fx.ids.syncSynced, fx.ids.refundSync]) {
    const row = await db.accountingSyncLog.findUniqueOrThrow({ where: { id } })
    assert.equal(row.errorMessage, MARKER)
    assert.equal((row.payload as { reference: string }).reference, 'SO-1')
  }
  assert.equal((await db.accountingSyncLog.findUniqueOrThrow({ where: { id: fx.ids.syncFailed } })).status, 'FAILED')
  // Notifications about the order carry the fixed text.
  const note = await db.notification.findFirstOrThrow({ where: { actionUrl: `/sales/${fx.orderId}` } })
  assert.doesNotMatch(`${note.title} ${note.message}`, new RegExp(NAME))

  // NO COPY ANYWHERE holds the email or the third party's name; the subject's name survives only on the posted copies.
  const everything = dump(await db.accountingEvent.findMany({ where: { sourceEntityId: { in: [fx.orderId, fx.refundId] } } }))
    + dump(await db.accountingEventLog.findMany({ where: { accountingEvent: { sourceEntityId: { in: [fx.orderId, fx.refundId] } } } }))
    + dump(await db.accountingSyncLog.findMany({ where: { referenceId: { in: [fx.orderId, fx.refundId] } }, select: { errorMessage: true } }))
  assert.doesNotMatch(everything, new RegExp(EMAIL.replace(/[+.]/g, '\\$&')))
  assert.doesNotMatch(everything, new RegExp(THIRD_PARTY))

  // ANOTHER SUBJECT is untouched.
  const other = await db.accountingEvent.findUniqueOrThrow({ where: { id: fx.other.eventId } })
  assert.deepEqual((other.linesJson as { contact: unknown }).contact, { name: 'Other Person', email: 'other@example.test' })
  assert.equal((await db.accountingSyncLog.findUniqueOrThrow({ where: { id: fx.other.syncId } })).errorMessage, 'Other Person failed')

  // The proof counts them, and carries no value.
  const proof = await db.activityLog.findFirstOrThrow({ where: { entityType: 'CUSTOMER', entityId: fx.customerId, action: 'gdpr_erasure_recorded' } })
  const counts = (proof.metadata as { counts: { accountingEventCopiesScrubbed: number; accountingErrorsScrubbed: number } }).counts
  assert.ok(counts.accountingEventCopiesScrubbed >= 5, `events + logs counted (${counts.accountingEventCopiesScrubbed})`)
  assert.equal(counts.accountingErrorsScrubbed, 3)
  assert.doesNotMatch(dump(proof), new RegExp(THIRD_PARTY))

  // IDEMPOTENT: a second pass over the same rows changes nothing.
  const { scrubAccountingDerivedCopiesInTx } = await import('@/lib/domain/erasure/derived-copies')
  const again = await db.$transaction((tx) => scrubAccountingDerivedCopiesInTx(tx, [fx.orderId]))
  assert.deepEqual(again, { accountingEventCopiesScrubbed: 0, accountingErrorsScrubbed: 0 })
})

test('[derived copies] a writer AFTER the erasure is held by the triggers; a row inserted while the erasure was uncommitted is cleared by the reconcile', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await fixture(db)
  t.after(() => fx.cleanup())
  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  const { reconcileDerivedCopies } = await import('@/lib/domain/erasure/derived-copies')
  assert.equal((await eraseCustomerPersonalData(fx.customerId, { trigger: 'ON_REQUEST', userId: null })).success, true)

  // An event written for the erased order: scrubbed on insert (unposted: placeholder; a posted one keeps the name).
  const late = await db.accountingEvent.create({ data: { type: 'INVOICE', sourceEntityType: 'SalesOrder', sourceEntityId: fx.orderId, businessDate: new Date('2026-11-03'), status: 'PENDING', idempotencyKey: `derived-${randomUUID()}`, linesJson: contactDoc(NAME, EMAIL), currency: 'GBP' } as never })
  assert.deepEqual((late.linesJson as { contact: unknown }).contact, { name: PLACEHOLDER })
  // Its status moving to POSTED later cannot bring the real name or the email back: a replaced name stays replaced.
  const posted = await db.accountingEvent.update({ where: { id: late.id }, data: { status: 'POSTED', externalSystem: 'xero', externalId: `xero-${randomUUID()}`, linesJson: contactDoc(NAME, EMAIL) } as never })
  assert.deepEqual((posted.linesJson as { contact: unknown }).contact, { name: PLACEHOLDER }, 'a replaced name stays replaced, and the email never returns')
  // An event log with a superseded body, a new error text on a sync row, a new notification.
  const log = await db.accountingEventLog.create({ data: { accountingEventId: fx.ids.pendingEvent, action: 'payload_superseded', metadata: { enqueuedLinesJson: contactDoc(NAME, EMAIL) } } })
  assert.deepEqual((log.metadata as { enqueuedLinesJson: { contact: unknown } }).enqueuedLinesJson.contact, { name: PLACEHOLDER })
  const sync = await db.accountingSyncLog.update({ where: { id: fx.ids.syncFailed }, data: { errorMessage: `retry failed for ${THIRD_PARTY}` } })
  assert.equal(sync.errorMessage, MARKER)
  const created = await db.notification.create({ data: { type: 'info', title: `Refund for ${NAME}`, message: `${NAME} refunded`, actionUrl: `/sales/${fx.orderId}/refunds` } })
  assert.doesNotMatch(`${created.title} ${created.message}`, new RegExp(NAME))
  // CONTROL: the same writes for an order that is NOT erased are untouched (the guard is not vacuous).
  const live = await db.accountingEvent.update({ where: { id: fx.other.eventId }, data: { linesJson: contactDoc('Other Person', 'other@example.test') } })
  assert.equal((live.linesJson as { contact: { email: string } }).contact.email, 'other@example.test')
  const liveSync = await db.accountingSyncLog.update({ where: { id: fx.other.syncId }, data: { errorMessage: 'Other Person still failing' } })
  assert.equal(liveSync.errorMessage, 'Other Person still failing')
  const liveNote = await db.notification.create({ data: { type: 'info', title: 'Live', message: 'Other Person paid', actionUrl: `/sales/${fx.other.orderId}` } })
  assert.equal(liveNote.message, 'Other Person paid')
  await db.notification.delete({ where: { id: liveNote.id } })

  // THE RACE A TRIGGER CANNOT SEE: rows inserted while the erasure was still uncommitted. Simulated with the triggers off for the inserts.
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`ALTER TABLE "accounting_events" DISABLE TRIGGER accounting_events_erased_contact`
    await tx.$executeRaw`ALTER TABLE "accounting_sync_logs" DISABLE TRIGGER accounting_sync_logs_erased_error`
    await tx.$executeRaw`ALTER TABLE "notifications" DISABLE TRIGGER notifications_erased_order_text`
    await tx.$executeRaw`ALTER TABLE "accounting_event_logs" DISABLE TRIGGER accounting_event_logs_erased_contact`
    await tx.accountingEvent.create({ data: { type: 'INVOICE', sourceEntityType: 'SalesOrder', sourceEntityId: fx.orderId, businessDate: new Date('2026-11-04'), status: 'PENDING', idempotencyKey: `derived-${randomUUID()}`, linesJson: contactDoc(NAME, EMAIL), currency: 'GBP' } as never })
    await tx.accountingEventLog.create({ data: { accountingEventId: fx.ids.pendingEvent, action: 'payload_superseded', metadata: { enqueuedLinesJson: contactDoc(NAME, EMAIL) } } })
    await tx.accountingSyncLog.update({ where: { id: fx.ids.syncSynced }, data: { errorMessage: `straggler ${THIRD_PARTY}` } })
    await tx.notification.create({ data: { type: 'info', title: NAME, message: NAME, actionUrl: `/sales/${fx.orderId}` } })
    await tx.$executeRaw`ALTER TABLE "accounting_events" ENABLE TRIGGER accounting_events_erased_contact`
    await tx.$executeRaw`ALTER TABLE "accounting_sync_logs" ENABLE TRIGGER accounting_sync_logs_erased_error`
    await tx.$executeRaw`ALTER TABLE "notifications" ENABLE TRIGGER notifications_erased_order_text`
    await tx.$executeRaw`ALTER TABLE "accounting_event_logs" ENABLE TRIGGER accounting_event_logs_erased_contact`
  })
  const dirty = dump(await db.accountingEvent.findMany({ where: { sourceEntityId: fx.orderId } })) + dump(await db.accountingSyncLog.findMany({ where: { referenceId: fx.orderId }, select: { errorMessage: true } }))
    + dump(await db.notification.findMany({ where: { actionUrl: `/sales/${fx.orderId}` } }))
  assert.match(dirty, new RegExp(EMAIL.replace(/[+.]/g, '\\$&')), 'PRECONDITION: the stragglers really carry the identity')
  const first = await reconcileDerivedCopies(db)
  assert.ok(first.changed >= 4, `reconcile changed the stragglers (${first.changed})`)
  assert.equal(first.remaining, 0)
  const clean = dump(await db.accountingEvent.findMany({ where: { sourceEntityId: fx.orderId, status: 'PENDING' } })) + dump(await db.accountingSyncLog.findMany({ where: { referenceId: fx.orderId }, select: { errorMessage: true } }))
    + dump(await db.notification.findMany({ where: { actionUrl: `/sales/${fx.orderId}` } })) + dump(await db.accountingEventLog.findMany({ where: { accountingEventId: fx.ids.pendingEvent } }))
  assert.doesNotMatch(clean, new RegExp(EMAIL.replace(/[+.]/g, '\\$&')))
  assert.doesNotMatch(clean, new RegExp(THIRD_PARTY))
  assert.doesNotMatch(clean, new RegExp(NAME))
  const idle = await reconcileDerivedCopies(db)
  assert.equal(idle.changed, 0, 'idempotent')
  assert.equal(idle.remaining, 0)
  // CONTROL: the other subject still holds its own data after the reconcile.
  assert.equal((await db.accountingSyncLog.findUniqueOrThrow({ where: { id: fx.other.syncId } })).errorMessage, 'Other Person still failing')
})

test('[derived copies] the name rule: a no-write SUPERSEDED event gets the placeholder (event and copied log body), a posted-then-superseded one keeps the name; SQL and mirroredPostStanding agree', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await fixture(db)
  t.after(() => fx.cleanup())
  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  const { eventKeepsContactName } = await import('@/lib/domain/erasure/derived-copies')
  const mk = (status: string, extra: Record<string, unknown> = {}) =>
    db.accountingEvent.create({ data: { type: 'INVOICE', sourceEntityType: 'SalesOrder', sourceEntityId: fx.orderId, businessDate: new Date('2026-11-02'), status, idempotencyKey: `derived-${randomUUID()}`, linesJson: contactDoc(NAME, EMAIL), currency: 'GBP', ...extra } as never })
  const matrix: Array<{ label: string; status: string; extra: Record<string, unknown> }> = [
    { label: 'pending', status: 'PENDING', extra: {} },
    { label: 'void', status: 'VOID', extra: {} },
    { label: 'failed', status: 'FAILED', extra: {} },
    { label: 'superseded no write (yield path)', status: 'SUPERSEDED', extra: {} },
    { label: 'posted confirmed', status: 'POSTED', extra: { postBasis: 'CONNECTOR' } },
    { label: 'posted asserted', status: 'POSTED', extra: { postBasis: 'OPERATOR_ASSERTION' } },
    { label: 'posted unrecorded', status: 'POSTED', extra: {} },
    { label: 'posted then superseded (document id)', status: 'SUPERSEDED', extra: { externalSystem: 'xero', externalId: `xero-${randomUUID()}` } },
    { label: 'superseded with revision stamp', status: 'SUPERSEDED', extra: { externalRevisionAt: new Date('2026-11-02T10:00:00Z') } },
    { label: 'superseded with post basis', status: 'SUPERSEDED', extra: { postBasis: 'CONNECTOR' } },
    { label: 'unstamped live write later superseded by document-id takeover', status: 'SUPERSEDED', extra: { revisionOrderBasis: 'live_write_unstamped' } },
    { label: 'backfill repair of a recorded write, superseded', status: 'SUPERSEDED', extra: { revisionOrderBasis: 'historical_backfill_repair' } },
    { label: 'pending with an unrelated basis string', status: 'PENDING', extra: { revisionOrderBasis: 'something_else' } },
  ]
  const rows = [] as Array<{ label: string; id: string }>
  for (const m of matrix) {
    const e = await mk(m.status, m.extra)
    await db.accountingEventLog.create({ data: { accountingEventId: e.id, action: 'payload_superseded', metadata: { enqueuedLinesJson: contactDoc(NAME, EMAIL) } } })
    rows.push({ label: m.label, id: e.id })
  }
  assert.equal((await eraseCustomerPersonalData(fx.customerId, { trigger: 'ON_REQUEST', userId: null })).success, true)
  for (const r of rows) {
    const e = await db.accountingEvent.findUniqueOrThrow({ where: { id: r.id } })
    const log = await db.accountingEventLog.findFirstOrThrow({ where: { accountingEventId: r.id } })
    const keeps = eventKeepsContactName({ status: e.status, postBasis: e.postBasis, externalId: e.externalId, externalRevisionAt: e.externalRevisionAt, revisionOrderBasis: e.revisionOrderBasis })
    const expected = { name: keeps ? NAME : PLACEHOLDER }
    assert.deepEqual((e.linesJson as { contact: unknown }).contact, expected, `${r.label}: event`)
    assert.deepEqual((log.metadata as { enqueuedLinesJson: { contact: unknown } }).enqueuedLinesJson.contact, expected, `${r.label}: log body`)
    // THE TWO RULES AGREE: the SQL function answers what the TypeScript statement answers, for the same row.
    const sql = await db.$queryRaw<Array<{ k: boolean }>>`SELECT gdpr_event_keeps_contact_name(e) AS k FROM "accounting_events" e WHERE e."id" = ${r.id}`
    assert.equal(sql[0]!.k, keeps, `${r.label}: SQL and TypeScript agree`)
  }
  const byLabel = (l: string) => rows.find((r) => r.label === l)!.id
  const keptNames = new Map<string, boolean>()
  for (const r of rows) keptNames.set(r.label, ((await db.accountingEvent.findUniqueOrThrow({ where: { id: r.id } })).linesJson as { contact: { name: string } }).contact.name === NAME)
  assert.equal(keptNames.get('superseded no write (yield path)'), false)
  assert.equal(keptNames.get('posted then superseded (document id)'), true)
  assert.equal(keptNames.get('posted confirmed'), true)
  assert.equal(keptNames.get('unstamped live write later superseded by document-id takeover'), true)
  assert.equal(keptNames.get('backfill repair of a recorded write, superseded'), true)
  assert.equal(keptNames.get('pending with an unrelated basis string'), false)
  assert.equal(keptNames.get('pending'), false)
  assert.ok(byLabel('void'))
  assert.doesNotMatch(dump(await db.accountingEvent.findMany({ where: { sourceEntityId: fx.orderId } })), new RegExp(EMAIL.replace(/[+.]/g, '\\$&')))
})

const TRIGGERS: Array<[string, string]> = [
  ['accounting_events', 'accounting_events_erased_contact'], ['accounting_sync_logs', 'accounting_sync_logs_erased_error'],
  ['notifications', 'notifications_erased_order_text'], ['accounting_event_logs', 'accounting_event_logs_erased_contact'],
]
async function withTriggersOff<T>(db: Awaited<ReturnType<typeof loadDb>>, run: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    for (const [table, trigger] of TRIGGERS) await tx.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER ${trigger}`)
    const out = await run(tx)
    for (const [table, trigger] of TRIGGERS) await tx.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE TRIGGER ${trigger}`)
    return out
  }, { timeout: 120_000, maxWait: 30_000 })
}

test('[derived copies] the reconcile is driven by the erased subject, not by row age: an OLD row written across the erasure commit is cleaned', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await fixture(db)
  t.after(() => fx.cleanup())
  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  const { reconcileDerivedCopies } = await import('@/lib/domain/erasure/derived-copies')
  const old = new Date(Date.now() - 10 * 24 * 3600 * 1000)
  // The fixture rows are ten days old.
  await db.accountingEvent.updateMany({ where: { sourceEntityId: { in: [fx.orderId, fx.refundId] } }, data: { createdAt: old } })
  await db.accountingEventLog.updateMany({ where: { accountingEvent: { sourceEntityId: fx.orderId } }, data: { createdAt: old } })
  await db.accountingSyncLog.updateMany({ where: { referenceId: { in: [fx.orderId, fx.refundId] } }, data: { createdAt: old } })
  const oldNote = await db.notification.create({ data: { type: 'info', title: 'x', message: 'x', actionUrl: `/sales/${fx.orderId}`, createdAt: old } })
  assert.equal((await eraseCustomerPersonalData(fx.customerId, { trigger: 'ON_REQUEST', userId: null })).success, true)
  // A writer whose trigger snapshot saw the order live updates the OLD rows as the erasure commits: the identity is back, and the row is older than any window.
  await withTriggersOff(db, async (tx) => {
    await tx.accountingEvent.update({ where: { id: fx.ids.pendingEvent }, data: { linesJson: contactDoc(NAME, EMAIL) } })
    await tx.accountingEventLog.updateMany({ where: { accountingEventId: fx.ids.pendingEvent }, data: { metadata: { enqueuedLinesJson: contactDoc(NAME, EMAIL) } } })
    await tx.accountingSyncLog.update({ where: { id: fx.ids.syncFailed }, data: { errorMessage: `late ${THIRD_PARTY}` } })
    await tx.notification.update({ where: { id: oldNote.id }, data: { title: NAME, message: NAME } })
  })
  assert.match(dump(await db.accountingEvent.findUniqueOrThrow({ where: { id: fx.ids.pendingEvent } })), new RegExp(EMAIL.replace(/[+.]/g, '\\$&')), 'PRECONDITION: the old row carries the identity again')
  const result = await reconcileDerivedCopies(db)
  assert.ok(result.changed >= 4, `the old rows were revisited (${result.changed})`)
  assert.equal(result.remaining, 0)
  const clean = dump(await db.accountingEvent.findUniqueOrThrow({ where: { id: fx.ids.pendingEvent } })) + dump(await db.accountingEventLog.findMany({ where: { accountingEventId: fx.ids.pendingEvent } }))
    + dump(await db.accountingSyncLog.findUniqueOrThrow({ where: { id: fx.ids.syncFailed } })) + dump(await db.notification.findUniqueOrThrow({ where: { id: oldNote.id } }))
  assert.doesNotMatch(clean, new RegExp(EMAIL.replace(/[+.]/g, '\\$&')))
  assert.doesNotMatch(clean, new RegExp(THIRD_PARTY))
  assert.doesNotMatch(clean, new RegExp(NAME))
  // CONTROL: another subject's old row is not touched.
  assert.equal((await db.accountingSyncLog.findUniqueOrThrow({ where: { id: fx.other.syncId } })).errorMessage, 'Other Person failed')
})

test('[derived copies] more dirty event logs and notifications than one batch are drained; a run that hits its cap REPORTS what is left', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await fixture(db)
  t.after(() => fx.cleanup())
  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  const { reconcileDerivedCopies } = await import('@/lib/domain/erasure/derived-copies')
  assert.equal((await eraseCustomerPersonalData(fx.customerId, { trigger: 'ON_REQUEST', userId: null })).success, true)
  const N = 620
  await withTriggersOff(db, async (tx) => {
    await tx.$executeRaw`
      INSERT INTO "accounting_event_logs" ("id", "accountingEventId", "action", "metadata", "createdAt")
      SELECT 'dl-' || ${fx.orderId} || '-' || g, ${fx.ids.pendingEvent}, 'payload_superseded', ${JSON.stringify({ enqueuedLinesJson: contactDoc(NAME, EMAIL) })}::jsonb, now()
        FROM generate_series(1, ${N}) g`
    await tx.$executeRaw`
      INSERT INTO "notifications" ("id", "type", "title", "message", "actionUrl", "createdAt")
      SELECT 'dn-' || ${fx.orderId} || '-' || g, 'info', ${NAME}, ${NAME}, ${`/sales/${fx.orderId}`}, now() FROM generate_series(1, ${N}) g`
  })
  // A capped run (one round, 500 per statement) leaves rows and SAYS so.
  const capped = await reconcileDerivedCopies(db, 500, 1)
  assert.ok(capped.remaining >= N - 500, `the cap leaves rows behind and reports them (${capped.remaining})`)
  // A full run drains them in rounds.
  const full = await reconcileDerivedCopies(db)
  assert.equal(full.remaining, 0)
  assert.ok(full.rounds >= 1)
  const left = await db.accountingEventLog.count({ where: { accountingEventId: fx.ids.pendingEvent, id: { startsWith: 'dl-' } } })
  assert.equal(left, N, 'the rows are scrubbed in place, not deleted')
  assert.equal(await db.notification.count({ where: { actionUrl: `/sales/${fx.orderId}`, title: NAME } }), 0)
  assert.equal(await db.accountingEventLog.count({ where: { accountingEventId: fx.ids.pendingEvent, metadata: { path: ['enqueuedLinesJson', 'contact', 'name'], equals: NAME } } }), 0)
})

test('[derived copies] an event-log MESSAGE that echoes a name (a final failure) is the marker after the erasure, on a later write, on an update, and through the reconcile', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await fixture(db)
  t.after(() => fx.cleanup())
  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  const { reconcileDerivedCopies } = await import('@/lib/domain/erasure/derived-copies')
  const echo = `Xero rejected the contact ${NAME} <${EMAIL}> (existing contact ${THIRD_PARTY})`
  const before = await db.accountingEventLog.create({ data: { accountingEventId: fx.ids.pendingEvent, action: 'failed_from_sync_log', message: echo, metadata: { syncType: 'SALES_INVOICE' } } })
  assert.match(before.message ?? '', new RegExp(THIRD_PARTY))
  assert.equal((await eraseCustomerPersonalData(fx.customerId, { trigger: 'ON_REQUEST', userId: null })).success, true)
  const after = await db.accountingEventLog.findUniqueOrThrow({ where: { id: before.id } })
  assert.equal(after.message, MARKER)
  assert.equal(after.action, 'failed_from_sync_log', 'the action, which says what happened, survives')
  assert.equal((after.metadata as { syncType: string }).syncType, 'SALES_INVOICE')
  // A later write (the mirror writing a final failure after the erasure) and an update are held by the trigger.
  const later = await db.accountingEventLog.create({ data: { accountingEventId: fx.ids.pendingEvent, action: 'failed_from_sync_log', message: echo } })
  assert.equal(later.message, MARKER)
  const updated = await db.accountingEventLog.update({ where: { id: later.id }, data: { message: echo } })
  assert.equal(updated.message, MARKER)
  // CONTROL: a log of another subject keeps its message.
  const live = await db.accountingEventLog.create({ data: { accountingEventId: fx.other.eventId, action: 'failed_from_sync_log', message: 'Other Person rejected' } })
  assert.equal(live.message, 'Other Person rejected')
  // The reconcile revisits it when the writer's snapshot saw the order live (triggers off).
  await withTriggersOff(db, (tx) => tx.accountingEventLog.update({ where: { id: later.id }, data: { message: echo } }))
  assert.equal((await db.accountingEventLog.findUniqueOrThrow({ where: { id: later.id } })).message, echo, 'PRECONDITION: the straggler carries the echo')
  const result = await reconcileDerivedCopies(db)
  assert.equal(result.remaining, 0)
  assert.equal((await db.accountingEventLog.findUniqueOrThrow({ where: { id: later.id } })).message, MARKER)
  assert.equal((await db.accountingEventLog.findUniqueOrThrow({ where: { id: live.id } })).message, 'Other Person rejected')
})
