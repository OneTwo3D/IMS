import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import { config } from 'dotenv'

/**
 * CONFIGURABLE DOCUMENT NUMBERING ON A REAL POSTGRES.
 *
 *   arm 1  two creates never get the same number: 20 concurrent transactions each mint and write an order, and the
 *          numbers are exactly 1..20, unpadded
 *   arm 2  a create that rolls back hands its number back
 *   arm 3  a pattern change never renumbers a document; the counter continues in the new pattern
 *   arm 4  a taken number is skipped; a run of 1001 taken numbers is refused instead of looping
 *   arm 5  a counter resets forward, and is refused at or below the highest number in use
 *   arm 6  a period with documents in it is seeded from them; the credit-note counter the old code kept is carried over
 *   arm 7  a pattern with no counter is locked too, so concurrent random draws never collide ({RAND:1}); a shipment has no number until a pattern is set
 *   arm 9  credit notes numbered by an old-writer simulation and the new mint at the same time never repeat, and the legacy yearly counter is kept in step
 *   arm 10 concurrent creates beyond a small connection pool finish with unique numbers when the number is minted in its own transaction, and no numbering lock is held while a document transaction does other work (the old shape is shown to hold it)
 *   arm 8  the uniqueness probe of every type runs against the real schema
 *
 * Nothing here reaches a network: WooCommerce, Mintsoft and Xero are not involved.
 */
const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'

async function world() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
  const [{ PrismaClient }, { PrismaPg }, mint, types] = await Promise.all([
    import('@/app/generated/prisma/client'),
    import('@prisma/adapter-pg'),
    import('@/lib/domain/numbering/mint'),
    import('@/lib/domain/numbering/document-types'),
  ])
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl, max: 30 }) })
  return { db, mint, types }
}
type World = Awaited<ReturnType<typeof world>>

const order = (orderNumber: string) => ({ orderNumber, status: 'DRAFT' as const, currency: 'GBP', subtotalForeign: 1, totalForeign: 1, subtotalBase: 1, totalBase: 1 })

let w: World
const suffixes: string[] = []
/** A pattern prefix nothing else uses, so documents of other tests and of the database never read as "in use". */
function fresh(): string {
  const s = `T${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`
  suffixes.push(s)
  return s
}
async function setPattern(type: 'sales_order' | 'credit_note' | 'shipment' | 'purchase_order', pattern: string | null) {
  await w.db.$executeRaw`DELETE FROM document_number_sequences WHERE document_type = ${type}`
  if (pattern !== null) await w.db.$transaction((tx) => w.mint.setDocumentPattern(tx, type, pattern, null))
}
const mintSo = (options: { fallbackPrefix?: string; date?: Date } = {}) => w.db.$transaction(async (tx) => {
  const value = await w.mint.mintRequiredDocumentNumber(tx, 'sales_order', options)
  await tx.salesOrder.create({ data: order(value) })
  return value
})

before(async () => { if (RUN) w = await world() })
after(async () => {
  if (!RUN) return
  for (const s of suffixes) await w.db.salesOrder.deleteMany({ where: { orderNumber: { startsWith: s } } })
  await w.db.$executeRaw`DELETE FROM document_number_sequences`
  await w.db.setting.deleteMany({ where: { key: { startsWith: 'document_counter:credit_note:' }, value: '77' } })
  await w.db.$disconnect()
})

test('arm 1: twenty concurrent creates are numbered 1..20, unpadded, with no number twice', { skip: !RUN }, async () => {
  const s = fresh()
  await setPattern('sales_order', `${s}-{SEQ}`)
  const numbers = await Promise.all(Array.from({ length: 20 }, () => mintSo()))
  assert.equal(new Set(numbers).size, 20)
  assert.deepEqual(numbers.map((n) => Number(n.slice(s.length + 1))).sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 1))
  assert.ok(numbers.every((n) => /^T[0-9A-F]{8}-\d+$/.test(n) && !n.includes('-0')), 'no implicit padding')
})

test('arm 2: a create that rolls back hands its number back', { skip: !RUN }, async () => {
  const s = fresh()
  await setPattern('sales_order', `${s}-{SEQ}`)
  assert.equal(await mintSo(), `${s}-1`)
  await assert.rejects(() => w.db.$transaction(async (tx) => {
    assert.equal(await w.mint.mintRequiredDocumentNumber(tx, 'sales_order'), `${s}-2`)
    throw new Error('the create failed after the number was minted')
  }), /the create failed/)
  assert.equal(await mintSo(), `${s}-2`, 'the number the failed create had is the next one')
})

test('arm 3: changing the pattern never renumbers a document, and the counter continues', { skip: !RUN }, async () => {
  const s = fresh()
  await setPattern('sales_order', `${s}-{SEQ}`)
  const before = [await mintSo(), await mintSo(), await mintSo()]
  assert.deepEqual(before, [`${s}-1`, `${s}-2`, `${s}-3`])
  await w.db.$transaction((tx) => w.mint.setDocumentPattern(tx, 'sales_order', `${s}B{SEQ:4}`, null))
  const stored = await w.db.salesOrder.findMany({ where: { orderNumber: { startsWith: s } }, select: { orderNumber: true } })
  assert.deepEqual(stored.map((r) => r.orderNumber).sort(), [`${s}-1`, `${s}-2`, `${s}-3`], 'existing documents keep their numbers')
  assert.equal(await mintSo(), `${s}B0004`, 'the counter continues, with the new pattern and the written padding')
  // and back to the default: the sales-order default carries a random tail, no counter row is needed
  await w.db.$transaction((tx) => w.mint.setDocumentPattern(tx, 'sales_order', '', null))
  const again = await w.db.salesOrder.findMany({ where: { orderNumber: { startsWith: s } }, select: { orderNumber: true } })
  assert.equal(again.length, 4)
})

test('arm 4: a taken number is skipped, and 1001 taken in a row are refused', { skip: !RUN }, async () => {
  const s = fresh()
  await setPattern('sales_order', `${s}-{SEQ}`)
  await w.db.salesOrder.createMany({ data: [order(`${s}-2`), order(`${s}-3`)] })
  assert.equal(await mintSo(), `${s}-4`, 'seeded from the highest in use')
  // a block of numbers ahead of the counter, issued under another scheme
  const t = fresh()
  await setPattern('sales_order', `${t}-{SEQ}`)
  assert.equal(await mintSo(), `${t}-1`)
  await w.db.salesOrder.createMany({ data: Array.from({ length: 1001 }, (_, i) => order(`${t}-${i + 2}`)) })
  await assert.rejects(() => mintSo(), (e: unknown) => e instanceof w.mint.DocumentNumberingError && e.code === 'PATTERN_EXHAUSTED' && /Reset the counter/.test(e.message))
  const free = await w.db.salesOrder.count({ where: { orderNumber: { startsWith: t } } })
  assert.equal(free, 1002, 'the refusal wrote nothing')
  await w.db.$transaction((tx) => w.mint.resetDocumentCounter(tx, 'sales_order', 2000, { updatedBy: null }))
  assert.equal(await mintSo(), `${t}-2000`)
})

test('arm 4b: a shipment reference held by another shipment is skipped, and the database refuses a duplicate', { skip: !RUN }, async () => {
  const s = fresh()
  const warehouse = await w.db.warehouse.create({ data: { code: `NW${s.slice(1, 9)}`, name: 'numbering' }, select: { id: true } })
  const so = await w.db.salesOrder.create({ data: order(`${s}-ORDER`), select: { id: true } })
  try {
    await setPattern('shipment', `${s}S{SEQ}`)
    await w.db.shipment.create({ data: { orderId: so.id, warehouseId: warehouse.id, reference: `${s}S1` } })
    const [a, b] = await w.db.$transaction(async (tx) => [await w.mint.mintDocumentNumber(tx, 'shipment'), await w.mint.mintDocumentNumber(tx, 'shipment')])
    assert.deepEqual([a, b], [`${s}S2`, `${s}S3`], 'the taken reference is skipped')
    await assert.rejects(() => w.db.shipment.create({ data: { orderId: so.id, warehouseId: warehouse.id, reference: `${s}S1` } }), /Unique constraint/)
  } finally {
    await w.db.shipment.deleteMany({ where: { orderId: so.id } })
    await w.db.salesOrder.delete({ where: { id: so.id } })
    await w.db.warehouse.delete({ where: { id: warehouse.id } })
  }
})

test('arm 5: the counter resets forward, and is refused at or below the highest number in use', { skip: !RUN }, async () => {
  const s = fresh()
  await setPattern('sales_order', `${s}-{SEQ}`)
  for (let i = 0; i < 5; i++) await mintSo()
  const refuse = (next: number) => w.db.$transaction((tx) => w.mint.resetDocumentCounter(tx, 'sales_order', next, { updatedBy: null }))
  for (const bad of [1, 3, 5]) {
    await assert.rejects(() => refuse(bad), (e: unknown) => e instanceof w.mint.DocumentNumberingError && e.code === 'COUNTER_BELOW_USED' && /number 5 is already in use/.test(e.message), `next=${bad}`)
  }
  for (const bad of [0, -1, 1.5, Number.NaN]) await assert.rejects(() => refuse(bad), /whole number/)
  assert.equal(await mintSo(), `${s}-6`, 'a refused reset changed nothing')
  await refuse(7)
  assert.equal(await mintSo(), `${s}-7`)
  await refuse(100)
  assert.equal(await mintSo(), `${s}-100`)
  await assert.rejects(() => refuse(50), /number 100 is already in use/)
  await w.db.salesOrder.deleteMany({ where: { orderNumber: `${s}-100` } })
  await assert.rejects(() => refuse(7), /number 7 is already in use/)
  await refuse(8)
  assert.equal(await mintSo(), `${s}-8`, 'back from 101 to 8 is allowed once nothing above 7 is in use')
})

test('arm 6: a period holding documents is seeded from them; the old credit note counter is carried over', { skip: !RUN }, async () => {
  const s = fresh()
  await setPattern('sales_order', `${s}-{YYYY}-{SEQ}`)
  const y = new Date().getUTCFullYear()
  await w.db.salesOrder.create({ data: order(`${s}-${y}-41`) })
  await w.db.salesOrder.create({ data: order(`${s}-${y - 1}-900`) })
  assert.equal(await mintSo(), `${s}-${y}-42`, 'this year carries on after this year, whatever last year reached')
  const next = await mintSo({ date: new Date(Date.UTC(y + 1, 0, 2)) })
  assert.equal(next, `${s}-${y + 1}-1`, 'a new year starts its own counter')

  await setPattern('credit_note', null)
  const year = new Date().getFullYear()
  await w.db.setting.upsert({ where: { key: `document_counter:credit_note:${year}` }, create: { key: `document_counter:credit_note:${year}`, value: '77' }, update: { value: '77' } })
  const cn = await w.db.$transaction((tx) => w.mint.mintRequiredDocumentNumber(tx, 'credit_note', { fallbackPrefix: `${s}-` }))
  assert.equal(cn, `${s}-${year}-00078`, 'the default credit note format, continuing the counter the old code kept')
  await w.db.setting.deleteMany({ where: { key: `document_counter:credit_note:${year}` } })
})

test('arm 7: a random-only pattern is locked as well, and a shipment has no number until a pattern is set', { skip: !RUN }, async () => {
  await setPattern('sales_order', null)
  await setPattern('shipment', null)
  const so = await w.db.$transaction((tx) => w.mint.mintRequiredDocumentNumber(tx, 'sales_order', { fallbackPrefix: 'SO-', date: new Date(Date.UTC(2026, 10, 7)) }))
  assert.match(so, /^SO-20261107-[0-9A-Z]{4}$/)
  const rows = await w.db.$queryRaw<Array<{ document_type: string }>>`SELECT document_type FROM document_number_sequences WHERE document_type = 'sales_order'`
  assert.equal(rows.length, 1, 'the random default takes the counter row lock like every other pattern')
  assert.equal(await w.db.$transaction((tx) => w.mint.mintDocumentNumber(tx, 'shipment')), null)
  await w.db.$transaction((tx) => w.mint.setDocumentPattern(tx, 'shipment', 'SHP-{SEQ:6}', null))
  assert.match((await w.db.$transaction((tx) => w.mint.mintDocumentNumber(tx, 'shipment')))!, /^SHP-0000\d\d$/)
  await w.db.$transaction((tx) => w.mint.setDocumentPattern(tx, 'shipment', '', null))
  assert.equal(await w.db.$transaction((tx) => w.mint.mintDocumentNumber(tx, 'shipment')), null, 'emptying the pattern turns shipment numbering off again')
})

test('arm 7b: an invalid pattern is refused and changes nothing', { skip: !RUN }, async () => {
  const s = fresh()
  await setPattern('sales_order', `${s}-{SEQ}`)
  for (const bad of ['NOCOUNTER', '{SEQ', 'A B{SEQ}']) {
    await assert.rejects(() => w.db.$transaction((tx) => w.mint.setDocumentPattern(tx, 'sales_order', bad, null)), (e: unknown) => e instanceof w.mint.DocumentNumberingError && e.code === 'PATTERN_INVALID')
  }
  assert.equal(await mintSo(), `${s}-1`)
})

test('arm 8: the uniqueness probe of every document type runs against the real schema', { skip: !RUN }, async () => {
  for (const type of w.types.NUMBERED_DOCUMENT_TYPES) {
    const spec = w.types.DOCUMENT_TYPE_SPECS[type]
    await w.db.$transaction(async (tx) => {
      assert.equal(await spec.exists(tx, `NOPE-${randomUUID()}`), false, `${type}.exists`)
      assert.deepEqual(await spec.listStartingWith(tx, `NOPE-${randomUUID()}`), [], `${type}.listStartingWith`)
    })
  }
})

test('arm 7c: twelve concurrent creates on a one-character random pattern never share a number', { skip: !RUN }, async () => {
  const s = fresh()
  await setPattern('sales_order', `${s}-{RAND:1}`)
  for (let round = 0; round < 5; round++) {
    const tag = fresh()
    await setPattern('sales_order', `${tag}-{RAND:1}`)
    const numbers = await Promise.all(Array.from({ length: 12 }, () => mintSo()))
    assert.equal(new Set(numbers).size, 12, `round ${round}: ${numbers.join(' ')}`)
  }
})

/** The credit note writer of the code before patterns, verbatim in what it reads and writes: the advisory lock, the yearly Setting counter, the format. */
async function oldWriterCreditNote(prefix: string): Promise<string> {
  return w.db.$transaction(async (tx) => {
    const year = new Date().getFullYear()
    const counterKey = `document_counter:credit_note:${year}`
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${counterKey}))`
    const row = await tx.setting.findUnique({ where: { key: counterKey }, select: { value: true } })
    const current = row?.value ? Number.parseInt(row.value, 10) : 0
    const next = Number.isFinite(current) && current >= 0 ? current + 1 : 1
    await tx.setting.upsert({ where: { key: counterKey }, create: { key: counterKey, value: String(next) }, update: { value: String(next) } })
    return `${prefix}${year}-${String(next).padStart(5, '0')}`
  })
}

test('arm 9: a rolling deploy: old-writer and new-writer credit notes interleaved never repeat a number', { skip: !RUN }, async () => {
  const s = fresh()
  const year = new Date().getFullYear()
  await setPattern('credit_note', null)
  await w.db.setting.deleteMany({ where: { key: `document_counter:credit_note:${year}` } })
  const newWriter = () => w.db.$transaction((tx) => w.mint.mintRequiredDocumentNumber(tx, 'credit_note', { fallbackPrefix: `${s}-` }))
  const sequence: string[] = []
  for (let i = 0; i < 4; i++) { sequence.push(await oldWriterCreditNote(`${s}-`)); sequence.push(await newWriter()) }
  const concurrent = await Promise.all(Array.from({ length: 16 }, (_, i) => (i % 2 === 0 ? oldWriterCreditNote(`${s}-`) : newWriter())))
  const all = [...sequence, ...concurrent]
  assert.equal(new Set(all).size, all.length, 'no credit note number issued twice')
  const counters = all.map((n) => Number(n.slice(`${s}-${year}-`.length))).sort((a, b) => a - b)
  assert.deepEqual(counters, Array.from({ length: all.length }, (_, i) => i + 1), 'one gapless run across both writers')
  const legacy = await w.db.setting.findUnique({ where: { key: `document_counter:credit_note:${year}` }, select: { value: true } })
  assert.equal(Number(legacy?.value), all.length, 'the yearly counter the old code reads stays in step')
  await w.db.setting.deleteMany({ where: { key: `document_counter:credit_note:${year}` } })
})

/** A client with a deliberately small pool and a short wait for a connection, so starvation shows as an error instead of a hang. */
async function smallPoolClient(max: number) {
  const [{ PrismaClient }, { PrismaPg }] = await Promise.all([import('@/app/generated/prisma/client'), import('@prisma/adapter-pg')])
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL!, max, connectionTimeoutMillis: 4000 }) })
}

test('arm 10: twelve concurrent creates on a pool of three finish, with unique numbers, when the number is minted in its own transaction', { skip: !RUN }, async () => {
  const s = fresh()
  const small = await smallPoolClient(3)
  try {
    for (const pattern of [`${s}-{SEQ}`, `${s}-{RAND:2}`]) {
      await setPattern('sales_order', pattern)
      const numbers = await Promise.all(Array.from({ length: 12 }, () => w.mint.retryWhenNumberTaken(async () => {
        const orderNumber = await w.mint.mintCommittedDocumentNumber((run) => small.$transaction(run), 'sales_order')
        return small.$transaction(async (tx) => {
          await w.mint.claimDocumentNumber(tx, 'sales_order', orderNumber)
          await tx.salesOrder.create({ data: order(orderNumber) })
          return orderNumber
        })
      })))
      assert.equal(new Set(numbers).size, 12, `${pattern}: ${numbers.join(' ')}`)
    }
  } finally {
    await small.$disconnect()
  }
})

/** Resolves true when `p` settles inside `ms`, false when it is still pending. */
const settlesWithin = (p: Promise<unknown>, ms: number) => Promise.race([p.then(() => true, () => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))])

test('arm 10b: while a document transaction is open and doing other work, no numbering lock is held: another number is minted at once', { skip: !RUN }, async () => {
  const s = fresh()
  for (const pattern of [`${s}-{SEQ}`, `${s}-{RAND:3}`]) {
    await setPattern('sales_order', pattern)
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let claimed!: () => void
    const inWork = new Promise<void>((r) => { claimed = r })
    const first = w.db.$transaction(async (tx) => {
      const number = await w.mint.mintCommittedDocumentNumber((run) => w.db.$transaction(run), 'sales_order')
      await w.mint.claimDocumentNumber(tx, 'sales_order', number)
      await tx.salesOrder.create({ data: order(number) })
      claimed()
      await gate // the rest of the order's work: queuing its invoice, through pooled connections
      return number
    })
    await inWork
    const second = w.mint.mintCommittedDocumentNumber((run) => w.db.$transaction(run), 'sales_order')
    assert.equal(await settlesWithin(second, 3000), true, `${pattern}: a second mint waited on the open document transaction`)
    release()
    assert.notEqual(await first, await second)
  }
})

test('arm 10c: the old shape, the number minted inside the document transaction, holds the lock across that work (what the committed mint avoids)', { skip: !RUN }, async () => {
  const s = fresh()
  await setPattern('sales_order', `${s}-{SEQ}`)
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  let minted!: () => void
  const inWork = new Promise<void>((r) => { minted = r })
  const first = w.db.$transaction(async (tx) => {
    const number = await w.mint.mintRequiredDocumentNumber(tx, 'sales_order')
    minted()
    await gate
    return number
  })
  await inWork
  const second = w.db.$transaction((tx) => w.mint.mintRequiredDocumentNumber(tx, 'sales_order'))
  assert.equal(await settlesWithin(second, 1500), false, 'the second mint is blocked behind the open transaction')
  release()
  assert.notEqual(await first, await second)
})

test('arm 10d: a number another document already holds is refused at the claim, and the retry mints a fresh one', { skip: !RUN }, async () => {
  const s = fresh()
  await setPattern('sales_order', `${s}-{SEQ}`)
  await w.db.salesOrder.create({ data: order(`${s}-1`) })
  await assert.rejects(() => w.db.$transaction((tx) => w.mint.claimDocumentNumber(tx, 'sales_order', `${s}-1`)), (e: unknown) => e instanceof w.mint.DocumentNumberTakenError)
  let calls = 0
  const result = await w.mint.retryWhenNumberTaken(async () => { calls++; if (calls < 3) throw new w.mint.DocumentNumberTakenError('sales_order', 'x'); return 'done' })
  assert.deepEqual([result, calls], ['done', 3])
  await assert.rejects(() => w.mint.retryWhenNumberTaken(async () => { throw new w.mint.DocumentNumberTakenError('sales_order', 'x') }, 2), w.mint.DocumentNumberTakenError)
})
