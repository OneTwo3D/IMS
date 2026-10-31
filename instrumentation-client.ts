import * as Sentry from '@sentry/nextjs'

import { dataCollection } from '@/lib/observability/data-collection'
import { scrubBreadcrumb, scrubEvent } from '@/lib/observability/scrub'

// Browser error tracking (GlitchTip). Off unless NEXT_PUBLIC_SENTRY_DSN is set at build time.
// No Replay, no profiling, no feedback widget.
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN?.trim() || undefined

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT?.trim() || 'dev',
  release: process.env.NEXT_PUBLIC_SENTRY_RELEASE?.trim() || undefined,
  tracesSampleRate: 0.05,
  dataCollection,
  beforeSend: scrubEvent,
  beforeSendTransaction: scrubEvent,
  beforeBreadcrumb: scrubBreadcrumb,
})

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart
