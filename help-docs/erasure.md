# Personal-data erasure

This page says what an erasure removes, what it keeps, and where it **cannot** reach. Erasure in IMS is not total, and the gaps below are part of the feature, not omissions.

## When an erasure happens

- **WooCommerce first, IMS mirrors it.** When WooCommerce anonymises an order (a customer's request, or WooCommerce's own scheduled anonymisation), IMS detects it and erases the same order. IMS has **no separate schedule** of its own: it erases when WooCommerce does. The record shows the trigger as *mirrored from storefront*.
- **On request in IMS.** **GDPR Anonymise** on a contact (Sales > Contacts) erases the customer and every order linked to them. The record shows the trigger as *on request*. This does **not** touch the storefront: erase it in WooCommerce too.
- An order that arrives *after* its customer was erased is created already erased.
- An erasure is all or nothing. If any part cannot be completed it is rolled back and reported, so there is never a half-erased order.

## What is erased

Names, email addresses, phone numbers, company, VAT numbers, billing and shipping addresses, order notes and internal notes, tracking numbers, the storefront customer id and order key, and the same details wherever IMS copied them: queued and sent email addresses, the stored copies of WooCommerce and warehouse payloads, accounting payload copies, activity-log rows about the customer or order, and notifications about the order. Waiting emails to the person are cancelled.

## What is kept, for six years

Order totals, tax, lines, currency, the ledger and Xero document ids, the **issued invoice PDF** and the refund reason text. These are the legal VAT record. The invoice PDF still shows the name it was issued under.

Ledger copies keep what the ledger holds: an accounting event or sync row for a posted document keeps its contact **name** (the email is removed); one that never posted gets the placeholder name.

## What each external system still holds (the per-system verdicts)

The erasure record (Settings > **Erasure records**, administrators only) shows one verdict per system. IMS makes **no write** to any external system for an erasure.

| System | Verdict | What it means |
|---|---|---|
| Storefront (WooCommerce) | *Erased at source* | WooCommerce anonymised first and IMS mirrored it. |
| | *Not attempted* | The erasure was requested in IMS. Erase the customer in WooCommerce too. |
| Accounting (Xero) | *Left untouched, pending legal ruling* | The Xero **contact** (name and email) is left as it is. A contact's name shows on every historical invoice, including those inside the six-year VAT retention, so renaming it would alter records that must stay intact. This waits for the accountant or DPO. Documents posted after the erasure carry the placeholder name and no email. |
| Warehouse (Mintsoft) | *Not written; handle by hand* | At least one of the person's orders is still **open** (sent to the warehouse, not wholly despatched, not cancelled). An order with a pending shipment, or one that has shipped only in part, is open. It still holds the name and address, and IMS will not rewrite a live warehouse order. |
| | *Cannot be erased there* | Only despatched orders: Mintsoft has no erase function. Nothing more can be done in IMS. |
| | *Not written; handle by hand* (also) | An order whose warehouse create was sent but whose outcome IMS never recorded may exist in the warehouse. It is listed as **unverified**: check it there and handle it by hand if it exists. |
| | *Nothing held* | No order of this person reached the warehouse (nothing was ever sent). |
| Carrier portal (Click & Drop) | *Not attempted* | IMS has no Click & Drop integration and holds none of its data. A removal there is outside IMS. |

### Open warehouse orders: what you must do

The moment an erasure leaves open warehouse orders, the operator who ran it is warned (the dialog stays open with the count), and a notification is raised for everyone. The record lists each open order by **warehouse order number**. Open the order in Mintsoft and change or cancel it by hand. The same applies when WooCommerce's anonymisation is mirrored.

## What erasure does not reach

- **Backups.** Erasure covers the live systems. Backups, on this server and off-site, age out on their normal schedule and still contain the erased data. **Restoring a backup brings erased data back.** After any restore, repeat the erasures made since that backup was taken: keep a note of such requests outside IMS, because the records are part of what a restore replaces.
- **Files already downloaded.** A CSV export or invoice PDF that someone saved is outside IMS.
- **Email already sent.** A message on the wire cannot be recalled.
- **Rows that mention the person but are keyed to something else.** A free-text note on another record cannot be found by key.
- **Mailing suppressions.** A bounced or complained address is stored in the suppression list. An erasure **deletes** the suppression rows for the person's addresses: owner ruling. If the address bounces again it is suppressed again.

## Retention settings are not erasure

The **Data retention** settings only delete operational history or *hide* old orders, purchase orders and customers; they never erase a name or address. See [Settings](settings.md).
