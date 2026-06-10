'use client'

import { useState, useTransition, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Plus, Pencil, X, Check, Loader2, Search, ShieldAlert, Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CountrySelect } from '@/components/ui/country-select'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { createCustomer, updateCustomer, importContactsCsv, anonymiseCustomer, type CustomerRow, type CustomerInput, type AddressData } from '@/app/actions/customers'
import { CsvBar } from '@/components/ui/csv-bar'
import { useBaseCurrency } from '@/components/providers/base-currency-provider'
import { formatCountryDisplay } from '@/lib/countries'
import { formatMoney } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

type ColKey = 'name' | 'company' | 'email' | 'phone' | 'taxNumber' | 'billingAddress' | 'shippingAddress' | 'orders' | 'lifetimeValue' | 'currentYearSales' | 'lastOrder' | 'status' | 'created' | 'notes'

const CURRENT_YEAR = new Date().getFullYear()

const ALL_COLUMNS: { key: ColKey; label: string; defaultVisible: boolean; align?: 'right' }[] = [
  { key: 'name', label: 'Name', defaultVisible: true },
  { key: 'company', label: 'Company', defaultVisible: true },
  { key: 'email', label: 'Email', defaultVisible: true },
  { key: 'phone', label: 'Phone', defaultVisible: false },
  { key: 'taxNumber', label: 'Tax Number', defaultVisible: true },
  { key: 'billingAddress', label: 'Billing Address', defaultVisible: true },
  { key: 'shippingAddress', label: 'Shipping Address', defaultVisible: false },
  { key: 'orders', label: 'Orders', defaultVisible: true, align: 'right' },
  { key: 'lifetimeValue', label: 'Lifetime Value', defaultVisible: true, align: 'right' },
  { key: 'currentYearSales', label: `${CURRENT_YEAR} Sales`, defaultVisible: true, align: 'right' },
  { key: 'lastOrder', label: 'Last Order', defaultVisible: false },
  { key: 'status', label: 'Status', defaultVisible: false },
  { key: 'created', label: 'Created', defaultVisible: false },
  { key: 'notes', label: 'Notes', defaultVisible: false },
]

const LS_KEY = 'customer-list-cols'

function defaultVisibility(): Record<ColKey, boolean> {
  return Object.fromEntries(ALL_COLUMNS.map((c) => [c.key, c.defaultVisible])) as Record<ColKey, boolean>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatAddr(a: AddressData | null): string {
  if (!a) return '—'
  return [a.line1, a.line2, a.city, a.postcode, formatCountryDisplay(a.country)].filter(Boolean).join(', ') || '—'
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

// ---------------------------------------------------------------------------
// Address Fields (shared by form)
// ---------------------------------------------------------------------------

function AddressFields({ label, value, onChange, disabled }: { label: string; value: AddressData; onChange: (v: AddressData) => void; disabled?: boolean }) {
  function set(field: keyof AddressData, val: string) { onChange({ ...value, [field]: val }) }
  return (
    <div className="space-y-2">
      <Label className="text-xs font-medium text-muted-foreground uppercase">{label}</Label>
      <Input value={value.line1 ?? ''} onChange={(e) => set('line1', e.target.value)} placeholder="Address line 1" className="h-8 text-sm" disabled={disabled} />
      <Input value={value.line2 ?? ''} onChange={(e) => set('line2', e.target.value)} placeholder="Address line 2" className="h-8 text-sm" disabled={disabled} />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        <Input value={value.city ?? ''} onChange={(e) => set('city', e.target.value)} placeholder="City" className="h-8 text-sm" disabled={disabled} />
        <Input value={value.county ?? ''} onChange={(e) => set('county', e.target.value)} placeholder="County" className="h-8 text-sm" disabled={disabled} />
        <Input value={value.postcode ?? ''} onChange={(e) => set('postcode', e.target.value)} placeholder="Postcode" className="h-8 text-sm" disabled={disabled} />
      </div>
      <CountrySelect value={value.country ?? ''} onChange={(country) => set('country', country)} blankLabel="Country" className="h-8 text-sm" disabled={disabled} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Customer Form Dialog
// ---------------------------------------------------------------------------

function CustomerFormDialog({ customer, onClose }: { customer: CustomerRow | null; onClose: () => void }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [firstName, setFirstName] = useState(customer?.firstName ?? '')
  const [lastName, setLastName] = useState(customer?.lastName ?? '')
  const [email, setEmail] = useState(customer?.email ?? '')
  const [phone, setPhone] = useState(customer?.phone ?? '')
  const [company, setCompany] = useState(customer?.company ?? '')
  const [taxNumber, setTaxNumber] = useState(customer?.taxNumber ?? '')
  const [billing, setBilling] = useState<AddressData>(customer?.billingAddress ?? {})
  const [shipping, setShipping] = useState<AddressData>(customer?.shippingAddress ?? {})
  const [sameAddress, setSameAddress] = useState(false)
  const [notes, setNotes] = useState(customer?.notes ?? '')
  const [error, setError] = useState('')

  function handleSameAddressToggle(checked: boolean) {
    setSameAddress(checked)
    if (checked) setShipping({ ...billing })
  }

  function handleBillingChange(v: AddressData) {
    setBilling(v)
    if (sameAddress) setShipping({ ...v })
  }

  function handleSave() {
    setError('')
    if (!firstName.trim()) { setError('First name is required'); return }
    startTransition(async () => {
      const input: CustomerInput = {
        firstName, lastName: lastName || undefined,
        email: email || undefined, phone: phone || undefined,
        company: company || undefined, taxNumber: taxNumber || undefined,
        billingAddress: billing,
        shippingAddress: sameAddress ? billing : shipping,
        notes: notes || undefined,
      }
      const result = customer ? await updateCustomer(customer.id, input) : await createCustomer(input)
      if (result.success) { router.refresh(); onClose() }
      else setError(result.error ?? 'Save failed')
    })
  }

  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent showCloseButton={false} className="max-w-2xl sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{customer ? 'Edit Customer' : 'New Customer'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>First Name *</Label>
              <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label>Last Name</Label>
              <Input value={lastName} onChange={(e) => setLastName(e.target.value)} className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label>Email</Label>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label>Phone</Label>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label>Company</Label>
              <Input value={company} onChange={(e) => setCompany(e.target.value)} className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label>Tax / VAT Number</Label>
              <Input value={taxNumber} onChange={(e) => setTaxNumber(e.target.value)} placeholder="e.g. GB123456789" className="h-9 font-mono" />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <AddressFields label="Billing Address" value={billing} onChange={handleBillingChange} />
            <div>
              <div className="flex items-center justify-between mb-2">
                <Label className="text-xs font-medium text-muted-foreground uppercase">Shipping Address</Label>
                <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                  <input type="checkbox" checked={sameAddress} onChange={(e) => handleSameAddressToggle(e.target.checked)} className="rounded border-input" />
                  Same as billing
                </label>
              </div>
              {sameAddress ? (
                <p className="text-xs text-muted-foreground italic py-2">Using billing address</p>
              ) : (
                <AddressFields label="" value={shipping} onChange={setShipping} />
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Notes</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="text-sm resize-none" />
          </div>
          {error && <p className="text-destructive text-sm">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isPending}>Cancel</Button>
          <Button onClick={handleSave} disabled={isPending}>
            {isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {customer ? 'Save Changes' : 'Create Contact'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// GDPR Dialog
// ---------------------------------------------------------------------------

function GdprDialog({ customer, onClose }: { customer: CustomerRow; onClose: () => void }) {
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

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

type Props = { initialCustomers: CustomerRow[] }

export function ContactsClient({ initialCustomers }: Props) {
  const baseCurrency = useBaseCurrency()
  const fmtBase = (value: number) => formatMoney(value, baseCurrency.symbol, baseCurrency.symbolPosition)
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [editing, setEditing] = useState<CustomerRow | null | undefined>(undefined)
  const [gdprTarget, setGdprTarget] = useState<CustomerRow | undefined>(undefined)
  const [search, setSearch] = useState('')

  // Column visibility (lazy init from localStorage)
  const [visible, setVisible] = useState<Record<ColKey, boolean>>(() => {
    if (typeof window === 'undefined') return defaultVisibility
    try {
      const stored = localStorage.getItem(LS_KEY)
      if (stored) return JSON.parse(stored)
    } catch { /* ignore */ }
    return defaultVisibility
  })
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPickerOpen(false)
    }
    if (pickerOpen) document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [pickerOpen])

  function toggleCol(key: ColKey, value: boolean) {
    const next = { ...visible, [key]: value }
    setVisible(next)
    try { localStorage.setItem(LS_KEY, JSON.stringify(next)) } catch { /* noop */ }
  }

  const visibleCols = ALL_COLUMNS.filter((c) => visible[c.key])

  const filtered = initialCustomers.filter((c) => {
    if (!search) return true
    const q = search.toLowerCase()
    return c.fullName.toLowerCase().includes(q) || (c.email ?? '').toLowerCase().includes(q) || (c.company ?? '').toLowerCase().includes(q)
  })

  const active = filtered.filter((c) => c.active)
  const inactive = filtered.filter((c) => !c.active)

  function handleToggle(c: CustomerRow) {
    startTransition(async () => {
      await updateCustomer(c.id, { active: !c.active })
      router.refresh()
    })
  }

  function renderCell(c: CustomerRow, key: ColKey) {
    switch (key) {
      case 'name':
        return (
          <>
            <Link href={`/sales/contacts/${c.id}`} className="text-primary hover:underline" target="_blank">
              {c.fullName}
            </Link>
            {c.gdprAnonymisedAt && (
              <span className="ml-2 inline-flex items-center gap-1 text-[10px] font-medium text-orange-600 bg-orange-50 px-1.5 py-0.5 rounded">
                <ShieldAlert className="h-3 w-3" />GDPR
              </span>
            )}
          </>
        )
      case 'company': return c.company ?? '—'
      case 'email': return c.email ?? '—'
      case 'phone': return c.phone ?? '—'
      case 'taxNumber': return c.taxNumber ? <span className="font-mono">{c.taxNumber}</span> : '—'
      case 'billingAddress': return formatAddr(c.billingAddress)
      case 'shippingAddress': return formatAddr(c.shippingAddress)
      case 'orders': return c.orderCount
      case 'lifetimeValue': return c.lifetimeValueBase > 0 ? fmtBase(c.lifetimeValueBase) : '—'
      case 'currentYearSales': return c.currentYearSalesBase > 0 ? fmtBase(c.currentYearSalesBase) : '—'
      case 'lastOrder': return fmtDate(c.lastOrderAt)
      case 'status':
        return (
          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium border ${
            c.active
              ? 'bg-green-100 text-green-800 border-green-200 dark:bg-green-900 dark:text-green-200'
              : 'bg-muted text-muted-foreground border-border'
          }`}>
            {c.active ? 'Active' : 'Inactive'}
          </span>
        )
      case 'created': return fmtDate(c.createdAt)
      case 'notes': return c.notes ? <span className="truncate max-w-40 block">{c.notes}</span> : '—'
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <div className="flex items-center gap-2">
          <CsvBar exportUrl="/api/export/contacts" templateUrl="/api/export/contacts?template=1" importAction={importContactsCsv} />
          <Button size="sm" onClick={() => setEditing(null)}>
            <Plus className="h-4 w-4 mr-1" />New Customer
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-48 max-w-xs">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search customers…" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-8 h-8 text-sm" />
        </div>
        <div className="relative" ref={pickerRef}>
          <Button variant="outline" size="sm" className="h-8" onClick={() => setPickerOpen((o) => !o)} title="Column settings">
            <Settings2 className="h-4 w-4" />
          </Button>
          {pickerOpen && (
            <div className="absolute right-0 top-full mt-1 z-50 w-[calc(100vw-2rem)] sm:w-52 rounded-md border border-border bg-popover shadow-md p-2 space-y-1">
              {ALL_COLUMNS.map((col) => (
                <label key={col.key} className="flex items-center gap-2 px-1 py-0.5 text-sm cursor-pointer hover:bg-accent rounded">
                  <input
                    type="checkbox"
                    checked={!!visible[col.key]}
                    onChange={(e) => toggleCol(col.key, e.target.checked)}
                    className="h-3.5 w-3.5 accent-primary"
                  />
                  {col.label}
                </label>
              ))}
            </div>
          )}
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">No customers found.</p>
      ) : (
        <Table containerClassName="rounded-md border max-h-[calc(100vh-16rem)]" className="min-w-[700px]">
          <TableHeader className="bg-muted/50">
            <TableRow>
              {visibleCols.map((col) => (
                <TableHead key={col.key} className={`px-4 text-xs${col.align === 'right' ? ' text-right' : ''}`}>
                  {col.label}
                </TableHead>
              ))}
              <TableHead className="w-16" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {[...active, ...inactive].map((c) => (
              <TableRow key={c.id} className={!c.active ? 'opacity-50' : ''}>
                {visibleCols.map((col) => (
                  <TableCell
                    key={col.key}
                    className={`px-4${col.align === 'right' ? ' text-right tabular-nums' : ''} text-xs${col.key === 'name' ? ' font-medium' : ' text-muted-foreground'}${col.key === 'billingAddress' || col.key === 'shippingAddress' ? ' truncate max-w-40' : ''}`}
                  >
                    {renderCell(c, col.key)}
                  </TableCell>
                ))}
                <TableCell className="px-4">
                  <div className="flex items-center gap-1 justify-end">
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setEditing(c)}>
                      <Pencil className="h-3 w-3" />
                    </Button>
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => handleToggle(c)} disabled={isPending}>
                      {c.active ? <X className="h-3 w-3 text-muted-foreground" /> : <Check className="h-3 w-3 text-muted-foreground" />}
                    </Button>
                    {!c.gdprAnonymisedAt && (
                      <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setGdprTarget(c)} title="GDPR Anonymise">
                        <ShieldAlert className="h-3 w-3 text-muted-foreground" />
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {editing !== undefined && <CustomerFormDialog customer={editing} onClose={() => setEditing(undefined)} />}
      {gdprTarget && <GdprDialog customer={gdprTarget} onClose={() => setGdprTarget(undefined)} />}
    </div>
  )
}
