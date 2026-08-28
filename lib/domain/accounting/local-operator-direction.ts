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
 *
 * ROUND 21 (Codex HIGH x2) CLOSED THE LAST OPEN PARAMETERS, so that the set of strings this renderer
 * can emit is FINITE AND COMPUTABLE and equals the reviewed inventory in the test file, sentence for
 * sentence. Three members carried fields whose product was wider than what anybody had read:
 *
 *   • `INSPECT` had `selector` x `read` — two independent fields, six sentences, two reviewed.
 *   • `READ_SETTING` had `lead` x `purpose` — four sentences, two reviewed. A type-valid
 *     `{ lead: 'THEN_GO_AND', purpose: 'LEARN_WHAT_A_REPLAY_WOULD_DO' }` shipped prose nobody saw.
 *   • `READ` and `INSPECT` both took `readonly OutboxReadAxis[]`, which is unbounded and INCLUDES
 *     THE EMPTY ARRAY. That is the branch Codex's counterexample used: nothing renders it, so the
 *     runtime equality check never reaches it, and `andList([])` made the sentence end mid-word.
 *
 * Each is one enumerated field now, and the column lists are named members of `OUTBOX_READ_LIST`.
 * The test that reads this module computes the VALUE of every string expression these two functions
 * can return and requires that set to be exactly the reviewed one — which is only a statement worth
 * making because there is no longer a parameter whose values nobody has enumerated.
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
 * RUNTIME IMMUTABILITY FOR EVERY TABLE THIS MODULE RENDERS OFF (o3d-batch-ret r31, Codex HIGH).
 *
 * `const` binds a NAME; it says nothing about the OBJECT the name holds. Every table below was an
 * exported object literal read by `renderLocalDirection` AT INVOCATION TIME, so
 * `SETTING_NAME.SETTING_SYNC_ENABLED = 'anything at all'` in any importer — an ordinary assignment
 * its `Record<..., string>` type admits, with no assertion and no diagnostic — changed what the
 * shipped TURN_OFF sentence says, AFTER the analysis that read the initializer and approved the
 * inventory. The analyzer folds the literal in THIS file and can see no write in any other, so the
 * whole "the renderer's output set is exactly the reviewed one" guarantee rested on nobody writing
 * to a table. `OUTBOX_READ_LIST` had the same runtime mutability behind its `as const` view, and so
 * did `LOCAL_DIRECTIONS` and the sequences behind `readonly`: a `readonly` TYPE is erased.
 *
 * BOTH HALVES ARE CLOSED. `SETTING_NAME` and `OUTBOX_READ_LIST` are no longer exported, so no
 * importer can name them at all; and every table — the two private ones and the four that must stay
 * exported because the reviewed inventory is judged against them — is DEEP-FROZEN at module
 * evaluation, before any renderer can run. A module is always strict-mode code, so a write to a
 * frozen table THROWS rather than being silently dropped. Not exporting alone would not have been
 * enough: a private mutable table is still mutable from inside this module.
 */
function freezeDeep<T>(table: T, seen: WeakSet<object> = new WeakSet()): T {
  if (table === null || typeof table !== 'object') return table
  if (seen.has(table)) return table
  seen.add(table)
  Object.freeze(table)
  for (const inner of Object.values(table as Record<string, unknown>)) freezeDeep(inner, seen)
  return table
}

/**
 * What each target IS, and the words a message must already be using for a direction at it to be
 * about it. The `anchor` is the second half of the coupling: generation makes the sentence a
 * function of the target, and the anchor check makes the MESSAGE the sentence ships in name that
 * same target — so a direction cannot be a fragment floating in a message about something else.
 */
export const LOCAL_TARGET: Readonly<Record<LocalTarget, Readonly<{
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
}>>> = {
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

/**
 * THE COLUMN LISTS THEMSELVES, ENUMERATED (o3d-batch-ret r21, Codex HIGH).
 *
 * `read: readonly OutboxReadAxis[]` was a FREE PARAMETER: six axes in any order and any length, so
 * the sentence "Read them by ..." had an unbounded set of values and only three of them were ever
 * written down and read. The empty array was in that set too, and it is the branch Codex's
 * split-literal counterexample rode in on — `andList([])` returns '', so the shipped renderer could
 * emit "Read them by " for a type-valid direction nobody enumerated.
 *
 * A LIST IS A NAME NOW. Three of them, each a non-empty tuple of axes the type still fences, so the
 * prose a direction can produce is finite and every value of it is in the reviewed inventory.
 */
const OUTBOX_READ_LIST = {
  /** This order's own rows, read for where each one got to. */
  THIS_ORDERS_ROWS: ['status', 'attempts', 'lastError', 'sentAt'],
  /** The same, plus when the row was made — the query that cannot be narrowed to one attempt. */
  BY_KIND_AND_REFERENCE: ['status', 'attempts', 'lastError', 'createdAt', 'sentAt'],
  /** What a row can be read for once narrowing it is known to be impossible. */
  WHEN_NARROWING_IS_IMPOSSIBLE: ['status', 'lastError', 'time'],
} as const satisfies Record<string, readonly [OutboxReadAxis, ...OutboxReadAxis[]]>

/**
 * The two settings IMS itself holds. There is no third, and no way to name anything else.
 *
 * NOT EXPORTED, and frozen at the foot of this file (o3d-batch-ret r31, Codex HIGH): the renderer reads
 * this table at invocation time, so while it was exported and writable an importer could rewrite the
 * setting name a shipped sentence prints without touching a line the analyzer reads.
 */
const SETTING_NAME: Readonly<Record<'SETTING_SYNC_ENABLED' | 'SETTING_ATTACH_PDF', string>> = {
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
  /**
   * o3d-batch-ret r21 (Codex HIGH): ONE FIELD, NOT TWO. `selector` and `read` were independent, so
   * the type admitted six INSPECT sentences and two of them were reviewed. The pair that ships is
   * one choice, and the column list each half reads is chosen by that same choice.
   */
  | { action: 'INSPECT'; target: 'EMAIL_OUTBOX_ROWS'; form: 'THIS_ORDERS_ROWS' | 'BY_KIND_AND_REFERENCE' }
  | { action: 'READ'; target: 'EMAIL_OUTBOX_ROWS' }
  | { action: 'RE_READ'; target: 'EMAIL_OUTBOX_ROWS' }
  | { action: 'TURN_OFF'; target: 'SETTING_SYNC_ENABLED'; control: 'LEVER_BELOW' | 'CONNECTOR_PANEL_CHECKBOX' }
  /**
   * o3d-batch-ret r19 (Codex HIGH): the two LEAVE-IT-OFF sentences are two FORMS of one action on
   * one target, not one of them plus a clause hidden inside an escalation. `BEFORE_ESCALATION` is
   * the half that used to live in the ESCALATE branch's `after` field.
   */
  | { action: 'LEAVE_OFF'; target: 'SETTING_SYNC_ENABLED'; form: 'NOT_A_FENCE' | 'BEFORE_ESCALATION' }
  /**
   * o3d-batch-ret r21 (Codex HIGH): THE SAME COLLAPSE. `lead` x `purpose` was a cartesian product of
   * four sentences, of which TWO shipped and two had never been read by anybody — a type-valid
   * `{ lead: 'THEN_GO_AND', purpose: 'LEARN_WHAT_A_REPLAY_WOULD_DO' }` emitted prose no reviewer had
   * seen. One field, two forms, two sentences.
   */
  | { action: 'READ_SETTING'; target: 'SETTING_ATTACH_PDF'; form: 'THEN_GO_AND_READ_IT' | 'TO_LEARN_WHAT_A_REPLAY_WOULD_DO' }
  | { action: 'ESCALATE'; target: 'THIS_RECORD_AND_ITS_SYNC_ROW'; naming: 'SYNC_ROW' }
  | {
      action: 'ESCALATE'
      target: 'THIS_RECORD_AND_ITS_SYNC_ROW'
      naming: 'RECORD_ONLY'
      caseForm: 'SENTENCE' | 'CLAUSE'
    }

/**
 * "a, b and c" — the shipped wording for a list of read axes.
 *
 * o3d-batch-ret r21 (Codex HIGH): the parameter is a NON-EMPTY tuple of axes, so `items[0]` needs no
 * `?? ''` fallback and there is no argument that makes this return the empty string. Every call site
 * passes a member of `OUTBOX_READ_LIST`, whose lengths are known, so the value of this function at
 * each call site is a constant a reader can compute.
 */
function andList(items: readonly [OutboxReadAxis, ...OutboxReadAxis[]]): string {
  return items.length < 2
    ? items[0]
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
    case 'INSPECT':
      return direction.form === 'THIS_ORDERS_ROWS'
        ? `Inspect the outbox rows for this order and read each row's ${andList(OUTBOX_READ_LIST.THIS_ORDERS_ROWS)}.`
        : 'Then INSPECT the outbox: query it for kind ACCOUNTING_INVOICE, referenceType SalesOrder, '
          + 'referenceId = the order id (no page in IMS lists them) and read each row\'s '
          + `${andList(OUTBOX_READ_LIST.BY_KIND_AND_REFERENCE)}.`
    case 'READ':
      return `Read them by ${andList(OUTBOX_READ_LIST.WHEN_NARROWING_IS_IMPOSSIBLE)}`
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
    case 'READ_SETTING':
      return direction.form === 'THEN_GO_AND_READ_IT'
        ? `THEN GO AND READ ${SETTING_NAME[direction.target]} AS IT STANDS NOW`
        : `READ ${SETTING_NAME[direction.target]} AS IT STANDS NOW to learn what a replay would do`
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
  { action: 'INSPECT', target: 'EMAIL_OUTBOX_ROWS', form: 'THIS_ORDERS_ROWS' },
  { action: 'INSPECT', target: 'EMAIL_OUTBOX_ROWS', form: 'BY_KIND_AND_REFERENCE' },
  { action: 'RE_READ', target: 'EMAIL_OUTBOX_ROWS' },
  { action: 'READ', target: 'EMAIL_OUTBOX_ROWS' },
  // The two plugin settings. Reading one is read-only; turning one off writes an IMS row and
  // touches nothing in anybody else's system — and the record says in prose, at length, that the
  // switch is an admission check rather than a fence.
  { action: 'TURN_OFF', target: 'SETTING_SYNC_ENABLED', control: 'LEVER_BELOW' },
  { action: 'READ_SETTING', target: 'SETTING_ATTACH_PDF', form: 'THEN_GO_AND_READ_IT' },
  { action: 'READ_SETTING', target: 'SETTING_ATTACH_PDF', form: 'TO_LEARN_WHAT_A_REPLAY_WOULD_DO' },
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

// ---------------------------------------------------------------------------
// AND EVERY ONE OF THEM IS FROZEN BEFORE ANYTHING CAN RENDER (o3d-batch-ret r31, Codex HIGH).
//
// These six statements run at module evaluation, which is before the first `renderLocalDirection`
// call by construction: a module body runs to completion before any of its exports can be read.
// From here on a write to any of these tables — from an importer, from this module, at any depth —
// throws a TypeError instead of changing what an operator is told to do.
//
// WHAT THE GUARANTEE NOW RESTS ON, stated plainly rather than implied. The analyzer's conclusion —
// "the set of sentences these renderers can emit is exactly the reviewed inventory" — is
// UNCONDITIONAL on data: there is no longer any object a renderer reads at invocation time that
// anything can write after the analysis. It still rests on two things that are not data, and both
// are diffs to THIS FILE in front of a reviewer: the renderer's own branch strings, and these
// freeze calls themselves. It also assumes `Object.freeze` is the standard one — a program that
// replaced the global intrinsic before this module loaded would defeat it, as it would defeat every
// other use of it in the process.
// ---------------------------------------------------------------------------

freezeDeep(LOCAL_TARGET)
freezeDeep(OUTBOX_READ_LIST)
freezeDeep(SETTING_NAME)
freezeDeep(LOCAL_DIRECTIONS)
freezeDeep(LEAVE_THE_TOGGLE_OFF_THEN_ESCALATE)
freezeDeep(LOCAL_DIRECTION_SEQUENCES)
