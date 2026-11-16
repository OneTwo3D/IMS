### Sales orders: fulfilment progress on the status badge; per-shipment packing slip (UI)

- **Fixed: the order status badge hid picking, packing and partial dispatch.** An Allocated order whose parcels are being picked, packed or partly dispatched now shows a second chip (for example "Picking (1 of 2 parcels)", "Packed — ready to ship", "Partially shipped 1/3") on the order page and in the sales list. It is derived from the shipments; no new state is stored.
- **Fixed: the packing slip could not be printed while picking.** Each shipment card now has a **Packing slip** button (from Pending onwards) that prints only that parcel (`/api/packing-slip/<order>?shipment=<id>`); the order-level slip in the ⋮ menu is offered for every non-draft, non-cancelled order.
- Editing a sales order after creation (a separate audit item) is not part of this change.

