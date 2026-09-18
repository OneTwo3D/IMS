/**
 * o3d-j625 r5 (review M-6) — THE ONE COPY OF WHAT THE REFUSAL SECTION SAYS.
 *
 * r4 wrote this paragraph as a literal `detail="…"` in the exception inbox — the very shape the o3d-0bfh
 * guard bans for the section beside it, and for the reason that guard exists: a literal in the UI is a
 * second author of an operator instruction, and it goes stale the round after somebody corrects the code
 * it describes. Here it is one exported string, scanned by the same guard as every other remedy surface.
 *
 * IMPORT-FREE on purpose: the exception inbox is a client component, so this must not drag a server module
 * into the client bundle.
 */
export const ACCOUNTING_POSTING_REFUSAL_SECTION_DETAIL =
  'IMS would have written these postings into books whose chart of accounts does not describe them — the '
  + 'accounting connector changed while the document was being built, or a document id the posting names '
  + 'cannot be shown to belong to the connector it would post to. Nothing was sent, and nothing retries on '
  + 'its own. Each row says which posting is owed, which books it was built for, which connector is active '
  + 'now, what still stands in IMS, and what to do. A row leaves this list when that posting is actually '
  + 'queued — there is no acknowledge action, because acknowledging one would not post it.'
