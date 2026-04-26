# Workflow State Machines

This document describes the canonical status flows used by the Stage 2.1
workflow helpers in `lib/domain/workflows`. This stage defines the helpers only;
write paths continue to use their existing validation until the follow-up
enforcement stage.

## Sales Orders

Sales order status tracks the commercial order lifecycle:

```text
DRAFT -> PENDING_PAYMENT -> PROCESSING -> ALLOCATED -> PICKING -> PACKING -> SHIPPED -> COMPLETED -> DELIVERED
```

Current alternate paths:

- `DRAFT`, `PENDING_PAYMENT`, `ON_HOLD`, `PROCESSING`, `ALLOCATED`, `PICKING`, and `PACKING` can move to `CANCELLED` where the current actions allow cancellation.
- `DRAFT` can move directly to `PROCESSING` for orders that do not need to wait in `PENDING_PAYMENT`.
- `DRAFT`, `PENDING_PAYMENT`, and `PROCESSING` can move directly to `ALLOCATED` when auto-allocation reserves stock for the order.
- `DRAFT`, `PENDING_PAYMENT`, `PROCESSING`, `ALLOCATED`, `PICKING`, and `PACKING` can move through `ON_HOLD` where the current actions allow hold/release.
- `PENDING_PAYMENT` can return to `DRAFT`.
- `ALLOCATED` can return to `PROCESSING` when allocations are released.
- `ALLOCATED` and `PICKING` can become `SHIPPED` only after shipment rows exist
  and every shipment row has already reached shipment `SHIPPED`; the sales order
  transition is an aggregate state update, not stock dispatch.
- `SHIPPED` can move directly to `DELIVERED` when delivery tracking confirms all
  tracked shipments are delivered.
- `PARTIALLY_REFUNDED` and `REFUNDED` are order states set by refund creation.
  `REFUNDED` is terminal; `PARTIALLY_REFUNDED` can move to `REFUNDED` when later
  refunds bring the total refunded amount up to the order total.

## Shipments

Shipment status tracks physical fulfilment for one warehouse shipment:

```text
PENDING -> PICKING -> PACKED -> SHIPPED
```

Order status and shipment status are intentionally separate. A sales order is
marked `SHIPPED` only after shipment rows exist and every shipment is already
`SHIPPED`. Shipment `SHIPPED` performs stock dispatch and cost-layer snapshot
work; sales order `SHIPPED` represents the aggregate order state.

## Purchase Orders

Purchase order status tracks supplier procurement plus receipt and return state:

```text
DRAFT -> RFQ_SENT -> QUOTE_RECEIVED -> PO_SENT -> SHIPPED -> PARTIALLY_RECEIVED -> RECEIVED -> INVOICED -> CLOSED
```

Current alternate paths:

- `DRAFT` can move directly to `PO_SENT` or `CANCELLED`.
- `RFQ_SENT` and `QUOTE_RECEIVED` can close without being sent.
- `PO_SENT` and `SHIPPED` can become `PARTIALLY_RECEIVED` or `RECEIVED` through receipt.
- `PO_SENT`, `PARTIALLY_RECEIVED`, `RECEIVED`, `INVOICED`, and `PARTIALLY_RETURNED` can become `PARTIALLY_RETURNED` or `RETURNED` through supplier return.
- `RECEIVED` can move to `INVOICED`; current invoice creation also stamps `invoicedAt`, so follow-up enforcement needs to decide whether to keep that secondary timestamp behavior or promote `INVOICED` as the primary status.

## Refunds

Refunds currently do not have a persisted status column. The helper models the
derived lifecycle already implied by the current records:

```text
RECORDED -> CREDIT_NOTE_SYNCED -> PAID
RECORDED -> PAID
```

`RECORDED` means a `SalesOrderRefund` row exists. `CREDIT_NOTE_SYNCED` is derived
from the accounting credit-note/sync state. `PAID` is derived from payments linked
to the refund. Follow-up enforcement should either keep this as a derived workflow
or add a persisted refund status before enforcing transitions.

## Stock Transfers

Stock transfer status tracks inter-warehouse movement:

```text
DRAFT -> IN_TRANSIT -> RECEIVED
```

`DRAFT` can also move to `CANCELLED`. Received and cancelled transfers are
terminal.
