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
