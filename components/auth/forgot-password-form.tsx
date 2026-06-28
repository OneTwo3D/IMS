'use client'

import { useState } from 'react'
import Link from 'next/link'

import { Button } from '@/components/ui/button'
import { buttonVariants } from '@/components/ui/button-variants'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent } from '@/components/ui/card'
import { Alert } from '@/components/ui/alert'
import { Loader2 } from 'lucide-react'
import { requestPasswordReset } from '@/app/actions/password-reset'

export function ForgotPasswordForm() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const result = await requestPasswordReset(email)
      if (result.success) {
        setSent(true)
      } else {
        setError(result.error)
      }
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card>
      <CardContent className="pt-6">
        {sent ? (
          <div className="flex flex-col gap-4">
            <Alert className="text-sm py-2 px-3">
              If an account exists for that email, a password reset link is on its way. The link
              expires in 60 minutes.
            </Alert>
            <Link href="/login" className={buttonVariants({ variant: 'outline', className: 'w-full' })}>
              Back to sign in
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
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </div>

            <Button type="submit" disabled={loading} className="w-full">
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Send reset link
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
