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

export async function ensureCurrentReleaseNotification(): Promise<void> {
  const release = CURRENT_RELEASE
  const id = getReleaseNotificationId(release.version)
  const title = `What's New in ${release.version}`
  const actionUrl = '/settings/system?tab=releases'
  const existing = await db.notification.findUnique({ where: { id } })

  if (!existing) {
    await db.notification.create({
      data: {
        id,
        userId: null,
        type: 'info',
        title,
        message: release.userMessage,
        actionUrl,
      },
    })
    return
  }

  if (
    existing.userId !== null ||
    existing.type !== 'info' ||
    existing.title !== title ||
    existing.message !== release.userMessage ||
    existing.actionUrl !== actionUrl
  ) {
    await db.notification.update({
      where: { id },
      data: {
        userId: null,
        type: 'info',
        title,
        message: release.userMessage,
        actionUrl,
      },
    })
  }
}
