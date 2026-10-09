import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test, { type TestContext } from 'node:test'

import { runCensus } from '../../scripts/check-system-import-capability.mjs'
import { createTempDirSync } from './temp-dir.ts'

/**
 * The boundary around the system-actor import capability (lib/first-load/apply/system-import-capability.ts), exercised on
 * fixture trees: each arm builds a tree, runs the real census, and asserts BOTH that the census looked at the files it was
 * meant to look at (the precondition, printed) and the verdict. A census that finds nothing on an empty tree proves nothing,
 * so the precondition arm shows it CAN find importers.
 */

const SCRIPT = join(process.cwd(), 'scripts/check-system-import-capability.mjs')
const CAP = '@/lib/first-load/apply/system-import-capability'

function tree(t: TestContext, files: Record<string, string>, options: { withCapability?: boolean } = {}): string {
  const root = createTempDirSync('system-import-capability-', t)
  const all: Record<string, string> = {
    ...(options.withCapability === false ? {} : { 'lib/first-load/apply/system-import-capability.ts': 'export const SYSTEM_IMPORT = Symbol("x")\n' }),
    ...files,
  }
  for (const [path, content] of Object.entries(all)) {
    mkdirSync(join(root, dirname(path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

/** The three importer modules, each importing only what it is allowed to. */
const IMPORTERS: Record<string, string> = {
  'app/actions/import.ts': `import { SYSTEM_IMPORT, withSystemActor, withSystemOutcome, type SystemImportContext } from '${CAP}'\n`,
  'app/actions/suppliers.ts': `import { SYSTEM_IMPORT, withSystemActor, withSystemOutcome, type SystemImportContext } from '${CAP}'\n`,
  'app/actions/purchase-orders.ts': `import { SYSTEM_IMPORT, withSystemActor, type SystemImportContext } from '${CAP}'\n`,
}
const RUNNER: Record<string, string> = {
  'scripts/first-load-apply.ts': `import { mintSystemImportContext, SYSTEM_IMPORT } from '${CAP}'\n`,
  'lib/first-load/apply/steps.ts': `import { mintSystemImportContext } from './system-import-capability'\n`,
  'tests/anything.test.ts': `import * as cap from '${CAP}'\nconst x = await import('${CAP}')\n`,
}

function verdict(root: string) {
  const { violations, importers } = runCensus({ root })
  return { violations, importers }
}

test('the allowed importers pass, and the census saw them (precondition)', (t) => {
  const { violations, importers } = verdict(tree(t, { ...IMPORTERS, ...RUNNER }))
  console.log(`census saw ${importers.length} importer file(s): ${importers.join(', ')}`)
  assert.equal(importers.length, 6, 'the three importer modules, the runner CLI, a runner-tree file and a test')
  assert.deepEqual(violations, [])
})

const ILLEGAL: Array<[string, string, string]> = [
  ['a page', 'app/page.ts', `import { SYSTEM_IMPORT } from '${CAP}'\n`],
  ['a client component', 'components/Button.tsx', `'use client'\nimport { SYSTEM_IMPORT } from '${CAP}'\n`],
  ['another server action module', 'app/actions/sales.ts', `import { SYSTEM_IMPORT } from '${CAP}'\n`],
  ['a lib file taking only a type', 'lib/other.ts', `import type { SystemImportContext } from '${CAP}'\n`],
  ['a lib file importing the minting function', 'lib/mint.ts', `import { mintSystemImportContext } from '${CAP}'\n`],
  ['an aliased import', 'lib/alias.ts', `import { SYSTEM_IMPORT as innocuous } from '${CAP}'\n`],
  ['a namespace import', 'lib/ns.ts', `import * as cap from '${CAP}'\n`],
  ['a re-export', 'lib/reexport.ts', `export * from '${CAP}'\n`],
  ['a named re-export', 'lib/reexport2.ts', `export { SYSTEM_IMPORT } from '${CAP}'\n`],
  ['a dynamic import', 'lib/dyn.ts', `export const load = () => import('${CAP}')\n`],
  ['a require', 'lib/req.cjs', `const cap = require('${CAP}')\n`],
  ['a relative path', 'components/rel.ts', `import { SYSTEM_IMPORT } from '../lib/first-load/apply/system-import-capability'\n`],
  ['a relative path with an extension', 'lib/ext.ts', `import { SYSTEM_IMPORT } from './first-load/apply/system-import-capability.ts'\n`],
  ['the barrel of the apply directory', 'lib/barrel-user.ts', `import { SYSTEM_IMPORT } from '@/lib/first-load/apply'\n`],
  ['an import() type', 'lib/typeimport.ts', `export type T = import('${CAP}').SystemImportContext\n`],
]

for (const [what, path, content] of ILLEGAL) {
  test(`${what} that is not on the allowlist fails the boundary check`, (t) => {
    const root = tree(t, { ...IMPORTERS, ...RUNNER, [path]: content })
    const { violations, importers } = verdict(root)
    console.log(`${path}: importers=${importers.length}, violations=${violations.length}`)
    assert.ok(importers.includes(path), `precondition: the census found ${path}`)
    assert.ok(violations.some((v) => v.startsWith(`${path}:`)), `${path} is flagged:\n${violations.join('\n')}`)
    // And only it: nothing allowed was flagged beside it.
    assert.equal(violations.filter((v) => !v.startsWith(`${path}:`)).length, 0)
    const cli = spawnSync(process.execPath, [SCRIPT], { cwd: root, env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8' })
    assert.equal(cli.status, 1)
    assert.match(cli.stderr, /System-import capability boundary violation/)
  })
}

test('an importer module that takes the minting function is refused', (t) => {
  const root = tree(t, {
    ...IMPORTERS,
    'app/actions/import.ts': `import { SYSTEM_IMPORT, mintSystemImportContext } from '${CAP}'\n`,
  })
  const { violations } = verdict(root)
  assert.ok(violations.some((v) => v.startsWith('app/actions/import.ts:') && v.includes('mintSystemImportContext')), violations.join('\n'))
})

test('an importer module that re-exports the capability or imports the apply barrel is refused', (t) => {
  const root = tree(t, {
    ...IMPORTERS,
    'app/actions/suppliers.ts': `export { SYSTEM_IMPORT } from '${CAP}'\nimport { SYSTEM_IMPORT as s } from '${CAP}'\n`,
    'app/actions/purchase-orders.ts': `import { SYSTEM_IMPORT } from '@/lib/first-load/apply'\n`,
  })
  const { violations } = verdict(root)
  assert.ok(violations.some((v) => v.startsWith('app/actions/suppliers.ts:') && v.includes('re-export')), violations.join('\n'))
  assert.ok(violations.some((v) => v.startsWith('app/actions/purchase-orders.ts:')), violations.join('\n'))
})

test('a missing capability module and a stale importer entry fail (the census cannot pass over nothing)', (t) => {
  const root = tree(t, { 'lib/unrelated.ts': 'export const x = 1\n' }, { withCapability: false })
  const { violations, importers } = verdict(root)
  console.log(`importers=${importers.length}, violations=${violations.length}`)
  assert.equal(importers.length, 0)
  assert.ok(violations.some((v) => v.includes('does not exist')))
  for (const module of Object.keys(IMPORTERS)) assert.ok(violations.some((v) => v.startsWith(`${module}:`) && v.includes('stale allowlist entry')), module)
})

test('the production tree passes, and the census saw exactly the importers it should', () => {
  const { violations, importers } = runCensus({ root: process.cwd() })
  console.log(`production census: ${importers.length} importer file(s)`)
  for (const module of Object.keys(IMPORTERS)) assert.ok(importers.includes(module), `precondition: ${module} imports the capability`)
  assert.ok(importers.includes('tests/first-load/system-import-importers.test.ts'), 'precondition: the importers spike test is among them')
  assert.deepEqual(violations, [])
})
