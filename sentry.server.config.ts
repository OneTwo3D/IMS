import * as Sentry from '@sentry/nextjs'

import { dataCollection } from '@/lib/observability/data-collection'
import { scrubBreadcrumb, scrubEvent, scrubSpan } from '@/lib/observability/scrub'

// Error tracking (GlitchTip, Sentry-compatible). Entirely off unless SENTRY_DSN is set, so CI,
// tests, local dev and any deployment without a DSN behave exactly as before.
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
  // Streamed spans (default) bypass beforeSendTransaction; this is their scrubber.
  beforeSendSpan: scrubSpan,
  beforeBreadcrumb: scrubBreadcrumb,
})
