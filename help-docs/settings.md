# Settings

Settings are organised in the sidebar by function. Some sections, such as **Accounting**, only appear when the related integration plugin is enabled.

## Company Settings

Found at **Settings > Company**, this is where you configure your organisation's core details and branding.

### Company Details

- **Company name** and **legal name**
- **VAT number** and **company number**
- **Address** (used on documents and invoices)
- **Contact information**
- **Base currency** — set this once during initial setup. After live data exists, changing it requires a database reset.

Base-currency amounts throughout the app use the configured currency's display style, including whether the symbol appears before or after the amount.

### Logos

Upload two logos for use across the system:

- **Icon logo** — a square image used in the sidebar and on the login page
- **Document logo** — a rectangular image used in PDF headers (invoices, sales orders, etc.)

### Branding

Customise the look of the application and your documents:

- **Primary colour** — sets the title bar colour
- **Accent colour** — sets the table header colour

A live preview updates as you adjust colours, so you can see the result before saving.

### Document Numbering

Configure the prefix and padding for auto-generated document numbers:

| Document Type | Example |
|---|---|
| Sales Order | SO-00001 |
| Purchase Order | PO-00001 |
| Invoice | INV-00001 |
| Credit Note | CN-00001 |

Set your preferred prefix (e.g. `SO`, `INV`) and padding length (e.g. 5 digits) for each type.

### Email / SMTP

Configure outbound email for sending documents and notifications:

- **SMTP host**, **port**, and **security** (TLS/SSL)
- **Credentials** (username and password)
- **From name** and **from email address**
- **Reply-to address**

### Department Emails

Set dedicated email addresses for each department. These appear on the relevant documents:

- **Sales email** — shown on invoices and sales orders
- **Purchases email** — shown on purchase orders and RFQs
- **Support email** — for general enquiries

### Document Templates

Configure templates for seven document types:

- Sales Order
- Purchase Order
- Invoice
- Packing Slip
- Credit Note
- RFQ (Request for Quotation)
- Manufacturing Order

Each template supports:

- **Header note** — text displayed at the top of the document
- **Footer note** — text displayed at the bottom of the document body
- **Terms & conditions** — printed on the document
- **Custom page footer** — appears at the very bottom of each page
- **Show logo** toggle
- **Show VAT** toggle
- **Show payment terms** toggle

Use the **PDF preview** and **Email preview** buttons to see how your template looks with sample data. Previews open in a new tab.

## Inventory Settings

Found at **Settings > Inventory**, this section includes:

- **Warehouses** — create and edit warehouses, default sales/returns warehouses, and store-sync eligibility when a shopping connector is enabled
- **Product Categories** — manage the reporting category tree. Add top-level categories or sub-categories under any node; rename inline; move a subtree under a new parent (cycles are prevented); delete a node to promote its children one level up and reassign its products to the parent. The same leaf name can be reused under different parents — for example `Apparel > T-Shirts` and `Promo > T-Shirts` are distinct. WooCommerce product sync mirrors the WC category tree into this list automatically, so connected stores stay in step without manual entry.
- **Stock adjustment reasons** — define selectable reasons for manual stock adjustments
- **Accounting mapping** — when an accounting connector is enabled, each adjustment reason can be linked to an account code

## Sales Settings

Set the **invoice generation trigger** to control when invoices are created automatically:

- **Manual** — generate invoices yourself
- **On ship** — invoice created when the order is shipped
- **On paid** — invoice created when the order is fully paid

### Dispatch Email

Toggle the dispatch email for direct (non-storefront) orders (off by default). When enabled, customers of direct orders receive a branded dispatch notification with the dispatched items, carrier, tracking number(s), and a tracking link when their order ships — queued at most once per order. Storefront orders are always excluded so the storefront's own dispatch email is not duplicated.

### Delivery Tracking

Toggle the delivery tracking module on or off. When enabled:

- **Source** — choose between WooCommerce (AST plugin) or TrackShip API direct
- **Shipping carriers** — configure which carriers are available in the carrier dropdown when shipping orders. Pre-populated with common carriers: Royal Mail, DPD, DHL, FedEx, UPS, Hermes/Evri, Yodel, Parcelforce, TNT, Amazon Logistics, GLS, USPS, and more.
- **Tracking links** — when delivery tracking is enabled, tracking numbers become clickable links that open the carrier's tracking website. A 17track fallback is used for carriers without a dedicated tracking URL.
- **Delivery status cron** — the endpoint `/api/cron/delivery-status` polls for delivery status updates on a schedule.
- The **DELIVERED** order status becomes available in the order workflow.

## Purchasing Settings

- **Purchase units** — define units of measure with conversion factors (e.g. 1 case = 12 units)
- **Landed cost distribution method** — choose how landed costs are allocated across purchase order lines

## Accounting Settings

This section only appears when an accounting plugin is enabled.

- **Financial year start** — set your financial year start date (UK format)
- **VAT rates** — manage VAT rate profiles (see below)
- **Currencies & FX rates** — add currencies and manage exchange rates
- **Exchange-rate source** (Accounting → FX Rates) — `ECB (frankfurter)` (default) or `Aelia`. With Aelia, IMS reads the store's currency switcher rates (the rate before Aelia's markup; the markup is never stored) instead of fetching frankfurter, health judges Aelia's freshness, and the IMS → WooCommerce rate push is disabled (helper plugin 1.3.0 also refuses every rate push itself, HTTP 410 `oti_fx_push_retired`; IMS logs it once as SKIPPED and does not retry). Choosing Aelia reads the store first and is refused (the source stays ECB, the card says why) unless every enabled currency has a rate from that read. Needs the onetwoInventory Helper plugin 1.3.0 or later deployed on the store first (owner-approved); see `docs/woocommerce.md`
- **FX rate schedule** — enable automatic exchange rate updates, set the update interval, or trigger an immediate update with the **Update Now** button
- **Reverse-charge accounting tax types** — connector-specific tax codes that IMS swaps in for any line whose `TaxRate.reverseCharge` is true. Configure `accounting_reverse_charge_sales_tax_type` (typical Xero: `ECOUTPUTSERVICES`) and `accounting_reverse_charge_purchase_tax_type` (typical Xero: `REVERSECHARGES`). Empty values disable the swap — the line posts with the parent `TaxRate.accountingTaxType` and is not flagged as reverse-charge on the VAT return.

The organisation base currency is not changed here. It is defined in **Settings > Company** and is treated as a one-time setup choice for a live system.

### VAT rate profiles

A VAT rate row in Settings > Accounting > VAT rates is a **tax profile**, not just a single percent. Each row carries:

| Field | Purpose |
|---|---|
| **Name** | The label shown on order/bill line dropdowns. |
| **Rate** | The effective rate stamped on document lines. Auto-computed from components if any are configured; otherwise hand-entered. |
| **Accounting tax type** | The tax code IMS sends to the accounting connector (e.g. Xero `OUTPUT2`, QBO `TAX_RATE_ID`) on every line that uses this rate. |
| **Country code** | ISO 3166-1 alpha-2; null = applies globally as a fallback. |
| **Used for** | `SALES`, `PURCHASE`, or `BOTH`. Filters which dropdowns the rate appears in. |
| **Compound** | When true, line totals apply this rate on top of the previous tax — see Components below. |
| **Reverse charge** | When true, IMS swaps the connector-side tax type on every line using this rate to the configured `accounting_reverse_charge_{sales,purchase}_tax_type` setting, so the VAT return classifies it on box 1 / box 8. The customer is not charged VAT (rate is 0 or the document posts at zero). |
| **Reporting category** | One of `DOMESTIC`, `REVERSE_CHARGE`, `EC_SALES`, `OSS`. Used to group/filter the VAT analytics report. Does not change accounting posting. |
| **Components** | Ordered breakdown for compound or multi-element taxes (e.g. Canada `GST 5% + PST 7%`). See below. |

#### Tax components (compound + multi-element)

When a jurisdiction layers multiple taxes onto the same goods value (e.g. Canada GST + PST, India IGST split), add the components in **Settings > Accounting > VAT rates > Edit > Components**. Each component carries:

- **Name** (e.g. `GST`, `PST`)
- **Rate** as a decimal (e.g. `0.05` for 5%)
- **Compound on previous** — when true, this component's rate applies to the running total (gross + previous components), not the goods value. So `GST 5%` non-compound followed by `PST 7%` compound yields `5% + 7%×(1+5%) = 12.35%` effective.
- **Accounting tax type** — connector-specific code for THIS component on the accounting side.
- **Sort order** — components apply in this order; the math is order-sensitive when any component is compound.

IMS computes the **effective rate** from the active components automatically and stamps it on every document line that uses the parent rate. The per-component breakdown is NOT pushed as separate invoice lines (that would either double-count goods or distort per-component tax bases). Instead:

- If the active accounting connector is **Xero**, IMS auto-syncs the components to a matching Xero `TaxRate` via the `TaxRate.TaxComponents` API on every save (gated by `xero_sync_tax_rate` setting). Xero then handles the component-level VAT-return reporting. The push is idempotent: matching by `Name`, unchanged re-saves are no-ops.
- If the active connector is **QuickBooks**, the IMS Activity log records a `tax_rate_sync_skipped_unsupported_connector` WARNING — there is no equivalent QBO API, so the operator must configure the equivalent tax codes manually.
- Until the sync completes, IMS emits a `sales_invoice_tax_components_not_pushed` (sales) or `purchase_invoice_tax_components_not_pushed` (purchases) WARNING on the relevant order or bill, naming the affected rate.

#### Reverse charge

Setting `TaxRate.reverseCharge` to true changes how IMS posts the line to the accounting system:

- The line's `taxType` is swapped to `settings.reverseChargeSalesTaxType` (sales) or `settings.reverseChargePurchaseTaxType` (purchases) so the accounting system tags the line for reverse-charge VAT return treatment.
- The IMS-side tax computation is unaffected (rate stays as configured — usually `0` for reverse-charge B2B services).
- The reporting category should be set to `REVERSE_CHARGE` so the VAT analytics report groups it separately from domestic sales.

If the reverse-charge tax type settings are empty, IMS falls back to the parent `TaxRate.accountingTaxType` — the line still posts but is not flagged as reverse-charge on the accounting side.

### Import purchase tax rates from Xero

**Where:** **Settings > Accounting > Tax**, below the rates table. Xero is the tax-rate master, so IMS can create its own **Purchases** rates from the copy of Xero's tax-rate list that the hourly `xero-tax-rate-drift` job stores (the button never calls Xero and never writes to it).

- **Preview** shows what **Import** would do and writes nothing; always preview first.
- **Import** creates, for each of `INPUT2` (20% VAT on expenses), `ZERORATEDINPUT` and `NONE` that has no active rate usable for purchases, one active **Purchases** rate with Xero's name, rate and tax type. A type that Xero does not list as active, or does not allow on expenses, is refused by name and no rate is created. Running it again changes nothing.
- Import also creates the missing **Sales** rates (`OUTPUT2`, `ZERORATEDOUTPUT` and Xero's other revenue-only rates), so IMS mirrors Xero's rates: each IMS rate is one active Xero tax type with Xero's percentage.
- **Also replace rates whose percentage differs from Xero's** (off by default): a differing rate is always listed; with the box ticked a new rate is created and the old one deactivated (never edited; the default rate is skipped). Rates with no Xero tax type (for example per-country rates) are listed as having no counterpart.
- **Also narrow "Both" rates whose Xero tax type is sales-only to Sales** (off by default): a rate such as *UK VAT* (`OUTPUT2`) then stops appearing on purchases. Only done together with a complete set of purchase rates.
- **Also deactivate rates whose tax type Xero does not list as active** (off by default): for example the `TAX001`...`TAX032` country rates left over from a demo organisation. Without the box they are only listed. The default rate is never deactivated.
- Nothing is deleted and no existing rate's percentage or tax type is changed (documents refer to them). It needs a stored list read within the last 26 hours for the organisation connected now; otherwise it says why (`XERO_LIST_STALE`, `XERO_LIST_MISSING`, ...).

### Re-key VAT rates to the Xero organisation's tax codes

**Where:** **Settings > Accounting > Tax**, below the import panel. **Why:** Xero numbers its *custom* tax codes (`TAX001`, `TAX002` ...) **per organisation**, in the order they were created there. IMS's per-country VAT rates (*CY VAT*, *BE VAT* ...) were created against a Demo organisation, so their codes are the Demo organisation's numbers. In the live organisation the same codes mean other rates (for example live `TAX005` is *BG VAT* where IMS's `TAX005` is *CY VAT*). IMS posts a line's code, so a sale on IMS *CY VAT* would post to Xero as BG VAT. This section ties each such rate to the live Xero type of the **same name**; it never matches by code.

- **Only before go-live.** The Apply is refused while Xero writes are not held (the panel says so): the producer-side hold must be enforced for Xero and Xero must not be live (no write grant, no live-from date). That is what guarantees no payload built around the re-key can reach Xero.
- **Preview** (read only) lists, for every active rate whose code is not a Xero built-in (`OUTPUT2`, `INPUT2`, `NONE` ...), one outcome: **ALREADY_CORRECT** (the code is already the same-named live type), **REKEY** (one live type has the same name, status Active, exactly the same percentage and a consistent country, under another code), **NO_MATCH**, **AMBIGUOUS** (more than one active live type has the name; nothing is guessed), **PERCENTAGE_DIFFERS** (the name matches but the percentage does not; both are shown and the rate is not re-keyed), **SIDE_NOT_ALLOWED** (Xero does not allow the live type on revenue / expenses, which the rate is used for), **MEANING_DIFFERS** (same percentage but a different component breakdown or a non-recoverable component), **COUNTRY_DIFFERS** (the name matches but the country in the Xero name, in the IMS name and on the IMS rate do not all agree, ignoring capital letters), **REPORT_TYPE_DIFFERS** (the live type files to another VAT-return box than IMS assigns the rate, for example an EU sale that Xero would report as plain Output instead of MOSS Sales; both are shown) and **REPORT_TYPE_UNKNOWN** (the box cannot be decided) and **NAME_MATCHES_INACTIVE**. Names are compared trimmed, with runs of spaces collapsed, and case-sensitive first, then case-insensitive; the row says which matched. A region in the name (`PT-30 VAT`) must agree, and one that cannot be read (`PT Madeira VAT`) is shown as **COUNTRY_DIFFERS**. The percentage is Xero's *EffectiveRate* (else *DisplayTaxRate*), compared exactly, against the rate and the percentage tax is computed at.
- **Apply the previewed plan** needs the **plan digest** the preview showed: the rates, their matches, the counts of documents, suppliers and mappings and your choices are bound to it, and if any of them changed it refuses and you preview again (it does not bind every detail copied to the new rate, such as the reverse-charge or compounding flag: those are protected by row locks while the Apply runs). In one transaction it creates, for each REKEY, a **new** rate with the live code and the old rate's name, percentage, use, country, category, flags and components; the old rate is only **deactivated** (it is never edited: documents refer to it); the supplier default tax rate and the WooCommerce rate mappings move to the new rate. A second run finds nothing to do.
- **No half-done Apply.** If any rate with a custom code has no matching live type, the Apply is refused and lists them. Tick *Also clear rates with no matching live type* (and preview again) to retire them: each is replaced by a rate with **no tax code** and documents on it will refuse to post until you map the new rate to a Xero tax type in this table. Nothing is posted with the old Demo code or with a default.
- **Documents.** Every not-cancelled order or purchase order that references a re-keyed rate can still post its code (the first invoice or bill, an edit or re-send, a credit note, a refund, a further bill for a part-billed purchase order), whether or not it has posted before, so the Apply is **refused** while any exist, with their counts split into never-posted and already-posted; tick *Also re-point the lines of orders and purchase orders that can still post* to move their lines to the new rate (same name, percentage, sides and component breakdown, so the same tax meaning and no amount changes; a posted Xero document then receives the new code on its next update, which is a correction of the other organisation's number). Refund lines on refunds whose credit note has **not posted** store their own tax code (chosen when the refund was made, and preferred when the credit note is built or retried), with no queued payload to stop it: they also refuse the Apply and, with the same tick, are migrated to the new code only when every other rate that carries the old code, active or not, means exactly the same (name, percentage, component breakdown, country, side, compounding, reverse charge, reporting category); otherwise the Apply is refused with no override. Documents and payloads that already went to Xero are not touched; cancelled orders and purchase orders are always moved to the new rate too and never block the Apply (nothing posted changes, and a storefront status change can reopen them). A payload **already queued** to Xero with the old code (a pending, processing or **failed** sync row) is a snapshot IMS does not rewrite: the Apply is always refused, with no override, until it has posted or been cancelled; a failed row keeps blocking until it is retried or cancelled. A component of the old rate that carries its own custom code which is not a live active type gets no code on the new rate (listed in the preview).
- A rate the Apply replaced shows as *Replaced by ... (read-only)* and cannot be reactivated or edited; edit the replacement. While an Apply runs, saving an edit of an active rate waits for it, and an edit saved just before it makes the Apply ask you to preview again.
- After the Apply, a form that was open beforehand and still holds the old rate is handled by the system: the old rate is replaced by the new one on save (same name and percentage). A rate that was simply switched off is refused on a new record with a clear message.
- It also refuses when two rates would be tied to one live type, or when the live type's code is already carried by another active rate that stays.
- It reads the stored copy of Xero's list (proven first, as for the import above) and never calls Xero. The same function is `npm run tax:rekey` on the server (see the installation guide). Afterwards run **Compare VAT rates**: a re-keyed rate no longer shows a percentage mismatch with Xero.

### VAT rate differences (Xero, IMS, WooCommerce)

**Where:** **Settings > Accounting > Tax**, below the import panel. The three systems must use the **same set of VAT rates** and **Xero is the master**. **Compare VAT rates** reads Xero's stored tax-rate list (Xero is not called), the IMS rates and their WooCommerce mappings, and WooCommerce's tax rates (read only, every page), and lists each difference with a reason: a rate missing in IMS, Xero or WooCommerce, a percentage that differs (both values are shown), a Xero type that is inactive, an IMS rate with no Xero type, a WooCommerce rate with no IMS mapping, an ambiguous mapping, or a country, class, compound or shipping setting that does not match. It changes nothing in any system.

- **Four reports, one per VAT scheme.** Tabs: **UK VAT**, **IOSS VAT**, **VOEC (Norway) VAT** and **Other foreign VAT** (EU OSS and any other foreign registration). Each rate is placed by its reporting category, its country and Xero's report type (hover a reason to see the rule). An EU-country rate is **Other foreign (EU OSS)** by default and goes to **IOSS** only when its reporting category is set to `IOSS`. A rate whose scheme still cannot be told (a conflicting or unknown reporting category, or a rate with no country and a MOSS report type) is never hidden: it is listed in the **Unclassified** section below the tabs with the reason, and you classify it by setting the rate's reporting category (`OSS`, `IOSS` or `VOEC`).
- **Sales and purchases are judged separately.** A Xero type counts as present in IMS on a side only if an active rate used for that side carries it (a Sales-only rate switched to Purchases is no longer the sales rate, and a WooCommerce rate mapped to it is a difference).
- **Shipping.** Shipping always carries the VAT rate of the goods, so a WooCommerce rate above zero that does not apply to shipping is a difference.
- **Regional rates are fine.** A WooCommerce rate limited to a state, postcode or city (for example the Canary Islands) is not a difference by itself. It is compared like any other rate against the IMS rate it is mapped to (percentage, class, compound, shipping, and the country, which must be equal); the region is shown in its own column for information.
- **At P1 you correct WooCommerce by hand.** IMS does not write WooCommerce tax rates yet (that is a later build, from P2). Open **WooCommerce > Settings > Tax**, change the rate or setting named in the row so it matches Xero, then run **Compare VAT rates** again until every tab says *no differences*. A row about IMS or Xero (for example a type missing in IMS) is fixed in IMS (Import purchase tax rates from Xero, above) or in Xero first.
- **A refusal is not "no differences".** If the stored Xero list is missing, stale or does not belong to the connected organisation, or WooCommerce cannot be read, the panel says why and compares nothing.
- The same report is available on the server as `npm run vat:diff` (`-- --scheme uk|ioss|voec|other|all`; see the installation guide).

### WooCommerce tax-rate writer (held until go-live)

**Where:** the server command `npm run woo:tax-plan` (there is no screen for it yet). WooCommerce, IMS and Xero must use the **same set of VAT rates**. Until go-live (P1) **you** maintain the WooCommerce tax rates by hand; from go-live (P2) IMS owns them. The writer is built but **held**: it plans, and while the WooCommerce hold is on it sends nothing.

- **Preview** (`npm run woo:tax-plan`): reads IMS and WooCommerce (read only) and lists the changes WooCommerce needs so that the VAT set check passes for it: **CREATE** a missing rate, **UPDATE** one whose name, percentage, country, region, class, compound or shipping differs, **DELETE** one that belongs to an inactive, purchase-only or reverse-charge IMS rate (or a second store rate for one IMS rate). Every change shows the before and after values. It ends with a **plan digest**. Nothing is written.
- **Shipping** always carries the VAT rate of the goods: a rate above zero is always created and updated with *apply to shipping* on. A 0% rate may keep it off.
- **Regions** (for example the Canary Islands or PT-30) are read from the end of the IMS rate name ("PT-30 VAT" is region 30). The writer sets or corrects a region; it never removes one, and it leaves a postcode or city on a store rate alone (IMS cannot record those): both show as findings for you to settle by hand.
- **What it may touch.** Only WooCommerce rates IMS **owns**: a rate mapped in the tax-rate mapping **and stamped with this store** (the web address configured in the WooCommerce settings), or one this writer created and recorded against this store. Mappings made before this rule, or against another store address, are not owned until you run the **adoption** step (below): the preview lists them as findings, and nothing is changed or created for them. A rate is also only changed or deleted while it still matches what IMS last recorded for it (name, country, percentage and class); if it differs, IMS did not cause it (an id reused by another rate, a rate re-purposed by hand), the preview says RE_ADOPTION_REQUIRED and the rate is left alone. Every other rate in the store is yours and is **never touched**; the preview only counts them. An unmapped store rate that looks like a rate it would create blocks the apply (map it to the IMS rate instead of creating a second one).
- **Apply** (`npm run woo:tax-plan -- --apply --confirm <digest>`): needs the digest the preview printed; if anything changed since, it refuses and you preview again. While the producer hold is on it records the planned changes as **shadows** and sends **nothing** (it is refused outright if the hold is not enforced). Only once WooCommerce is live and IMS owns tax rates does it send, one change at a time, recording each with its mapping row. Running it again then finds nothing to do.
- **Importing, re-mapping and re-keying end the stamp.** If you replace a WooCommerce rate by a different one and then **Import from store**, re-map a rate in the mapper, or run a tax re-key, the affected mapping loses its store stamp whenever its IMS rate or its name, country, percentage or class changed, and the writer treats it as not adopted until you adopt it again. An import that changes nothing keeps the stamp. A rate the writer deletes also loses its stamp (its mapping row stays for old orders), so if the store later reuses that id for another rate it is not touched until you adopt it.
- **Adoption** (`npm run woo:tax-plan -- --adopt`, then `-- --adopt --apply --confirm <digest>`): lists the mapping rows that are not stamped for this store, or whose rate changed since IMS last recorded it, with the recorded values and the live rate side by side. Applying it stamps them with this store and records the live rate as the new snapshot, so you are vouching that the live rate is the rate IMS means. It sends nothing to WooCommerce.
- The WooCommerce store must already have the tax classes it names (standard, zero-rate, reduced-rate, second-reduced-rate, exempt); it refuses a rate of a class it does not have and the run stops there.
- Afterwards run **Compare VAT rates** (or `npm run vat:diff`) to confirm the differences are gone.

### Generate missing accounting tax rates

**Where:** the VAT rates screen itself — **Settings > Accounting > Tax** (the same page where you add and enable/disable rates). When an accounting connector is connected, a **Generate missing rates** button appears next to **Add VAT Rate**. This complements the **Xero drift** chips on each rate ("no matching rate in Xero").

For every **active, unmapped** IMS rate (`accountingTaxType` blank) that has **no name-match** among the connector's existing rates, IMS can create the rate in the connector and write the returned tax type back onto the IMS rate. Rates that already name-match an existing connector rate are **skipped** (map those with the WooCommerce-connector tax-rate mapper's **Auto-apply** — no duplicates are created). Clicking the button first shows a **confirmation dialog** listing each rate to be created with its rate and report type; the **report type is a per-rate dropdown pre-filled with the default below** — change any of them before confirming. Nothing is written until you confirm.

- **Xero** — fully supported. Creates each rate via `POST /TaxRates` (mirroring any tax components) and sets `ReportTaxType` from the IMS `Reporting category` + `Used for`:

  | Reporting category | Used for | Xero ReportTaxType |
  |---|---|---|
  | `DOMESTIC` | SALES / BOTH | `OUTPUT` |
  | `DOMESTIC` | PURCHASE | `INPUT` |
  | `REVERSE_CHARGE` | any | `REVERSECHARGES` |
  | `EC_SALES` | SALES / BOTH | `ECOUTPUTSERVICES` |
  | `EC_SALES` | PURCHASE | `ECACQUISITIONS` |
  | `OSS` (non-EU / non-VOEC) **at 0%** | SALES / BOTH → `EXEMPTOUTPUT`, PURCHASE → `EXEMPTINPUT` | |
  | `OSS` (non-EU / non-VOEC) **charging VAT** | SALES / BOTH → `OUTPUT`, PURCHASE → `INPUT` | |
  | (unset) | SALES / BOTH → `OUTPUT`, PURCHASE → `INPUT` | |

  > Xero rejects the `NONE` report type when creating a rate ("not valid for this organisation"), so it is never used or offered.

  **EU / VOEC distance-selling override:** a **sales** rate whose **name starts with an EU member-state ISO code** (e.g. `DE Standard`, `FR 20%`; Greece as `GR` or `EL`) or a **VOEC** code (Norway `NO`) is an OSS/IOSS/VOEC distance sale and defaults to **`MOSSSALES`** ("MOSS Sales" in Xero). This overrides the category default above — except an explicit `REVERSE_CHARGE` (which still files to `REVERSECHARGES`) and purchase-only rates. OSS rates **outside** those schemes (e.g. Channel Islands `CI`, Isle of Man `IM`, Monaco `MC`) are treated as **exempt** (`EXEMPTOUTPUT` / `EXEMPTINPUT`) when they're 0% — Xero forbids a non-zero exempt rate, so any that still charge VAT fall back to `OUTPUT` / `INPUT`. The match is on a leading 2-letter token only, so `Deutschland` does not count as `DE`. Any of these can be changed per-rate in the confirmation dialog.

  The creation is idempotent — Xero keys by `Name`, so a rate that already exists is matched rather than duplicated. Each generate run is recorded in the Activity log (`xero_tax_rates_generated`); partial failures are reported per rate and don't roll back rates already created.

- **QuickBooks** — not supported (QBO has no programmatic tax-code creation on the public API). The action degrades gracefully: create the tax codes in QuickBooks, then use **Auto-apply** to map them.

## Backup & Restore

Full system backup and restore functionality is available for administrator-led backups and restores. See `docs/backup-restore.md` for the deployment-level details.

### Creating a backup

- **Manual** — click **Create Backup** in Settings > Backup. The system runs `pg_dump` in plain SQL format and saves a timestamped `.sql` file plus a `.manifest.json` sidecar that records schema version, the SQL filename, table names, and row counts.
- **Scheduled** — the `/api/cron/backup` cron endpoint runs `pg_dump` automatically. Configure your cron daemon to call this endpoint daily; we recommend an off-peak window (e.g. 02:00).

### Remote upload (S3 or SFTP)

Backups can be auto-uploaded to remote storage to keep them off the application server:

1. In Settings > Backup, choose **S3** or **SFTP** as the target.
2. Enter credentials and the target path.
3. Save settings. Every scheduled backup uploads both the `.sql` and `.manifest.json` files to the remote target.

If you have manual backups that should also go to remote storage, click **Upload to remote** on the backup row.

### Restore

Restoring is a destructive operation — it overwrites the current database with the contents of the backup file. The system protects this with several gates:

1. **Email confirmation code** — clicking Restore sends a 6-character code to your admin email. You must type it back into the form within 2 minutes. The code is bound to your current session and client IP, so a stolen code from a different network can't be used.
2. **Typed confirmation** — you must type the literal phrase shown on screen to proceed.
3. **Disk space check** — the system verifies enough free disk space before accepting the upload.
4. **Manifest validation** — for stored backups, the manifest sidecar is checked to ensure the file is a valid IMS backup with the four critical tables present (users, products, sales_orders, purchase_orders).
5. **File size cap** — uploads default to a 50MB max. Set the `DATABASE_RESTORE_MAX_FILE_BYTES` environment variable to raise the cap.

After restore, the system enters maintenance mode briefly while connections drain, then resumes normal operation.

### What to do before going live

- Test the backup/restore round-trip once on a staging environment.
- Schedule the backup cron and verify it runs successfully (check the Settings > System > Health page).
- Configure remote upload — local-only backups are vulnerable to the same incident that takes down the application server.

## User Management

Manage user accounts and roles from **Settings > Users**. See the [User Management & Security](user-management.md) guide for full details on roles and permissions.

### Password policy

When creating or updating a user password, the system enforces:

- Minimum **12 characters**
- At least one **uppercase letter**, one **lowercase letter**, one **number**, and one **symbol** (anything not alphanumeric)
- The password must not match a built-in deny-list of common weak passwords (e.g. `password123`, `Welcome2024!`)

If a password fails any check, the form returns a specific error message indicating which rule was violated. This policy applies in the UI, the CLI user-creation tool, and any API endpoints that create users.

### Activity-log redaction

The activity log automatically redacts sensitive data from log entries before they are stored:

- API tokens, OAuth secrets, and webhook secrets are replaced with `[REDACTED]`
- Database passwords and SMTP credentials are replaced
- Email content (for outbound notifications) is summarised, not stored verbatim

This means an admin viewing the activity log can see who did what but not see secret values, even if those values appeared in the error message of a failed operation.

## System Settings

- **Plugins** — enable or disable shopping/accounting connector plugins. Disabled plugins are hidden from menus and shared UI.
  - Some plugins are **mutually exclusive**: one WMS connector at a time. Saving is refused with "Enable one WMS connector at a time" rather than partially applied, and the refusal writes nothing at all, including the plugins in the same save that were individually fine. (There used to be a WooCommerce-or-Shopify pair and a Xero-or-QuickBooks pair as well; Shopify and QuickBooks were both removed in 2026-09, so WooCommerce and Xero are now the only connectors in their categories and have nothing to conflict with.)
  - The rule is checked against the state the save is about to *land on*, not the state the page was loaded with. If a second administrator enables the other connector of a pair while your form is open, your save is refused rather than silently producing a both-enabled system. Reload to see the current selection before choosing again.
  - Saves are applied as one all-or-nothing change and are serialised against anything that acts on which connector is active (notably cancelling stranded accounting sync rows), so no other part of the system can observe a half-switched selection.
- **Scheduler** — configure the public app URL used for external callbacks and manage scheduled jobs
- **Activity log retention** — set how many days to keep log entries, configurable per log level
- **Data retention** — configure archival/deletion windows for operational records. Accounting sync entries that are still **pending, in progress or failed** are exempt from the age-based deletion: they are unfinished work rather than history, their payload is what a retry posts, and deleting one while a worker is holding it would land a document in the accounting system that nothing in IMS records. They expire normally once they settle (synced or cancelled), so the way to clear them is to resolve them on the Accounting Sync page. One further exemption is in force, and the retention screen shows it: the **webhook events** window compacts processed shopping-webhook rows (it clears the stored payload and keeps the row as a duplicate-delivery tombstone), but WooCommerce **order** deliveries — all of them, at any age — are held back from it while `o3d-j7y4` is open. Their payloads are the only evidence of whether the store stated a currency on orders imported before IMS began requiring one, and emptying one destroys that evidence permanently. Product deliveries — the bulk of the inbox — compact exactly as before, and lowering the window does not reach the held-back orders. There is no automatic expiry: a version that stopped at a recorded cutoff was tried and withdrawn, because it saved nothing until a full retention window had passed and could be made to say the wrong thing in the one direction that destroys evidence for good. The exemption therefore grows while it is on, and it ends when the issue closes. The notice beside the setting states how many payloads are being kept alive *solely* by the exemption (held, past your window, and otherwise due for clearing), the total number of order deliveries still carrying a payload, and the issue that lifts it.
- Two kinds of
  record are compacted rather than deleted at the end of their window, because deleting them would
  break something that cannot be reconstructed: webhook events — both shopping and warehouse
  (the row is the idempotency record) — and accounting sync rows whose back-reference is still
  unresolved (the row is the only
  evidence of which accounting document an unlinked order or bill belongs to, and deleting a
  competing one would silently turn a refused-because-ambiguous attribution into a wrong answer). In
  both cases the *content* — payloads, error text, and the customer details and financial lines they
  contain — is cleared on schedule; only the small identifying record is kept.
  Nothing that is still **unresolved** is cleared at all. A warehouse event that failed and was
  dead-lettered, or that is waiting for you to approve it, keeps its full payload however old it
  gets — that payload is what a replay re-attempts, so clearing it would turn a problem you can
  still fix into one you cannot. The same applies to sync runs: **WMS Sync Runs** deletes finished
  runs and their per-item lines, but never a run that has not finished, and never the dry run an
  unconfirmed "Align To WMS" binding is still waiting on — that one run is kept until you confirm
  or change the binding, and the rest of that warehouse's runs expire normally.
  On **Xero**, a compacted accounting sync row is **still repaired**: the repair sweep can still
  write its external id onto the order or bill, because everything that write needs survives
  compaction. What cannot survive is the follow-up work built from the payload (invoice PDF, payment
  registration, bill attachment). If the sweep repairs one of these rows — or if you retry one by hand
  from the Accounting Sync page, which settles it against the id it already has rather than
  re-sending it — a WARNING is written to the activity log
  (`xero_backreference_followups_discarded`) naming the document, so you can check whether its PDF or
  payment is missing and re-drive it by hand. In both cases the row is settled only once that warning
  has been written, so a retry can never turn one of these rows green without saying what it lost. On **QuickBooks** there is
  deliberately no repair sweep at all — a QuickBooks document id is a per-company integer, so a sweep
  could not tell a previously connected company's id from the current one's — and an unresolved row
  is compacted on the same schedule but only ever links by hand. See *Back-Reference Repair* in the
  accounting sync guide. A row can fall under both rules at once (a failed sync that already has an
  accounting document id): it is kept for the retry AND has its content cleared on schedule, which is
  safe because a document that already posted is never re-sent — only its follow-ups are re-driven.
  One further set of accounting sync rows is **never deleted by age at all**: registered invoice
  payments, applied supplier-credit-note allocations and sent bill payments (`INVOICE_PAYMENT`,
  `PURCHASE_CREDIT_NOTE_ALLOCATION`, `BILL_PAYMENT`). For those, the row's existence *is* the record
  that the money movement already happened — it is what stops the same payment or allocation being
  sent to the ledger a second time, and for an imported order it is the only such record anywhere.
  Xero's own duplicate protection expires six minutes after the original call, so nothing at the far
  end would catch the repeat. These rows hold only external ids, a bank account id, an amount, a date
  and a reference — no customer names, addresses or line detail — and there is one per payment or
  allocation ever made. Everything else, including invoice PDFs, emails and WooCommerce notes,
  expires on the schedule you configure.
- **System health** — at-a-glance status of FX sync, accounting sync, integration outbox depth, recent cron runs, and invariant check results
- **Database reset** — reset system data with three levels of severity:
  - **Transactions only** — clears orders, invoices, and movements but keeps products and settings
  - **Products** — clears products and all related data
  - **Full reset** — returns the system to a blank state

All reset options require a typed confirmation to prevent accidental data loss.

If you need to change the organisation base currency after setup, use a database reset and reconfigure the system from scratch.

### Cron jobs

The system relies on scheduled jobs to keep external systems in sync and to maintain data hygiene. Each cron endpoint requires the `CRON_SECRET` bearer header in the request:

| Cron endpoint | Purpose | Typical cadence |
|---|---|---|
| `/api/cron/fx-rates` | Fetch exchange rates from frankfurter.dev (or, with the Aelia FX source, read them from Aelia) | Daily |
| `/api/cron/wc-reconcile` | WooCommerce reconciliation + stock catch-up | Daily |
| `/api/cron/accounting-daily-batch` | Xero sub-ledger A1/A2/B journals | Daily |
| `/api/cron/accounting-sync` | Drain pending accounting sync queue | Every 5 min |
| `/api/cron/accounting-payment-poll` | Detect paid invoices via Xero bank feed | Every 15 min |
| `/api/cron/accounting-fx-revaluation` | Unrealised FX on open AR/AP | Daily |
| `/api/cron/delivery-status` | Tracking provider polling | Every 15 min |
| `/api/cron/account-balance-snapshot` | Xero account balance snapshots | Daily |
| `/api/cron/invariant-check` | Scheduled data-integrity check | Daily |
| `/api/cron/backup` | Database backup | Daily |
| `/api/cron/product-lifecycle-archive` | Auto-archive exhausted EOL products | Daily |
| `/api/cron/reconciliation-pack` | Run the reconciliation pack on a schedule and record every start in the activity log. **Off by default**; refuses to run until a phase is set; reads no vendor unless its separate WooCommerce option is on (also off by default). See "Scheduling the pack" in docs/installation.md | Daily at 03:00 once switched on |
| `/api/cron/mintsoft-webhook-sweeper` | Drain Mintsoft webhook events | Every 5 min |
| `/api/cron/mintsoft-dispatch-sync` | Poll Mintsoft for despatches of orders IMS has pushed and progress the IMS shipment and tracking. Reads from Mintsoft only and never logs in (use a fixed API key; with username and password it skips once the stored key has expired). On by default | Every 15 min |
| `/api/cron/wms-order-push` | Push paid, ready-to-fulfil orders for WMS-bound warehouses to the WMS, and propagate cancellations (Phase 8 dispatch). **Off by default** | Every 10 min |
| `/api/cron/wms-order-status` | Refresh cached WMS order statuses that power the sales-list status chips | Every 15 min |
| `/api/cron/mintsoft-stock-sync` | Poll Mintsoft warehouse stock and queue discrepancy handling for bound warehouses | Hourly |
| `/api/cron/mintsoft-returns-sync` | Poll the Mintsoft returns feed and stage items for review | Hourly |
| `/api/cron/mintsoft-product-verify` | Check Mintsoft product/barcode mappings against IMS products | Daily |
| `/api/cron/mintsoft-bundle-verify` | Check KIT composition against the linked Mintsoft bundle | Daily |
| `/api/cron/email-outbox` | Send queued emails | Hourly |
| `/api/cron/activity-cleanup` | Trim old activity log entries | Daily |

### Cron rate limits

Each cron endpoint has a per-hour quota to prevent accidental over-invocation. The defaults match the expected cadence with headroom for jitter:

- Daily and hourly jobs: 1/hour
- 5-minute crons: 12-15/hour (depending on the job)
- 15-minute crons: 4-6/hour

If your cron daemon retries on transient errors and the underlying issue resolves itself, the legitimate next-tick run may be denied with HTTP 429. Adjust your cron daemon's retry policy or contact your system administrator.

For multi-instance deployments (multiple application replicas behind a load balancer), set `RATE_LIMIT_BACKEND=redis` and `REDIS_URL` so the rate limit is shared across replicas. The default in-memory backend doesn't share state.

### Invariant check

The system runs a periodic invariant check that scans inventory, accounting, and sales data for known drift conditions (negative stock, orphan cost layers, refund-status mismatches, etc.). Critical findings trigger an admin notification.

You can also run the check manually:

```bash
npm run invariant-check:preflight
```

This is the same check that runs in CI on every PR — it validates that the data shape matches the system's invariants.
