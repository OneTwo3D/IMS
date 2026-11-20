# Customers: one person, one timeline

**Sales > Customers** lists every customer record IMS holds. Opening one shows the contact details, the invoiced turnover, three CRM sections described here, and the order list. Every user who can open Sales can open this page. Nothing on it changes anything in WooCommerce, Xero or the warehouse.

## Same person: how records are joined

The same shopper often exists twice, because they typed their email differently or checked out as a guest. IMS shows such records together as **one person** when their email addresses are the same after these rules:

- upper and lower case do not matter, and spaces around the address are ignored (`Jane@Shop.com` is `jane@shop.com`);
- a `+tag` is ignored (`jane+shop@example.com` is `jane@example.com`);
- for Gmail and Googlemail addresses dots are ignored, and `googlemail.com` is `gmail.com` (`j.ane@googlemail.com` is `jane@gmail.com`).

For other providers dots count: `first.last@example.com` and `firstlast@example.com` are different people.

Records are **not** joined, whatever the email says, when either has been anonymised or when the address is empty or a WooCommerce placeholder. WooCommerce cannot hold the same email on two accounts, so two shop accounts whose emails differ only by such an alias (`jane@gmail.com` and `j.ane+shop@gmail.com`) **are** one person, and are joined even though their WooCommerce customer ids differ. Letters are folded for plain A-Z only; other characters must match exactly (after Unicode composition and trimming any kind of white space). Role mailboxes that use `+tag` per end customer (`orders+clientA@reseller.com`) are folded too, so check such a person before an erasure, and use **Separate this customer** when two different people share a folded address.

**Nothing is merged or deleted.** Every original record stays exactly as it was, with its own orders and invoices. Joining is a view layered on top, and every join the system makes by itself is written to an audit trail.

When an order arrives from WooCommerce it is matched to its customer first by the **WooCommerce customer id** (when the order has one), then by **email**, ignoring case and surrounding spaces. The email must match exactly: `j_smith@x.com` is never matched to `j.smith@x.com`.

## Merge and separate (managers and administrators)

The **Same person** card lists the records shown together. Users with the **MANAGER** or **ADMIN** role also see:

- **Merge**: paste another customer's id, or the address of its customer page, to join it to this person even when the emails differ. The company list below has a **Merge as same person** button for each customer. IMS first shows **both customers' names and emails** and asks you to confirm.
- **Separate this customer**: splits this record away from everyone it is joined to, after showing who it separates from and asking you to confirm. Use it when two different people share an address. Records that are still joined to each other stay together.

Capital letters outside the basic Latin alphabet (for example É) are not folded when records are compared by email: `JOSÉ@x.com` and `josé@x.com` stay separate until you merge them. Because a merge decides who a later erasure also anonymises, both need you to have **signed in recently** (you are asked to sign in again otherwise). While an erasure of a person is unfinished, merge and separate refuse its records. Both are recorded with who did it and when, and the latest decision for a pair always wins: a separate holds even though the emails match, and a later merge overrides an earlier separate. Other roles can see the card but not change it.

## Company grouping

The **Other customers at this company** card lists customers who share this customer's **billing company name** (ignoring case, full stops and commas, and legal endings: "Acme Ltd", "Acme Limited" and "ACME Co." are one name; Ltd/Limited, Inc/Incorporated, plc, LLC, GmbH, Co/Company are folded) **or** a company **email domain**. Free providers such as gmail.com, outlook.com and yahoo.com never count as a company. Grouping is only a view: it never joins records as one person, and the list shows at most 50 customers.

## Timeline

The **Timeline** shows, newest first, what happened for this person: orders placed and cancelled, invoices issued, payments received, credit notes and refunds, refunds paid, returns expected and returns received by the warehouse. An invoice dated the day the order was placed is listed after the order placed (it is shown at the order's own time, as the invoice carries only a date). Each line links to the order. It is read-only and shows numbers, dates and amounts, never notes or free text. With **Emails on the customer timeline** switched on (**Settings > Sales**; the `crm_timeline_emails_enabled` setting, off by default), the timeline also lists the emails IMS sent for the person's orders as **Email sent** lines: the kind of email, its status and when it was sent (or queued, if it has not gone yet), linked to the order. The subject, the message text and the address are never shown, and an email whose order's personal data has been erased is not listed. Switched off, the timeline is exactly as before. When the person has several records, switch between **Whole person** and **This record only**. **Load older** shows the next page.

## Erasure covers the whole person

**GDPR Anonymise** on a customer erases **every record joined to that person**, with all their orders, in one request. The confirmation **lists every record by name and email**, and refuses if the joined records changed since you opened the page. The audit trail of joins and the saved list of records are kept; they hold only internal ids. If part of the erasure cannot be completed, the message says how many records were erased and the request can simply be run again, from any of the records, to finish: it continues from the saved list. See [Personal-data erasure](erasure.md).

## Where the WooCommerce customer id comes from

Each imported order stores the WooCommerce customer id it was placed under (nothing for a guest order). The importer uses it to find the customer of an order placed under the same shop account. Orders imported before this feature get it the next time WooCommerce sends that order. An administrator can also fill it from deliveries already stored in IMS with `npm run crm:backfill-order-customer-id` (a dry run unless `--apply` is added); it also says how many orders no stored delivery can fill, and never calls WooCommerce. An erasure clears the id.
