/**
 * WRITER ATTESTATIONS: THE OWNER'S CONFIRMATION THAT AN INCUMBENT WRITER HAS STOPPED. Constants and single-sourced text.
 *
 * Some incumbents (Qoblex's stock push to WooCommerce, Qoblex's native Xero posting) are stopped by the owner in a system IMS cannot see. IMS
 * therefore waits for the owner's word: an append-only WriterAttestation row, written by `npm run writers:attest` or by the ADMIN confirmation on the
 * Sync screen, always with an activity-log entry. Pure and import-light: the settings writers, the check and the screen all import it.
 */

export const WRITER_ATTESTATION_KINDS = ['qoblex-stock-push-stopped', 'qoblex-xero-stopped'] as const
export type WriterAttestationKind = (typeof WRITER_ATTESTATION_KINDS)[number]

export const WRITER_ATTESTATION_LABEL: Record<WriterAttestationKind, string> = {
  'qoblex-stock-push-stopped': 'The Qoblex stock push to WooCommerce is stopped',
  'qoblex-xero-stopped': 'Qoblex\'s native Xero posting (bills, journals, daily batches) is stopped',
}

/** What the owner is asked to have done before confirming (shown on the confirmation screen and printed by the command). */
export const WRITER_ATTESTATION_STATEMENT: Record<WriterAttestationKind, string> = {
  'qoblex-stock-push-stopped': 'I have stopped the stock push from Qoblex to the WooCommerce store, in Qoblex. I understand IMS will start pushing stock once this is recorded and the WooCommerce step goes live.',
  'qoblex-xero-stopped': 'I have stopped Qoblex\'s native posting of bills, journals and daily batches to Xero, in Qoblex. I understand IMS will start posting once this is recorded and the Xero step goes live.',
}

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
 * The confirmation a step's WRITES need before the producer decision may call them LIVE (the writers:check phase needs the same one). Step X moves Xero posting from
 * Qoblex to IMS, so IMS stays held until the owner has said Qoblex stopped. `xero_sync_enabled` itself is NOT guarded: P1 reads from Xero with it on.
 */
export const STEP_LIVE_ATTESTATION: Readonly<Partial<Record<'mintsoft' | 'woocommerce' | 'xero', WriterAttestationKind>>> = {
  xero: 'qoblex-xero-stopped',
}

export function attestationRefusalText(setting: string, kind: WriterAttestationKind): string {
  return `Cannot turn on ${setting}: the owner has not confirmed that this is safe. Qoblex still writes here until the owner stops it, so IMS would be a second writer. `
    + `An administrator must first record the confirmation "${WRITER_ATTESTATION_LABEL[kind]}" (Sync screen, or ${WRITER_ATTESTATION_COMMAND}).`
}

export function isWriterAttestationKind(value: unknown): value is WriterAttestationKind {
  return typeof value === 'string' && (WRITER_ATTESTATION_KINDS as readonly string[]).includes(value)
}
