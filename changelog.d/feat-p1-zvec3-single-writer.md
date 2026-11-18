### Operations

- The writers check (`npm run writers:check`) now also asks the storefront (one signed read-only call per run, hourly when the scheduled job is on) whether the legacy bridge, Xeroom and IOSS/Xero plugins are active, and fails when the ownership map gives IMS an operation in the current phase that an active plugin also writes. A store that cannot be asked, or an installation that does not ask, is reported as unreadable (an error when IMS could write a contested operation, a warning otherwise) instead of assuming the plugins are off. Nothing is switched on by this; it only reads.
  - The onetwoInventory Helper plugin is now 1.5.0: it adds a signed read-only endpoint that reports those three plugins as active or inactive. Install it on the store to get the check.
  - The WooCommerce live runbook has a new section, "Single-writer cutover", with the order of the switch, how to verify that nothing was written twice, the stop condition and the rollback.
