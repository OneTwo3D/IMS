# In-App Help Docs

This directory contains the user-facing help articles shown inside the application.

- Keep these docs focused on day-to-day product usage.
- Do not add architecture notes, deployment instructions, connector runbooks, or other internal/admin material here.
- Internal and technical documentation belongs in `docs/`.

The overlapping user manuals in `docs/` should be symlinks back to this directory so there is only one maintained copy of each article.


## Articles

### Getting started
- [Getting Started](getting-started.md) — entry point for new users
- [Setup Wizard Walkthrough](onboarding-walkthrough.md) — step-by-step guide through the first-run wizard
- [Glossary](glossary.md) — plain-English definitions of key terms
- [Troubleshooting](troubleshooting.md) — common errors and first-stop fixes

### Day-to-day usage
- [Dashboard](dashboard.md) — KPIs and live overview
- [Inventory](inventory.md) — product catalogue and stock levels
- [Stock Control](stock-control.md) — adjustments and transfers
- [Sales Orders](sales.md) — order workflow, allocation, shipments, refunds
- [Purchasing](purchasing.md) — purchase orders, receiving, suppliers
- [Manufacturing](manufacturing.md) — build orders and BOMs
- [Analytics](analytics.md) — reports and forecasting
- [Documents & Email](documents-email.md) — PDF generation and notifications
- [Activity Log](activity-log.md) — audit trail

### Administration
- [Settings](settings.md) — company, inventory, sales, accounting, backup, system
- [User Management & Security](user-management.md) — roles, permissions, 2FA

### Integrations
- [WooCommerce Integration](woocommerce.md) — order sync, product sync, refunds
- [Xero Accounting Sync](xero-sync.md) — sub-ledger flow, journals, FX


## Authoring notes

- When updating an article, also check the [Setup Wizard Walkthrough](onboarding-walkthrough.md) and [Troubleshooting](troubleshooting.md) for cross-references that may need updating.
- The [Glossary](glossary.md) is the canonical source for term definitions. Link to it from other articles rather than re-defining terms.
