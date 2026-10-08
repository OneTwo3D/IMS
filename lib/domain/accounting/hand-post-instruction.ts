/**
 * o3d-1e7sl (Codex round 8) - THE SINGLE SOURCE OF "WHAT TO DO BEFORE YOU HAND-POST / MARK HANDLED".
 *
 * Four review rounds in a row found the check-first / current-version instruction rendered by SEVERAL independent code paths (the
 * row text, the claim dialog, the mark-handled dialog, the release dialog, the claim log, the refusing sites' remedies, the help
 * text), each of which could be right while another was wrong. It is rendered from ONE structure now:
 *
 *   handPostInstruction({ type, earlierPostingDetails, retiredUnproven })
 *     -> { mode, flow, step, branches[], markHandledCondition, ... }
 *
 * and every consumer renders from it: `handPostOrderFor` (the inbox row), `claimWarningFor` (the claim dialog),
 * `markHandledWarningFor` (the mark-handled dialog), `releaseWarningFor` (the release dialog), the claim ActivityLog, and
 * `GENERIC_HAND_POST_STEP` for the surfaces that know no row state (a refusing site's remedy, the not-claimed refusal, the help
 * text). A census test fails if a new surface renders mark-handled advice outside this module.
 *
 * PURE and import-free (types only) because the dialogs are client components.
 *
 * THE THREE THINGS, NEVER ONE: the retired unproven attempt (may or may not have posted THE CURRENT update), the earlier document
 * (version N, any standing) and the refused newer update (version N+1, what is owed). The earlier document alone never satisfies a
 * "do not post again" branch, and Mark as handled waits for the CURRENT version.
 */
import type { LedgerStanding } from '@/lib/domain/accounting/ledger-standing'

export type EarlierPosting = { ref: string; standing: LedgerStanding }

/**
 * Codex round 9: the inputs are a DISCRIMINATED state. The plain "post it in the ledger now" wording is reachable ONLY when the caller
 * positively asserts `state: 'loaded'` with NO earlier document and NO retired attempt. A caller that did not load the posting key's
 * rows (a claims list without row state, a provisional row, a missing field) passes - or defaults to - `'not-loaded'`, and gets the
 * CONSERVATIVE conditional wording. Anything other than the literal 'loaded' is read as not loaded, so a missing input can never
 * select the plain wording.
 */
export type HandPostInput = { type?: string } & (
  | { state: 'loaded'; earlierPostingDetails: readonly EarlierPosting[]; retiredUnproven: readonly string[] }
  | { state: 'not-loaded' }
)

export type HandPostFlow = 'update' | 'payment' | 'conditional' | 'untyped'
export type HandPostBranch = { when: string; then: string }

export type HandPostInstruction = {
  /**
   * THE POSTING TYPE, AND NOTHING ELSE, decides this (Codex round 10). 'update' = an edit of one document (SALES_INVOICE_UPDATE,
   * PURCHASE_INVOICE_UPDATE); 'payment' = BILL_PAYMENT; 'conditional' = a type whose key is not reused, so no earlier document can
   * exist; 'untyped' = the type is not known here. What was loaded (earlier documents, retired attempts, nothing) never changes
   * which action or which Mark-as-handled condition applies: it can only ADD factual sentences.
   */
  flow: HandPostFlow
  /** The instruction sentence, lower-case, no trailing full stop: the ONE text every surface carries. */
  step: string
  /** The same instruction as a table: what to do when each ledger state is found. */
  branches: HandPostBranch[]
  /** What must be true before "Mark as handled" is pressed, as a clause that follows "only once". */
  markHandledCondition: string
  /** What the operator confirms by pressing it, as a clause that follows "Mark this handled ONLY if". */
  markHandledConfirms: string
  /** What the operator must NOT release over, as a clause that follows "if". */
  alreadyDone: string
}

/**
 * ═══ Codex round 14: NO PREDICTIONS. ═══
 * Three rounds of "state only what holds in every branch" kept finding one more branch (a later posting declined during the claim; a later save
 * refused again; a stamped row on a one-posting key). So every operator-visible surface now states ONLY (a) what the action does at the moment it
 * runs and (b) "check Sync > Exceptions afterwards". This ONE constant set is the whole vocabulary; a whole-surface census forbids the prediction
 * vocabulary (will / closes / stays / suppresses / for ever / ...) in the modules that render it.
 */
export const CHECK_AFTERWARDS = 'Check Sync > Exceptions afterwards to see whether this row closed or a new one appeared.'
export const MARK_ACTION_NOW = 'Marking this records your confirmation and cancels IMS\'s own queued retry of this posting.'
export const CLAIM_ACTION_NOW = 'While you hold the claim, IMS does not queue this posting.'
/** The tail every refusing site's remedy uses after "mark this row handled" (Codex round 14: no prediction of what marking leads to). */
export const MARK_REMEDY_TAIL = `Marking the row handled cancels IMS's own queued retry of it. ${CHECK_AFTERWARDS}`
/**
 * Codex round 15: after a mark or a release that leaves a refusal outstanding, the operator may ALREADY have posted the current version by hand
 * while holding the claim, so "re-save it or post it" can duplicate it. Never an instruction to post without the ledger check first.
 */
export const AFTER_DECLINE_STEP =
  'Check whether the current version is already in the accounting system. If it is, take a fresh claim and mark the outstanding refusal handled. '
  + 'If it is absent, EITHER take a fresh claim first (the claim is what stops IMS queueing it while you post), check the ledger again under that claim, '
  + 'and only then post the current version by hand, OR - holding NO claim, because a save is declined while a claim is held - re-save the document.'
export const LEDGER_CHECK_FIRST = 'Check whether the current version is already in the accounting system. Only if it is absent: '
export const RELEASE_ACTION_NOW = 'Releasing gives up your claim on this posting.'
export const TAKE_TOAST = `Taken for hand posting. ${CLAIM_ACTION_NOW}`
export const RELEASE_TOAST = `Released. ${CHECK_AFTERWARDS}`
export const MARKED_TOAST = `Marked as handled. ${CHECK_AFTERWARDS}`
export const INCOMPLETE_HISTORY_BANNER =
  'Incomplete history: while this was held by hand, IMS declined at least one posting for it and could not record how many. '
  + `Compare this document with the ledger. ${CHECK_AFTERWARDS}`

/** A fact read in the same transaction as the action: what IMS declined while the claim was held. */
export function declinedWhileHeld(unaccounted: boolean, count: number): string {
  if (unaccounted) return ' While the claim was held IMS declined at least one posting for this document and could not record how many, so this row\'s history is incomplete.'
  return count > 0 ? ` While the claim was held IMS declined ${count} posting(s) for this document.` : ''
}

/**
 * The reused-key types (drift-guarded against `REUSED_POSTING_KEY_TYPES` in a test; this module stays import-free because the dialogs
 * are client components). For every one of them the refused posting is the NEXT version of something that may already be in the
 * ledger, whatever IMS loaded.
 */
export const UPDATE_POSTING_TYPES: ReadonlySet<string> = new Set(['SALES_INVOICE_UPDATE', 'PURCHASE_INVOICE_UPDATE'])
export const PAYMENT_POSTING_TYPES: ReadonlySet<string> = new Set(['BILL_PAYMENT'])

export function handPostFlowOf(type: string | undefined): HandPostFlow {
  if (typeof type !== 'string' || type.trim() === '') return 'untyped'
  if (UPDATE_POSTING_TYPES.has(type)) return 'update'
  if (PAYMENT_POSTING_TYPES.has(type)) return 'payment'
  return 'conditional'
}

/** What to do, per posting type. A function of the type ONLY. */
export function handPostInstruction(input: { type?: string }): HandPostInstruction {
  const flow = handPostFlowOf(input?.type)
  if (flow === 'update') {
    const branches: HandPostBranch[] = [
      { when: 'the current version is there', then: 'do not post again' },
      { when: 'only an earlier version is there', then: 'apply the update to it (do not raise a second document)' },
      { when: 'nothing is there', then: 'post it as a new document' },
    ]
    return {
      flow,
      step: 'check the ledger for the CURRENT version (the one this refused posting would have made, not an earlier version): '
        + branches.map((b) => `if ${b.when}, ${b.then}`).join('; '),
      branches,
      markHandledCondition: 'the CURRENT version is in the ledger',
      markHandledConfirms: 'the CURRENT version is in the ledger - already there, or you posted or updated it by hand',
      alreadyDone: 'the CURRENT version is already in the ledger',
    }
  }
  if (flow === 'payment') {
    const branches: HandPostBranch[] = [
      { when: 'the current payment is there', then: 'do not post again' },
      { when: 'only an earlier payment is there', then: 'register THIS payment as a NEW payment and do NOT alter the earlier payment' },
      { when: 'nothing is there', then: 'post it as a new payment' },
    ]
    return {
      flow,
      step: 'check the ledger for the CURRENT payment (the one this refused posting would have registered, not an earlier payment; an earlier payment does NOT discharge this one): '
        + branches.map((b) => `if ${b.when}, ${b.then}`).join('; '),
      branches,
      markHandledCondition: 'the CURRENT payment is in the ledger',
      markHandledConfirms: 'the CURRENT payment is in the ledger - already there, or you registered it as a new payment by hand',
      alreadyDone: 'the CURRENT payment is already in the ledger',
    }
  }
  if (flow === 'conditional') {
    return {
      flow,
      step: 'check the ledger for that document first; post it ONLY if it is absent. If it exists, do not post again',
      branches: [
        { when: 'it exists', then: 'do not post again' },
        { when: 'it is absent', then: 'post it' },
      ],
      markHandledCondition: 'the document is in the ledger (already there, or posted by you)',
      markHandledConfirms: 'the document is in the ledger - it was already there, or you posted it by hand',
      alreadyDone: 'the document is already in the ledger',
    }
  }
  return {
    flow,
    step: GENERIC_HAND_POST_STEP,
    branches: [
      { when: 'the current version of the posting is there', then: 'do not post again' },
      { when: 'the posting type has not been identified', then: 'identify it first' },
    ],
    markHandledCondition: 'the CURRENT version of the posting is in the ledger',
    markHandledConfirms: 'the CURRENT version of the posting is in the ledger - already there, or you posted it by hand once you had identified the posting type',
    alreadyDone: 'the CURRENT version of the posting is already in the ledger',
  }
}

/** The step for a posting whose type the caller knows (a refusing site's remedy, the not-claimed refusal). Typeless callers get the generic one. */
export function handPostStepFor(type: string | undefined): string {
  return handPostInstruction({ type }).step
}

/**
 * A row's hand-post inputs, from the fields the inbox row carries (the ONE mapping every dialog uses). `handPostState` is the
 * server's positive statement that it loaded the posting key's rows for this row; any row without it reads as not loaded.
 */
export function handPostInputOf(row: { type: string; handPostState?: 'loaded' | 'not-loaded'; earlierPostingDetails?: readonly EarlierPosting[]; retiredUnproven?: readonly string[] }): HandPostInput {
  if (row.handPostState !== 'loaded' || !row.earlierPostingDetails || !row.retiredUnproven) return { type: row.type, state: 'not-loaded' }
  return { type: row.type, state: 'loaded', earlierPostingDetails: row.earlierPostingDetails, retiredUnproven: row.retiredUnproven }
}

/** For a surface that has no row state (the claims list's Release button): the conservative reading. */
export const NOT_LOADED_HAND_POST_INPUT: HandPostInput = { state: 'not-loaded' }

/**
 * The step where even the posting TYPE is not known. It names no per-type branch ("update it" / "register as new"), because the right
 * one depends on the type: the operator must identify the type first (the exception inbox names it on the row).
 */
export const GENERIC_HAND_POST_STEP =
  'identify the posting type before any ledger work (the exception inbox names it on the row), then check the ledger for the CURRENT version of the '
  + 'posting: if it is there, do not post again; otherwise follow the step for that posting type'

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** "Press Mark as handled only once ...". ONE sentence for every surface that tells the operator when to press it. */
export function markHandledSentence(i: HandPostInstruction): string {
  return `Press "Mark as handled" only once ${i.markHandledCondition}, as your confirmation.`
}

/**
 * The earlier postings as a FACTUAL sentence about their standing ('' when none). It carries no instruction: what to do about them is
 * the single `step` (check for the CURRENT version; the earlier one alone never satisfies it).
 */
export function describeEarlierPostings(earlier: readonly EarlierPosting[]): string {
  if (earlier.length === 0) return ''
  const confirmed = earlier.filter((e) => e.standing === 'CONFIRMED_POSTED')
  const unverified = earlier.filter((e) => e.standing !== 'CONFIRMED_POSTED')
  const note = (e: EarlierPosting) => `${e.ref}${e.standing === 'ASSERTED_POSTED' ? ' (an id an operator typed in)' : ' (unproven)'}`
  return (confirmed.length > 0
    ? ` The ledger holds ${confirmed.map((e) => e.ref).join(', ')} for this obligation (confirmed by the connector), from an earlier version of this document.`
    : '')
    + (unverified.length > 0
      ? ` IMS records ${unverified.map(note).join(', ')} as posted for this obligation, from an earlier version of this document, and has NOT verified it.`
      : '')
}

export function describeRetiredUnproven(notes: readonly string[]): string {
  if (notes.length === 0) return ''
  // FACTUAL ONLY (Codex round 10): what IMS cannot rule out. Which action applies is the single step, by posting type.
  return ' Earlier attempt(s) at this posting were retired without proof that they never reached the ledger: '
    + `${notes.join('; ')}. `
    + 'IMS has no proof that the CURRENT version is not already in the ledger (an earlier version being there does not show it).'
}

/** The inbox row's "what to do first" text. */
/** What the Mark does to the row when ANOTHER operator holds the claim. ONE sentence for the inbox row and the refusal. */
export const OTHER_OPERATOR_CLAIM_OUTCOME =
  'While they hold the claim IMS does not queue it. If they are not going to finish, release their claim first.'

export function handPostOrderFor(state: HandPostInput & {
  queuedRow: 'unsent' | 'may-be-sent' | null
  claim: { at: string; byName: string | null; mine: boolean } | null
}): string {
  const instruction = handPostInstruction(state)
  const earlierDetails = state.state === 'loaded' && Array.isArray(state.earlierPostingDetails) ? state.earlierPostingDetails : []
  const retiredNotes = state.state === 'loaded' && Array.isArray(state.retiredUnproven) ? state.retiredUnproven : []
  const earlier = describeEarlierPostings(earlierDetails)
  const retired = describeRetiredUnproven(retiredNotes)
    + (state.state === 'loaded' && Array.isArray(state.earlierPostingDetails) && Array.isArray(state.retiredUnproven)
      ? ''
      : ' IMS did not load what the other sync rows for this posting say (earlier versions, retired attempts).')
  if (state.claim?.mine) {
    return `YOU are settling this by hand. ${CLAIM_ACTION_NOW} Take your time: ${capitalise(instruction.step)}. ${markHandledSentence(instruction)} `
      + 'If you are not going to post it, press "Release" to give up your claim.'
      + earlier
      + retired
  }
  if (state.claim) {
    return `${state.claim.byName ?? 'Another operator'} is settling this by hand (taken ${state.claim.at}). `
      + `Do NOT post it as well. ${OTHER_OPERATOR_CLAIM_OUTCOME}`
      + earlier
  }
  if (state.queuedRow === 'may-be-sent') {
    return 'DO NOT POST THIS BY HAND. IMS may ALREADY have posted this — its accounting sync row is in '
      + 'flight, has been claimed by a processor, or carries a document id — and posting it by hand could '
      + 'duplicate it. Find this posting in the accounting sync log and settle THAT row first; '
      + 'taking it for hand posting is refused while that row stands.'
      + earlier
  }
  return 'DO NOT POST THIS BY HAND YET. Press "Take for hand posting" FIRST. That is one transaction which '
    + (state.queuedRow === 'unsent'
      ? 'cancels the queued row IMS is holding for this posting (nothing has picked it up yet), refuses if '
        + 'any row may already have been sent, '
      : 'refuses if any row for this posting may already have been sent, cancels any that provably has not, ')
    + 'and, while you hold it, IMS does not queue this posting. '
    + `Then ${instruction.step}. ${markHandledSentence(instruction)}`
    + earlier
    + retired
}

/** The "Take for hand posting" dialog: the same instruction the row text carries, for the same row. */
export function claimWarningFor(input: HandPostInput): string {
  const instruction = handPostInstruction(input)
  return `Take this posting to settle it by hand. ${CLAIM_ACTION_NOW} (Not on a sweep, not when another operator saves the document.) `
    + 'Any queued row nothing has picked up is cancelled when you take it; if a row may ALREADY have been sent you are told instead and '
    + `nothing is changed. Then ${instruction.step}. ${markHandledSentence(instruction)} If you decide not to post it, `
    + 'press "Release" to give up your claim.'
}

/** The "Mark as handled" dialog. IMS does not read the ledger when it is pressed, so the dialog says what the operator confirms. */
export function markHandledWarningFor(input: HandPostInput): string {
  const instruction = handPostInstruction(input)
  return `Mark this handled ONLY if ${instruction.markHandledConfirms}. IMS does not read the ledger when you press it - it takes `
    + `your word. Marking it means: "I posted this by hand or confirmed it is there." ${MARK_ACTION_NOW} ${CHECK_AFTERWARDS} `
    + 'If IMS may already have posted it, you are told, and nothing is changed.'
}

/** The "Release" dialog. */
export function releaseWarningFor(input: HandPostInput): string {
  const instruction = handPostInstruction(input)
  return `${RELEASE_ACTION_NOW} Do NOT release it if ${instruction.alreadyDone} — press "Mark as handled" instead. `
    + `Releasing somebody else's claim is allowed, and recorded. ${CHECK_AFTERWARDS}`
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The activity-log and notice texts of the three actions, from the same constant set (state at the moment + check afterwards; no predictions).
// ---------------------------------------------------------------------------------------------------------------------------------------------

export function claimLogDescription(args: { cancelledCount: number; earlier: string; retired: string; step: string }): string {
  return `Took a refused accounting posting to settle it by hand. ${CLAIM_ACTION_NOW}`
    + (args.cancelledCount > 0 ? ` ${args.cancelledCount} unsent queued row(s) for it were cancelled.` : '')
    + args.earlier + args.retired + ` Instruction shown, to follow under the claim just taken: ${args.step}.`
}

export function releaseLogDescription(args: { unaccounted: boolean; deferredEdits: number }): string {
  return `Released the hand-posting claim on a refused accounting posting. ${RELEASE_ACTION_NOW} The refusal is outstanding in the exception inbox.`
    + declinedWhileHeld(args.unaccounted, args.deferredEdits)
    + ` ${CHECK_AFTERWARDS}`
}

export function releaseNotice(args: { unaccounted: boolean; deferredEdits: number }): string | null {
  const declined = declinedWhileHeld(args.unaccounted, args.deferredEdits)
  return declined === '' ? null : `Released.${declined} ${AFTER_DECLINE_STEP} ${CHECK_AFTERWARDS}`
}

export function markLogDescription(args: { kind: string; cancelledCount: number; stillOutstanding: boolean; unaccounted: boolean; deferredEdits: number }): string {
  return `Marked a refused ${args.kind} posting as handled: the operator confirmed the current version is in the ledger (posted by hand, or already there); IMS did not read the ledger. `
    + `${MARK_ACTION_NOW}`
    + (args.cancelledCount > 0 ? ` ${args.cancelledCount} unsent queued row(s) for it were cancelled.` : '')
    + (args.stillOutstanding ? ` This row is STILL OUTSTANDING.${declinedWhileHeld(args.unaccounted, args.deferredEdits)} ${AFTER_DECLINE_STEP}` : '')
    + ` ${CHECK_AFTERWARDS}`
}

export function markNotice(args: { unaccounted: boolean; deferredEdits: number }): string {
  return `Your confirmation is recorded. This row is STILL OUTSTANDING.${declinedWhileHeld(args.unaccounted, args.deferredEdits)} `
    + `${AFTER_DECLINE_STEP} ${CHECK_AFTERWARDS}`
}

/** Wording for surfaces that know no row state: what a refusing site's remedy / the not-claimed refusal / the help text say. */
export const GENERIC_HAND_POST_REMEDY_TAIL = `${GENERIC_HAND_POST_STEP}, then mark it handled in the exception inbox`

export const HAND_POST_INSTRUCTION_DOC_BEGIN = '<!-- hand-post-instruction:begin -->'
export const HAND_POST_INSTRUCTION_DOC_END = '<!-- hand-post-instruction:end -->'

/** The help-docs block: GENERATED from the same structure the row text, the dialogs and the claim log use. */
export function renderHandPostInstructionDoc(): string {
  const rows: Array<[string, { type?: string }]> = [
    ['An invoice or bill UPDATE (SALES_INVOICE_UPDATE, PURCHASE_INVOICE_UPDATE) - whatever IMS loaded: earlier versions, retired attempts, or nothing', { type: 'SALES_INVOICE_UPDATE' }],
    ['A bill PAYMENT (BILL_PAYMENT) - whatever IMS loaded', { type: 'BILL_PAYMENT' }],
    ['Any other posting (no earlier document can exist)', { type: 'SALES_INVOICE' }],
    ['The posting type is not known where the text is shown', {}],
  ]
  return [
    HAND_POST_INSTRUCTION_DOC_BEGIN,
    'Take the posting for hand posting first and hold that claim while you work: every row below applies only under that claim.',
    '',
    '| Posting type | What the page, the dialogs and the log tell you | When to press *Mark as handled* |',
    '|---|---|---|',
    ...rows.map(([name, input]) => {
      const i = handPostInstruction(input)
      return `| ${name} | Hold the hand-post claim, then: ${i.step}. | Only once ${i.markHandledCondition}. |`
    }),
    HAND_POST_INSTRUCTION_DOC_END,
  ].join('\n')
}

export const HAND_POST_SETTLEMENT_DOC_BEGIN = '<!-- hand-post-settlement:begin -->'
export const HAND_POST_SETTLEMENT_DOC_END = '<!-- hand-post-settlement:end -->'

/**
 * The help-docs prose for Take / Mark / Release / the claims list, GENERATED from the same constant set (Codex round 14: no predictions of
 * what happens AFTER an operator action; each paragraph states what the action does now and sends the operator to the list).
 */
export function renderHandPostSettlementDoc(): string {
  return [
    HAND_POST_SETTLEMENT_DOC_BEGIN,
    `  **1. Take for hand posting.** Press this *before* you go to the ledger. ${CLAIM_ACTION_NOW} (Not on a sweep, not when another operator saves the document.) `
      + 'It cancels any queued attempt at that posting that nothing has picked up. If a sync row for it may ALREADY have been sent (it is being processed, '
      + 'has failed, or carries a document id) you are refused here and nothing is changed: check the ledger and settle that sync row first. '
      + 'While you hold the claim the row is on this list, marked as being settled by you; another operator who opens the page is told you hold it. '
      + 'Each refused attempt is logged as `accounting_posting_suppressed_hand_post_claimed`.',
    '',
    `  **2. Mark as handled.** ${MARK_ACTION_NOW} IMS does not read the ledger when you press it: it takes your word, so press it only when the table above says so. `
      + 'It asks for an optional note (for example the ledger journal number) and records who marked it and when. '
      + 'It is refused if you do not hold the posting, and on a row that IMS clears itself. '
      + `${CHECK_AFTERWARDS} Resolved rows from the last 30 days are listed underneath with how each was closed.`,
    '',
    `  **Release.** ${RELEASE_ACTION_NOW} Do not release it if you have already posted it by hand: press *Mark as handled* instead. `
      + `Releasing somebody else's claim is allowed and is recorded as a **warning**. ${CHECK_AFTERWARDS}`,
    '',
    '  **Postings being settled by hand.** Every claim is listed in its own section, independent of the refusal list (which shows the oldest 50 debts). '
      + 'A claim has no expiry: somebody confirms the posting or releases it. Each row shows who holds it, how long it has been held, and how many postings '
      + 'IMS declined to queue while it was held. That count includes an attempt that was already queued when the posting was taken: taking it cancels that attempt, '
      + 'and the decline is logged as `accounting_posting_refusal_clear_declined_hand_post_claim`. If the count could not be written the row says '
      + `"at least one, NOT COUNTED" and its history is incomplete: compare the document with the ledger. ${CHECK_AFTERWARDS} `
      + 'Anything held far longer than a hand posting takes is flagged: a prompt to ask the holder or release it.',
    '',
    '  **Finding a claim.** The longest-held claims are listed separately at the top, each with its own Release. Below them is the rest of the list, and '
      + '**Show more claims** pages through it. The page does not tell you when you have seen every claim, because claims are taken and given back while you read. '
      + 'To reach a specific posting, SEARCH for its document: the **Find** box searches the reference id (an order or PO number), the reference type, '
      + "the posting type and the refusal id. It does not search the holder's name, so an empty result is not evidence that nobody holds the posting. "
      + "Anybody with sync access may release anybody's claim.",
    '',
    '  **If the document is saved again while you hold the claim.** IMS declines to queue that posting, including a later version of the same document '
      + '(an invoice update, a bill update, a bill payment). Each decline is counted on the row and shown in the claims section as *postponed behind it*. '
      + `When you press *Mark as handled* after that, the page tells you whether the row is still outstanding. ${AFTER_DECLINE_STEP} ${CHECK_AFTERWARDS}`,
    '',
    '  **An earlier version of the same document.** For the postings where successive versions share one entry (an invoice update, a bill update, '
      + 'a bill payment) the ledger may already hold the previous version. IMS names that document on the row and does not stop you taking the posting. '
      + 'Whatever its standing, the earlier document is not the current version: check the ledger for the CURRENT version (the table above).',
    '',
    '  **Refusals recorded after a mark.** A refusal of a posting that was marked handled is logged (`accounting_posting_refused_after_handled_by_hand`) or listed, '
      + 'depending on the posting type. A refusal that arrives while the posting is being queued is logged (`accounting_posting_refused_after_queued`) and not listed, '
      + 'because the posting is in the accounting sync log. A refusal raised from inside a piece of work that is not allowed to wait for the posting\'s lock is held with that work, '
      + 'and the next **accounting sync** run settles it under the lock (`accounting_posting_refusal_not_recorded_contended`). When IMS is unable to tell whether a posting '
      + 'beat a refusal it lists the refusal: look at the sync log entry and settle it there; *Take for hand posting* is refused while IMS may already have posted.',
    '',
    '  **Unconfirmed rows.** A held refusal that the accounting sync run has not settled within about 15 minutes is listed marked '
      + '**Unconfirmed — not yet known to be owed**. An unconfirmed row offers no *Take for hand posting* action and **must not be posted by hand**: '
      + 'the posting may still belong to the job that held the lock. The usual cause is that `/api/cron/accounting-sync` is not running: check that first. '
      + 'A claim the run keeps failing to settle is moved to the **integration outbox failures** section.',
    HAND_POST_SETTLEMENT_DOC_END,
  ].join('\n')
}


// ---------------------------------------------------------------------------------------------------------------------------------------------
// Codex round 16: EVERY remedy a refusing site writes passes through ONE sink guard, so a hand-post / re-post / re-save instruction can never reach an
// operator without the claim-and-ledger-check preamble in front of it. (Auditing ~100 hand-written remedy strings one by one is what kept failing open;
// a string that already carries the preamble is left alone, and a string with no such instruction is not touched.)
// ---------------------------------------------------------------------------------------------------------------------------------------------

/** An imperative to post, re-post, re-save, re-send, retry, reset, raise, enter or register something, or to do anything "by hand" / "yourself". */
export const HAND_POST_INSTRUCTION_PATTERN =
  /\b(post|re-?post|repost|re-?send|resend|retry|reset|re-?save|resave|raise|re-?raise|enter|register|record|book|apply|allocate|settle|reconcile|journal|credit|refund|void)\b[^.]{0,80}\b(by hand|yourself|manually|again|in the ledger|in the accounting system|from (its|the) source document|in (Xero|QuickBooks))\b|\bpost (it|this|that|the current (version|payment)|its current version)\b|\byourself\b|\bre-?save\b|\bre-?post\b|\bresend\b|\bre-?raise\b/i

export const HAND_POST_SAFETY =
  'BEFORE any hand posting, re-post or re-save: take the posting for hand posting on this row and hold that claim (so IMS does not queue it while you work), '
  + 'and check whether the current version is already in the accounting system; act only if it is absent.'

/** The text with the safety preamble in front of it when it carries an instruction (idempotent; text with no instruction is returned unchanged). */
export function withHandPostSafety(text: string): string {
  if (!HAND_POST_INSTRUCTION_PATTERN.test(text) || text.includes(HAND_POST_SAFETY)) return text
  return `${HAND_POST_SAFETY} ${text}`
}


/**
 * Codex round 17: for the operator-visible instruction texts that are NOT on the refusal inbox (an error message on a purchase order, a chargeback warning, a
 * reconciliation message): there is no hand-post claim there, so the preamble is the LEDGER CHECK alone. Idempotent; text with no instruction is untouched; a text
 * that already carries the full hand-post preamble is left alone.
 */
export const LEDGER_CHECK_PREAMBLE = 'BEFORE acting on this: check whether the current version is already in the accounting system, and act only if it is absent.'

export function withLedgerCheck(text: string): string {
  if (!HAND_POST_INSTRUCTION_PATTERN.test(text) || text.includes(LEDGER_CHECK_PREAMBLE) || text.includes(HAND_POST_SAFETY)) return text
  return `${LEDGER_CHECK_PREAMBLE} ${text}`
}
