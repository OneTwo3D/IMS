'use client'

import { useCallback, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'
import { Loader2, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert } from '@/components/ui/alert'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

// Re-export the pure detection helper so callers can keep a single import.
export { isFreshAuthFailure, type MaybeFreshAuthFailure } from '@/lib/auth/fresh-auth-result'

/**
 * audit-ohou: step-up re-authentication. Many mutating server actions require a
 * "fresh" session (re-auth within the last 15 min). When one returns the
 * fresh_auth_required failure, call `promptReauth()` — it opens a modal that
 * re-verifies the user's password (and TOTP if enabled), refreshes
 * sessionAuthTime in place via session.update({ _stepUpToken }), and resolves
 * true so the caller can retry the original action. Resolves false if cancelled.
 *
 * Usage:
 *   const { promptReauth, stepUpDialog } = useStepUpReauth()
 *   ...
 *   let result = await someGatedAction(args)
 *   if (isFreshAuthFailure(result) && await promptReauth()) {
 *     result = await someGatedAction(args) // retry once, now fresh
 *   }
 *   ...
 *   return (<>{stepUpDialog}{rest}</>)
 */
export function useStepUpReauth() {
  const { data: session, update } = useSession()
  const totpEnabled = Boolean(session?.user?.totpEnabled)

  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const resolverRef = useRef<((ok: boolean) => void) | null>(null)

  const promptReauth = useCallback((): Promise<boolean> => {
    setPassword('')
    setCode('')
    setError('')
    setBusy(false)
    setOpen(true)
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve
    })
  }, [])

  const settle = useCallback((ok: boolean) => {
    setOpen(false)
    const resolve = resolverRef.current
    resolverRef.current = null
    resolve?.(ok)
  }, [])

  const handleOpenChange = useCallback((next: boolean) => {
    // Closing the dialog (Esc / backdrop / cancel) counts as "not re-authed".
    if (!next && !busy) settle(false)
  }, [busy, settle])

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const res = await fetch('/api/auth/step-up', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, code: totpEnabled ? code : undefined }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data?.success) {
        setError(data?.error ?? 'Re-authentication failed.')
        setBusy(false)
        return
      }
      // Refresh sessionAuthTime in place using the server-issued one-time token.
      await update({ _stepUpToken: data.stepUpToken })
      setBusy(false)
      settle(true)
    } catch {
      setError('Re-authentication failed. Please try again.')
      setBusy(false)
    }
  }, [password, code, totpEnabled, update, settle])

  const stepUpDialog = (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            Confirm it&apos;s you
          </DialogTitle>
          <DialogDescription>
            For security, please re-enter your password to continue. This is required
            when changing sensitive settings.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <Alert variant="destructive" className="text-sm py-2 px-3">
              {error}
            </Alert>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="step-up-password">Password</Label>
            <Input
              id="step-up-password"
              type="password"
              autoComplete="current-password"
              autoFocus
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {totpEnabled && (
            <div className="space-y-1.5">
              <Label htmlFor="step-up-code">Authenticator code</Label>
              <Input
                id="step-up-code"
                type="text"
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                autoComplete="one-time-code"
                required
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="000000"
                className="text-center text-lg tracking-widest"
              />
            </div>
          )}
          <DialogFooter className="gap-2 sm:gap-2">
            <Button type="button" variant="ghost" onClick={() => settle(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !password || (totpEnabled && code.length !== 6)}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Confirm
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )

  return { promptReauth, stepUpDialog }
}
