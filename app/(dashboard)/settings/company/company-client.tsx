'use client'

import { useState, useTransition, useRef } from 'react'
import { useRouter } from 'next/navigation'
import {
  Building2, Palette, Hash, Mail, FileText, Upload, Loader2, Check, Trash2, Camera, Eye,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import {
  updateOrganisation,
  saveNumberingFormats,
  saveEmailSettings,
  saveBrandingColours,
  saveDocumentTemplate,
  type OrganisationData,
  type NumberingFormats,
  type EmailSettings,
  type BrandingColours,
  type DocumentTemplateData,
} from '@/app/actions/company'
import type { CurrencyRow } from '@/app/actions/currencies'

type ShoppingConnectorSummary = { id: string; label: string; available: boolean }

type Props = {
  org: OrganisationData
  baseCurrencyLocked: boolean
  numbering: NumberingFormats
  email: EmailSettings
  branding: BrandingColours
  templates: DocumentTemplateData[]
  shoppingConnectors: ShoppingConnectorSummary[]
  currencies: CurrencyRow[]
}

const TABS = [
  { key: 'company', label: 'Company Details', icon: Building2 },
  { key: 'branding', label: 'Branding', icon: Palette },
  { key: 'numbering', label: 'Numbering', icon: Hash },
  { key: 'email', label: 'Email', icon: Mail },
  { key: 'documents', label: 'Documents', icon: FileText },
] as const

type Tab = (typeof TABS)[number]['key']

const TEMPLATE_LABELS: Record<string, string> = {
  sales_order: 'Sales Order',
  purchase_order: 'Purchase Order',
  invoice: 'Invoice',
  packing_slip: 'Packing Slip',
  credit_note: 'Credit Note',
  rfq: 'Request for Quotation',
  manufacturing_order: 'Manufacturing Order',
}

export function CompanySettingsClient({ org, baseCurrencyLocked, numbering, email, branding, templates, shoppingConnectors, currencies }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [tab, setTab] = useState<Tab>('company')
  const [saved, setSaved] = useState<string | null>(null)

  // --- Company details state ---
  const [co, setCo] = useState(org)
  const [logoUrl, setLogoUrl] = useState(org.logoUrl)
  const [docLogoUrl, setDocLogoUrl] = useState(org.documentLogoUrl)
  const [uploading, setUploading] = useState(false)
  const [uploadingDoc, setUploadingDoc] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const docFileRef = useRef<HTMLInputElement>(null)

  // --- Branding state ---
  const [br, setBr] = useState(branding)

  // --- Numbering state ---
  const [num, setNum] = useState(numbering)

  // --- Email state ---
  const [em, setEm] = useState(email)

  // --- Templates state ---
  const [tpls, setTpls] = useState(templates)
  const [editingTpl, setEditingTpl] = useState<string | null>(null)

  function showSaved(section: string) {
    setSaved(section)
    setTimeout(() => setSaved(null), 2000)
  }

  // Company
  function handleSaveCompany() {
    startTransition(async () => {
      const result = await updateOrganisation(co)
      if (result.success) showSaved('company')
      else if (result.error) alert(result.error)
    })
  }

  async function handleLogoUpload(e: React.ChangeEvent<HTMLInputElement>, variant: 'icon' | 'document') {
    const file = e.target.files?.[0]
    if (!file) return
    const setLoading = variant === 'document' ? setUploadingDoc : setUploading
    setLoading(true)
    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('variant', variant)
      const res = await fetch('/api/upload/logo', { method: 'POST', body: formData })
      const data = await res.json()
      if (res.ok) {
        if (variant === 'document') {
          setDocLogoUrl(data.url)
          setCo((p) => ({ ...p, documentLogoUrl: data.url }))
        } else {
          setLogoUrl(data.url)
          setCo((p) => ({ ...p, logoUrl: data.url }))
        }
        router.refresh()
        showSaved(variant === 'document' ? 'doclogo' : 'logo')
      }
    } finally {
      setLoading(false)
      const ref = variant === 'document' ? docFileRef : fileRef
      if (ref.current) ref.current.value = ''
    }
  }

  function handleRemoveLogo(variant: 'icon' | 'document') {
    startTransition(async () => {
      if (variant === 'document') {
        await updateOrganisation({ documentLogoUrl: null })
        setDocLogoUrl(null)
        setCo((p) => ({ ...p, documentLogoUrl: null }))
      } else {
        await updateOrganisation({ logoUrl: null })
        setLogoUrl(null)
        setCo((p) => ({ ...p, logoUrl: null }))
      }
      router.refresh()
    })
  }

  // Branding
  function handleSaveBranding() {
    startTransition(async () => {
      await saveBrandingColours(br)
      showSaved('branding')
    })
  }

  // Numbering
  function handleSaveNumbering() {
    startTransition(async () => {
      await saveNumberingFormats(num)
      showSaved('numbering')
    })
  }

  // Email
  function handleSaveEmail() {
    startTransition(async () => {
      await saveEmailSettings(em)
      showSaved('email')
    })
  }

  // Templates
  function handleSaveTemplate(type: string) {
    const tpl = tpls.find((t) => t.type === type)
    if (!tpl) return
    startTransition(async () => {
      await saveDocumentTemplate(tpl)
      setEditingTpl(null)
      showSaved(`tpl-${type}`)
    })
  }

  function updateTpl(type: string, field: string, value: unknown) {
    setTpls((prev) => prev.map((t) => t.type === type ? { ...t, [field]: value } : t))
  }

  function coField(key: keyof OrganisationData, label: string, opts?: { type?: string; span?: number }) {
    return (
      <div className={`space-y-1.5 ${opts?.span === 2 ? 'sm:col-span-2' : ''}`}>
        <Label className="text-xs">{label}</Label>
        <Input
          type={opts?.type ?? 'text'}
          value={(co[key] as string) ?? ''}
          onChange={(e) => setCo((p) => ({ ...p, [key]: e.target.value || null }))}
          className="h-9"
        />
      </div>
    )
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-semibold">Company Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Company details, branding, document numbering, email, and templates.
        </p>
      </div>

      {/* Tabs */}
      <div className="border-b">
        <div className="flex items-center gap-1 overflow-x-auto overflow-y-hidden">
          {TABS.map((t) => {
            const Icon = t.icon
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={`shrink-0 flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors -mb-px ${
                  tab === t.key
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {t.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* ---- Company Details ---- */}
      {tab === 'company' && (
        <Card className="p-6">
          {/* Logos */}
          <h3 className="text-sm font-medium mb-3">Logos</h3>
          <div className="flex items-start gap-4 sm:gap-6 mb-6">
            {/* Square icon logo */}
            <div className="flex flex-col items-center gap-2">
              <p className="text-xs text-muted-foreground font-medium">Icon Logo</p>
              <div className="relative group h-20 w-20 rounded-lg border bg-muted flex items-center justify-center overflow-hidden">
                {logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={logoUrl} alt="Icon logo" className="h-full w-full object-contain" />
                ) : (
                  <Building2 className="h-8 w-8 text-muted-foreground" />
                )}
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                  disabled={uploading}
                >
                  {uploading ? <Loader2 className="h-5 w-5 text-white animate-spin" /> : <Camera className="h-5 w-5 text-white" />}
                </button>
                <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/svg+xml" className="hidden" onChange={(e) => handleLogoUpload(e, 'icon')} />
              </div>
              <div className="flex items-center gap-1">
                <Button variant="outline" size="sm" className="text-xs h-7" onClick={() => fileRef.current?.click()} disabled={uploading}>
                  <Upload className="h-3 w-3 mr-1" />{logoUrl ? 'Change' : 'Upload'}
                </Button>
                {logoUrl && (
                  <Button variant="ghost" size="sm" className="text-xs h-7 text-destructive" onClick={() => handleRemoveLogo('icon')} disabled={isPending}>
                    <Trash2 className="h-3 w-3" />
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground text-center max-w-[120px]">Square. Used in sidebar &amp; top-left corner.</p>
            </div>

            {/* Document header logo */}
            <div className="flex flex-col items-center gap-2">
              <p className="text-xs text-muted-foreground font-medium">Document Logo</p>
              <div className="relative group h-16 sm:h-20 w-32 sm:w-48 rounded-lg border bg-muted flex items-center justify-center overflow-hidden">
                {docLogoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={docLogoUrl} alt="Document logo" className="h-full w-full object-contain" />
                ) : (
                  <FileText className="h-8 w-8 text-muted-foreground" />
                )}
                <button
                  type="button"
                  onClick={() => docFileRef.current?.click()}
                  className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                  disabled={uploadingDoc}
                >
                  {uploadingDoc ? <Loader2 className="h-5 w-5 text-white animate-spin" /> : <Camera className="h-5 w-5 text-white" />}
                </button>
                <input ref={docFileRef} type="file" accept="image/jpeg,image/png,image/webp,image/svg+xml" className="hidden" onChange={(e) => handleLogoUpload(e, 'document')} />
              </div>
              <div className="flex items-center gap-1">
                <Button variant="outline" size="sm" className="text-xs h-7" onClick={() => docFileRef.current?.click()} disabled={uploadingDoc}>
                  <Upload className="h-3 w-3 mr-1" />{docLogoUrl ? 'Change' : 'Upload'}
                </Button>
                {docLogoUrl && (
                  <Button variant="ghost" size="sm" className="text-xs h-7 text-destructive" onClick={() => handleRemoveLogo('document')} disabled={isPending}>
                    <Trash2 className="h-3 w-3" />
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground text-center max-w-[200px]">Rectangular. Used in PDF headers (invoices, POs, etc).</p>
            </div>
          </div>

          <h3 className="text-sm font-medium mb-3">Company Information</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
            {coField('name', 'Company Name')}
            {coField('legalName', 'Legal Name')}
            {coField('vatNumber', 'VAT Number')}
            {coField('companyNumber', 'Company Number')}
            <div className="space-y-1.5">
              <Label className="text-xs">Base Currency</Label>
              <select
                value={co.baseCurrency}
                onChange={(e) => setCo((p) => ({ ...p, baseCurrency: e.target.value }))}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm font-mono"
                disabled={baseCurrencyLocked}
              >
                {currencies
                  .filter((c) => c.active)
                  .sort((a, b) => a.code.localeCompare(b.code))
                  .map((c) => (
                    <option key={c.code} value={c.code}>{c.code} {c.symbol}</option>
                  ))}
              </select>
              <p className="text-xs text-muted-foreground">
                {baseCurrencyLocked
                  ? 'Base currency is locked. Reset the database to change it.'
                  : 'Set this once during setup. Saving it locks the base currency for this database.'}
              </p>
            </div>
          </div>

          <h3 className="text-sm font-medium mb-3">Address</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
            {coField('addressLine1', 'Address Line 1', { span: 2 })}
            {coField('addressLine2', 'Address Line 2', { span: 2 })}
            {coField('city', 'City')}
            {coField('county', 'County')}
            {coField('postcode', 'Postcode')}
            {coField('country', 'Country')}
          </div>

          <h3 className="text-sm font-medium mb-3">Contact</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
            {coField('phone', 'Phone')}
            {coField('email', 'Email', { type: 'email' })}
            {coField('website', 'Website')}
          </div>

          <SaveButton onClick={handleSaveCompany} pending={isPending} saved={saved === 'company'} />
        </Card>
      )}

      {/* ---- Branding ---- */}
      {tab === 'branding' && (
        <Card className="p-6">
          <p className="text-sm text-muted-foreground mb-4">
            These colours are used on PDF documents (invoices, purchase orders, etc).
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-md">
            <div className="space-y-1.5">
              <Label className="text-xs">Primary Colour</Label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={br.primaryColor}
                  onChange={(e) => setBr((p) => ({ ...p, primaryColor: e.target.value }))}
                  className="h-9 w-12 rounded border cursor-pointer"
                />
                <Input
                  value={br.primaryColor}
                  onChange={(e) => setBr((p) => ({ ...p, primaryColor: e.target.value }))}
                  className="h-9 w-28 font-mono text-xs"
                />
              </div>
              <p className="text-xs text-muted-foreground">Document title bar background</p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Accent Colour</Label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={br.accentColor}
                  onChange={(e) => setBr((p) => ({ ...p, accentColor: e.target.value }))}
                  className="h-9 w-12 rounded border cursor-pointer"
                />
                <Input
                  value={br.accentColor}
                  onChange={(e) => setBr((p) => ({ ...p, accentColor: e.target.value }))}
                  className="h-9 w-28 font-mono text-xs"
                />
              </div>
              <p className="text-xs text-muted-foreground">Table headers and highlights</p>
            </div>
          </div>

          <div className="mt-6">
            <h3 className="text-sm font-medium mb-2">Preview</h3>
            <div className="flex gap-3 items-start">
              <div className="rounded overflow-hidden border" style={{ width: 200 }}>
                <div className="h-8 flex items-center px-3" style={{ backgroundColor: br.primaryColor }}>
                  <span className="text-white text-xs font-bold">INVOICE</span>
                </div>
                <div className="p-2 text-xs text-muted-foreground space-y-1">
                  <div className="h-4 rounded" style={{ backgroundColor: br.accentColor + '1a' }} />
                  <div className="h-3 bg-muted rounded w-3/4" />
                  <div className="h-3 bg-muted rounded w-1/2" />
                </div>
              </div>
            </div>
          </div>

          <div className="mt-4">
            <SaveButton onClick={handleSaveBranding} pending={isPending} saved={saved === 'branding'} />
          </div>
        </Card>
      )}

      {/* ---- Numbering ---- */}
      {tab === 'numbering' && (
        <Card className="p-6">
          <p className="text-sm text-muted-foreground mb-4">
            Prefixes used for all document numbers across the system. These are the single source of truth — the
            accounting and shopping connectors read from here.
          </p>

          {/* Core numbering rows */}
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Core Documents</h3>
          <div className="space-y-1 overflow-x-auto">
            {(() => {
              const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '')
              const year = new Date().getFullYear()
              const rows: {
                label: string
                key: 'so_prefix' | 'po_prefix' | 'inv_prefix' | 'cn_prefix'
                description: string
                example: (prefix: string) => string
              }[] = [
                {
                  label: 'Sales Order',
                  key: 'so_prefix',
                  description: 'Manual IMS sales orders',
                  example: (p) => `${p}${ymd}-A7X2`,
                },
                {
                  label: 'Purchase Order',
                  key: 'po_prefix',
                  description: 'Purchase orders to suppliers',
                  example: (p) => `${p}${ymd}-K3B9`,
                },
                {
                  label: 'Invoice',
                  key: 'inv_prefix',
                  description: 'Accounting invoice number for manual sales orders',
                  example: (p) => `${p}${ymd}-A7X2`,
                },
                {
                  label: 'Credit Note',
                  key: 'cn_prefix',
                  description: 'Refund / credit note numbers',
                  example: (p) => `${p}${year}-00001`,
                },
              ]
              return rows.map((r) => (
                <div key={r.key} className="flex items-center gap-4 py-1.5 border-b border-border/50 last:border-b-0">
                  <div className="w-40 shrink-0">
                    <div className="text-sm font-medium">{r.label}</div>
                    <div className="text-[11px] text-muted-foreground">{r.description}</div>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Prefix</Label>
                    <Input
                      value={num[r.key]}
                      onChange={(e) => setNum((p) => ({ ...p, [r.key]: e.target.value }))}
                      className="h-8 w-32 text-xs font-mono"
                      placeholder="—"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Example</Label>
                    <p className="text-xs font-mono text-muted-foreground pt-1">{r.example(num[r.key])}</p>
                  </div>
                </div>
              ))
            })()}
          </div>

          {/* Per-connector numbering rows */}
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mt-6 mb-2">
            Shopping Connectors
          </h3>
          <p className="text-[11px] text-muted-foreground mb-2">
            Each connector has its own order and invoice prefix so the origin of an imported order is visible in its number.
          </p>
          <div className="space-y-1 overflow-x-auto">
            {shoppingConnectors.map((c) => {
              const cp = num.connectors[c.id] ?? { orderPrefix: '', invPrefix: '' }
              return (
                <div key={c.id} className="flex items-center gap-4 py-1.5 border-b border-border/50 last:border-b-0">
                  <div className="w-40 shrink-0">
                    <div className="text-sm font-medium flex items-center gap-2">
                      {c.label}
                      {!c.available && (
                        <span className="inline-flex items-center rounded-full px-1.5 py-0 text-[10px] font-medium bg-muted text-muted-foreground">
                          Coming soon
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-muted-foreground">Order and invoice numbers for imported orders</div>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Order Prefix</Label>
                    <Input
                      value={cp.orderPrefix}
                      onChange={(e) =>
                        setNum((p) => ({
                          ...p,
                          connectors: { ...p.connectors, [c.id]: { ...cp, orderPrefix: e.target.value } },
                        }))
                      }
                      className="h-8 w-28 text-xs font-mono"
                      placeholder="—"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Invoice Prefix</Label>
                    <Input
                      value={cp.invPrefix}
                      onChange={(e) =>
                        setNum((p) => ({
                          ...p,
                          connectors: { ...p.connectors, [c.id]: { ...cp, invPrefix: e.target.value } },
                        }))
                      }
                      className="h-8 w-28 text-xs font-mono"
                      placeholder="—"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Example</Label>
                    <p className="text-xs font-mono text-muted-foreground pt-1">
                      {cp.orderPrefix}12345 · {cp.invPrefix}12345
                    </p>
                  </div>
                </div>
              )
            })}
          </div>

          <div className="mt-4">
            <SaveButton onClick={handleSaveNumbering} pending={isPending} saved={saved === 'numbering'} />
          </div>
        </Card>
      )}

      {/* ---- Email ---- */}
      {tab === 'email' && (
        <Card className="p-6">
          <p className="text-sm text-muted-foreground mb-4">
            SMTP settings for sending documents (invoices, POs, RFQs) by email.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-lg">
            <div className="space-y-1.5 sm:col-span-2">
              <Label className="text-xs">SMTP Host</Label>
              <Input value={em.smtp_host} onChange={(e) => setEm((p) => ({ ...p, smtp_host: e.target.value }))} className="h-9" placeholder="smtp.example.com" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Port</Label>
              <Input value={em.smtp_port} onChange={(e) => setEm((p) => ({ ...p, smtp_port: e.target.value }))} className="h-9" placeholder="587" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Security</Label>
              <select
                value={em.smtp_secure}
                onChange={(e) => setEm((p) => ({ ...p, smtp_secure: e.target.value }))}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
              >
                <option value="tls">TLS (STARTTLS)</option>
                <option value="ssl">SSL</option>
                <option value="none">None</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Username</Label>
              <Input value={em.smtp_user} onChange={(e) => setEm((p) => ({ ...p, smtp_user: e.target.value }))} className="h-9" autoComplete="off" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Password</Label>
              <Input type="password" value={em.smtp_pass} onChange={(e) => setEm((p) => ({ ...p, smtp_pass: e.target.value }))} className="h-9" autoComplete="off" />
            </div>
            <div className="sm:col-span-2 border-t pt-3 mt-1" />
            <div className="space-y-1.5">
              <Label className="text-xs">From Name</Label>
              <Input value={em.from_name} onChange={(e) => setEm((p) => ({ ...p, from_name: e.target.value }))} className="h-9" placeholder="onetwoInventory" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">From Email</Label>
              <Input type="email" value={em.from_email} onChange={(e) => setEm((p) => ({ ...p, from_email: e.target.value }))} className="h-9" placeholder="accounts@example.com" />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label className="text-xs">Reply-To</Label>
              <Input type="email" value={em.reply_to} onChange={(e) => setEm((p) => ({ ...p, reply_to: e.target.value }))} className="h-9" placeholder="Optional" />
            </div>
            <div className="sm:col-span-2 border-t pt-3 mt-1" />
            <p className="sm:col-span-2 text-xs text-muted-foreground">Department email addresses — shown on documents as the contact for queries.</p>
            <div className="space-y-1.5">
              <Label className="text-xs">Sales Email</Label>
              <Input type="email" value={em.sales_email} onChange={(e) => setEm((p) => ({ ...p, sales_email: e.target.value }))} className="h-9" placeholder="sales@example.com" />
              <p className="text-xs text-muted-foreground">Shown on invoices, sales orders, credit notes, packing slips</p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Purchases Email</Label>
              <Input type="email" value={em.purchases_email} onChange={(e) => setEm((p) => ({ ...p, purchases_email: e.target.value }))} className="h-9" placeholder="purchasing@example.com" />
              <p className="text-xs text-muted-foreground">Shown on purchase orders and RFQs</p>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label className="text-xs">Support Email</Label>
              <Input type="email" value={em.support_email} onChange={(e) => setEm((p) => ({ ...p, support_email: e.target.value }))} className="h-9" placeholder="support@example.com" />
              <p className="text-xs text-muted-foreground">General support contact</p>
            </div>
          </div>
          <div className="mt-4">
            <SaveButton onClick={handleSaveEmail} pending={isPending} saved={saved === 'email'} />
          </div>
        </Card>
      )}

      {/* ---- Document Templates ---- */}
      {tab === 'documents' && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Customise header notes, footer text, terms, and display options for each document type.
          </p>
          {tpls.map((tpl) => {
            const isEditing = editingTpl === tpl.type
            return (
              <Card key={tpl.type} className="p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-medium">{TEMPLATE_LABELS[tpl.type] ?? tpl.type}</h3>
                  {!isEditing ? (
                    <div className="flex items-center gap-2">
                      <Button variant="outline" size="sm" className="text-xs h-7" onClick={() => window.open(`/api/preview/document?type=${tpl.type}&t=${Date.now()}`, '_blank')}>
                        <Eye className="h-3 w-3 mr-1" />PDF
                      </Button>
                      <Button variant="outline" size="sm" className="text-xs h-7" onClick={() => window.open(`/api/preview/email?type=${tpl.type}&t=${Date.now()}`, '_blank')}>
                        <Mail className="h-3 w-3 mr-1" />Email
                      </Button>
                      <Button variant="outline" size="sm" className="text-xs h-7" onClick={() => setEditingTpl(tpl.type)}>
                        Edit
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <Button variant="outline" size="sm" className="text-xs h-7" onClick={() => window.open(`/api/preview/document?type=${tpl.type}&t=${Date.now()}`, '_blank')}>
                        <Eye className="h-3 w-3 mr-1" />PDF
                      </Button>
                      <Button variant="outline" size="sm" className="text-xs h-7" onClick={() => window.open(`/api/preview/email?type=${tpl.type}&t=${Date.now()}`, '_blank')}>
                        <Mail className="h-3 w-3 mr-1" />Email
                      </Button>
                      <Button size="sm" className="text-xs h-7" onClick={() => handleSaveTemplate(tpl.type)} disabled={isPending}>
                        {isPending && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}Save
                      </Button>
                      <Button variant="ghost" size="sm" className="text-xs h-7" onClick={() => setEditingTpl(null)}>Cancel</Button>
                      {saved === `tpl-${tpl.type}` && <Check className="h-4 w-4 text-green-600" />}
                    </div>
                  )}
                </div>

                {isEditing ? (
                  <div className="space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label className="text-xs">Header Note</Label>
                        <Textarea
                          value={tpl.headerNote}
                          onChange={(e) => updateTpl(tpl.type, 'headerNote', e.target.value)}
                          className="text-xs min-h-[60px]"
                          placeholder="Text shown above the table"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">Footer Note</Label>
                        <Textarea
                          value={tpl.footerNote}
                          onChange={(e) => updateTpl(tpl.type, 'footerNote', e.target.value)}
                          className="text-xs min-h-[60px]"
                          placeholder="Text shown below the table"
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label className="text-xs">Terms &amp; Conditions</Label>
                        <Textarea
                          value={tpl.termsText}
                          onChange={(e) => updateTpl(tpl.type, 'termsText', e.target.value)}
                          className="text-xs min-h-[60px]"
                          placeholder="Terms and conditions text"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">Custom Page Footer</Label>
                        <Textarea
                          value={tpl.customFooter}
                          onChange={(e) => updateTpl(tpl.type, 'customFooter', e.target.value)}
                          className="text-xs min-h-[60px]"
                          placeholder="Free text printed at the bottom of every page (e.g. registered address, company number)"
                        />
                      </div>
                    </div>
                    <div className="flex items-center gap-6">
                      <label className="flex items-center gap-2 text-xs">
                        <Switch checked={tpl.showLogo} onCheckedChange={(v) => updateTpl(tpl.type, 'showLogo', v)} />
                        Show Logo
                      </label>
                      <label className="flex items-center gap-2 text-xs">
                        <Switch checked={tpl.showVat} onCheckedChange={(v) => updateTpl(tpl.type, 'showVat', v)} />
                        Show VAT
                      </label>
                      <label className="flex items-center gap-2 text-xs">
                        <Switch checked={tpl.showPaymentTerms} onCheckedChange={(v) => updateTpl(tpl.type, 'showPaymentTerms', v)} />
                        Show Payment Terms
                      </label>
                    </div>
                    {tpl.showPaymentTerms && (
                      <div className="space-y-1.5 max-w-xs">
                        <Label className="text-xs">Payment Terms Text</Label>
                        <Input
                          value={tpl.paymentTermsText}
                          onChange={(e) => updateTpl(tpl.type, 'paymentTermsText', e.target.value)}
                          className="h-8 text-xs"
                          placeholder="e.g. Net 30 days"
                        />
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-xs text-muted-foreground space-y-0.5">
                    {tpl.headerNote && <p>Header: {tpl.headerNote.slice(0, 80)}{tpl.headerNote.length > 80 ? '...' : ''}</p>}
                    {tpl.footerNote && <p>Footer: {tpl.footerNote.slice(0, 80)}{tpl.footerNote.length > 80 ? '...' : ''}</p>}
                    {tpl.termsText && <p>Terms: {tpl.termsText.slice(0, 80)}{tpl.termsText.length > 80 ? '...' : ''}</p>}
                    {tpl.customFooter && <p>Page footer: {tpl.customFooter.slice(0, 80)}{tpl.customFooter.length > 80 ? '...' : ''}</p>}
                    <div className="flex gap-3 mt-1">
                      {tpl.showLogo && <span className="text-green-600">Logo ✓</span>}
                      {tpl.showVat && <span className="text-green-600">VAT ✓</span>}
                      {tpl.showPaymentTerms && <span className="text-green-600">Payment Terms ✓</span>}
                    </div>
                    {!tpl.headerNote && !tpl.footerNote && !tpl.termsText && <p className="italic">No customisations — using defaults</p>}
                  </div>
                )}
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}

function SaveButton({ onClick, pending, saved }: { onClick: () => void; pending: boolean; saved: boolean }) {
  return (
    <div className="fixed bottom-4 right-4 sm:bottom-6 sm:right-6 z-50">
      <div className="flex items-center gap-2 rounded-lg border bg-background/95 backdrop-blur shadow-lg px-4 py-2.5">
        <Button size="sm" onClick={onClick} disabled={pending}>
          {pending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
          Save Changes
        </Button>
        {saved && (
          <span className="text-sm text-green-600 flex items-center gap-1">
            <Check className="h-3 w-3" />Saved
          </span>
        )}
      </div>
    </div>
  )
}
