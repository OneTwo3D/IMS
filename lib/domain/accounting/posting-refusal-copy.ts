/**
 * o3d-j625 r5 (review M-6) — THE ONE COPY OF WHAT THE REFUSAL SECTION SAYS.
 *
 * r6 (review L4): r5 said "nothing retries on its own", which the held WooCommerce release sweep and the
 * supplier-credit-note allocation sweep both contradict — and since r6 every path that queues a posting
 * clears its row (lib/domain/accounting/sync-log-row.ts), so a sweep's success does clear it.
 *
 * r6 (review H4, owner decision): and NOT every row clears when "the posting is made" — a MANUAL-ONLY kind
 * has no path that raises it again, so it leaves the list when someone marks it handled. Which kind is which
 * is posting-refusal-kinds.ts, never this text.
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
  + 'cannot be shown to belong to the connector it would post to. Nothing was sent. Each row says which posting '
  + 'is owed, which books it was built for, which connector is active now, what still stands in IMS, and what '
  + 'to do. A row marked "clears itself" leaves this list when IMS queues the posting. Any other row can be marked '
  + 'handled once you have posted it by hand: that records who did it, and IMS will then never post that posting '
  + 'itself — its own retry is cancelled — so it cannot be posted twice.'

/** o3d-j625 r6/r7: the prefix of the "How it clears" cell, per classification. */
export const ACCOUNTING_POSTING_REFUSAL_CLEARING_LABEL = {
  auto: 'Clears itself. ',
  retried: 'IMS retries this, but the retry can get stuck. ',
  manual: 'Nothing in IMS will post this. ',
} as const

/** o3d-j625 r6/r7: what the Mark-as-handled dialog tells the operator before they confirm. */
export const ACCOUNTING_POSTING_REFUSAL_MARK_HANDLED_WARNING =
  'Mark this handled ONLY if you have posted it by hand in the ledger. Marking it means: "I posted this by hand; '
  + 'IMS will not post it." IMS cancels its own retry of this posting and will refuse to post it from then on, so '
  + 'it cannot reach the ledger twice. If IMS may already have posted it, you will be told, and nothing is changed.'

/** o3d-j625 r6 (review H4): the heading detail of the recently-resolved list. */
export const ACCOUNTING_POSTING_REFUSAL_RESOLVED_DETAIL =
  'How each refused posting left the list: queued by IMS, or marked handled by a person after posting it by hand.'
