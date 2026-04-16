# Changelog

This repository uses an `x.y` release scheme.

- Increment `x` for breaking changes.
- Increment `y` for non-breaking changes.

## 1.0 - 2026-04-16

### User-facing

- Added the Product Profitability analytics page.
- Added Turnstile protection to password login.
- Added release tracking in the UI, including a release history view and release notifications.

### Technical

- Added groundwork for Shopify and QuickBooks connectors, including multi-connector shopping support.
- Hardened install and update scripts for git-based deployments, Prisma client generation, and deployment metadata preservation.
- Removed the legacy shopping webhook route conflict and added a real `/api/health` endpoint for deployment checks.
