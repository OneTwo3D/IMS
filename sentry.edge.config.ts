import * as Sentry from '@sentry/nextjs'

import { dataCollection } from '@/lib/observability/data-collection'
import { scrubBreadcrumb, scrubEvent } from '@/lib/observability/scrub'

// Edge runtime init — same options as the server; off unless SENTRY_DSN is set.
const dsn = process.env.SENTRY_DSN?.trim() || undefined

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment: process.env.SENTRY_ENVIRONMENT?.trim() || 'dev',
  release: process.env.SENTRY_RELEASE?.trim() || undefined,
  tracesSampleRate: 0.05,
  dataCollection,
  beforeSend: scrubEvent,
  beforeSendTransaction: scrubEvent,
  beforeBreadcrumb: scrubBreadcrumb,
})
