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
    jwt({ token, user }) {
      if (user) {
        token.id = user.id
        token.role = (user as { role?: string }).role
        token.totpEnabled = (user as { totpEnabled?: boolean }).totpEnabled
        token.totpVerified = (user as { totpVerified?: boolean }).totpVerified ?? false
      }
      return token
    },
    session({ session, token }) {
      if (token) {
        session.user.id = token.id as string
        session.user.role = token.role as string
        session.user.totpEnabled = token.totpEnabled as boolean
        session.user.totpVerified = token.totpVerified as boolean
      }
      return session
    },
  },
  providers: [
    Credentials({
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
          totpEnabled: user.totpEnabled,
          totpVerified: false, // always start unverified; TOTP challenge sets this
        }
      },
    }),
  ],
}
