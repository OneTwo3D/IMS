# Stock Movement Reporting Guarantees

Migration `20260602103000_stock_movement_reporting_guarantees` installs DB-native guarantees that Prisma cannot express:

- `stock_movements_reporting_value_consistent` requires `unitCostBase` and `totalValueBase` to be either both null or both populated, and requires populated totals to equal `ROUND(qty * unitCostBase, 6)`.
- `stock_movements_reporting_evidence_guard` is a deferred constraint trigger. At commit time it requires inbound `PURCHASE_RECEIPT`, `PRODUCTION_IN`, and inbound `ADJUSTMENT` movements to have cost-layer evidence, and outbound `SALE_DISPATCH`, `PURCHASE_REVERSAL`, `PRODUCTION_OUT`, and outbound `ADJUSTMENT` movements to have COGS evidence.

### The reference a guarded inbound movement must carry (o3d-gles)

The cost-layer half of that guard is not satisfied by *any* matching layer: the movement has to **name the document that vouches for the units**, because that id is how the guard reaches the layer. The same rule is written three times — in this trigger, in `hasMatchingInboundCostLayer` and in the `stock_movement_missing_cost_layer` SQL collector (both `lib/domain/inventory/invariants.ts`) — so a writer that gets it wrong either fails at COMMIT or reports as a `critical` invariant finding for ever.

| movement | `referenceType` / `referenceId` | the layer it must find |
| --- | --- | --- |
| `PURCHASE_RECEIPT` | `'PurchaseOrder'` / the purchase-order id | a `cost_layers` row for the same product + destination warehouse, `receivedQty` equal to the movement quantity, whose `poLineId` belongs to that purchase order |
| `PRODUCTION_IN` | `'ProductionOrder'` / the production-order id | a layer with `production_order_id` equal to that id |
| inbound `ADJUSTMENT` | anything | a layer with `adjustment_movement_id` equal to the movement's own id |

Both purchase-receipt writers obey this: the manual receipt (`app/actions/purchase-orders.ts`) and the WMS webhook book-in (`lib/domain/wms/booked-in-service.ts`). The WMS one used to write `referenceType: 'WmsAsnMap'` instead, so every purchase-order-backed book-in with units to credit died at COMMIT with SQLSTATE 23514 and moved no stock (o3d-gles, pre-existing since PR #581). Its ASN linkage is carried by `idempotencyKey` (`PURCHASE_RECEIPT:wmsAsnLine:<asnLineMapId>:receipt:<receiptEventId>`) and by the external ASN id in `note`. `TRANSFER_IN` is not covered by the guard and still references the ASN map.

## Deploy Recovery

The migration preflight blocks deploy only for value-field drift because those rows would fail CHECK validation:

```sql
SELECT id, type, qty, "unitCostBase", "totalValueBase"
FROM "stock_movements"
WHERE ("unitCostBase" IS NULL AND "totalValueBase" IS NOT NULL)
   OR ("unitCostBase" IS NOT NULL AND "totalValueBase" IS NULL)
   OR (
     "unitCostBase" IS NOT NULL
     AND "totalValueBase" IS NOT NULL
     AND "totalValueBase" <> ROUND((qty * "unitCostBase")::numeric, 6)
   )
ORDER BY "createdAt", id;
```

Repair those rows by either clearing both value fields when provenance is not derivable, or by recalculating `totalValueBase` from the same `roundQuantity(..., 6)` policy used by the writer. Then rerun `prisma migrate deploy`.

Existing movement evidence drift is warning-only during deploy because historical data may lack durable evidence links. After deploy, run the inventory invariant report and repair rows reported as:

- `stock_movement_missing_cost_layer`
- `stock_movement_missing_cogs_entry`

## Maintenance

For bounded maintenance that needs to repair historical stock movement evidence, prefer writing the missing evidence rows inside normal transactions with the trigger enabled. If a repair script must temporarily bypass the trigger, use the narrow table trigger toggle rather than `session_replication_role`:

```sql
ALTER TABLE "stock_movements" DISABLE TRIGGER stock_movements_reporting_evidence_guard;
-- run bounded repair
ALTER TABLE "stock_movements" ENABLE TRIGGER stock_movements_reporting_evidence_guard;
```

Immediately rerun the inventory invariant report after re-enabling the trigger. Do not leave the trigger disabled across application traffic.

## Performance

The trigger is `DEFERRABLE INITIALLY DEFERRED`, so it supports writer transactions that create a movement first and evidence rows later in the same transaction. The tradeoff is that evidence checks run at commit time for each affected movement row. Keep bulk dispatch, production, and repair batches bounded so commit latency stays below the application transaction timeout.

The migration uses `NOT VALID` plus `VALIDATE CONSTRAINT` for the CHECK. Validation scans the existing table and can stall writes on large installs; schedule the deployment window accordingly.

## Observability

Trigger rejections surface to the application as PostgreSQL `23514` constraint errors and are also visible in database logs. The inventory invariant report is the operational dashboard for existing drift and should be the first diagnostic tool after a rejected writer transaction. The trigger itself does not write audit rows because trigger-side writes would make normal transaction rollback semantics harder to reason about.
