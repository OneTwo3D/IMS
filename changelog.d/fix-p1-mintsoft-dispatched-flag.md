### Fixed
- The Mintsoft align-down in-flight gate now uses the connector's own despatched decision (vendor status grouping or a despatch date), stored with each WMS status snapshot, instead of the status name alone. An order is released only on a fresh successful read that explicitly says not despatched; an absent, stale or failed decision holds.
