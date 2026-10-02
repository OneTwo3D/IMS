import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test, { type TestContext } from 'node:test'

import ts from 'typescript'

import { createTempDirSync } from './temp-dir'

import {
  CLASSES,
  MIN_SITES_BY_KIND,
  MIN_SOURCE_FILES,
  OWNING_MODULE,
  floorFailures,
  reconcile,
  scanProgram,
} from '../../scripts/check-ledger-standing-readers.mjs'
import { DECLARATIONS } from '../../scripts/ledger-standing-reader-declarations.mjs'

/**
 * o3d-f709 - THE CENSUS GUARD, PROVEN ABLE TO FAIL.
 *
 * `scripts/check-ledger-standing-readers.mjs` fails the build on any reader of an AccountingSyncLog
 * row's evidence that is neither inside lib/domain/accounting/ledger-standing.ts nor DECLARED, per
 * site. A guard is worth what it REFUSES, so every shape below is a synthetic source this tree does
 * not contain (assertions over today's sources cannot establish what the guard turns down), and every
 * test states and prints its PRECONDITION: the count of sites it found, so a detector that quietly
 * stopped seeing the shape fails the precondition instead of passing an empty assertion.
 */

const ROOT = process.cwd()
const COLUMNS = new Set([
  'id', 'connector', 'type', 'status', 'referenceType', 'referenceId', 'externalTransactionId',
  'payload', 'errorMessage', 'retryCount', 'settlementBasis', 'abandonedBeforeRemoteCall',
])

/** A Prisma-shaped declaration the fixtures share: the status enum and a sync-log row. */
const PRELUDE = `
export type AccountingSyncStatus = 'PENDING' | 'PROCESSING' | 'SYNCED' | 'FAILED' | 'CANCELLED'
export type Row = {
  id: string
  status: AccountingSyncStatus
  externalTransactionId: string | null
  settlementBasis: string | null
}
export declare const db: {
  accountingSyncLog: { findMany(args: unknown): Promise<Row[]>; updateMany(args: unknown): Promise<unknown> }
  accountingEvent: { findMany(args: unknown): Promise<unknown[]> }
}
`

function scan(sources: Record<string, string>) {
  const all = { 'lib/fixture-prelude.ts': PRELUDE, ...sources }
  const files = new Map(Object.entries(all).map(([name, text]) => [path.join(ROOT, name), text]))
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
  }
  const host = ts.createCompilerHost(options, true)
  const readFile = host.readFile.bind(host)
  const fileExists = host.fileExists.bind(host)
  const getSourceFile = host.getSourceFile.bind(host)
  host.readFile = (name) => (files.has(name) ? files.get(name) : readFile(name))
  host.fileExists = (name) => files.has(name) || fileExists(name)
  host.getSourceFile = (name, languageVersion, ...rest) => (files.has(name)
    ? ts.createSourceFile(name, files.get(name) as string, languageVersion, true)
    : getSourceFile(name, languageVersion, ...rest))
  const program = ts.createProgram([...files.keys()], options, host)
  return scanProgram({
    program,
    checker: program.getTypeChecker(),
    inScope: new Set(Object.keys(all)),
    columns: COLUMNS,
  })
}

type Site = { key: string; kind: string; file: string; decl: string; selectsBasis?: boolean; rescued?: boolean }
const kindsIn = (sites: Site[], file: string) => sites.filter((s) => s.file === file).map((s) => s.kind).sort()

// ---------------------------------------------------------------------------------------------
// EVERY KIND IS SEEN
// ---------------------------------------------------------------------------------------------

test('o3d-f709: a status comparison against SYNCED and CANCELLED is a site, keyed per declaration and ordinal', () => {
  const result = scan({
    'lib/a.ts': `
      import type { Row } from './fixture-prelude'
      export function first(row: Row) { return row.status === 'SYNCED' }
      export function second(row: Row) { return row.status !== 'CANCELLED' && row.status === 'SYNCED' }
    `,
  })
  console.log(`# precondition: ${result.sites.length} site(s): ${result.sites.map((s: Site) => s.key).join(' | ')}`)
  assert.deepEqual(result.sites.map((s: Site) => s.key), [
    'lib/a.ts::first::cmp-synced#1',
    'lib/a.ts::second::cmp-cancelled#1',
    'lib/a.ts::second::cmp-synced#1',
  ])
})

test('o3d-f709: hiding SYNCED behind a const, an alias or a set does not hide the site', () => {
  const result = scan({
    'lib/hidden.ts': `
      import type { Row } from './fixture-prelude'
      const WANTED = 'SYNCED' as const
      const LIVE = ['PENDING', 'PROCESSING', 'SYNCED'] as const
      const alias = LIVE
      export function viaConst(row: Row) { return row.status === WANTED }
      export function viaSet(row: Row) { return (alias as readonly string[]).includes(row.status) }
      export function viaSwitch(row: Row) { switch (row.status) { case 'SYNCED': return 1; default: return 0 } }
    `,
  })
  console.log(`# precondition hidden: ${result.sites.map((s: Site) => s.key).join(' | ')}`)
  assert.deepEqual(result.sites.map((s: Site) => s.key), [
    'lib/hidden.ts::viaConst::cmp-synced#1',
    'lib/hidden.ts::viaSet::cmp-synced#1',
    'lib/hidden.ts::viaSwitch::cmp-synced#1',
  ])
})

test('o3d-f709: a where whose status clause admits SYNCED, and an id-not-null clause, are sites; a spread of the module is not', () => {
  const result = scan({
    'lib/q.ts': `
      import { db } from './fixture-prelude'
      declare const MAY_HAVE_REACHED_LEDGER_WHERE: object
      export async function admits() { return db.accountingSyncLog.findMany({ where: { status: { in: ['PENDING', 'SYNCED'] } } }) }
      export async function idOnly() { return db.accountingSyncLog.findMany({ where: { externalTransactionId: { not: null } } }) }
      export async function viaModule() { return db.accountingSyncLog.findMany({ where: { ...MAY_HAVE_REACHED_LEDGER_WHERE } }) }
      export async function notSynced() { return db.accountingSyncLog.findMany({ where: { status: { in: ['PENDING', 'FAILED'] } } }) }
    `,
  })
  console.log(`# precondition q: ${result.sites.map((s: Site) => s.key).join(' | ')}`)
  assert.deepEqual(result.sites.map((s: Site) => s.key), [
    'lib/q.ts::admits::where-admits-synced#1',
    'lib/q.ts::idOnly::where-id-not-null#1',
  ])
})

test('o3d-f709: a status clause this scan cannot read fails CLOSED as a site, never silently', () => {
  const result = scan({
    'lib/unreadable.ts': `
      import { db } from './fixture-prelude'
      declare function statusesAtRuntime(): any
      export async function dynamic() { return db.accountingSyncLog.findMany({ where: { status: { in: statusesAtRuntime() } } }) }
    `,
  })
  // BOTH kinds: an unreadable set might be the complement of CANCELLED and might admit SYNCED.
  assert.deepEqual(kindsIn(result.sites, 'lib/unreadable.ts'), ['where-admits-synced', 'where-excludes-cancelled'])
  assert.ok(result.sites.every((s: { detail: string }) => /cannot be read statically/.test(s.detail)))
})

test('o3d-f709: the complement of CANCELLED written longhand is a where-excludes-cancelled site, tagged rescued only against a real sibling', () => {
  const result = scan({
    'lib/excl.ts': `
      import { db } from './fixture-prelude'
      export async function bare() {
        return db.accountingSyncLog.findMany({ where: { status: { not: 'CANCELLED' } } })
      }
      export async function rescued() {
        return db.accountingSyncLog.findMany({ where: { OR: [
          { status: { in: ['PENDING', 'PROCESSING', 'SYNCED', 'FAILED'] } },
          { externalTransactionId: { not: null } },
        ] } })
      }
    `,
  })
  const excl = result.sites.filter((s: Site) => s.kind === 'where-excludes-cancelled')
  console.log(`# precondition excl: ${excl.map((s: Site) => `${s.key} rescued=${s.rescued}`).join(' | ')}`)
  assert.deepEqual(excl.map((s: Site) => [s.decl, s.rescued]), [['bare', false], ['rescued', true]])
})

test('o3d-f709: a truthiness read of externalTransactionId is a site in every form, and a plain assignment is not', () => {
  const result = scan({
    'lib/ids.ts': `
      import type { Row } from './fixture-prelude'
      export function ifForm(r: Row) { if (r.externalTransactionId) return 1; return 0 }
      export function notForm(r: Row) { return !r.externalTransactionId }
      export function andForm(r: Row) { return r.status && r.externalTransactionId }
      export function ternaryForm(r: Row) { return r.externalTransactionId ? 'y' : 'n' }
      export function boolForm(r: Row) { return Boolean(r.externalTransactionId) }
      export function nullForm(r: Row) { return r.externalTransactionId !== null }
      export function filterForm(rs: Row[]) { return rs.filter((r) => r.externalTransactionId) }
      export function justRead(r: Row) { const id = r.externalTransactionId; return id }
    `,
  })
  console.log(`# precondition ids: ${result.sites.map((s: Site) => s.decl).join(',')}`)
  assert.deepEqual(result.sites.map((s: Site) => s.decl), [
    'ifForm', 'notForm', 'andForm', 'ternaryForm', 'boolForm', 'nullForm', 'filterForm',
  ])
  assert.ok(result.sites.every((s: Site) => s.kind === 'id-read'))
})

test('o3d-f709: an AccountingEvent POSTED read without postBasis is a site; with it, or the whole row, it is not', () => {
  const result = scan({
    'lib/ae.ts': `
      import { db } from './fixture-prelude'
      type Event = { status: string; idempotencyKey: string; linesJson: unknown }
      type EventWithBasis = Event & { postBasis: string | null }
      export async function narrowSelect() {
        return db.accountingEvent.findMany({ where: { status: 'POSTED' }, select: { linesJson: true } })
      }
      export async function selectsBasis() {
        return db.accountingEvent.findMany({ where: { status: 'POSTED' }, select: { linesJson: true, postBasis: true } })
      }
      export async function wholeRow() { return db.accountingEvent.findMany({ where: { status: 'POSTED' } }) }
      export function compareWithout(e: Event) { return e.status === 'POSTED' }
      export function compareWith(e: EventWithBasis) { return e.status === 'POSTED' }
    `,
  })
  console.log(`# precondition ae: ${result.sites.map((s: Site) => s.key).join(' | ')}`)
  assert.deepEqual(result.sites.map((s: Site) => s.key), [
    'lib/ae.ts::narrowSelect::ae-posted-query#1',
    'lib/ae.ts::compareWithout::ae-posted-compare#1',
  ])
})

test('o3d-f709: the owning module is exempt - its own comparisons and fragments are the rule', () => {
  const result = scan({
    [OWNING_MODULE]: `
      import type { Row } from './fixture-prelude'
      export function rule(row: Row) { return row.status === 'SYNCED' && !!row.externalTransactionId }
    `,
  })
  assert.deepEqual(result.sites, [])
})

// ---------------------------------------------------------------------------------------------
// RECONCILIATION IS UNIVERSAL IN BOTH DIRECTIONS
// ---------------------------------------------------------------------------------------------

const SAMPLE = scan({
  'lib/s.ts': `
    import { db } from './fixture-prelude'
    import type { Row } from './fixture-prelude'
    export function f(r: Row) { return r.status === 'SYNCED' }
    export async function g() { return db.accountingSyncLog.findMany({ where: { status: { in: ['SYNCED'] } }, select: { id: true } }) }
  `,
}).sites as Site[]

const declareAll = (cls = 'MONEY') => SAMPLE.map((s) => ({ key: s.key, class: cls, reason: 'a reason long enough to be an argument' }))

test('o3d-f709: a fully declared scan reconciles clean (the control for the failures below)', () => {
  console.log(`# precondition reconcile: ${SAMPLE.length} sites ${SAMPLE.map((s) => s.key).join(' | ')}`)
  assert.equal(SAMPLE.length, 2)
  assert.deepEqual(reconcile(SAMPLE, declareAll()), [])
})

test('o3d-f709: a NEW reader in a file nothing declares fails, naming the key', () => {
  const failures = reconcile(SAMPLE, declareAll().slice(0, 1))
  assert.equal(failures.length, 1)
  assert.match(failures[0], /UNDECLARED where-admits-synced/)
  assert.match(failures[0], /lib\/s\.ts::g::where-admits-synced#1/)
})

test('o3d-f709: DELETING a declared site fails as STALE - an allowlist nothing matches permits everything', () => {
  const stale = [...declareAll(), { key: 'lib/s.ts::f::cmp-synced#2', class: 'MONEY', reason: 'a reason long enough to be an argument' }]
  const failures = reconcile(SAMPLE, stale)
  assert.equal(failures.length, 1)
  assert.match(failures[0], /STALE/)
})

test('o3d-f709: SWAPPING a declared site for an undeclared one in the SAME function fails both ways', () => {
  // The per-file count form of this guard could not tell these apart: one site in, one site out, the
  // count unchanged. The key carries the kind, so a cmp-synced swapped for an id-read in `f` fails.
  const swapped = scan({
    'lib/s.ts': `
      import { db } from './fixture-prelude'
      import type { Row } from './fixture-prelude'
      export function f(r: Row) { return !r.externalTransactionId }
      export async function g() { return db.accountingSyncLog.findMany({ where: { status: { in: ['SYNCED'] } }, select: { id: true } }) }
    `,
  }).sites as Site[]
  assert.equal(swapped.length, SAMPLE.length, 'precondition: the COUNT is identical')
  const failures = reconcile(swapped, declareAll())
  console.log(`# swap failures: ${failures.map((f) => f.split('\n')[0]).join(' || ')}`)
  assert.equal(failures.length, 2)
  assert.ok(failures.some((f) => /UNDECLARED id-read/.test(f)))
  assert.ok(failures.some((f) => /STALE/.test(f)))
})

test('o3d-f709: a class outside the vocabulary, a missing reason and a malformed bead id are refused', () => {
  const bad = [
    { key: SAMPLE[0].key, class: 'WHATEVER', reason: 'a reason long enough to be an argument' },
    { key: SAMPLE[1].key, class: 'PENDING_CONVERSION:nobead', reason: 'x' },
  ]
  const failures = reconcile(SAMPLE, bad)
  assert.ok(failures.some((f) => /class "WHATEVER"/.test(f)))
  assert.ok(failures.some((f) => /PENDING_CONVERSION:nobead/.test(f)))
  assert.ok(failures.some((f) => /no reason/.test(f)))
  assert.ok(CLASSES.includes('WORK_SLOT'))
})

test('o3d-f709: a WORK_SLOT declaration on a where that does not select settlementBasis fails; selecting it passes', () => {
  const without = scan({
    'lib/w.ts': `
      import { db } from './fixture-prelude'
      export async function slot() { return db.accountingSyncLog.findMany({ where: { status: { in: ['SYNCED'] } }, select: { id: true, payload: true } }) }
    `,
  }).sites as Site[]
  const withBasis = scan({
    'lib/w.ts': `
      import { db } from './fixture-prelude'
      declare const LEDGER_STANDING_SELECT: object
      export async function slot() { return db.accountingSyncLog.findMany({ where: { status: { in: ['SYNCED'] } }, select: { id: true, ...LEDGER_STANDING_SELECT } }) }
    `,
  }).sites as Site[]
  const slotDecl = (s: Site[]) => s.map((x) => ({ key: x.key, class: 'WORK_SLOT', reason: 'the work-slot predicate, pinned by tests' }))
  console.log(`# precondition WORK_SLOT: without.selectsBasis=${without[0].selectsBasis} with.selectsBasis=${withBasis[0].selectsBasis}`)
  assert.equal(without[0].selectsBasis, false)
  assert.equal(withBasis[0].selectsBasis, true)
  assert.match(reconcile(without, slotDecl(without))[0], /does not select `settlementBasis`/)
  assert.deepEqual(reconcile(withBasis, slotDecl(withBasis)), [])
})

test('o3d-f709: a declaration of rescued:true fails when the clause stopped being ORed with post evidence', () => {
  const asAnd = scan({
    'lib/r.ts': `
      import { db } from './fixture-prelude'
      export async function guard() {
        return db.accountingSyncLog.findMany({ where: { status: { not: 'CANCELLED' }, externalTransactionId: { not: null } } })
      }
    `,
  }).sites as Site[]
  const excl = asAnd.filter((s) => s.kind === 'where-excludes-cancelled')
  assert.equal(excl.length, 1)
  const decls = asAnd.map((s) => ({
    key: s.key, class: 'GUARD', reason: 'the guard ORs the live set with post evidence',
    ...(s.kind === 'where-excludes-cancelled' ? { rescued: true } : {}),
  }))
  assert.match(reconcile(asAnd, decls).join('\n'), /declared rescued:true but was found rescued:false/)
})

// ---------------------------------------------------------------------------------------------
// THE GUARD PROVES IT RAN
// ---------------------------------------------------------------------------------------------

test('o3d-f709: an EMPTY scan fails "subject not reached" on the file floor and on every kind floor', () => {
  const failures = floorFailures({ sites: [], sourceFileCount: 0 })
  console.log(`# empty-scan failures: ${failures.length}`)
  assert.ok(failures.some((f) => f.includes('the floor is') && f.includes('subject not reached')))
  const kindsWithFloor = Object.entries(MIN_SITES_BY_KIND).filter(([, floor]) => (floor as number) > 0).length
  assert.equal(failures.length, 1 + kindsWithFloor)
  assert.ok(MIN_SOURCE_FILES > 100, 'the floor is far above what a mis-rooted scan sees')
})

test('o3d-f709: a scan that reaches enough files but sees none of one kind still fails for that kind', () => {
  const sites = Array.from({ length: 30 }, (_, i) => ({ kind: 'id-read', key: `k${i}` }))
  const failures = floorFailures({ sites, sourceFileCount: MIN_SOURCE_FILES + 1 })
  assert.ok(failures.some((f) => /found 0 cmp-synced site/.test(f)))
  assert.ok(!failures.some((f) => /id-read/.test(f)))
})

/** Runs the real script in a scratch directory laid out however the test needs. */
function runGuardIn(layout: Record<string, string>, t: TestContext): { status: number; output: string } {
  const dir = createTempDirSync('ledger-standing-guard-', t)
  for (const [name, text] of Object.entries(layout)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    writeFileSync(path.join(dir, name), text)
  }
  try {
    const output = execFileSync(process.execPath, [path.join(ROOT, 'scripts/check-ledger-standing-readers.mjs')], {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, output }
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string }
    return { status: e.status ?? -1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

const SCHEMA = `model AccountingSyncLog {
  id String @id
  connector String
  type String
  status String
  referenceType String
  referenceId String
  externalTransactionId String?
  settlementBasis String?
  abandonedBeforeRemoteCall Boolean?
  payload Json
  errorMessage String?
}
`

test('o3d-f709: a MISSING tsconfig.json exits 2 - the guard cannot be pointed at nothing and pass', (t) => {
  const result = runGuardIn({ 'prisma/schema.prisma': SCHEMA, 'scripts/ledger-standing-reader-declarations.mjs': 'export const DECLARATIONS = []' }, t)
  console.log(`# missing tsconfig: status=${result.status} ${result.output.trim().slice(0, 80)}`)
  assert.equal(result.status, 2)
  assert.match(result.output, /tsconfig\.json not found/)
})

test('o3d-f709: an UNREADABLE tsconfig.json exits 2', (t) => {
  const result = runGuardIn({
    'tsconfig.json': '{ this is not json',
    'prisma/schema.prisma': SCHEMA,
    'scripts/ledger-standing-reader-declarations.mjs': 'export const DECLARATIONS = []',
  }, t)
  console.log(`# unreadable tsconfig: status=${result.status} ${result.output.trim().slice(0, 80)}`)
  assert.equal(result.status, 2)
  assert.match(result.output, /unreadable/)
})

test('o3d-f709: scan roots pointing at an EMPTY tree fail with "subject not reached" (exit 1), not a green zero', (t) => {
  const result = runGuardIn({
    'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true }, include: ['**/*.ts'] }),
    'prisma/schema.prisma': SCHEMA,
    'scripts/ledger-standing-reader-declarations.mjs': 'export const DECLARATIONS = []',
    'lib/empty.ts': 'export const x = 1\n',
  }, t)
  console.log(`# empty tree: status=${result.status} ${result.output.split('\n').find((l) => l.includes('subject not reached'))?.trim()}`)
  assert.equal(result.status, 1)
  assert.match(result.output, /subject not reached/)
})

// ---------------------------------------------------------------------------------------------
// THE REAL DECLARATIONS
// ---------------------------------------------------------------------------------------------

test('o3d-f709: the shipped declarations are unique, classed, argued and name beads that exist', () => {
  const keys = new Set<string>()
  for (const d of DECLARATIONS as Array<{ key: string; class: string; reason: string }>) {
    assert.ok(!keys.has(d.key), `duplicate declaration ${d.key}`)
    keys.add(d.key)
    assert.ok(d.reason.trim().length >= 12, `${d.key} has no reason`)
  }
  const classes = new Map<string, number>()
  for (const d of DECLARATIONS as Array<{ class: string }>) classes.set(d.class, (classes.get(d.class) ?? 0) + 1)
  console.log(`# declarations: ${keys.size}; by class ${JSON.stringify(Object.fromEntries(classes))}`)
  assert.ok(keys.size >= 100, 'precondition: the declarations are present')
  const pending = [...classes.keys()].filter((c) => c.startsWith('PENDING_CONVERSION:'))
  assert.ok(pending.length >= 2, 'slice 1c and the M17 design decision are named')
  const text = readFileSync(path.join(ROOT, 'scripts/ledger-standing-reader-declarations.mjs'), 'utf8')
  for (const bead of ['o3d-djemh', 'o3d-1e7sl']) assert.ok(text.includes(`PENDING_CONVERSION:${bead}`), `${bead} is used`)
})

test('o3d-f709: package.json, validate-local.sh and the workflow all name the guard, and the old guard is gone', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
  assert.match(pkg.scripts['check:ledger-standing-readers'] ?? '', /check-ledger-standing-readers\.mjs/)
  assert.match(pkg.scripts['check:all'], /npm run check:ledger-standing-readers/)
  assert.equal('check:accounting-cancelled-row-predicates' in pkg.scripts, false)
  const validate = readFileSync(path.join(ROOT, 'scripts/validate-local.sh'), 'utf8')
  assert.match(validate, /^run_step 'ledger standing readers'\s+npm run check:ledger-standing-readers$/m)
  const workflow = readFileSync(path.join(ROOT, '.github/workflows/ledger-standing-guard.yml'), 'utf8')
  assert.match(workflow, /^\s+- run: npm run check:ledger-standing-readers$/m)
  assert.doesNotMatch(workflow, /^\s+(paths|paths-ignore|needs|if|continue-on-error):/m, 'ungated: no path filter, classifier, needs or if')
})
