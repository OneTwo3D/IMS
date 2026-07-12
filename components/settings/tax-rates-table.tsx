'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Pencil, X, Check, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { createTaxRate, updateTaxRate, type TaxRateRow, type TaxCategoryValue } from '@/app/actions/settings'

type Props = { taxRates: TaxRateRow[]; onChanged?: () => void }

const USED_FOR_LABELS: Record<string, string> = {
  SALES: 'Sales',
  PURCHASE: 'Purchases',
  BOTH: 'Both',
}

const TAX_CATEGORY_OPTIONS: { value: TaxCategoryValue; label: string }[] = [
  { value: 'STANDARD', label: 'Standard' },
  { value: 'REDUCED', label: 'Reduced' },
  { value: 'SECOND_REDUCED', label: '2nd Reduced' },
  { value: 'ZERO', label: 'Zero-rated' },
  { value: 'EXEMPT', label: 'Exempt' },
]

const TAX_CATEGORY_LABELS: Record<string, string> = Object.fromEntries(
  TAX_CATEGORY_OPTIONS.map((o) => [o.value, o.label]),
)

const REPORTING_CATEGORY_OPTIONS = [
  { value: '', label: 'None' },
  { value: 'DOMESTIC', label: 'Domestic' },
  { value: 'REVERSE_CHARGE', label: 'Reverse charge' },
  { value: 'EC_SALES', label: 'EC sales' },
  { value: 'OSS', label: 'OSS' },
]

type TaxComponentFormRow = {
  id?: string
  name: string
  ratePct: string
  compoundOnPrevious: boolean
  accountingTaxType: string
  active: boolean
}

function TaxRateFormDialog({
  rate,
  onClose,
  onChanged,
}: {
  rate: TaxRateRow | null
  onClose: () => void
  onChanged?: () => void
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [name, setName] = useState(rate?.name ?? '')
  const [rateVal, setRateVal] = useState(rate ? (rate.rate * 100).toFixed(2) : '')
  const [usedFor, setUsedFor] = useState(rate?.usedFor ?? 'BOTH')
  const [taxCategory, setTaxCategory] = useState<TaxCategoryValue>(rate?.taxCategory ?? 'STANDARD')
  const [countryCode, setCountryCode] = useState(rate?.countryCode ?? '')
  const [reverseCharge, setReverseCharge] = useState(rate?.reverseCharge ?? false)
  const [reportingCategory, setReportingCategory] = useState(rate?.reportingCategory ?? '')
  const [components, setComponents] = useState<TaxComponentFormRow[]>(
    rate?.components.map((component) => ({
      id: component.id,
      name: component.name,
      ratePct: (component.rate * 100).toFixed(2),
      compoundOnPrevious: component.compoundOnPrevious,
      accountingTaxType: component.accountingTaxType ?? '',
      active: component.active,
    })) ?? [],
  )
  const [error, setError] = useState('')

  function updateComponent(index: number, patch: Partial<TaxComponentFormRow>) {
    setComponents((current) => current.map((component, idx) => (idx === index ? { ...component, ...patch } : component)))
  }

  function addComponent() {
    setComponents((current) => [
      ...current,
      {
        name: '',
        ratePct: '',
        compoundOnPrevious: current.length > 0,
        accountingTaxType: '',
        active: true,
      },
    ])
  }

  function removeComponent(index: number) {
    setComponents((current) => current.filter((_, idx) => idx !== index))
  }

  function handleSave() {
    setError('')
    if (!name.trim()) { setError('Name is required'); return }
    const pct = parseFloat(rateVal)
    if (isNaN(pct) || pct < 0 || pct > 100) { setError('Rate must be between 0 and 100'); return }
    const trimmedCountry = countryCode.trim()
    if (trimmedCountry && trimmedCountry.length !== 2) {
      setError('Country code must be ISO 3166-1 alpha-2 (2 letters), or blank for global')
      return
    }
    const normalizedComponents = components
      .map((component, index) => ({
        id: component.id,
        name: component.name.trim(),
        rate: parseFloat(component.ratePct) / 100,
        compoundOnPrevious: component.compoundOnPrevious,
        accountingTaxType: component.accountingTaxType.trim() || null,
        sortOrder: index,
        active: component.active,
      }))
      .filter((component) => component.name.length > 0)
    const invalidComponent = normalizedComponents.find((component) => !Number.isFinite(component.rate) || component.rate < 0 || component.rate > 1)
    if (invalidComponent) {
      setError('Component rates must be between 0 and 100')
      return
    }
    const componentPayload = rate
      ? normalizedComponents
      : (normalizedComponents.length > 0 ? normalizedComponents : undefined)

    startTransition(async () => {
      const payload = {
        name,
        rate: pct / 100,
        usedFor,
        taxCategory,
        countryCode: trimmedCountry ? trimmedCountry.toLowerCase() : null,
        isCompound: componentPayload !== undefined
          ? componentPayload.length > 1 || componentPayload.some((component) => component.compoundOnPrevious)
          : undefined,
        reverseCharge,
        reportingCategory: reportingCategory || null,
        components: componentPayload,
      }
      const result = rate
        ? await updateTaxRate(rate.id, payload)
        : await createTaxRate(payload)

      if (result.success) {
        onChanged?.()
        router.refresh()
        onClose()
      } else {
        setError(result.error ?? 'Save failed')
      }
    })
  }

  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent showCloseButton={false} className="max-w-2xl sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{rate ? 'Edit VAT Rate' : 'New VAT Rate'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <div className="space-y-1.5">
            <Label>Name *</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. UK Standard Rate" className="h-9" />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Rate (%)</Label>
              <Input
                type="number" min="0" max="100" step="0.01"
                value={rateVal}
                onChange={(e) => setRateVal(e.target.value)}
                placeholder="20.00"
                className="h-9 font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Applies To</Label>
              <select
                value={usedFor}
                onChange={(e) => setUsedFor(e.target.value)}
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="BOTH">Sales &amp; Purchases</option>
                <option value="SALES">Sales only</option>
                <option value="PURCHASE">Purchases only</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Tax Category</Label>
              <select
                value={taxCategory}
                onChange={(e) => setTaxCategory(e.target.value as TaxCategoryValue)}
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
              >
                {TAX_CATEGORY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                Matched against the product&apos;s tax category at order time. &ldquo;Exempt&rdquo; vs &ldquo;Zero&rdquo; map to different accounting tax codes.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>Country Code</Label>
              <Input
                value={countryCode}
                onChange={(e) => setCountryCode(e.target.value)}
                placeholder="GB (blank = global)"
                maxLength={2}
                className="h-9 font-mono uppercase"
              />
              <p className="text-xs text-muted-foreground">
                ISO 3166-1 alpha-2. Leave blank for global fallback rates (e.g. exports).
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Reporting Category</Label>
              <select
                value={reportingCategory}
                onChange={(e) => setReportingCategory(e.target.value)}
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
              >
                {REPORTING_CATEGORY_OPTIONS.map((option) => (
                  <option key={option.value || 'none'} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
            <label className="flex items-center gap-2 self-end h-9 text-sm">
              <input
                type="checkbox"
                checked={reverseCharge}
                onChange={(e) => setReverseCharge(e.target.checked)}
                className="h-4 w-4 rounded border-input"
              />
              Reverse charge
            </label>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label>Tax Components</Label>
              <Button type="button" size="sm" variant="outline" onClick={addComponent}>
                <Plus className="h-3 w-3 mr-1" />Add
              </Button>
            </div>
            {components.length > 0 && (
              <div className="space-y-2">
                {components.map((component, index) => (
                  <div key={component.id ?? index} className="grid grid-cols-1 sm:grid-cols-[1fr_7rem_auto] gap-2 rounded-md border p-2">
                    <Input
                      value={component.name}
                      onChange={(e) => updateComponent(index, { name: e.target.value })}
                      placeholder="Component name"
                      className="h-9"
                    />
                    <Input
                      type="number"
                      min="0"
                      max="100"
                      step="0.01"
                      value={component.ratePct}
                      onChange={(e) => updateComponent(index, { ratePct: e.target.value })}
                      placeholder="0.00"
                      className="h-9 font-mono"
                    />
                    <Button type="button" variant="ghost" size="sm" className="h-9 w-9 p-0" onClick={() => removeComponent(index)}>
                      <X className="h-4 w-4" />
                    </Button>
                    <div className="sm:col-span-3 grid grid-cols-1 sm:grid-cols-[1fr_auto_auto] gap-2">
                      <Input
                        value={component.accountingTaxType}
                        onChange={(e) => updateComponent(index, { accountingTaxType: e.target.value })}
                        placeholder="Accounting tax type"
                        className="h-9"
                      />
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={component.compoundOnPrevious}
                          onChange={(e) => updateComponent(index, { compoundOnPrevious: e.target.checked })}
                          className="h-4 w-4 rounded border-input"
                        />
                        Compound
                      </label>
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={component.active}
                          onChange={(e) => updateComponent(index, { active: e.target.checked })}
                          className="h-4 w-4 rounded border-input"
                        />
                        Active
                      </label>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {error && <p className="text-destructive text-sm">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isPending}>Cancel</Button>
          <Button onClick={handleSave} disabled={isPending}>
            {isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {rate ? 'Save Changes' : 'Create Rate'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function TaxRatesTable({ taxRates, onChanged }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [editing, setEditing] = useState<TaxRateRow | null | undefined>(undefined)

  function handleToggle(rate: TaxRateRow) {
    startTransition(async () => {
      await updateTaxRate(rate.id, { active: !rate.active })
      onChanged?.()
      router.refresh()
    })
  }

  const salesRates = taxRates.filter((r) => r.usedFor === 'SALES' || r.usedFor === 'BOTH')
  const purchaseRates = taxRates.filter((r) => r.usedFor === 'PURCHASE' || r.usedFor === 'BOTH')
  const sections = [
    { title: 'Sales VAT Rates', rates: salesRates },
    { title: 'Purchase VAT Rates', rates: purchaseRates },
  ]

  // Deduplicate: if a rate is BOTH, it appears in both sections. Show a flat list instead if all are BOTH.
  const allBoth = taxRates.every((r) => r.usedFor === 'BOTH')

  function renderTable(rates: TaxRateRow[]) {
    if (rates.length === 0) return <p className="text-sm text-muted-foreground py-2">No rates defined.</p>
    return (
      <Table className="rounded-md border">
        <TableHeader className="bg-muted/50">
          <TableRow>
            <TableHead className="text-xs">Name</TableHead>
            <TableHead className="text-xs">Category</TableHead>
            <TableHead className="text-xs">Country</TableHead>
            <TableHead className="text-xs">Reporting</TableHead>
            <TableHead className="text-xs text-right">Rate</TableHead>
            {!allBoth && <TableHead className="text-xs">Applies To</TableHead>}
            <TableHead className="text-xs">Status</TableHead>
            <TableHead className="w-16" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rates.map((r) => (
            <TableRow key={r.id} className={!r.active ? 'opacity-50' : ''}>
              <TableCell className="font-medium">{r.name}</TableCell>
              <TableCell className="text-xs">
                <span className="inline-flex items-center rounded-full px-2 py-0.5 font-medium border bg-muted/50">
                  {TAX_CATEGORY_LABELS[r.taxCategory] ?? r.taxCategory}
                </span>
              </TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground uppercase">
                {r.countryCode ?? '—'}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {r.reverseCharge ? 'Reverse charge' : r.reportingCategory ?? '—'}
                {r.components.length > 0 && <span className="block">{r.components.length} component{r.components.length === 1 ? '' : 's'}</span>}
              </TableCell>
              <TableCell className="text-right font-mono text-xs">{(r.rate * 100).toFixed(2)}%</TableCell>
              {!allBoth && <TableCell className="text-xs text-muted-foreground">{USED_FOR_LABELS[r.usedFor] ?? r.usedFor}</TableCell>}
              <TableCell>
                <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium border ${
                  r.active
                    ? 'bg-green-100 text-green-800 border-green-200 dark:bg-green-900 dark:text-green-200'
                    : 'bg-muted text-muted-foreground border-border'
                }`}>
                  {r.active ? 'Active' : 'Inactive'}
                </span>
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-1 justify-end">
                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setEditing(r)}>
                    <Pencil className="h-3 w-3" />
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => handleToggle(r)} disabled={isPending}>
                    {r.active ? <X className="h-3 w-3 text-muted-foreground" /> : <Check className="h-3 w-3 text-muted-foreground" />}
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-2 flex-wrap">
        <Button size="sm" onClick={() => setEditing(null)}>
          <Plus className="h-3 w-3 mr-1" />Add VAT Rate
        </Button>
      </div>

      {allBoth ? (
        renderTable(taxRates)
      ) : (
        sections.map((s) => (
          <div key={s.title} className="space-y-2">
            <h3 className="text-sm font-medium text-muted-foreground">{s.title}</h3>
            {renderTable(s.rates)}
          </div>
        ))
      )}

      {editing !== undefined && (
        <TaxRateFormDialog rate={editing} onClose={() => setEditing(undefined)} onChanged={onChanged} />
      )}
    </div>
  )
}
