import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildCustomerIdentityReport,
  REPORT_COUNT_KEYS,
  type IdentityReportTx,
} from '@/lib/domain/crm/identity-report'

type Cust = { id: string; email: string | null; ext?: number | null; anon?: boolean; woo?: string[] }
type Ord = { id: string; email: string | null; erased?: boolean; customerId?: string | null }

function fakeTx(customers: Cust[], orders: Ord[], log: string[] = [], pageSizes: number[] = []): IdentityReportTx {
  const page = <T extends { id: string }>(rows: T[], a: { take: number; skip?: number; cursor?: { id: string } }) => {
    const sorted = [...rows].sort((x, y) => (x.id < y.id ? -1 : 1))
    const start = a.cursor ? sorted.findIndex((r) => r.id === a.cursor!.id) + (a.skip ?? 0) : 0
    pageSizes.push(a.take)
    return sorted.slice(start, start + a.take)
  }
  return {
    async $executeRawUnsafe(sql: string) {
      log.push(sql)
    },
    customer: {
      async findMany(a) {
        log.push('customer.findMany')
        return page(customers, a).map((c) => ({
          id: c.id,
          email: c.email,
          externalCustomerId: c.ext ?? null,
          gdprAnonymisedAt: c.anon ? new Date() : null,
          shoppingLinks: (c.woo ?? []).map((externalCustomerId) => ({ externalCustomerId })),
        }))
      },
    },
    salesOrder: {
      async findMany(a) {
        log.push('salesOrder.findMany')
        return page(orders.filter((o) => (o.customerId ?? null) === null), a).map((o) => ({
          id: o.id,
          customerEmail: o.email,
          erasedAt: o.erased ? new Date() : null,
        }))
      },
    },
  }
}

const customers: Cust[] = [
  { id: 'c01', email: 'a@example.com', woo: ['10'] },
  { id: 'c02', email: ' A@Example.com', woo: ['11'] }, // case/whitespace variant, two woo ids
  { id: 'c03', email: 'b@example.com' },
  { id: 'c04', email: 'b@example.com' }, // byte identical
  { id: 'c05', email: 'p@example.com' },
  { id: 'c06', email: 'p+shop@example.com' }, // plus variant
  { id: 'c07', email: 'j.ane@gmail.com' },
  { id: 'c08', email: 'jane@googlemail.com' }, // gmail dot/alias variant
  { id: 'c09', email: null },
  { id: 'c10', email: 'gone@site.invalid' },
  { id: 'c11', email: 'anon@example.com', anon: true, woo: ['12'] },
  { id: 'c12', email: 'solo@example.com' },
]
const orders: Ord[] = [
  { id: 'o1', email: 'x@example.com', erased: true },
  { id: 'o2', email: null },
  { id: 'o3', email: 'deleted@site.invalid' },
  { id: 'o4', email: 'A@EXAMPLE.com' }, // matches live customer
  { id: 'o5', email: 'anon@example.com' }, // only an anonymised customer: not live
  { id: 'o6', email: 'stranger@example.com' },
  { id: 'o7', email: 'a@example.com', customerId: 'c01' }, // has customer: out of scope
]

test('report buckets synthetic data correctly', async () => {
  const r = await buildCustomerIdentityReport(fakeTx(customers, orders))
  assert.equal(r.customersTotal, 12)
  assert.equal(r.customersWithWooLink, 3)
  assert.equal(r.customersWithoutWooLink, 9)
  assert.equal(r.customersAnonymised, 1)
  assert.equal(r.customersNullOrPlaceholderEmail, 2)
  assert.deepEqual(r.strictKeyGroupSizeHistogram, { size1: 5, size2: 2, size3: 0, size4: 0, size5Plus: 0 })
  assert.equal(r.strictGroupsOfTwoOrMore, 2)
  assert.equal(r.strictGroupsByteIdentical, 1)
  assert.equal(r.strictGroupsCaseOrWhitespaceOnly, 1)
  assert.equal(r.looseGroupsMergingDistinctStrictKeys, 2)
  assert.equal(r.plusVariantGroups, 1)
  assert.equal(r.gmailDotVariantGroups, 1)
  assert.equal(r.strictGroupsWithTwoOrMoreWooIds, 1)
  assert.equal(r.ordersWithoutCustomerTotal, 6)
  assert.equal(r.ordersWithoutCustomerErased, 1)
  assert.equal(r.ordersWithoutCustomerNoEmail, 2)
  assert.equal(r.ordersWithoutCustomerEmailMatchesLiveCustomer, 1)
  assert.equal(r.ordersWithoutCustomerOtherEmail, 2)
})

test('output holds only declared count keys and no email-like or non-numeric values', async () => {
  const r = await buildCustomerIdentityReport(fakeTx(customers, orders))
  assert.deepEqual(Object.keys(r).sort(), [...REPORT_COUNT_KEYS].sort())
  const walk = (v: unknown) => {
    if (typeof v === 'number') return assert.ok(Number.isInteger(v) && v >= 0)
    // sampleClusters: customer ids only (opaque row ids)
    if (typeof v === 'string') return assert.match(v, /^c\d+$/)
    assert.equal(typeof v, 'object')
    for (const x of Object.values(v as object)) walk(x)
  }
  walk(r)
  const text = JSON.stringify(r)
  assert.ok(!text.includes('@'))
  assert.ok(!/[a-z0-9._+-]+@[a-z0-9.-]+/i.test(text))
  assert.ok(!/example\.com|googlemail|\.invalid/i.test(text))
})

test('the transaction is set READ ONLY before any read', async () => {
  const log: string[] = []
  await buildCustomerIdentityReport(fakeTx(customers, orders, log))
  assert.equal(log[0], 'SET TRANSACTION READ ONLY')
  assert.ok(log.filter((l) => /^(INSERT|UPDATE|DELETE)/i.test(l)).length === 0)
})

test('reads in batches of 1000 and pages across batch boundaries', async () => {
  const many: Cust[] = Array.from({ length: 2500 }, (_, i) => ({ id: `c${String(i).padStart(5, '0')}`, email: `u${i % 1250}@example.com` }))
  const sizes: number[] = []
  const r = await buildCustomerIdentityReport(fakeTx(many, [], [], sizes))
  assert.ok(sizes.every((s) => s === 1000))
  assert.equal(r.customersTotal, 2500)
  assert.equal(r.strictKeyGroupSizeHistogram.size2, 1250)
})

test('derived clusters follow the resolver: folded email, split by storefront account, sampled as ids only', async () => {
  const cs: Cust[] = [
    { id: 'c01', email: 'a@example.com', woo: ['10'] },
    { id: 'c02', email: ' A+x@Example.com', woo: ['10'] }, // same person
    { id: 'c03', email: 'a@example.com', woo: ['11'] }, // same email, different storefront account: separate person
    { id: 'c04', email: 'j.ane@gmail.com' },
    { id: 'c05', email: 'jane@googlemail.com' },
    { id: 'c06', email: 'jane+z@gmail.com' },
    { id: 'c07', email: 'jane@gmail.com', anon: true }, // never joins
    { id: 'c08', email: 'solo@example.com' },
  ]
  const r = await buildCustomerIdentityReport(fakeTx(cs, []))
  assert.equal(r.derivedClustersOfTwoOrMore, 2)
  assert.equal(r.derivedClusterCustomerRecords, 5)
  assert.equal(r.derivedGroupsSplitByStorefrontId, 1)
  assert.deepEqual(r.sampleClusters, [{ size: 3, customerIds: ['c04', 'c05', 'c06'] }, { size: 2, customerIds: ['c01', 'c02'] }])
})
