'use client'

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Building2, Camera, Check, Loader2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CountrySelect } from '@/components/ui/country-select'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { updateOrganisation, saveEmailSettings, sendTestEmailSettings, type EmailSettings, type OrganisationData } from '@/app/actions/company'
import { setSetting } from '@/app/actions/settings'
import { syncCrontab } from '@/app/actions/cron'
import type { PublicAppUrlInfo } from '@/lib/public-app-url'

export type CompanyStepHandle = {
  save: () => Promise<boolean>
}

type Props = {
  org: OrganisationData
  emailSettings: EmailSettings
  publicAppUrlInfo: PublicAppUrlInfo
  suggestedPublicAppUrl: string | null
  testEmailDefault: string
  onSaved: () => void
  onDirtyChange?: (dirty: boolean) => void
}

function hasCompanyDraftChanges(
  current: OrganisationData,
  initial: OrganisationData,
  logoUrl: string | null,
  publicAppUrl: string,
  initialPublicAppUrl: string,
  emailSettings: EmailSettings,
  initialEmailSettings: EmailSettings,
) {
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
    logoUrl !== initial.logoUrl ||
    publicAppUrl !== initialPublicAppUrl ||
    Object.keys(emailSettings).some((key) => {
      const typedKey = key as keyof EmailSettings
      return emailSettings[typedKey] !== initialEmailSettings[typedKey]
    })
  )
}

export const CompanyStep = forwardRef<CompanyStepHandle, Props>(function CompanyStep({
  org: initialOrg,
  emailSettings: initialEmailSettings,
  publicAppUrlInfo,
  suggestedPublicAppUrl,
  testEmailDefault,
  onSaved,
  onDirtyChange,
}, ref) {
  const router = useRouter()
  const [co, setCo] = useState(initialOrg)
  const [logoUrl, setLogoUrl] = useState(initialOrg.logoUrl)
  const [publicAppUrl, setPublicAppUrl] = useState(publicAppUrlInfo.value ?? '')
  const [emailSettings, setEmailSettings] = useState(initialEmailSettings)
  const [testEmail, setTestEmail] = useState(testEmailDefault)
  const [isTestingEmail, setIsTestingEmail] = useState(false)
  const [emailTestResult, setEmailTestResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setCo(initialOrg)
    setLogoUrl(initialOrg.logoUrl)
  }, [initialOrg])

  useEffect(() => {
    setPublicAppUrl(publicAppUrlInfo.value ?? '')
  }, [publicAppUrlInfo])

  useEffect(() => {
    setEmailSettings(initialEmailSettings)
  }, [initialEmailSettings])

  useEffect(() => {
    setTestEmail(testEmailDefault)
  }, [testEmailDefault])

  useEffect(() => {
    onDirtyChange?.(
      hasCompanyDraftChanges(
        co,
        initialOrg,
        logoUrl,
        publicAppUrl,
        publicAppUrlInfo.value ?? '',
        emailSettings,
        initialEmailSettings,
      ),
    )
  }, [co, emailSettings, initialEmailSettings, initialOrg, logoUrl, onDirtyChange, publicAppUrl, publicAppUrlInfo.value])

  function field(key: keyof OrganisationData, label: string, opts?: { type?: string; span?: number }) {
    return (
      <div className={`space-y-1.5 ${opts?.span === 2 ? 'sm:col-span-2' : ''}`}>
        <Label className="text-xs">{label}</Label>
        {key === 'country' ? (
          <CountrySelect
            value={co.country}
            onChange={(value) => setCo((p) => ({ ...p, country: value }))}
            allowBlank={false}
            className="h-9"
          />
        ) : (
          <Input
            type={opts?.type ?? 'text'}
            value={(co[key] as string) ?? ''}
            onChange={(e) => setCo((p) => ({ ...p, [key]: e.target.value || null }))}
            className="h-9"
          />
        )}
      </div>
    )
  }

  function updateEmailField<K extends keyof EmailSettings>(key: K, value: EmailSettings[K]) {
    setEmailSettings((prev) => ({ ...prev, [key]: value }))
  }

  function normalizePublicAppUrl(value: string): string | null {
    const normalized = value.trim().replace(/\/+$/, '')
    if (!normalized) return null

    try {
      const parsed = new URL(normalized)
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        setError('Public App URL must start with http:// or https://')
        return null
      }
      return normalized
    } catch {
      setError('Enter a valid Public App URL.')
      return null
    }
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

  async function handleTestEmail() {
    setError('')
    setEmailTestResult(null)

    if (!testEmail.trim()) {
      setEmailTestResult({ type: 'error', message: 'Enter a test email recipient.' })
      return
    }

    setIsTestingEmail(true)
    try {
      const result = await sendTestEmailSettings(emailSettings, testEmail.trim())
      if (!result.success) {
        setEmailTestResult({ type: 'error', message: result.error ?? 'Failed to send test email.' })
        return
      }
      setEmailTestResult({ type: 'success', message: result.message ?? `Test email sent to ${testEmail.trim()}.` })
    } catch (cause) {
      setEmailTestResult({
        type: 'error',
        message: cause instanceof Error ? cause.message : 'Failed to send test email.',
      })
    } finally {
      setIsTestingEmail(false)
    }
  }

  const handleSave = useCallback(async function handleSave() {
    setError('')
    try {
      const normalizedPublicAppUrl = publicAppUrl.trim() ? normalizePublicAppUrl(publicAppUrl) : null
      if (publicAppUrl.trim() && !normalizedPublicAppUrl) {
        return false
      }

      const result = await updateOrganisation({ ...co, logoUrl })
      if (!result.success) {
        setError(result.error ?? 'Failed to save')
        return false
      }

      const emailResult = await saveEmailSettings(emailSettings)
      if (!emailResult.success) {
        setError('Failed to save email settings.')
        return false
      }

      if (normalizedPublicAppUrl) {
        await setSetting('public_app_url', normalizedPublicAppUrl)
        const cronResult = await syncCrontab()
        if (!cronResult.success) {
          setError(cronResult.error ?? 'Failed to apply Public App URL changes.')
          return false
        }
      }

      router.refresh()
      onSaved()
      return true
    } catch {
      setError('Failed to save')
      return false
    }
  }, [co, emailSettings, logoUrl, onSaved, publicAppUrl, router])

  useImperativeHandle(ref, () => ({ save: handleSave }), [handleSave])

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

      <div className="space-y-4 rounded-lg border p-4">
        <div>
          <h3 className="text-sm font-medium">Public App URL</h3>
          <p className="text-xs text-muted-foreground mt-1">
            Used for Xero and QuickBooks callbacks, webhooks, and scheduled jobs.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Public App URL</Label>
          <Input
            value={publicAppUrl}
            onChange={(e) => setPublicAppUrl(e.target.value)}
            placeholder={suggestedPublicAppUrl ?? 'https://ims.example.com'}
            className="h-9 font-mono"
            autoComplete="off"
          />
        </div>
        {!publicAppUrlInfo.value && suggestedPublicAppUrl ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>Suggested: {suggestedPublicAppUrl}</span>
            <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setPublicAppUrl(suggestedPublicAppUrl)}>
              Use Suggested URL
            </Button>
          </div>
        ) : null}
      </div>

      <div className="space-y-4 rounded-lg border p-4">
        <div>
          <h3 className="text-sm font-medium">Email Settings</h3>
          <p className="text-xs text-muted-foreground mt-1">
            Optional SMTP setup for invoices, purchase orders, and other document emails.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5 sm:col-span-2">
            <Label className="text-xs">SMTP Host</Label>
            <Input value={emailSettings.smtp_host} onChange={(e) => updateEmailField('smtp_host', e.target.value)} className="h-9" placeholder="smtp.yourdomain.com" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Port</Label>
            <Input value={emailSettings.smtp_port} onChange={(e) => updateEmailField('smtp_port', e.target.value)} className="h-9" placeholder="587" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Security</Label>
            <select
              value={emailSettings.smtp_secure}
              onChange={(e) => updateEmailField('smtp_secure', e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
            >
              <option value="tls">TLS (STARTTLS)</option>
              <option value="ssl">SSL</option>
              <option value="none">None</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Username</Label>
            <Input value={emailSettings.smtp_user} onChange={(e) => updateEmailField('smtp_user', e.target.value)} className="h-9" autoComplete="off" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Password</Label>
            <Input type="password" value={emailSettings.smtp_pass} onChange={(e) => updateEmailField('smtp_pass', e.target.value)} className="h-9" autoComplete="off" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">From Name</Label>
            <Input value={emailSettings.from_name} onChange={(e) => updateEmailField('from_name', e.target.value)} className="h-9" placeholder="onetwoInventory" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">From Email</Label>
            <Input type="email" value={emailSettings.from_email} onChange={(e) => updateEmailField('from_email', e.target.value)} className="h-9" placeholder="accounts@yourdomain.com" />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label className="text-xs">Reply-To</Label>
            <Input type="email" value={emailSettings.reply_to} onChange={(e) => updateEmailField('reply_to', e.target.value)} className="h-9" placeholder="Optional" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Sales Email</Label>
            <Input type="email" value={emailSettings.sales_email} onChange={(e) => updateEmailField('sales_email', e.target.value)} className="h-9" placeholder="sales@yourdomain.com" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Purchases Email</Label>
            <Input type="email" value={emailSettings.purchases_email} onChange={(e) => updateEmailField('purchases_email', e.target.value)} className="h-9" placeholder="purchasing@yourdomain.com" />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label className="text-xs">Support Email</Label>
            <Input type="email" value={emailSettings.support_email} onChange={(e) => updateEmailField('support_email', e.target.value)} className="h-9" placeholder="support@yourdomain.com" />
          </div>
        </div>

        <div className="space-y-3 border-t pt-4">
          <div className="space-y-1.5">
            <Label className="text-xs">Test Email Recipient</Label>
            <Input type="email" value={testEmail} onChange={(e) => setTestEmail(e.target.value)} className="h-9 max-w-md" placeholder="you@yourdomain.com" />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="outline" size="sm" onClick={handleTestEmail} disabled={isTestingEmail}>
              {isTestingEmail ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
              Test SMTP
            </Button>
            {emailTestResult?.type === 'success' ? <Check className="h-4 w-4 text-green-600" /> : null}
            {emailTestResult ? (
              <p className={`text-xs ${emailTestResult.type === 'success' ? 'text-green-600' : 'text-destructive'}`}>
                {emailTestResult.message}
              </p>
            ) : null}
          </div>
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      <p className="text-xs text-muted-foreground">Your changes will be saved when you continue.</p>
    </div>
  )
})
