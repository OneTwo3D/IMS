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
  + 'handled once you have posted it by hand: that records who did it and cancels IMS\'s own retry of it. For a posting whose key names one posting for ever IMS then also refuses to post it again; for an invoice or bill update or a bill payment a later save of the document can still queue a new one. '
  + 'A row marked "Unconfirmed" is not yet '
  + 'one of these: IMS refused it while another job was settling the same posting, and the accounting sync run '
  + 'is still establishing whether it is owed — do not post an unconfirmed row by hand.'

/**
 * o3d-j625 r10 (Codex round 9, HIGH) — WHAT AN UNRECONCILED PROVISIONAL CLAIM SAYS, AND WHAT IT MUST NOT.
 *
 * A refusal decided inside a business transaction that could not take the posting key is held as a
 * provisional claim and settled by the accounting-sync tick (lib/domain/accounting/
 * posting-refusal-provisional.ts). Until that happens IMS does not know whether the posting is owed —
 * another transaction may have queued it — so the ONE thing this text must never do is ask the operator
 * to post it by hand. That instruction, given while the posting may still be someone else's, is how a
 * ledger gets the same journal twice. It says so in as many words, and the row carries no kind, so the
 * Mark-as-handled affordance is not offered against it either.
 */
export const ACCOUNTING_POSTING_REFUSAL_UNCONFIRMED_REASON = 'awaiting_reconciliation'

export const ACCOUNTING_POSTING_REFUSAL_UNCONFIRMED_REMEDY =
  'Nothing yet — and do NOT post this in the ledger by hand. IMS refused this posting while another job was '
  + 'settling the same one, so it does not yet know whether the posting is owed or was queued by that job. The '
  + 'accounting sync run settles it automatically, usually within minutes: it then either disappears from this '
  + 'list or becomes an ordinary refused posting with a remedy. If it is still here after an hour, the '
  + 'accounting sync cron is not running — check that first.'

export const ACCOUNTING_POSTING_REFUSAL_UNCONFIRMED_CLEARING_NOTE =
  'Unconfirmed. Waiting for the accounting sync run to settle whether this posting is owed; it is not yet '
  + 'something to post by hand, and it cannot be marked handled.'

export const ACCOUNTING_POSTING_REFUSAL_UNCONFIRMED_COMMITTED =
  'The work that produced this posting is committed in IMS. Whether the posting itself reached the ledger is '
  + 'what has not been established yet.'

/** o3d-j625 r6/r7: the prefix of the "How it clears" cell, per classification. */
export const ACCOUNTING_POSTING_REFUSAL_CLEARING_LABEL = {
  auto: 'Clears itself. ',
  retried: 'IMS retries this, but the retry can get stuck. ',
  manual: 'Nothing in IMS will post this. ',
} as const

/**
 * Codex round 8: the Mark-as-handled, Take-for-hand-posting and Release dialogs are NOT constants any more. Each is a function of
 * the row's state (`markHandledWarningFor`, `claimWarningFor`, `releaseWarningFor` in `hand-post-instruction.ts`), rendered from
 * the same structure as the inbox row text, because a static dialog could not say "check the CURRENT version" for a posting whose
 * earlier version is in the ledger.
 */

/** o3d-j625 r6 (review H4): the heading detail of the recently-resolved list. */
export const ACCOUNTING_POSTING_REFUSAL_RESOLVED_DETAIL =
  'How each refused posting left the list: queued by IMS, or marked handled by a person after posting it by hand.'

/**
 * o3d-j625 r18 (Codex round 17, HIGH 2) — the heading detail of the ACTIVE HAND-POST CLAIMS section.
 *
 * A hand-post claim never expires: r16 rejected a timer because a claim that lapsed would re-open exactly the
 * interval it closes. That is only safe if every claim can be FOUND and given back, and until this section
 * existed the only Release control rode on the oldest-50 refusal list — so a claim behind 50 older debts was a
 * suppression nobody could reach. This section is the answer, and it says out loud who may end a claim.
 */
export const ACCOUNTING_POSTING_HAND_POST_CLAIM_DETAIL =
  'Postings an operator has taken to settle BY HAND. While a posting is held here IMS will not queue it — that '
  + 'is what stops it reaching the ledger twice — and a claim never expires, so it ends only when somebody '
  + 'confirms the posting or releases it. The ones held LONGEST are listed first, above; below them is the rest '
  + 'of the list, which you can page through. To reach a specific posting, SEARCH for its document rather than '
  + 'paging: postings are taken and given back while you read, so this list is a view of what is held and not '
  + 'a roll-call. ANYBODY with sync access may release ANYBODY\'s claim, deliberately: otherwise a claim taken '
  + 'by someone who has left would suppress that posting for ever. Releases are recorded.'

/**
 * o3d-j625 r20 (Codex round 19, HIGH) — WHAT THE LOOKUP SEARCHES, said on the page.
 *
 * A search box that does not say what it searches is one an operator cannot trust, and "I searched and it was
 * not there" must never be evidence that a claim does not exist. It is the same list
 * `handPostClaimSearchWhere` builds, and a test holds the two together.
 */
export const ACCOUNTING_POSTING_HAND_POST_CLAIM_SEARCH_HINT =
  'Find a claim by the document it is for — the reference id (an order or PO number), the reference type, the '
  + 'posting type, or the refusal id. NOT the holder\'s name. Clearing the box returns to the first page.'

/** What "held a long time" means on the section above — a signal to look, never an expiry that acts. */
export const ACCOUNTING_POSTING_HAND_POST_CLAIM_STALE_NOTE =
  'Held far longer than a hand posting takes. Nothing will end it on its own: ask the holder, or release it.'

/**
 * o3d-j625 r22 (Codex round 21, HIGH) — the heading of the LONGEST-HELD block.
 *
 * The walk beneath it is ordered by the row's identity, because `handPostClaimedAt` is rewritten on every
 * re-take from an application clock and a cursor over a rewritable key can put the same row on both sides of
 * itself. Identity carries no meaning an operator should read, so the surfacing that oldest-claim-first bought
 * lives here instead: a short age-ordered look at what is being sat on. It is a display aid — nothing
 * paginates through it and nothing can hide behind it, because the complete walk is directly below.
 */
export const ACCOUNTING_POSTING_HAND_POST_CLAIM_LONGEST_HELD_DETAIL =
  'Held longest first — the ones most likely to have been forgotten. The full list below is in no particular '
  + 'order an operator should read anything into, so start here, and search by document for a specific one.'


