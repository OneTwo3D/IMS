### Operations

- The writers check (`npm run writers:check`) now also asks the storefront whether the legacy bridge, Xeroom and IOSS/Xero plugins are still active, and fails when IMS could write something an active plugin also writes. If the storefront cannot be asked, the check reports it as unreadable instead of assuming the plugins are off. Nothing is switched on by this; it only reads.
  - The onetwoInventory Helper plugin is now 1.5.0: it adds a signed read-only endpoint that reports those three plugins as active or inactive. Install it on the store to get the check.
  - The WooCommerce live runbook has a new section, "Single-writer cutover", with the order of the switch, how to verify that nothing was written twice, the stop condition and the rollback.
