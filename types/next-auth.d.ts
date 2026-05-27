import type { DefaultSession } from 'next-auth'

import type { SessionInvalidReason } from '@/lib/auth/session-state'

declare module 'next-auth' {
  interface Session {
    user: {
      id: string
      role: string
      supplierId: string | null
      totpEnabled: boolean
      totpVerified: boolean
      pictureUrl: string | null
      sessionVersion: number
      sessionAuthTime: number
      sessionInvalidReason?: SessionInvalidReason | null
    } & DefaultSession['user']
  }

  interface User {
    role?: string
    supplierId?: string | null
    totpEnabled?: boolean
    totpVerified?: boolean
    pictureUrl?: string | null
    sessionVersion?: number
    sessionAuthTime?: number
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    id?: string
    role?: string
    supplierId?: string | null
    totpEnabled?: boolean
    totpVerified?: boolean
    pictureUrl?: string | null
    sessionVersion?: number
    sessionAuthTime?: number
    sessionInvalidReason?: SessionInvalidReason | null
  }
}
