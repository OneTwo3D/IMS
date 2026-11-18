### Fulfilment and WooCommerce completion fixes

- The WooCommerce completion job re-checks that the IMS order is still Shipped (or Completed/Delivered) on every attempt. An order reopened or un-shipped while the job was waiting is dropped without sending tracking or a completed status to WooCommerce.
- The `product.updated` webhook now follows the product sync settings, as the hourly poll does: it imports into IMS unless product sync is explicitly off or the direction excludes WooCommerce to IMS (an unset setting imports, as before). With sync off, or IMS as the product master ("IMS to WooCommerce"), the delivery is acknowledged, logged and not imported. The stock correction on the same webhook is unchanged.
