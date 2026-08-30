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
 *     runtime equality check never reaches it, and r21's `andList([])` ended the sentence mid-word.
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
function freezeDeep<T>(table: T): T {
  if (table === null || typeof table !== 'object') return table
  // ALREADY-FROZEN IS THE REVISIT GUARD, and it replaced a `WeakSet` (r32). The set was two more
  // prototype methods — `WeakSet.prototype.add` and `.has` — dispatched to do a job `Object.isFrozen`
  // does with one intrinsic: nothing here starts frozen, this line runs after the freeze below, so a
  // second arrival at the same object returns instead of recursing. `for...of` went with it: it
  // dispatches `Array.prototype[Symbol.iterator]` and the iterator's `next`, and an indexed loop
  // over a local array reads only own properties.
  if (Object.isFrozen(table)) return table
  Object.freeze(table)
  const inner = Object.values(table as Record<string, unknown>)
  for (let index = 0; index < inner.length; index += 1) freezeDeep(inner[index])
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
 * split-literal counterexample rode in on — r21's `andList([])` returned '', so the shipped renderer
 * could emit "Read them by " for a type-valid direction nobody enumerated.
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
 * "a, b and c" FOR EACH OF THOSE LISTS, BUILT WITHOUT DISPATCHING A PROTOTYPE METHOD (o3d-batch-ret
 * r32, Codex HIGH).
 *
 * r21's `andList` did this at INVOCATION TIME, and it did it through `Array.prototype`:
 * `items.slice(0, -1).join(', ')` resolves `slice` and `join` off a prototype every program in the
 * process can write to. `Array.prototype.join = () => 'open the remote bill and delete it'` in any
 * importer — an ordinary assignment, no diagnostic, no diff to this file — rewrote the shipped READ
 * sentence AFTER every freeze at the foot of this file had run. Freezing the TABLES closed the data;
 * it could not close the prototypes, because the renderer never held the methods, it looked them up
 * each time it ran.
 *
 * SO THERE IS NO LOOKUP TO DIVERT. Each phrase is one concatenation of indexed reads off the frozen
 * tuple above it, evaluated ONCE at module evaluation, and the renderer's branches interpolate the
 * finished string. The axes are still the single source of the words — no column name is written out
 * here — and the arity is fenced by the tuple type: `[3]` on a three-element tuple does not compile,
 * and a list that GREW would leave an axis out of its phrase, which the test that rebuilds these
 * phrases from the axes refuses.
 *
 * A template's substitution and `+` are what remain, and neither is a lookup: both operands of every
 * one of them is a string PRIMITIVE, and ToString/ToPrimitive of a primitive returns it without
 * reading a property from anything. See the note at the foot of this file.
 */
const OUTBOX_READ_PHRASE = {
  THIS_ORDERS_ROWS: `${OUTBOX_READ_LIST.THIS_ORDERS_ROWS[0]}, ${OUTBOX_READ_LIST.THIS_ORDERS_ROWS[1]}, `
    + `${OUTBOX_READ_LIST.THIS_ORDERS_ROWS[2]} and ${OUTBOX_READ_LIST.THIS_ORDERS_ROWS[3]}`,
  BY_KIND_AND_REFERENCE: `${OUTBOX_READ_LIST.BY_KIND_AND_REFERENCE[0]}, `
    + `${OUTBOX_READ_LIST.BY_KIND_AND_REFERENCE[1]}, ${OUTBOX_READ_LIST.BY_KIND_AND_REFERENCE[2]}, `
    + `${OUTBOX_READ_LIST.BY_KIND_AND_REFERENCE[3]} and ${OUTBOX_READ_LIST.BY_KIND_AND_REFERENCE[4]}`,
  WHEN_NARROWING_IS_IMPOSSIBLE: `${OUTBOX_READ_LIST.WHEN_NARROWING_IS_IMPOSSIBLE[0]}, `
    + `${OUTBOX_READ_LIST.WHEN_NARROWING_IS_IMPOSSIBLE[1]} and ${OUTBOX_READ_LIST.WHEN_NARROWING_IS_IMPOSSIBLE[2]}`,
}

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
        ? `Inspect the outbox rows for this order and read each row's ${OUTBOX_READ_PHRASE.THIS_ORDERS_ROWS}.`
        : 'Then INSPECT the outbox: query it for kind ACCOUNTING_INVOICE, referenceType SalesOrder, '
          + 'referenceId = the order id (no page in IMS lists them) and read each row\'s '
          + `${OUTBOX_READ_PHRASE.BY_KIND_AND_REFERENCE}.`
    case 'READ':
      return `Read them by ${OUTBOX_READ_PHRASE.WHEN_NARROWING_IS_IMPOSSIBLE}`
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

/**
 * One remediation that is genuinely two acts, in the order they must be performed.
 *
 * EXACTLY TWO (o3d-batch-ret r32). The rest element `...LocalDirection[]` was r21's defect one type
 * over: a parameter whose values nobody had enumerated. Its length was unbounded, so the set of
 * sentences the sequence renderer could emit was INFINITE, and the only thing any reviewer had ever
 * read was a pair. Fixing the arity is what lets the renderer below be a concatenation rather than a
 * `map`/`join` over a length it cannot know — and it turns the sequence renderer's computed output
 * from "a repeat, of at least two, of these fourteen" into a finite set of constants held to the
 * reviewed inventory the same way a direction's is. A third act is a third element and a diff here.
 */
export type LocalDirectionSequence = readonly [LocalDirection, LocalDirection]

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
  return renderLocalDirection(sequence[0], context) + ' and ' + renderLocalDirection(sequence[1], context)
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
// These seven statements run at module evaluation, which is before the first `renderLocalDirection`
// call by construction: a module body runs to completion before any of its exports can be read.
// From here on a write to any of these tables — from an importer, from this module, at any depth —
// throws a TypeError instead of changing what an operator is told to do.
//
// ---------------------------------------------------------------------------
// WHAT THE GUARANTEE RESTS ON, DERIVED FROM THE CODE RATHER THAN RECALLED (o3d-batch-ret r32,
// Codex HIGH).
//
// R31 STATED THIS LIST AND THE LIST WAS INCOMPLETE. It said the conclusion — "the set of sentences
// these renderers can emit is exactly the reviewed inventory" — rested on the renderer's branch
// strings, these freeze calls, and `Object.freeze` being the standard intrinsic. It rested on
// `Array.prototype` too, and nothing in that list said so: `andList` resolved `slice` and `join`
// through the prototype every time it ran, and the sequence renderer resolved `map` and `join` the
// same way, so an ordinary `Array.prototype.join = …` in any importer rewrote a shipped sentence
// after all six freezes had completed. Six frozen tables and a mutable prototype is not a closure.
//
// THE OMISSION WAS FINDABLE BECAUSE THE CONDITIONS WERE WRITTEN DOWN, so they are written down
// again — but DERIVED this time, by reading every construct the two renderers execute and asking of
// each one whether it resolves a name through anything a program can write. The derivation is the
// point: a reader can redo it against the code below rather than trust the list.
//
// WHAT THE RENDERERS EXECUTE AT INVOCATION TIME, exhaustively, and why none of it is a lookup
// anything can divert:
//
//   1. `direction.action`, `.form`, `.control`, `.naming`, `.caseForm`, `.target`, and
//      `context.ledger` / `.syncRowId` — property reads on the two ARGUMENTS. Every one of them is
//      an OWN property of any value of the declared type, so no prototype is consulted. This is a
//      condition on the CALLER, and it is the one condition here that is not a diff to this file:
//      an object that omitted a property would read `Object.prototype` instead. What that buys is
//      bounded and worth stating — every one of those reads except `context.*` and `direction.target`
//      is only ever COMPARED against a string literal, so a prototype-supplied value can at worst
//      select the other arm of the same enumerated pair, and both arms are reviewed sentences.
//   2. `SETTING_NAME[direction.target]` and `OUTBOX_READ_PHRASE.THIS_ORDERS_ROWS` (and its two
//      siblings) — property reads on the module's own tables, which are frozen below. The keys are
//      fenced by the discriminated union, so each read finds an own property.
//   3. `sequence[0]` and `sequence[1]` — indexed reads on a tuple whose type fixes its length at
//      two, so both indices are own properties and neither can fall through to `Array.prototype`.
//      This is why the rest element had to go: an index BEYOND the length is a prototype read.
//   4. `===` (and the `switch`, which is `===`) — between two string primitives. Strict equality
//      on primitives reads no property from anything.
//   5. Template substitution `${…}` — ToString. Every substituted expression is typed `string`
//      (`OutboxReadAxis`, `LocalDirectionContext`'s two fields, or one of the phrase constants), and
//      ToString of a string PRIMITIVE returns it; the `Symbol.toPrimitive` / `toString` lookup
//      happens only for an OBJECT operand, and there is none here.
//   6. `+` between strings — the same answer through ToPrimitive, and for the same reason: it
//      dispatches only on an object operand. Both operands of every `+` below are primitives.
//   7. `renderLocalDirection(...)` from the sequence renderer — a call through a module-scope
//      binding, which is a scope lookup and not a property read, so there is no receiver to poison.
//   8. `administrator` — a local `const` holding a string literal. A scope lookup, as above.
//
//   THERE IS NO PROTOTYPE METHOD LEFT IN EITHER RENDERER. That is checkable rather than asserted:
//   neither function body contains a call whose callee is a property access, so there is nothing to
//   enumerate and capture.
//
// AND WHAT THIS MODULE EXECUTES AT EVALUATION TIME, which is before any renderer can run and so is
// only reachable by a program that loaded FIRST:
//
//   9. `Object.freeze`, `Object.isFrozen` and `Object.values` in `freezeDeep`, plus the indexed
//      walk over the array `Object.values` returns. Replacing one of those three intrinsics before
//      this module loads defeats the freeze — as it would defeat every other use of `Object.freeze`
//      in the process. `freezeDeep` uses no `for...of` and no `WeakSet` precisely so this list is
//      three names long: an iterator protocol and `WeakSet.prototype.add`/`.has` would each be
//      another entry.
//  10. The `OUTBOX_READ_PHRASE` construction — templates and `+` over indexed reads of a frozen
//      tuple, so items 3, 5 and 6 above, one evaluation earlier. A prototype written to after this
//      module loads cannot reach it: the phrases are already strings by then.
//
// AND WHAT REMAINS UNCONDITIONAL is what it was: the renderer's own branch strings and these freeze
// calls, both of which are diffs to THIS FILE in front of a reviewer.
// ---------------------------------------------------------------------------

freezeDeep(LOCAL_TARGET)
freezeDeep(OUTBOX_READ_LIST)
freezeDeep(OUTBOX_READ_PHRASE)
freezeDeep(SETTING_NAME)
freezeDeep(LOCAL_DIRECTIONS)
freezeDeep(LEAVE_THE_TOGGLE_OFF_THEN_ESCALATE)
freezeDeep(LOCAL_DIRECTION_SEQUENCES)
