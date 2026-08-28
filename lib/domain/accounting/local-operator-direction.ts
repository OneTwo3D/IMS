/**
 * WHAT A RECORD THAT CAN NAME NOTHING MAY TELL AN OPERATOR TO DO — THE STRUCTURE, AND THE PROSE IT
 * GENERATES (o3d-batch-ret r18, Codex HIGH).
 *
 * ROUND 17 BUILT THIS MODEL IN THE TEST FILE. The coupling it claimed — that a shipped instruction
 * cannot name a remote object, because a direction pairs an action WITH a target and its sentence is
 * chosen by that pair — was therefore a property of a FIXTURE. The test asserted only that the
 * generated span appeared SOMEWHERE INSIDE independently written production prose
 * (`text.includes(span)`), so a formatter could keep the span and extend that same instruction with
 * a remote action: the type-checker constrained the rebuild, not the record.
 *
 * SO IT LIVES HERE, AND THE FORMATTERS COMPOSE THE SHIPPED SENTENCE FROM IT. Every operator
 * instruction in `unrecorded-posted-document.ts` that a lookup-less record carries is
 * `renderLocalDirection(...)` interpolated into the message — not prose that happens to contain the
 * same words. An instruction the model cannot represent cannot be composed, and one composed from a
 * direction whose target does not match what the sentence is about does not type-check.
 *
 * Nothing about the model itself changed in the move: the same five targets, the same fourteen
 * directions, the same total renderer. What changed is which artefact the invariant is about.
 *
 * ROUND 19 (Codex HIGH) THEN FIXED WHAT THE MOVE EXPOSED: one direction was emitting two
 * imperatives, only one of which its declared {action, target} covered. See the block above
 * `LocalDirectionSequence` at the end of this file — compound remediation is a SEQUENCE now, and
 * `after` is gone.
 */

/**
 * THE IMS-LOCAL OBJECTS A RECORD THAT CAN NAME NOTHING IS STILL ALLOWED TO POINT AT.
 *
 * A closed union, and the whole safety property is in what it does NOT have: there is no member for
 * a bill, an invoice, a ledger document, a WooCommerce order — for anything in somebody else's
 * system.
 *
 * ROUND 17 (Codex HIGH): THAT UNION USED TO SIT NEXT TO THE SENTENCE INSTEAD OF PRODUCING IT.
 *
 * Round 16 paired each direction with a hand-written `span` and a separately hand-written `object`,
 * and the only thing tying the two together was `assert.ok(object.length > 0)`. So the closed type
 * constrained a LABEL, and nothing established that the label was the thing the sentence was about.
 * Codex's route, in full: extend the escalation span with the books/entry/PDF sentence, leave
 * `object: 'this record and its sync row'` exactly as it stands, leave the cap at 14. The sentence
 * carries no mutation lexeme, so round 14 passes it; the extended span is a REVIEWED span, so round
 * 16's closure strips it and passes; TypeScript sees a member of the union and compiles. A remote
 * instruction ships, and the type that was supposed to make it unrepresentable never read it.
 *
 * SO THERE IS NO `span` FIELD ANY MORE. A direction is a discriminated {action, target} value with
 * typed parameters and NOTHING ELSE — no field of free text anywhere in it — and its prose is
 * produced by `renderLocalDirection`, a total function whose every branch is selected by the action
 * and the target. The target does not annotate a sentence somebody else wrote; it CHOOSES the
 * sentence. Codex's route is a type error now rather than a review failure, because the field the
 * instruction was smuggled into does not exist.
 *
 * AND THE PARAMETERS ARE TYPED TOO, for the same reason: the outbox directions name their columns
 * from `OutboxReadAxis`, the setting directions cannot name a setting other than the two IMS holds.
 * There is no string in a direction that a reviewer has to read.
 *
 * WHAT THIS STILL DOES NOT BUY, stated rather than implied — the same residue round 16 named for
 * RECORD_PROSE. The renderer's own strings can be edited, and somebody who writes a remote
 * instruction into the ESCALATE branch has written a remote instruction. That is a diff on a named
 * branch of a function, in front of a reviewer, and `LOCAL_DIRECTION_SPANS` must still appear
 * verbatim in a shipped message, so the edit fails here unless the module ships the same sentence
 * too. What is GONE is the shape where an instruction arrives as DATA in a field whose neighbouring
 * label goes on claiming the target is local.
 */
export type LocalTarget =
  | 'ORDER_INVOICE_PDF'
  | 'EMAIL_OUTBOX_ROWS'
  | 'SETTING_SYNC_ENABLED'
  | 'SETTING_ATTACH_PDF'
  | 'THIS_RECORD_AND_ITS_SYNC_ROW'

/**
 * What each target IS, and the words a message must already be using for a direction at it to be
 * about it. The `anchor` is the second half of the coupling: generation makes the sentence a
 * function of the target, and the anchor check makes the MESSAGE the sentence ships in name that
 * same target — so a direction cannot be a fragment floating in a message about something else.
 */
export const LOCAL_TARGET: Record<LocalTarget, {
  object: string
  anchor: string
  /**
   * Whether naming the anchor DISTINGUISHES this target from the others. Four of the five do: an
   * outbox direction lands in messages that say "outbox", and there are shipped messages that never
   * say it, so the check can fail and does discriminate.
   *
   * The fifth cannot, and saying so is more honest than choosing a word that looks discriminating.
   * The target of an escalation IS the record the operator is reading, and every one of these
   * records names its own sync row — that is the invariant the whole file is built on. So its
   * anchor is UNIVERSAL: asserting it proves the records still name themselves, and nothing about
   * which direction landed where. What couples that target is the other half of round 17 — the
   * ESCALATE branch of `renderLocalDirection` cannot produce prose about anything else, because
   * there is no field to put other prose in.
   */
  reach: 'DISTINGUISHING' | 'UNIVERSAL'
}> = {
  ORDER_INVOICE_PDF: {
    object: 'the invoice PDF IMS stored against the order',
    anchor: 'invoice PDF',
    reach: 'DISTINGUISHING',
  },
  EMAIL_OUTBOX_ROWS: {
    object: 'the local EmailOutbox rows',
    anchor: 'outbox',
    reach: 'DISTINGUISHING',
  },
  SETTING_SYNC_ENABLED: {
    object: 'the plugin setting quickbooks_sync_enabled',
    anchor: 'quickbooks_sync_enabled',
    reach: 'DISTINGUISHING',
  },
  SETTING_ATTACH_PDF: {
    object: 'the plugin setting quickbooks_sync_attach_pdf',
    anchor: 'quickbooks_sync_attach_pdf',
    reach: 'DISTINGUISHING',
  },
  THIS_RECORD_AND_ITS_SYNC_ROW: {
    object: 'this record and its sync row',
    anchor: 'sync row',
    reach: 'UNIVERSAL',
  },
}

/** The EmailOutbox columns (and the one derived axis) a direction may send a reader to read. */
export type OutboxReadAxis = 'status' | 'attempts' | 'lastError' | 'createdAt' | 'sentAt' | 'time'

/** The two settings IMS itself holds. There is no third, and no way to name anything else. */
export const SETTING_NAME: Record<'SETTING_SYNC_ENABLED' | 'SETTING_ATTACH_PDF', string> = {
  SETTING_SYNC_ENABLED: 'quickbooks_sync_enabled',
  SETTING_ATTACH_PDF: 'quickbooks_sync_attach_pdf',
}

/**
 * WHAT A LOOKUP-LESS RECORD MAY TELL AN OPERATOR TO DO, AS STRUCTURE.
 *
 * Every member pairs an action with an IMS-LOCAL target, and carries only enumerated parameters.
 * Every action is read-only or a switch on IMS's own setting; there is no member whose target is in
 * anybody else's system, and no member with a field that would accept one.
 */
export type LocalDirection =
  | { action: 'CONFIRM'; target: 'ORDER_INVOICE_PDF' }
  | {
      action: 'INSPECT'
      target: 'EMAIL_OUTBOX_ROWS'
      selector: 'THIS_ORDERS_ROWS' | 'BY_KIND_AND_REFERENCE'
      read: readonly OutboxReadAxis[]
    }
  | { action: 'READ'; target: 'EMAIL_OUTBOX_ROWS'; read: readonly OutboxReadAxis[] }
  | { action: 'RE_READ'; target: 'EMAIL_OUTBOX_ROWS' }
  | { action: 'TURN_OFF'; target: 'SETTING_SYNC_ENABLED'; control: 'LEVER_BELOW' | 'CONNECTOR_PANEL_CHECKBOX' }
  /**
   * o3d-batch-ret r19 (Codex HIGH): the two LEAVE-IT-OFF sentences are two FORMS of one action on
   * one target, not one of them plus a clause hidden inside an escalation. `BEFORE_ESCALATION` is
   * the half that used to live in the ESCALATE branch's `after` field.
   */
  | { action: 'LEAVE_OFF'; target: 'SETTING_SYNC_ENABLED'; form: 'NOT_A_FENCE' | 'BEFORE_ESCALATION' }
  | {
      action: 'READ_SETTING'
      target: 'SETTING_ATTACH_PDF'
      lead: 'THEN_GO_AND' | 'NONE'
      purpose: 'LEARN_WHAT_A_REPLAY_WOULD_DO' | 'NONE'
    }
  | { action: 'ESCALATE'; target: 'THIS_RECORD_AND_ITS_SYNC_ROW'; naming: 'SYNC_ROW' }
  | {
      action: 'ESCALATE'
      target: 'THIS_RECORD_AND_ITS_SYNC_ROW'
      naming: 'RECORD_ONLY'
      caseForm: 'SENTENCE' | 'CLAUSE'
    }

/** "a, b and c" — the shipped wording for a list of read axes. */
function andList(items: readonly string[]): string {
  return items.length < 2
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/**
 * THE PROSE, GENERATED FROM THE STRUCTURE. Total over `LocalDirection`: adding a member without a
 * branch here fails the build on the return type, and there is no default case to absorb one.
 *
 * Every sentence lives in the branch its TARGET selects. A direction cannot carry text its target
 * did not choose, which is the whole of the round-17 fix.
 */
export type LocalDirectionContext = {
  /** The accounting package's display name, exactly as the surrounding message spells it. */
  ledger: string
  /** The sync row this record names — the only id an ESCALATE direction may print. */
  syncRowId: string
}

export function renderLocalDirection(direction: LocalDirection, context: LocalDirectionContext): string {
  switch (direction.action) {
    case 'CONFIRM':
      return 'confirm the invoice PDF stored against the order is the document you expect'
    case 'INSPECT': {
      const selector = direction.selector === 'THIS_ORDERS_ROWS'
        ? 'Inspect the outbox rows for this order'
        : 'Then INSPECT the outbox: query it for kind ACCOUNTING_INVOICE, referenceType SalesOrder, '
          + 'referenceId = the order id (no page in IMS lists them)'
      return `${selector} and read each row's ${andList(direction.read)}.`
    }
    case 'READ':
      return `Read them by ${andList(direction.read)}`
    case 'RE_READ':
      return 'so re-run the query rather than treating one result as the final list'
    case 'TURN_OFF':
      return direction.control === 'LEVER_BELOW'
        ? 'TURN THE LEVER BELOW OFF FIRST, so that no NEW run is admitted'
        : `HOW TO STOP MORE OF IT: turn ${context.ledger} sync OFF. The control is the checkbox at the top of `
          + `the SYNC tab of the ${context.ledger} connector panel, and it writes the setting `
          + `${SETTING_NAME[direction.target]}.`
    case 'LEAVE_OFF':
      return direction.form === 'NOT_A_FENCE'
        ? 'THEN LEAVE IT OFF, BECAUSE TURNING IT OFF IS NOT A FENCE.'
        : 'Leave the toggle off'
    case 'READ_SETTING': {
      const lead = direction.lead === 'THEN_GO_AND' ? 'THEN GO AND ' : ''
      const purpose = direction.purpose === 'LEARN_WHAT_A_REPLAY_WOULD_DO'
        ? ' to learn what a replay would do'
        : ''
      return `${lead}READ ${SETTING_NAME[direction.target]} AS IT STANDS NOW${purpose}`
    }
    case 'ESCALATE': {
      const administrator = 'to whoever administers this installation'
      if (direction.naming === 'SYNC_ROW') {
        return `ESCALATE sync row ${context.syncRowId}, with this record, ${administrator}`
      }
      return `${direction.caseForm === 'SENTENCE' ? 'Escalate' : 'escalate'} this record ${administrator}`
    }
  }
}

/**
 * THE COMPLETE INVENTORY OF WHAT A LOOKUP-LESS RECORD TELLS AN OPERATOR TO DO. Every one is at an
 * object IMS itself holds and this message names, every one is read-only or a switch on IMS's own
 * setting, and the cap is the review: a fifteenth line means somebody decided to add an instruction
 * to a record that can name nothing, and has to raise the cap in front of a reviewer to do it.
 */
export const LOCAL_DIRECTIONS: readonly LocalDirection[] = [
  // The PDF IMS downloaded and stored against the order. Local file, read-only, and the message
  // prints the IMS reference that reaches it.
  { action: 'CONFIRM', target: 'ORDER_INVOICE_PDF' },
  // The local EmailOutbox rows, by that table's own columns — every one walked into the schema in
  // rounds 6 through 9. Reads only: EmailOutbox has no state that means "cancelled", and the record
  // says so in prose rather than instructing one.
  {
    action: 'INSPECT',
    target: 'EMAIL_OUTBOX_ROWS',
    selector: 'THIS_ORDERS_ROWS',
    read: ['status', 'attempts', 'lastError', 'sentAt'],
  },
  {
    action: 'INSPECT',
    target: 'EMAIL_OUTBOX_ROWS',
    selector: 'BY_KIND_AND_REFERENCE',
    read: ['status', 'attempts', 'lastError', 'createdAt', 'sentAt'],
  },
  { action: 'RE_READ', target: 'EMAIL_OUTBOX_ROWS' },
  { action: 'READ', target: 'EMAIL_OUTBOX_ROWS', read: ['status', 'lastError', 'time'] },
  // The two plugin settings. Reading one is read-only; turning one off writes an IMS row and
  // touches nothing in anybody else's system — and the record says in prose, at length, that the
  // switch is an admission check rather than a fence.
  { action: 'TURN_OFF', target: 'SETTING_SYNC_ENABLED', control: 'LEVER_BELOW' },
  { action: 'READ_SETTING', target: 'SETTING_ATTACH_PDF', lead: 'THEN_GO_AND', purpose: 'NONE' },
  {
    action: 'READ_SETTING',
    target: 'SETTING_ATTACH_PDF',
    lead: 'NONE',
    purpose: 'LEARN_WHAT_A_REPLAY_WOULD_DO',
  },
  { action: 'TURN_OFF', target: 'SETTING_SYNC_ENABLED', control: 'CONNECTOR_PANEL_CHECKBOX' },
  { action: 'LEAVE_OFF', target: 'SETTING_SYNC_ENABLED', form: 'NOT_A_FENCE' },
  { action: 'LEAVE_OFF', target: 'SETTING_SYNC_ENABLED', form: 'BEFORE_ESCALATION' },
  // The escalation, in the three shapes the module writes it. Its target is this record and the
  // sync row this message names — both IMS's own — and it is ONE act on that one target: the
  // "leave the toggle off" half is now the LEAVE_OFF direction above, sequenced in front of it.
  { action: 'ESCALATE', target: 'THIS_RECORD_AND_ITS_SYNC_ROW', naming: 'SYNC_ROW' },
  { action: 'ESCALATE', target: 'THIS_RECORD_AND_ITS_SYNC_ROW', naming: 'RECORD_ONLY', caseForm: 'SENTENCE' },
  { action: 'ESCALATE', target: 'THIS_RECORD_AND_ITS_SYNC_ROW', naming: 'RECORD_ONLY', caseForm: 'CLAUSE' },
]

/** The most instructions a record that can name nothing may carry. Raising this IS the decision. */
export const LOCAL_DIRECTION_CAP = 14

// ---------------------------------------------------------------------------
// COMPOUND REMEDIATION IS A SEQUENCE OF DIRECTIONS, NOT A DIRECTION WITH AN EXTRA CLAUSE
// (o3d-batch-ret r19, Codex HIGH).
//
// r18's ESCALATE member carried `after: 'LEAVE_THE_TOGGLE_OFF' | 'FIX_THE_FAILURE'`, and the
// renderer put that clause in front of the escalation. So ONE typed direction emitted TWO
// imperatives — and only one of them was covered by its declared {action, target}:
//
//   • `LEAVE_THE_TOGGLE_OFF` acts on SETTING_SYNC_ENABLED while the direction declares
//     THIS_RECORD_AND_ITS_SYNC_ROW. The target did not choose that sentence; a neighbouring
//     enum value did, which is the r17 `span` defect wearing an enum instead of a string.
//   • `FIX_THE_FAILURE` was worse: FIX is not an action this model has at all, and "the failure
//     named above" is not one of the five targets. It named an act on an object the closed union
//     was written to make unnameable.
//
// AND THE TYPE-CHECKER PROBE COULD NOT SEE EITHER, because it verifies discriminants and not
// whether the rendered prose is exhausted by them. One entry in a capped inventory was carrying two
// instructions, so the cap was counting something other than what it claims to count.
//
// So: `after` is gone. The leave-it-off half is a LEAVE_OFF direction on its own declared target,
// in a second FORM, and the compound remediation is the SEQUENCE below. FIX is simply removed —
// the message it sat in already says the failure is the WRITE and that closing the row safely needs
// someone who can read the database directly (o3d-4b5p, o3d-3lhp), so "fix the failure named above"
// was an instruction nobody reading that record could perform.
//
// EVERY ELEMENT OF EVERY SEQUENCE IS A MEMBER OF `LOCAL_DIRECTIONS`, so a sequence cannot introduce
// an instruction the cap has not counted. That is asserted, not merely intended.
// ---------------------------------------------------------------------------

/** One remediation that is genuinely two acts, in the order they must be performed. */
export type LocalDirectionSequence = readonly [LocalDirection, LocalDirection, ...LocalDirection[]]

/**
 * Compose a sequence into the shipped sentence.
 *
 * The join is the ONLY conjunction this module produces. A renderer branch that wanted to say "do A
 * and then B" has to become two directions and come through here, which is what makes "one action
 * on one declared target" a property of every branch rather than a habit of the person writing one.
 */
export function renderLocalDirectionSequence(
  sequence: LocalDirectionSequence,
  context: LocalDirectionContext,
): string {
  return sequence.map((direction) => renderLocalDirection(direction, context)).join(' and ')
}

/**
 * THE COMPOUND REMEDIATIONS THE RECORDS SHIP. Declared here for the same reason the directions are:
 * so the inventory is a list somebody has to change in front of a reviewer, not an argument shape.
 */
export const LEAVE_THE_TOGGLE_OFF_THEN_ESCALATE: LocalDirectionSequence = [
  { action: 'LEAVE_OFF', target: 'SETTING_SYNC_ENABLED', form: 'BEFORE_ESCALATION' },
  { action: 'ESCALATE', target: 'THIS_RECORD_AND_ITS_SYNC_ROW', naming: 'SYNC_ROW' },
]

/** Every declared sequence, so the test can hold all of them to the inventory. */
export const LOCAL_DIRECTION_SEQUENCES: readonly LocalDirectionSequence[] = [
  LEAVE_THE_TOGGLE_OFF_THEN_ESCALATE,
]
