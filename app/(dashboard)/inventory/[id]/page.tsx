import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ChevronRight, Package, Layers, SlidersHorizontal } from 'lucide-react'
import { db } from '@/lib/db'
import { getProduct, getVariableProducts, listProductCategories, updateProduct, getProductOptions, getProductSuppliers, getProductComponents, getKitStock } from '@/app/actions/products'
import { getWarehouses, getActiveAdjustmentReasons } from '@/app/actions/stock'
import { getStockUnitOptions } from '@/app/actions/settings'
import { ProductForm } from '@/components/inventory/product-form'
import { StockAdjustmentForm } from '@/components/inventory/stock-adjustment-form'
import { VariantGenerator } from '@/components/inventory/variant-generator'
import { KitConfigurator } from '@/components/inventory/kit-configurator'
import { DeleteVariantButton } from '@/components/inventory/delete-variant-button'
import { ShoppingProductLinkButton } from '@/components/inventory/shopping-product-link-button'
import { StockFlowButton } from '@/components/inventory/stock-flow-dialog'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { StockDetailPopup } from '@/components/inventory/stock-detail-popups'
import type { ProductLifecycleStatus, ProductType } from '@/app/generated/prisma/client'
import { hasExternalProductLink } from '@/lib/shopping'
import { getBaseCurrencyDisplay } from '@/lib/base-currency'
import { formatMoney } from '@/lib/utils'

const TYPE_LABELS: Record<ProductType, string> = {
  SIMPLE: 'Simple',
  VARIABLE: 'Variable',
  VARIANT: 'Variant',
  KIT: 'Kit / Bundle',
  BOM: 'Bill of Materials',
  NON_INVENTORY: 'Non-Inventory',
}

const STATUS_LABELS: Record<ProductLifecycleStatus, string> = {
  ACTIVE: 'Active',
  NOT_FOR_SALE: 'Not for sale',
  ARCHIVED: 'Archived',
}

const STATUS_VARIANTS: Record<ProductLifecycleStatus, 'default' | 'secondary' | 'outline'> = {
  ACTIVE: 'default',
  NOT_FOR_SALE: 'secondary',
  ARCHIVED: 'outline',
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const product = await getProduct(id)
  if (!product) return { title: 'Product Not Found' }
  return { title: `${product.sku} | Inventory` }
}

export default async function ProductDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const [product, variableProducts, warehouses, reasons, stockUnitOptions, productCategories] = await Promise.all([
    getProduct(id),
    getVariableProducts(),
    getWarehouses(),
    getActiveAdjustmentReasons(),
    getStockUnitOptions(),
    listProductCategories(),
  ])
  const baseCurrency = await getBaseCurrencyDisplay()
  const fmtBase = (value: number) => formatMoney(value, baseCurrency.symbol, baseCurrency.symbolPosition)

  if (!product) notFound()

  const isKitOrBom = product.type === 'KIT' || product.type === 'BOM'

  const [productOptions, suppliers, productComponents, kitStock] = await Promise.all([
    product.type === 'VARIABLE' ? getProductOptions(id) : Promise.resolve([]),
    getProductSuppliers(id),
    isKitOrBom ? getProductComponents(id) : Promise.resolve([]),
    product.type === 'KIT' ? getKitStock(id) : Promise.resolve([]),
  ])

  const hasStoreLink = await hasExternalProductLink(id)

  // For the kit configurator: all stockable products (not self, not VARIABLE, not NON_INVENTORY)
  const allSimpleProducts = isKitOrBom
    ? await db.product.findMany({
        where: { lifecycleStatus: { in: ['ACTIVE', 'NOT_FOR_SALE'] }, type: { notIn: ['VARIABLE', 'NON_INVENTORY'] }, NOT: { id } },
        select: { id: true, sku: true, name: true },
        orderBy: { sku: 'asc' },
      })
    : []

  const boundUpdate = updateProduct.bind(null, id)

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <div>
        <nav className="flex items-center gap-1 text-sm text-muted-foreground mb-2">
          <Link href="/inventory" className="hover:text-foreground">Inventory</Link>
          {product.parentId && product.parentSku && (
            <>
              <ChevronRight className="h-4 w-4" />
              <Link href={`/inventory/${product.parentId}`} className="hover:text-foreground">
                {product.parentSku}
              </Link>
            </>
          )}
          <ChevronRight className="h-4 w-4" />
          <span className="text-foreground">{product.sku}</span>
        </nav>
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-2xl font-semibold">{product.name}</h1>
          <Badge variant={STATUS_VARIANTS[product.lifecycleStatus]}>
            {STATUS_LABELS[product.lifecycleStatus]}
          </Badge>
          <Badge variant="secondary">{TYPE_LABELS[product.type]}</Badge>
          {product.categoryName && <Badge variant="outline">{product.categoryName}</Badge>}
          {hasStoreLink && <ShoppingProductLinkButton sku={product.sku} />}
          {product.type !== 'VARIABLE' && product.type !== 'NON_INVENTORY' && (
            <StockFlowButton productId={id} />
          )}
          {product.parentId && (
            <DeleteVariantButton
              variantId={id}
              variantSku={product.sku}
              parentId={product.parentId}
            />
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: form */}
        <div className="lg:col-span-2 space-y-6">
          <Card className="p-6">
            <h2 className="text-base font-semibold mb-4">Product Details</h2>
            <ProductForm
              action={boundUpdate}
              variableProducts={variableProducts}
              defaultValues={{
                sku: product.sku,
                name: product.name,
                categoryName: product.categoryName,
                description: product.description ?? undefined,
                type: product.type,
                parentId: product.parentId ?? undefined,
                barcode: product.barcode ?? undefined,
                mpn: product.mpn ?? undefined,
                hsCode: product.hsCode ?? undefined,
                countryOfOrigin: product.countryOfOrigin ?? undefined,
                weight: product.weight ?? undefined,
                imageUrl: product.imageUrl,
                widthCm: product.widthCm,
                heightCm: product.heightCm,
                depthCm: product.depthCm,
                salesPriceBase: product.salesPriceBase ?? undefined,
                salePriceBase: product.salePriceBase ?? undefined,
                salesPriceTaxInclusive: product.salesPriceTaxInclusive,
                taxCategory: product.taxCategory,
                stockUnit: product.stockUnit,
                oversellAllowed: product.oversellAllowed,
                active: product.active,
                lifecycleStatus: product.lifecycleStatus,
              }}
              stockUnitOptions={stockUnitOptions}
              productCategories={productCategories}
              inline
            />
          </Card>

          {/* Variants + generator (for VARIABLE products) */}
          {product.type === 'VARIABLE' && (
            <Card className="p-6">
              <h2 className="text-base font-semibold flex items-center gap-2 mb-4">
                <Layers className="h-4 w-4" />
                Variants
              </h2>
              <VariantGenerator
                productId={id}
                initialOptions={productOptions}
                variants={product.variants}
              />
            </Card>
          )}

          {/* Component configurator (for KIT and BOM products) */}
          {isKitOrBom && (
            <Card className="p-6">
              <h2 className="text-base font-semibold flex items-center gap-2 mb-4">
                <Layers className="h-4 w-4" />
                {product.type === 'BOM' ? 'Bill of Materials' : 'Kit Components'}
              </h2>
              <KitConfigurator
                productId={id}
                productType={product.type as 'KIT' | 'BOM'}
                initialComponents={productComponents}
                allProducts={allSimpleProducts}
              />
            </Card>
          )}
        </div>

        {/* Right: image + stock + cost layers */}
        <div className="space-y-4">
          {/* Product image */}
          {product.imageUrl && (
            <Card className="p-3">
              <div className="w-full max-h-56 rounded-md border border-border overflow-hidden bg-muted flex items-center justify-center">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={product.imageUrl}
                  alt={product.name}
                  className="max-h-56 w-full object-contain"
                />
              </div>
            </Card>
          )}

          {/* VARIABLE: variant summary */}
          {product.type === 'VARIABLE' && (
            <Card className="p-4">
              <h2 className="text-sm font-semibold flex items-center gap-2 mb-3">
                <Layers className="h-4 w-4" />
                Variant Summary
              </h2>
              {product.variants.length === 0 ? (
                <p className="text-sm text-muted-foreground">No variants yet.</p>
              ) : (
                <div className="space-y-1.5 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Total variants</span>
                    <span className="font-mono font-medium">{product.variants.length}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Active</span>
                    <span className="font-mono">{product.variants.filter((v) => v.lifecycleStatus === 'ACTIVE').length}</span>
                  </div>
                  <div className="flex justify-between border-t border-border pt-1.5 mt-1">
                    <span className="text-muted-foreground">Total stock</span>
                    <span className="font-mono font-semibold">
                      {product.variants.reduce((s, v) => s + Number(v.totalStock), 0).toLocaleString()}
                    </span>
                  </div>
                </div>
              )}
            </Card>
          )}

          {/* Stock adjustment */}
          {product.type !== 'VARIABLE' && product.type !== 'NON_INVENTORY' && product.type !== 'KIT' && (
            <Card className="p-4">
              <h2 className="text-sm font-semibold flex items-center gap-2 mb-3">
                <SlidersHorizontal className="h-4 w-4" />
                Stock Adjustment
              </h2>
              <StockAdjustmentForm
                productId={product.id}
                warehouses={warehouses}
                reasons={reasons}
              />
            </Card>
          )}

          {/* Non-inventory notice */}
          {product.type === 'NON_INVENTORY' && (
            <Card className="p-4">
              <p className="text-sm text-muted-foreground">
                Non-inventory product — stock is unlimited and not tracked.
              </p>
            </Card>
          )}

          {/* KIT: calculated stock per warehouse */}
          {product.type === 'KIT' && (
            <Card className="p-4">
              <h2 className="text-sm font-semibold flex items-center gap-2 mb-3">
                <Package className="h-4 w-4" />
                Calculated Stock (Kit)
              </h2>
              {productComponents.length === 0 ? (
                <p className="text-sm text-muted-foreground">Add components to see calculated stock.</p>
              ) : kitStock.length === 0 ? (
                <p className="text-sm text-muted-foreground">No warehouses configured.</p>
              ) : (
                <div className="space-y-0">
                  <div className="grid grid-cols-[1fr_auto] gap-2 text-xs text-muted-foreground pb-1.5 border-b border-border">
                    <span>Warehouse</span>
                    <span className="text-right">Max Kits</span>
                  </div>
                  {kitStock.map((w) => (
                    <div key={w.warehouseId} className="grid grid-cols-[1fr_auto] gap-2 py-1.5 text-sm border-b border-border/50 last:border-0">
                      <span className="text-muted-foreground">
                        <span className="font-mono font-medium text-foreground">{w.warehouseCode}</span>
                        {w.calculatedQty === 0 && w.limitingComponent && (
                          <span className="text-xs text-destructive ml-2">limited by {w.limitingComponent}</span>
                        )}
                      </span>
                      <span className={`font-mono text-right font-medium ${w.calculatedQty === 0 ? 'text-destructive' : ''}`}>
                        {w.calculatedQty.toLocaleString()}
                      </span>
                    </div>
                  ))}
                  <div className="grid grid-cols-[1fr_auto] gap-2 pt-2 text-sm font-semibold border-t border-border">
                    <span>Total</span>
                    <span className="font-mono text-right">
                      {kitStock.reduce((s, w) => s + w.calculatedQty, 0).toLocaleString()}
                    </span>
                  </div>
                </div>
              )}
              {Number(product.inventoryValue) > 0 && (
                <div className="mt-3 pt-3 border-t border-border flex justify-between text-sm">
                  <span className="text-muted-foreground">Unit COGS (components)</span>
                  <span className="font-mono font-semibold">{fmtBase(Number(product.inventoryValue))}</span>
                </div>
              )}
              <p className="text-xs text-muted-foreground mt-2">
                Based on available (unallocated) component stock per warehouse.
              </p>
            </Card>
          )}

          {/* BOM: actual stock notice */}
          {product.type === 'BOM' && (
            <Card className="p-4">
              <p className="text-xs text-muted-foreground">
                BOM product — stock is added via manufacturing orders or by purchasing finished units from a supplier.
              </p>
            </Card>
          )}

          {/* Stock by warehouse (non-virtual types) */}
          {product.type !== 'VARIABLE' && product.type !== 'NON_INVENTORY' && product.type !== 'KIT' && (
            <Card className="p-4">
              <h2 className="text-sm font-semibold flex items-center gap-2 mb-3">
                <Package className="h-4 w-4" />
                Stock Levels
              </h2>
              {product.stockByWarehouse.length === 0 ? (
                <p className="text-sm text-muted-foreground">No stock recorded.</p>
              ) : (
                <div className="space-y-0">
                  {/* Header row */}
                  <div className="grid grid-cols-3 sm:grid-cols-5 gap-1 text-xs text-muted-foreground pb-1.5 border-b border-border">
                    <span>Warehouse</span>
                    <span className="text-right">On Hand ({product.stockUnit})</span>
                    <span className="hidden sm:block text-right">Allocated</span>
                    <span className="text-right">Available</span>
                    <span className="hidden sm:block text-right text-blue-600 dark:text-blue-400">Incoming</span>
                  </div>

                  {product.stockByWarehouse.map((s) => {
                    const incoming = Number(s.incomingTransferQty) + Number(s.incomingPoQty)
                    return (
                      <div key={s.warehouseId} className="grid grid-cols-3 sm:grid-cols-5 gap-1 py-1.5 text-sm border-b border-border/50 last:border-0">
                        <span className="text-muted-foreground truncate">
                          <span className="font-mono font-medium text-foreground">{s.warehouseCode}</span>
                        </span>
                        <span className="font-mono text-right text-xs">
                          {Number(s.quantity).toLocaleString()}
                        </span>
                        <span className={`hidden sm:block font-mono text-right text-xs ${Number(s.allocatedQty) > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}>
                          {Number(s.allocatedQty) > 0 ? (
                            <StockDetailPopup productId={product.id} warehouseId={s.warehouseId} type="allocated">
                              {Number(s.allocatedQty).toLocaleString()}
                            </StockDetailPopup>
                          ) : '—'}
                        </span>
                        <span className={`font-mono text-right text-xs font-medium ${Number(s.availableQty) < 0 ? 'text-destructive' : ''}`}>
                          {Number(s.availableQty).toLocaleString()}
                        </span>
                        <span className={`hidden sm:block font-mono text-right text-xs ${incoming > 0 ? 'text-blue-600 dark:text-blue-400 font-medium' : 'text-muted-foreground'}`}>
                          {incoming > 0 ? (
                            <StockDetailPopup productId={product.id} warehouseId={s.warehouseId} type="incoming">
                              +{incoming.toLocaleString()}
                            </StockDetailPopup>
                          ) : '—'}
                        </span>
                      </div>
                    )
                  })}

                  {/* Totals */}
                  <div className="grid grid-cols-3 sm:grid-cols-5 gap-1 pt-2 text-sm font-semibold border-t border-border mt-0.5">
                    <span>Total</span>
                    <span className="font-mono text-right">{Number(product.totalStock).toLocaleString()}</span>
                    <span className={`hidden sm:block font-mono text-right ${
                      product.stockByWarehouse.reduce((s, w) => s + Number(w.allocatedQty), 0) > 0
                        ? 'text-amber-600 dark:text-amber-400'
                        : 'text-muted-foreground'
                    }`}>
                      {(() => {
                        const total = product.stockByWarehouse.reduce((s, w) => s + Number(w.allocatedQty), 0)
                        return total > 0 ? total.toLocaleString() : '—'
                      })()}
                    </span>
                    <span className={`font-mono text-right ${
                      product.stockByWarehouse.reduce((s, w) => s + Number(w.availableQty), 0) < 0
                        ? 'text-destructive'
                        : ''
                    }`}>
                      {product.stockByWarehouse.reduce((s, w) => s + Number(w.availableQty), 0).toLocaleString()}
                    </span>
                    {(() => {
                      const totalIncoming = product.stockByWarehouse.reduce((s, w) => s + Number(w.incomingTransferQty) + Number(w.incomingPoQty), 0) + Number(product.incomingPoQty)
                      return (
                        <span className={`hidden sm:block font-mono text-right ${totalIncoming > 0 ? 'text-blue-600 dark:text-blue-400' : 'text-muted-foreground'}`}>
                          {totalIncoming > 0 ? `+${totalIncoming.toLocaleString()}` : '—'}
                        </span>
                      )
                    })()}
                  </div>

                  {/* COGS value + avg unit cost */}
                  <div className="pt-2 mt-1 border-t border-border space-y-1">
                    <div className="flex justify-between items-center text-sm">
                      <span className="text-muted-foreground">COGS Value</span>
                      <span className="font-mono font-semibold">{fmtBase(Number(product.inventoryValue))}</span>
                    </div>
                    <div className="flex justify-between items-center text-sm">
                      <span className="text-muted-foreground">Avg Unit Cost</span>
                      <span className="font-mono">
                        {Number(product.totalStock) > 0
                          ? fmtBase(Number(product.inventoryValue) / Number(product.totalStock))
                          : '—'}
                      </span>
                    </div>
                  </div>

                  {/* Unassigned PO incoming (no warehouse set) */}
                  {Number(product.incomingPoQty) > 0 && (
                    <div className="mt-2 pt-2 border-t border-border">
                      <div className="flex justify-between text-xs">
                        <span className="text-muted-foreground">PO incoming (warehouse unassigned)</span>
                        <span className="font-mono text-blue-600 dark:text-blue-400 font-medium">
                          +{Number(product.incomingPoQty).toLocaleString()}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </Card>
          )}

          {/* FIFO cost layers */}
          {product.type !== 'VARIABLE' && product.type !== 'NON_INVENTORY' && product.type !== 'KIT' && (
            <Card className="p-4">
              <h2 className="text-sm font-semibold mb-3">FIFO Cost Layers</h2>
              {product.costLayers.length === 0 ? (
                <p className="text-xs text-muted-foreground">No cost layers recorded yet.</p>
              ) : (
                <div className="space-y-2">
                  {product.costLayers.map((c) => (
                    <div key={c.id} className="text-sm">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">
                          {new Date(c.receivedAt).toLocaleDateString('en-GB')}
                        </span>
                        <span className="font-mono">{fmtBase(Number(c.unitCostBase))}</span>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {Number(c.remainingQty).toLocaleString()} remaining of{' '}
                        {Number(c.receivedQty).toLocaleString()}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          )}

          {/* Suppliers */}
          {suppliers.length > 0 && (
            <Card className="p-4">
              <h2 className="text-sm font-semibold mb-3">Suppliers</h2>
              <div className="space-y-3">
                {suppliers.map((s) => (
                  <div key={s.supplierId} className="text-sm space-y-0.5">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{s.supplierName}</span>
                      <span className="text-xs text-muted-foreground">
                        {s.updatedAt.toLocaleDateString('en-GB')}
                      </span>
                    </div>
                    {s.supplierSku && (
                      <div className="text-xs text-muted-foreground font-mono">
                        Ref: {s.supplierSku}
                      </div>
                    )}
                    <div className="flex items-center justify-between">
                      <span className="font-mono font-medium">
                        {s.lastUnitCost}{s.currencySymbol}
                      </span>
                      {s.baseEquivalent && s.currency !== baseCurrency.code && (
                        <span className="font-mono text-muted-foreground text-xs">
                          ({fmtBase(Number(s.baseEquivalent))})
                          {s.fxRate && (
                            <span className="ml-1 opacity-60">
                              @ {s.fxRate}
                            </span>
                          )}
                        </span>
                      )}
                      {s.currency === baseCurrency.code && (
                        <span className="font-mono text-muted-foreground text-xs">{fmtBase(Number(s.baseEquivalent))}</span>
                      )}
                    </div>
                    {s.fxFetchedAt && s.currency !== baseCurrency.code && (
                      <div className="text-xs text-muted-foreground opacity-60">
                        Rate as of {s.fxFetchedAt.toLocaleDateString('en-GB')}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
