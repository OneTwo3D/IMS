### CI flake fixes (tests)
- `npm run test:db` now runs one file at a time: the `tests/db` files share one database and mutate shared `settings`/tax-rate/token rows inside rolled-back transactions, so in parallel they deadlocked (`40P01`), saw each other's writes and signalled each other's connections. A unit test pins the flag.
- `daily-batch-retention` cutoff test pins its time zone (it failed by an hour on DST-observing hosts); a second case covers a DST-crossing window in two zones.
- `wc-invoice-note-floor` BOUNDARY test warms the pool before choosing the instant, so a cold first query can no longer start the loop after the instant.
- `rehearse-first-install` teardown waits (bounded) for the stopped cluster's children to exit before judging them orphans, instead of exiting 3 on a clean teardown.
- `invoice-document-fetch` reset-verdict assertion accepts a stamped scratch database.
