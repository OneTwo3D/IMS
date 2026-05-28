import { NextResponse } from 'next/server'

import { requireApiAdmin } from '@/lib/auth/server'
import { createRolloutReadinessHandler } from '@/lib/ops/rollout-readiness'

export const runtime = 'nodejs'

export const GET = createRolloutReadinessHandler({
  authorize: async () => {
    const authResult = await requireApiAdmin()
    return authResult instanceof NextResponse ? authResult : null
  },
})

