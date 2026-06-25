# WMS / 3PL connector boundary (frozen)

The IMS treats the 3PL/WMS layer as **connector-agnostic**. Core app flows — sales,
purchase orders, transfers, stock, onboarding, settings, the `/sync` wiring, and
external fulfillment — go through a generic boundary and never branch on a
specific connector (`mintsoft`). A second WMS connector (e.g. ShipHero) is added
by **implementing the contract + registering it**, with no edits to those core
flows.

This mirrors the shopping (`shopping-registry.ts`) and accounting
(`accounting-registry.ts`) boundaries. Epic: `onetwo3d-ims-h02x.10`.

## The contract (stable, app-facing)

- **`lib/connectors/wms/types.ts`** — the `WmsConnector` interface plus
  `WMS_CONNECTOR_IDS` / `WmsConnectorId` (the single source of truth for connector
  ids) and `isWmsConnectorId`. This module is server-free so client components can
  import the id guard.
- **`lib/connectors/wms/registry.ts`** — `WMS_CONNECTORS` descriptors +
  `getWmsConnector(id)` (resolves the connector implementation).
- **`lib/connectors/wms/active-connector.ts`** — `getActiveWmsConnectorId()` (the
  enabled WMS connector, with a single-connector fallback).
- **`lib/connectors/wms/asn-types.ts`** — connector-agnostic ASN view-models.
- **`lib/connectors/wms/order-lookup.ts`** — `resolveWmsOrderLookupConnector`.

## Dispatch facades (core flows call these, never a connector module)

- **`app/actions/wms-asn.ts`** — PO/transfer receive-ASN state + create.
- **`app/actions/wms-sync.ts`** — `/sync` dashboard data.
- **`app/actions/wms-onboarding.ts`** — onboarding connection-data.
- **`app/actions/wms-order-status.ts`** — live order status for the sales-order chip.

Each resolves the active connector and dispatches to its implementation. The
per-connector UI lives in dedicated dispatchers
(`app/(dashboard)/sync/wms-sync-panel.tsx`,
`components/onboarding/wms-onboarding-connection.tsx`) — adding a connector means a
branch there, not in the page/step.

## Where the `mintsoft` literal is allowed

The literal is legitimate only in: the Mintsoft connector itself
(`lib/connectors/mintsoft/**`, `app/actions/mintsoft-sync.ts`), its per-connector
ingress (`app/api/cron/mintsoft-*`, `app/api/webhooks/mintsoft/**`,
`app/api/e2e/mintsoft/**`, `app/api/export/mintsoft-sync/**`, `lib/cron-jobs/wms-mintsoft.ts`),
the WMS dispatch facades/registry/panels above, the UI connector registry
(`/sync` `CONNECTORS`, the settings enable toggle), and per-connector ops/security
probes + cosmetic/plugin-registry files. See the allowlist in the guard.

## Enforcement

`scripts/check-wms-connector-boundary.mjs` (run by `npm run check:all` and the
**WMS Connector Boundary Guard** CI workflow) fails the build if `mintsoft` appears
in any scanned `app`/`lib`/`components` file outside that allowlist. For a genuinely
connector-specific reference, add the path to the allowlist or add a per-line waiver:

```
// wms-connector-boundary-ok: <ticket-or-date>: <reason>
```

## Known pending generalization

- `app/actions/products.ts` still triggers Mintsoft product/bundle sync directly on
  product mutations (`runMintsoftProductSyncForProduct`). Generalizing this to the
  active WMS connector is tracked separately (WMS product-sync dispatch); the file
  is allowlisted until then.
