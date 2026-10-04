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
  /**
   * What pressing Mark as handled DOES, per posting type (Codex round 11): the server cancels IMS's own queued retry and resolves the
   * row for every type, but it writes the durable suppression (`suppressedAt`) only where the posting key names ONE posting for ever.
   * On a reused key (update / payment) a later save can queue a new posting, and the dialog must not promise otherwise.
   */
  markHandledEffect: string
}

const EFFECT_REUSED_KEY =
  'Marking this records that you dealt with it in the ledger and cancels IMS\'s own queued retry of it. Whether THIS refusal then closes depends on '
  + 'whether a later posting was declined while you held it (if one was, the refusal stays open, your claim is released, and IMS tells you when you press it). '
  + 'It does not suppress later postings: a later save of the document may queue a new posting or be refused again. Check Sync > Exceptions afterwards to confirm which.'
const EFFECT_ONE_POSTING_KEY =
  'IMS cancels its own retry of this posting and will refuse to post it from then on, so it cannot reach the ledger twice.'
const EFFECT_TYPE_UNKNOWN =
  'This records that you dealt with it and cancels IMS\'s own queued retry of it. Whether this refusal closes, and whether IMS refuses to post it again, depends on the posting type and on whether a later posting was declined while you held it. Check Sync > Exceptions afterwards.'

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
      markHandledEffect: EFFECT_REUSED_KEY,
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
      markHandledEffect: EFFECT_REUSED_KEY,
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
      markHandledEffect: EFFECT_ONE_POSTING_KEY,
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
    markHandledEffect: EFFECT_TYPE_UNKNOWN,
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
  return `Press "Mark as handled" only once ${i.markHandledCondition}, to confirm it and close this row.`
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
    + 'IMS cannot rule out that the CURRENT version is already in the ledger (an earlier version being there does not show it): a second one is not undone by marking this handled.'
}

/** The inbox row's "what to do first" text. */
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
    return 'YOU are settling this by hand. IMS will not queue this posting while you hold it, so take your '
      + `time: ${capitalise(instruction.step)}. ${markHandledSentence(instruction)} If `
      + 'you are not going to post it, press "Release" — IMS may then queue it again.'
      + earlier
      + retired
  }
  if (state.claim) {
    return `${state.claim.byName ?? 'Another operator'} is settling this by hand (taken ${state.claim.at}). `
      + 'Do NOT post it as well. IMS will not queue it while they hold it, and the row closes when they '
      + 'confirm. If they are not going to finish, release their claim first.'
      + earlier
  }
  if (state.queuedRow === 'may-be-sent') {
    return 'DO NOT POST THIS BY HAND. IMS may ALREADY have posted this — its accounting sync row is in '
      + 'flight, has been claimed by a processor, or carries a document id — so posting it now is how the '
      + 'ledger gets it twice. Find this posting in the accounting sync log and settle THAT row first; '
      + 'taking it for hand posting will refuse until you do.'
      + earlier
  }
  return 'DO NOT POST THIS BY HAND YET. Press "Take for hand posting" FIRST. That is one transaction which '
    + (state.queuedRow === 'unsent'
      ? 'cancels the queued row IMS is holding for this posting (nothing has picked it up yet), refuses if '
        + 'any row may already have been sent, '
      : 'refuses if any row for this posting may already have been sent, cancels any that provably has not, ')
    + 'and stops IMS queueing this posting at all while you hold it — so IMS cannot send it behind you '
    + 'while you are in the ledger. '
    + `Then ${instruction.step}. ${markHandledSentence(instruction)}`
    + earlier
    + retired
}

/** The "Take for hand posting" dialog: the same instruction the row text carries, for the same row. */
export function claimWarningFor(input: HandPostInput): string {
  const instruction = handPostInstruction(input)
  return 'Take this posting to settle it by hand. From the moment you do, IMS will NOT queue it — not on a sweep, not '
    + 'from another operator saving the document — so nothing can post it while you are in the ledger. Any queued '
    + 'row nothing has picked up is cancelled now; if a row may ALREADY have been sent you will be told instead and '
    + `nothing is changed. Then ${instruction.step}. ${markHandledSentence(instruction)} If you decide not to post it, `
    + 'press "Release" so IMS can queue it again.'
}

/** The "Mark as handled" dialog. IMS does not read the ledger when it is pressed, so the dialog says what the operator confirms. */
export function markHandledWarningFor(input: HandPostInput): string {
  const instruction = handPostInstruction(input)
  return `Mark this handled ONLY if ${instruction.markHandledConfirms}. IMS does not read the ledger when you press it - it takes `
    + `your word. Marking it means: "I posted this by hand or confirmed it is there." ${instruction.markHandledEffect} If IMS may already have `
    + 'posted it, you will be told, and nothing is changed.'
}

/** The "Release" dialog: the one act that re-opens the window. */
export function releaseWarningFor(input: HandPostInput): string {
  const instruction = handPostInstruction(input)
  return 'Release this posting. IMS may queue and post it again from now on, and the refusal stays outstanding. Do NOT '
    + `release it if ${instruction.alreadyDone} — press "Mark as handled" instead, or the ledger can get it `
    + 'twice. Releasing somebody else\'s claim is allowed, and recorded.'
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
    '| Posting type | What the page, the dialogs and the log tell you | When to press *Mark as handled* |',
    '|---|---|---|',
    ...rows.map(([name, input]) => {
      const i = handPostInstruction(input)
      return `| ${name} | ${capitalise(i.step)}. | Only once ${i.markHandledCondition}. |`
    }),
    HAND_POST_INSTRUCTION_DOC_END,
  ].join('\n')
}
