'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ShieldAlert, Mail, Phone, Building2, FileText, MapPin, Loader2 } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { anonymiseCustomer, type CustomerDetail, type AddressData } from '@/app/actions/customers'
import { useBaseCurrency } from '@/components/providers/base-currency-provider'
import { formatCountryDisplay } from '@/lib/countries'
import { formatMoney } from '@/lib/utils'

const STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Draft',
  PENDING_PAYMENT: 'Pending Payment',
  ON_HOLD: 'On Hold',
  PROCESSING: 'Processing',
  ALLOCATED: 'Allocated',
  PICKING: 'Picking',
  PACKING: 'Packing',
  SHIPPED: 'Shipped',
  COMPLETED: 'Completed',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
  REFUNDED: 'Refunded',
  PARTIALLY_REFUNDED: 'Part. Refunded',
}

const STATUS_CLASS: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-800 border-gray-200 dark:bg-gray-800 dark:text-gray-200',
  PENDING_PAYMENT: 'bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900 dark:text-yellow-200',
  ON_HOLD: 'bg-muted text-muted-foreground border-muted',
  PROCESSING: 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900 dark:text-blue-200',
  ALLOCATED: 'bg-cyan-100 text-cyan-800 border-cyan-200 dark:bg-cyan-900 dark:text-cyan-200',
  PICKING: 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900 dark:text-blue-200',
  PACKING: 'bg-indigo-100 text-indigo-800 border-indigo-200 dark:bg-indigo-900 dark:text-indigo-200',
  SHIPPED: 'bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-900 dark:text-purple-200',
  COMPLETED: 'bg-green-100 text-green-800 border-green-200 dark:bg-green-900 dark:text-green-200',
  DELIVERED: 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-900 dark:text-emerald-200',
  CANCELLED: 'text-destructive border-destructive/30',
  REFUNDED: 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900 dark:text-red-200',
  PARTIALLY_REFUNDED: 'bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900 dark:text-orange-200',
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function formatAddr(a: AddressData | null): string {
  if (!a) return '—'
  return [a.line1, a.line2, a.city, a.county, a.postcode, formatCountryDisplay(a.country)].filter(Boolean).join(', ') || '—'
}

function GdprDialog({ customer, onClose }: { customer: CustomerDetail; onClose: () => void }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState('')

  const expectedName = customer.fullName
  const canConfirm = confirmation === expectedName

  function handleAnonymise() {
    setError('')
    startTransition(async () => {
      const result = await anonymiseCustomer(customer.id)
      if (result.success) { router.refresh(); onClose() }
      else setError(result.error ?? 'Anonymisation failed')
    })
  }

  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent showCloseButton={false} className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-destructive" />
            GDPR Anonymise Customer
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <p className="text-muted-foreground">
            This will permanently anonymise all personal data for <strong>{customer.fullName}</strong>.
            This action cannot be undone. Existing invoice PDFs will not be affected.
          </p>
          <p className="text-muted-foreground">
            The following data will be cleared: name, email, phone, company, tax number, billing/shipping addresses, notes, and all linked order customer details.
          </p>
          <div className="space-y-1.5">
            <Label className="text-xs">Type <strong>{expectedName}</strong> to confirm</Label>
            <Input
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              placeholder={expectedName}
              className="h-9"
            />
          </div>
          {error && <p className="text-destructive text-sm">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isPending}>Cancel</Button>
          <Button variant="destructive" onClick={handleAnonymise} disabled={isPending || !canConfirm}>
            {isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Anonymise
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

type Props = { customer: CustomerDetail }

export function CustomerDetailClient({ customer }: Props) {
  const baseCurrency = useBaseCurrency()
  const fmtBase = (value: number) => formatMoney(value, baseCurrency.symbol, baseCurrency.symbolPosition)
  const [showGdpr, setShowGdpr] = useState(false)

  const currentYear = new Date().getFullYear()
  const recentYears = [currentYear, currentYear - 1, currentYear - 2].map(String)

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Customer Info + Turnover */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Contact details */}
        <Card className="p-5 lg:col-span-2">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold">Contact Details</h2>
            {!customer.gdprAnonymisedAt && (
              <Button variant="outline" size="sm" className="h-7 text-xs text-destructive border-destructive/30 hover:bg-destructive/10" onClick={() => setShowGdpr(true)}>
                <ShieldAlert className="h-3.5 w-3.5 mr-1" />
                GDPR Anonymise
              </Button>
            )}
          </div>
          {customer.gdprAnonymisedAt && (
            <div className="flex items-center gap-2 text-orange-600 bg-orange-50 rounded px-3 py-2 mb-3 text-xs font-medium">
              <ShieldAlert className="h-4 w-4" />
              GDPR anonymised on {fmtDate(customer.gdprAnonymisedAt)}
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-2 gap-x-6 text-sm">
            {customer.email && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Mail className="h-3.5 w-3.5 shrink-0" />
                <span>{customer.email}</span>
              </div>
            )}
            {customer.phone && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Phone className="h-3.5 w-3.5 shrink-0" />
                <span>{customer.phone}</span>
              </div>
            )}
            {customer.company && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Building2 className="h-3.5 w-3.5 shrink-0" />
                <span>{customer.company}</span>
              </div>
            )}
            {customer.taxNumber && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <FileText className="h-3.5 w-3.5 shrink-0" />
                <span className="font-mono">{customer.taxNumber}</span>
              </div>
            )}
            {customer.billingAddress && (
              <div className="flex items-start gap-2 text-muted-foreground sm:col-span-2">
                <MapPin className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                <span>{formatAddr(customer.billingAddress)}</span>
              </div>
            )}
          </div>
          {customer.notes && (
            <p className="mt-3 text-xs text-muted-foreground border-t pt-2">{customer.notes}</p>
          )}
          <div className="mt-3 flex items-center gap-3 text-xs">
            <span className={customer.active ? 'text-green-600' : 'text-muted-foreground'}>
              {customer.active ? 'Active' : 'Inactive'}
            </span>
            <span className="text-muted-foreground">{customer.orderCount} order{customer.orderCount !== 1 ? 's' : ''}</span>
          </div>
        </Card>

        {/* Turnover */}
        <Card className="p-5">
          <h2 className="text-sm font-semibold mb-3">Turnover ({baseCurrency.code})</h2>
          <div className="space-y-2">
            <div className="flex justify-between items-baseline">
              <span className="text-xs text-muted-foreground">All time</span>
              <span className="text-lg font-semibold tabular-nums">{fmtBase(customer.totalTurnoverBase)}</span>
            </div>
            <div className="border-t pt-2 space-y-1">
              {recentYears.map((year) => (
                <div key={year} className="flex justify-between items-baseline">
                  <span className="text-xs text-muted-foreground">{year}</span>
                  <span className="text-sm font-medium tabular-nums">{fmtBase(customer.annualTurnoverBase[year] ?? 0)}</span>
                </div>
              ))}
            </div>
          </div>
        </Card>
      </div>

      {/* Orders */}
      <Card className="p-5">
        <h2 className="text-sm font-semibold mb-3">Orders ({customer.orders.length})</h2>
        {customer.orders.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">No orders for this customer.</p>
        ) : (
          <Table className="min-w-[600px]">
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead className="px-4 text-xs">Order</TableHead>
                <TableHead className="px-4 text-xs">Date</TableHead>
                <TableHead className="px-4 text-xs">Status</TableHead>
                <TableHead className="px-4 text-xs text-right">Lines</TableHead>
                <TableHead className="px-4 text-xs text-right">Total</TableHead>
                <TableHead className="px-4 text-xs text-right">{baseCurrency.code}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {customer.orders.map((o) => (
                <TableRow key={o.id}>
                  <TableCell className="px-4 font-medium">
                    <Link href={`/sales/${o.id}`} className="text-primary hover:underline" target="_blank">
                      {o.orderNumber}
                    </Link>
                  </TableCell>
                  <TableCell className="px-4 text-muted-foreground text-xs">{fmtDate(o.createdAt)}</TableCell>
                  <TableCell className="px-4">
                    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[o.status] ?? ''}`}>
                      {STATUS_LABELS[o.status] ?? o.status}
                    </span>
                  </TableCell>
                  <TableCell className="px-4 text-right text-xs tabular-nums">{o.lineCount}</TableCell>
                  <TableCell className="px-4 text-right text-xs tabular-nums">
                    {o.currency !== baseCurrency.code ? `${o.currency} ${o.totalForeign.toFixed(2)}` : fmtBase(o.totalForeign)}
                  </TableCell>
                  <TableCell className="px-4 text-right text-xs tabular-nums font-medium">{fmtBase(o.totalBase)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {showGdpr && <GdprDialog customer={customer} onClose={() => setShowGdpr(false)} />}
    </div>
  )
}
