### Fulfilment

- Orders allocated across several warehouses can now be sent to the warehouse (Mintsoft) as only its own part, and despatched part by part. This is behind the setting `wms_mixed_warehouse_push_enabled`, which is off by default; with it off nothing changes (the whole order is sent, and a despatch for a mixed order is still refused).
  - With it on, Mintsoft is sent only the units allocated to its warehouse (a kit goes whole or not at all; a kit split across warehouses is refused for a person to reallocate), and nothing is sent while any unit is still unallocated.
  - The discount, shipping and VAT are split in pence. Shipping goes with whichever part ships first.
  - A change to an allocation or shipment amends the Mintsoft order while it is still New; once it is past New the change is not applied and shows under Exceptions.
  - A Mintsoft despatch ships only Mintsoft's own shipments, once, and leaves the other warehouse's shipments open. The order is marked Shipped, and WooCommerce told, only when every shipment has shipped. A despatch that no longer matches what was sent is not applied and shows under Exceptions; it is not counted as a connector failure.
  - A WooCommerce "completed" for such an order is ignored while Mintsoft's part is open, and shows under Exceptions.
  - Once Mintsoft's part has despatched, IMS stops polling the order and never cancels it in Mintsoft.
  - A single-warehouse order is sent byte for byte as before, whether the setting is on or off.
