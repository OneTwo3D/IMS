/**
 * Coordination primitives shared between WooCommerce credential
 * mutations and in-flight stock syncs.
 *
 * The stock-sync path persists resolved `Product.externalProductId` values
 * incrementally across many `await`s. Without serialization, a
 * concurrent `saveWcCredentials` / `resetWcProductIdCache` could run
 * between a sync reading the version and writing a product row,
 * letting an old-store id land on top of a freshly wiped cache.
 *
 * Two primitives make that race impossible:
 *
 *   1. A Postgres transaction-scoped advisory lock, taken by BOTH the
 *      credential-mutation path and every externalProductId write inside the
 *      stock sync. Holders are serialized; the lock auto-releases on
 *      transaction commit or rollback.
 *
 *   2. A monotonic `wc_settings_version` Setting row. A rebind or
 *      cache reset bumps it inside the same advisory-lock-held
 *      transaction that wipes the cache. Stock sync snapshots this
 *      value at the start of its run (also under the advisory lock)
 *      and refuses to persist any mapping whose transaction observes
 *      a different version — proof that the credentials were mutated
 *      mid-run.
 *
 * Both the lock key and the setting key are referenced in multiple
 * files; they live here so the contract is explicit and the two
 * sides cannot drift out of sync.
 */

export const WC_SYNC_ADVISORY_LOCK_KEY = 918_273_645

export const WC_SETTINGS_VERSION_KEY = 'wc_settings_version'
