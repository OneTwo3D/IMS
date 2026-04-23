'use client'

import { useState, useTransition } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Plus, Pencil, X, Loader2, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CountrySelect } from '@/components/ui/country-select'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { createSupplier, updateSupplier, importSuppliersCsv, type SupplierRow, type SupplierInput } from '@/app/actions/suppliers'
import { CsvBar } from '@/components/ui/csv-bar'
import type { TaxRateRow } from '@/app/actions/settings'
import type { CurrencyRow } from '@/app/actions/currencies'
import { useBaseCurrency } from '@/components/providers/base-currency-provider'

type Props = {
  initialSuppliers: SupplierRow[]
  taxRates: TaxRateRow[]
  currencies: CurrencyRow[]
}

type FormState = {
  name: string
  contactName: string
  email: string
  phone: string
  addressLine1: string
  addressLine2: string
  city: string
  county: string
  postcode: string
  country: string
  currency: string
  taxRateId: string
  vatNumber: string
  accountNumber: string
  paymentTermsDays: string
  manualDeliveryDays: string
  notes: string
}

const EMPTY_FORM: FormState = {
  name: '',
  contactName: '',
  email: '',
  phone: '',
  addressLine1: '',
  addressLine2: '',
  city: '',
  county: '',
  postcode: '',
  country: '',
  currency: '',
  taxRateId: '',
  vatNumber: '',
  accountNumber: '',
  paymentTermsDays: '',
  manualDeliveryDays: '',
  notes: '',
}

function buildEmptyForm(baseCurrencyCode: string): FormState {
  return { ...EMPTY_FORM, currency: baseCurrencyCode }
}

function supplierToForm(s: SupplierRow): FormState {
  return {
    name: s.name,
    contactName: s.contactName ?? '',
    email: s.email ?? '',
    phone: s.phone ?? '',
    addressLine1: s.addressLine1 ?? '',
    addressLine2: s.addressLine2 ?? '',
    city: s.city ?? '',
    county: s.county ?? '',
    postcode: s.postcode ?? '',
    country: s.country ?? '',
    currency: s.currency,
    taxRateId: s.taxRateId ?? '',
    vatNumber: s.vatNumber ?? '',
    accountNumber: s.accountNumber ?? '',
    paymentTermsDays: s.paymentTermsDays?.toString() ?? '',
    manualDeliveryDays: s.manualDeliveryDays?.toString() ?? '',
    notes: s.notes ?? '',
  }
}

function formToInput(f: FormState): SupplierInput {
  return {
    name: f.name,
    contactName: f.contactName || undefined,
    email: f.email || undefined,
    phone: f.phone || undefined,
    addressLine1: f.addressLine1 || undefined,
    addressLine2: f.addressLine2 || undefined,
    city: f.city || undefined,
    county: f.county || undefined,
    postcode: f.postcode || undefined,
    country: f.country || undefined,
    currency: f.currency,
    taxRateId: f.taxRateId || null,
    vatNumber: f.vatNumber || undefined,
    accountNumber: f.accountNumber || undefined,
    paymentTermsDays: f.paymentTermsDays ? parseInt(f.paymentTermsDays) : null,
    manualDeliveryDays: f.manualDeliveryDays ? parseInt(f.manualDeliveryDays) : null,
    notes: f.notes || undefined,
  }
}

function SupplierFormDialog({
  supplier,
  taxRates,
  currencies,
  baseCurrencyCode,
  baseCurrencySymbol,
  onClose,
}: {
  supplier: SupplierRow | null
  taxRates: TaxRateRow[]
  currencies: CurrencyRow[]
  baseCurrencyCode: string
  baseCurrencySymbol: string
  onClose: () => void
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [form, setForm] = useState<FormState>(supplier ? supplierToForm(supplier) : buildEmptyForm(baseCurrencyCode))
  const [error, setError] = useState('')

  function set(field: keyof FormState, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  function handleSave() {
    setError('')
    if (!form.name.trim()) { setError('Supplier name is required'); return }

    startTransition(async () => {
      const input = formToInput(form)
      const result = supplier
        ? await updateSupplier(supplier.id, input)
        : await createSupplier(input)

      if (result.success) {
        router.refresh()
        onClose()
      } else {
        setError(result.error ?? 'Save failed')
      }
    })
  }

  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent showCloseButton={false} className="max-w-xl sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{supplier ? 'Edit Supplier' : 'New Supplier'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <div className="space-y-1.5">
            <Label>Name *</Label>
            <Input value={form.name} onChange={(e) => set('name', e.target.value)} className="h-9" />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Contact Name</Label>
              <Input value={form.contactName} onChange={(e) => set('contactName', e.target.value)} className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label>Email</Label>
              <Input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label>Phone</Label>
              <Input value={form.phone} onChange={(e) => set('phone', e.target.value)} className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label>Currency</Label>
              <select
                value={form.currency}
                onChange={(e) => set('currency', e.target.value)}
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm font-mono"
              >
                <option value={baseCurrencyCode}>{baseCurrencyCode} {baseCurrencySymbol}</option>
                {currencies.filter((c) => c.code !== baseCurrencyCode).map((c) => (
                  <option key={c.code} value={c.code}>{c.code} {c.symbol}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Default VAT Rate</Label>
              <select
                value={form.taxRateId}
                onChange={(e) => set('taxRateId', e.target.value)}
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">No VAT</option>
                {taxRates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({(t.rate * 100).toFixed(0)}%)
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>VAT Number</Label>
              <Input value={form.vatNumber} onChange={(e) => set('vatNumber', e.target.value)} className="h-9" />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Address Line 1</Label>
            <Input value={form.addressLine1} onChange={(e) => set('addressLine1', e.target.value)} className="h-9" />
          </div>
          <div className="space-y-1.5">
            <Label>Address Line 2</Label>
            <Input value={form.addressLine2} onChange={(e) => set('addressLine2', e.target.value)} className="h-9" />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label>City</Label>
              <Input value={form.city} onChange={(e) => set('city', e.target.value)} className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label>County</Label>
              <Input value={form.county} onChange={(e) => set('county', e.target.value)} className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label>Postcode</Label>
              <Input value={form.postcode} onChange={(e) => set('postcode', e.target.value)} className="h-9" />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Country</Label>
              <CountrySelect value={form.country} onChange={(value) => set('country', value)} className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label>Account Number</Label>
              <Input value={form.accountNumber} onChange={(e) => set('accountNumber', e.target.value)} className="h-9" placeholder="Your ref with supplier" />
            </div>
            <div className="space-y-1.5">
              <Label>Payment Terms (days)</Label>
              <Input
                type="number" min={0}
                value={form.paymentTermsDays}
                onChange={(e) => set('paymentTermsDays', e.target.value)}
                className="h-9"
                placeholder="30"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Delivery Time (days)</Label>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <div className="text-xs text-muted-foreground mb-1">Average (from history)</div>
                <div className="h-9 flex items-center px-3 rounded-md border border-input bg-muted/30 font-mono text-sm">
                  {supplier && supplier.avgDeliveryDays != null ? (
                    <span>
                      {supplier.avgDeliveryDays}d
                      <span className="text-muted-foreground ml-1.5 text-xs font-sans">
                        (from {supplier.avgDeliveryDaysCount} PO{supplier.avgDeliveryDaysCount === 1 ? '' : 's'})
                      </span>
                    </span>
                  ) : (
                    <span className="text-muted-foreground text-xs font-sans">No received POs yet</span>
                  )}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-1">Manual override</div>
                <Input
                  type="number" min={0}
                  value={form.manualDeliveryDays}
                  onChange={(e) => set('manualDeliveryDays', e.target.value)}
                  className="h-9"
                  placeholder="e.g. 14"
                />
              </div>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Notes</Label>
            <Textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} rows={2} className="text-sm resize-none" />
          </div>

          {error && <p className="text-destructive text-sm">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isPending}>Cancel</Button>
          <Button onClick={handleSave} disabled={isPending}>
            {isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {supplier ? 'Save Changes' : 'Create Supplier'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function SuppliersClient({ initialSuppliers, taxRates, currencies }: Props) {
  const baseCurrency = useBaseCurrency()
  const router = useRouter()
  const searchParams = useSearchParams()
  const [, startTransition] = useTransition()
  const [editing, setEditing] = useState<SupplierRow | null | undefined>(undefined)
  const [toggling, setToggling] = useState<string | null>(null)

  // Auto-open edit dialog when navigated with ?edit=<supplierId> (render-time)
  const editId = searchParams.get('edit')
  const [prevEditId, setPrevEditId] = useState<string | null>(null)
  if (editId && editId !== prevEditId) {
    setPrevEditId(editId)
    const match = initialSuppliers.find((s) => s.id === editId)
    if (match) setEditing(match)
  }
  if (!editId && prevEditId) {
    setPrevEditId(null)
  }

  function handleToggleActive(s: SupplierRow) {
    setToggling(s.id)
    startTransition(async () => {
      await updateSupplier(s.id, { active: !s.active })
      router.refresh()
      setToggling(null)
    })
  }

  const active = initialSuppliers.filter((s) => s.active)
  const inactive = initialSuppliers.filter((s) => !s.active)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <CsvBar exportUrl="/api/export/suppliers" templateUrl="/api/export/suppliers?template=1" importAction={importSuppliersCsv} />
        <Button size="sm" onClick={() => setEditing(null)}>
          <Plus className="h-4 w-4 mr-1" />New Supplier
        </Button>
      </div>

      {initialSuppliers.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">No suppliers yet. Add your first supplier.</p>
      ) : (
        <Table className="rounded-md border min-w-[800px]">
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead className="px-4 text-xs">Name</TableHead>
              <TableHead className="px-4 text-xs">Contact</TableHead>
              <TableHead className="px-4 text-xs">Email</TableHead>
              <TableHead className="px-4 text-xs">Currency</TableHead>
              <TableHead className="px-4 text-xs">VAT Rate</TableHead>
              <TableHead className="px-4 text-xs">Terms</TableHead>
              <TableHead className="px-4 text-xs">Delivery</TableHead>
              <TableHead className="px-4 text-xs">Status</TableHead>
              <TableHead className="w-16" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {[...active, ...inactive].map((s) => (
              <TableRow key={s.id} className={!s.active ? 'opacity-50' : ''}>
                <TableCell className="px-4 font-medium">{s.name}</TableCell>
                <TableCell className="px-4 text-muted-foreground">{s.contactName ?? '—'}</TableCell>
                <TableCell className="px-4 text-muted-foreground">{s.email ?? '—'}</TableCell>
                <TableCell className="px-4 font-mono text-xs">{s.currency}</TableCell>
                <TableCell className="px-4 text-xs">
                  {s.taxRateName
                    ? <span>{s.taxRateName} ({(s.taxRate! * 100).toFixed(0)}%)</span>
                    : <span className="text-muted-foreground">—</span>}
                </TableCell>
                <TableCell className="px-4 text-muted-foreground">{s.paymentTermsDays ? `${s.paymentTermsDays}d` : '—'}</TableCell>
                <TableCell className="px-4 text-xs">
                  {s.manualDeliveryDays != null ? (
                    <span>
                      <span className="font-mono">{s.manualDeliveryDays}d</span>
                      <span className="text-muted-foreground ml-1">(manual)</span>
                    </span>
                  ) : s.avgDeliveryDays != null ? (
                    <span>
                      <span className="font-mono">{s.avgDeliveryDays}d</span>
                      <span className="text-muted-foreground ml-1">(avg of {s.avgDeliveryDaysCount})</span>
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="px-4">
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium border ${
                    s.active
                      ? 'bg-green-100 text-green-800 border-green-200 dark:bg-green-900 dark:text-green-200'
                      : 'bg-muted text-muted-foreground border-border'
                  }`}>
                    {s.active ? 'Active' : 'Inactive'}
                  </span>
                </TableCell>
                <TableCell className="px-4">
                  <div className="flex items-center gap-1 justify-end">
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setEditing(s)}>
                      <Pencil className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost" size="sm" className="h-7 w-7 p-0"
                      onClick={() => handleToggleActive(s)}
                      disabled={toggling === s.id}
                    >
                      {toggling === s.id
                        ? <Loader2 className="h-3 w-3 animate-spin" />
                        : s.active
                          ? <X className="h-3 w-3 text-muted-foreground" />
                          : <Check className="h-3 w-3 text-muted-foreground" />}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {editing !== undefined && (
        <SupplierFormDialog
          supplier={editing}
          taxRates={taxRates}
          currencies={currencies}
          baseCurrencyCode={baseCurrency.code}
          baseCurrencySymbol={baseCurrency.symbol}
          onClose={() => setEditing(undefined)}
        />
      )}
    </div>
  )
}
