/**
 * THE SHADOW-READER CENSUS: EVERY PLACE THAT READS THE PRESENCE OF A SYNC ROW, AN OUTBOX ROW, A WAREHOUSE LINK OR A SYNC LOG
 * AS A STATEMENT ABOUT WHAT WAS SENT, WHAT IS PENDING, WHAT IS DONE OR WHAT FAILED.
 *
 * Why it exists. With the producer-side hold enforced for a destination (PRODUCER_HOLD_ENFORCED_DESTINATIONS), work that would have
 * been queued is recorded as a SHADOW instead, and a shadow is not a queued, a sent or a failed outcome:
 *
 *   Xero         a CANCELLED accounting sync row with settlement basis HELD_SHADOW, no document id, no outbox job, no accounting event.
 *   WooCommerce  no outbox job, no stock-sync state change, no stamp; only an outbound_shadow_writes record.
 *   Mintsoft     no push link, no product/bundle link, no ASN reservation, no stamp; only an outbound_shadow_writes record.
 *
 * Every consumer that decides from the PRESENCE (or the ABSENCE) of such a row is therefore a place where a shadow can be misread
 * as "sent", "pending", "failed" or "missing". The sites are found by syntax tree, never by a list written by hand, and each is
 * declared in scripts/shadow-reader-declarations.ts with a class and a reason.
 *
 * What a site is, per family (a READ only; the writers have their own censuses):
 *   ledger        a read of the accounting sync log: a delegate call that is not a write, a raw statement that reads the table, or any
 *                 reference to the delegate that is not the receiver of a write.
 *   outbox        the same for the integration outbox.
 *   pushLink      the same for the warehouse order push link, plus the `wmsOrderPush` relation named in a query or read off a row.
 *   wmsLink       the same for the warehouse product link, bundle link and ASN reservation tables, plus their relations.
 *   stockState    the same for the stock-sync state and job tables, plus their relations.
 *   shopLog       the same for the shopping (storefront) sync log.
 *   shadowRecord  a raw statement over the durable shadow table.
 *   batchStamp    a read of an order column the daily batch stamps (the batch dates and references), including a stamp stamped for a
 *                 shadowed batch: the stamp is written whether or not the journal was queued, so its presence says "batched", not "posted".
 *
 * Reconciliation is universal in both directions (see the test): a site found and not declared is red; a declaration no site
 * matches is red; a declared site whose count moved is red.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import ts from 'typescript'

export const SOURCE_ROOTS = ['app', 'lib', 'scripts', 'components'] as const
const SKIPPED = new Set(['node_modules', '.next', 'generated', 'archive'])

export const FAMILIES = ['ledger', 'outbox', 'pushLink', 'wmsLink', 'stockState', 'shopLog', 'shadowRecord', 'batchStamp'] as const
export type Family = (typeof FAMILIES)[number]

/** Prisma delegate names (the property after the client) and raw table names, per family. */
const DELEGATES: Record<Exclude<Family, 'batchStamp'>, readonly string[]> = {
  ledger: ['accountingSyncLog'],
  outbox: ['integrationOutbox'],
  pushLink: ['wmsOrderPushLink'],
  wmsLink: ['wmsProductLink', 'wmsBundleLink', 'wmsAsnMap', 'wmsAsnLineMap'],
  stockState: ['stockSyncState', 'stockSyncJob'],
  shopLog: ['shoppingSyncLog'],
  shadowRecord: ['outboundShadowWrite'],
}
const TABLES: Record<Exclude<Family, 'batchStamp'>, readonly string[]> = {
  ledger: ['accounting_sync_logs'],
  outbox: ['integration_outbox'],
  pushLink: ['wms_order_push_links'],
  wmsLink: ['wms_product_links', 'wms_bundle_links', 'wms_asn_maps', 'wms_asn_line_maps'],
  stockState: ['stock_sync_states', 'stock_sync_jobs'],
  shopLog: ['shopping_sync_logs'],
  shadowRecord: ['outbound_shadow_writes'],
}
/** Relation fields on other models that reach the same rows. */
const RELATIONS: Partial<Record<Family, readonly string[]>> = {
  pushLink: ['wmsOrderPush'],
  wmsLink: ['wmsProductLinks', 'wmsBundleLinks'],
  stockState: ['stockSyncStates', 'stockSyncJobs'],
}
/** The order columns the daily batch stamps. */
const BATCH_STAMP_COLUMNS = ['revenueDeferredDate', 'inventoryAllocatedDate', 'revenueDeferredBatchRef', 'allocationBatchSyncLogId'] as const
const BATCH_STAMP_SQL = ['accounting_revenue_deferred_date', 'accounting_inventory_allocated_date', 'accounting_revenue_deferred_batch_ref', 'accounting_allocation_batch_sync_log_id']

const WRITE_METHODS = new Set(['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'updateManyAndReturn', 'upsert', 'delete', 'deleteMany'])
const DATA_KEYS = new Set(['data', 'create', 'update', 'set'])
const READ_SQL_RE = /\b(SELECT|FROM|JOIN|EXISTS|USING)\b/i

export type Site = { key: string; family: Family; file: string; fn: string; count: number; line: number }

export function walk(dir: string, out: string[] = []): string[] {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) { if (!SKIPPED.has(entry.name)) walk(p, out) }
    else if (['.ts', '.tsx', '.mts'].includes(extname(entry.name)) && !entry.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

function enclosingName(node: ts.Node): string {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if ((ts.isFunctionDeclaration(cur) || ts.isMethodDeclaration(cur)) && cur.name) return cur.name.getText()
    if (ts.isVariableDeclaration(cur) && cur.initializer && (ts.isArrowFunction(cur.initializer) || ts.isFunctionExpression(cur.initializer))) return cur.name.getText()
  }
  return '<module>'
}

function insideDataKey(node: ts.Node): boolean {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (ts.isPropertyAssignment(cur) && DATA_KEYS.has(cur.name.getText())) return true
    if (ts.isCallExpression(cur) || ts.isFunctionLike(cur)) return false
  }
  return false
}

/** True when `access` (`x.delegate`) is the receiver of a write method call: `x.delegate.update(...)`. */
function isWriteReceiver(access: ts.PropertyAccessExpression): boolean {
  const parent = access.parent
  return ts.isPropertyAccessExpression(parent) && parent.expression === access && ts.isCallExpression(parent.parent) && parent.parent.expression === parent && WRITE_METHODS.has(parent.name.text)
}

export function scanSource(text: string, rel: string): Site[] {
  const found = new Map<string, Site>()
  const add = (family: Family, node: ts.Node, sf: ts.SourceFile): void => {
    const fn = enclosingName(node)
    const key = `${family}::${rel}::${fn}`
    const existing = found.get(key)
    if (existing) existing.count += 1
    else found.set(key, { key, family, file: rel, fn, count: 1, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 })
  }
  const mentions = (needle: readonly string[]) => needle.some((word) => text.includes(word))
  const everything = [...Object.values(DELEGATES).flat(), ...Object.values(TABLES).flat(), ...Object.values(RELATIONS).flat(), ...BATCH_STAMP_COLUMNS, ...BATCH_STAMP_SQL]
  if (!mentions(everything)) return []
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const families = Object.keys(DELEGATES) as Array<Exclude<Family, 'batchStamp'>>

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) {
      const name = node.name.text
      for (const family of families) {
        if (DELEGATES[family].includes(name) && !isWriteReceiver(node)) add(family, node, sf)
        else if (RELATIONS[family]?.includes(name)) add(family, node, sf)
      }
      if ((BATCH_STAMP_COLUMNS as readonly string[]).includes(name) && !insideDataKey(node)) add('batchStamp', node, sf)
    }
    if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
      const name = node.name.getText()
      for (const family of families) if (RELATIONS[family]?.includes(name) && !insideDataKey(node)) add(family, node, sf)
      if ((BATCH_STAMP_COLUMNS as readonly string[]).includes(name) && !insideDataKey(node)) add('batchStamp', node, sf)
    }
    if (ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node) || (ts.isStringLiteral(node) && node.text.length > 30)) {
      const raw = node.getText()
      if (READ_SQL_RE.test(raw)) {
        let hit = false
        for (const family of families) {
          if (TABLES[family].some((table) => new RegExp(`\\b${table}\\b`).test(raw))) { add(family, node, sf); hit = true }
        }
        if (BATCH_STAMP_SQL.some((column) => new RegExp(`\\b${column}\\b`).test(raw))) { add('batchStamp', node, sf); hit = true }
        // A matched statement is one site: do not count the templates nested in its substitutions again.
        if (hit && !ts.isStringLiteral(node)) return
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return [...found.values()]
}

export type Scan = { sites: Site[]; filesScanned: number }

export function scanTree(root: string): Scan {
  const files = SOURCE_ROOTS.flatMap((dir) => walk(join(root, dir)))
  const merged = new Map<string, Site>()
  for (const abs of files) {
    const rel = relative(root, abs).split('\\').join('/')
    for (const site of scanSource(readFileSync(abs, 'utf8'), rel)) merged.set(site.key, site)
  }
  return { sites: [...merged.values()].sort((a, b) => a.key.localeCompare(b.key)), filesScanned: files.length }
}

// ───────────────────────── declarations and the reconciliation ─────────────────────────

/**
 * How a site reads a shadow.
 *
 *   SHADOW_AWARE      reads a shadow as its own state (HELD_SHADOW, the durable record, `shadowed`) and says so, or leaves it out of a
 *                     question it cannot answer. The reason names the code that does it.
 *   SHADOW_NEUTRAL    a shadow cannot reach this site, or reaching it changes nothing it decides. The reason names WHY, in one of the
 *                     closed forms below (REASONS).
 *   FIXED             this change made the site shadow-aware. The reason names what it was doing wrong and what it does now.
 *   OPEN_FINDING      the site misreports or acts wrongly under a shadow and is NOT fixed here. The reason says what goes wrong; docs/installation.md
 *                     lists every open finding. The test pins the number, so a finding cannot be added or silently closed without this file moving.
 */
export const CLASSES = ['SHADOW_AWARE', 'SHADOW_NEUTRAL', 'FIXED', 'OPEN_FINDING'] as const
export type ReaderClass = (typeof CLASSES)[number]

/**
 * The closed forms of "neutral". A neutral declaration names ONE of them, so "neutral" cannot be a shrug:
 *
 *   status-excludes      the query's status filter cannot admit a shadow (a shadow is CANCELLED / absent, and this asks for live work).
 *   claim-side           a claim or a drain of queued work: a shadow is never claimable and the destination hold stands down the drain.
 *   keyed-by-id          reads one row by an id it was given, or a row family a shadow is never a member of.
 *   inbound              reads state written by inbound traffic (a webhook, an import, a callback), which a shadow never produces.
 *   existence-by-design  asks whether a record exists to dedupe or to refuse, and a shadow occupying the slot is the intended answer.
 *   absence-irrelevant   the absence of a row (the shadow leaves none) does not change what it decides.
 *   write-only-check     reads only to fence its own write on a value it observed.
 *   test-support         a fixture, a seed or a harness: not a product reader.
 */
export const NEUTRAL_FORMS = ['status-excludes', 'claim-side', 'keyed-by-id', 'inbound', 'existence-by-design', 'absence-irrelevant', 'write-only-check', 'test-support'] as const
export type NeutralForm = (typeof NEUTRAL_FORMS)[number]

export type Declaration = {
  /** `family::file::enclosing function` */
  key: string
  count: number
  class: ReaderClass
  /** Required for SHADOW_NEUTRAL: which closed form. */
  form?: NeutralForm
  reason: string
}

export type Report = { undeclared: Site[]; stale: string[]; moved: Array<{ key: string; declared: number; found: number }>; malformed: string[] }

export function reconcile(sites: readonly Site[], declarations: readonly Declaration[]): Report {
  const declared = new Map<string, Declaration>()
  const malformed: string[] = []
  for (const declaration of declarations) {
    if (declared.has(declaration.key)) malformed.push(`${declaration.key}: declared twice`)
    declared.set(declaration.key, declaration)
    if (!(CLASSES as readonly string[]).includes(declaration.class)) malformed.push(`${declaration.key}: unknown class ${String(declaration.class)}`)
    if (declaration.class === 'SHADOW_NEUTRAL' && !(NEUTRAL_FORMS as readonly string[]).includes(declaration.form ?? '')) malformed.push(`${declaration.key}: neutral without a closed form`)
    if (declaration.class !== 'SHADOW_NEUTRAL' && declaration.form !== undefined) malformed.push(`${declaration.key}: a form is only for neutral`)
    if (declaration.reason.trim().length < 20) malformed.push(`${declaration.key}: reason too short`)
    if (!Number.isInteger(declaration.count) || declaration.count < 1) malformed.push(`${declaration.key}: bad count`)
  }
  const found = new Map(sites.map((site) => [site.key, site]))
  return {
    undeclared: sites.filter((site) => !declared.has(site.key)),
    stale: [...declared.keys()].filter((key) => !found.has(key)),
    moved: sites.flatMap((site) => {
      const declaration = declared.get(site.key)
      return declaration && declaration.count !== site.count ? [{ key: site.key, declared: declaration.count, found: site.count }] : []
    }),
    malformed,
  }
}

// ───────────────────────── the guard's own preconditions ─────────────────────────

/** A scan that reaches fewer files, or fewer sites of a family this tree is known to contain, has not reached its subject. */
export const MIN_FILES = 800
export const MIN_SITES_BY_FAMILY: Record<string, number> = {
  ledger: 40, outbox: 8, pushLink: 15, wmsLink: 15, stockState: 2, shopLog: 10, shadowRecord: 2, batchStamp: 15,
}

export function summarise(scan: Scan, declarations: readonly Declaration[]): string {
  const sitesByFamily: Record<string, number> = {}
  for (const site of scan.sites) sitesByFamily[site.family] = (sitesByFamily[site.family] ?? 0) + 1
  const byClass: Record<string, number> = {}
  for (const declaration of declarations) byClass[declaration.class] = (byClass[declaration.class] ?? 0) + 1
  return `shadow-reader census: ${scan.filesScanned} files, ${scan.sites.length} sites ${JSON.stringify(sitesByFamily)}; declared ${declarations.length} ${JSON.stringify(byClass)}`
}
