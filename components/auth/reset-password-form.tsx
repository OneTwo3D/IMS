'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

import { Button } from '@/components/ui/button'
import { buttonVariants } from '@/components/ui/button-variants'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent } from '@/components/ui/card'
import { Alert } from '@/components/ui/alert'
import { Loader2 } from 'lucide-react'
import { resetPassword } from '@/app/actions/password-reset'
import { MIN_PASSWORD_LENGTH } from '@/lib/security/password-policy'

export function ResetPasswordForm({ token }: { token: string }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  // The token arrives in the URL query but is already held in `token` here. Strip it from
  // the address bar after mount so it can't leak via Referer headers, browser history, or
  // shoulder-surfing while the user fills in the form.
  useEffect(() => {
    if (token && typeof window !== 'undefined') {
      window.history.replaceState(null, '', '/reset-password')
    }
  }, [token])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }
    setLoading(true)
    try {
      const result = await resetPassword(token, password)
      if (result.success) {
        setDone(true)
      } else {
        setError(result.error)
      }
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  if (done) {
    return (
      <Card>
        <CardContent className="flex flex-col gap-4 pt-6">
          <Alert className="text-sm py-2 px-3">
            Your password has been updated. You can now sign in with your new password.
          </Alert>
          <Link href="/login" className={buttonVariants({ className: 'w-full' })}>
            Go to sign in
          </Link>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardContent className="pt-6">
        {!token ? (
          <div className="flex flex-col gap-4">
            <Alert variant="destructive" className="text-sm py-2 px-3">
              This reset link is invalid. Please request a new one.
            </Alert>
            <Link href="/forgot-password" className={buttonVariants({ variant: 'outline', className: 'w-full' })}>
              Request a new link
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            {error && (
              <Alert variant="destructive" className="text-sm py-2 px-3">
                {error}
              </Alert>
            )}

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password">New password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
              />
              <p className="text-xs text-muted-foreground">
                At least {MIN_PASSWORD_LENGTH} characters, with an uppercase letter, a number, and a symbol.
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="confirm">Confirm new password</Label>
              <Input
                id="confirm"
                type="password"
                autoComplete="new-password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="••••••••••••"
              />
            </div>

            <Button type="submit" disabled={loading} className="w-full">
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Update password
            </Button>

            <div className="text-center text-sm">
              <Link href="/login" className="text-muted-foreground hover:text-foreground underline-offset-4 hover:underline">
                Back to sign in
              </Link>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  )
}
