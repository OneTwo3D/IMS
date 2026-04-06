import type { DefaultSession } from 'next-auth'

declare module 'next-auth' {
  interface Session {
    user: {
      id: string
      role: string
      totpEnabled: boolean
      totpVerified: boolean
      pictureUrl: string | null
    } & DefaultSession['user']
  }
}
