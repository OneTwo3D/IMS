import type { NextAuthConfig } from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { db } from '@/lib/db'

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

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
    jwt({ token, user, trigger, session }) {
      if (user) {
        token.id = user.id
        token.role = (user as { role?: string }).role
        token.supplierId = (user as { supplierId?: string | null }).supplierId ?? null
        token.totpEnabled = (user as { totpEnabled?: boolean }).totpEnabled
        token.totpVerified = (user as { totpVerified?: boolean }).totpVerified ?? false
        token.pictureUrl = (user as { pictureUrl?: string | null }).pictureUrl ?? null
      }
      // Allow client-side session.update() to refresh token fields
      if (trigger === 'update' && session) {
        if (session.pictureUrl !== undefined) token.pictureUrl = session.pictureUrl
        if (session.totpVerified !== undefined) token.totpVerified = session.totpVerified
        if (session.totpEnabled !== undefined) token.totpEnabled = session.totpEnabled
        if (session.name !== undefined) token.name = session.name
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
      async authorize(credentials) {
        const parsed = loginSchema.safeParse(credentials)
        if (!parsed.success) return null

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

        if (!user || !user.active) return null

        const passwordMatch = await bcrypt.compare(
          parsed.data.password,
          user.passwordHash,
        )
        if (!passwordMatch) return null

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
      },
      async authorize(credentials) {
        // This provider is only called after WebAuthn verification succeeds on the client.
        // The server action verifyPasskeyAuthentication already verified the passkey,
        // so we just look up the user by ID here.
        const userId = credentials?.userId as string | undefined
        if (!userId) return null

        const user = await db.user.findUnique({
          where: { id: userId },
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
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
          pictureUrl: user.pictureUrl,
          totpEnabled: user.totpEnabled,
          // Passkey counts as strong auth — skip TOTP
          totpVerified: true,
        }
      },
    }),
  ],
}
