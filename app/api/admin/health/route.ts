import { NextResponse } from 'next/server'

import { requireApiAdmin } from '@/lib/auth/server'
import { createAdminHealthHandler } from '@/lib/ops/health'

export const runtime = 'nodejs'

export const GET = createAdminHealthHandler({
  authorize: async () => {
    const authResult = await requireApiAdmin()
    return authResult instanceof NextResponse ? authResult : null
  },
})
