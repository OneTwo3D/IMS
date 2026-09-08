import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { mock } from 'node:test'
import ts from 'typescript'

/**
 * o3d-potv: `wc_sync_interval_minutes` was an editable "Polling interval (minutes)" number
 * input on Settings -> Sync -> WooCommerce that NOTHING read.
 *
 * The real cadence is the `wc-reconcile` cron schedule (lib/cron-jobs/woocommerce.ts,
 * defaultSchedule `0 4 * * *`), edited in Settings -> System -> Scheduler. An operator who
 * set the interval to 5 minutes after a webhook outage got a DAILY 04:00 reconcile and was
 * never told.
 *
 * WHY REMOVED RATHER THAN WIRED UP. The cadence is genuinely owned by the cron registry: the
 * schedule is a cron expression stored as `cron_wc_reconcile_schedule`, with its own enable
 * flag and crontab sync. Driving that from a second minutes field would give ONE fact TWO
 * writers with no defined precedence — and the job it would have to drive does far more than
 * poll orders (held sales-invoice releases, the product poll, the stock reconcile), so an
 * "order polling interval" cannot express its cadence anyway. One control, one place.
 *
 * ROUND 2 — WHY THESE ASSERTIONS ARE NOT ABOUT `wc_sync_interval_minutes`.
 *
 * Round 1 asserted the ABSENCE OF ONE IDENTIFIER: no `s.wc_sync_interval_minutes` binding, no
 * `wc_sync_interval_minutes:` write, no "Polling interval (minutes)" label. Codex's finding is
 * that this permits a partial resurrection: recreate the same editable no-op as
 * `wc_poll_every_minutes` and every assertion still passes. A name is a proxy. The fact worth
 * defending is a CATEGORY — *an editable control that sets a WooCommerce polling cadence lives
 * on this page* — and a guard written against one member of the category is one rename from
 * vacuous.
 *
 * So the rule is quantified over the category instead of enumerating instances:
 *
 *   - the settings the page is HANDED contain no cadence-named field, whatever it is called;
 *   - a save PERSISTS no cadence-named key, whatever it is called;
 *   - EVERY editable control the page renders is examined (parsed out of the TSX, not grepped),
 *     and none may be named — by its operator-visible label, by the setting it binds, or by its
 *     own attributes — as something that sets a cadence;
 *   - the block where the page STATES the cadence, located structurally by the one link to the
 *     Scheduler tab rather than by its wording, contains no editable control at all. That
 *     assertion needs no vocabulary: it is what separates the legitimate state (a sentence and
 *     a link to the page that genuinely owns the cadence) from a resurrection (a control).
 *
 * PROSE CANNOT SATISFY ANY OF IT. The UI rule reads the JSX tree, so comments are invisible to
 * it, and a control's "label" is taken only from `<Label>`/`<label>`/`<legend>` elements —
 * never from `<p>` explanatory text. This file's subject deliberately still NAMES the removed
 * key in the comment that explains why it is gone, and still describes the box it used to be;
 * a gravestone has to read differently from a resurrection, and here it does so structurally.
 */

mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'admin' } }),
    requireFreshPermission: async () => ({ user: { id: 'admin' } }),
    freshAuthFailureResult: () => null,
  },
})
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })

const state = {
  settings: [] as Array<{ key: string; value: string }>,
  transactions: 0,
  upserts: [] as Array<{ key: string; value: string }>,
}

const settingDelegate = {
  findMany: async ({ where }: { where?: { key?: { in?: string[] } } } = {}) => {
    const wanted = where?.key?.in
    return state.settings
      .filter((row) => (wanted ? wanted.includes(row.key) : true))
      .map((row) => ({ ...row }))
  },
  findUnique: async ({ where }: { where: { key: string } }) =>
    state.settings.find((row) => row.key === where.key) ?? null,
  updateMany: async () => ({ count: 0 }),
  upsert: ({ where, update }: { where: { key: string }; update: { value: string } }) => {
    // Prisma delegates return a thenable that only executes inside `$transaction`; recording
    // at build time proves the write was PREPARED, and `transactions` proves it was executed.
    state.upserts.push({ key: where.key, value: update.value })
    return { key: where.key }
  },
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: settingDelegate,
      $transaction: async (ops: unknown) => {
        state.transactions += 1
        return Array.isArray(ops) ? ops : []
      },
    },
  },
})

// Neither the currency probe nor the connection gate is what these tests are about; they must
// simply never be the reason a save is refused.
mock.module('@/lib/connectors/woocommerce/connection-test-gate', {
  namedExports: {
    buildWooCommerceConnectionFingerprint: () => 'fingerprint',
    evaluateWooCommerceEnableConnectionGate: async () => ({ ok: true }),
  },
})
mock.module('@/lib/integration-connection-test-gate', {
  namedExports: {
    getIntegrationConnectionTestState: async () => ({ status: 'passed' }),
    recordIntegrationConnectionTest: async () => {},
  },
})

const SYNC_CLIENT = join(process.cwd(), 'app/(dashboard)/sync/sync-client.tsx')
const SYSTEM_SETTINGS_PAGE = join(process.cwd(), 'app/(dashboard)/settings/system/page.tsx')
const WOOCOMMERCE_DOC = join(process.cwd(), 'help-docs/woocommerce.md')
const SETTINGS_PAGES_DIR = join(process.cwd(), 'app/(dashboard)/settings')

function readRepoFile(path: string): string {
  const src = readFileSync(path, 'utf8')
  // A guard that reads an empty or missing file passes by accident. Assert the subject was
  // really loaded before asserting anything about its contents.
  assert.ok(src.length > 2000, `${path} should have been read, got ${src.length} bytes`)
  return src
}

// ---------------------------------------------------------------------------
// The category: "names a polling cadence"
//
// These are the words in which an editable *how often* is written — the quantity itself
// (interval, cadence, frequency, period), the act it paces (poll, sweep, refresh, tick), the
// units it is entered in (minutes/seconds/hours), and the throttles that are the same fact
// under another name. It deliberately does NOT include bare "daily"/"hourly": those state a
// frequency in passing without offering one to edit — "Push FX rates daily" is a boolean
// enable on this same page, and flagging it would make the rule about wording rather than
// about controls that set a cadence.
// ---------------------------------------------------------------------------
// The boundary is `(?<![A-Za-z])`, NOT `\b`. `\b` treats `_` as a word character, so `\bpoll`
// does not match inside `wc_poll_every_minutes` — the very name a resurrection would use. A
// mutation that recreated the control under that name away from the cadence block passed the
// first draft of this rule for exactly that reason: the label half fired on the block heading
// while the binding half was silently inert.
const CADENCE_NAME =
  /(?<![A-Za-z])(?:poll|interval|cadence|frequenc|freq(?![a-z])|sweep|how often|every|minute|min(?![a-z])|second|sec(?![a-z])|hour|period|schedul|throttle|debounce|refresh|tick)/i

function cadenceHit(text: string): string | null {
  const m = CADENCE_NAME.exec(text)
  return m ? m[0] : null
}

// ---------------------------------------------------------------------------
// Every editable control the sync page renders, parsed out of the TSX.
// ---------------------------------------------------------------------------

/** Intrinsic form elements, and the component names this codebase wraps them in. */
const INTRINSIC_CONTROL = /^(?:input|select|textarea)$/
const CONTROL_COMPONENT =
  /(?:Input|Select|Textarea|Switch|Slider|Checkbox|Radio|Toggle|Combobox|Picker|Field|Editor|Control)$/
const LABEL_TAG = /^(?:label|Label|legend|FormLabel)$/

type Opening = ts.JsxOpeningElement | ts.JsxSelfClosingElement
type Control = {
  tag: string
  line: number
  /** `<Label>`/`<label>` text only — never `<p>` prose, and never a comment. */
  label: string
  /** Everything the control binds or is configured with, minus presentational classes. */
  attrs: string
}

function parseTsx(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readRepoFile(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
}

function tagOf(node: ts.Node): string | null {
  if (ts.isJsxElement(node)) return node.openingElement.tagName.getText()
  if (ts.isJsxSelfClosingElement(node)) return node.tagName.getText()
  if (ts.isJsxOpeningElement(node)) return node.tagName.getText()
  return null
}

function isEditableControl(node: Opening): boolean {
  const tag = node.tagName.getText()
  return INTRINSIC_CONTROL.test(tag) || CONTROL_COMPONENT.test(tag)
}

/**
 * The text an operator reads as the NAME of a control. `<p>` and `<code>` subtrees are
 * excluded on purpose: explanatory prose (including the sentence that explains why the old
 * interval box is gone) must never be able to make this rule fire, or to satisfy it.
 */
function labelTextOf(node: ts.Node): string {
  let out = ''
  const visit = (n: ts.Node) => {
    const tag = tagOf(n)
    if (tag === 'p' || tag === 'code') return
    if (ts.isJsxText(n)) out += ` ${n.text}`
    else if (ts.isStringLiteral(n) && n.parent && ts.isJsxExpression(n.parent)) out += ` ${n.text}`
    n.forEachChild(visit)
  }
  visit(node)
  return out.replace(/\s+/g, ' ').trim()
}

/** The label element a block puts at its own top level, if it has one. */
function ownLabelOf(container: ts.JsxElement, skip: ts.Node): ts.Node | null {
  for (const child of container.children) {
    if (child === skip) continue
    const tag = tagOf(child)
    if (tag && LABEL_TAG.test(tag)) return child
  }
  return null
}

/**
 * Best effort, and deliberately not the only signal: walk out to the nearest enclosing block
 * that names itself with a label. A control that is not inside a labelled block at all still
 * has to pass the binding/attribute half of the rule, which needs no label.
 */
function resolveLabel(control: Opening): string {
  let child: ts.Node = control
  let cur: ts.Node | undefined = control.parent
  while (cur) {
    if (ts.isJsxElement(cur)) {
      const tag = cur.openingElement.tagName.getText()
      if (LABEL_TAG.test(tag)) return labelTextOf(cur)
      const own = ownLabelOf(cur, child)
      if (own) return labelTextOf(own)
    }
    child = cur
    cur = cur.parent
  }
  return ''
}

function attrTextOf(control: Opening): string {
  const parts: string[] = []
  for (const attr of control.attributes.properties) {
    if (ts.isJsxAttribute(attr) && /^class(Name)?$/.test(attr.name.getText())) continue
    parts.push(attr.getText())
  }
  return parts.join(' ').replace(/\s+/g, ' ')
}

function collectControls(sf: ts.SourceFile, root: ts.Node = sf): Control[] {
  const found: Control[] = []
  const visit = (n: ts.Node) => {
    if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && isEditableControl(n)) {
      found.push({
        tag: n.tagName.getText(),
        line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
        label: resolveLabel(n),
        attrs: attrTextOf(n),
      })
    }
    n.forEachChild(visit)
  }
  visit(root)
  return found
}

/**
 * Everything an operator actually READS inside a block: prose included this time, because the
 * question is what reaches the page. JSX comments are `JsxExpression` nodes with no expression,
 * so they contribute nothing here either — a job name that survives only in a comment cannot
 * satisfy a requirement that the page name it.
 */
function renderedTextOf(node: ts.Node): string {
  let out = ''
  const visit = (n: ts.Node) => {
    if (ts.isJsxText(n)) out += ` ${n.text}`
    else if (ts.isStringLiteral(n) && n.parent && ts.isJsxExpression(n.parent)) out += ` ${n.text}`
    n.forEachChild(visit)
  }
  visit(node)
  return out.replace(/\s+/g, ' ').trim()
}

/** Every element in the tree, so a landmark can be located structurally. */
function findElements(root: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node[] {
  const found: ts.Node[] = []
  const visit = (n: ts.Node) => {
    if ((ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) && predicate(n)) found.push(n)
    n.forEachChild(visit)
  }
  visit(root)
  return found
}

/** The nearest enclosing block that names itself with a label — the control's "section". */
function labelledBlockOf(node: ts.Node): { block: ts.JsxElement; label: string } | null {
  let child: ts.Node = node
  let cur: ts.Node | undefined = node.parent
  while (cur) {
    if (ts.isJsxElement(cur)) {
      const own = ownLabelOf(cur, child)
      if (own) return { block: cur, label: labelTextOf(own) }
    }
    child = cur
    cur = cur.parent
  }
  return null
}

function reset() {
  state.settings = [
    { key: 'wc_sync_order_statuses', value: '["processing"]' },
    { key: 'wc_sync_interval_minutes', value: '5' },
  ]
  state.transactions = 0
  state.upserts = []
}

test('o3d-potv: the settings the WooCommerce sync page is given carry no polling-cadence field, under any name', async () => {
  reset()
  const { getWcSyncSettings } = await import('@/app/actions/wc-sync')

  const settings = await getWcSyncSettings()
  const keys = Object.keys(settings)

  // Non-vacuity: this is a rule over a real, populated key set, not over an empty object.
  assert.ok(keys.length >= 15, `expected the full sync settings shape, got ${keys.length} keys`)

  // The category, not the instance: a stored row survives the removal (nothing deletes it), so
  // the assertion is about what the page is HANDED — and it holds for a field renamed to
  // `wc_poll_every_minutes` exactly as it does for `wc_sync_interval_minutes`.
  const cadenceKeys = keys.filter((key) => cadenceHit(key))
  assert.deepEqual(
    cadenceKeys,
    [],
    'no field naming a polling cadence may be offered to the settings form — the cadence is the wc-reconcile cron schedule',
  )
  // The control: the sibling setting on the same form is still delivered, so this is not a
  // test that passes because the whole settings read is broken.
  assert.equal(settings.wc_sync_order_statuses, '["processing"]')
})

test('o3d-potv: a posted polling cadence is not persisted under any name, and the same save still writes a real setting', async () => {
  reset()
  const { saveWcSyncSettings } = await import('@/app/actions/wc-sync')

  // What a stale browser tab, a hand-made request, or a half-reverted resurrection would send.
  // The renamed keys are here because the rule is about the category: a cadence this page
  // persists is the defect, whatever it is called.
  const stalePayload = {
    wc_sync_interval_minutes: '5',
    wc_poll_every_minutes: '5',
    wc_sync_frequency_seconds: '300',
    wc_sync_product_direction: 'from_wc',
  } as unknown as Parameters<typeof saveWcSyncSettings>[0]

  const result = await saveWcSyncSettings(stalePayload)

  assert.deepEqual(result, { success: true })
  assert.equal(state.transactions, 1)
  assert.deepEqual(
    state.upserts.filter((row) => cadenceHit(row.key)),
    [],
    'a cadence posted to the sync settings save must not reach the settings table',
  )
  // The real setting in the SAME payload proves the write path ran at all — without it this
  // assertion would also pass for a save that persisted nothing.
  assert.deepEqual(state.upserts, [{ key: 'wc_sync_product_direction', value: 'from_wc' }])
})

test('o3d-potv: no editable control on the sync page sets a polling cadence, and the block that states the cadence holds no control at all', async () => {
  const sf = parseTsx(SYNC_CLIENT)
  const controls = collectControls(sf)

  // Non-vacuity for the whole rule: the page really was parsed and really does render controls.
  // A scanner that found none would let every assertion below pass while examining nothing.
  assert.ok(controls.length >= 10, `expected the sync page's form controls, found ${controls.length}`)
  assert.ok(
    controls.some((c) => /store url/i.test(c.label)),
    'the label resolver should find the credential fields it is supposed to read',
  )

  // (1) THE CATEGORY RULE. Every editable control, examined by what an operator sees it called
  // and by what it binds — not by whether it repeats one retired identifier.
  const cadenceControls = controls
    .map((c) => ({ c, hit: cadenceHit(c.label) ?? cadenceHit(c.attrs) }))
    .filter((row) => row.hit)
    .map((row) => `line ${row.c.line} <${row.c.tag}> label=${JSON.stringify(row.c.label)} matched "${row.hit}"`)
  assert.deepEqual(
    cadenceControls,
    [],
    'the sync page must offer no control that sets how often WooCommerce is swept; that cadence is the WooCommerce Reconcile schedule',
  )

  // (2) THE STRUCTURAL RULE, which needs no vocabulary at all. Find the cadence statement by
  // its link to the page that genuinely owns the cadence, then require that the block it lives
  // in is a statement — prose and a link — rather than a control.
  const schedulerLinks = findElements(sf, (node) => {
    const open = ts.isJsxElement(node) ? node.openingElement : (node as ts.JsxSelfClosingElement)
    return tagOf(node) === 'a' && /\/settings\/system\?tab=scheduler/.test(open.getText())
  })
  assert.equal(schedulerLinks.length, 1, 'the sync page should point at the Scheduler tab exactly once')

  const cadenceBlock = labelledBlockOf(schedulerLinks[0])
  assert.ok(cadenceBlock, 'the cadence statement should sit in a labelled block')
  // Proves the block resolver landed on the cadence statement and not on some outer container.
  assert.match(cadenceBlock.label, /cadence|interval|poll|how often/i)
  assert.deepEqual(
    collectControls(sf, cadenceBlock.block).map((c) => `line ${c.line} <${c.tag}>`),
    [],
    'where the page states the cadence there may be a link to the Scheduler, never a control',
  )

  // The resolver is not one that returns "no controls" for everything: the sibling block on the
  // same row does contain controls, and is found to.
  const statusBlock = labelledBlockOf(
    findElements(sf, (node) => {
      const open = ts.isJsxElement(node) ? node.openingElement : (node as ts.JsxSelfClosingElement)
      return tagOf(node) === 'label' && /orderStatuses\.includes/.test(open.parent.getText())
    })[0] ?? sf,
  )
  assert.ok(
    statusBlock && collectControls(sf, statusBlock.block).length > 0,
    'the order-status block should resolve to a block that does contain controls',
  )

  // (3) PROSE IMMUNITY, asserted rather than assumed. The file still names the removed key and
  // still describes the box, in the comment that explains why it is gone — and the rule above
  // passed anyway, because it reads controls out of the JSX tree instead of grepping the text.
  const src = readRepoFile(SYNC_CLIENT)
  assert.match(src, /wc_sync_interval_minutes/, 'the gravestone comment is worth more than a grep-clean file')
  assert.match(src, /editable minutes input/)

  // (4) Naming the job is the other half of the remedy: an operator who came here to speed the
  // sweep up has to leave knowing where the cadence actually lives. Asserted against what the
  // cadence block RENDERS, not against the file — the same rule the rest of this test obeys, and
  // a job name left only in a comment (which is where this file's removed key now lives) tells
  // an operator nothing.
  const cadenceText = renderedTextOf(cadenceBlock.block)
  assert.ok(cadenceText.length > 80, `the cadence block should render a statement, got ${cadenceText.length} chars`)
  assert.match(cadenceText, /WooCommerce Reconcile/)
})

test('o3d-potv: every operator-facing pointer at the WooCommerce polling cadence names a page that exists', async () => {
  const { RETIRED_ENV_VARS } = await import('@/lib/ops/retired-env-vars')
  const message = RETIRED_ENV_VARS.WC_POLL_INTERVAL_MINUTES

  assert.match(message, /wc-reconcile cron schedule/)

  // Round 1 asserted the message does not say "Settings -> Cron" — a page this app does not
  // have. That is the same name-as-proxy weakness: any OTHER invented page passes it. Resolve
  // every settings path the message names against the real navigation instead.
  const paths = [...message.matchAll(/Settings -> ([A-Z][A-Za-z]*) -> ([A-Z][A-Za-z]*)/g)]
  assert.ok(paths.length >= 1, `the message should point somewhere; parsed ${paths.length} settings paths`)
  for (const [, page, tab] of paths) {
    const pageSource = readRepoFile(join(SETTINGS_PAGES_DIR, page.toLowerCase(), 'page.tsx'))
    assert.match(
      pageSource,
      new RegExp(`key: '${tab.toLowerCase()}', label: '${tab}'`),
      `Settings -> ${page} -> ${tab} should be a tab that exists`,
    )
  }
  // And the one it must name is the one that owns the cadence.
  assert.match(message, /Settings -> System -> Scheduler/)
  assert.match(readRepoFile(SYSTEM_SETTINGS_PAGE), /key: 'scheduler', label: 'Scheduler'/)
})

test('o3d-potv: the WooCommerce help doc describes the cadence as a pointer, never as a field on this page', async () => {
  const doc = readRepoFile(WOOCOMMERCE_DOC)

  const section = /### Ongoing Order Sync\n([\s\S]*?)\n### /.exec(doc)
  assert.ok(section, 'the ongoing-order-sync section should be found in the doc')

  // The doc's own structure: `- **Name** — what it does`, continuation lines indented.
  const bullets: Array<{ name: string; body: string }> = []
  let current: { name: string; body: string } | null = null
  for (const line of section[1].split('\n')) {
    const start = /^- \*\*(.+?)\*\*(.*)$/.exec(line)
    if (start) {
      current = { name: start[1], body: start[2] }
      bullets.push(current)
    } else if (current && /^\s+\S/.test(line)) {
      current.body += ` ${line.trim()}`
    } else {
      current = null
    }
  }
  assert.ok(bullets.length >= 3, `expected the configuration-options list, parsed ${bullets.length} bullets`)

  // Any bullet naming a cadence must be a POINTER, not a described control — whatever it is
  // titled. A resurrection documented as "**Poll every (minutes)** — how often IMS polls;
  // default 5" is cadence-named and carries neither marker, so it fails here.
  const cadenceBullets = bullets.filter((b) => cadenceHit(b.name))
  assert.ok(cadenceBullets.length >= 1, 'the doc should still tell an operator where the cadence lives')
  for (const bullet of cadenceBullets) {
    assert.match(
      bullet.body,
      /not\*{0,2} set on this page/,
      `the "${bullet.name}" bullet must say the cadence is not set on this page`,
    )
    assert.match(
      bullet.body,
      /Settings → System → Scheduler/,
      `the "${bullet.name}" bullet must name the page that does own the cadence`,
    )
    // Scoped to the bullet for the same reason: a file-wide match is satisfied by any of the
    // dozen other mentions of the job elsewhere in this document.
    assert.match(
      bullet.body,
      /WooCommerce Reconcile/,
      `the "${bullet.name}" bullet must name the schedule that does set the cadence`,
    )
  }
})
