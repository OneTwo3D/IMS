/**
 * THE WOOCOMMERCE HALF OF THE PRODUCER CENSUS: EVERY PLACE IMS CAN WRITE TO WOOCOMMERCE ASKS THE PRODUCER-SIDE HOLD, AND THE LIST IS CHECKED.
 *
 * scripts/producer-census.ts finds every call of a named write primitive and requires it to be declared. That says WHERE the writers
 * are. This module says what each of the WooCommerce ones DOES about the hold, and closes the gaps the primitive list cannot see:
 *
 *   WOO-1  DESIGNATED SEAM FUNCTIONS. A table of the functions that carry the hold (the outbox enqueue, the stock writer, the three
 *          queue drains, the last barrier in front of the transport, the daily-reconcile stamp). Each must exist, and must call its
 *          consultation BEFORE its first effect. A function renamed away, or a consultation deleted or moved after the effect, is red.
 *   WOO-2  EVERY WOOCOMMERCE OUTBOX ENQUEUE HANDLES THE SHADOW ANSWER. A declared `enqueueIntegrationOutbox` site for WooCommerce must,
 *          in its own function, read the answer with `isOutboxEnqueueShadowed` after the call. A caller that treated a shadow as a
 *          queued row (the defect this exists to stop) is red.
 *   WOO-3  EVERY RAW WOOCOMMERCE TRANSPORT WRITE IS FOUND, WHOEVER WROTE IT. By syntax tree over app/, lib/, scripts/ and components/:
 *          every `connectorFetch` / `fetch` call aimed at WooCommerce (its `connectorName` is 'WooCommerce', or its URL names
 *          `wp-json`) whose method is not a literal GET/HEAD (a computed or missing-literal method counts as a write). Each must sit in a
 *          function that the WOO-1 table lists as the transport barrier, and that function must call `wooEgressHold` before the call.
 *          A new raw POST in a new file is red with its file:line.
 *   WOO-4  EVERY WOOCOMMERCE OWNERSHIP-MAP OPERATION IS GOVERNED. Each row of the map for destination woocommerce is covered by a
 *          declared 'seam' site, a WOO-1 function that lists the operation, or an explicit entry in {@link WOO_OPERATIONS_GOVERNED_ELSEWHERE}
 *          / the producer census's NO_PRODUCER. A new operation added to the map with no seam is red.
 *   WOO-5  EVERY OUTBOX REGISTRY ENTRY NAMES WHERE ITS EFFECT LANDS, and a WooCommerce or Mintsoft one is in the ownership map.
 *
 * It is SYNTACTIC, like the census it extends. It proves the consultation is THERE and ORDERED before the effect in the function, not
 * that it dominates every path, and it cannot see a write built from a computed destination or reached through a registry lookup. The
 * blind spots are the census's own (producer-census.ts header) and are disclosed, not claimed covered. The differential and DB tests
 * prove the behaviour at each seam; this proves nothing is added or removed without the table changing.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import ts from 'typescript'

import { ownershipTargetForOutboxOperation, WRITER_OWNERSHIP_MAP, type OwnershipRow } from '../lib/security/writer-ownership-map'
import type { Declaration } from './producer-census'

export type WooSeamRole = 'outbox-primitive' | 'producer' | 'drain' | 'transport-barrier' | 'stamp-guard' | 'sync-log-seam'

export type WooSeamFunction = {
  file: string
  decl: string
  role: WooSeamRole
  /** One of these must be called in the function. */
  mustCall: readonly string[]
  /** The first call of any of these (by callee name) is the function's first EFFECT; a consultation must come before it. */
  beforeCalls: readonly string[]
  /** Ownership-map operations of destination woocommerce that this function governs. */
  operations: readonly string[]
  why: string
}

export const WOO_SEAM_FUNCTIONS: readonly WooSeamFunction[] = [
  {
    file: 'lib/domain/integrations/outbox.ts', decl: 'enqueueIntegrationOutbox', role: 'outbox-primitive',
    mustCall: ['outboxProducerVerdict'], beforeCalls: ['create'],
    operations: ['stock', 'order.status'],
    why: 'The one outbox enqueue: a WooCommerce operation is decided here, and a shadow writes no row. Every WooCommerce stock and order-status job is made by it.',
  },
  {
    file: 'lib/connectors/woocommerce/sync/stock-sync.ts', decl: 'pushStockToWc', role: 'producer',
    mustCall: ['wooProducerSeam'], beforeCalls: ['snapshotSyncContext'],
    operations: ['stock'],
    why: 'The one stock writer: the queue drain, the daily reconcile, the manual push and a webhook correction all reach WooCommerce through it, so asking here covers the paths below the enqueue.',
  },
  {
    file: 'lib/connectors/woocommerce/sync/stock-sync-jobs.ts', decl: 'processQueuedWcStockSyncJobs', role: 'drain',
    mustCall: ['wooDrainHold'], beforeCalls: ['migrateLegacyWcStockSyncJobs', 'claimIntegrationOutboxWork'],
    operations: [],
    why: 'Claim boundary of the stock queue: a held destination claims nothing, migrates nothing and spends no attempt.',
  },
  {
    file: 'lib/connectors/woocommerce/sync/order-completion-jobs.ts', decl: 'processWcOrderCompletionJobs', role: 'drain',
    mustCall: ['wooDrainHold'], beforeCalls: ['claimIntegrationOutboxWork'],
    operations: [],
    why: 'Claim boundary of the order-completion queue.',
  },
  {
    file: 'lib/connectors/woocommerce/sync/order-status-jobs.ts', decl: 'runFencedWcOrderJob', role: 'drain',
    mustCall: ['wooDrainHold'], beforeCalls: ['claimIntegrationOutboxWork'],
    operations: [],
    why: 'Claim boundary of the order cancel and hold queues.',
  },
  {
    file: 'lib/connectors/woocommerce/api.ts', decl: 'wcPost', role: 'transport-barrier',
    mustCall: ['wooEgressHold'], beforeCalls: ['connectorFetch'],
    operations: [],
    why: 'The last barrier in front of every WooCommerce REST POST.',
  },
  {
    file: 'lib/connectors/woocommerce/api.ts', decl: 'wcPut', role: 'transport-barrier',
    mustCall: ['wooEgressHold'], beforeCalls: ['connectorFetch'],
    operations: [],
    why: 'The last barrier in front of every WooCommerce REST PUT.',
  },
  {
    file: 'lib/connectors/woocommerce/fx-rates.ts', decl: 'pushFxRatesToWc', role: 'transport-barrier',
    mustCall: ['wooEgressHold'], beforeCalls: ['connectorFetch'],
    operations: [],
    why: 'The last barrier in front of the FX-rate POST to the helper plugin.',
  },
  {
    file: 'lib/connectors/woocommerce/fx-rates.ts', decl: 'probeFxHelperPlugin', role: 'transport-barrier',
    mustCall: ['wooEgressHold'], beforeCalls: ['connectorFetch'],
    operations: [],
    why: 'The last barrier in front of the FX helper probe, which is a POST.',
  },
  {
    file: 'lib/connectors/woocommerce/sync/partial-shipment.ts', decl: 'pushPartialShipmentToWc', role: 'transport-barrier',
    mustCall: ['wooEgressHold'], beforeCalls: ['connectorFetch'],
    operations: [],
    why: 'The last barrier in front of the partial-shipment POST to the helper plugin.',
  },
  {
    file: 'lib/connectors/woocommerce/sync/reconcile.ts', decl: 'runWcReconcile', role: 'stamp-guard',
    mustCall: ['pushStockToWc'], beforeCalls: [],
    operations: [],
    why: 'The daily stock reconcile must not stamp last_wc_stock_daily_reconcile_at for a push the hold shadowed (checked by WOO-1b below).',
  },
  {
    file: 'lib/domain/accounting/sync-log-row.ts', decl: 'createAccountingSyncLogRow', role: 'sync-log-seam',
    mustCall: ['xeroProducerSeamVerdict'], beforeCalls: ['create'],
    operations: ['order.invoice-note'],
    why: 'The invoice note is a sync-log type whose destination is WooCommerce: it follows the WooCommerce setting at the one sync-log primitive.',
  },
]

/**
 * WooCommerce ownership-map operations that are governed by something other than a function above or a declared 'seam' site. Each
 * needs the reason; an entry that no longer matches a map row is red.
 */
export const WOO_OPERATIONS_GOVERNED_ELSEWHERE: Readonly<Record<string, string>> = {
  'order.withdrawal-outcome': 'No IMS producer exists: the endpoint stays in the WooCommerce withdrawal plugin (producer census NO_PRODUCER).',
  'order.trackship-reconcile': 'No IMS producer exists: the endpoint stays in the TrackShip plugin (producer census NO_PRODUCER).',
  'order.invoice-document': 'No IMS producer exists yet: the My Account invoice is a later build (producer census NO_PRODUCER).',
  'tax-rate': 'No IMS producer exists yet: P1 is the owner correcting WooCommerce by hand from the VAT difference report (producer census NO_PRODUCER).',
}

export const SOURCE_ROOTS = ['app', 'lib', 'scripts', 'components'] as const
const SKIPPED = new Set(['node_modules', '.next', 'generated', 'archive'])

export function walk(dir: string, out: string[] = []): string[] {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) { if (!SKIPPED.has(entry.name)) walk(p, out) }
    else if (['.ts', '.tsx'].includes(extname(entry.name)) && !entry.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

export function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
}

export function unwrap(n: ts.Node): ts.Node {
  let x = n
  while (ts.isParenthesizedExpression(x) || ts.isNonNullExpression(x) || ts.isAsExpression(x) || ts.isAwaitExpression(x)) x = x.expression
  return x
}

export function calleeName(call: ts.CallExpression): string | null {
  const e = unwrap(call.expression)
  if (ts.isIdentifier(e)) return e.text
  if (ts.isPropertyAccessExpression(e)) return e.name.text
  return null
}

/** The top-level declaration of this name, or null. */
export function findTopLevel(sf: ts.SourceFile, name: string): ts.Node | null {
  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (declaration.name.getText(sf) === name) return statement
      }
    }
  }
  return null
}

export function topLevelNameOf(node: ts.Node, sf: ts.SourceFile): string {
  let n: ts.Node = node
  while (n.parent && n.parent !== sf) n = n.parent
  if (ts.isFunctionDeclaration(n)) return n.name?.text ?? '<anonymous>'
  if (ts.isVariableStatement(n)) {
    let m: ts.Node = node
    while (m.parent && !ts.isVariableDeclaration(m)) m = m.parent
    if (ts.isVariableDeclaration(m)) return m.name.getText(sf)
    return n.declarationList.declarations.map((d) => d.name.getText(sf)).join('+')
  }
  return '<module>'
}

export type CallInfo = { name: string; pos: number }
export function callsIn(node: ts.Node, sf: ts.SourceFile): CallInfo[] {
  const out: CallInfo[] = []
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const name = calleeName(n)
      if (name) out.push({ name, pos: n.getStart(sf) })
    }
    ts.forEachChild(n, visit)
  }
  visit(node)
  return out
}

// ───────────────────────── WOO-5: the outbox registry, read as syntax ─────────────────────────

export const OUTBOX_REGISTRY_FILE = 'lib/domain/integrations/outbox-registry.ts'
export const OUTBOX_DESTINATIONS: readonly string[] = ['woocommerce', 'mintsoft', 'xero', 'internal']

/**
 * `INTEGRATION_OUTBOX_REGISTRY = defineOutboxRegistry({ <connector>: { '<operation>': { name, destination, ... } } })`, read by syntax:
 * connector -> operation -> its `destination` string literal (absent when the entry does not carry a literal one).
 */
export function scanOutboxRegistrySource(text: string): Record<string, Record<string, { destination?: string }>> {
  const sf = parse(OUTBOX_REGISTRY_FILE, text)
  const out: Record<string, Record<string, { destination?: string }>> = {}
  const keyOf = (name: ts.PropertyName): string | null => (ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null)
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'INTEGRATION_OUTBOX_REGISTRY' && n.initializer) {
      const call = unwrap(n.initializer)
      const arg = ts.isCallExpression(call) ? call.arguments[0] : undefined
      const connectors = arg ? unwrap(arg) : undefined
      if (connectors && ts.isObjectLiteralExpression(connectors)) {
        for (const connector of connectors.properties) {
          if (!ts.isPropertyAssignment(connector)) continue
          const connectorName = keyOf(connector.name)
          const operations = unwrap(connector.initializer)
          if (connectorName === null || !ts.isObjectLiteralExpression(operations)) continue
          out[connectorName] = {}
          for (const operation of operations.properties) {
            if (!ts.isPropertyAssignment(operation)) continue
            const operationName = keyOf(operation.name)
            const entry = unwrap(operation.initializer)
            if (operationName === null || !ts.isObjectLiteralExpression(entry)) continue
            const destination = objectProperty(entry, 'destination')
            const value = destination && ts.isPropertyAssignment(destination) ? literalString(destination.initializer) : null
            out[connectorName]![operationName] = value === null ? {} : { destination: value }
          }
        }
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

// ───────────────────────── WOO-3: the raw transport scan ─────────────────────────

export type WooTransportSite = {
  file: string
  line: number
  decl: string
  callee: string
  method: string
  write: boolean
}

export function literalString(n: ts.Expression | undefined): string | null {
  if (!n) return null
  const x = unwrap(n)
  return ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x) ? x.text : null
}

export function objectProperty(obj: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralElementLike | undefined {
  return obj.properties.find((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && ts.isIdentifier(p.name) && p.name.text === name)
}

/** Every `connectorFetch(…)` / `fetch(…)` call aimed at WooCommerce in this file, with its method. */
export function scanWooTransportSource(text: string, file: string): WooTransportSite[] {
  if (!text.includes('WooCommerce') && !text.includes('wp-json')) return []
  const sf = parse(file, text)
  const sites: WooTransportSite[] = []
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const name = calleeName(n)
      if (name === 'connectorFetch' || name === 'fetch') {
        const [urlArg, initArg, optionsArg] = n.arguments
        const urlText = urlArg ? urlArg.getText(sf) : ''
        let aimed = urlText.includes('wp-json')
        if (optionsArg && ts.isObjectLiteralExpression(unwrap(optionsArg) as ts.Expression)) {
          const prop = objectProperty(unwrap(optionsArg) as ts.ObjectLiteralExpression, 'connectorName')
          if (prop && ts.isPropertyAssignment(prop) && literalString(prop.initializer) === 'WooCommerce') aimed = true
        }
        if (aimed) {
          let method = 'GET'
          let write = false
          if (initArg) {
            const init = unwrap(initArg)
            if (ts.isObjectLiteralExpression(init)) {
              const prop = objectProperty(init, 'method')
              if (prop) {
                const value = ts.isPropertyAssignment(prop) ? literalString(prop.initializer) : null
                method = value === null ? 'UNKNOWN' : value.toUpperCase()
              }
            } else {
              method = 'UNKNOWN'
            }
          }
          write = method !== 'GET' && method !== 'HEAD'
          sites.push({ file, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, decl: topLevelNameOf(n, sf), callee: name, method, write })
        }
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return sites
}

export function scanWooTransport(root: string): { sites: WooTransportSite[]; filesScanned: number } {
  const files = SOURCE_ROOTS.flatMap((r) => walk(join(root, r)))
  const sites: WooTransportSite[] = []
  for (const abs of files) {
    const rel = relative(root, abs).split('\\').join('/')
    sites.push(...scanWooTransportSource(readFileSync(abs, 'utf8'), rel))
  }
  return { sites, filesScanned: files.length }
}

// ───────────────────────── the findings ─────────────────────────

export type WooCensusInput = {
  readSource: (file: string) => string | undefined
  transport: readonly WooTransportSite[]
  /** The producer census's declarations and sites (keys), for WOO-2 and WOO-4. */
  declarations: readonly Declaration[]
  siteKeys: ReadonlySet<string>
  noProducer: Readonly<Record<string, string>>
  seamFunctions?: readonly WooSeamFunction[]
  map?: readonly OwnershipRow[]
  registry?: Record<string, Record<string, { destination?: string }>>
  governedElsewhere?: Readonly<Record<string, string>>
}

export type WooCensusCounts = {
  seamFunctions: number
  seamFunctionsConsulting: number
  transportSites: number
  transportWrites: number
  transportWritesBehindBarrier: number
  outboxEnqueueSites: number
  outboxEnqueueSitesHandlingShadow: number
  mapOperations: number
  mapOperationsGoverned: number
  registryEntries: number
}

export function wooCensusFindings(input: WooCensusInput): { failures: string[]; counts: WooCensusCounts } {
  const failures: string[] = []
  const seamFunctions = input.seamFunctions ?? WOO_SEAM_FUNCTIONS
  const map = (input.map ?? (WRITER_OWNERSHIP_MAP as readonly OwnershipRow[])).filter((row) => row.destination === 'woocommerce')
  // The registry is read as SYNTAX (not imported): the producer-census CI job has no generated Prisma client, and the registry module
  // imports its enums.
  const registryText = input.readSource(OUTBOX_REGISTRY_FILE)
  const registry = input.registry ?? (registryText === undefined ? null : scanOutboxRegistrySource(registryText))
  if (registry === null) failures.push(`WOO-5 ${OUTBOX_REGISTRY_FILE} could not be read, so the outbox registry destinations cannot be checked.`)
  const governedElsewhere = input.governedElsewhere ?? WOO_OPERATIONS_GOVERNED_ELSEWHERE
  const counts: WooCensusCounts = {
    seamFunctions: 0, seamFunctionsConsulting: 0, transportSites: input.transport.length, transportWrites: 0, transportWritesBehindBarrier: 0,
    outboxEnqueueSites: 0, outboxEnqueueSitesHandlingShadow: 0, mapOperations: map.length, mapOperationsGoverned: 0, registryEntries: 0,
  }
  const parsed = new Map<string, ts.SourceFile | null>()
  const sourceFile = (file: string): ts.SourceFile | null => {
    if (!parsed.has(file)) {
      const text = input.readSource(file)
      parsed.set(file, text === undefined ? null : parse(file, text))
    }
    return parsed.get(file) ?? null
  }

  // ---- WOO-1 ----
  const seamKeys = new Set<string>()
  for (const fn of seamFunctions) {
    counts.seamFunctions++
    seamKeys.add(`${fn.file}::${fn.decl}`)
    const sf = sourceFile(fn.file)
    if (!sf) { failures.push(`WOO-1 ${fn.file}::${fn.decl}: the file could not be read. A seam function that moved must have its row in WOO_SEAM_FUNCTIONS (scripts/producer-census-woocommerce.ts) updated.`); continue }
    const node = findTopLevel(sf, fn.decl)
    if (!node) { failures.push(`WOO-1 ${fn.file}::${fn.decl} (${fn.role}) no longer exists. Update WOO_SEAM_FUNCTIONS if it was renamed or moved; do not delete the row if the duty moved with it.`); continue }
    const calls = callsIn(node, sf)
    const consult = calls.filter((call) => fn.mustCall.includes(call.name))
    if (consult.length === 0) {
      failures.push(`WOO-1 ${fn.file}::${fn.decl} (${fn.role}) calls none of ${fn.mustCall.join(', ')}. ${fn.why}`)
      continue
    }
    const firstConsult = Math.min(...consult.map((call) => call.pos))
    const effects = calls.filter((call) => fn.beforeCalls.includes(call.name))
    const firstEffect = effects.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...effects.map((call) => call.pos))
    if (fn.beforeCalls.length > 0 && effects.length === 0) {
      failures.push(`WOO-1 ${fn.file}::${fn.decl} (${fn.role}) never calls ${fn.beforeCalls.join(' or ')}, the effect its consultation must precede. The row is stale or the function changed shape: ${fn.why}`)
      continue
    }
    if (firstConsult > firstEffect) {
      failures.push(`WOO-1 ${fn.file}::${fn.decl} (${fn.role}) consults ${fn.mustCall.join('/')} AFTER its first effect (${fn.beforeCalls.join('/')}). The consultation must come first. ${fn.why}`)
      continue
    }
    counts.seamFunctionsConsulting++
    // WOO-1b: the stamp guard reads `.shadowed` of the stock push before it writes the daily stamp.
    if (fn.role === 'stamp-guard') {
      const push = calls.find((call) => call.name === 'pushStockToWc')
      const shadowReads: number[] = []
      const stamps: number[] = []
      const visit = (n: ts.Node) => {
        if (ts.isPropertyAccessExpression(n) && n.name.text === 'shadowed') shadowReads.push(n.name.getStart(sf))
        if (ts.isStringLiteral(n) && n.text === 'last_wc_stock_daily_reconcile_at') stamps.push(n.getStart(sf))
        ts.forEachChild(n, visit)
      }
      visit(node)
      const firstStamp = push ? Math.min(...stamps.filter((pos) => pos > push.pos), Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY
      if (!push || firstStamp === Number.POSITIVE_INFINITY) {
        failures.push(`WOO-1b ${fn.file}::${fn.decl} no longer stamps last_wc_stock_daily_reconcile_at after pushStockToWc, so the guard has nothing to guard. Update the row if the stamp moved.`)
      } else if (!shadowReads.some((pos) => pos > push.pos && pos < firstStamp)) {
        failures.push(`WOO-1b ${fn.file}::${fn.decl} writes last_wc_stock_daily_reconcile_at without reading \`.shadowed\` of the stock push first. A shadowed push reconciled nothing; stamping it would tell the live phase's first run that stock was just reconciled.`)
      }
    }
  }

  // ---- WOO-2 ----
  for (const declaration of input.declarations) {
    if (declaration.destination !== 'woocommerce' || !/::enqueueIntegrationOutbox#\d+$/.test(declaration.key)) continue
    if (!input.siteKeys.has(declaration.key)) continue
    counts.outboxEnqueueSites++
    const [file, decl] = declaration.key.split('::')
    const sf = sourceFile(file!)
    const node = sf ? findTopLevel(sf, decl!) : null
    if (!sf || !node) { failures.push(`WOO-2 ${declaration.key}: the declaring function could not be found to check its shadow handling.`); continue }
    const calls = callsIn(node, sf)
    const enqueue = calls.filter((call) => call.name === 'enqueueIntegrationOutbox')
    const handled = calls.some((call) => call.name === 'isOutboxEnqueueShadowed' && enqueue.some((e) => e.pos < call.pos))
    if (handled) counts.outboxEnqueueSitesHandlingShadow++
    else failures.push(`WOO-2 ${declaration.key} enqueues a WooCommerce outbox job but ${decl} never calls isOutboxEnqueueShadowed after it. A shadow has no row; a caller that reads it as queued work is the defect the shadow outcome exists to prevent.`)
  }

  // ---- WOO-3 ----
  const barrierRows = new Map(seamFunctions.filter((fn) => fn.role === 'transport-barrier').map((fn) => [`${fn.file}::${fn.decl}`, fn]))
  const barrierSeen = new Set<string>()
  for (const site of input.transport) {
    if (!site.write) continue
    counts.transportWrites++
    const key = `${site.file}::${site.decl}`
    if (barrierRows.has(key)) { barrierSeen.add(key); counts.transportWritesBehindBarrier++; continue }
    failures.push(`WOO-3 ${site.file}:${site.line} (${site.decl}) calls ${site.callee} on WooCommerce with method ${site.method} and is not a listed transport barrier. `
      + 'A WooCommerce write must sit in a function that calls wooEgressHold first: add the call and a transport-barrier row in WOO_SEAM_FUNCTIONS (scripts/producer-census-woocommerce.ts), or route the write through wcPost / wcPut.')
  }
  for (const key of barrierRows.keys()) {
    if (!barrierSeen.has(key)) failures.push(`WOO-3 the transport-barrier row ${key} matches no WooCommerce write call. Delete the row, or fix it if the write moved.`)
  }

  // ---- WOO-4 ----
  const governed = new Set<string>()
  for (const fn of seamFunctions) for (const op of fn.operations) governed.add(op)
  for (const declaration of input.declarations) {
    if (declaration.destination === 'woocommerce' && declaration.mechanism === 'seam' && input.siteKeys.has(declaration.key)) governed.add(declaration.operation)
  }
  for (const row of map) {
    const pair = `woocommerce.${row.operation}`
    const elsewhere = Object.prototype.hasOwnProperty.call(governedElsewhere, row.operation)
    const noProducer = Object.prototype.hasOwnProperty.call(input.noProducer, pair)
    if (governed.has(row.operation)) {
      counts.mapOperationsGoverned++
      if (elsewhere) failures.push(`WOO-4 woocommerce.${row.operation} is both governed by a seam and listed in WOO_OPERATIONS_GOVERNED_ELSEWHERE. Remove the stale entry.`)
    } else if (elsewhere && noProducer) {
      counts.mapOperationsGoverned++
    } else {
      failures.push(`WOO-4 the ownership-map operation woocommerce.${row.operation} is governed by no seam: no 'seam' declaration, no WOO_SEAM_FUNCTIONS row lists it, and it is not an explicit no-producer operation. `
        + 'A WooCommerce operation nothing asks the hold about is a writer that bypasses it.')
    }
  }
  for (const op of Object.keys(governedElsewhere)) {
    if (!map.some((row) => row.operation === op)) failures.push(`WOO-4 WOO_OPERATIONS_GOVERNED_ELSEWHERE["${op}"] is not an operation of the ownership map. Delete it.`)
  }

  // ---- WOO-5 ----
  for (const [connector, operations] of Object.entries(registry ?? {})) {
    for (const [operation, entry] of Object.entries(operations)) {
      counts.registryEntries++
      const destination = entry.destination
      if (typeof destination !== 'string') { failures.push(`WOO-5 outbox ${connector}/${operation} has no destination. Say where its effect lands (woocommerce, mintsoft, xero or internal).`); continue }
      if (!OUTBOX_DESTINATIONS.includes(destination)) {
        failures.push(`WOO-5 outbox ${connector}/${operation} has destination "${destination}", which is not one of ${OUTBOX_DESTINATIONS.join(', ')}.`)
        continue
      }
      if (destination === 'woocommerce' || destination === 'mintsoft') {
        const target = ownershipTargetForOutboxOperation(`${connector}/${operation}`)
        if (!target || target.destination !== destination) {
          failures.push(`WOO-5 outbox ${connector}/${operation} lands on ${destination} but no ownership-map row names it in outboxOperations, so the enqueue seam can only shadow it as unmapped. Add it to the map row it carries.`)
        }
      }
    }
  }

  return { failures, counts }
}

export function runWooCensus(root: string, declarations: readonly Declaration[], siteKeys: ReadonlySet<string>, noProducer: Readonly<Record<string, string>>) {
  const transport = scanWooTransport(root)
  const cache = new Map<string, string | undefined>()
  const readSource = (file: string): string | undefined => {
    if (!cache.has(file)) {
      try { cache.set(file, readFileSync(join(root, file), 'utf8')) } catch { cache.set(file, undefined) }
    }
    return cache.get(file)
  }
  return { transport, ...wooCensusFindings({ readSource, transport: transport.sites, declarations, siteKeys, noProducer }) }
}

export function formatWooCounts(counts: WooCensusCounts): string {
  return `producer census (WooCommerce): ${counts.seamFunctionsConsulting}/${counts.seamFunctions} seam functions consult the hold before their first effect; `
    + `${counts.transportWritesBehindBarrier}/${counts.transportWrites} raw WooCommerce transport writes (of ${counts.transportSites} transport calls) sit behind the egress barrier; `
    + `${counts.outboxEnqueueSitesHandlingShadow}/${counts.outboxEnqueueSites} outbox enqueue sites handle the shadow answer; `
    + `${counts.mapOperationsGoverned}/${counts.mapOperations} WooCommerce ownership operations are governed; ${counts.registryEntries} outbox registry entries carry a destination`
}
