'use client'

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Building2, Camera, Loader2, Upload, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { updateOrganisation, type OrganisationData } from '@/app/actions/company'

export type CompanyStepHandle = {
  save: () => Promise<boolean>
}

type Props = {
  org: OrganisationData
  onSaved: () => void
  onReadyChange?: (ready: boolean) => void
}

function hasCompanyDraftChanges(current: OrganisationData, initial: OrganisationData, logoUrl: string | null) {
  return (
    current.name !== initial.name ||
    current.legalName !== initial.legalName ||
    current.vatNumber !== initial.vatNumber ||
    current.companyNumber !== initial.companyNumber ||
    current.addressLine1 !== initial.addressLine1 ||
    current.addressLine2 !== initial.addressLine2 ||
    current.city !== initial.city ||
    current.county !== initial.county ||
    current.postcode !== initial.postcode ||
    current.country !== initial.country ||
    current.phone !== initial.phone ||
    current.email !== initial.email ||
    current.website !== initial.website ||
    logoUrl !== initial.logoUrl
  )
}

export const CompanyStep = forwardRef<CompanyStepHandle, Props>(function CompanyStep({
  org: initialOrg,
  onSaved,
  onReadyChange,
}, ref) {
  const router = useRouter()
  const [co, setCo] = useState(initialOrg)
  const [logoUrl, setLogoUrl] = useState(initialOrg.logoUrl)
  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setCo(initialOrg)
    setLogoUrl(initialOrg.logoUrl)
  }, [initialOrg])

  useEffect(() => {
    onReadyChange?.(hasCompanyDraftChanges(co, initialOrg, logoUrl))
  }, [co, initialOrg, logoUrl, onReadyChange])

  function field(key: keyof OrganisationData, label: string, opts?: { type?: string; span?: number }) {
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

  async function handleLogoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    try {
      const form = new FormData()
      form.append('file', file)
      form.append('type', 'icon')
      const res = await fetch('/api/upload/logo', { method: 'POST', body: form })
      if (!res.ok) throw new Error('Upload failed')
      const { url } = await res.json()
      setLogoUrl(url)
    } catch {
      setError('Logo upload failed')
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function handleSave() {
    setError('')
    setSaving(true)
    try {
      const result = await updateOrganisation({ ...co, logoUrl })
      if (!result.success) {
        setError(result.error ?? 'Failed to save')
        return false
      }
      router.refresh()
      onSaved()
      return true
    } finally {
      setSaving(false)
    }
  }

  useImperativeHandle(ref, () => ({ save: handleSave }), [co, logoUrl, onSaved, router])

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Company Details</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Enter your company information. This will appear on invoices, purchase orders, and other documents.
        </p>
      </div>

      {/* Logo */}
      <div>
        <Label className="text-xs">Company Logo</Label>
        <div className="flex items-center gap-4 mt-2">
          <div className="relative group h-16 w-16 rounded-lg border bg-muted flex items-center justify-center overflow-hidden">
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoUrl} alt="Logo" className="h-full w-full object-contain" />
            ) : (
              <Building2 className="h-6 w-6 text-muted-foreground" />
            )}
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
              disabled={uploading}
            >
              {uploading ? <Loader2 className="h-4 w-4 text-white animate-spin" /> : <Camera className="h-4 w-4 text-white" />}
            </button>
            <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/svg+xml" className="hidden" onChange={handleLogoUpload} />
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="text-xs h-8" onClick={() => fileRef.current?.click()} disabled={uploading}>
              <Upload className="h-3 w-3 mr-1" />{logoUrl ? 'Change' : 'Upload'}
            </Button>
            {logoUrl && (
              <Button variant="ghost" size="sm" className="text-xs h-8 text-destructive" onClick={() => setLogoUrl(null)}>
                <Trash2 className="h-3 w-3" />
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Fields */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {field('name', 'Company Name', { span: 2 })}
        {field('legalName', 'Legal Name')}
        {field('vatNumber', 'VAT Number')}
        {field('companyNumber', 'Company Number')}
        {field('addressLine1', 'Address Line 1', { span: 2 })}
        {field('addressLine2', 'Address Line 2', { span: 2 })}
        {field('city', 'City')}
        {field('county', 'County / State')}
        {field('postcode', 'Postcode / ZIP')}
        {field('country', 'Country')}
        {field('phone', 'Phone', { type: 'tel' })}
        {field('email', 'Email', { type: 'email' })}
        {field('website', 'Website', { type: 'url' })}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      <p className="text-xs text-muted-foreground">Your changes will be saved when you continue.</p>
    </div>
  )
})
