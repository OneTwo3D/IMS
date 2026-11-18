### Order-total check no longer flags orders it cannot judge (WMS push)

- **Fixed: the advisory "order total mismatch" check stays silent on two kinds of order.** An order whose lines were edited in IMS (component check only; address and notes edits do not count) and an order whose discount is recorded under a model other than line-allocated are skipped, so they no longer raise a false mismatch on Integrations > Exceptions. The check still runs on every other order, after the warehouse accepts it, and never changes or blocks what is sent.
