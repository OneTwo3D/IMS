### Reports and alerts fixes

- The What's New notification now opens a read-only release-notes page at Help > What's New (`/help/releases`) that every role can view; it previously linked to the admin-only System Settings tab and showed non-admins an access-denied page. The existing notification is updated to the new link.
- The VAT report now includes archived orders, so a period's VAT figure no longer drops when data retention archives old orders. Cancelled orders stay excluded.
- Customer Aging and AR Aging no longer drop an order that nets to zero only because a credit could not be placed. Customer Aging keeps it as a row marked ≈; AR Aging lists it as an uncertain document under its customer and counts it in the report notice.
- A warehouse despatch recorded against an order that is not ready to ship now reports a retryable failure when the admin review notice or its marker could not be saved (including when there is no active admin), instead of a quiet success; the next sweep raises it again.
- Test fix: the hold-streak dispatch test no longer depends on the runner's settings key.
