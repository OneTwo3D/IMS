### Cleared customs data now clears in Mintsoft

- A customs field (HS code, country of origin, customs description) that WooCommerce explicitly empties is now emptied in IMS and logged on the product. A field the store omits, sends invalid, or that a variation inherits from a filled parent still keeps the IMS value.
- A customs field that is empty in IMS is now cleared in Mintsoft when an existing product is updated, as a separate request so a Mintsoft refusal cannot fail the update (it is retried on the next run). A blank country of origin is still declared as China on create, but no longer on update. Barcodes are never cleared.
- A clear counts only when a read-back of the Mintsoft product shows the field empty; otherwise it is retried next run. The clear format has not been verified against the live API.
- No migration.
