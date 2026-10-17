/**
 * THE MINTSOFT HALF OF THE PRODUCER CENSUS: EVERY PLACE IMS CAN WRITE TO MINTSOFT ASKS THE PRODUCER-SIDE HOLD, AND THE LIST IS CHECKED.
 *
 * scripts/producer-census.ts finds every call of a named write primitive and requires it to be declared. That says WHERE the writers
 * are. This module says what each of the Mintsoft ones DOES about the hold, and closes the gaps the primitive list cannot see:
 *
 *   MINT-1  DESIGNATED SEAM FUNCTIONS. A table of the functions that carry the hold: the generic and the destination seam, the
 *           transport barrier, the sweep, the two operator re-arm actions, the product, bundle, content and ASN producers and the
 *           refund note. Each must exist, must call its consultation BEFORE its first effect, and must name each operation it
 *           governs in a consultation of its own (an operation literal that no consultation carries is red). A function renamed
 *           away, or a consultation deleted or moved after the effect, is red.
 *   MINT-2  EVERY ANSWER IS READ. A consultation whose result is thrown away, or never tested, is a seam that asks and ignores the
 *           answer. Each call of the seam must be assigned, and the answer's `proceed` / `held` (or the re-arm's refusal) must be
 *           read in the same function afterwards.
 *   MINT-3  EVERY MINTSOFT TRANSPORT CALL IS BEHIND THE BARRIER. By syntax tree over app/, lib/, scripts/ and components/: every
 *           `connectorFetch` / `fetch` call whose options name `connectorName: 'Mintsoft'` must sit in the one function that
 *           `mintsoftRequest` reaches AFTER its barrier (sendMintsoftRequest, referenced nowhere else), or in one of the two
 *           declared login helpers. A new raw call in a new file is red with its file:line, whatever its HTTP method: Mintsoft
 *           mutates through GET, so a method is no evidence of a read.
 *   MINT-4  EVERY MINTSOFT OWNERSHIP-MAP OPERATION IS GOVERNED. Each row of the map for destination mintsoft is covered by a
 *           'seam' declaration, a MINT-1 function that lists the operation, or an explicit entry in
 *           {@link MINT_OPERATIONS_GOVERNED_ELSEWHERE}. A new operation added to the map with no seam is red.
 *   MINT-5  THE CLEARANCE CANNOT BE FORGED, AND EVERY WRITE PASSES ONE. Every warehouse write method (pushOrder, updateOrder,
 *           cancelOrder, addOrderComment, upsertProduct, createBundle, createAsn, updateProductContent) is called with `<answer>.clearance`
 *           as its last argument, and the clearance type is minted by a type assertion in exactly one file. Every operation literal a
 *           consultation names is an operation of the map, and the generic seam names a destination for every registered warehouse
 *           connector.
 *
 * It is SYNTACTIC, like the census it extends. It proves the consultation is THERE and ORDERED before the effect in the function, not
 * that it dominates every path, and it cannot see a write built from a computed destination or reached through a registry lookup. The
 * blind spots are the census's own (producer-census.ts header) and are disclosed, not claimed covered. The differential and DB tests
 * prove the behaviour at each seam; the compiler proves a write cannot be called without a clearance of its own operation; this proves
 * nothing is added or removed without the table changing.
 */

import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

import { WRITER_OWNERSHIP_MAP, type OwnershipRow } from '../lib/security/writer-ownership-map'
import type { Declaration } from './producer-census'
import {
  SOURCE_ROOTS,
  calleeName,
  callsIn,
  findTopLevel,
  literalString,
  objectProperty,
  parse,
  topLevelNameOf,
  unwrap,
  walk,
} from './producer-census-woocommerce'

/** The consultations that answer `{ proceed }`. The generic one carries the connector id first, the destination one does not. */
export const MINT_CONSULT_CALLS = ['wmsProducerSeam', 'mintsoftProducerSeam'] as const
/** The consultation of the operator re-arm actions: null to go ahead, `{ notice }` to refuse. Its implicit operation is order.create. */
export const MINT_REARM_CALLS = ['wmsOrderCreateReArmShadow'] as const
/** The pass-level gate: `.held` is read. */
export const MINT_HOLD_CALLS = ['wmsProducerHold', 'mintsoftDrainHold'] as const
/** Files that define the consultations; their own bodies are not callers. */
export const MINT_SEAM_DEFINITION_FILES = [
  'lib/connectors/wms/producer-seam.ts',
  'lib/connectors/mintsoft/producer-seam.ts',
  'lib/connectors/mintsoft/producer-egress.ts',
] as const
/** The warehouse write methods of the connector contract. Each takes a clearance as its last argument. */
export const MINT_WRITE_METHODS = [
  'pushOrder', 'updateOrder', 'cancelOrder', 'addOrderComment', 'upsertProduct', 'createBundle', 'createAsn', 'updateProductContent',
] as const
export const CLEARANCE_MINT_FILE = 'lib/connectors/wms/clearance.ts'
export const CLEARANCE_MINT_FUNCTION = 'mintWmsWriteClearance'
export const DESTINATION_TABLE_FILE = 'lib/connectors/wms/producer-seam.ts'
export const CLEARANCE_TYPE = 'WmsWriteClearance'

export type MintSeamRole = 'generic-seam' | 'destination-seam' | 'transport-barrier' | 'sweep' | 'operator-rearm' | 'producer'

export type MintSeamFunction = {
  file: string
  decl: string
  role: MintSeamRole
  /** One of these must be called in the function. */
  mustCall: readonly string[]
  /** The first call of any of these (by callee name) is the function's first EFFECT; a consultation must come before it. */
  beforeCalls: readonly string[]
  /** Ownership-map operations of destination mintsoft that this function governs: each must be named by a consultation in it. */
  operations: readonly string[]
  why: string
}

export const MINT_SEAM_FUNCTIONS: readonly MintSeamFunction[] = [
  {
    file: 'lib/connectors/wms/producer-seam.ts', decl: 'wmsProducerSeam', role: 'generic-seam',
    mustCall: ['mintsoftProducerSeam'], beforeCalls: [],
    operations: [],
    why: 'The generic warehouse seam: connector-agnostic flows ask it, and it hands the question to the destination of the connector they hold.',
  },
  {
    file: 'lib/connectors/mintsoft/producer-seam.ts', decl: 'mintsoftProducerSeam', role: 'destination-seam',
    mustCall: ['producerSeamVerdict'], beforeCalls: ['recordOutboundShadow'],
    operations: [],
    why: 'The destination seam: it decides from the environment first and records the shadow only for a SHADOW decision.',
  },
  {
    file: 'lib/connectors/mintsoft/api/client.ts', decl: 'mintsoftRequest', role: 'transport-barrier',
    mustCall: ['mintsoftEgressHold'], beforeCalls: ['getMintsoftApiConfiguration', 'getMintsoftAccessToken', 'sendMintsoftRequest'],
    operations: [],
    why: 'The last barrier in front of every Mintsoft request: a held write is refused before the configuration read and before any key could be minted.',
  },
  {
    file: 'lib/domain/wms/order-push-sweep.ts', decl: 'runWmsOrderPushSweepCore', role: 'sweep',
    mustCall: ['wmsProducerHold'], beforeCalls: ['releasableHeldOrders', 'revalidatableLinks', 'ambiguousCreateLinks', 'createCandidates'],
    operations: ['order.create', 'order.amend', 'order.cancel', 'order.hold', 'order.comment'],
    why: 'The order-push sweep: the passes that only re-open creates stand down while the warehouse is held, and every create, amendment, cancellation, hold and note asks first.',
  },
  {
    file: 'app/actions/wms-order-push.ts', decl: 'replayWmsOrderPush', role: 'operator-rearm',
    mustCall: ['wmsOrderCreateReArmShadow'], beforeCalls: ['probeOrderPresence', 'updateMany'],
    operations: ['order.create'],
    why: 'The order-page replay re-arms a create: it is refused with the shadow text and queues nothing.',
  },
  {
    file: 'app/actions/sync-exceptions.ts', decl: 'repushMissingWmsOrder', role: 'operator-rearm',
    mustCall: ['wmsOrderCreateReArmShadow'], beforeCalls: ['probeOrderPresence', '$transaction'],
    operations: ['order.create'],
    why: 'The exception inbox re-push re-arms a create: it is refused with the shadow text and leaves the finding and the link as they are.',
  },
  {
    file: 'lib/connectors/mintsoft/sync/product-sync.ts', decl: 'syncOneMintsoftProduct', role: 'producer',
    mustCall: ['mintsoftProducerSeam'], beforeCalls: ['upsertProduct'],
    operations: ['product.upsert'],
    why: 'The one product writer: the hook, the verify cron, the verify button and the e2e route all reach Mintsoft through it.',
  },
  {
    file: 'lib/connectors/mintsoft/sync/bundle-sync.ts', decl: 'syncBundleInternal', role: 'producer',
    mustCall: ['mintsoftProducerSeam'], beforeCalls: ['claimBundleCreateSlot', 'createBundle'],
    operations: ['product.bundle'],
    why: 'The one bundle writer: it asks before the claim slot is taken, so a shadow leaves no "a create may be on its way" trace.',
  },
  {
    file: 'lib/connectors/mintsoft/sync/product-content-sync.ts', decl: 'syncMintsoftProductContent', role: 'producer',
    mustCall: ['mintsoftProducerSeam'], beforeCalls: ['updateProductContent'],
    operations: ['product.content'],
    why: 'The one product-content writer: its own live/shadow decision is joined to the enforcement switch and yields the clearance.',
  },
  {
    file: 'app/actions/mintsoft-sync.ts', decl: 'createMintsoftPurchaseOrderAsn', role: 'producer',
    mustCall: ['mintsoftProducerSeam'], beforeCalls: ['create', 'createAsn'],
    operations: ['asn.create'],
    why: 'The purchase-order ASN button: it asks before the sync job, the reservation or the create, so a shadow reserves nothing.',
  },
  {
    file: 'app/actions/mintsoft-sync.ts', decl: 'createMintsoftTransferAsn', role: 'producer',
    mustCall: ['mintsoftProducerSeam'], beforeCalls: ['create', 'createAsn'],
    operations: ['asn.create'],
    why: 'The transfer ASN button: it asks before the sync job, the reservation or the create, so a shadow reserves nothing.',
  },
  {
    file: 'app/actions/sales.ts', decl: 'createRefund', role: 'producer',
    mustCall: ['wmsProducerSeam'], beforeCalls: ['addOrderComment'],
    operations: ['order.comment'],
    why: 'The refund note on a pushed order: shadowed it is kept as a record and the refund goes on.',
  },
]

/**
 * Mintsoft ownership-map operations that are governed by something other than a function above or a declared 'seam' site. Each needs
 * the reason; an entry that no longer matches a map row is red.
 */
export const MINT_OPERATIONS_GOVERNED_ELSEWHERE: Readonly<Record<string, string>> = {
  'auth.login': 'Key minting is not a business write (map owner nobody): the producer hold is never consulted for it, and the outbound-write hold\'s login grant governs it.',
}

/** The only places a Mintsoft transport call may sit, besides the barrier's own sendMintsoftRequest. */
export const MINT_LOGIN_TRANSPORT: Readonly<Record<string, string>> = {
  'lib/connectors/mintsoft/api/auth.ts::requestMintsoftAuthSession': 'POST /api/Auth mints a key: not a business write; the outbound-write hold\'s login grant governs it (ownership-map row auth.login).',
  'lib/connectors/mintsoft/api/auth.ts::testMintsoftFixedApiKey': 'A literal GET /api/Warehouse that only tests a key: a read.',
}
export const MINT_BARRIER_FILE = 'lib/connectors/mintsoft/api/client.ts'
export const MINT_BARRIER_ENTRY = 'mintsoftRequest'
export const MINT_BARRIER_SEND = 'sendMintsoftRequest'

const SKIPPED_DIRS_NOTE = 'app/, lib/, scripts/ and components/'

// ───────────────────────── syntax helpers ─────────────────────────

function operationLiterals(call: ts.CallExpression): string[] {
  const arg = call.arguments.find((a) => ts.isObjectLiteralExpression(unwrap(a)))
  if (!arg) return []
  const prop = objectProperty(unwrap(arg) as ts.ObjectLiteralExpression, 'operation')
  if (!prop || !ts.isPropertyAssignment(prop)) return []
  const init = unwrap(prop.initializer)
  const direct = literalString(init as ts.Expression)
  if (direct !== null) return [direct]
  if (ts.isConditionalExpression(init)) {
    return [literalString(init.whenTrue), literalString(init.whenFalse)].filter((x): x is string => x !== null)
  }
  return []
}

type Consultation = { name: string; pos: number; operations: string[] }

function consultationsIn(node: ts.Node, sf: ts.SourceFile): Consultation[] {
  const out: Consultation[] = []
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const name = calleeName(n)
      if (name && (MINT_CONSULT_CALLS as readonly string[]).includes(name)) {
        out.push({ name, pos: n.getStart(sf), operations: operationLiterals(n) })
      } else if (name && (MINT_REARM_CALLS as readonly string[]).includes(name)) {
        out.push({ name, pos: n.getStart(sf), operations: ['order.create'] })
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(node)
  return out
}

// ───────────────────────── MINT-2 / MINT-5: the scan of every caller ─────────────────────────

export type MintCallerFinding = { file: string; line: number; decl: string; message: string }

export type MintScan = {
  mintCalls: number
  consultCalls: number
  consultCallsRead: number
  writeCalls: number
  writeCallsWithClearance: number
  clearanceCasts: Array<{ file: string; line: number }>
  operationLiterals: Array<{ file: string; line: number; operation: string }>
  failures: string[]
}

/** The scan of ONE source text. Pure: fixtures drive every detector through this. */
export function scanMintsoftCallersSource(text: string, file: string): MintScan {
  const result: MintScan = {
    mintCalls: 0, consultCalls: 0, consultCallsRead: 0, writeCalls: 0, writeCallsWithClearance: 0, clearanceCasts: [], operationLiterals: [], failures: [],
  }
  const interesting = [...MINT_CONSULT_CALLS, ...MINT_REARM_CALLS, ...MINT_HOLD_CALLS, ...MINT_WRITE_METHODS, CLEARANCE_TYPE, CLEARANCE_MINT_FUNCTION]
  if (!interesting.some((name) => text.includes(name))) return result
  const sf = parse(file, text)
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
  const isDefinitionFile = (MINT_SEAM_DEFINITION_FILES as readonly string[]).includes(file)

  const visit = (n: ts.Node) => {
    // MINT-5: a type assertion to the clearance type.
    if ((ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)) && n.type.getText(sf).includes(CLEARANCE_TYPE)) {
      result.clearanceCasts.push({ file, line: lineOf(n) })
    }
    if (ts.isCallExpression(n)) {
      const name = calleeName(n)
      // MINT-5: the clearance is minted by a call of the mint function, and that call is made by the two seams only.
      if (name === CLEARANCE_MINT_FUNCTION && file !== CLEARANCE_MINT_FILE) {
        if (!(MINT_SEAM_DEFINITION_FILES as readonly string[]).includes(file)) {
          result.failures.push(`MINT-5 ${file}:${lineOf(n)} (${topLevelNameOf(n, sf)}) calls ${CLEARANCE_MINT_FUNCTION}. A clearance is minted by the producer seams (${MINT_SEAM_DEFINITION_FILES.join(', ')}) as the \`proceed\` arm of a consultation; a call anywhere else forges the answer to a question nobody asked.`)
        } else result.mintCalls++
      }
      if (name && (MINT_CONSULT_CALLS as readonly string[]).includes(name)) {
        for (const operation of operationLiterals(n)) result.operationLiterals.push({ file, line: lineOf(n), operation })
      }
      // MINT-2: the answer of a consultation is assigned and read.
      if (name && !isDefinitionFile && ([...MINT_CONSULT_CALLS, ...MINT_REARM_CALLS, ...MINT_HOLD_CALLS] as readonly string[]).includes(name)) {
        result.consultCalls++
        const decl = topLevelNameOf(n, sf)
        let parent: ts.Node = n.parent
        while (parent && (ts.isAwaitExpression(parent) || ts.isParenthesizedExpression(parent))) parent = parent.parent
        const assigned = parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) ? parent.name.text : null
        // `wmsProducerHold(…).held` reads the answer in the same expression.
        if (!assigned && parent && ts.isPropertyAccessExpression(parent) && ['held', 'proceed'].includes(parent.name.text)) {
          result.consultCallsRead++
        } else if (!assigned) {
          result.failures.push(`MINT-2 ${file}:${lineOf(n)} (${decl}) calls ${name} and does not keep the answer. A consultation whose result is thrown away is a seam that asks and ignores the answer: assign it and test it.`)
        } else {
          const container = findContainer(sf, n)
          let read = false
          const scan = (m: ts.Node) => {
            if (ts.isIdentifier(m) && m.text === assigned && m.getStart(sf) > n.getStart(sf) && m !== (parent as ts.VariableDeclaration).name) {
              const p = m.parent
              const isMember = p && ts.isPropertyAccessExpression(p) && p.expression === m && ['proceed', 'held'].includes(p.name.text)
              const isTest = p && (
                (ts.isIfStatement(p) && p.expression === m)
                || (ts.isConditionalExpression(p) && p.condition === m)
                || (ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken)
                || (ts.isReturnStatement(p))
              )
              if (isMember || isTest) read = true
            }
            ts.forEachChild(m, scan)
          }
          if (container) scan(container)
          if (read) result.consultCallsRead++
          else result.failures.push(`MINT-2 ${file}:${lineOf(n)} (${decl}) keeps the answer of ${name} in \`${assigned}\` but never tests it (no \`${assigned}.proceed\`, \`${assigned}.held\` or \`if (${assigned})\` afterwards).`)
        }
      }
      // MINT-5: a warehouse write is called with `<answer>.clearance` as its last argument.
      if (name && (MINT_WRITE_METHODS as readonly string[]).includes(name) && ts.isPropertyAccessExpression(unwrap(n.expression))) {
        result.writeCalls++
        const last = n.arguments[n.arguments.length - 1]
        const lastExpr = last ? unwrap(last) : null
        if (lastExpr && ts.isPropertyAccessExpression(lastExpr) && lastExpr.name.text === 'clearance') result.writeCallsWithClearance++
        else result.failures.push(`MINT-5 ${file}:${lineOf(n)} (${topLevelNameOf(n, sf)}) calls the warehouse write ${name} without \`<answer>.clearance\` as its last argument. Ask the producer seam first and pass the clearance from its \`proceed\` arm.`)
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return result
}

function findContainer(sf: ts.SourceFile, node: ts.Node): ts.Node | null {
  const pos = node.getStart(sf)
  return sf.statements.find((statement) => statement.getStart(sf) <= pos && pos < statement.getEnd()) ?? null
}

// ───────────────────────── MINT-3: the raw transport scan ─────────────────────────

export type MintTransportSite = { file: string; line: number; decl: string; callee: string; method: string; gated?: boolean }

/** Every `connectorFetch(…)` / `fetch(…)` call whose options name `connectorName: 'Mintsoft'` in this file. */
export function scanMintsoftTransportSource(text: string, file: string): MintTransportSite[] {
  if (!text.includes('Mintsoft')) return []
  const sf = parse(file, text)
  const sites: MintTransportSite[] = []
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const name = calleeName(n)
      if (name === 'connectorFetch' || name === 'fetch') {
        const [, initArg, optionsArg] = n.arguments
        let aimed = false
        let gated = false
        if (optionsArg && ts.isObjectLiteralExpression(unwrap(optionsArg))) {
          const prop = objectProperty(unwrap(optionsArg) as ts.ObjectLiteralExpression, 'connectorName')
          if (prop && ts.isPropertyAssignment(prop) && literalString(prop.initializer) === 'Mintsoft') aimed = true
          // A hop gate, or a refusal of every redirect: either way no redirect hop is followed unjudged.
          const opts = unwrap(optionsArg) as ts.ObjectLiteralExpression
          if (objectProperty(opts, 'hopGate')) gated = true
          const refuse = objectProperty(opts, 'refuseRedirects')
          if (refuse && ts.isPropertyAssignment(refuse) && refuse.initializer.kind === ts.SyntaxKind.TrueKeyword) gated = true
        }
        if (aimed) {
          let method = 'GET'
          if (initArg) {
            const init = unwrap(initArg)
            if (ts.isObjectLiteralExpression(init)) {
              const prop = objectProperty(init, 'method')
              if (prop) {
                const value = ts.isPropertyAssignment(prop) ? literalString(prop.initializer) : null
                method = value === null ? 'UNKNOWN' : value.toUpperCase()
              }
              // A spread (`...init`) may carry a method the literal does not show.
              if (init.properties.some((p) => ts.isSpreadAssignment(p))) method = 'UNKNOWN'
            } else method = 'UNKNOWN'
          }
          sites.push({ file, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, decl: topLevelNameOf(n, sf), callee: name, method, gated })
        }
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return sites
}

// ───────────────────────── the findings ─────────────────────────

export type MintCensusInput = {
  readSource: (file: string) => string | undefined
  transport: readonly MintTransportSite[]
  scans: ReadonlyArray<MintScan>
  declarations: readonly Declaration[]
  siteKeys: ReadonlySet<string>
  seamFunctions?: readonly MintSeamFunction[]
  map?: readonly OwnershipRow[]
  governedElsewhere?: Readonly<Record<string, string>>
  /** Registered warehouse connector ids, and the connectors the generic seam names a destination for (both read as syntax). */
  registeredConnectorIds?: readonly string[] | null
  destinationConnectorIds?: readonly string[] | null
}

export type MintCensusCounts = {
  seamFunctions: number
  seamFunctionsConsulting: number
  seamOperations: number
  seamOperationsNamed: number
  consultCalls: number
  consultCallsRead: number
  transportSites: number
  transportSitesBehindBarrier: number
  writeCalls: number
  writeCallsWithClearance: number
  clearanceCasts: number
  mintCalls: number
  mapOperations: number
  mapOperationsGoverned: number
}

/** The string-literal elements of `export const <name> = [ … ]` (or `{ k: v }` keys), by syntax. */
export function literalMembersOf(text: string, name: string, kind: 'array' | 'object'): string[] | null {
  const sf = parse(`${name}.ts`, text)
  let found: string[] | null = null
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) {
      let init = unwrap(n.initializer)
      while (ts.isSatisfiesExpression(init)) init = unwrap(init.expression)
      if (kind === 'array' && ts.isArrayLiteralExpression(init)) {
        const items = init.elements.map((e) => literalString(e as ts.Expression))
        found = items.every((x): x is string => x !== null) ? (items as string[]) : null
      }
      if (kind === 'object' && ts.isObjectLiteralExpression(init)) {
        found = init.properties.flatMap((p) => (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? [p.name.text] : []))
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return found
}

export function mintCensusFindings(input: MintCensusInput): { failures: string[]; counts: MintCensusCounts } {
  const failures: string[] = []
  const seamFunctions = input.seamFunctions ?? MINT_SEAM_FUNCTIONS
  const map = (input.map ?? (WRITER_OWNERSHIP_MAP as readonly OwnershipRow[])).filter((row) => row.destination === 'mintsoft')
  const governedElsewhere = input.governedElsewhere ?? MINT_OPERATIONS_GOVERNED_ELSEWHERE
  const counts: MintCensusCounts = {
    seamFunctions: 0, seamFunctionsConsulting: 0, seamOperations: 0, seamOperationsNamed: 0,
    consultCalls: 0, consultCallsRead: 0, transportSites: input.transport.length, transportSitesBehindBarrier: 0,
    writeCalls: 0, writeCallsWithClearance: 0, clearanceCasts: 0, mintCalls: 0, mapOperations: map.length, mapOperationsGoverned: 0,
  }
  const parsed = new Map<string, ts.SourceFile | null>()
  const sourceFile = (file: string): ts.SourceFile | null => {
    if (!parsed.has(file)) {
      const text = input.readSource(file)
      parsed.set(file, text === undefined ? null : parse(file, text))
    }
    return parsed.get(file) ?? null
  }

  // ---- MINT-1 ----
  for (const fn of seamFunctions) {
    counts.seamFunctions++
    const sf = sourceFile(fn.file)
    if (!sf) { failures.push(`MINT-1 ${fn.file}::${fn.decl}: the file could not be read. A seam function that moved must have its row in MINT_SEAM_FUNCTIONS (scripts/producer-census-mintsoft.ts) updated.`); continue }
    const node = findTopLevel(sf, fn.decl)
    if (!node) { failures.push(`MINT-1 ${fn.file}::${fn.decl} (${fn.role}) no longer exists. Update MINT_SEAM_FUNCTIONS if it was renamed or moved; do not delete the row if the duty moved with it.`); continue }
    const calls = callsIn(node, sf)
    const consult = calls.filter((call) => fn.mustCall.includes(call.name))
    if (consult.length === 0) {
      failures.push(`MINT-1 ${fn.file}::${fn.decl} (${fn.role}) calls none of ${fn.mustCall.join(', ')}. ${fn.why}`)
      continue
    }
    const firstConsult = Math.min(...consult.map((call) => call.pos))
    const effects = calls.filter((call) => fn.beforeCalls.includes(call.name))
    const firstEffect = effects.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...effects.map((call) => call.pos))
    if (fn.beforeCalls.length > 0 && effects.length === 0) {
      failures.push(`MINT-1 ${fn.file}::${fn.decl} (${fn.role}) never calls ${fn.beforeCalls.join(' or ')}, the effect its consultation must precede. The row is stale or the function changed shape: ${fn.why}`)
      continue
    }
    if (firstConsult > firstEffect) {
      failures.push(`MINT-1 ${fn.file}::${fn.decl} (${fn.role}) consults ${fn.mustCall.join('/')} AFTER its first effect (${fn.beforeCalls.join('/')}). The consultation must come first. ${fn.why}`)
      continue
    }
    counts.seamFunctionsConsulting++
    // MINT-1c: every operation the row lists is named by a consultation in the function.
    const named = consultationsIn(node, sf)
    for (const operation of fn.operations) {
      counts.seamOperations++
      if (named.some((c) => c.operations.includes(operation))) counts.seamOperationsNamed++
      else failures.push(`MINT-1 ${fn.file}::${fn.decl} lists the operation mintsoft.${operation} but no consultation in it names that operation. A consultation for another operation does not govern this one.`)
    }
  }

  // ---- MINT-2 and MINT-5 (the callers) ----
  for (const scan of input.scans) {
    counts.consultCalls += scan.consultCalls
    counts.consultCallsRead += scan.consultCallsRead
    counts.writeCalls += scan.writeCalls
    counts.writeCallsWithClearance += scan.writeCallsWithClearance
    counts.clearanceCasts += scan.clearanceCasts.length
    counts.mintCalls += scan.mintCalls
    failures.push(...scan.failures)
    for (const cast of scan.clearanceCasts) {
      if (cast.file !== CLEARANCE_MINT_FILE) {
        failures.push(`MINT-5 ${cast.file}:${cast.line} casts to ${CLEARANCE_TYPE}. A clearance is minted in ${CLEARANCE_MINT_FILE} only, as the \`proceed\` arm of a consultation; a cast anywhere else forges the answer to a question nobody asked.`)
      }
    }
  }
  if (counts.clearanceCasts !== 1) {
    failures.push(`MINT-5 expected exactly one cast to ${CLEARANCE_TYPE} (in ${CLEARANCE_MINT_FILE}) and found ${counts.clearanceCasts}.`)
  }
  if (counts.mintCalls !== 2) {
    failures.push(`MINT-5 expected exactly two calls of ${CLEARANCE_MINT_FUNCTION} (one in each producer seam) and found ${counts.mintCalls}.`)
  }
  const mapOperations = new Set(map.map((row) => row.operation))
  for (const scan of input.scans) {
    for (const lit of scan.operationLiterals) {
      if (!mapOperations.has(lit.operation)) {
        failures.push(`MINT-5 ${lit.file}:${lit.line} consults the producer seam for the operation "${lit.operation}", which is not an operation of the Mintsoft ownership map.`)
      }
    }
  }
  const registered = input.registeredConnectorIds
  const named = input.destinationConnectorIds
  if (!registered || !named) {
    failures.push('MINT-5 the registered warehouse connector ids or the generic seam\'s destination table could not be read as syntax, so the destination mapping cannot be checked.')
  } else {
    for (const id of registered) {
      if (!named.includes(id)) failures.push(`MINT-5 the warehouse connector "${id}" is registered but ${DESTINATION_TABLE_FILE} names no destination for it (WMS_PRODUCER_DESTINATION), so its writes would be ungoverned.`)
    }
    for (const id of named) {
      if (!registered.includes(id)) failures.push(`MINT-5 ${DESTINATION_TABLE_FILE} names a destination for "${id}", which is not a registered warehouse connector. Delete the entry.`)
    }
  }

  // ---- MINT-3 ----
  const barrierSf = sourceFile(MINT_BARRIER_FILE)
  let sendOnlyInEntry = false
  if (barrierSf) {
    const uses: string[] = []
    const visit = (n: ts.Node) => {
      if (ts.isIdentifier(n) && n.text === MINT_BARRIER_SEND && !(ts.isFunctionDeclaration(n.parent) && n.parent.name === n)) uses.push(topLevelNameOf(n, barrierSf))
      ts.forEachChild(n, visit)
    }
    visit(barrierSf)
    sendOnlyInEntry = uses.length > 0 && uses.every((decl) => decl === MINT_BARRIER_ENTRY)
    if (!sendOnlyInEntry) {
      failures.push(`MINT-3 ${MINT_BARRIER_FILE}: ${MINT_BARRIER_SEND} is referenced outside ${MINT_BARRIER_ENTRY} (${uses.join(', ') || 'nowhere'}). It is the function behind the barrier, so only the barrier's own function may call it.`)
    }
  } else {
    failures.push(`MINT-3 ${MINT_BARRIER_FILE} could not be read, so the transport barrier cannot be checked.`)
  }
  const sendSeen = new Set<string>()
  const loginSeen = new Set<string>()
  for (const site of input.transport) {
    const key = `${site.file}::${site.decl}`
    if (site.gated === false) {
      failures.push(`MINT-3 ${site.file}:${site.line} (${site.decl}) calls ${site.callee} on Mintsoft without \`hopGate\` or \`refuseRedirects: true\`. Mintsoft mutates through GET, so a followed redirect can land on a write path the producer hold never judged: pass mintsoftHopGate, or refuse redirects.`)
    }
    if (site.file === MINT_BARRIER_FILE && site.decl === MINT_BARRIER_SEND) {
      if (sendOnlyInEntry) counts.transportSitesBehindBarrier++
      sendSeen.add(key)
      continue
    }
    if (Object.prototype.hasOwnProperty.call(MINT_LOGIN_TRANSPORT, key)) {
      loginSeen.add(key)
      if (key.endsWith('testMintsoftFixedApiKey') && site.method !== 'GET') {
        failures.push(`MINT-3 ${site.file}:${site.line} (${site.decl}) is declared a read-only key test but calls ${site.callee} with method ${site.method}.`)
      } else counts.transportSitesBehindBarrier++
      continue
    }
    failures.push(`MINT-3 ${site.file}:${site.line} (${site.decl}) calls ${site.callee} on Mintsoft (method ${site.method}) outside the barrier. A Mintsoft request goes through mintsoftRequest, which refuses a held write before it leaves; `
      + 'Mintsoft mutates through GET too, so no method makes a direct call safe. Route it through mintsoftRequest, or declare a login helper in MINT_LOGIN_TRANSPORT with the reason.')
  }
  if (!sendSeen.has(`${MINT_BARRIER_FILE}::${MINT_BARRIER_SEND}`)) failures.push(`MINT-3 the transport call in ${MINT_BARRIER_FILE}::${MINT_BARRIER_SEND} was not found, so the barrier guards nothing. The row is stale.`)
  for (const key of Object.keys(MINT_LOGIN_TRANSPORT)) {
    if (!loginSeen.has(key)) failures.push(`MINT-3 the login helper ${key} matches no Mintsoft transport call. Delete its entry from MINT_LOGIN_TRANSPORT.`)
  }

  // ---- MINT-4 ----
  const governed = new Set<string>()
  for (const fn of seamFunctions) for (const op of fn.operations) governed.add(op)
  for (const declaration of input.declarations) {
    if (declaration.destination === 'mintsoft' && declaration.mechanism === 'seam' && input.siteKeys.has(declaration.key)) governed.add(declaration.operation)
  }
  for (const row of map) {
    const elsewhere = Object.prototype.hasOwnProperty.call(governedElsewhere, row.operation)
    if (governed.has(row.operation)) {
      counts.mapOperationsGoverned++
      if (elsewhere) failures.push(`MINT-4 mintsoft.${row.operation} is both governed by a seam and listed in MINT_OPERATIONS_GOVERNED_ELSEWHERE. Remove the stale entry.`)
    } else if (elsewhere) {
      counts.mapOperationsGoverned++
    } else {
      failures.push(`MINT-4 the ownership-map operation mintsoft.${row.operation} is governed by no seam: no 'seam' declaration, no MINT_SEAM_FUNCTIONS row lists it, and it is not an explicit exception. `
        + 'A Mintsoft operation nothing asks the hold about is a writer that bypasses it.')
    }
  }
  for (const op of Object.keys(governedElsewhere)) {
    if (!map.some((row) => row.operation === op)) failures.push(`MINT-4 MINT_OPERATIONS_GOVERNED_ELSEWHERE["${op}"] is not an operation of the ownership map. Delete it.`)
  }

  return { failures, counts }
}

export function runMintsoftCensus(root: string, declarations: readonly Declaration[], siteKeys: ReadonlySet<string>) {
  const files = SOURCE_ROOTS.flatMap((r) => walk(join(root, r)))
  const transport: MintTransportSite[] = []
  const scans: MintScan[] = []
  for (const abs of files) {
    const rel = relative(root, abs).split('\\').join('/')
    const text = readFileSync(abs, 'utf8')
    transport.push(...scanMintsoftTransportSource(text, rel))
    scans.push(scanMintsoftCallersSource(text, rel))
  }
  const cache = new Map<string, string | undefined>()
  const readSource = (file: string): string | undefined => {
    if (!cache.has(file)) {
      try { cache.set(file, readFileSync(join(root, file), 'utf8')) } catch { cache.set(file, undefined) }
    }
    return cache.get(file)
  }
  const typesText = readSource('lib/connectors/wms/types.ts')
  const seamText = readSource(DESTINATION_TABLE_FILE)
  const registeredConnectorIds = typesText === undefined ? null : literalMembersOf(typesText, 'WMS_CONNECTOR_IDS', 'array')
  const destinationConnectorIds = seamText === undefined ? null : literalMembersOf(seamText, 'WMS_PRODUCER_DESTINATION', 'object')
  return {
    filesScanned: files.length,
    transport,
    ...mintCensusFindings({ readSource, transport, scans, declarations, siteKeys, registeredConnectorIds, destinationConnectorIds }),
  }
}

export function formatMintsoftCounts(counts: MintCensusCounts): string {
  return `producer census (Mintsoft): ${counts.seamFunctionsConsulting}/${counts.seamFunctions} seam functions consult the hold before their first effect and name ${counts.seamOperationsNamed}/${counts.seamOperations} operations; `
    + `${counts.consultCallsRead}/${counts.consultCalls} consultations have their answer read; `
    + `${counts.transportSitesBehindBarrier}/${counts.transportSites} Mintsoft transport calls sit behind the barrier or are declared login helpers; `
    + `${counts.writeCallsWithClearance}/${counts.writeCalls} warehouse write calls pass an answer's clearance (${counts.clearanceCasts} clearance cast, ${counts.mintCalls} mint calls); `
    + `${counts.mapOperationsGoverned}/${counts.mapOperations} Mintsoft ownership operations are governed`
}

export const MINT_SCANNED_ROOTS_NOTE = SKIPPED_DIRS_NOTE
