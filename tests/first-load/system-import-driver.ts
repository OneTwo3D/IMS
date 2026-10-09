/**
 * The in-application half of the system-actor importer spike (tests/first-load/system-import-importers.test.ts).
 *
 * It runs under `tsx` with NO module mocks and NO Next request: the real Server Action modules, the real
 * `requirePermission`, the real `next/cache`, against the throwaway cluster named by DATABASE_URL. It prints exactly one
 * line, `SPIKE_DRIVER {json}`, and exits 0; any unexpected failure is a thrown error and exit 1. The parent reads the
 * database itself to judge what was written, so nothing here is trusted as evidence of its own success.
 *
 * Input (environment): SPIKE_TAG (a unique prefix for every fixture name) and SPIKE_ONLY (optional, a comma list of steps).
 */
import { mintSystemImportContext } from '@/lib/first-load/apply/system-import-capability'

const tag = process.env.SPIKE_TAG
if (!tag) throw new Error('SPIKE_TAG is not set')

const csv = (rows: string[][]): string => rows.map((row) => row.map((cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(',')).join('\n') + '\n'
const form = (rows: string[][], mode: 'execute' | 'preview' = 'execute'): FormData => {
  const data = new FormData()
  data.set('file', new File([csv(rows)], 'spike.csv', { type: 'text/csv' }))
  data.set('mode', mode)
  return data
}
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 240)

const out: Record<string, unknown> = {}
async function attempt<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    const value = await fn()
    out[name] = { threw: false, value }
    return value
  } catch (error) {
    out[name] = { threw: true, message: message(error) }
    return undefined
  }
}

const SKU = {
  parent: `${tag}-VAR`, variant: `${tag}-VAR-1`, a: `${tag}-A`, b: `${tag}-B`, kit: `${tag}-KIT`, bom: `${tag}-BOM`, direct: `${tag}-A`,
}
const SUPPLIER = `${tag} Supplier`
const FORGED_SUPPLIER = `${tag} Forged`

async function main(): Promise<void> {
  // 1. Do the modules LOAD outside Next, and what does the Next-only API do here?
  for (const [name, specifier] of [['import', '@/app/actions/import'], ['suppliers', '@/app/actions/suppliers'], ['purchase-orders', '@/app/actions/purchase-orders']] as const) {
    await attempt(`load:${name}`, async () => Object.keys(await import(specifier)).sort())
  }
  await attempt('revalidatePath-unmocked', async () => {
    const { revalidatePath } = await import('next/cache')
    revalidatePath('/spike')
    return 'did not throw'
  })

  const imports = await import('@/app/actions/import')
  const suppliers = await import('@/app/actions/suppliers')
  const purchaseOrders = await import('@/app/actions/purchase-orders')

  // 2. Without a context the action asks for a session, and there is none here: it must refuse and write nothing.
  await attempt('no-context:suppliers', () => suppliers.importSuppliersCsv(form([['name'], [FORGED_SUPPLIER]])))

  // 3. A look-alike context is not the capability. Every one of these must be refused (the real requirePermission has no session).
  const lookAlikes: Record<string, unknown> = {
    'boolean-token': { systemImportToken: true, runId: 'forged', operator: 'forged' },
    'string-token': { systemImportToken: 'SYSTEM_IMPORT', runId: 'forged', operator: 'forged' },
    'other-symbol': { systemImportToken: Symbol('SYSTEM_IMPORT'), runId: 'forged', operator: 'forged' },
    'no-token': { runId: 'forged', operator: 'forged' },
    'bare-true': true,
    'bare-string': 'system',
  }
  for (const [name, forged] of Object.entries(lookAlikes)) {
    await attempt(`forged:${name}:suppliers`, () => suppliers.importSuppliersCsv(form([['name'], [FORGED_SUPPLIER]]), forged as never))
    await attempt(`forged:${name}:products`, () => imports.importProductsCsv(form([['sku', 'name', 'type'], [`${tag}-FORGED`, 'forged', 'SIMPLE']]), forged as never))
    await attempt(`forged:${name}:purchase-order`, () => purchaseOrders.createPurchaseOrder({ supplierId: 'x', currency: 'GBP', lines: [{ productId: 'x', sku: 'x', productName: 'x', qty: 1, unitCostForeign: 1 }] } as never, forged as never))
  }

  // 4. The capability cannot be minted inside the web application.
  const hadRuntime = process.env.NEXT_RUNTIME
  process.env.NEXT_RUNTIME = 'nodejs'
  await attempt('mint-inside-next-runtime', async () => mintSystemImportContext({ runId: 'spike', operator: 'spike' }))
  if (hadRuntime === undefined) delete process.env.NEXT_RUNTIME
  else process.env.NEXT_RUNTIME = hadRuntime
  await attempt('mint-bad-run-id', async () => mintSystemImportContext({ runId: 'has space', operator: 'spike' }))
  await attempt('mint-bad-operator', async () => mintSystemImportContext({ runId: 'spike', operator: '  ' }))

  const system = mintSystemImportContext({ runId: `run-${tag}`, operator: 'Spike Operator' })

  // 5. The real thing, in dependency order. Each result is recorded verbatim.
  await attempt('system:suppliers', () => suppliers.importSuppliersCsv(form([
    ['name', 'currency', 'email'],
    [SUPPLIER, 'GBP', 'buyer@example.test'],
    [`${tag} Second Supplier`, 'GBP', ''],
  ]), system))

  await attempt('system:products', () => imports.importProductsCsv(form([
    ['sku', 'name', 'type', 'parentSku', 'components', 'category', 'salesPriceBase'],
    [SKU.parent, `${tag} variable parent`, 'VARIABLE', '', '', 'Spike', ''],
    [SKU.variant, `${tag} variant`, 'VARIANT', SKU.parent, '', 'Spike', '10'],
    [SKU.a, `${tag} simple A`, 'SIMPLE', '', '', 'Spike', '5'],
    [SKU.b, `${tag} simple B`, 'SIMPLE', '', '', 'Spike', '6'],
    [SKU.kit, `${tag} kit`, 'KIT', '', `${SKU.a}:2;${SKU.b}:1`, 'Spike', '20'],
    [SKU.bom, `${tag} bom`, 'BOM', '', `${SKU.a}:1;${SKU.b}:3`, 'Spike', '30'],
  ]), system))

  await attempt('system:opening-stock', () => imports.importOpeningStockCsv(form([
    ['sku', 'warehouseCode', 'qty', 'unitCostBase'],
    [SKU.a, 'DEFAULT', '10', '2.5'],
    [SKU.b, 'DEFAULT', '4', '1.25'],
  ]), system))

  await attempt('system:purchase-orders', () => imports.importPurchaseOrdersCsv(form([
    ['orderKey', 'supplierName', 'currency', 'destinationWarehouseCode', 'sku', 'qty', 'unitCostForeign'],
    [`${tag}-PO-1`, SUPPLIER, 'GBP', 'DEFAULT', SKU.a, '5', '2.00'],
    [`${tag}-PO-1`, SUPPLIER, 'GBP', 'DEFAULT', SKU.b, '3', '1.00'],
  ]), system))

  const product = await (await import('@/lib/db')).db.product.findUnique({ where: { sku: SKU.a }, select: { id: true, name: true } })
  const supplier = await (await import('@/lib/db')).db.supplier.findFirst({ where: { name: SUPPLIER }, select: { id: true } })
  await attempt('system:create-purchase-order', () => purchaseOrders.createPurchaseOrder({
    reference: `${tag}-PO-2`,
    supplierId: supplier!.id,
    currency: 'GBP',
    pricesIncludeVat: false,
    lines: [{ productId: product!.id, sku: SKU.a, productName: product!.name, qty: 2, unitCostForeign: 3 }],
  } as never, system))

  // 6. Transfers: accepted in preview, refused when it would write.
  await attempt('system:transfers-execute', () => imports.importTransfersCsv(form([
    ['transferKey', 'fromWarehouseCode', 'toWarehouseCode', 'status', 'sku', 'qty'],
    [`${tag}-T1`, 'DEFAULT', 'DEFAULT', 'DRAFT', SKU.a, '1'],
  ]), system))
  await attempt('system:transfers-preview', () => imports.importTransfersCsv(form([
    ['transferKey', 'fromWarehouseCode', 'toWarehouseCode', 'status', 'sku', 'qty'],
    [`${tag}-T1`, 'DEFAULT', 'DEFAULT', 'DRAFT', SKU.a, '1'],
  ], 'preview'), system))

  // 7. Give a fire-and-forget effect (the products import schedules one with setTimeout(0)) time to show itself.
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.SPIKE_SETTLE_MS ?? '4000')))

  console.log(`SPIKE_DRIVER ${JSON.stringify(out, (_key, value) => (typeof value === 'symbol' ? String(value) : value))}`)
  await (await import('@/lib/db')).db.$disconnect()
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1) })
