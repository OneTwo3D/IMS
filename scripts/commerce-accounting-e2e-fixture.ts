import 'dotenv/config'
import { db } from '../lib/db/index.ts'
import { importWcOrder } from '../lib/connectors/woocommerce/sync/order-import.ts'
import type { WcFullOrder } from '../lib/connectors/woocommerce/sync/types.ts'

function uniqueSuffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

async function upsertSetting(key: string, value: string) {
  await db.setting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  })
}

async function seedAccountingSettings() {
  await Promise.all([
    upsertSetting('plugin_xero_enabled', 'true'),
    upsertSetting('plugin_woocommerce_enabled', 'true'),
    upsertSetting('xero_sync_enabled', 'true'),
    upsertSetting('xero_sales_account', '200'),
    upsertSetting('xero_shipping_account', '210'),
    upsertSetting('xero_discount_account', '220'),
    upsertSetting('xero_cogs_account', '500'),
    upsertSetting('xero_inventory_account', '630'),
    upsertSetting('xero_allocated_inventory_account', '631'),
    upsertSetting('xero_unearned_revenue_account', '820'),
    upsertSetting('xero_transit_account', '640'),
  ])
}

async function seedManualFxOrderUiScenario() {
  await seedAccountingSettings()

  await db.currency.upsert({
    where: { code: 'JPY' },
    update: {
      name: 'Japanese Yen',
      symbol: 'JPY',
      symbolPosition: 'PREFIX',
      active: true,
    },
    create: {
      code: 'JPY',
      name: 'Japanese Yen',
      symbol: 'JPY',
      symbolPosition: 'PREFIX',
      active: true,
    },
  })
  await db.fxRate.create({
    data: {
      fromCurrency: 'GBP',
      toCurrency: 'JPY',
      rate: 173.456789,
    },
  })

  console.log(JSON.stringify({
    currency: 'JPY',
    expectedLineUnitAmount: 1234.56,
    expectedLineDiscountAmount: 15,
    expectedShippingAmount: 50,
    expectedOrderDiscountAmount: 25,
  }))
}

async function ensureDefaultWarehouse() {
  return db.warehouse.upsert({
    where: { code: 'DEFAULT' },
    update: {
      name: 'Default',
      type: 'STANDARD',
      availableForSale: true,
      syncToStore: false,
      isDefault: true,
      defaultReturnWarehouse: true,
      active: true,
    },
    create: {
      code: 'DEFAULT',
      name: 'Default',
      type: 'STANDARD',
      availableForSale: true,
      syncToStore: false,
      isDefault: true,
      defaultReturnWarehouse: true,
      active: true,
    },
  })
}

async function seedFxRefundScenario() {
  const suffix = uniqueSuffix()
  await seedAccountingSettings()
  const warehouse = await ensureDefaultWarehouse()
  const customer = await db.customer.create({
    data: {
      firstName: 'FX',
      lastName: `Refund ${suffix}`,
      email: `fx-refund-${suffix}@example.com`,
      active: true,
    },
  })
  const product = await db.product.create({
    data: {
      sku: `E2E-FX-REFUND-${suffix}`,
      name: `FX Refund ${suffix}`,
      type: 'SIMPLE',
      lifecycleStatus: 'ACTIVE',
      salesPriceBase: 10,
      salesPriceTaxInclusive: false,
      taxCategory: 'STANDARD',
      stockUnit: 'pcs',
      oversellAllowed: false,
      active: true,
    },
  })

  const fxRate = 173.456789
  const unitPriceForeign = 1234.5678
  const unitPriceBase = Math.round((unitPriceForeign / fxRate) * 1_000_000) / 1_000_000
  const totalBase = Math.round((unitPriceForeign / fxRate) * 10_000) / 10_000

  const order = await db.salesOrder.create({
    data: {
      orderNumber: `SO-FX-${suffix}`,
      externalOrderNumber: `FX-${suffix}`,
      status: 'SHIPPED',
      currency: 'JPY',
      fxRateToBase: fxRate,
      customerId: customer.id,
      customerName: `${customer.firstName} ${customer.lastName}`,
      customerEmail: customer.email,
      billingAddress: { country: 'JP' } as never,
      shippingAddress: { country: 'JP' } as never,
      subtotalForeign: unitPriceForeign,
      shippingForeign: 0,
      taxForeign: 0,
      pricesIncludeVat: false,
      totalForeign: unitPriceForeign,
      subtotalBase: totalBase,
      shippingBase: 0,
      taxBase: 0,
      totalBase,
      shipFromWarehouseId: warehouse.id,
      shippedAt: new Date(),
      lines: {
        create: [
          {
            productId: product.id,
            sku: product.sku,
            description: product.name,
            qty: 1,
            unitPriceForeign,
            unitPriceBase,
            totalForeign: unitPriceForeign,
            totalBase,
          },
        ],
      },
    },
  })

  console.log(JSON.stringify({
    orderId: order.id,
    expectedUnitAmount: unitPriceForeign,
  }))
}

async function seedMixedRateRefundScenario() {
  const suffix = uniqueSuffix()
  await seedAccountingSettings()
  const warehouse = await ensureDefaultWarehouse()
  const customer = await db.customer.create({
    data: {
      firstName: 'Mixed',
      lastName: `Refund ${suffix}`,
      email: `mixed-refund-${suffix}@example.com`,
      active: true,
    },
  })
  const standardRate = await db.taxRate.create({
    data: {
      name: `Mixed Refund Standard ${suffix}`,
      rate: 0.2,
      type: 'VAT',
      taxCategory: 'STANDARD',
      usedFor: 'SALES',
      accountingTaxType: 'STANDARD20',
      active: true,
    },
  })
  const reducedRate = await db.taxRate.create({
    data: {
      name: `Mixed Refund Reduced ${suffix}`,
      rate: 0.05,
      type: 'VAT',
      taxCategory: 'REDUCED',
      usedFor: 'SALES',
      accountingTaxType: 'REDUCED5',
      active: true,
    },
  })
  const standardProduct = await db.product.create({
    data: {
      sku: `E2E-MIXED-STD-${suffix}`,
      name: `Mixed Refund Standard Product ${suffix}`,
      type: 'SIMPLE',
      lifecycleStatus: 'ACTIVE',
      salesPriceBase: 12,
      salesPriceTaxInclusive: false,
      taxCategory: 'STANDARD',
      stockUnit: 'pcs',
      oversellAllowed: false,
      active: true,
    },
  })
  const reducedProduct = await db.product.create({
    data: {
      sku: `E2E-MIXED-RED-${suffix}`,
      name: `Mixed Refund Reduced Product ${suffix}`,
      type: 'SIMPLE',
      lifecycleStatus: 'ACTIVE',
      salesPriceBase: 8,
      salesPriceTaxInclusive: false,
      taxCategory: 'REDUCED',
      stockUnit: 'pcs',
      oversellAllowed: false,
      active: true,
    },
  })

  const order = await db.salesOrder.create({
    data: {
      orderNumber: `SO-MIXED-${suffix}`,
      externalOrderNumber: `MIXED-${suffix}`,
      status: 'SHIPPED',
      currency: 'GBP',
      fxRateToBase: 1,
      customerId: customer.id,
      customerName: `${customer.firstName} ${customer.lastName}`,
      customerEmail: customer.email,
      billingAddress: { country: 'GB' } as never,
      shippingAddress: { country: 'GB' } as never,
      subtotalForeign: 20,
      shippingForeign: 0,
      taxRateName: standardRate.name,
      taxRatePercent: 0.2,
      taxForeign: 2.8,
      pricesIncludeVat: false,
      totalForeign: 22.8,
      subtotalBase: 20,
      shippingBase: 0,
      taxBase: 2.8,
      totalBase: 22.8,
      shipFromWarehouseId: warehouse.id,
      shippedAt: new Date(),
      lines: {
        create: [
          {
            productId: standardProduct.id,
            sku: standardProduct.sku,
            description: standardProduct.name,
            qty: 1,
            unitPriceForeign: 12,
            unitPriceBase: 12,
            taxRateId: standardRate.id,
            taxForeign: 2.4,
            taxBase: 2.4,
            totalForeign: 12,
            totalBase: 12,
          },
          {
            productId: reducedProduct.id,
            sku: reducedProduct.sku,
            description: reducedProduct.name,
            qty: 1,
            unitPriceForeign: 8,
            unitPriceBase: 8,
            taxRateId: reducedRate.id,
            taxForeign: 0.4,
            taxBase: 0.4,
            totalForeign: 8,
            totalBase: 8,
          },
        ],
      },
    },
  })

  console.log(JSON.stringify({
    orderId: order.id,
    expectedTaxTypes: ['STANDARD20', 'REDUCED5'],
  }))
}

async function inspectFxRefundScenario(orderId: string) {
  const refund = await db.salesOrderRefund.findFirst({
    where: { orderId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      lines: {
        select: {
          unitPriceForeign: true,
          unitPriceBase: true,
          totalForeign: true,
          totalBase: true,
        },
      },
    },
  })

  const creditNoteLog = refund
    ? await db.accountingSyncLog.findFirst({
        where: {
          connector: 'xero',
          type: 'CREDIT_NOTE',
          referenceType: 'SalesOrderRefund',
          referenceId: refund.id,
        },
        orderBy: { createdAt: 'desc' },
        select: { payload: true },
      })
    : null

  const payload = creditNoteLog?.payload as {
    currency?: string
    lines?: Array<{ description?: string; quantity?: number; unitAmount?: number }>
  } | null

  console.log(JSON.stringify({
    refundLine: refund?.lines[0]
      ? {
          unitPriceForeign: Number(refund.lines[0].unitPriceForeign),
          unitPriceBase: Number(refund.lines[0].unitPriceBase),
          totalForeign: Number(refund.lines[0].totalForeign),
          totalBase: Number(refund.lines[0].totalBase),
        }
      : null,
    creditNoteCurrency: payload?.currency ?? null,
    creditNoteLines: Array.isArray(payload?.lines)
      ? payload.lines.map((line) => ({
          description: line.description ?? null,
          quantity: Number(line.quantity ?? 0),
          unitAmount: Number(line.unitAmount ?? 0),
        }))
      : [],
  }))
}

async function inspectCreditNoteScenario(orderId: string) {
  const refund = await db.salesOrderRefund.findFirst({
    where: { orderId },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  })

  const creditNoteLog = refund
    ? await db.accountingSyncLog.findFirst({
        where: {
          connector: 'xero',
          type: 'CREDIT_NOTE',
          referenceType: 'SalesOrderRefund',
          referenceId: refund.id,
        },
        orderBy: { createdAt: 'desc' },
        select: { payload: true },
      })
    : null

  const payload = creditNoteLog?.payload as {
    lines?: Array<{ description?: string; quantity?: number; unitAmount?: number; taxType?: string }>
  } | null

  console.log(JSON.stringify({
    lines: Array.isArray(payload?.lines)
      ? payload.lines.map((line) => ({
          description: line.description ?? null,
          quantity: Number(line.quantity ?? 0),
          unitAmount: Number(line.unitAmount ?? 0),
          taxType: line.taxType ?? null,
        }))
      : [],
  }))
}

async function importWcFeeScenario() {
  const suffix = uniqueSuffix()
  await seedAccountingSettings()

  const product = await db.product.create({
    data: {
      sku: `E2E-WC-FEE-${suffix}`,
      name: `WC Fee Product ${suffix}`,
      type: 'SIMPLE',
      lifecycleStatus: 'ACTIVE',
      salesPriceBase: 10,
      salesPriceTaxInclusive: false,
      taxCategory: 'STANDARD',
      stockUnit: 'pcs',
      oversellAllowed: false,
      active: true,
    },
  })

  const standardTaxRate = await db.taxRate.create({
    data: {
      name: `E2E Standard Rate ${suffix}`,
      rate: 0.2,
      type: 'VAT',
      taxCategory: 'STANDARD',
      usedFor: 'BOTH',
      accountingTaxType: 'STANDARD20',
      active: true,
    },
  })
  const reducedTaxRate = await db.taxRate.create({
    data: {
      name: `E2E Reduced Rate ${suffix}`,
      rate: 0.05,
      type: 'VAT',
      taxCategory: 'REDUCED',
      usedFor: 'BOTH',
      accountingTaxType: 'REDUCED5',
      active: true,
    },
  })

  const standardExternalRateId = String(Math.floor(Date.now() % 1_000_000))
  const reducedExternalRateId = String((Math.floor(Date.now() % 1_000_000)) + 1)

  await db.shoppingTaxRateMapping.createMany({
    data: [
      {
        connector: 'woocommerce',
        externalTaxRateId: standardExternalRateId,
        externalName: 'Standard',
        externalCountry: 'GB',
        externalRatePct: 20,
        externalClass: '',
        taxRateId: standardTaxRate.id,
      },
      {
        connector: 'woocommerce',
        externalTaxRateId: reducedExternalRateId,
        externalName: 'Reduced',
        externalCountry: 'GB',
        externalRatePct: 5,
        externalClass: 'reduced-rate',
        taxRateId: reducedTaxRate.id,
      },
    ],
  })

  const externalOrderId = Math.floor(Date.now() / 1000)
  const wcOrder: WcFullOrder = {
    id: externalOrderId,
    parent_id: 0,
    number: `WC-FEE-${suffix}`,
    order_key: `wc_order_${suffix}`,
    created_via: 'checkout',
    version: '9.0.0',
    status: 'processing',
    currency: 'GBP',
    date_created: new Date().toISOString(),
    date_created_gmt: new Date().toISOString(),
    date_modified: new Date().toISOString(),
    date_modified_gmt: new Date().toISOString(),
    discount_total: '0',
    discount_tax: '0',
    shipping_total: '10',
    shipping_tax: '2',
    cart_tax: '2.25',
    total: '29.25',
    total_tax: '4.25',
    prices_include_tax: false,
    customer_id: 0,
    customer_ip_address: '127.0.0.1',
    customer_note: '',
    billing: {
      first_name: 'Woo',
      last_name: 'Fee',
      company: '',
      address_1: '1 Test Street',
      address_2: '',
      city: 'London',
      state: '',
      postcode: 'SW1A 1AA',
      country: 'GB',
      email: `wc-fee-${suffix}@example.com`,
      phone: '',
    },
    shipping: {
      first_name: 'Woo',
      last_name: 'Fee',
      company: '',
      address_1: '1 Test Street',
      address_2: '',
      city: 'London',
      state: '',
      postcode: 'SW1A 1AA',
      country: 'GB',
      phone: '',
    },
    payment_method: 'bacs',
    payment_method_title: 'Direct bank transfer',
    transaction_id: '',
    date_paid: null,
    date_paid_gmt: null,
    date_completed: null,
    date_completed_gmt: null,
    cart_hash: `hash-${suffix}`,
    meta_data: [],
    line_items: [
      {
        id: externalOrderId + 1,
        name: product.name,
        product_id: externalOrderId + 10,
        variation_id: 0,
        quantity: 1,
        tax_class: '',
        subtotal: '10',
        subtotal_tax: '2',
        total: '10',
        total_tax: '2',
        taxes: [{ id: Number(standardExternalRateId), total: '2', subtotal: '2' }],
        meta_data: [],
        sku: product.sku,
        price: 10,
      },
    ],
    tax_lines: [
      {
        id: externalOrderId + 2,
        rate_code: 'GB-STD-20',
        rate_id: Number(standardExternalRateId),
        label: 'Standard',
        compound: false,
        tax_total: '2',
        shipping_tax_total: '2',
      },
      {
        id: externalOrderId + 3,
        rate_code: 'GB-RED-5',
        rate_id: Number(reducedExternalRateId),
        label: 'Reduced',
        compound: false,
        tax_total: '0.25',
        shipping_tax_total: '0',
      },
    ],
    shipping_lines: [
      {
        id: externalOrderId + 4,
        method_title: 'Tracked 24',
        method_id: 'flat_rate',
        total: '10',
        total_tax: '2',
        taxes: [{ id: Number(standardExternalRateId), total: '2' }],
      },
    ],
    fee_lines: [
      {
        id: externalOrderId + 5,
        name: 'Handling Fee',
        tax_class: 'reduced-rate',
        total: '5',
        total_tax: '0.25',
        taxes: [{ id: Number(reducedExternalRateId), total: '0.25' }],
      },
    ],
    coupon_lines: [],
    refunds: [],
  }

  const result = await importWcOrder(wcOrder)
  if (!result.success || !result.orderId) {
    throw new Error(result.error ?? 'Failed to import WC fee order')
  }

  console.log(JSON.stringify({
    orderId: result.orderId,
    feeDescription: 'Handling Fee',
  }))
}

async function inspectWcFeeScenario(orderId: string) {
  const order = await db.salesOrder.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      shippingForeign: true,
      taxForeign: true,
      lines: {
        orderBy: { description: 'asc' },
        select: {
          description: true,
          qty: true,
          unitPriceForeign: true,
          taxForeign: true,
          totalForeign: true,
        },
      },
    },
  })

  const invoiceLog = await db.accountingSyncLog.findFirst({
    where: {
      connector: 'xero',
      type: 'SALES_INVOICE',
      referenceType: 'SalesOrder',
      referenceId: orderId,
    },
    orderBy: { createdAt: 'desc' },
    select: { payload: true },
  })

  const payload = invoiceLog?.payload as {
    shippingAmount?: number
    shippingTaxType?: string
    lines?: Array<{ description?: string; quantity?: number; unitAmount?: number; taxType?: string }>
  } | null

  console.log(JSON.stringify({
    shippingForeign: Number(order.shippingForeign),
    taxForeign: Number(order.taxForeign),
    orderLines: order.lines.map((line) => ({
      description: line.description,
      qty: Number(line.qty),
      unitPriceForeign: Number(line.unitPriceForeign),
      taxForeign: Number(line.taxForeign),
      totalForeign: Number(line.totalForeign),
    })),
    invoicePayload: {
      shippingAmount: Number(payload?.shippingAmount ?? 0),
      shippingTaxType: payload?.shippingTaxType ?? null,
      lines: Array.isArray(payload?.lines)
        ? payload.lines.map((line) => ({
            description: line.description ?? null,
            quantity: Number(line.quantity ?? 0),
            unitAmount: Number(line.unitAmount ?? 0),
            taxType: line.taxType ?? null,
          }))
        : [],
    },
  }))
}

async function inspectSalesInvoice(orderId: string) {
  const invoiceLog = await db.accountingSyncLog.findFirst({
    where: {
      connector: 'xero',
      type: 'SALES_INVOICE',
      referenceType: 'SalesOrder',
      referenceId: orderId,
    },
    orderBy: { createdAt: 'desc' },
    select: { payload: true },
  })

  const payload = invoiceLog?.payload as {
    currency?: string
    shippingAmount?: number
    discountAmount?: number
    lineAmountsIncludeTax?: boolean
    lines?: Array<{
      description?: string
      quantity?: number
      unitAmount?: number
      discountAmount?: number
      taxType?: string
    }>
  } | null

  console.log(JSON.stringify({
    currency: payload?.currency ?? null,
    shippingAmount: Number(payload?.shippingAmount ?? 0),
    discountAmount: Number(payload?.discountAmount ?? 0),
    lineAmountsIncludeTax: typeof payload?.lineAmountsIncludeTax === 'boolean' ? payload.lineAmountsIncludeTax : null,
    lines: Array.isArray(payload?.lines)
      ? payload.lines.map((line) => ({
          description: line.description ?? null,
          quantity: Number(line.quantity ?? 0),
          unitAmount: Number(line.unitAmount ?? 0),
          discountAmount: Number(line.discountAmount ?? 0),
          taxType: line.taxType ?? null,
        }))
      : [],
  }))
}

async function importWcDiscountScenario() {
  const suffix = uniqueSuffix()
  await seedAccountingSettings()

  const product = await db.product.create({
    data: {
      sku: `E2E-WC-DISC-${suffix}`,
      name: `WC Discount Product ${suffix}`,
      type: 'SIMPLE',
      lifecycleStatus: 'ACTIVE',
      salesPriceBase: 10,
      salesPriceTaxInclusive: false,
      taxCategory: 'STANDARD',
      stockUnit: 'pcs',
      oversellAllowed: false,
      active: true,
    },
  })

  const standardTaxRate = await db.taxRate.create({
    data: {
      name: `E2E WC Discount Standard ${suffix}`,
      rate: 0.2,
      type: 'VAT',
      taxCategory: 'STANDARD',
      usedFor: 'BOTH',
      accountingTaxType: 'STANDARD20',
      active: true,
    },
  })

  const standardExternalRateId = String(Math.floor(Date.now() % 1_000_000))
  await db.shoppingTaxRateMapping.create({
    data: {
      connector: 'woocommerce',
      externalTaxRateId: standardExternalRateId,
      externalName: 'Standard',
      externalCountry: 'GB',
      externalRatePct: 20,
      externalClass: '',
      taxRateId: standardTaxRate.id,
    },
  })

  const externalOrderId = Math.floor(Date.now() / 1000)
  const wcOrder: WcFullOrder = {
    id: externalOrderId,
    parent_id: 0,
    number: `WC-DISC-${suffix}`,
    order_key: `wc_order_${suffix}`,
    created_via: 'checkout',
    version: '9.0.0',
    status: 'processing',
    currency: 'GBP',
    date_created: new Date().toISOString(),
    date_created_gmt: new Date().toISOString(),
    date_modified: new Date().toISOString(),
    date_modified_gmt: new Date().toISOString(),
    discount_total: '0',
    discount_tax: '0',
    shipping_total: '0',
    shipping_tax: '0',
    cart_tax: '2',
    total: '10',
    total_tax: '2',
    prices_include_tax: false,
    customer_id: 0,
    customer_ip_address: '127.0.0.1',
    customer_note: '',
    billing: {
      first_name: 'Woo',
      last_name: 'Discount',
      company: '',
      address_1: '1 Test Street',
      address_2: '',
      city: 'London',
      state: '',
      postcode: 'SW1A 1AA',
      country: 'GB',
      email: `wc-discount-${suffix}@example.com`,
      phone: '',
    },
    shipping: {
      first_name: 'Woo',
      last_name: 'Discount',
      company: '',
      address_1: '1 Test Street',
      address_2: '',
      city: 'London',
      state: '',
      postcode: 'SW1A 1AA',
      country: 'GB',
      phone: '',
    },
    payment_method: 'bacs',
    payment_method_title: 'Direct bank transfer',
    transaction_id: '',
    date_paid: null,
    date_paid_gmt: null,
    date_completed: null,
    date_completed_gmt: null,
    cart_hash: `hash-${suffix}`,
    meta_data: [],
    line_items: [
      {
        id: externalOrderId + 1,
        name: product.name,
        product_id: externalOrderId + 10,
        variation_id: 0,
        quantity: 1,
        tax_class: '',
        subtotal: '12',
        subtotal_tax: '2.4',
        total: '10',
        total_tax: '2',
        taxes: [{ id: Number(standardExternalRateId), total: '2', subtotal: '2.4' }],
        meta_data: [],
        sku: product.sku,
        price: 12,
      },
    ],
    tax_lines: [
      {
        id: externalOrderId + 2,
        rate_code: 'GB-STD-20',
        rate_id: Number(standardExternalRateId),
        label: 'Standard',
        compound: false,
        tax_total: '2',
        shipping_tax_total: '0',
      },
    ],
    shipping_lines: [],
    fee_lines: [],
    coupon_lines: [],
    refunds: [],
  }

  const result = await importWcOrder(wcOrder)
  if (!result.success || !result.orderId) {
    throw new Error(result.error ?? 'Failed to import WC discount order')
  }

  console.log(JSON.stringify({
    orderId: result.orderId,
    productDescription: product.name,
    expectedLineDiscountAmount: 2,
  }))
}

async function seedDailyBatchDiscountScenario() {
  const suffix = uniqueSuffix()
  await seedAccountingSettings()

  const customer = await db.customer.create({
    data: {
      firstName: 'Daily',
      lastName: `Batch ${suffix}`,
      email: `daily-batch-${suffix}@example.com`,
      active: true,
    },
  })

  const manualOrder = await db.salesOrder.create({
    data: {
      orderNumber: `SO-MANUAL-BATCH-${suffix}`,
      status: 'PROCESSING',
      currency: 'GBP',
      fxRateToBase: 1,
      customerId: customer.id,
      customerName: `${customer.firstName} ${customer.lastName}`,
      customerEmail: customer.email,
      subtotalForeign: 100,
      shippingForeign: 0,
      taxForeign: 16,
      pricesIncludeVat: true,
      totalForeign: 96,
      subtotalBase: 100,
      shippingBase: 0,
      taxBase: 16,
      totalBase: 96,
      discountAmount: 24,
      taxRatePercent: 0.2,
      paidAt: new Date(),
      accountingInvoiceId: `manual-${suffix}`,
    },
  })

  const wcOrder = await db.salesOrder.create({
    data: {
      orderNumber: `SO-WC-BATCH-${suffix}`,
      status: 'PROCESSING',
      currency: 'GBP',
      fxRateToBase: 1,
      customerId: customer.id,
      customerName: `${customer.firstName} ${customer.lastName}`,
      customerEmail: customer.email,
      subtotalForeign: 100,
      shippingForeign: 0,
      taxForeign: 15.2,
      pricesIncludeVat: true,
      totalForeign: 91.2,
      subtotalBase: 100,
      shippingBase: 0,
      taxBase: 15.2,
      totalBase: 91.2,
      discountAmount: 24,
      taxRatePercent: 0.2,
      paidAt: new Date(),
      accountingInvoiceId: `wc-${suffix}`,
      shoppingLinks: {
        create: {
          connector: 'woocommerce',
          externalOrderId: `wc-${suffix}`,
          externalOrderNumber: `WC-${suffix}`,
        },
      },
    },
  })

  console.log(JSON.stringify({
    manualOrderId: manualOrder.id,
    wcOrderId: wcOrder.id,
  }))
}

async function runDailyBatchDiscountScenario() {
  const { runDailyBatchSync } = await import('../lib/connectors/xero/daily-sync.ts')
  const result = await runDailyBatchSync()
  console.log(JSON.stringify(result))
}

async function inspectDailyBatchDiscountScenario(manualOrderId: string, wcOrderId: string) {
  const orders = await db.salesOrder.findMany({
    where: { id: { in: [manualOrderId, wcOrderId] } },
    select: {
      id: true,
      unearnedRevenueAmount: true,
      revenueDeferredDate: true,
    },
    orderBy: { id: 'asc' },
  })

  console.log(JSON.stringify(orders.map((order) => ({
    id: order.id,
    unearnedRevenueAmount: Number(order.unearnedRevenueAmount ?? 0),
    revenueDeferred: !!order.revenueDeferredDate,
  }))))
}

async function main() {
  const [command, ...args] = process.argv.slice(2)

  switch (command) {
    case 'seed-manual-fx-order-ui':
      await seedManualFxOrderUiScenario()
      break
    case 'seed-fx-refund':
      await seedFxRefundScenario()
      break
    case 'seed-mixed-rate-refund':
      await seedMixedRateRefundScenario()
      break
    case 'inspect-fx-refund':
      if (!args[0]) throw new Error('inspect-fx-refund requires <orderId>')
      await inspectFxRefundScenario(args[0])
      break
    case 'inspect-credit-note':
      if (!args[0]) throw new Error('inspect-credit-note requires <orderId>')
      await inspectCreditNoteScenario(args[0])
      break
    case 'import-wc-fee-order':
      await importWcFeeScenario()
      break
    case 'inspect-wc-fee-order':
      if (!args[0]) throw new Error('inspect-wc-fee-order requires <orderId>')
      await inspectWcFeeScenario(args[0])
      break
    case 'inspect-sales-invoice':
      if (!args[0]) throw new Error('inspect-sales-invoice requires <orderId>')
      await inspectSalesInvoice(args[0])
      break
    case 'import-wc-discount-order':
      await importWcDiscountScenario()
      break
    case 'seed-daily-batch-discounts':
      await seedDailyBatchDiscountScenario()
      break
    case 'run-daily-batch-discounts':
      await runDailyBatchDiscountScenario()
      break
    case 'inspect-daily-batch-discounts':
      if (!args[0] || !args[1]) throw new Error('inspect-daily-batch-discounts requires <manualOrderId> <wcOrderId>')
      await inspectDailyBatchDiscountScenario(args[0], args[1])
      break
    default:
      throw new Error(
        'usage: tsx scripts/commerce-accounting-e2e-fixture.ts ' +
        '<seed-manual-fx-order-ui|seed-fx-refund|seed-mixed-rate-refund|inspect-fx-refund|inspect-credit-note|import-wc-fee-order|inspect-wc-fee-order|inspect-sales-invoice|import-wc-discount-order|seed-daily-batch-discounts|run-daily-batch-discounts|inspect-daily-batch-discounts> [...]',
      )
  }
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(async () => {
    await db.$disconnect()
  })
