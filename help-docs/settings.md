# Settings

Settings are organised in the sidebar by function: **Company**, **Inventory**, **Sales**, **Purchasing**, **Accounting**, **Users**, **Backup & Restore**, **Erasure records** and **System**. Settings are for administrators. **Accounting** only appears when the accounting integration is enabled. Connector credentials and sync screens are not under Settings: they are on the **Integrations** item in the sidebar (which itself only appears once at least one integration is switched on in **Settings > System > Plugins**).

Some changes are sensitive (users, backups and restores, connector credentials, database reset). When you make one, IMS may ask you to confirm it is you: a **Confirm it's you** box asks for your password (and your authenticator code if you use two-factor authentication). Destructive actions also open a confirmation box, which can ask you to type a name or tick a box saying you have checked the other system. See [User Management & Security](user-management.md).

## Company Settings

Found at **Settings > Company**, this is where you configure your organisation's core details and branding. The page has five tabs: **Company Details**, **Branding**, **Numbering**, **Email** and **Documents**.

### Company Details

- **Company name** and **legal name**
- **VAT number** and **company number**
- **Address** (used on documents and invoices)
- **Contact information**
- **Timezone** — the organisation's timezone (for example `Europe/London`; the list is every timezone your browser supports). Dates and times across the app and on documents are shown in this timezone, so everyone sees the same times whatever their own computer is set to. If it is left blank, `Europe/London` is used. Set it once during setup (it is also a field of the Company step of the setup wizard).
- **Base currency** — set this once during initial setup. After live data exists, changing it requires a database reset.

Base-currency amounts throughout the app use the configured currency's display style, including whether the symbol appears before or after the amount.

### Logos

Upload two logos for use across the system:

- **Icon logo** — a square image used in the sidebar and on the login page
- **Document logo** — a rectangular image used in PDF headers (invoices, sales orders, etc.)

### Branding

Customise the look of the application and your documents:

- **Primary colour** — the title bar colour on PDF documents
- **Accent colour** — table headers and highlights on PDF documents

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

Use **Test SMTP** to send a test email to the **Test Email Recipient** (pre-filled with your own address) using the values currently typed on the screen, before you save them.

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

Toggle the dispatch email for direct (non-storefront) orders (off by default). When enabled, customers of direct orders receive a branded dispatch notification with the dispatched items, carrier, tracking number(s), and a tracking link when their order ships — queued at most once per order, and only for an order with a customer email address that is at **Shipped** status when the email is queued (an older order that a later sweep reprocesses does not get a late email). Storefront orders are always excluded so the storefront's own dispatch email is not duplicated.

### Delivery Tracking

Shown when the WooCommerce integration is enabled. Toggle the delivery tracking module on or off. When enabled:

- **Source** — choose between WooCommerce (AST plugin) or TrackShip API direct
- **Shipping carriers** — configure which carriers are available in the carrier dropdown when shipping orders. Pre-populated with common carriers: Royal Mail, DPD, DHL, FedEx, UPS, Hermes/Evri, Yodel, Parcelforce, TNT, Amazon Logistics, GLS, USPS, and more.
- **Tracking links** — when delivery tracking is enabled, tracking numbers become clickable links that open the carrier's tracking website. A 17track fallback is used for carriers without a dedicated tracking URL.
- **Delivery status cron** — the endpoint `/api/cron/delivery-status` polls for delivery status updates on a schedule.
- The **DELIVERED** order status becomes available in the order workflow.

### Recent tax-rate fallbacks and invoice PDF signals

Two read-only lists sit at the bottom of **Settings > Sales**:

- **Recent Tax Rate Fallbacks** — recent events where a line's tax rate could not be matched and a fallback was used or blocked. Use it to find the rate that needs mapping (see [Troubleshooting](troubleshooting.md)).
- **Recent Invoice PDF Token Security Signals** — orders whose customer invoice PDF link was used from a copied session or a changed address. An unexpected entry is worth a look; an empty list is normal.

## Purchasing Settings

- **Purchase units** — define units of measure with conversion factors (e.g. 1 case = 12 units)
- **Landed cost distribution method** — choose how landed costs are allocated across purchase order lines

## Accounting Settings

This section only appears when an accounting plugin is enabled.

- **Financial year start** — set your financial year start date (UK format)
The page has four tabs: **Financial Year**, **Tax**, **Currencies** and **FX Rates**.

- **Financial year start** (Financial Year tab) — set your financial year start date (UK format)
- **VAT rates** (Tax tab) — manage VAT rate profiles (see below)
- **Currencies** (Currencies tab) — add and manage the currencies you trade in. The base currency cannot be removed.
- **FX Rates** (FX Rates tab) — the current exchange rate per currency (pin a **manual override** with the pencil icon, clear it to go back to the fetched rate), the log of recent pushes to the store, and an **Integration health** card (last fetch, last fetch attempt, last WooCommerce push, currencies under manual override, and a **Probe helper plugin** button that checks the onetwoInventory Helper plugin is reachable).
- **Exchange-rate source** (FX Rates tab) — `ECB (frankfurter)` is the default and what you should leave selected: IMS fetches the daily European Central Bank rates for its own use. It does not push them to the store: helper plugin 1.3.0 refuses rate pushes, and the store's currency switcher owns the storefront rates. An `Aelia` option (read the rates from the store's currency switcher instead) exists on the same card but is **not yet switched on**: it needs the onetwoInventory Helper plugin 1.3.0 or later deployed on the store first and the owner's go-ahead, so do not choose it until you are told to. The card asks you to confirm before it switches.
- **FX rate schedule** (Currencies tab) — shows when rates were last updated and has the **Update Now** button for an immediate update. Whether the automatic update runs, and when, is set on the **FX Rate Update** job in **Settings > System > Scheduler** (daily at 07:00 by default).
- **Reverse-charge accounting tax types** — connector-specific tax codes that IMS swaps in for any line whose `TaxRate.reverseCharge` is true. Configure `accounting_reverse_charge_sales_tax_type` (typical Xero: `ECOUTPUTSERVICES`) and `accounting_reverse_charge_purchase_tax_type` (typical Xero: `REVERSECHARGES`). Empty values disable the swap — the line posts with the parent `TaxRate.accountingTaxType` and is not flagged as reverse-charge on the VAT return.

The organisation base currency is not changed here. It is defined in **Settings > Company** and is treated as a one-time setup choice for a live system.

### Tax-rate drift (rates edited directly in Xero)

An hourly check compares the active IMS tax rates with the live Xero rates. A rate that no longer matches shows a **Xero drift** chip in the rates table on **Settings > Accounting > Tax** ("No matching rate in Xero" or "Differs from the live Xero rate", with the differing values on hover), and the **Integrations** page shows an amber banner ("N tax rates differ from the live Xero definition") with a **Review VAT rates** button. Until you reconcile, **the next invoice posts with the IMS-side numbers**, so fix the rate (in IMS or in Xero, whichever is wrong) before it goes out. The check only alerts; it never edits either side.

### VAT rate profiles

A VAT rate row on **Settings > Accounting > Tax** is a **tax profile**, not just a single percent. Each row carries:

| Field | Purpose |
|---|---|
| **Name** | The label shown on order/bill line dropdowns. |
| **Rate** | The effective rate stamped on document lines. Auto-computed from components if any are configured; otherwise hand-entered. |
| **Accounting tax type** | The tax code IMS sends to Xero (e.g. `OUTPUT2`) on every line that uses this rate. A sales invoice or credit note line with no tax type is refused, never posted as "No VAT" (see [Xero Accounting Sync](xero-sync.md)). |
| **Country code** | ISO 3166-1 alpha-2; null = applies globally as a fallback. |
| **Used for** | `SALES`, `PURCHASE`, or `BOTH`. Filters which dropdowns the rate appears in. |
| **Compound** | When true, line totals apply this rate on top of the previous tax — see Components below. |
| **Reverse charge** | When true, IMS swaps the connector-side tax type on every line using this rate to the configured `accounting_reverse_charge_{sales,purchase}_tax_type` setting, so the VAT return classifies it on box 1 / box 8. The customer is not charged VAT (rate is 0 or the document posts at zero). |
| **Reporting category** | The rate editor offers None, Domestic, Reverse charge, EC sales and OSS. Used to group/filter the VAT analytics report and to place the rate in the right tab of the VAT rate differences report; the Xero report type that **Generate missing rates** picks also follows it. Two more categories, **IOSS** and **VOEC**, exist for EU and Norway sales collected at the till under those schemes; they are set by the EU VAT set-up done by an administrator, not chosen in the editor (see "EU IOSS / VOEC" below). |
| **Components** | Ordered breakdown for compound or multi-element taxes (e.g. Canada `GST 5% + PST 7%`). See below. |

#### Tax components (compound + multi-element)

When a jurisdiction layers multiple taxes onto the same goods value (e.g. Canada GST + PST, India IGST split), add the components in **Settings > Accounting > Tax**, **Edit** the rate, **Tax Components**. Each component carries:

- **Name** (e.g. `GST`, `PST`)
- **Rate** as a decimal (e.g. `0.05` for 5%)
- **Compound on previous** — when true, this component's rate applies to the running total (gross + previous components), not the goods value. So `GST 5%` non-compound followed by `PST 7%` compound yields `5% + 7%×(1+5%) = 12.35%` effective.
- **Accounting tax type** — connector-specific code for THIS component on the accounting side.
- **Sort order** — components apply in this order; the math is order-sensitive when any component is compound.

IMS computes the **effective rate** from the active components automatically and stamps it on every document line that uses the parent rate. The per-component breakdown is NOT pushed as separate invoice lines (that would either double-count goods or distort per-component tax bases). Instead:

- With the **Xero** connector, IMS auto-syncs the components to a matching Xero `TaxRate` via the `TaxRate.TaxComponents` API on every save (when the Xero tax-rate sync is switched on). Xero then handles the component-level VAT-return reporting. The push is idempotent: matching by `Name`, unchanged re-saves are no-ops.
- Until the sync completes, IMS emits a `sales_invoice_tax_components_not_pushed` (sales) or `purchase_invoice_tax_components_not_pushed` (purchases) WARNING on the relevant order or bill, naming the affected rate.

#### Reverse charge

Setting `TaxRate.reverseCharge` to true changes how IMS posts the line to the accounting system:

- The line's `taxType` is swapped to `settings.reverseChargeSalesTaxType` (sales) or `settings.reverseChargePurchaseTaxType` (purchases) so the accounting system tags the line for reverse-charge VAT return treatment.
- The IMS-side tax computation is unaffected (rate stays as configured — usually `0` for reverse-charge B2B services).
- The reporting category should be set to `REVERSE_CHARGE` so the VAT analytics report groups it separately from domestic sales.

If the reverse-charge tax type settings are empty, IMS falls back to the parent `TaxRate.accountingTaxType` — the line still posts but is not flagged as reverse-charge on the accounting side.

### EU IOSS / VOEC and EU VAT regime (set-up only, not yet switched on)

IMS holds the configuration for treating EU (IOSS), Norway (VOEC) and delivered-duty-paid EU sales separately: a second, zero-rated Xero tax type per scheme rate, three further Xero account roles on the Xero connector's account mapping (**EU IOSS/VOEC VAT collected**, **EU DDP charges collected**, **EU landed-cost fees**; leave them blank until told otherwise), and a credit-note hold threshold (the first few credit notes on the plugin's refund rate are to be held for a person to check; a stored setting with no screen yet). This is **configuration only and not yet switched on**: no posted invoice line, total or credit note changes because of it, and IMS does not yet decide or record an order's EU VAT regime on any document. The detail, for the person doing the set-up, is in [Xero Accounting Sync](xero-sync.md).

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
- It reads the stored copy of Xero's list (proven first, as for the import above) and never calls Xero. Your system administrator can also run the same function from the server. Afterwards run **Compare VAT rates**: a re-keyed rate no longer shows a percentage mismatch with Xero.

### VAT rate differences (Xero, IMS, WooCommerce)

**Where:** **Settings > Accounting > Tax**, below the re-key panel. The three systems must use the **same set of VAT rates** and **Xero is the master**. **Compare VAT rates** reads Xero's stored tax-rate list (Xero is not called), the IMS rates and their WooCommerce mappings, and WooCommerce's tax rates (read only, every page), and lists each difference with a reason: a rate missing in IMS, Xero or WooCommerce, a percentage that differs (both values are shown), a Xero type that is inactive, an IMS rate with no Xero type, a WooCommerce rate with no IMS mapping, an ambiguous mapping, or a country, class, compound or shipping setting that does not match. It changes nothing in any system.

- **Four reports, one per VAT scheme.** Tabs: **UK VAT**, **IOSS VAT**, **VOEC (Norway) VAT** and **Other foreign VAT** (EU OSS and any other foreign registration). Each rate is placed by its reporting category, its country and Xero's report type (hover a reason to see the rule). An EU-country rate is **Other foreign (EU OSS)** by default and goes to **IOSS** only when its reporting category is set to `IOSS`. A rate whose scheme still cannot be told (a conflicting or unknown reporting category, or a rate with no country and a MOSS report type) is never hidden: it is listed in the **Unclassified** section below the tabs with the reason, and you classify it by setting the rate's reporting category (**OSS** in the rate editor; the IOSS and VOEC markers come from the EU VAT set-up).
- **Sales and purchases are judged separately.** A Xero type counts as present in IMS on a side only if an active rate used for that side carries it (a Sales-only rate switched to Purchases is no longer the sales rate, and a WooCommerce rate mapped to it is a difference).
- **Shipping.** Shipping always carries the VAT rate of the goods, so a WooCommerce rate above zero that does not apply to shipping is a difference.
- **Regional rates are fine.** A WooCommerce rate limited to a state, postcode or city (for example the Canary Islands) is not a difference by itself. It is compared like any other rate against the IMS rate it is mapped to (percentage, class, compound, shipping, and the country, which must be equal); the region is shown in its own column for information.
- **Until go-live you correct WooCommerce by hand.** IMS does not write WooCommerce tax rates yet. Open **WooCommerce > Settings > Tax**, change the rate or setting named in the row so it matches Xero, then run **Compare VAT rates** again until every tab says *no differences*. A row about IMS or Xero (for example a type missing in IMS) is fixed in IMS (Import purchase tax rates from Xero, above) or in Xero first.
- **A refusal is not "no differences".** If the stored Xero list is missing, stale or does not belong to the connected organisation, or WooCommerce cannot be read, the panel says why and compares nothing.
- Your system administrator can also run the same report from the server.

### WooCommerce tax-rate writer (not yet switched on)

WooCommerce, IMS and Xero must use the **same set of VAT rates**, with Xero as the master. Until go-live **you** maintain the WooCommerce tax rates by hand (**WooCommerce > Settings > Tax**), using **Compare VAT rates** above to see what to change. A writer that would let IMS maintain the WooCommerce rates is built but **held**: it has no screen, it is not yet switched on, and nothing in IMS creates, changes or deletes a WooCommerce tax rate. It will be announced here when it is.

### Generate missing accounting tax rates

**Where:** the VAT rates screen itself — **Settings > Accounting > Tax** (the same page where you add and enable/disable rates). When an accounting connector is connected, a **Generate missing rates** button appears next to **Add VAT Rate**. This complements the **Xero drift** chips on each rate ("no matching rate in Xero").

For every **active, unmapped** IMS rate (`accountingTaxType` blank) that has **no name-match** among the connector's existing rates, IMS can create the rate in the connector and write the returned tax type back onto the IMS rate. Rates that already name-match an existing connector rate are **skipped** (map those with the WooCommerce-connector tax-rate mapper's **Auto-apply** — no duplicates are created). Clicking the button first shows a **confirmation dialog** listing each rate to be created with its rate and report type; the **report type is a per-rate dropdown pre-filled with the default below** — change any of them before confirming. Nothing is written until you confirm.

Creates each rate via `POST /TaxRates` (mirroring any tax components) and sets `ReportTaxType` from the IMS `Reporting category` + `Used for`:

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

## Backup & Restore

Full system backup and restore functionality is available for administrator-led backups and restores. See `docs/backup-restore.md` for the deployment-level details. **Settings > Backup & Restore** has three tabs: **Backup & Restore** (create, upload, restore and delete backups), **Scheduler** (the automatic backup schedule) and **Storage** (the S3 and SFTP targets). Creating, restoring and deleting backups are sensitive actions, so you may be asked to **Confirm it's you** with your password first.

### Creating a backup

- **Manual** — click **Create Backup** on the **Backup & Restore** tab. The system runs `pg_dump` in plain SQL format and saves a timestamped `.sql` file plus a `.manifest.json` sidecar that records schema version, the SQL filename, table names, and row counts.
- **Scheduled** — on the **Scheduler** tab, switch on **Enable scheduled backups**, set **Retention (days)** (default 30, older backups are deleted), **Max backups** (default 10, the oldest beyond this are deleted) and **Auto-upload** (None, S3 or SFTP), then **Save**. Saving also updates the scheduler. The time of day is the **Database Backup** job on **Settings > System > Scheduler** (daily at 01:00 by default; scheduled backups are **off until you switch them on**). Pick an off-peak window.

### Remote upload (S3 or SFTP)

Backups can be uploaded to remote storage to keep them off the application server:

1. On the **Storage** tab, fill in the **S3 Compatible Storage** card (endpoint (blank for AWS S3), region, bucket, access key, secret key, optional path prefix) or the **SFTP Server** card (host, port, username, password or private key, **Host Fingerprint** (required, it pins the server's identity so a wrong host is refused) and remote path) and save it. Changing an S3 endpoint or the SFTP host or fingerprint changes where backups are sent, so check the values first.
2. On the **Scheduler** tab, set **Auto-upload** to **S3** or **SFTP**. Every scheduled backup then uploads both the `.sql` and `.manifest.json` files.

For a backup you made by hand, use the cloud icon (**Upload to S3**) or the server icon (**Upload via SFTP**) on its row.

### Deleting a backup

Each backup row ends with a **Delete** button, kept apart from the Restore icon. Deleting is permanent and does not touch copies already uploaded to S3 or SFTP, so it asks you to confirm: the dialog names the backup file, its size and date, tells you if it is the newest backup, and enables **Delete backup** only after you type the backup file name exactly.

### Restore

Restoring is a destructive operation — it overwrites the current database with the contents of the backup file. Use the restore icon on a backup row, or **Restore from File** to upload a `.sql` backup **and its manifest file**. The system protects this with several gates:

1. **Email confirmation code** — opening the restore box sends a 6-character code to your admin email (use **Resend code** if it does not arrive). You must type it back into the form within 2 minutes. The code is bound to your current session and client IP, so a stolen code from a different network can't be used.
2. **Typed confirmation** — you must type `RESTORE` to proceed.
3. **Disk space check** — the system verifies enough free disk space before accepting the upload.
4. **Manifest validation** — the manifest sidecar is checked to ensure the file is a valid IMS backup with the four critical tables present (users, products, sales_orders, purchase_orders).
5. **File size cap** — uploads default to a 50MB max. Set the `DATABASE_RESTORE_MAX_FILE_BYTES` environment variable to raise the cap.

After restore, the system enters maintenance mode briefly while connections drain, then resumes normal operation. A restore brings back anything that was erased after the backup was taken: see [Personal-data erasure](erasure.md).

### What to do before going live

- Test the backup/restore round-trip once on a staging environment.
- Switch on scheduled backups and verify one runs successfully (the new backup appears in the list, and the **Activity** page records it under the `system` tag).
- Configure remote upload — local-only backups are vulnerable to the same incident that takes down the application server.

## User Management

Manage user accounts and roles from **Settings > Users** (**Add User**, edit and delete icons on each row). Creating, changing or deleting a user asks you to re-enter your password first (**Confirm it's you**). See the [User Management & Security](user-management.md) guide for full details on roles and permissions.

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

## Erasure records

**Settings > Erasure records** (administrators only) lists every personal-data erasure with proof of what was done and what each external system still holds. It never shows the erased values. Search by request id, or filter to the records that still need warehouse orders handled by hand. See [Personal-data erasure](erasure.md).

## System Settings

**Settings > System** has five tabs: **Releases** (the current version, what changed and the release history), **Plugins**, **Scheduler**, **Data Retention** (which also holds the activity-log retention) and **Database Reset**.

- **Plugins** — enable or disable shopping/accounting connector plugins. Disabled plugins are hidden from menus and shared UI.
  - Each plugin has a switch, and **Save & Apply** at the bottom saves the selection and updates the scheduler's crontab to match. If the selection saves but the crontab could not be updated, an amber message says so and tells you what to do; the selection itself is kept.
  - Some plugins are **mutually exclusive**: one WMS connector at a time. Saving is refused with "Enable one WMS connector at a time" rather than partially applied, and the refusal writes nothing at all, including the plugins in the same save that were individually fine. (Shopify and QuickBooks were removed in 2026-09: WooCommerce is the only shopping connector and Xero the only accounting connector, so they have nothing to conflict with.)
  - The rule is checked against the state the save is about to *land on*, not the state the page was loaded with. If a second administrator enables the other connector of a pair while your form is open, your save is refused rather than silently producing a both-enabled system. Reload to see the current selection before choosing again.
  - Saves are applied as one all-or-nothing change and are serialised against anything that acts on which connector is active (notably cancelling stranded accounting sync rows), so no other part of the system can observe a half-switched selection.
- **Scheduler** — the **Public URL** card and the list of scheduled jobs (see [Cron jobs](#cron-jobs) below).
  - **Public App URL** is the address used for external callbacks and for the scheduled jobs. It must be a plain `https://` address (`http://` is accepted only for `localhost`, `127.0.0.1` or `[::1]`) with no spaces, credentials (`user:password@`), query (`?...`), fragment (`#...`) or shell characters such as quotes, `$` or backticks, because it is written into the scheduler's crontab. Anything else is refused when you save it with a message saying so, and a bad value that is already stored stops the crontab being written until it is corrected. The screen suggests the address you are browsing from when none is set. The same field is in the Company step of the setup wizard.
  - Every save on this tab (the Public App URL, the job list, or **Plugins**) uses **Save & Apply**, which also rewrites the scheduler's crontab. If the settings saved but the crontab could not be updated, an amber message says so and nothing is lost. A red box at the top of the tab ("Scheduler crontab needs attention") says when the crontab is missing, was edited by hand, or carries an out-of-date secret; **Save & Apply** repairs it. On a containerised install the host owns the crontab and the tab says so.
- **Activity log retention** (Data Retention tab) — set how many days to keep log entries, per log level (defaults: Info 30, Warning 60, Error 90; 0 keeps them for ever)
- **Data retention** (Data Retention tab) — configure archival/deletion windows, in months, for operational records. Defaults: sales orders, purchase orders, customers and stock movements **0 (off)**; sync logs 6; webhook events 3; WMS inbound events 3; WMS sync runs 12. Accounting sync entries that are still **pending, in progress or failed** are exempt from the age-based deletion: they are unfinished work rather than history, their payload is what a retry posts, and deleting one while a worker is holding it would land a document in the accounting system that nothing in IMS records. They expire normally once they settle (synced or cancelled), so the way to clear them is to resolve them on the Accounting Sync page. One further exemption is in force, and the retention screen shows it: the **webhook events** window compacts processed shopping-webhook rows (it clears the stored payload and keeps the row as a duplicate-delivery tombstone), but WooCommerce **order** deliveries — all of them, at any age — are held back from it while an evidence hold is in force. Their payloads are the only evidence of whether the store stated a currency on orders imported before IMS began requiring one, and emptying one destroys that evidence permanently. Product deliveries — the bulk of the inbox — compact exactly as before, and lowering the window does not reach the held-back orders. There is no automatic expiry: a version that stopped at a recorded cutoff was tried and withdrawn, because it saved nothing until a full retention window had passed and could be made to say the wrong thing in the one direction that destroys evidence for good. The exemption therefore grows while it is on, and it ends when the hold is lifted. The notice beside the setting states how many payloads are being kept alive *solely* by the exemption (held, past your window, and otherwise due for clearing), the total number of order deliveries still carrying a payload, and what lifts it.
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
  **What each retention setting destroys, and what it only hides.**
  - *Destroys* (rows are deleted): sync logs, stock movements (old ones), finished WMS sync runs, and activity-log entries by level.
  - *Compacts* (the row stays, its content is cleared): shopping and warehouse webhook events, and accounting sync rows whose back-reference is still unresolved.
  - *Only hides* (the row is flagged archived and every value on it survives): **sales orders**, **purchase orders** and **customers**. Archiving removes them from lists. It does **not** erase a name, an address or an email.
  - **Customers are archived only when all of their orders are archived**, and orders are archived by the separate **sales orders** window (off by default). Turning on the customers window alone therefore does nothing at all: enable the sales-orders window first.
  - None of the retention settings erases personal data. That is done by the GDPR erasure, which follows WooCommerce's own anonymisation and the operator's **GDPR Anonymise** button: see [Personal-data erasure](erasure.md). IMS has no separate erasure schedule of its own.

- **Where to see health** — there is no single system-health page. FX freshness and the helper-plugin probe are on **Settings > Accounting > FX Rates** (Integration health card); failed and stuck sync work is on **Integrations** (banners at the top, the **Sync Exceptions** inbox and the **Event Timeline**); the scheduled checks below raise a notification (bell icon) to administrators when something needs attention; and the **Activity** page records every run.
- **Database reset** — reset system data with three levels of severity:
  - **Transactions only** — clears orders, invoices, and movements but keeps products and settings
  - **Products** — clears products and all related data
  - **Full reset** — returns the system to a blank state

All reset options require a typed confirmation to prevent accidental data loss.

If you need to change the organisation base currency after setup, use a database reset and reconfigure the system from scratch.

### Cron jobs

The system relies on scheduled jobs to keep external systems in sync and to maintain data hygiene. They are managed on **Settings > System > Scheduler**: each job has an on/off switch and a frequency, grouped by area (System, WooCommerce, Xero, Mintsoft and WMS groups only appear when that plugin is on). Change what you need and press **Save & Apply**; the system writes the schedule into the server's crontab. Each cron endpoint requires the `CRON_SECRET` bearer header in the request.

**After an upgrade, press Save & Apply once.** A job that is new in a release, or whose frequency changed, only reaches an existing crontab when you save the Scheduler. Since 2.0.0 this applies to **Mintsoft Despatch Poll** (`mintsoft-dispatch-sync`, every 15 minutes, new), **WooCommerce Reconcile** (`wc-reconcile`, now hourly instead of daily) and **Xero Chart of Accounts Refresh** (`xero-chart-sync`, new, daily at 00:30). The frequency boxes show the defaults below until you change them, and a fresh install's first crontab may use slightly different times until you save.

Defaults are what the Scheduler shows until you change them. "On" means switched on by default.

| Cron endpoint | Purpose | Default frequency | On by default |
|---|---|---|---|
| `/api/cron/fx-rates` | Fetch exchange rates from frankfurter.dev (the ECB rates) and replay any WooCommerce orders waiting for a rate. With the Aelia FX source (not yet switched on) it would read them from the store instead | Daily at 07:00 | On |
| `/api/cron/wc-reconcile` | WooCommerce backup reconciliation of orders and products and stock catch-up | Hourly | On |
| `/api/cron/wc-withdrawal-sweep` | Re-check every order IMS refused (EU withdrawal requests, orders held back by the status selection or an unmapped status) against the live store | Every 15 min | On |
| `/api/cron/shopping-webhook-inbox` | Process stored WooCommerce webhook events and retry queued "completed" pushes | Every 5 min | On |
| `/api/cron/accounting-sync` | Drain the pending accounting sync queue | Every 5 min | On |
| `/api/cron/accounting-payment-poll` | Detect paid invoices and bills in Xero | Every 15 min | On |
| `/api/cron/accounting-payment-reconcile` | Slow backlog check of every linked invoice and bill against its current Xero status (report only unless switched to apply) | Daily at 03:00 | On |
| `/api/cron/accounting-daily-batch` | Xero sub-ledger A1/A2/B journals | Daily at 02:00 | On |
| `/api/cron/xero-chart-sync` | Refresh the stored Xero chart of accounts (read only) before the balance snapshot | Daily at 00:30 | On |
| `/api/cron/account-balance-snapshot` | Xero account balance snapshots (needs the trial-balance permission; see [Xero Accounting Sync](xero-sync.md)) | Daily at 01:00 | On |
| `/api/cron/xero-tax-rate-drift` | Compare IMS tax rates with the live Xero rates and raise the drift alert | Hourly | On |
| `/api/cron/accounting-fx-revaluation` | Unrealised FX on open AR/AP | Daily | Not in the Scheduler list; schedule it from the server's own cron if you use accounting |
| `/api/cron/delivery-status` | Tracking provider polling | Every 15 min | On |
| `/api/cron/refund-reservation-release` | Safety net that releases stock reservations for refunded units | Every 15 min | On |
| `/api/cron/reallocation-sweep` | Re-run allocation for processing orders left short | Every 15 min | On |
| `/api/cron/invariant-check` | Scheduled data-integrity check (see below) | Daily at 04:00 | On |
| `/api/cron/read-sync-liveness` | Hourly check that every read feed that keeps IMS current (store order sweep, warehouse despatch poll and status refresh, account balance snapshots, tax rates, chart refresh) has succeeded recently; alerts administrators once per breach | Hourly (at :25) | On |
| `/api/cron/writers-check` | Hourly record of whether IMS and another system could both write the same thing; for the switchover only | Hourly (at :40) | Off |
| `/api/cron/invoice-documents` | Fetch the customer invoice PDF from the ledger for storefront orders after a set start date | Every 15 min | Off |
| `/api/cron/backup` | Database backup (also controlled from Backup & Restore) | Daily at 01:00 | Off until you switch it on |
| `/api/cron/product-lifecycle-archive` | Auto-archive exhausted EOL products | Daily at 00:30 | On |
| `/api/cron/recompute-product-lead-times` | Recompute each product's observed supplier lead time for Reorder Planning | Daily at 04:00 | On |
| `/api/cron/inventory-snapshot` | Daily on-hand quantity and value snapshots for inventory analytics | Daily at 00:00 | Off |
| `/api/cron/reconciliation-pack` | Run the reconciliation pack on a schedule and record every start in the activity log. Refuses to run until a phase is set; reads no vendor unless its separate WooCommerce option is on (also off). For the switchover; its options sit below the job list | Daily at 03:00 once switched on | Off |
| `/api/cron/activity-cleanup` | Trim old activity log entries | Daily at 03:00 | On |
| `/api/cron/mintsoft-webhook-sweeper` | Drain Mintsoft webhook events | Every 5 min | On |
| `/api/cron/mintsoft-dispatch-sync` | Poll Mintsoft for despatches of orders IMS has pushed and progress the IMS shipment and tracking. Reads from Mintsoft only and never logs in (use a fixed API key; with username and password it skips once the stored key has expired) | Every 15 min | On |
| `/api/cron/mintsoft-stock-sync` | Poll Mintsoft warehouse stock and queue discrepancy handling for bound warehouses | Hourly | Off |
| `/api/cron/mintsoft-returns-sync` | Poll the Mintsoft returns feed and stage items for review | Hourly (at :15) | Off |
| `/api/cron/mintsoft-product-verify` | Check Mintsoft product/barcode mappings against IMS products | Daily at 03:00 | Off |
| `/api/cron/mintsoft-bundle-verify` | Check KIT composition against the linked Mintsoft bundle | Daily at 03:30 | Off |
| `/api/cron/wms-order-push` | Push paid, ready-to-fulfil orders for WMS-bound warehouses to the WMS and propagate cancellations | Every 10 min | **Off** |
| `/api/cron/wms-order-status` | Refresh cached WMS order statuses that power the sales-list status chips | Every 15 min | Off |
| `/api/cron/wms-order-reconcile` | Daily order-level check of IMS against the WMS (orders never pushed, deleted in the WMS, cancelled but still active there) | Daily at 05:30 | Off |
| `/api/cron/wms-watchdog` | Hourly checks for purchase-order receipts overdue with no warehouse booking, and warehouse bindings whose stock sync went quiet; alerts administrators once per breach | Hourly (at :15) | On |
| `/api/cron/email-outbox` | Send queued emails | Hourly | Not in the Scheduler list; schedule it from the server's own cron |
| `/api/cron/hs-classify` | Background HS-code classification sweep | Every 15-30 min | Not in the Scheduler list; schedule it from the server's own cron |

The Mintsoft and WMS jobs are explained on [Warehouse (Mintsoft)](warehouse.md); the push, status and reconcile jobs only matter once you have bound a warehouse to the WMS.

### Cron rate limits

Each cron endpoint has a rate limit to prevent accidental over-invocation. It follows the job's frequency, with headroom for jitter and retries:

- Daily and hourly jobs: three runs per period (the scheduled run plus two spare)
- Jobs that run more often than hourly: the number of scheduled runs per hour plus a quarter (at least two) spare
- The jobs that call Xero are also held to a rolling daily run budget, so a leaked secret used from many addresses cannot multiply runs

If your cron daemon retries on transient errors and the underlying issue resolves itself, a further run in the same window may be denied with HTTP 429. Adjust your cron daemon's retry policy or contact your system administrator.

For multi-instance deployments (multiple application replicas behind a load balancer), set `RATE_LIMIT_BACKEND=redis` and `REDIS_URL` so the rate limit is shared across replicas. The default in-memory backend doesn't share state.

### Invariant check and other alerts

The system runs a daily invariant check (04:00 by default) that scans inventory, accounting, and sales data for known drift conditions (negative stock, orphan cost layers, refund-status mismatches, etc.). Critical findings send a **notification to administrators** (bell icon, top bar), and so do a short list of actionable warnings: stock whose cost layers do not add up, goods stranded in transit between warehouses, failed accounting postings, refunds whose credit note or reversal has not been sent to the ledger, and a refund reversal IMS cannot decide. A warning notifies only when it newly appears or its count rises since the previous complete run, so you are not told the same thing every day. Everything the check finds is also written to the **Activity** page.

Two hourly checks raise their own administrator notifications, once per problem rather than once per run:

- **Read-sync liveness** — a feed that keeps IMS current (storefront order sweep, warehouse despatch poll, WMS order-status refresh, Xero account balance snapshot, tax rates, chart of accounts) has not succeeded within its limit. A feed whose job is switched off is reported as off.
- **WMS watchdog** — a purchase-order receipt is overdue with no warehouse booking, or a warehouse binding's stock sync has gone quiet.

An administrator can also run the invariant check by hand from the server.
