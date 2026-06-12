import { db } from '@/lib/db'

export type AppRelease = {
  version: string
  date: string
  title: string
  summary: string
  userMessage: string
  userHighlights: string[]
  technicalHighlights: string[]
}

export const RELEASES: AppRelease[] = [
  {
    version: '2.0.0',
    date: '2026-06-12',
    title: 'Tax model, accounting sync, manufacturing-aware reorder, decimal-precision overhaul',
    summary: 'Major release covering 16 cleared release blockers and ~190 PRs since 1.5.0. Highlights: a full VAT/tax-profile model with bidirectional Xero sync, post-push edits for invoices and bills, the Reorder Planning report extended to manufactured products and their raw materials, end-to-end Decimal precision across landed cost / allocation / refund / COGS, hardened cron and webhook authentication, and breaking changes operators must action before deploying.',
    userMessage: 'IMS 2.0 brings compound and reverse-charge VAT with Xero round-trips, lets you edit invoices and bills after they have synced, and surfaces manufactured goods plus their raw materials in one Reorder Planning report so you can generate POs and draft MOs in a single click. See the release notes for actionable operator changes (cron auth, settings connection-test gate, upload storage roots).',
    userHighlights: [
      'VAT rate profiles in Settings > Accounting: ordered components, compound math (e.g. GST + PST 12.35%), reverse-charge flag, reporting category (DOMESTIC / REVERSE_CHARGE / EC_SALES / OSS).',
      'Multi-component VAT rates auto-sync to Xero TaxRates with the matching TaxComponents on every save.',
      'Sales invoices and purchase bills that have already pushed to Xero now sync edits back as updates instead of silently dropping the change. QuickBooks logs a clear "not supported" warning.',
      'Failed accounting updates surface as an amber alert on the related sales order or purchase order with connector, timestamp, retry count, and a safe error message.',
      'VAT analytics report groups and filters by reporting category; OSS and reverse-charge entries no longer mix with domestic.',
      'Reorder Planning report covers manufactured products: BOM rows show the most recent manufacturer (or "Manufactured in-house"), raw materials show "Needed for" each parent BOM with their demand rolled up, and a "Generate POs + draft MOs for visible rows" button creates draft orders in one click.',
      'Sales allocation now distinguishes physical reservations from backorder demand; allocation activity logs include the backorder breakdown so operators can see why an order sits in a status.',
      'Report description and methodology notices now hide behind an (i) tooltip next to the title, freeing ~24px on every analytics page for the data table.',
      'Mintsoft booked-in webhook flow is more reliable: HMAC binds the freshness timestamp, acknowledgements wait for durable persistence, retries are configurable and queryable, reconciliation uses direct ASN lookup.',
      'Integration settings now require a successful connection test before sync can be enabled (Xero / WooCommerce / Mintsoft / SMTP) — the test result, timestamp, and configuration fingerprint are persisted and re-checked on save.',
    ],
    technicalHighlights: [
      'TaxRateComponent schema + idempotent migration; TaxRate gains isCompound / reverseCharge / reportingCategory and a components relation. Effective rate snapshotted on document lines so historical documents stay stable.',
      'AccountingSyncType extended with SALES_INVOICE_UPDATE, PURCHASE_INVOICE_UPDATE, TAX_RATE_SYNC; processor handles each with payload-derived idempotency keys (DB-level dedupe + Xero-level idempotency).',
      'lib/connectors/xero/tax-rates.ts wraps POST /TaxRates; lib/accounting/tax-rate-sync-trigger.ts queues a sync when an IMS TaxRate with components is saved.',
      'queueSalesInvoiceForOrder, createInvoice, and updateInvoice emit multi-component WARNING logs via shared lib/accounting/multi-component-warning.ts. Reverse-charge tax-type swap on both sales and purchase paths.',
      'getReorderReport rebuilt as a two-phase loader: candidates first, BOM-driven component demand folded into reorderPoint, then filter. Latest ProductionOrder labels BOM supplier column. createReorderMOs creates DRAFT ProductionOrders copying manufacturer + warehouse from the latest MO.',
      'PO currency/rate edits now rebase line + freight + parent base amounts inside a single transaction; FX resolver lifted into a dedicated rate-only update path.',
      'Decimal precision overhaul across landed-cost recalculation (Decimal throughout, revaluation audit runs), allocation availability (Decimal arithmetic), refund correctness (return-stock idempotency now includes return warehouse, restocking requires shipped-stock evidence), COGS entries (six-decimal consumed quantities), cost-layer snapshots (Decimal-safe six-decimal strings).',
      'Manufacturing WIP and cost-layer timing align with finance expectations; manufacturing domain helpers extracted into testable modules.',
      'Inventory invariant SQL collector + integration outbox payload registry with backoff retry give operators introspection into ingest health.',
      'Report CSV exports moved metadata out of per-row schemas into trailing comment rows and base64url-encoded X-IMS-Export-Metadata response header (breaking change for column-pinned consumers).',
      'High-volume Xero daily batch journals split into multiple entries per day with deterministic hash suffixes; reconciliation groups by payload metadata (batchDate / batchGroup / batchReferenceId).',
      'Account-balance snapshots now have a daily cron dependency (GET /api/cron/account-balance-snapshot) — production-readiness check treats stale runs as a blocker.',
      'Upload storage roots are now environment-configured: UPLOAD_STORAGE_DIR for private uploads (supplier invoice PDFs) and PUBLIC_UPLOAD_STORAGE_DIR for branding/avatar assets.',
      'Invoice PDF uploads can be scanned before storage via FILE_SCAN_MODE=command with a configurable quarantine + scanner command.',
      'Decimal boundary guard, integration outbox registry, and the inventory invariant SQL collector tighten precision and observability across the stack.',
      'CHANGELOG and docs/help-docs cover the full cycle; legacy production-readiness blockers plan moved to docs/completed/.',
      'Breaking: production cron endpoints now require bearer authentication by default (CRON_SECRET). Update existing production crontabs to include the Authorization header; emergency bypass is explicit and narrow. Fresh installs are handled by scripts/install.',
    ],
  },
  {
    version: '1.5.0',
    date: '2026-04-19',
    title: 'Onboarding company-step flow cleanup',
    summary: 'The onboarding wizard now uses a single Next action on Company Details, which saves the form and advances without a redundant separate save button.',
    userMessage: 'The Company Details step in onboarding is simpler: Next now saves your details and moves you forward in one action.',
    userHighlights: [
      'Removed the separate Save Company Details button from onboarding.',
      'Made Next save the company details step and advance in one click.',
      'Added coverage for the Company Details Next flow in end-to-end tests.',
    ],
    technicalHighlights: [
      'Moved the company-step save trigger behind the shared onboarding navigation so the footer action can persist state before changing steps.',
      'Bumped the visible release version and release notes for the onboarding flow change.',
    ],
  },
  {
    version: '1.4.1',
    date: '2026-04-19',
    title: 'Deployment script hotfix',
    summary: 'The bundled production update script no longer aborts after printing recent commits during a git-based deploy.',
    userMessage: 'Deployment automation is more reliable: the bundled update script now completes cleanly when showing recent changes from git.',
    userHighlights: [
      'Fixed the bundled update script so git-based production updates complete cleanly instead of aborting after printing recent commits.',
    ],
    technicalHighlights: [
      'Replaced the pipefail-sensitive `git log | head` pipeline in `scripts/update.sh` with a single `git log --max-count` invocation.',
    ],
  },
  {
    version: '1.4.0',
    date: '2026-04-19',
    title: 'Onboarding, opening stock import, and profitability usability',
    summary: 'New instances now have a guided onboarding flow, opening stock can be imported directly by warehouse, and the product profitability report is easier to work with on larger datasets.',
    userMessage: 'Onboarding is smoother for new installs, opening stock can be imported in bulk, and the product profitability report now has pagination, column visibility, and better scrolling.',
    userHighlights: [
      'Added a guided onboarding setup flow for new instances with tighter integration gating.',
      'Added opening stock CSV import by SKU, warehouse, quantity, and base unit cost.',
      'Improved the product profitability report with pagination, column visibility controls, and scroll behavior fixes.',
    ],
    technicalHighlights: [
      'Hardened FIFO, allocation, refund, shipment, and landed-cost accounting flows across the Xero and commerce workflows.',
      'Fixed CSV import regressions and added end-to-end onboarding coverage for the new setup workflow.',
    ],
  },
  {
    version: '1.3.1',
    date: '2026-04-17',
    title: 'Bundle fulfillment hardening and help consolidation',
    summary: 'Bundle and BOM handling now uses stronger fulfillment safeguards, mirrored help files are centralized, and duplicate component configurations are flagged before they proliferate.',
    userMessage: 'Bundle and BOM workflows are safer: duplicate component setups are flagged, help content is unified, and stock/accounting behavior is documented more clearly.',
    userHighlights: [
      'Added warnings when a bundle or BOM matches the exact component makeup of an existing bundle or BOM.',
      'Expanded bundle, BOM, shipment-only fulfillment, and refund guidance across the in-app help.',
      'Unified mirrored help content so the app and repo share one maintained source of truth.',
    ],
    technicalHighlights: [
      'Added component-signature matching for KIT/BOM configuration warnings and enforced barcode uniqueness in the database and product flows.',
      'Added bundle fulfillment coverage and component-allocation migration work, plus live WC-to-Xero bundle refund E2E coverage.',
    ],
  },
  {
    version: '1.3.0',
    date: '2026-04-16',
    title: 'Shopify integration setup and stock sync',
    summary: 'Integrations now includes a real Shopify connector screen with credential setup, manual stock sync, and connector-aware sync visibility.',
    userMessage: 'Shopify can now be configured in Integrations, with manual stock sync, sync logs, and Shopify link support where matches are resolved safely.',
    userHighlights: [
      'Added a Shopify connector screen in Integrations for credentials and webhook-secret setup.',
      'Added manual Shopify stock sync and visible Shopify sync log history.',
      'Added Shopify product and sales-order admin links where the IMS can resolve a safe Shopify match.',
    ],
    technicalHighlights: [
      'Implemented the first real Shopify connector layer and shared shopping-facade wiring.',
      'Added duplicate-SKU safeguards, webhook retry-safe rejection, and Shopify sync log persistence.',
    ],
  },
  {
    version: '1.2.0',
    date: '2026-04-16',
    title: 'QuickBooks Online accounting connector',
    summary: 'QuickBooks Online is now available alongside Xero, with end-to-end accounting sync and OAuth setup in Integrations.',
    userMessage: 'QuickBooks Online can now be connected in Integrations and used for accounting sync alongside Xero.',
    userHighlights: [
      'Added QuickBooks Online as a fully available accounting connector.',
      'Added QuickBooks setup and selection in the Integrations dashboard.',
    ],
    technicalHighlights: [
      'Implemented the full QuickBooks connector, including OAuth, account sync, transaction sync, and payment polling.',
      'Updated the accounting facade, OAuth callback, and cron routes to dispatch to the active accounting connector.',
    ],
  },
  {
    version: '1.1.0',
    date: '2026-04-16',
    title: 'Visible app version in System Settings',
    summary: 'Added the current release number directly to the System Settings header for faster support and deployment verification.',
    userMessage: 'System Settings now shows the current app version directly in the page header.',
    userHighlights: [
      'Added a visible version badge to the System Settings header.',
      'Kept the Releases tab as the place for fuller release history and notes.',
    ],
    technicalHighlights: [
      'Bumped the application release to 1.1.0 and recorded it in the repo changelog.',
    ],
  },
  {
    version: '1.0.0',
    date: '2026-04-16',
    title: 'Release tracking and operational hardening',
    summary: 'Introduced repo-backed release versioning, user-visible release notes, deployment hardening, and health checks.',
    userMessage: 'New product profitability analytics are live, login protection has been tightened with Turnstile, and the app now shows release updates directly in the UI.',
    userHighlights: [
      'Added the Product Profitability analytics view.',
      'Added Turnstile protection to password login.',
      'Added in-app release notifications and a release history view in System Settings.',
    ],
    technicalHighlights: [
      'Added connector groundwork for Shopify and QuickBooks, including multi-connector shopping foundations.',
      'Hardened install and update scripts for git-based deployments, Prisma generation, and webhook routing.',
      'Added a real /api/health endpoint for deployment checks.',
    ],
  },
]

export const CURRENT_RELEASE = RELEASES[0]

export function getReleaseNotificationId(version: string): string {
  return `release-${version.replace(/\./g, '-')}`
}

type ReleaseNotificationData = {
  id: string
  userId: string | null
  type: string
  title: string
  message: string
  actionUrl: string | null
}

type ReleaseNotificationStore = {
  createMany(args: { data: ReleaseNotificationData[]; skipDuplicates: boolean }): Promise<{ count: number }>
  findUnique(args: {
    where: { id: string }
    select: Record<keyof Omit<ReleaseNotificationData, 'id'>, true>
  }): Promise<Omit<ReleaseNotificationData, 'id'> | null>
  update(args: {
    where: { id: string }
    data: Omit<ReleaseNotificationData, 'id'>
  }): Promise<unknown>
}

function releaseNotificationHasDrift(
  existing: Omit<ReleaseNotificationData, 'id'>,
  desired: Omit<ReleaseNotificationData, 'id'>,
): boolean {
  return existing.userId !== desired.userId
    || existing.type !== desired.type
    || existing.title !== desired.title
    || existing.message !== desired.message
    || existing.actionUrl !== desired.actionUrl
}

export async function ensureCurrentReleaseNotificationInStore(
  notificationStore: ReleaseNotificationStore,
): Promise<void> {
  const release = CURRENT_RELEASE
  const id = getReleaseNotificationId(release.version)
  const title = `What's New in ${release.version}`
  const actionUrl = '/settings/system?tab=releases'
  const desired = {
    id,
    userId: null,
    type: 'info',
    title,
    message: release.userMessage,
    actionUrl,
  }

  const created = await notificationStore.createMany({
    data: [desired],
    skipDuplicates: true,
  })
  if (created.count > 0) return

  const existing = await notificationStore.findUnique({
    where: { id },
    select: {
      userId: true,
      type: true,
      title: true,
      message: true,
      actionUrl: true,
    },
  })

  if (!existing) return

  const desiredUpdate = {
    userId: desired.userId,
    type: desired.type,
    title: desired.title,
    message: desired.message,
    actionUrl: desired.actionUrl,
  }

  if (releaseNotificationHasDrift(existing, desiredUpdate)) {
    await notificationStore.update({
      where: { id },
      data: desiredUpdate,
    })
  }
}

export async function ensureCurrentReleaseNotification(): Promise<void> {
  await ensureCurrentReleaseNotificationInStore(db.notification)
}
