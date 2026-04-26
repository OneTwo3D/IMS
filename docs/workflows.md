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
- `DRAFT`, `PENDING_PAYMENT`, `PROCESSING`, and `ALLOCATED` can move through `ON_HOLD` where the current actions allow hold/release.
- `PENDING_PAYMENT` can return to `DRAFT`.
- `ALLOCATED` can return to `PROCESSING` when allocations are released.
- `PARTIALLY_REFUNDED` and `REFUNDED` are terminal order states set by refund creation.

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
DRAFT -> RFQ_SENT -> QUOTE_RECEIVED -> PO_SENT -> SHIPPED -> PARTIALLY_RECEIVED -> RECEIVED -> CLOSED
```

Current alternate paths:

- `DRAFT` can move directly to `PO_SENT` or `CANCELLED`.
- `RFQ_SENT` and `QUOTE_RECEIVED` can close without being sent.
- `PO_SENT` and `SHIPPED` can become `PARTIALLY_RECEIVED` or `RECEIVED` through receipt.
- `PO_SENT`, `PARTIALLY_RECEIVED`, `RECEIVED`, `INVOICED`, and `PARTIALLY_RETURNED` can become `PARTIALLY_RETURNED` or `RETURNED` through supplier return.
- `INVOICED` is currently mostly a secondary state in the schema; invoice creation stamps `invoicedAt` and does not always replace the primary PO status.

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
