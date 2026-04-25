# Unified FX rates — production cutover runbook

This is Phase 5 of `docs/todo/unified-fx-rates-plan.md`. Phases 1–4 land the
code; this document is what an operator runs to switch a live tenant from
each system using its own rate source to the single IMS rate.

## Pre-flight (in IMS)

1. **Confirm IMS is the source of truth.** Settings → Accounting → FX Rates
   should show:
   - Last ECB fetch within the last 36 hours (no stale warning).
   - One row per active non-base currency, all with source `ECB (frankfurter)`.
   - Zero (or known/expected) manual overrides.

2. **Confirm Xero is already aligned (Phase 1).** Pull a recent multi-currency
   invoice from Xero and check `CurrencyRate` is set on the document. If the
   field is blank, IMS posted before Phase 1 — those documents will keep their
   Xero-default rate. New documents are fine.

## Install the helper plugin (in WordPress admin)

3. In IMS, go to **Sync → WooCommerce → Connection** and click
   **Download plugin (.zip)**.
4. In WordPress admin, go to **Plugins → Add New → Upload Plugin**, choose the
   zip, and click **Install Now → Activate**.
5. WordPress admin → **Settings → onetwoInventory** — paste the same shared
   secret used for WooCommerce webhooks. Save.

## Probe the connection (in IMS)

6. In IMS, go to **Settings → Accounting → FX Rates** and click
   **Probe helper plugin**. You want:
   - `OK (HTTP 401) — Helper plugin is installed and the FX endpoint is wired.`
   That 401 is the success response; it proves the plugin received the request
   and rejected the deliberately-invalid signature.
7. If you see `BAD_SECRET` or `NOT_INSTALLED`, fix that on the WordPress side
   first. Don't enable push until the probe is green.

## Aelia handover (in WordPress admin)

8. WooCommerce → **Settings → Currency Switcher Options → Currencies** (Aelia).
9. For each non-base currency, **set the per-currency exchange rate provider
   to "Manual" or to the OTI provider** (the helper plugin's filter takes
   effect automatically once IMS pushes a rate, but the explicit "Manual"
   choice prevents Aelia falling back to its own provider on cache miss).
10. Disable any **scheduled rate updates** in Aelia's settings. The helper
    plugin will keep rates fresh from IMS instead.

## Enable the push (in IMS)

11. **Sync → WooCommerce → Connection → onetwoInventory Helper plugin** card:
    tick **Push FX rates daily** and click **Push Now**.
12. Wait ~2 seconds. The Last push timestamp should update to "just now" with
    a "Pushed N rate(s)" success message.
13. Refresh **Settings → Accounting → FX Rates**. The Recent Pushes table
    should show one new `OK` row.
14. (Optional) In WordPress admin, refresh **Settings → onetwoInventory**.
    The Current rates table should reflect the same rates IMS just pushed.

## Smoke test (in WooCommerce)

15. On the WooCommerce storefront, switch the displayed currency to a non-base
    one and confirm the converted price equals `base_price × IMS_rate` to
    within rounding tolerance. (Compare against the value shown in the IMS FX
    Rates table.)
16. Place a tiny test order in the foreign currency. Confirm:
    - The WC order total in foreign currency matches the IMS sales order's
      `totalForeign`.
    - The IMS sales order's `totalBase = totalForeign / fxRateToBase` matches
      the Xero invoice's base-currency total to the penny.

## First-week monitoring

17. The FX cron runs daily. After each run check **Settings → Accounting →
    FX Rates → Recent pushes** — every entry should be `OK`. Investigate any
    `FAILED` entry by reading the error column (likely WC URL change, secret
    rotation, or plugin deactivation).
18. Watch the Integration health card on the same page. If either timestamp
    flips amber, follow the warning text.
19. After 7 days of green pushes, Phase 5 is complete. Close the parent bd
    issue (`onetwo3d-ims-5mp`).

## Rollback

If the integration misbehaves:

1. **In IMS**, untick **Push FX rates daily** in the WC sync page. The cron
   will stop pushing immediately.
2. **In WordPress**, deactivate the onetwoInventory Helper plugin. Aelia
   reverts to whatever provider was previously configured.
3. IMS continues to stamp `CurrencyRate` on Xero documents (Phase 1) — that
   side is unaffected by rolling back the WC push.

## What can go wrong, and how to read it

| Symptom in IMS | Likely cause | Fix |
|---|---|---|
| Probe → `NOT_INSTALLED` | Plugin not active in WP | Activate in Plugins screen |
| Probe → `BAD_SECRET` (401, oti_fx_no_secret) | Plugin active but secret blank | Paste secret in WP admin → Settings → onetwoInventory |
| Probe → `BAD_SECRET` (200) | Plugin version skew — signature check bypassed | Re-download plugin zip from IMS, reinstall |
| Probe → `UNREACHABLE` | DNS / firewall / wrong store URL | Verify wc_url in IMS Sync settings |
| Push log shows `FAILED` with `HTTP 401` | Secret rotated on one side | Generate new webhook secret in IMS, re-paste in WP plugin |
| Health card shows "Last ECB fetch" stale | Cron not running | Check `/api/cron/fx-rates` is in the schedule |
| Health card shows "Last WC push" stale (push enabled) | Inbound fetch cron skipped fan-out, or WC unreachable | Check most recent FxRatePushLog row + activity log |
