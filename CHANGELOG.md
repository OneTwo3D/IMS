# Changelog

This repository uses an `x.y.z` release scheme.

- Increment `x` for breaking changes.
- Increment `y` for user-facing non-breaking changes.
- Increment `z` for backend-only non-breaking changes.

## 1.2.0 - 2026-04-16

### User-facing

- Added QuickBooks Online as a fully available accounting connector (OAuth, chart of accounts sync, invoices, bills, credit memos, journal entries, payment polling, daily batch sub-ledger sync).
- QuickBooks is now selectable in the Integrations dashboard alongside Xero.

### Technical

- Full QuickBooks connector module (16 files): OAuth 2.0 with Intuit, HTTP client with rate limiting, split Customer/Vendor contacts, NonInventory items, idempotent sync processor, payment poller with checkpoint-on-success-only.
- Accounting facade, server actions, OAuth callback, and all cron routes now dispatch to the active accounting connector (Xero or QuickBooks).
- Fixed sync processor idempotency: external writes are no longer replayed after partial follow-up failures.
- Fixed stale contact IDs cleared on disconnect to prevent cross-tenant reuse.

## 1.1.0 - 2026-04-16

### User-facing

- Added the current app version as a visible badge in System Settings.

### Technical

- Bumped the tracked release metadata and package version for the 1.1 non-breaking release.

## 1.0 - 2026-04-16

### User-facing

- Added the Product Profitability analytics page.
- Added Turnstile protection to password login.
- Added release tracking in the UI, including a release history view and release notifications.

### Technical

- Added groundwork for Shopify and QuickBooks connectors, including multi-connector shopping support.
- Hardened install and update scripts for git-based deployments, Prisma client generation, and deployment metadata preservation.
- Removed the legacy shopping webhook route conflict and added a real `/api/health` endpoint for deployment checks.
