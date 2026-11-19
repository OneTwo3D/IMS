/**
 * WRITER ATTESTATIONS: THE OWNER'S CONFIRMATION THAT AN INCUMBENT WRITER HAS STOPPED. Constants and single-sourced text.
 *
 * Some incumbents (Qoblex's stock push to WooCommerce, Qoblex's native Xero posting) are stopped by the owner in a system IMS cannot see. IMS
 * therefore waits for the owner's word: an append-only WriterAttestation row, written by `npm run writers:attest` or by the ADMIN confirmation on the
 * Sync screen, always with an activity-log entry. Pure and import-light: the settings writers, the check and the screen all import it.
 */

import type { LiveWriterStep } from './writer-ownership-map'

export const WRITER_ATTESTATION_KINDS = ['qoblex-stock-push-stopped', 'qoblex-xero-stopped', 'bridge-units-masked'] as const
export type WriterAttestationKind = (typeof WRITER_ATTESTATION_KINDS)[number]

export const WRITER_ATTESTATION_LABEL: Record<WriterAttestationKind, string> = {
  'qoblex-stock-push-stopped': 'The Qoblex stock push to WooCommerce is stopped',
  'qoblex-xero-stopped': 'Qoblex\'s native Xero posting (bills, journals, daily batches) is stopped',
  'bridge-units-masked': 'The bridge host\'s sweep timer, sweep service and webhook service are masked and inactive',
}

/** What the owner is asked to have done before confirming (shown on the confirmation screen and printed by the command). */
export const WRITER_ATTESTATION_STATEMENT: Record<WriterAttestationKind, string> = {
  'qoblex-stock-push-stopped': 'I have stopped the stock push from Qoblex to the WooCommerce store, in Qoblex. I understand IMS will start pushing stock once this is recorded and the WooCommerce step goes live.',
  'qoblex-xero-stopped': 'I have stopped Qoblex\'s native posting of bills, journals and daily batches to Xero, in Qoblex. I understand IMS will start posting once this is recorded and the Xero step goes live.',
  'bridge-units-masked': 'I ran scripts/bridge/bridge_writers_status.py on the bridge host after masking wc-mintsoft-order-sweep.timer, wc-mintsoft-order-sweep.service and wc-mintsoft-webhook.service, and pasted its output unchanged. IMS checks that all three are masked and inactive and that nothing triggered after the Mintsoft step\'s live-from instant.', // wms-connector-boundary-ok: 2026-11-19: names the bridge's own systemd units, not a WMS connector.
}

/** Kinds whose confirmation carries a pasted host report (`payload`) instead of only the owner's word. */
export const WRITER_ATTESTATION_REPORT_KINDS: readonly WriterAttestationKind[] = ['bridge-units-masked']

export const WRITER_ATTESTATION_ACTION = 'writer_attestation_recorded'
export const WRITER_ATTESTATION_REFUSAL_ACTION = 'writer_attestation_setting_refused'
export const WRITER_ATTESTATION_COMMAND = 'npm run writers:attest'
export const WRITER_ATTESTATION_NOTE_MAX = 500

/**
 * The settings an IMS writer switch is guarded by: turning the setting ON is refused until the matching attestation exists.
 * Only `wc_stock_sync_enabled` (the WooCommerce stock push). `xero_sync_enabled` is NOT guarded: P1 reads from Xero with it on; Xero WRITES are held by the
 * producer decision until the Qoblex confirmation exists (STEP_LIVE_ATTESTATION).
 */
export const ATTESTATION_GUARDED_SETTINGS: Readonly<Record<string, WriterAttestationKind>> = {
  wc_stock_sync_enabled: 'qoblex-stock-push-stopped',
}

/**
 * The confirmation a step's WRITES need before they may be DELIVERED (the producer decision does not look at it: work is produced and queued, and the
 * drains hold it until the owner's word is on record, so nothing is ever shadowed for good because a confirmation had not been read yet). Step X moves
 * Xero posting from Qoblex to IMS, so IMS holds until the owner has said Qoblex stopped. `xero_sync_enabled` itself is NOT guarded: P1 reads from Xero with it on.
 */
export const STEP_LIVE_ATTESTATION: Readonly<Partial<Record<LiveWriterStep, WriterAttestationKind>>> = {
  xero: 'qoblex-xero-stopped',
}

/**
 * The same, for ONE OPERATION of a step whose other operations need nothing. Step W holds the WooCommerce stock push on the Qoblex stock confirmation;
 * its webhooks stay separate (no incumbent pushes webhooks). Keyed `<destination>/<operation>`.
 */
export const OPERATION_LIVE_ATTESTATION: Readonly<Record<string, WriterAttestationKind>> = {
  'woocommerce/stock': 'qoblex-stock-push-stopped',
}

/** The confirmation the delivery of `destination`/`operation` (a row of `step`) waits for, or undefined when it waits for none. */
export function requiredAttestationFor(destination: string, operation: string, step: string): WriterAttestationKind | undefined {
  const own = OPERATION_LIVE_ATTESTATION[`${destination}/${operation}`]
  if (own !== undefined) return own
  return (STEP_LIVE_ATTESTATION as Readonly<Record<string, WriterAttestationKind | undefined>>)[step]
}

export function attestationRefusalText(setting: string, kind: WriterAttestationKind): string {
  return `Cannot turn on ${setting}: the owner has not confirmed that this is safe. Qoblex still writes here until the owner stops it, so IMS would be a second writer. `
    + `An administrator must first record the confirmation "${WRITER_ATTESTATION_LABEL[kind]}" (Sync screen, or ${WRITER_ATTESTATION_COMMAND}).`
}

export function isWriterAttestationKind(value: unknown): value is WriterAttestationKind {
  return typeof value === 'string' && (WRITER_ATTESTATION_KINDS as readonly string[]).includes(value)
}
