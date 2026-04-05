'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Pencil, X, Check, Loader2, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { createCustomer, updateCustomer, importContactsCsv, type CustomerRow, type CustomerInput, type AddressData } from '@/app/actions/customers'
import { CsvBar } from '@/components/ui/csv-bar'

type Props = { initialCustomers: CustomerRow[] }

function AddressFields({ label, value, onChange, disabled }: { label: string; value: AddressData; onChange: (v: AddressData) => void; disabled?: boolean }) {
  function set(field: keyof AddressData, val: string) { onChange({ ...value, [field]: val }) }
  return (
    <div className="space-y-2">
      <Label className="text-xs font-medium text-muted-foreground uppercase">{label}</Label>
      <Input value={value.line1 ?? ''} onChange={(e) => set('line1', e.target.value)} placeholder="Address line 1" className="h-8 text-sm" disabled={disabled} />
      <Input value={value.line2 ?? ''} onChange={(e) => set('line2', e.target.value)} placeholder="Address line 2" className="h-8 text-sm" disabled={disabled} />
      <div className="grid grid-cols-3 gap-2">
        <Input value={value.city ?? ''} onChange={(e) => set('city', e.target.value)} placeholder="City" className="h-8 text-sm" disabled={disabled} />
        <Input value={value.county ?? ''} onChange={(e) => set('county', e.target.value)} placeholder="County" className="h-8 text-sm" disabled={disabled} />
        <Input value={value.postcode ?? ''} onChange={(e) => set('postcode', e.target.value)} placeholder="Postcode" className="h-8 text-sm" disabled={disabled} />
      </div>
      <Input value={value.country ?? ''} onChange={(e) => set('country', e.target.value)} placeholder="Country" className="h-8 text-sm" disabled={disabled} />
    </div>
  )
}

function formatAddr(a: AddressData | null): string {
  if (!a) return '—'
  return [a.line1, a.line2, a.city, a.postcode, a.country].filter(Boolean).join(', ') || '—'
}

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
      <DialogContent showCloseButton={false} className="max-w-2xl sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{customer ? 'Edit Customer' : 'New Customer'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <div className="grid grid-cols-2 gap-3">
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

          <div className="grid grid-cols-2 gap-4">
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

export function ContactsClient({ initialCustomers }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [editing, setEditing] = useState<CustomerRow | null | undefined>(undefined)
  const [search, setSearch] = useState('')

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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Customers</h1>
        <Button size="sm" onClick={() => setEditing(null)}>
          <Plus className="h-4 w-4 mr-1" />New Customer
        </Button>
      </div>

      <CsvBar exportUrl="/api/export/contacts" templateUrl="/api/export/contacts?template=1" importAction={importContactsCsv} />

      <div className="relative max-w-xs">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input placeholder="Search customers…" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-8 h-8 text-sm" />
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">No customers found.</p>
      ) : (
        <div className="rounded-md border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/50">
              <tr>
                <th className="px-4 py-2 text-left font-medium text-muted-foreground text-xs">Name</th>
                <th className="px-4 py-2 text-left font-medium text-muted-foreground text-xs">Company</th>
                <th className="px-4 py-2 text-left font-medium text-muted-foreground text-xs">Email</th>
                <th className="px-4 py-2 text-left font-medium text-muted-foreground text-xs">Tax Number</th>
                <th className="px-4 py-2 text-left font-medium text-muted-foreground text-xs">Billing Address</th>
                <th className="px-4 py-2 text-right font-medium text-muted-foreground text-xs">Orders</th>
                <th className="w-16" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {[...active, ...inactive].map((c) => (
                <tr key={c.id} className={`hover:bg-muted/30 ${!c.active ? 'opacity-50' : ''}`}>
                  <td className="px-4 py-2 font-medium">{c.fullName}</td>
                  <td className="px-4 py-2 text-muted-foreground text-xs">{c.company ?? '—'}</td>
                  <td className="px-4 py-2 text-muted-foreground text-xs">{c.email ?? '—'}</td>
                  <td className="px-4 py-2 text-muted-foreground text-xs font-mono">{c.taxNumber ?? '—'}</td>
                  <td className="px-4 py-2 text-muted-foreground text-xs truncate max-w-40">{formatAddr(c.billingAddress)}</td>
                  <td className="px-4 py-2 text-right text-xs tabular-nums">{c.orderCount}</td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-1 justify-end">
                      <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setEditing(c)}>
                        <Pencil className="h-3 w-3" />
                      </Button>
                      <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => handleToggle(c)} disabled={isPending}>
                        {c.active ? <X className="h-3 w-3 text-muted-foreground" /> : <Check className="h-3 w-3 text-muted-foreground" />}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing !== undefined && <CustomerFormDialog customer={editing} onClose={() => setEditing(undefined)} />}
    </div>
  )
}
