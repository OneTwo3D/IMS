# Unified FX Rates Across IMS, Shopping & Accounting Connectors

**Goal:** make IMS the single source of truth for FX rates so WooCommerce (currently
Aelia Currency Switcher) and Xero both consume the same daily rate. Implementation
must stay agnostic of which shopping/accounting plugin is in use — Aelia, CURCY,
WPML, Shopify Markets on one side; Xero, QuickBooks on the other.

---

## 1. Why this matters

Today three systems each have their own rate:

| System | Rate source | When applied |
|---|---|---|
| WC + Aelia | Aelia's configured provider (ECB, Yahoo, manual) — polled on its own schedule | Cart/checkout currency conversion + order currency stamp |
| IMS | `frankfurter.dev` (ECB) via `/api/cron/fx-rates` daily | Stamped on PO/SO/Invoice as `fxRateToBase` |
| Xero | XE.com internal rates | Auto-applied to multi-currency invoices/bills if `CurrencyRate` not provided |

Even when all three pull "ECB", they pull at different times of day and round
differently. That produces 1–3 % drift between the WC order total, the IMS sales
order base-currency total, and the Xero invoice base-currency total — which then
shows up as unexplained variance on COGS/margin reports and reconciliation.

---

## 2. Target architecture

```
                   ┌────────────────────────┐
                   │  External rate feed    │
                   │  (frankfurter / ECB)   │
                   └───────────┬────────────┘
                               │ daily cron
                               ▼
         ┌─────────────────────────────────────────┐
         │  IMS — FxRate table (single source)     │
         │  rate(GBP→XXX, fetched_at)              │
         └───┬────────────────────────────┬────────┘
             │ push                       │ stamp on every doc
             ▼                            ▼
   ShoppingConnector.pushFxRates    AccountingConnector.upsertInvoice
   ─ WooCommerce → Aelia adapter    ─ Xero  (CurrencyRate field)
   ─ Shopify    → Markets adapter   ─ QuickBooks (ExchangeRate field)
```

Two new responsibilities, both expressed on the existing connector interfaces in
`lib/connectors/types.ts`:

1. **Shopping side — push** rates to the storefront so prices/orders convert with
   the IMS rate.
2. **Accounting side — stamp** rates on every document we create so the
   accounting platform never falls back to its own rate.

No code outside the two connector adapter folders should know which plugin is in
use.

---

## 3. What already exists (do not rebuild)

- `prisma/schema.prisma` `FxRate` model — `fromCurrency`/`toCurrency`/`rate`/`fetchedAt`
- `app/api/cron/fx-rates/route.ts` — daily fetch from frankfurter
- `lib/base-currency.ts` — `getBaseCurrencyCode()` and helpers
- `fxRateToBase` columns on `PurchaseOrder`, `SalesOrder`, `Invoice`, `CreditNote`
- `lib/connectors/types.ts` — `ShoppingConnector` and `AccountingConnector` interfaces
- `lib/connectors/woocommerce/wc-invoice-buttons.php` — proven companion-WP-plugin pattern

Most of the foundation is already in place. The new work is **outbound** — pushing
the IMS rate into WC and ensuring it always rides along on Xero documents.

---

## 4. Schema changes

Minimal. Add only what's needed to track outbound sync state.

```prisma
model FxRate {
  // existing fields ...
  source         String   @default("frankfurter")     // for audit
  manualOverride Boolean  @default(false)              // admin can pin a rate
}

model FxRatePushLog {
  id           String   @id @default(cuid())
  connector    String                                  // 'woocommerce' | 'shopify' | ...
  pushedAt     DateTime @default(now())
  ratesCount   Int
  status       String                                  // 'OK' | 'PARTIAL' | 'FAILED'
  errorMessage String?
  payload      Json?                                   // for debugging
  @@index([connector, pushedAt])
  @@map("fx_rate_push_log")
}
```

No changes to existing `fxRateToBase` columns — they already capture per-document
rates.

---

## 5. Connector interface extensions

### 5.1 Shopping side

Add to `ShoppingConnector` in `lib/connectors/types.ts`:

```ts
export type FxRatePush = {
  fromCurrency: string   // base currency, e.g. 'GBP'
  toCurrency: string     // target, e.g. 'EUR'
  rate: number           // 1 GBP = rate toCurrency
  fetchedAt: string      // ISO timestamp from IMS
}

export interface ShoppingConnector {
  // ... existing methods

  /**
   * Push the current FX rate set to the storefront. Optional capability —
   * connectors that don't support multi-currency may return
   * { supported: false }.
   */
  pushFxRates?(rates: FxRatePush[]): Promise<{
    supported: boolean
    pushed: number
    errors: string[]
  }>
}
```

### 5.2 Accounting side

`AccountingConnector` already accepts an `InvoiceData` object — extend it (and
`BillData`, `CreditNoteData`) with a single optional field:

```ts
export type InvoiceData = {
  // ... existing fields
  /**
   * Rate used to convert from the document currency back to base. Connectors
   * MUST forward this to the platform if provided, so the accounting system
   * does not substitute its own daily rate.
   *   - Xero    → `CurrencyRate` (note: Xero defines as "1 doc-ccy = X base")
   *   - QuickBooks → `ExchangeRate`
   */
  currencyRate?: number
}
```

Document the rate-direction convention once in `types.ts` and let each adapter
invert if needed (Xero and QB define it differently from each other).

---

## 6. Source-of-truth job

Existing `/api/cron/fx-rates` becomes the only writer to `FxRate`. After it
finishes the inbound fetch it triggers an **outbound fan-out**:

```ts
// app/api/cron/fx-rates/route.ts (new section, pseudocode)
const rates = await db.fxRate.findMany({ where: { fetchedAt: today } })
const payload = rates.map(toFxRatePush)

for (const connector of getEnabledShoppingConnectors()) {
  if (!connector.pushFxRates) continue
  const result = await connector.pushFxRates(payload)
  await db.fxRatePushLog.create({ data: { connector: connector.id, ... } })
}
```

Failure on one connector must not block the others. Errors get logged to
`FxRatePushLog` and surfaced on the Sync page.

---

## 7. WooCommerce / Aelia adapter

This is the only Aelia-specific code in the system. Lives entirely under
`lib/connectors/woocommerce/` and is invisible to the rest of IMS.

### 7.1 The companion WP plugin

Add a second PHP plugin alongside `wc-invoice-buttons.php`:

```
lib/connectors/woocommerce/oti-fx-rates.php
```

It does two things:

1. Exposes a REST endpoint `POST /wp-json/oti/v1/fx-rates` that accepts the rate
   payload from IMS, authenticated with the existing
   `WC_WEBHOOK_SECRET` (HMAC of body, same scheme webhooks use).
2. Registers itself as an Aelia exchange-rates provider via
   `wc_aelia_currencyswitcher_exchange_rates_models` so Aelia reads its rates
   from a transient that the REST endpoint writes.

Why a custom Aelia provider rather than directly poking
`wc_aelia_cs_settings`: the option layout is internal and changes between Aelia
versions. The provider hook is the public, stable API.

### 7.2 IMS-side adapter

`lib/connectors/woocommerce/fx-rates.ts`:

```ts
export async function pushFxRates(rates: FxRatePush[]) {
  const cfg = await loadWooConfig()
  if (!cfg.fxRatesEnabled) return { supported: false, pushed: 0, errors: [] }

  const body = JSON.stringify(rates)
  const signature = hmacSha256(body, cfg.webhookSecret)
  const res = await fetch(`${cfg.url}/wp-json/oti/v1/fx-rates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-OTI-Signature': signature },
    body,
  })
  // ...
}
```

The IMS code never names "Aelia". Switching to CURCY or another plugin only
requires updating the companion PHP plugin to register against that plugin's
filter — the IMS payload, endpoint and signature stay identical.

### 7.3 Aelia gotchas to handle in PHP

- Aelia caches rates aggressively; after writing the transient call
  `WC_Aelia_CurrencySwitcher::reset_settings_cache()`.
- Aelia rounding: store rates with 8 decimals to match `Decimal(18,8)` in
  Prisma; let Aelia round for display.
- Aelia inverts the rate direction if the shop base currency differs from IMS
  base — invert in PHP, not in IMS.

---

## 8. Xero adapter changes

Currently `lib/connectors/xero/invoices.ts` posts invoices without explicitly
sending `CurrencyRate`, so Xero applies its own daily XE rate. Change:

1. Read `fxRateToBase` from the IMS document.
2. Pass it through the new `InvoiceData.currencyRate` field.
3. In the Xero adapter, set `CurrencyRate` on the API call — inverting the
   number if needed (Xero: "1 unit of doc currency in base"; IMS stores
   "1 unit of base in doc currency"). Add a unit test for the inversion.

Same change for `bills.ts` and `credit-notes.ts`.

QuickBooks adapter (when added) does the same thing into its `ExchangeRate`
field.

---

## 9. Read API for other consumers

Useful even outside the connector flow (reports, ad-hoc scripts, future
integrations). Add `GET /api/fx-rates/current` returning the latest set, gated
by the same auth as other internal API routes. This is *not* the path the
companion WP plugin uses — keep that one push-based so the WP side stays a
dumb consumer.

---

## 10. Admin UI

Under **Settings → Financial → FX Rates** (new tab):

- Table of latest rates (currency, rate, fetched at, source).
- Per-currency manual override (`manualOverride = true`, with effective-from
  date).
- Last push status per connector, pulled from `FxRatePushLog`.
- "Push now" button — manual fan-out trigger for testing.

All of this uses existing patterns — Shadcn `Table`, dialog form for the manual
override (per the dialog-forms feedback rule).

---

## 11. Rollout

1. **Phase 1 — schema & xero stamping.** ✅ **Shipped in 1.7.2** (commits
   `5e5b8be` + `c34f4d1`). `currencyRateToBase` added to `InvoiceData` /
   `BillData` / `CreditNoteData`. Xero adapter inverts to `CurrencyRate` at
   6dp. Stamped at every queue site: WooCommerce import, manual sales invoice,
   sales credit note, purchase invoice. QuickBooks adapter ignores the field
   for now. Outcome: IMS and Xero now agree on every multi-currency document.
2. **Phase 2 — companion WP plugin + IMS push.** ✅ **Shipped in 1.7.3.**
   - Unified PHP plugin **onetwoInventory Helper** at `lib/connectors/woocommerce/wp-plugin/onetwoinventory-helper.php`. Rolls up the old `wc-invoice-buttons.php` (now removed) plus a new FX rate receiver module.
   - REST endpoint `POST /wp-json/oti/v1/fx-rates` validated with HMAC-SHA256 (shared secret = `WC_WEBHOOK_SECRET`, pasted in via the plugin's settings page).
   - Aelia integration via the `wc_aelia_currencyswitcher_exchange_rate` filter (cross-version safe; no dependency on Aelia's internal class hierarchy). Resolves direct/inverse/cross rates.
   - IMS-side `pushFxRatesToWc()` adapter, plus generic `pushFxRates` capability on the `ShoppingConnector` interface.
   - FX cron (`/api/cron/fx-rates`) fans out to the WC connector after each successful inbound fetch, behind `wc_fx_push_enabled` setting.
   - Installable from the IMS WC sync page: a "Download plugin (.zip)" button serves a hand-rolled STORED zip via `/api/woocommerce/helper-plugin`.
4. **Phase 4 — admin UI + manual override.** Ship the settings tab.
5. **Phase 5 — production cutover.** Disable Aelia's built-in providers,
   switch to OTI provider, monitor `FxRatePushLog` for a week.

Each phase is independently shippable.

---

## 12. Testing

- **Unit:** rate inversion (Xero direction), HMAC signature, Aelia provider
  payload shape.
- **Integration:** spin up a WP container with Aelia + the companion plugin in
  `e2e/`, push a rate, assert Aelia returns it.
- **Manual:** post a multi-currency invoice through the full flow (WC checkout
  → IMS sales order → Xero invoice) and assert all three records carry the
  same rate to 8 dp.
- **Reconciliation report:** add a row to the existing sync-health page that
  flags any document where IMS `fxRateToBase` differs from the rate Xero
  reports back on the synced invoice.

---

## 13. Open questions

- **Manual override scope** — does an override apply only to new documents from
  that point, or retroactively recompute? Strong default: only new documents,
  to keep historical reports stable.
- **Aelia "geolocation pricing"** — Aelia can apply a fixed markup per
  currency. The IMS rate should ignore markup; the markup stays an Aelia-only
  concept. Document this in the settings UI.
- **Frankfurter outage** — current cron silently keeps yesterday's rate. Add
  an alert when `fetchedAt` is older than 36 h.
- **Non-base sales** — if a customer pays in a currency that isn't ECB-quoted
  against GBP (e.g. exotic), frankfurter returns no rate. Plan: surface in the
  admin UI as "missing rate, manual entry required" rather than silently
  defaulting.
