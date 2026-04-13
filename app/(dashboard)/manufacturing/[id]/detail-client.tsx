'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  ArrowLeft, Factory, Play, CheckCircle2, XCircle, FileText, Mail,
  Loader2, AlertTriangle, ExternalLink, Package,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import {
  updateManufacturingOrderStatus,
  type ManufacturingOrderDetail as OrderType,
} from '@/app/actions/manufacturing'
import { ProductThumb } from '@/components/inventory/product-thumb'

const STATUS_BADGE: Record<string, string> = {
  DRAFT: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  IN_PROGRESS: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  COMPLETED: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
  CANCELLED: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
}

const NEXT_STATUS: Record<string, { label: string; status: 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED'; icon: typeof Play; variant: 'default' | 'destructive' }[]> = {
  DRAFT: [
    { label: 'Start Production', status: 'IN_PROGRESS', icon: Play, variant: 'default' },
    { label: 'Cancel', status: 'CANCELLED', icon: XCircle, variant: 'destructive' },
  ],
  IN_PROGRESS: [
    { label: 'Mark Completed', status: 'COMPLETED', icon: CheckCircle2, variant: 'default' },
    { label: 'Cancel', status: 'CANCELLED', icon: XCircle, variant: 'destructive' },
  ],
  COMPLETED: [],
  CANCELLED: [],
}

function fmtDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function fmtDateTime(iso: string | null) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) +
    ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

export function ManufacturingOrderDetail({ order }: { order: OrderType }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const isDisassembly = order.orderType === 'DISASSEMBLY'
  const hasManufacturer = !!order.manufacturerId
  const actions = NEXT_STATUS[order.status] ?? []

  function handleStatusChange(status: 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED') {
    setError(null)
    startTransition(async () => {
      const result = await updateManufacturingOrderStatus(order.id, status)
      if (result.success) {
        router.refresh()
      } else {
        setError(result.error ?? 'Failed to update status.')
      }
    })
  }

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <Link href="/manufacturing">
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold">{order.reference}</h1>
              <Badge variant="secondary" className={`text-xs ${STATUS_BADGE[order.status] ?? ''}`}>
                {order.status.replace('_', ' ')}
              </Badge>
              <Badge variant="secondary" className="text-xs">
                {isDisassembly ? 'Disassembly' : 'Assembly'}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground mt-0.5">
              Created {fmtDateTime(order.createdAt)}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* PDF / Email buttons — always visible, especially useful for 3rd party manufacturers */}
          <Button variant="outline" size="sm" onClick={() => window.open(`/api/manufacturing-order/${order.id}?t=${Date.now()}`, '_blank')}>
            <FileText className="h-4 w-4 mr-1" />PDF
          </Button>
          {hasManufacturer && (
            <Button variant="outline" size="sm" onClick={() => {
              const subject = encodeURIComponent(`Manufacturing Order ${order.reference}`)
              const body = encodeURIComponent(`Dear ${order.manufacturerName},\n\nPlease find attached manufacturing order ${order.reference}.\n\nProduct: ${order.productSku} — ${order.productName}\nQuantity: ${order.qtyPlanned}\nType: ${isDisassembly ? 'Disassembly' : 'Assembly'}\n\nPlease confirm receipt and provide an estimated completion date.\n\nKind regards`)
              window.open(`mailto:${order.manufacturerEmail ?? ''}?subject=${subject}&body=${body}`, '_blank')
            }}>
              <Mail className="h-4 w-4 mr-1" />Email Manufacturer
            </Button>
          )}

          {/* Status progression buttons */}
          {actions.map((a) => {
            const Icon = a.icon
            return (
              <Button
                key={a.status}
                variant={a.variant}
                size="sm"
                onClick={() => handleStatusChange(a.status)}
                disabled={isPending}
              >
                {isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Icon className="h-4 w-4 mr-1" />}
                {a.label}
              </Button>
            )
          })}
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4" />
          {error}
        </div>
      )}

      {/* Details grid */}
      <div className="grid grid-cols-[1fr_1fr_auto] gap-4">
        <Card className="p-4">
          <h2 className="text-sm font-medium mb-3 flex items-center gap-1.5">
            <Factory className="h-4 w-4 text-muted-foreground" />
            Order Details
          </h2>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Product</dt>
              <dd>
                <Link href={`/inventory/${order.productId}`} className="hover:underline" target="_blank">
                  <span className="font-mono text-xs">{order.productSku}</span> — {order.productName}
                  <ExternalLink className="h-3 w-3 inline ml-1" />
                </Link>
              </dd>
            </div>
            {order.productBarcode && (
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Barcode</dt>
                <dd className="font-mono text-xs">{order.productBarcode}</dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Warehouse</dt>
              <dd>{order.warehouseName} ({order.warehouseCode})</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Planned Qty</dt>
              <dd className="font-semibold">{order.qtyPlanned}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Produced Qty</dt>
              <dd>{order.qtyProduced}</dd>
            </div>
          </dl>
        </Card>

        <Card className="p-4">
          <h2 className="text-sm font-medium mb-3">Timeline &amp; Manufacturer</h2>
          <dl className="space-y-2 text-sm">
            {hasManufacturer && (
              <>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Manufacturer</dt>
                  <dd>{order.manufacturerName}</dd>
                </div>
                {order.manufacturerEmail && (
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Email</dt>
                    <dd><a href={`mailto:${order.manufacturerEmail}`} className="text-primary hover:underline">{order.manufacturerEmail}</a></dd>
                  </div>
                )}
              </>
            )}
            {!hasManufacturer && (
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Manufacturer</dt>
                <dd className="text-muted-foreground italic">In-house</dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Scheduled</dt>
              <dd>{fmtDate(order.scheduledAt)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Started</dt>
              <dd>{fmtDateTime(order.startedAt)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Completed</dt>
              <dd>{fmtDateTime(order.completedAt)}</dd>
            </div>
          </dl>
          {order.notes && (
            <div className="mt-3 pt-3 border-t">
              <p className="text-xs text-muted-foreground mb-1">Notes</p>
              <p className="text-sm">{order.notes}</p>
            </div>
          )}
        </Card>

        {/* Product image */}
        <Link href={`/inventory/${order.productId}`} target="_blank" className="block">
          <Card className="p-4 flex flex-col items-center justify-center h-full">
            {order.productImageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={order.productImageUrl}
                alt={order.productName}
                className="w-36 h-36 rounded-lg object-contain border border-border bg-muted"
              />
            ) : (
              <span className="flex w-36 h-36 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground">
                <Package className="h-12 w-12" />
              </span>
            )}
            <p className="text-xs text-muted-foreground mt-2 text-center font-mono">{order.productSku}</p>
          </Card>
        </Link>
      </div>

      {/* Components table */}
      <Card className="p-4">
        <h2 className="text-sm font-medium mb-3">
          {isDisassembly ? 'Components Produced' : 'Components Required'}
        </h2>
        <Table className="rounded-md border min-w-[600px]">
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead>#</TableHead>
              <TableHead className="w-12"></TableHead>
              <TableHead>SKU</TableHead>
              <TableHead>Component</TableHead>
              <TableHead>Barcode</TableHead>
              <TableHead className="text-right">Per Unit</TableHead>
              <TableHead className="text-right">Total Qty</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {order.components.map((c, i) => (
              <TableRow key={c.componentId}>
                <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                <TableCell>
                  <ProductThumb productId={c.componentId} imageUrl={c.componentImageUrl} name={c.componentName} />
                </TableCell>
                <TableCell className="font-mono text-xs">{c.componentSku}</TableCell>
                <TableCell>
                  <Link href={`/inventory/${c.componentId}`} className="hover:underline" target="_blank">
                    {c.componentName}
                  </Link>
                </TableCell>
                <TableCell className="text-muted-foreground font-mono text-xs">{c.componentBarcode ?? '—'}</TableCell>
                <TableCell className="text-right">{c.qtyPerUnit}</TableCell>
                <TableCell className="text-right font-medium">{c.qtyPerUnit * order.qtyPlanned}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  )
}
