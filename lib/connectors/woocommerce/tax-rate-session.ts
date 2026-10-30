/**
 * THE DEPENDENCIES OF THE TAX-RATE WRITER, ALL BUILT FROM ONE CREDENTIAL RESOLUTION (lib/connectors/woocommerce/tax-rate-writer.ts).
 *
 * The CLI binds ownership to the URL of the store it reads, then sends writes with wcPost and wcPut, which (given no credentials) reload them from the settings on every call. A store URL
 * changed while an apply runs would then send a plan confirmed for store A to store B and record it under A. So the credentials are resolved ONCE, here, and passed explicitly to everything
 * that talks to the store: the GET reads (the walk and the single-rate re-read) and the write port. `configuredStoreIdentity` is the one thing that still reads the settings, on purpose: the
 * writer compares it with the pinned identity before it starts and before each send, and stops when they differ.
 */

import { createWooGetPort, type WooTransportDeps } from '@/lib/reconciliation-pack/woo-transport'
import { readWooTaxRateById, readWooTaxRateDetails } from '@/lib/reconciliation-pack/woo-source'
import type { ConnectorCredentials } from '../types'
import { normaliseStoreIdentity } from './tax-rate-plan'
import { createWooTaxRateWritePort } from './tax-rate-port'
import type { WooTaxWriterDeps } from './tax-rate-writer'

export type WooTaxSessionInput = {
  /** The credentials resolved ONCE at the start of the run (null: none usable). */
  pinned: ConnectorCredentials | null
  /** The settings read again (what `getWcCredentials` returns now); only its URL is used, and only to compare. */
  configured: () => Promise<ConnectorCredentials | null>
  context?: WooTaxWriterDeps['context']
  /** Test seam: the GET transport's fetch seam, environment and timeout. */
  transport?: Pick<WooTransportDeps, 'fetchImpl' | 'env' | 'timeoutMs'>
}

const identityOf = (creds: ConnectorCredentials | null): string | null => (creds === null ? null : normaliseStoreIdentity(creds.url))

export function createWooTaxWriterDeps(input: WooTaxSessionInput): WooTaxWriterDeps {
  const { pinned } = input
  const port = createWooGetPort({ ...input.transport, readCredentials: async () => (pinned === null ? null : { baseUrl: pinned.url, key: pinned.key, secret: pinned.secret }) })
  return {
    readWoo: async () => { const read = await readWooTaxRateDetails(port); return read.ok ? { ok: true as const, rates: read.value.rates } : { ok: false as const } },
    readWooRate: (wooId) => readWooTaxRateById(port, wooId),
    storeIdentity: async () => identityOf(pinned),
    configuredStoreIdentity: async () => identityOf(await input.configured()),
    // `null` is passed through as given: a run with no usable credentials sends nothing, it does not fall back to reloading them.
    port: createWooTaxRateWritePort(pinned),
    ...(input.context === undefined ? {} : { context: input.context }),
  }
}
