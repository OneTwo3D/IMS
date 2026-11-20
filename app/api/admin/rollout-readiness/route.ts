import { NextResponse } from 'next/server'

import { requireApiAdmin } from '@/lib/auth/server'
import { createRolloutReadinessHandler } from '@/lib/ops/rollout-readiness'
import { recordReadinessOverride } from '@/lib/ops/rollout-readiness-override-audit'

export const runtime = 'nodejs'

export const GET = createRolloutReadinessHandler({
  authorize: async () => {
    const authResult = await requireApiAdmin()
    return authResult instanceof NextResponse ? authResult : null
  },
  // `?allowWarnings=true` needs a signed-in ADMIN (checked again here, independent of `authorize`) and an audit row.
  resolveOverrideActor: async () => {
    const authResult = await requireApiAdmin()
    return authResult instanceof NextResponse ? null : { id: authResult.user.id }
  },
  recordOverride: recordReadinessOverride,
})
