/**
 * The first-load tools are file-in, file-out: no database, no network. This is an ABSENCE check over every file of the tool
 * (universal: one offending line anywhere fails it), and it prints how many files and lines it examined.
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { precondition } from './helpers.ts'

const FILES = [
  ...readdirSync(path.join(process.cwd(), 'lib/first-load')).filter((name) => name.endsWith('.ts')).map((name) => `lib/first-load/${name}`),
  'scripts/first-load-prepare.ts',
]

const FORBIDDEN: Array<[string, RegExp]> = [
  ['database module', /from ['"](?:@\/lib\/db|\.\.?\/.*\/db|pg|@prisma\/adapter-pg)(?:\/[^'"]*)?['"]/],
  ['Prisma client constructed', /new\s+PrismaClient\b|PrismaPg/],
  ['network module', /from ['"]node:(?:net|http|https|http2|dns|tls|dgram)['"]|require\(['"](?:net|http|https)['"]\)/],
  ['fetch', /\bfetch\s*\(|connectorFetch|undici/],
  ['environment variable', /process\.env\b/],
  ['clock', /\bnew Date\(\s*\)|Date\.now\s*\(|performance\.now/],
  ['child process', /node:child_process/],
]

test('the first-load tool imports no database, network, clock, environment or child-process module', (t) => {
  let lines = 0
  const hits: string[] = []
  for (const file of FILES) {
    const text = readFileSync(path.join(process.cwd(), file), 'utf8')
    lines += text.split('\n').length
    text.split('\n').forEach((line, index) => {
      if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) return
      for (const [what, pattern] of FORBIDDEN) if (pattern.test(line)) hits.push(`${file}:${index + 1}: ${what}: ${line.trim()}`)
    })
  }
  precondition(t, 'files scanned', FILES.length)
  precondition(t, 'lines scanned', lines)
  assert.deepEqual(hits, [])
})

test('the purity rule can fail: each forbidden pattern matches a sample line', (t) => {
  const samples: Record<string, string> = {
    'database module': "import { db } from '@/lib/db'",
    'Prisma client constructed': 'const c = new PrismaClient()',
    'network module': "import http from 'node:http'",
    fetch: 'await fetch(url)',
    'environment variable': 'const x = process.env.HOME',
    clock: 'const now = Date.now()',
    'child process': "import { spawn } from 'node:child_process'",
  }
  precondition(t, 'patterns exercised', FORBIDDEN.length)
  for (const [what, pattern] of FORBIDDEN) assert.ok(pattern.test(samples[what]), what)
})

// ---------------------------------------------------------------------------
// The one place that may talk to a store: lib/first-load/woo-snapshot/ (and its script). Everywhere else in lib/first-load, including
// subdirectories the scan above does not reach, the connector layer must not be imported.
// ---------------------------------------------------------------------------
function walk(dir: string): string[] {
  return readdirSync(path.join(process.cwd(), dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`
    return entry.isDirectory() ? walk(rel) : entry.name.endsWith('.ts') ? [rel] : []
  })
}

test('only lib/first-load/woo-snapshot/ imports the connector layer (universal absence over every other file under lib/first-load)', (t) => {
  const outside = walk('lib/first-load').filter((file) => !file.startsWith('lib/first-load/woo-snapshot/'))
  const inside = walk('lib/first-load/woo-snapshot')
  precondition(t, 'files outside the snapshot directory', outside.length)
  precondition(t, 'files inside the snapshot directory', inside.length)
  // Static and dynamic imports alike: any quoted specifier that reaches the connector layer.
  const connectorImport = /['"]@\/lib\/(?:connectors|security\/connector-fetch)/
  const hits = outside.flatMap((file) => readFileSync(path.join(process.cwd(), file), 'utf8').split('\n').map((line, i) => ({ file, line, i })).filter(({ line }) => connectorImport.test(line)).map(({ file: f, i }) => `${f}:${i + 1}`))
  assert.deepEqual(hits, [])
  assert.ok(connectorImport.test("const { wcFetch } = await import('@/lib/connectors/woocommerce/api')"), 'the scan sees a dynamic import')
  assert.ok(connectorImport.test("import { wcFetch } from '@/lib/connectors/woocommerce/api'"), 'and a static one')
  const dynamic = inside.filter((file) => /@\/lib\/connectors\/woocommerce\/(?:api|url-safety)/.test(readFileSync(path.join(process.cwd(), file), 'utf8')))
  precondition(t, 'snapshot-directory files that use the connector (the control: the scan can find one)', dynamic.length)
})
