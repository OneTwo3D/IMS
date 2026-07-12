# WMS / 3PL connector-agnostic boundary audit (onetwo3d-ims-h02x.10)

Goal: core app flows (sales / PO / transfer / stock / settings / sync UI / order-status
/ webhook+cron dispatch) go through the generic `WmsConnector` contract
(`lib/connectors/wms/types.ts`) + a WMS registry (`lib/connectors/wms/registry.ts`),
**not** `mintsoft`-specific branches — mirroring the shopping (`shopping-registry.ts`)
and accounting (`accounting-registry.ts`) boundaries.

Acceptance: a ShipHero connector can be added by implementing the contract + registering
it (registry entry + plugin-id + setting key + per-connector cron/webhook ingress), with
**no edits to sales/PO/transfer/stock/settings core flows**.

## Data model is already connector-agnostic

`WmsConnection.connector` and `ExternalWmsBinding.connector` are plain `String` columns,
and `WmsProductLink` / `WmsBundleLink` / `WmsAsnMap` etc. are all keyed by `connector`.
The leaks are **only in app/lib code that hardcodes the `'mintsoft'` literal**, not in
the schema.

## Leak inventory (refs to `mintsoft`/`Mintsoft` outside `lib/connectors/mintsoft/**`)

### CORE LEAK — core flow hardcodes the connector; must go through the registry

| File | Site | Fix |
|------|------|-----|
| `lib/integration-plugins.ts` | `isIntegrationModuleVisible` `'wms'`/`'mintsoft'` case returns `state.mintsoft` | Data-drive over `WMS_CONNECTOR_IDS`; resolve per-connector module strings generically. **(done — keystone)** |
| `app/(dashboard)/layout.tsx` | `wmsIntegrationEnabled={pluginState.mintsoft}` (nav visibility) | `isIntegrationModuleVisible('wms', pluginState)`. **(done — keystone)** |
| `lib/fulfillment/external-fulfillment.ts` | `ExternalFulfillmentSource` includes `'mintsoft'`; `resolveShoppingConnectorForSource` special-cases it via `getMintsoftConnectionRecord()` + `inferMintsoftOrderLookupConnector` | Generalise source to a WMS connector; resolve the order-lookup connector from the active `WmsConnection.orderLookupConnector` via the registry. → sub-issue |
| `app/(dashboard)/onboarding/page.tsx` + `onboarding-client.tsx` | `getMintsoftOnboardingConnectionData()` / `mintsoftConnection` prop / `plugins.mintsoft && !mintsoftConnected` | Generic `getWmsOnboardingConnectionData()` dispatched to the active WMS connector. → sub-issue |
| `app/(dashboard)/purchase-orders/[id]/page.tsx` + `po-detail-client.tsx` | `getMintsoftPurchaseOrderAsnState()`, `createMintsoftPurchaseOrderAsn()`, mintsoft-specific ASN types | Generic `getWmsReceiptAsnState()` + `<WmsAsnDialog>` dispatched via the contract. → sub-issue |
| `app/(dashboard)/stock-control/transfers/page.tsx` + `transfer-list.tsx` + `transfers-client.tsx` | `getMintsoftTransferAsnStates()`, `createMintsoftTransferAsn()`, `mintsoftAsnState` | Generic WMS transfer-ASN state + action. → sub-issue (shares the ASN dialog work) |
| `app/actions/onboarding.ts` | upsert hardcoded `'plugin_mintsoft_enabled'` | Resolve the active WMS connector's setting key from the plugin registry. → sub-issue |
| `app/(dashboard)/sync/sync-dashboard.tsx` + `page.tsx` + `mintsoft-client.tsx` | WMS sync surface routes to a mintsoft-specific client/tabs | Data-drive the WMS sync panel by the active connector (cf. df3m3 accounting-panel). → sub-issue |

### CONNECTOR-EDGE — per-connector ingress; acceptable to be mintsoft-named, dispatch by `binding.connector`

- `app/api/cron/mintsoft-*` (stock-sync, returns-sync, product-verify, bundle-verify, webhook-sweeper)
- `app/api/webhooks/mintsoft/asn-booked-in/route.ts`
- `app/api/e2e/mintsoft/**` (test mocks), `app/api/export/mintsoft-sync/[jobId]/route.ts`
- `lib/cron-jobs/wms-mintsoft.ts` (registers 5 jobs with `module: 'mintsoft'`); `lib/cron-jobs/index.ts` hard-imports `./wms-mintsoft` → generalise to a per-binding cron loader. → sub-issue (medium)
- `lib/domain/integrations/outbox-registry.ts`, `lib/domain/wms/booked-in-service.ts`, `lib/jobs/wms/process-mintsoft-booked-in-event.ts` (connector-specific handlers; orchestration already generic)
- `lib/ops/health.ts`, `lib/ops/rollout-readiness.ts` (per-connector probes — auto-discover from enabled bindings)
- `lib/security/route-auth-policy.ts`, `lib/security/public-route-security-policy.ts` (per-route policies for the ingress endpoints above)
- `app/api/admin/wms/receipt-events/[id]/review/route.ts` (already under generic `/api/admin/wms/`)

### COSMETIC — not a leak

- `lib/releases.ts` (changelog text), `lib/settings-store.ts` (`mintsoft_*` setting keys — stable, connector-scoped), `lib/integration-connection-test-gate.ts` (union type member)
- `app/(dashboard)/settings/system/page.tsx` `mintsoftEnabled` prop — the per-connector **enable toggle**, parallel to `woocommerceEnabled`/`xeroEnabled`. Adding `shipheroEnabled` is "registering a connector", not a core-flow edit. (A later data-driven `IntegrationPluginsSettings` refactor is optional polish.)

## Distinct refactors (deduped) → sub-issues

1. **Keystone (this PR):** single source of truth for WMS connector ids in the contract; data-driven `isIntegrationModuleVisible`; generic WMS nav visibility.
2. External-fulfillment order-lookup resolution via the active `WmsConnection` (also unblocks h02x.1 order-status chip).
3. Generic WMS receipt-ASN state + dialog (PO + transfer), via the contract.
4. Generic WMS onboarding connection-data step + setting-key resolution.
5. Data-driven `/sync` WMS panel.
6. Per-binding cron loader (replace hard-import of `wms-mintsoft`).
7. Freeze `WmsConnector` as the stable app-facing boundary (doc + lint guard against new `mintsoft` literals outside `lib/connectors/mintsoft/**`).
</content>
</invoke>
