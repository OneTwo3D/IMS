'use client'

import { useState } from 'react'
import Image from 'next/image'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Loader2, ShieldCheck, ShieldOff } from 'lucide-react'

type Step = 'idle' | 'setup' | 'confirm' | 'disable'

interface TotpSetupProps {
  enabled: boolean
}

export function TotpSetup({ enabled }: TotpSetupProps) {
  const [step, setStep] = useState<Step>('idle')
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [secret, setSecret] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState('')

  async function startSetup() {
    setLoading(true)
    setError('')
    const res = await fetch('/api/auth/totp-setup')
    const data = await res.json()
    setLoading(false)
    if (!res.ok) { setError(data.error); return }
    setQrDataUrl(data.qrDataUrl)
    setSecret(data.secret)
    setStep('setup')
  }

  async function confirmSetup() {
    setLoading(true)
    setError('')
    const res = await fetch('/api/auth/totp-setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    const data = await res.json()
    setLoading(false)
    if (!res.ok) { setError(data.error); return }
    setSuccess('Two-factor authentication has been enabled.')
    setStep('idle')
    setCode('')
    // Reload to update session
    window.location.reload()
  }

  async function disableTotp() {
    setLoading(true)
    setError('')
    const res = await fetch('/api/auth/totp-setup', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    const data = await res.json()
    setLoading(false)
    if (!res.ok) { setError(data.error); return }
    setSuccess('Two-factor authentication has been disabled.')
    setStep('idle')
    setCode('')
    window.location.reload()
  }

  return (
    <div className="rounded-lg border p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Two-factor authentication</h2>
        <Badge variant={enabled ? 'default' : 'secondary'}>
          {enabled ? 'Enabled' : 'Disabled'}
        </Badge>
      </div>

      {success && (
        <Alert className="text-sm py-2 px-3 text-green-700 border-green-200 bg-green-50 dark:text-green-400 dark:border-green-900 dark:bg-green-950">
          {success}
        </Alert>
      )}
      {error && (
        <Alert variant="destructive" className="text-sm py-2 px-3">{error}</Alert>
      )}

      {step === 'idle' && !enabled && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Add an extra layer of security. You&apos;ll need an authenticator app
            such as Google Authenticator, Authy, or 1Password.
          </p>
          <Button onClick={startSetup} disabled={loading} size="sm">
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            <ShieldCheck className="mr-2 h-4 w-4" />
            Enable 2FA
          </Button>
        </div>
      )}

      {step === 'idle' && enabled && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Two-factor authentication is active. Your account is protected.
          </p>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => { setStep('disable'); setCode(''); setError('') }}
          >
            <ShieldOff className="mr-2 h-4 w-4" />
            Disable 2FA
          </Button>
        </div>
      )}

      {step === 'setup' && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Scan this QR code with your authenticator app, then enter the 6-digit
            code to confirm.
          </p>
          {qrDataUrl && (
            <div className="flex justify-center">
              <Image src={qrDataUrl} alt="2FA QR code" width={180} height={180} />
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="totp-confirm">Verification code</Label>
            <Input
              id="totp-confirm"
              type="text"
              inputMode="numeric"
              maxLength={6}
              placeholder="000000"
              className="text-center tracking-widest text-xl max-w-[160px]"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            />
          </div>
          <div className="flex gap-2">
            <Button
              onClick={confirmSetup}
              disabled={loading || code.length !== 6}
              size="sm"
            >
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Confirm &amp; Enable
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setStep('idle')}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {step === 'disable' && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Enter the code from your authenticator app to confirm disabling 2FA.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="totp-disable">Verification code</Label>
            <Input
              id="totp-disable"
              type="text"
              inputMode="numeric"
              maxLength={6}
              placeholder="000000"
              className="text-center tracking-widest text-xl max-w-[160px]"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            />
          </div>
          <div className="flex gap-2">
            <Button
              variant="destructive"
              onClick={disableTotp}
              disabled={loading || code.length !== 6}
              size="sm"
            >
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Disable 2FA
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setStep('idle')}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
