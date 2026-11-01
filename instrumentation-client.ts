import * as Sentry from '@sentry/nextjs'

import { dataCollection } from '@/lib/observability/data-collection'
import { dropContentCapturingIntegrations } from '@/lib/observability/integrations'
import { scrubBreadcrumb, scrubEvent, scrubSpan } from '@/lib/observability/scrub'

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
  // Breadcrumbs: navigation + fetch/xhr only. No DOM breadcrumbs (they record clicked elements' alt/title/
  // aria-label text, which holds user and product names); scrubBreadcrumb is an allowlist on top of this.
  integrations: (defaults) => [
    ...dropContentCapturingIntegrations(defaults).filter((i) => i.name !== 'Breadcrumbs'),
    Sentry.breadcrumbsIntegration({ dom: false, fetch: true, history: true, xhr: true, sentry: false }),
  ],
  beforeSend: scrubEvent,
  beforeSendTransaction: scrubEvent,
  // Streamed spans (default) bypass beforeSendTransaction; this is their scrubber.
  beforeSendSpan: scrubSpan,
  beforeBreadcrumb: scrubBreadcrumb,
})

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart
