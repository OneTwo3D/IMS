'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Script from 'next/script'
import { signIn } from 'next-auth/react'
import { startAuthentication } from '@simplewebauthn/browser'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent } from '@/components/ui/card'
import { Alert } from '@/components/ui/alert'
import { Loader2, Fingerprint } from 'lucide-react'
import {
  getPasskeyAuthenticationOptions,
  verifyPasskeyAuthentication,
} from '@/app/actions/passkey'

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: HTMLElement,
        options: {
          sitekey: string
          callback?: (token: string) => void
          'expired-callback'?: () => void
          'error-callback'?: () => void
          theme?: 'light' | 'dark' | 'auto'
        },
      ) => string
      reset: (widgetId?: string) => void
    }
  }
}

type LoginFormProps = {
  turnstileSiteKey?: string | null
  sessionMessage?: string | null
}

export function LoginForm({ turnstileSiteKey, sessionMessage }: LoginFormProps) {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [passkeyLoading, setPasskeyLoading] = useState(false)
  const [turnstileToken, setTurnstileToken] = useState('')
  const [turnstileLoaded, setTurnstileLoaded] = useState(false)
  const turnstileContainerRef = useRef<HTMLDivElement | null>(null)
  const turnstileWidgetIdRef = useRef<string | null>(null)

  const turnstileEnabled = !!turnstileSiteKey

  useEffect(() => {
    if (!turnstileEnabled || !turnstileLoaded || !window.turnstile || !turnstileContainerRef.current) return
    if (turnstileWidgetIdRef.current) return

    turnstileWidgetIdRef.current = window.turnstile.render(turnstileContainerRef.current, {
      sitekey: turnstileSiteKey,
      theme: 'auto',
      callback: (token) => {
        setTurnstileToken(token)
        setError('')
      },
      'expired-callback': () => {
        setTurnstileToken('')
      },
      'error-callback': () => {
        setTurnstileToken('')
      },
    })
  }, [turnstileEnabled, turnstileLoaded, turnstileSiteKey])

  function resetTurnstile() {
    if (!turnstileEnabled) return
    setTurnstileToken('')
    if (window.turnstile && turnstileWidgetIdRef.current) {
      window.turnstile.reset(turnstileWidgetIdRef.current)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')

    if (turnstileEnabled && !turnstileToken) {
      setError('Please complete the verification check.')
      return
    }

    setLoading(true)

    const result = await signIn('credentials', {
      email,
      password,
      turnstileToken,
      redirect: false,
    })

    setLoading(false)
    resetTurnstile()

    if (result?.error) {
      setError('Invalid email or password.')
      return
    }

    router.push('/dashboard')
    router.refresh()
  }

  async function handlePasskeyLogin() {
    setError('')
    setPasskeyLoading(true)

    try {
      // Get authentication options (discoverable credential — no email needed)
      const authOptions = await getPasskeyAuthenticationOptions()
      if ('error' in authOptions) {
        setError(authOptions.error ?? 'Passkey authentication failed.')
        setPasskeyLoading(false)
        return
      }

      // Prompt the browser/OS passkey dialog
      const credential = await startAuthentication({ optionsJSON: authOptions.options })

      // Verify on server
      const result = await verifyPasskeyAuthentication(credential, authOptions.challengeKey)

      if (result.error) {
        setError(result.error)
        setPasskeyLoading(false)
        return
      }

      // Sign in via the passkey credentials provider with the one-time auth token
      const signInResult = await signIn('passkey', {
        userId: result.user!.id,
        authToken: result.authToken,
        redirect: false,
      })

      setPasskeyLoading(false)

      if (signInResult?.error) {
        setError('Sign-in failed.')
        return
      }

      router.push('/dashboard')
      router.refresh()
    } catch (e: unknown) {
      setPasskeyLoading(false)
      const message = e instanceof Error ? e.message : ''
      // User cancelled — not an error
      if (message.includes('ceremony was sent an abort signal') || message.includes('cancelled') || message.includes('AbortError')) {
        return
      }
      setError('Passkey authentication failed.')
    }
  }

  return (
    <Card>
      <CardContent className="pt-6">
        {turnstileEnabled && (
          <Script
            src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
            strategy="afterInteractive"
            onLoad={() => setTurnstileLoaded(true)}
          />
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {!error && sessionMessage && (
            <Alert className="text-sm py-2 px-3">
              {sessionMessage}
            </Alert>
          )}

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
              autoComplete="email webauthn"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>

          {turnstileEnabled && (
            <div className="flex flex-col gap-1.5">
              <div ref={turnstileContainerRef} />
            </div>
          )}

          <Button type="submit" disabled={loading || passkeyLoading} className="w-full">
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Sign in
          </Button>
        </form>

        <div className="relative my-4">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-card px-2 text-muted-foreground">or</span>
          </div>
        </div>

        <Button
          variant="outline"
          className="w-full"
          onClick={handlePasskeyLogin}
          disabled={loading || passkeyLoading}
        >
          {passkeyLoading ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Fingerprint className="mr-2 h-4 w-4" />
          )}
          Sign in with Passkey
        </Button>
      </CardContent>
    </Card>
  )
}
