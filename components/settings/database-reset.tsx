'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { useStepUpReauth } from '@/components/auth/use-step-up-reauth'
import { resetDatabase, type ResetLevel } from '@/app/actions/reset'

const LEVELS: { key: ResetLevel; label: string; description: string; items: string[] }[] = [
  {
    key: 'transactions',
    label: 'Reset Transactions Only',
    description: 'Deletes all orders, purchases, stock movements, invoices, payments, and receipts. Keeps products, suppliers, customers, warehouses, and settings.',
    items: ['Sales orders + lines + refunds + payments', 'Purchase orders + lines + receipts + returns + invoices', 'Stock movements + levels + cost layers + COGS entries', 'Stock transfers', 'Sync logs + activity logs'],
  },
  {
    key: 'products',
    label: 'Reset Transactions + Products',
    description: 'Everything above, plus all products, BOMs, kits, variants, suppliers, and customers.',
    items: ['Everything in "Transactions Only"', 'All products (including variants, BOMs, kits)', 'Product components + options', 'Suppliers + supplier products', 'Customers'],
  },
  {
    key: 'full',
    label: 'Full Database Reset',
    description: 'Resets everything except user accounts. This is irreversible.',
    items: ['Everything in "Transactions + Products"', 'Warehouses', 'Currencies + FX rates', 'Tax rates', 'Purchase units', 'Adjustment reasons', 'All settings', 'Organisation details', 'Note: user accounts are preserved'],
  },
]

export function DatabaseReset() {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [showDialog, setShowDialog] = useState(false)
  const [selectedLevel, setSelectedLevel] = useState<ResetLevel | null>(null)
  const [confirmation, setConfirmation] = useState('')
  const [emailCode, setEmailCode] = useState('')
  const [codeStatus, setCodeStatus] = useState<string | null>(null)
  const [sendingCode, setSendingCode] = useState(false)
  const [result, setResult] = useState<{ message: string; isError: boolean } | null>(null)
  const { promptReauth, stepUpDialog } = useStepUpReauth()

  const level = LEVELS.find((l) => l.key === selectedLevel)
  const confirmText = selectedLevel === 'full' ? 'RESET EVERYTHING' : selectedLevel === 'products' ? 'RESET PRODUCTS' : 'RESET TRANSACTIONS'
  const isConfirmed = confirmation === confirmText

  async function requestResetCode(): Promise<{ ok: boolean; status: number; data: { email?: string; error?: string; code?: string } }> {
    const res = await fetch('/api/reset/code')
    const data = await res.json().catch(() => ({}))
    return { ok: res.ok, status: res.status, data }
  }

  async function handleSendCode() {
    setSendingCode(true)
    setCodeStatus(null)
    try {
      let attempt = await requestResetCode()
      // The endpoint requires a fresh admin session; on staleness it returns
      // 403 {code:'fresh_auth_required'}. Prompt step-up re-auth and retry once.
      if (!attempt.ok && attempt.status === 403 && attempt.data.code === 'fresh_auth_required') {
        if (await promptReauth()) {
          attempt = await requestResetCode()
        } else {
          setCodeStatus('Re-authentication is required to send the confirmation code.')
          return
        }
      }
      if (attempt.ok) {
        setCodeStatus(`Confirmation code emailed to ${attempt.data.email}.`)
      } else {
        setCodeStatus(attempt.data.error ?? 'Failed to send confirmation code.')
      }
    } catch {
      setCodeStatus('Failed to send confirmation code.')
    } finally {
      setSendingCode(false)
    }
  }

  function handleReset() {
    if (!selectedLevel || !isConfirmed || emailCode.trim().length < 6) return
    setResult(null)
    startTransition(async () => {
      const r = await resetDatabase(selectedLevel, emailCode.trim().toUpperCase())
      if (r.success) {
        setResult({ message: 'Database has been reset successfully.', isError: false })
        setShowDialog(false)
        setConfirmation('')
        setEmailCode('')
        setCodeStatus(null)
        setSelectedLevel(null)
        router.refresh()
      } else {
        setResult({ message: r.error ?? 'Reset failed', isError: true })
      }
    })
  }

  return (
    <div className="space-y-4">
      {stepUpDialog}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {LEVELS.map((l) => (
          <div key={l.key} className={`rounded-md border p-4 flex flex-col ${l.key === 'full' ? 'border-destructive/50' : ''}`}>
            <h3 className="text-sm font-medium">{l.label}</h3>
            <p className="text-xs text-muted-foreground mt-2">{l.description}</p>
            <ul className="text-xs text-muted-foreground space-y-0.5 list-disc pl-4 mt-2">
              {l.items.map((item, i) => <li key={i}>{item}</li>)}
            </ul>
            <div className="mt-auto pt-4">
              <Button
                variant={l.key === 'full' ? 'destructive' : 'outline'}
                size="sm"
                className="w-full"
                onClick={() => {
                  setSelectedLevel(l.key)
                  setShowDialog(true)
                  setConfirmation('')
                  setEmailCode('')
                  setCodeStatus(null)
                  setResult(null)
                  void handleSendCode()
                }}
              >
                {l.label}
              </Button>
            </div>
          </div>
        ))}
      </div>

      {result && (
        <p className={`text-sm ${result.isError ? 'text-destructive' : 'text-green-600'}`}>{result.message}</p>
      )}

      {showDialog && level && (
        <Dialog open onOpenChange={() => {}}>
          <DialogContent showCloseButton={false} className="max-w-md sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-5 w-5" />
                {level.label}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm">
                <p className="font-medium text-destructive">This action is irreversible.</p>
                <p className="text-muted-foreground mt-1">{level.description}</p>
              </div>
              <div className="space-y-1.5">
                <Label>Type <code className="text-xs bg-muted px-1 rounded font-bold">{confirmText}</code> to confirm</Label>
                <Input
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                  placeholder={confirmText}
                  className="h-9 font-mono text-sm"
                  autoFocus
                />
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <Label>Email confirmation code</Label>
                  <Button type="button" variant="outline" size="sm" onClick={() => void handleSendCode()} disabled={sendingCode || isPending}>
                    {sendingCode ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Resend code'}
                  </Button>
                </div>
                <Input
                  value={emailCode}
                  onChange={(e) => setEmailCode(e.target.value.replace(/[^a-fA-F0-9]/g, '').slice(0, 8).toUpperCase())}
                  placeholder="Email code"
                  className="h-9 font-mono text-sm tracking-[0.3em]"
                />
                {codeStatus && (
                  <p className="text-xs text-muted-foreground">{codeStatus}</p>
                )}
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => { setShowDialog(false); setConfirmation(''); setEmailCode(''); setCodeStatus(null) }} disabled={isPending}>Cancel</Button>
              <Button variant="destructive" onClick={handleReset} disabled={isPending || !isConfirmed || emailCode.trim().length < 6}>
                {isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Confirm Reset
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
