import type { ConnectorSnapshot, PreloadReaders } from '../../lib/first-load/apply/db/preload-rails'

/** A snapshot of an installation with no connector enabled and no credential. */
export const CLEAN_SNAPSHOT: ConnectorSnapshot = {
  pluginEnabled: { woocommerce: false, mintsoft: false, xero: false },
  credentialPresent: {},
  accountingTokens: 0,
  activeWarehouseConnections: 0,
  activeWarehouseBindings: 0,
}

/**
 * The pre-load rails over a quiet installation: no grant in the environment, no connector enabled, an empty crontab. Tests that exercise the load (not the rails themselves) use it so that
 * they do not depend on the crontab of the machine they run on or on the connector settings a test seeds on purpose (the effects-suppression tests configure a storefront).
 */
export const CLEAN_PRELOAD: PreloadReaders = { env: {}, connectors: async () => CLEAN_SNAPSHOT, crontab: async () => ({ resolved: true, text: '' }) }
