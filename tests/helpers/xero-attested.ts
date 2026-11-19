import { setAttestationSnapshot } from '../../lib/security/writer-attestation-snapshot.ts'

// Importing this file records, for THIS test process only, that the owner has confirmed Qoblex's Xero posting is stopped, so step-X writes can be LIVE.
// The tests that exercise the refusal do not import it.
setAttestationSnapshot(new Set(['qoblex-xero-stopped']))
