# Customers: one person, one timeline

**Sales > Customers** lists every customer record IMS holds. Opening one shows the contact details, the invoiced turnover, three CRM sections described here, and the order list. Every user who can open Sales can open this page. Nothing on it changes anything in WooCommerce, Xero or the warehouse.

## Same person: how records are joined

The same shopper often exists twice, because they typed their email differently or checked out as a guest. IMS shows such records together as **one person** when their email addresses are the same after these rules:

- upper and lower case do not matter, and spaces around the address are ignored (`Jane@Shop.com` is `jane@shop.com`);
- a `+tag` is ignored (`jane+shop@example.com` is `jane@example.com`);
- for Gmail and Googlemail addresses dots are ignored, and `googlemail.com` is `gmail.com` (`j.ane@googlemail.com` is `jane@gmail.com`).

For other providers dots count: `first.last@example.com` and `firstlast@example.com` are different people.

Two records are **not** joined, whatever the email says, when they carry two different WooCommerce customer ids (two separate shop accounts), when either has been anonymised, or when the address is empty or a WooCommerce placeholder.

**Nothing is merged or deleted.** Every original record stays exactly as it was, with its own orders and invoices. Joining is a view layered on top, and every join the system makes by itself is written to an audit trail.

When an order arrives from WooCommerce, its email is matched to an existing customer **ignoring case**, so a different capitalisation no longer creates a second record.

## Merge and separate (managers and administrators)

The **Same person** card lists the records shown together. Users with the **MANAGER** or **ADMIN** role also see:

- **Merge**: paste another customer's id, or the address of its customer page, to join it to this person even when the emails differ. The company list below has a **Merge as same person** button for each customer.
- **Separate this customer**: splits this record away from everyone it is joined to. Use it when two different people share an address. Records that are still joined to each other stay together.

Both are recorded with who did it and when, and the latest decision for a pair always wins: a separate holds even though the emails match, and a later merge overrides an earlier separate. Other roles can see the card but not change it.

## Company grouping

The **Other customers at this company** card lists customers who share this customer's **billing company name** (ignoring case, full stops and commas; "Acme Ltd" and "Acme Limited" are different names) **or** a company **email domain**. Free providers such as gmail.com, outlook.com and yahoo.com never count as a company. Grouping is only a view: it never joins records as one person, and the list shows at most 50 customers.

## Timeline

The **Timeline** shows, newest first, what happened for this person: orders placed and cancelled, invoices issued, payments received, credit notes and refunds, refunds paid, returns expected and returns received by the warehouse. Each line links to the order. It is read-only and shows numbers, dates and amounts, never notes or free text. When the person has several records, switch between **Whole person** and **This record only**. **Load older** shows the next page.

## Erasure covers the whole person

**GDPR Anonymise** on a customer erases **every record joined to that person**, with all their orders, in one request. The confirmation says how many records will be erased. The audit trail of joins is kept; it holds only internal ids. If part of the erasure cannot be completed, the message says how many records were erased and the request can simply be run again to finish. See [Personal-data erasure](erasure.md).

## Where the WooCommerce customer id comes from

Each imported order stores the WooCommerce customer id it was placed under (nothing for a guest order). Orders imported before this feature get it the next time WooCommerce sends that order. An administrator can also fill it from deliveries already stored in IMS with `npm run crm:backfill-order-customer-id` (a dry run unless `--apply` is added); this never calls WooCommerce. An erasure clears the id.
