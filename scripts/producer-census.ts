/**
 * THE PRODUCER CENSUS: EVERY CALL THAT CREATES OUTBOUND WORK, OR WRITES TO A VENDOR DIRECTLY, IS DECLARED.
 *
 * The producer-side hold (lib/security/producer-disposition.ts) can only decide for a producer that it
 * knows about, and the ownership map (lib/security/writer-ownership-map.ts) only names operations. This
 * census is the link between them: it finds, by TypeScript syntax tree over app/, lib/, scripts/ and
 * components/, every call of a WRITE PRIMITIVE (the functions in {@link PRIMITIVES}), and
 * scripts/producer-census-declarations.ts must say for each one which (destination, operation) of the
 * ownership map it produces, by what mechanism, and whether its work has a business-event time.
 *
 * Reconciliation is UNIVERSAL IN EVERY DIRECTION (see {@link reconcile}):
 *   - a site found and not declared                      -> red, and the message names the file to edit;
 *   - a declaration no site matches                      -> red (an allowlist cannot outlive its code);
 *   - a declared (destination, operation) that is neither in the ownership map nor in
 *     EXCLUDED_OPERATIONS with a reason                  -> red;
 *   - a declared obligationTime that disagrees with the map's -> red;
 *   - an ownership-map operation with no declared producer and no NO_PRODUCER note -> red;
 *   - a NO_PRODUCER note for an operation that now has a producer, or that is not in the map -> red.
 *
 * ── WHAT THE SCAN DOES CATCH (syntactic, per file) ──────────────────────────────────────────────
 *   - a call of a primitive by name: `wcPost(…)`, `api.wcPost(…)` (a namespace or object receiver);
 *   - a call through an ALIAS: `import { createAccountingSyncLogRow as c }`, a destructured
 *     `const { wcPost: p } = await import(…)`, and `const f = wcPost` followed by `f(…)`;
 *   - a literal element-access call: `facade['wcPost'](…)`;
 *   - `.call` / `.apply` on a primitive: `wcPost.call(null, …)`;
 *   - a RE-EXPORT of a primitive: `export { wcPost } from './api'`, `export { wcPost as w }`;
 *   - a bare REFERENCE to a primitive that is not a call (`.then(wcPost)`, `const f = wcPost`,
 *     `{ wcPost }`), because passing the function on is how a call hides;
 *   - a local WRAPPER's inner call, because the wrapper is a function that calls the primitive and that
 *     call is a site in the wrapper's file.
 *
 * ── WHAT IT DOES NOT CATCH (the residual blind spots, and every one is real) ────────────────────
 *   - a call of a LOCAL WRAPPER: the wrapper's inner call is declared, but a caller of the wrapper is not
 *     itself a site, so a NEW caller of a declared wrapper passes unseen. Wrapper callers are only
 *     covered where the wrapper is itself a primitive (the facade functions, the queue entry points);
 *   - a DYNAMIC property call, `facade[name](…)` with a non-literal key, and a computed destructure
 *     `const { [key]: f } = facade`;
 *   - a primitive reached through `export * from '…'`, a re-export under a NAME this table does not know,
 *     or a function obtained from a registry/map/array by key (`handlers[type](…)`);
 *   - a method-style primitive (`pushOrder`, `updateOrder`, …) is matched by member name ALONE, with no
 *     receiver type: a different object with a method of that name is a false positive (declared, with
 *     the true reason), and a connector reached under another method name is a false negative;
 *   - raw `fetch` / `connectorFetch` calls other than the named primitives (tests/security/
 *     outbound-write-hold-raw-fetch.test.ts and check:connector-fetch-boundaries own the transport level);
 *   - generated code, code under archive/, and files outside app/, lib/, scripts/, components/;
 *   - SQL or shell that writes a vendor or queue table without a TypeScript call.
 * These need a symbol-level (type-checker) analysis; see the follow-up bead named in docs. The census
 * says "declared and complete over the syntax it can read", never "every producer is found".
 */

import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import ts from 'typescript'

import {
  WRITER_OWNERSHIP_MAP,
  type OwnershipRow,
} from '../lib/security/writer-ownership-map'

export const SOURCE_ROOTS = ['app', 'lib', 'scripts', 'components'] as const
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.next', 'generated', 'archive'])

/** A scan that reaches fewer files than this has not reached its subject (printed on every run). */
export const MIN_SOURCE_FILES = 800

/** Where a primitive's callers land; used to group the printed counts and to fail a family that found nothing. */
export type PrimitiveFamily =
  | 'xero-queue'
  | 'xero-transport'
  | 'outbox'
  | 'woocommerce-facade'
  | 'woocommerce-writer'
  | 'mintsoft-write'
  | 'operator-action'
  | 'customer-email'

export type Primitive = {
  family: PrimitiveFamily
  /** Matched only as a member call (`x.name(…)`): a bare function of this name is some other function. */
  memberOnly?: boolean
  /** Named in the brief but absent on this trunk: expected to find nothing, and said so. */
  absentOnTrunk?: boolean
}

export const PRIMITIVES: Readonly<Record<string, Primitive>> = {
  // ---- Xero: queue entry points. All four create sites funnel through the one primitive. ----------------
  createAccountingSyncLogRow: { family: 'xero-queue' },
  queueAccountingSync: { family: 'xero-queue' },
  queueAccountingSyncTx: { family: 'xero-queue' },
  queueAccountingSyncTxWithOutcome: { family: 'xero-queue' },
  queueAccountingSyncSafely: { family: 'xero-queue', absentOnTrunk: true },
  queueXeroSync: { family: 'xero-queue' },
  scheduleXeroAccountingOutbox: { family: 'xero-queue' },
  // ---- Xero: transport posts (the drain, and the direct writers) ------------------------------------------
  xeroPost: { family: 'xero-transport' },
  xeroPut: { family: 'xero-transport' },
  xeroUploadAttachment: { family: 'xero-transport' },
  putXeroTaxRate: { family: 'xero-transport' },
  generateMissingXeroTaxRates: { family: 'xero-transport' },
  // ---- The integration outbox, and the WooCommerce jobs built on it ------------------------------------------
  enqueueIntegrationOutbox: { family: 'outbox' },
  enqueueWcStockSyncJobs: { family: 'outbox' },
  enqueueAndProcessImmediateWcStockSync: { family: 'outbox' },
  scheduleWcOrderCompletion: { family: 'outbox' },
  scheduleWcOrderCancel: { family: 'outbox' },
  scheduleWcOrderHold: { family: 'outbox' },
  // ---- The lib/shopping.ts facade --------------------------------------------------------------------------------
  enqueueStockSync: { family: 'woocommerce-facade' },
  syncShoppingConnectorStock: { family: 'woocommerce-facade' },
  pushProductMetadata: { family: 'woocommerce-facade' },
  pushOrderDeliveryMetadata: { family: 'woocommerce-facade' },
  pushPartialShipmentToShopping: { family: 'woocommerce-facade' },
  pushWmsOrderStatusToShopping: { family: 'woocommerce-facade' },
  pushSalesOrderStatus: { family: 'woocommerce-facade' },
  scheduleShoppingOrderCompletion: { family: 'woocommerce-facade' },
  scheduleShoppingOrderStatusPush: { family: 'woocommerce-facade' },
  pushFxRatesToConnectors: { family: 'woocommerce-facade' },
  // ---- WooCommerce direct writers ----------------------------------------------------------------------------------
  wcPost: { family: 'woocommerce-writer' },
  wcPut: { family: 'woocommerce-writer' },
  pushStockToWc: { family: 'woocommerce-writer' },
  pushImsProductToWc: { family: 'woocommerce-writer' },
  pushImsStatusToWc: { family: 'woocommerce-writer' },
  pushImsTrackingToWc: { family: 'woocommerce-writer' },
  pushWmsOrderStatusToWc: { family: 'woocommerce-writer' },
  pushPartialShipmentToWc: { family: 'woocommerce-writer' },
  pushInvoiceNoteToWc: { family: 'woocommerce-writer' },
  pushFxRatesToWc: { family: 'woocommerce-writer' },
  pushCurrentFxRatesToWc: { family: 'woocommerce-writer' },
  probeFxHelperPlugin: { family: 'woocommerce-writer' },
  startManualWcStockSync: { family: 'woocommerce-writer' },
  runWcReconcile: { family: 'woocommerce-writer' },
  // ---- Mintsoft: the client write functions, key minting, and the WMS connector's write methods -------------
  pushMintsoftOrder: { family: 'mintsoft-write' },
  updateMintsoftOrder: { family: 'mintsoft-write' },
  cancelMintsoftOrder: { family: 'mintsoft-write' },
  addMintsoftOrderComment: { family: 'mintsoft-write' },
  upsertMintsoftProduct: { family: 'mintsoft-write' },
  updateMintsoftProductContent: { family: 'mintsoft-write' },
  createMintsoftAsn: { family: 'mintsoft-write' },
  createMintsoftBundle: { family: 'mintsoft-write' },
  requestMintsoftAuthSession: { family: 'mintsoft-write' },
  runWmsOrderPushSweep: { family: 'mintsoft-write' },
  scheduleWmsProductSync: { family: 'mintsoft-write' },
  runMintsoftProductVerify: { family: 'mintsoft-write' },
  runMintsoftBundleVerify: { family: 'mintsoft-write' },
  pushOrder: { family: 'mintsoft-write', memberOnly: true },
  updateOrder: { family: 'mintsoft-write', memberOnly: true },
  cancelOrder: { family: 'mintsoft-write', memberOnly: true },
  addOrderComment: { family: 'mintsoft-write', memberOnly: true },
  upsertProduct: { family: 'mintsoft-write', memberOnly: true },
  updateProductContent: { family: 'mintsoft-write', memberOnly: true },
  createAsn: { family: 'mintsoft-write', memberOnly: true },
  createBundle: { family: 'mintsoft-write', memberOnly: true },
  // ---- Operator buttons that re-arm or trigger a write ------------------------------------------------------------
  replayWmsOrderPush: { family: 'operator-action' },
  repushMissingWmsOrder: { family: 'operator-action' },
  retryFailedXeroSync: { family: 'operator-action' },
  retryFailedAccountingSync: { family: 'operator-action' },
  runMintsoftProductVerifyNow: { family: 'operator-action' },
  createWcWebhooks: { family: 'operator-action' },
  // ---- Customer e-mail (mapped only) -------------------------------------------------------------------------------------
  queueEmail: { family: 'customer-email' },
  queueDispatchEmailIfEligible: { family: 'customer-email' },
}

/**
 * Raw row creation on a queue table, which bypasses every seam above: `<anything>.accountingSyncLog.create(…)`.
 * Matched by the two-link member chain `<table>.<method>`, so `tx.accountingSyncLog.create` and
 * `db.accountingSyncLog.createMany` both count and an unrelated `x.create` does not.
 */
export const RAW_QUEUE_TABLES: Readonly<Record<string, string>> = {
  accountingSyncLog: 'accountingSyncLog',
  integrationOutbox: 'integrationOutbox',
}
export const RAW_CREATE_METHODS = ['create', 'createMany', 'createManyAndReturn', 'upsert'] as const

export type SiteKind = 'call' | 'reference' | 'reexport'

export type Site = {
  /** `<file>::<top-level declaration>::<primitive>[kind]#<ordinal>`; `call` carries no bracket. */
  key: string
  file: string
  line: number
  decl: string
  primitive: string
  kind: SiteKind
  /** How the primitive was named at the site when that is not the primitive's own name. */
  via?: string
  /** Character offset of the site in its file; lets the seam checks ask what comes before and after it. */
  pos?: number
}

const WRAP_KINDS = (n: ts.Node): ts.Node => {
  let x = n
  while (
    ts.isParenthesizedExpression(x) || ts.isNonNullExpression(x) || ts.isAsExpression(x)
    || ts.isTypeAssertionExpression(x) || ts.isSatisfiesExpression(x)
  ) x = x.expression
  return x
}

function topLevelDeclName(node: ts.Node, sf: ts.SourceFile): string {
  let n: ts.Node = node
  while (n.parent && n.parent !== sf) n = n.parent
  if (ts.isFunctionDeclaration(n)) return n.name?.text ?? '<anonymous>'
  if (ts.isClassDeclaration(n)) {
    const className = n.name?.text ?? '<class>'
    let m: ts.Node = node
    while (m.parent && m.parent !== n) m = m.parent
    const name = (m as ts.ClassElement).name
    const member = name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : '<member>'
    return `${className}.${member}`
  }
  if (ts.isVariableStatement(n)) {
    let m: ts.Node = node
    while (m.parent && !ts.isVariableDeclaration(m)) m = m.parent
    if (ts.isVariableDeclaration(m)) return m.name.getText(sf)
    return n.declarationList.declarations.map((d) => d.name.getText(sf)).join('+')
  }
  return '<module>'
}

/** Is this identifier a NAME being declared or a type position, rather than a use of the value? */
function isNonValuePosition(id: ts.Identifier): boolean {
  const p = id.parent
  if (!p) return true
  if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isExportSpecifier(p)) return true
  if (ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isClassDeclaration(p) || ts.isClassExpression(p)) return p.name === id
  if (ts.isMethodDeclaration(p) || ts.isMethodSignature(p) || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p)) return p.name === id
  if (ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) return p.name === id
  if (ts.isParameter(p)) return p.name === id
  if (ts.isVariableDeclaration(p)) return p.name === id
  if (ts.isBindingElement(p)) return p.name === id || p.propertyName === id
  if (ts.isPropertyAssignment(p)) return p.name === id
  if (ts.isEnumMember(p) || ts.isTypeAliasDeclaration(p) || ts.isInterfaceDeclaration(p)) return true
  if (ts.isTypeReferenceNode(p) || ts.isQualifiedName(p) || ts.isTypeQueryNode(p) || ts.isExpressionWithTypeArguments(p)) return true
  if (ts.isNamedTupleMember(p) || ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return true
  if (ts.isImportEqualsDeclaration(p) || ts.isNamespaceExport(p)) return true
  return false
}

/** The primitive a callee names, and how. Aliases are resolved by the caller through `aliases`. */
function resolveName(
  name: string,
  member: boolean,
  aliases: ReadonlyMap<string, string>,
): { primitive: string; via?: string } | null {
  const aliased = !member ? aliases.get(name) : undefined
  const canonical = aliased ?? name
  const entry = Object.prototype.hasOwnProperty.call(PRIMITIVES, canonical) ? PRIMITIVES[canonical] : undefined
  if (!entry) return null
  if (entry.memberOnly && !member) return null
  return { primitive: canonical, via: aliased ? name : undefined }
}

/** Every alias a file introduces for a primitive: renamed imports, renamed destructures, `const f = prim`. */
function collectAliases(sf: ts.SourceFile): Map<string, string> {
  const aliases = new Map<string, string>()
  const known = (n: string) => Object.prototype.hasOwnProperty.call(PRIMITIVES, n) && !PRIMITIVES[n].memberOnly
  const visit = (node: ts.Node) => {
    if (ts.isImportSpecifier(node) && node.propertyName && known(node.propertyName.text)) {
      aliases.set(node.name.text, node.propertyName.text)
    } else if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
      const key = node.propertyName
      const keyText = key && (ts.isIdentifier(key) || ts.isStringLiteral(key)) ? key.text : null
      if (keyText && known(keyText) && node.name.text !== keyText) aliases.set(node.name.text, keyText)
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = WRAP_KINDS(node.initializer)
      const target = ts.isIdentifier(init) ? init.text : null
      if (target) {
        const canonical = aliases.get(target) ?? target
        if (known(canonical) && node.name.text !== canonical) aliases.set(node.name.text, canonical)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  // A `const f = g` where g is itself an alias declared later in the file settles in a second pass.
  visit(sf)
  return aliases
}

/** The scan of ONE source text. Pure: fixtures drive every detector through this. */
export function scanSource(text: string, file: string): Site[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const aliases = collectAliases(sf)
  const found: Array<Omit<Site, 'key'>> = []
  const handled = new Set<ts.Node>()

  const add = (node: ts.Node, primitive: string, kind: SiteKind, via?: string) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
    found.push({ file, line: line + 1, decl: topLevelDeclName(node, sf), primitive, kind, via, pos: node.getStart(sf) })
  }

  /** Name of the thing a callee/expression denotes, when it is a plain or literal-keyed reference. */
  const nameOf = (expr: ts.Node): { name: string; member: boolean; nameNode: ts.Node } | null => {
    const e = WRAP_KINDS(expr)
    if (ts.isIdentifier(e)) return { name: e.text, member: false, nameNode: e }
    if (ts.isPropertyAccessExpression(e)) return { name: e.name.text, member: true, nameNode: e.name }
    if (ts.isElementAccessExpression(e)) {
      const arg = WRAP_KINDS(e.argumentExpression)
      if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return { name: arg.text, member: true, nameNode: arg }
    }
    return null
  }

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      let callee: ts.Node = node.expression
      let target = nameOf(callee)
      // `wcPost.call(…)`, `.apply(…)`: the primitive is the receiver.
      if (target && target.member && ['call', 'apply'].includes(target.name)) {
        const recv = WRAP_KINDS(callee) as ts.PropertyAccessExpression
        if (ts.isPropertyAccessExpression(recv)) {
          const inner = nameOf(recv.expression)
          if (inner && resolveName(inner.name, inner.member, aliases)) {
            target = inner
            callee = recv.expression
          }
        }
      }
      const rawCallee = WRAP_KINDS(node.expression)
      if (
        ts.isPropertyAccessExpression(rawCallee)
        && (RAW_CREATE_METHODS as readonly string[]).includes(rawCallee.name.text)
      ) {
        const owner = WRAP_KINDS(rawCallee.expression)
        const table = ts.isPropertyAccessExpression(owner) ? owner.name.text : ts.isIdentifier(owner) ? owner.text : null
        if (table && Object.prototype.hasOwnProperty.call(RAW_QUEUE_TABLES, table)) {
          add(node, `${table}.${rawCallee.name.text}`, 'call')
        }
      }
      if (target) {
        const hit = resolveName(target.name, target.member, aliases)
        if (hit) {
          add(node, hit.primitive, 'call', hit.via)
          handled.add(target.nameNode)
          const c = WRAP_KINDS(callee)
          if (ts.isPropertyAccessExpression(c)) handled.add(c.name)
        }
      }
    } else if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const spec of node.exportClause.elements) {
        const source = (spec.propertyName ?? spec.name).text
        const hit = resolveName(source, false, aliases)
        if (hit) add(spec, hit.primitive, 'reexport', hit.via)
      }
    } else if (ts.isIdentifier(node) && !handled.has(node) && !isNonValuePosition(node)) {
      const p = node.parent
      // A property name on the right of `.` is judged where the property access is.
      if (!(ts.isPropertyAccessExpression(p) && p.name === node)) {
        const hit = resolveName(node.text, false, aliases)
        if (hit) add(node, hit.primitive, 'reference', hit.via)
      }
    } else if (ts.isPropertyAccessExpression(node) && !handled.has(node.name) && !ts.isTypeQueryNode(node.parent)) {
      const hit = resolveName(node.name.text, true, aliases)
      const parent = node.parent
      const isCallee = ts.isCallExpression(parent) && WRAP_KINDS(parent.expression) === node
      if (hit && !isCallee && !(ts.isBinaryExpression(parent) && parent.left === node)) {
        add(node.name, hit.primitive, 'reference', hit.via)
        handled.add(node.name)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)

  found.sort((a, b) => a.line - b.line || a.primitive.localeCompare(b.primitive))
  const seen = new Map<string, number>()
  return found.map((site) => {
    const base = `${site.file}::${site.decl}::${site.primitive}${site.kind === 'call' ? '' : `[${site.kind}]`}`
    const ordinal = (seen.get(base) ?? 0) + 1
    seen.set(base, ordinal)
    return { ...site, key: `${base}#${ordinal}` }
  })
}

function walk(dir: string, out: string[] = []): string[] {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(p, out)
    } else if (['.ts', '.tsx'].includes(extname(entry.name)) && !entry.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

export type TreeScan = { sites: Site[]; filesScanned: number; /** Text of every file that holds a site, for the seam checks. */ sources: Map<string, string> }

/** The scan of the whole tree: every .ts/.tsx under {@link SOURCE_ROOTS}. Never a diff, never a branch. */
export function scanTree(root: string, roots: readonly string[] = SOURCE_ROOTS): TreeScan {
  const files = roots.flatMap((r) => walk(join(root, r)))
  const sites: Site[] = []
  const sources = new Map<string, string>()
  for (const abs of files) {
    const rel = relative(root, abs).split('\\').join('/')
    const text = readFileSync(abs, 'utf8')
    // Cheap pre-filter: a file that never spells a primitive cannot hold a site.
    if (![...Object.keys(PRIMITIVES), ...Object.keys(RAW_QUEUE_TABLES)].some((n) => text.includes(n))) continue
    const found = scanSource(text, rel)
    if (found.length > 0) sources.set(rel, text)
    sites.push(...found)
  }
  return { sites, filesScanned: files.length, sources }
}

// ───────────────────────── declarations and reconciliation ─────────────────────────

export const MECHANISMS = [
  'seam',             // a site that ASKS the producer-side hold before it produces (checked by seamFindings)
  'queue-seam',       // the one primitive that creates the queue row, or the entry point that reaches it
  'queue-producer',   // a business flow that asks for a queued write
  'drain',            // a processor/sweep that performs the write for work already queued
  'direct-write',     // a synchronous or fire-and-forget vendor call with no durable work row
  'facade',           // lib/shopping.ts or another delegating layer that passes the call on
  'operator-action',  // a button or server action a person presses
  'script',           // a manual script
  'reexport',         // a re-export of a primitive
  'reference',        // a primitive passed on as a value
] as const
export type Mechanism = (typeof MECHANISMS)[number]

export type Declaration = {
  key: string
  destination: string
  operation: string
  mechanism: Mechanism
  obligationTime: 'required' | 'not-applicable'
  note: string
}

export type ExclusionMap = Readonly<Record<string, string>>
export type NoProducerMap = Readonly<Record<string, string>>

export type CensusInputs = {
  sites: readonly Site[]
  declarations: readonly Declaration[]
  /** `<destination>.<operation>` -> reason this declared pair is not an ownership-map operation. */
  excludedOperations: ExclusionMap
  /** `<destination>.<operation>` of a map row -> why no producer exists in this repo. */
  noProducer: NoProducerMap
  map?: readonly OwnershipRow[]
  filesScanned: number
  minSourceFiles?: number
  /** Text of the files that hold sites; when given, the seam checks run over it. */
  sources?: ReadonlyMap<string, string>
}

export type CensusReport = {
  failures: string[]
  counts: {
    filesScanned: number
    sitesFound: number
    declared: number
    excluded: number
    byFamily: Record<string, number>
    byPrimitive: Record<string, number>
    byDestination: Record<string, number>
    mapOperations: number
    mapOperationsWithProducer: number
    mapOperationsNoProducer: number
    seam: SeamCounts | null
  }
}

const MIN_REASON = 15
const DECLARATIONS_FILE = 'scripts/producer-census-declarations.ts'
const MAP_FILE = 'lib/security/writer-ownership-map.ts'


// ───────────────────────── the seam checks ─────────────────────────

/**
 * THE PRODUCER SEAM, CHECKED. A declaration with mechanism 'seam' says "this function asks the producer-side hold before
 * it produces"; this makes that checkable instead of a word:
 *
 *   SEAM-1  the top-level declaration holding a 'seam' site CALLS one of {@link SEAM_CONSULTATIONS} at a position BEFORE the site.
 *   SEAM-2  every call of the sync-log row primitive outside its own file HANDLES THE SHADOW ANSWER: the same top-level
 *           declaration reads `.shadowed` of the result after the call and before the next outbox schedule (or, with none,
 *           anywhere after the call). A caller that queues an outbox job for a shadow is the defect this exists for.
 *   SEAM-3  a destination-xero declaration with mechanism 'direct-write' is a finding: a direct Xero write is a seam or it is
 *           declared as the transport behind one ('drain').
 *
 * Syntactic, like the rest of the census: it proves the consultation and the shadow read are THERE and ORDERED, not that
 * they dominate every path. Its blind spots are the census's own (helpers, aliases through objects).
 */
export const SEAM_CONSULTATIONS = ['xeroProducerSeamVerdict', 'xeroTaxRateWriteShadow', 'producerSeamVerdict'] as const
export const SYNC_ROW_PRIMITIVE = 'createAccountingSyncLogRow'
export const SYNC_ROW_PRIMITIVE_FILE = 'lib/domain/accounting/sync-log-row.ts'
export const SHADOW_RESULT_FIELD = 'shadowed'
export const OUTBOX_SCHEDULE = 'scheduleXeroAccountingOutbox'

export type SeamCounts = {
  seamSites: number; seamSitesConsulting: number; rowSites: number; rowSitesHandlingShadow: number
  /** SEAM-4: Xero transport call sites examined, and how many sit behind the claim boundary (or in a transport module / declared exception). */
  egressSites: number; egressSitesBehindBoundary: number
}

/**
 * SEAM-4, THE CLAIM BOUNDARY. Every call of a Xero transport primitive (xeroPost, xeroPut, xeroUploadAttachment,
 * putXeroTaxRate) is in ONE of: a transport module (the functions the processor calls), app/actions/settings.ts (a declared
 * seam, SEAM-1), the demo-provisioning script (declared exception), or sync-processor.ts::processClaimedEntry, which must call
 * the producer decision BEFORE its first transport call and must hand a held row back as 'producer-held'. Any other file is a
 * new egress that bypasses the boundary and is a finding.
 */
export const CLAIM_BOUNDARY_FILE = 'lib/connectors/xero/sync-processor.ts'
export const CLAIM_BOUNDARY_DECL = 'processClaimedEntry'
export const CLAIM_BOUNDARY_HANDBACK = 'producer-held'
const TRANSPORT_MODULE_RE = /^lib\/connectors\/xero\/(bills|contacts|credit-notes|invoices|items|journals|tax-rates)\.ts$/
const EGRESS_DECLARED_EXCEPTIONS = [/^scripts\/provision-xero-demo\.ts$/, /^app\/actions\/settings\.ts$/, /^lib\/connectors\/accounting-registry\.ts$/]

function calleeName(call: ts.CallExpression): string | null {
  const e = WRAP_KINDS(call.expression)
  if (ts.isIdentifier(e)) return e.text
  if (ts.isPropertyAccessExpression(e)) return e.name.text
  return null
}

export function seamFindings(
  sourceByFile: ReadonlyMap<string, string>,
  sites: readonly Site[],
  declarations: readonly Declaration[],
): { failures: string[]; counts: SeamCounts } {
  const failures: string[] = []
  const counts: SeamCounts = { seamSites: 0, seamSitesConsulting: 0, rowSites: 0, rowSitesHandlingShadow: 0, egressSites: 0, egressSitesBehindBoundary: 0 }
  const declByKey = new Map(declarations.map((d) => [d.key, d]))
  const parsed = new Map<string, ts.SourceFile>()
  const parse = (file: string): ts.SourceFile | null => {
    const cached = parsed.get(file)
    if (cached) return cached
    const text = sourceByFile.get(file)
    if (text === undefined) return null
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    parsed.set(file, sf)
    return sf
  }
  const topLevelContaining = (sf: ts.SourceFile, pos: number): ts.Node | null =>
    sf.statements.find((statement) => statement.getStart(sf) <= pos && pos < statement.getEnd()) ?? null

  for (const site of sites) {
    if (site.pos === undefined) continue
    const declared = declByKey.get(site.key)
    const isSeam = declared?.mechanism === 'seam'
    const isRowSite = site.primitive === SYNC_ROW_PRIMITIVE && site.kind === 'call' && site.file !== SYNC_ROW_PRIMITIVE_FILE
    const isEgress = PRIMITIVES[site.primitive]?.family === 'xero-transport' && site.kind === 'call'
    if (isEgress) {
      counts.egressSites++
      if (TRANSPORT_MODULE_RE.test(site.file) || EGRESS_DECLARED_EXCEPTIONS.some((re) => re.test(site.file))) counts.egressSitesBehindBoundary++
      else if (site.file !== CLAIM_BOUNDARY_FILE || site.decl !== CLAIM_BOUNDARY_DECL) {
        failures.push(`SEAM-4 ${site.key} (${site.file}:${site.line}) is a Xero egress outside the claim boundary. Xero transport is called only from the transport modules and ${CLAIM_BOUNDARY_FILE}::${CLAIM_BOUNDARY_DECL}, which asks the producer decision first.`)
      } else {
        const bsf = parse(site.file)
        const container = bsf && site.pos !== undefined ? topLevelContaining(bsf, site.pos) : null
        let consultedAt = Number.POSITIVE_INFINITY
        let handsBack = false
        const walk = (node: ts.Node) => {
          if (bsf && ts.isCallExpression(node)) {
            const name = calleeName(node)
            if (name && (SEAM_CONSULTATIONS as readonly string[]).includes(name)) consultedAt = Math.min(consultedAt, node.getStart(bsf))
          }
          if (ts.isStringLiteral(node) && node.text === CLAIM_BOUNDARY_HANDBACK) handsBack = true
          ts.forEachChild(node, walk)
        }
        if (container) walk(container)
        // The FIRST transport site of the function, not just this one: the check is that nothing precedes the gate.
        const first = sites.filter((other) => other.file === site.file && other.decl === site.decl && PRIMITIVES[other.primitive]?.family === 'xero-transport' && other.pos !== undefined).reduce((min, other) => Math.min(min, other.pos!), Number.POSITIVE_INFINITY)
        if (consultedAt < first && handsBack) counts.egressSitesBehindBoundary++
        else failures.push(`SEAM-4 ${site.key}: ${CLAIM_BOUNDARY_DECL} must call the producer decision before its first Xero transport call and hand a held row back as '${CLAIM_BOUNDARY_HANDBACK}' (consulted at ${consultedAt === Number.POSITIVE_INFINITY ? 'never' : consultedAt}, first transport at ${first}, hands back: ${handsBack}).`)
      }
    }
    if (!isSeam && !isRowSite) continue
    const sf = parse(site.file)
    const container = sf ? topLevelContaining(sf, site.pos) : null
    if (!sf || !container) {
      failures.push(`SEAM ${site.key}: the source of ${site.file} could not be read back, so the seam check cannot run. Fix the census input.`)
      continue
    }
    const calls: Array<{ name: string; pos: number }> = []
    const shadowReads: number[] = []
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const name = calleeName(node)
        if (name) calls.push({ name, pos: node.getStart(sf) })
      }
      if (ts.isPropertyAccessExpression(node) && node.name.text === SHADOW_RESULT_FIELD) shadowReads.push(node.name.getStart(sf))
      ts.forEachChild(node, visit)
    }
    visit(container)

    if (isSeam) {
      counts.seamSites++
      const consulted = calls.some((call) => (SEAM_CONSULTATIONS as readonly string[]).includes(call.name) && call.pos < site.pos!)
      if (consulted) counts.seamSitesConsulting++
      else {
        failures.push(
          `SEAM-1 ${site.key} (${site.file}:${site.line}) is declared a seam but ${site.decl} calls none of ${SEAM_CONSULTATIONS.join(', ')} before it. `
          + 'Ask the producer-side hold before producing, or change the declaration to the mechanism it really is.',
        )
      }
    }
    if (isRowSite) {
      counts.rowSites++
      const nextSchedule = calls
        .filter((call) => call.name === OUTBOX_SCHEDULE && call.pos > site.pos!)
        .reduce((min, call) => Math.min(min, call.pos), Number.POSITIVE_INFINITY)
      const handled = shadowReads.some((read) => read > site.pos! && read < nextSchedule)
      if (handled) counts.rowSitesHandlingShadow++
      else {
        failures.push(
          `SEAM-2 ${site.key} (${site.file}:${site.line}) creates a sync-log row but ${site.decl} never reads \`.${SHADOW_RESULT_FIELD}\` of the result `
          + `between the call and the next ${OUTBOX_SCHEDULE}. A shadow must not be given an outbox job: handle the shadow answer before scheduling.`,
        )
      }
    }
  }
  return { failures, counts }
}

export function reconcile(input: CensusInputs): CensusReport {
  const failures: string[] = []
  const map = (input.map ?? (WRITER_OWNERSHIP_MAP as readonly OwnershipRow[]))
  const mapByKey = new Map(map.map((row) => [`${row.destination}.${row.operation}`, row]))
  const sitesByKey = new Map<string, Site>()
  for (const site of input.sites) sitesByKey.set(site.key, site)

  const floor = input.minSourceFiles ?? MIN_SOURCE_FILES
  if (input.filesScanned < floor) {
    failures.push(`SUBJECT NOT REACHED: only ${input.filesScanned} source files were scanned (floor ${floor}). The roots are wrong or the walk found nothing.`)
  }

  // ---- declarations: shape, and what they point at -------------------------------------------------
  const declaredKeys = new Map<string, Declaration>()
  for (const d of input.declarations) {
    if (declaredKeys.has(d.key)) {
      failures.push(`DUPLICATE DECLARATION ${d.key}: a site is declared once. Remove one entry from ${DECLARATIONS_FILE}.`)
      continue
    }
    declaredKeys.set(d.key, d)
    if (!(MECHANISMS as readonly string[]).includes(d.mechanism)) {
      failures.push(`${d.key}: mechanism "${d.mechanism}" is not one of ${MECHANISMS.join(', ')}. Fix it in ${DECLARATIONS_FILE}.`)
    }
    if (d.obligationTime !== 'required' && d.obligationTime !== 'not-applicable') {
      failures.push(`${d.key}: obligationTime must be 'required' or 'not-applicable'. Fix it in ${DECLARATIONS_FILE}.`)
    }
    if (typeof d.note !== 'string' || d.note.trim().length < MIN_REASON) {
      failures.push(`${d.key}: the note is missing or shorter than ${MIN_REASON} characters. Say why this site produces ${d.destination}.${d.operation}.`)
    }
    const pair = `${d.destination}.${d.operation}`
    const row = mapByKey.get(pair)
    const excluded = Object.prototype.hasOwnProperty.call(input.excludedOperations, pair)
    if (!row && !excluded) {
      failures.push(
        `${d.key} declares ${pair}, which is neither an operation in ${MAP_FILE} nor in EXCLUDED_OPERATIONS.\n`
        + `    Add the operation to the ownership map (with its owner per phase), or add "${pair}" with a reason to EXCLUDED_OPERATIONS in ${DECLARATIONS_FILE}.`,
      )
    }
    if (row && excluded) {
      failures.push(`${pair} is both an ownership-map operation and in EXCLUDED_OPERATIONS. Remove it from EXCLUDED_OPERATIONS in ${DECLARATIONS_FILE}.`)
    }
    if (row && d.obligationTime !== row.obligationTime) {
      failures.push(
        `${d.key}: declares obligationTime '${d.obligationTime}' but ${pair} in ${MAP_FILE} says '${row.obligationTime}'. `
        + 'The producer and the map must agree about whether the work has a business-event time.',
      )
    }
  }
  for (const [pair, reason] of Object.entries(input.excludedOperations)) {
    if (typeof reason !== 'string' || reason.trim().length < MIN_REASON) {
      failures.push(`EXCLUDED_OPERATIONS["${pair}"] has no real reason. Say why this is not an ownership-map operation.`)
    }
    if (!input.declarations.some((d) => `${d.destination}.${d.operation}` === pair)) {
      failures.push(`EXCLUDED_OPERATIONS["${pair}"] is not used by any declaration. Delete it from ${DECLARATIONS_FILE}.`)
    }
  }

  // ---- sites <-> declarations, both ways -------------------------------------------------------------
  for (const site of input.sites) {
    if (!declaredKeys.has(site.key)) {
      failures.push(
        `NEW PRODUCER SITE ${site.key} (${site.file}:${site.line}) calls ${site.primitive}${site.via ? ` as ${site.via}` : ''} and is not declared.\n`
        + `    Edit ${DECLARATIONS_FILE}: add { key, destination, operation, mechanism, obligationTime, note } naming the (destination, operation) of ${MAP_FILE} this site produces.\n`
        + `    If the operation does not exist there, add it to the ownership map first; if the site is not a producer, declare it under an EXCLUDED_OPERATIONS pair with a reason.`,
      )
    }
  }
  for (const d of input.declarations) {
    if (!sitesByKey.has(d.key)) {
      failures.push(
        `STALE DECLARATION ${d.key}: no call site matches it. Delete it from ${DECLARATIONS_FILE} `
        + '(or fix the key if the site moved to another function or its ordinal changed).',
      )
    }
  }

  // ---- ownership map -> producers, both ways ---------------------------------------------------------
  const producedBy = new Map<string, number>()
  for (const d of input.declarations) {
    const pair = `${d.destination}.${d.operation}`
    if (mapByKey.has(pair) && sitesByKey.has(d.key)) producedBy.set(pair, (producedBy.get(pair) ?? 0) + 1)
  }
  let withProducer = 0
  let withNote = 0
  for (const [pair] of mapByKey) {
    const n = producedBy.get(pair) ?? 0
    const note = Object.prototype.hasOwnProperty.call(input.noProducer, pair) ? input.noProducer[pair] : undefined
    if (n > 0) withProducer++
    if (n === 0 && note === undefined) {
      failures.push(
        `OWNERSHIP OPERATION ${pair} has no declared producer and no NO_PRODUCER note.\n`
        + `    Declare the call site that produces it, or add "${pair}" with the reason to NO_PRODUCER in ${DECLARATIONS_FILE} (an explicit "no producer in this repo").`,
      )
    }
    if (n === 0 && note !== undefined) withNote++
    if (n > 0 && note !== undefined) {
      failures.push(`STALE NO_PRODUCER ${pair}: it now has ${n} declared producer(s). Delete the note from ${DECLARATIONS_FILE}.`)
    }
    if (note !== undefined && note.trim().length < MIN_REASON) {
      failures.push(`NO_PRODUCER["${pair}"] has no real reason.`)
    }
  }
  for (const pair of Object.keys(input.noProducer)) {
    if (!mapByKey.has(pair)) {
      failures.push(`NO_PRODUCER["${pair}"] is not an operation in ${MAP_FILE}. Delete it from ${DECLARATIONS_FILE}.`)
    }
  }

  // ---- the seam checks (SEAM-1, SEAM-2 over the source text; SEAM-3 over the declarations) ----------------
  for (const d of input.declarations) {
    if (d.destination === 'xero' && d.mechanism === 'direct-write') {
      failures.push(`SEAM-3 ${d.key} is a direct Xero write declared 'direct-write'. A direct write to Xero asks the producer-side hold ('seam'), or is the transport behind one ('drain').`)
    }
  }
  let seamCounts: SeamCounts | null = null
  if (input.sources) {
    const seam = seamFindings(input.sources, input.sites, input.declarations)
    failures.push(...seam.failures)
    seamCounts = seam.counts
    // A seam check that examined nothing proves nothing: with the tree reached, there must be seam sites and row sites.
    if (input.filesScanned >= floor && (seam.counts.seamSites === 0 || seam.counts.rowSites === 0 || seam.counts.egressSites === 0)) {
      failures.push(`SUBJECT NOT REACHED: the seam checks saw ${seam.counts.seamSites} seam site(s) and ${seam.counts.rowSites} sync-log create site(s); both must be above zero on this tree.`)
    }
  }

  // ---- precondition: every family this tree is known to contain was reached ----------------------------
  const byFamily: Record<string, number> = {}
  const byPrimitive: Record<string, number> = {}
  for (const site of input.sites) {
    const family = PRIMITIVES[site.primitive]?.family ?? (site.primitive.includes('.') ? 'raw-queue-create' : '(unknown)')
    byFamily[family] = (byFamily[family] ?? 0) + 1
    byPrimitive[site.primitive] = (byPrimitive[site.primitive] ?? 0) + 1
  }
  if (input.filesScanned >= floor) {
    const families = new Set<string>(Object.values(PRIMITIVES).map((p) => p.family))
    for (const family of families) {
      if (!byFamily[family]) {
        failures.push(`SUBJECT NOT REACHED: the scan found no site at all for the "${family}" family. A guard that scanned nothing prints nothing red; check the roots and the PRIMITIVES table.`)
      }
    }
    for (const [name, entry] of Object.entries(PRIMITIVES)) {
      if (entry.absentOnTrunk && byPrimitive[name]) {
        failures.push(`${name} is marked absentOnTrunk in PRIMITIVES but ${byPrimitive[name]} site(s) now call it. Remove the marker.`)
      }
    }
  }

  const byDestination: Record<string, number> = {}
  let excluded = 0
  for (const d of input.declarations) {
    if (!sitesByKey.has(d.key)) continue
    byDestination[d.destination] = (byDestination[d.destination] ?? 0) + 1
    if (Object.prototype.hasOwnProperty.call(input.excludedOperations, `${d.destination}.${d.operation}`)) excluded++
  }

  return {
    failures,
    counts: {
      filesScanned: input.filesScanned,
      sitesFound: input.sites.length,
      declared: input.declarations.filter((d) => sitesByKey.has(d.key)).length,
      excluded,
      byFamily,
      byPrimitive,
      byDestination,
      mapOperations: mapByKey.size,
      mapOperationsWithProducer: withProducer,
      mapOperationsNoProducer: withNote,
      seam: seamCounts,
    },
  }
}

export function formatCounts(report: CensusReport): string {
  const c = report.counts
  const lines = [
    `producer census: scanned ${c.filesScanned} source files`,
    `producer census: sites found ${c.sitesFound}, declared ${c.declared}, excluded (declared as not an ownership-map operation) ${c.excluded}`,
    `producer census: ownership-map operations ${c.mapOperations}: ${c.mapOperationsWithProducer} with a declared producer, ${c.mapOperationsNoProducer} with a NO_PRODUCER note`,
    `producer census: sites by family ${JSON.stringify(c.byFamily)}`,
    `producer census: sites by destination ${JSON.stringify(c.byDestination)}`,
    `producer census: sites by primitive ${JSON.stringify(c.byPrimitive)}`,
    `producer census: seam checks ${c.seam ? `${c.seam.seamSitesConsulting}/${c.seam.seamSites} seam sites consult the hold before producing; ${c.seam.rowSitesHandlingShadow}/${c.seam.rowSites} sync-log create sites handle the shadow answer; ${c.seam.egressSitesBehindBoundary}/${c.seam.egressSites} Xero transport calls are behind the claim boundary` : '(not run: no sources given)'}`,
    `producer census: primitives named but absent on this trunk (expected to find nothing): ${
      Object.entries(PRIMITIVES).filter(([, p]) => p.absentOnTrunk).map(([n]) => n).join(', ') || '(none)'}`,
  ]
  return lines.join('\n')
}
