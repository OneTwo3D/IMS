### WMS misc fixes (batch AG)
- A legacy shipping address whose street line is only the company name no longer counts as a deliverable street: the warehouse push falls back to the billing address when that has a real street.
- A dispatch blocked by a refund-reservation release row in a status this version does not recognise now says so and names the rollback remedy, and the row appears in Sync Exceptions (Integration outbox) and its count instead of being invisible.
