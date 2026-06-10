import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import {
  archiveExhaustedEolProducts,
  getProductIncomingStock,
} from '@/lib/domain/inventory/product-lifecycle-archive'

function decimal(value: string | number): Prisma.Decimal {
  return new Prisma.Decimal(value)
}

type ProductLifecycleStatus = 'ACTIVE' | 'EOL' | 'ARCHIVED'

type ProductRecord = {
  id: string
  sku: string
  name: string
  active: boolean
  lifecycleStatus: ProductLifecycleStatus
  type?: 'SIMPLE' | 'VARIABLE' | 'VARIANT'
  parentId?: string | null
  stockQty: Prisma.Decimal
}

function createArchiveClient(options: {
  products: ProductRecord[]
  incomingByProductId?: Map<string, string>
  failActivityLog?: boolean
}) {
  const logs: unknown[] = []
  const findManyCalls: unknown[] = []
  const incomingByProductId = options.incomingByProductId ?? new Map<string, string>()
  const products = options.products

  const productDelegate = {
    findMany: async (args?: unknown) => {
      findManyCalls.push(args)
      const parsed = args as {
        where?: { id?: { gt?: string }; lifecycleStatus?: ProductLifecycleStatus }
        take?: number
      }
      const afterId = parsed.where?.id?.gt
      return products
        .filter((product) => product.lifecycleStatus === parsed.where?.lifecycleStatus)
        .filter((product) => !afterId || product.id > afterId)
        .sort((left, right) => left.id.localeCompare(right.id))
        .slice(0, parsed.take)
        .map((product) => ({ id: product.id, sku: product.sku, name: product.name }))
    },
    findUnique: async (args?: unknown) => {
      const id = (args as { where: { id: string } }).where.id
      const product = products.find((candidate) => candidate.id === id)
      if (!product) return null
      return {
        lifecycleStatus: product.lifecycleStatus,
        type: product.type ?? 'SIMPLE',
        stockLevels: [{ quantity: product.stockQty }],
        variants: products
          .filter((candidate) => candidate.parentId === product.id)
          .map((variant) => ({
            id: variant.id,
            stockLevels: [{ quantity: variant.stockQty }],
          })),
      }
    },
    update: async (args?: unknown) => {
      const parsed = args as {
        where: { id: string }
        data: { active?: boolean; lifecycleStatus?: ProductLifecycleStatus; updatedAt?: Date }
      }
      const product = products.find((candidate) => candidate.id === parsed.where.id)
      assert.ok(product)
      if (parsed.data.active !== undefined) product.active = parsed.data.active
      if (parsed.data.lifecycleStatus) product.lifecycleStatus = parsed.data.lifecycleStatus
      return product
    },
  }

  const transactionClient = {
    $queryRaw: async () => [],
    product: productDelegate,
    purchaseOrderLine: {
      findMany: async (args?: unknown) => {
        const productId = (args as { where: { productId: string } }).where.productId
        const incoming = incomingByProductId.get(productId) ?? '0'
        return decimal(incoming).gt(0)
          ? [{ qty: decimal(incoming), qtyReceived: decimal(0) }]
          : []
      },
    },
    stockTransferLine: { findMany: async () => [] },
    productionOrder: { findMany: async () => [] },
    wmsAsnLineMap: { findMany: async () => [] },
    activityLog: {
      create: async (args?: unknown) => {
        if (options.failActivityLog) throw new Error('audit unavailable')
        logs.push(args)
        return {}
      },
    },
  }

  const client = {
    product: productDelegate,
    $transaction: async <T>(fn: (tx: typeof transactionClient) => Promise<T>): Promise<T> => {
      const productSnapshot = products.map((product) => ({ ...product }))
      const logCount = logs.length
      try {
        return await fn(transactionClient)
      } catch (error) {
        products.splice(0, products.length, ...productSnapshot)
        logs.splice(logCount)
        throw error
      }
    },
  }

  return { client, logs, findManyCalls }
}

test('product incoming stock breakdown sums only remaining inbound quantities', async () => {
  let wmsAsnStatusFilter: unknown
  const client = {
    purchaseOrderLine: {
      findMany: async () => [
        { qty: decimal('10'), qtyReceived: decimal('4') },
        { qty: decimal('2'), qtyReceived: decimal('3') },
      ],
    },
    stockTransferLine: {
      findMany: async () => [
        { qty: decimal('5'), qtyReceived: decimal('1.5') },
      ],
    },
    productionOrder: {
      findMany: async () => [
        { qtyPlanned: decimal('8'), qtyProduced: decimal('2') },
      ],
    },
    wmsAsnLineMap: {
      findMany: async (args?: unknown) => {
        wmsAsnStatusFilter = (args as { where: { asn: { status: { in: string[] } } } }).where.asn.status.in
        return [
          {
            expectedQty: decimal('7'),
            qtyAccountedViaSnapshot: decimal('2'),
            qtyAccountedViaReceipt: decimal('1.25'),
          },
        ]
      },
    },
  }

  const incoming = await getProductIncomingStock('product-1', { client: client as never })

  assert.equal(incoming.purchaseOrders, '6')
  assert.equal(incoming.stockTransfers, '3.5')
  assert.equal(incoming.productionOrders, '6')
  assert.equal(incoming.wmsAsn, '3.75')
  assert.equal(incoming.total, '19.25')
  assert.deepEqual(wmsAsnStatusFilter, ['OPEN', 'PARTIALLY_BOOKED_IN'])
})

test('product incoming stock excludes unconfirmed WMS ASN create states', async () => {
  const client = {
    purchaseOrderLine: { findMany: async () => [] },
    stockTransferLine: { findMany: async () => [] },
    productionOrder: { findMany: async () => [] },
    wmsAsnLineMap: {
      findMany: async (args?: unknown) => {
        const statuses = (args as { where: { asn: { status: { in: string[] } } } }).where.asn.status.in
        assert.equal(statuses.includes('CREATE_PENDING'), false)
        assert.equal(statuses.includes('CREATE_IN_FLIGHT'), false)
        return []
      },
    },
  }

  const incoming = await getProductIncomingStock('product-1', { client: client as never })

  assert.equal(incoming.wmsAsn, '0')
  assert.equal(incoming.total, '0')
})

test('product lifecycle archive archives zero-stock EOL products and audits in the same transaction', async () => {
  const products: ProductRecord[] = [
    { id: 'product-1', sku: 'EOL-ZERO', name: 'Zero stock', active: true, lifecycleStatus: 'EOL', stockQty: decimal(0) },
    { id: 'product-2', sku: 'EOL-STOCK', name: 'Still stocked', active: true, lifecycleStatus: 'EOL', stockQty: decimal(1) },
    { id: 'product-3', sku: 'EOL-INCOMING', name: 'Incoming', active: true, lifecycleStatus: 'EOL', stockQty: decimal(0) },
  ]
  const incomingByProductId = new Map([['product-3', '2']])
  const { client, logs } = createArchiveClient({ products, incomingByProductId })

  const result = await archiveExhaustedEolProducts({
    client: client as never,
    now: new Date('2026-06-10T01:02:03.000Z'),
  })

  assert.deepEqual(result, {
    scanned: 3,
    archived: 1,
    skippedWithStock: 1,
    skippedWithIncoming: 1,
  })
  assert.equal(products[0]?.active, false)
  assert.equal(products[0]?.lifecycleStatus, 'ARCHIVED')
  assert.equal(products[1]?.lifecycleStatus, 'EOL')
  assert.equal(products[2]?.lifecycleStatus, 'EOL')
  assert.equal(logs.length, 1)
  assert.equal(
    ((logs[0] as { data: { metadata: { triggeredBy: string } } }).data.metadata.triggeredBy),
    'product-lifecycle-archive-cron',
  )
})

test('product lifecycle archive paginates past skipped products so later eligible products are not starved', async () => {
  const products: ProductRecord[] = [
    { id: 'product-1', sku: 'EOL-STOCK-1', name: 'Still stocked 1', active: true, lifecycleStatus: 'EOL', stockQty: decimal(5) },
    { id: 'product-2', sku: 'EOL-STOCK-2', name: 'Still stocked 2', active: true, lifecycleStatus: 'EOL', stockQty: decimal(3) },
    { id: 'product-3', sku: 'EOL-ZERO', name: 'Zero stock', active: true, lifecycleStatus: 'EOL', stockQty: decimal(0) },
  ]
  const { client, findManyCalls } = createArchiveClient({ products })

  const result = await archiveExhaustedEolProducts({
    client: client as never,
    batchSize: 1,
    now: new Date('2026-06-10T01:02:03.000Z'),
  })

  assert.deepEqual(result, {
    scanned: 3,
    archived: 1,
    skippedWithStock: 2,
    skippedWithIncoming: 0,
  })
  assert.equal(products[2]?.lifecycleStatus, 'ARCHIVED')
  assert.equal(findManyCalls.length, 4)
  assert.equal(
    ((findManyCalls[1] as { where: { id: { gt: string } } }).where.id.gt),
    'product-1',
  )
  assert.equal(
    ((findManyCalls[2] as { where: { id: { gt: string } } }).where.id.gt),
    'product-2',
  )
})

test('product lifecycle archive keeps variable parents while variants have stock or incoming supply', async () => {
  const products: ProductRecord[] = [
    { id: 'parent-1', sku: 'EOL-PARENT-STOCK', name: 'Parent with stock', active: true, lifecycleStatus: 'EOL', type: 'VARIABLE', stockQty: decimal(0) },
    { id: 'variant-1', sku: 'EOL-VARIANT-STOCK', name: 'Variant stock', active: true, lifecycleStatus: 'ACTIVE', type: 'VARIANT', parentId: 'parent-1', stockQty: decimal(4) },
    { id: 'parent-2', sku: 'EOL-PARENT-INCOMING', name: 'Parent with incoming', active: true, lifecycleStatus: 'EOL', type: 'VARIABLE', stockQty: decimal(0) },
    { id: 'variant-2', sku: 'EOL-VARIANT-INCOMING', name: 'Variant incoming', active: true, lifecycleStatus: 'ACTIVE', type: 'VARIANT', parentId: 'parent-2', stockQty: decimal(0) },
    { id: 'parent-3', sku: 'EOL-PARENT-ZERO', name: 'Parent zero', active: true, lifecycleStatus: 'EOL', type: 'VARIABLE', stockQty: decimal(0) },
    { id: 'variant-3', sku: 'EOL-VARIANT-ZERO', name: 'Variant zero', active: true, lifecycleStatus: 'ACTIVE', type: 'VARIANT', parentId: 'parent-3', stockQty: decimal(0) },
  ]
  const incomingByProductId = new Map([['variant-2', '3']])
  const { client } = createArchiveClient({ products, incomingByProductId })

  const result = await archiveExhaustedEolProducts({
    client: client as never,
    now: new Date('2026-06-10T01:02:03.000Z'),
  })

  assert.deepEqual(result, {
    scanned: 3,
    archived: 1,
    skippedWithStock: 1,
    skippedWithIncoming: 1,
  })
  assert.equal(products[0]?.lifecycleStatus, 'EOL')
  assert.equal(products[2]?.lifecycleStatus, 'EOL')
  assert.equal(products[4]?.lifecycleStatus, 'ARCHIVED')
})

test('product lifecycle archive rolls back the archive update when the audit log write fails', async () => {
  const products: ProductRecord[] = [
    { id: 'product-1', sku: 'EOL-ZERO', name: 'Zero stock', active: true, lifecycleStatus: 'EOL', stockQty: decimal(0) },
  ]
  const { client } = createArchiveClient({ products, failActivityLog: true })

  await assert.rejects(
    archiveExhaustedEolProducts({
      client: client as never,
      now: new Date('2026-06-10T01:02:03.000Z'),
    }),
    /audit unavailable/,
  )

  assert.equal(products[0]?.active, true)
  assert.equal(products[0]?.lifecycleStatus, 'EOL')
})
