import type { NextAuthConfig } from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { db } from '@/lib/db'
import { consumeAuthToken } from '@/lib/auth/token-store'
import { checkRateLimit, clearRateLimit } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/request-ip'

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

const DUMMY_BCRYPT_HASH = '$2b$12$Q7QxTQqR0p6vJY9Yx1m8JOkjH3J0mD6G4jY6YtV2v0mL4YvM1gM9S'

export const authConfig: NextAuthConfig = {
  trustHost: true,
  pages: {
    signIn: '/login',
  },
  session: {
    strategy: 'jwt',
    maxAge: 30 * 24 * 60 * 60, // 30 days
  },
  callbacks: {
    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = !!auth?.user
      const isAuthPage =
        nextUrl.pathname.startsWith('/login') ||
        nextUrl.pathname.startsWith('/2fa')
      const isApiAuth = nextUrl.pathname.startsWith('/api/auth')
      const isPublic = isAuthPage || isApiAuth

      if (isPublic) return true
      if (isLoggedIn) return true
      return false // redirect to /login
    },
    async jwt({ token, user, trigger, session }) {
      if (user) {
        token.id = user.id
        token.role = (user as { role?: string }).role
        token.supplierId = (user as { supplierId?: string | null }).supplierId ?? null
        token.totpEnabled = (user as { totpEnabled?: boolean }).totpEnabled
        token.totpVerified = (user as { totpVerified?: boolean }).totpVerified ?? false
        token.pictureUrl = (user as { pictureUrl?: string | null }).pictureUrl ?? null
      }
      // Allow client-side session.update() to refresh non-sensitive token fields only.
      // SECURITY: totpVerified and totpEnabled must only be set server-side (TOTP API route),
      // never from client session.update() — otherwise a user could bypass 2FA.
      if (trigger === 'update' && session) {
        if (session.pictureUrl !== undefined) token.pictureUrl = session.pictureUrl
        if (session.name !== undefined) token.name = session.name
        // totpVerified can only be set via a server-issued one-time token
        if (session.totpVerified === true && session._totpToken) {
          const verified = await consumeAuthToken(`totp_verify:${session._totpToken}`)
          if (verified === token.id) {
            token.totpVerified = true
          }
        }
        // totpEnabled is refreshed from DB when TOTP setup changes
        if (session._refreshTotp === true) {
          // Re-read from DB to get fresh totpEnabled state
          const { db } = await import('@/lib/db')
          const user = await db.user.findUnique({
            where: { id: token.id as string },
            select: { totpEnabled: true },
          })
          if (user) {
            token.totpEnabled = user.totpEnabled
            if (!user.totpEnabled) token.totpVerified = false
          }
        }
      }
      return token
    },
    session({ session, token }) {
      if (token) {
        session.user.id = token.id as string
        session.user.role = token.role as string
        session.user.supplierId = token.supplierId as string | null
        session.user.totpEnabled = token.totpEnabled as boolean
        session.user.totpVerified = token.totpVerified as boolean
        session.user.pictureUrl = token.pictureUrl as string | null
      }
      return session
    },
  },
  providers: [
    Credentials({
      id: 'credentials',
      async authorize(credentials, request) {
        const parsed = loginSchema.safeParse(credentials)
        if (!parsed.success) return null

        const clientIp = getClientIp(request.headers) ?? 'unknown'
        const rlKey = `login:${parsed.data.email.toLowerCase()}:${clientIp}`
        const rl = checkRateLimit(rlKey, 10, 15 * 60_000)
        if (!rl.allowed) return null

        const user = await db.user.findUnique({
          where: { email: parsed.data.email },
          select: {
            id: true,
            email: true,
            name: true,
            passwordHash: true,
            role: true,
            supplierId: true,
            pictureUrl: true,
            totpEnabled: true,
            active: true,
          },
        })

        const passwordHash = user?.passwordHash ?? DUMMY_BCRYPT_HASH
        const passwordMatch = await bcrypt.compare(
          parsed.data.password,
          passwordHash,
        )
        if (!user || !user.active || !passwordMatch) return null

        clearRateLimit(rlKey)

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          supplierId: user.supplierId,
          pictureUrl: user.pictureUrl,
          totpEnabled: user.totpEnabled,
          totpVerified: false,
        }
      },
    }),
    Credentials({
      id: 'passkey',
      credentials: {
        userId: { type: 'text' },
        authToken: { type: 'text' },
      },
      async authorize(credentials) {
        const userId = credentials?.userId as string | undefined
        const authToken = credentials?.authToken as string | undefined
        if (!userId || !authToken) return null

        // Verify the one-time auth token from verifyPasskeyAuthentication.
        // This binds the signIn call to a successful WebAuthn verification,
        // preventing direct signIn('passkey', { userId }) without verification.
        const verifiedUserId = await consumeAuthToken(`passkey_auth:${authToken}`)
        if (!verifiedUserId || verifiedUserId !== userId) return null

        const user = await db.user.findUnique({
          where: { id: userId },
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
            supplierId: true,
            pictureUrl: true,
            totpEnabled: true,
            active: true,
          },
        })

        if (!user || !user.active) return null

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          supplierId: user.supplierId,
          pictureUrl: user.pictureUrl,
          totpEnabled: user.totpEnabled,
          // Passkey counts as strong auth — skip TOTP
          totpVerified: true,
        }
      },
    }),
  ],
}
