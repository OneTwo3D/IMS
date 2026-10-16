/**
 * The runner core opens no database, socket, process or environment variable and reads no clock; only io.ts touches the filesystem.
 * (ABSENCE checks over every file of the core; each pattern is proved able to fail.) Then the two filesystem helpers, against a real directory.
 */
import assert from 'node:assert/strict'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { PreparedDirError, readFileOrNull, readPreparedDir, writeExclusiveFile } from '../../lib/first-load/apply/io.ts'
import { precondition } from './helpers.ts'

const CORE = readdirSync(path.join(process.cwd(), 'lib/first-load/apply'))
  .filter((name) => name.endsWith('.ts') && name !== 'system-import-capability.ts')
  .map((name) => `lib/first-load/apply/${name}`)

const FORBIDDEN: Array<[string, RegExp]> = [
  ['database module', /from ['"](?:@\/lib\/db|\.\.?\/.*\/db|pg|@prisma\/adapter-pg|@\/app\/actions)(?:\/[^'"]*)?['"]/],
  ['Prisma client constructed', /new\s+PrismaClient\b|PrismaPg/],
  ['network module', /from ['"]node:(?:net|http|https|http2|dns|tls|dgram)['"]/],
  ['fetch or connector', /\bfetch\s*\(|connectorFetch|undici|@\/lib\/connectors/],
  ['environment variable', /process\.env\b/],
  ['clock', /\bnew Date\(\s*\)|Date\.now\s*\(|performance\.now/],
  ['child process', /node:child_process/],
  ['randomness', /Math\.random|randomUUID/],
]
const FS_IMPORT = /from ['"]node:fs(?:\/promises)?['"]/

function code(file: string): Array<{ line: string; n: number }> {
  return readFileSync(path.join(process.cwd(), file), 'utf8').split('\n').map((line, i) => ({ line, n: i + 1 })).filter(({ line }) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
}

test('no file of the runner core imports a database, network, connector, environment, clock, child-process or random source', (t) => {
  const hits: string[] = []
  let lines = 0
  for (const file of CORE) for (const { line, n } of code(file)) { lines++; for (const [what, pattern] of FORBIDDEN) if (pattern.test(line)) hits.push(`${file}:${n}: ${what}: ${line.trim()}`) }
  precondition(t, 'files scanned', CORE.length)
  precondition(t, 'lines scanned', lines)
  assert.deepEqual(hits, [])
})

test('only io.ts imports the filesystem', (t) => {
  const importers = CORE.filter((file) => code(file).some(({ line }) => FS_IMPORT.test(line)))
  precondition(t, 'files scanned', CORE.length)
  assert.deepEqual(importers, ['lib/first-load/apply/io.ts'])
})

test('the absence rules can fail: each forbidden pattern matches a sample line', (t) => {
  const samples: Record<string, string> = {
    'database module': "import { db } from '@/lib/db'",
    'Prisma client constructed': 'const c = new PrismaClient()',
    'network module': "import http from 'node:http'",
    'fetch or connector': 'await fetch(url)',
    'environment variable': 'const x = process.env.HOME',
    clock: 'const now = Date.now()',
    'child process': "import { spawn } from 'node:child_process'",
    randomness: 'const id = randomUUID()',
  }
  precondition(t, 'patterns exercised', FORBIDDEN.length)
  for (const [what, pattern] of FORBIDDEN) assert.ok(pattern.test(samples[what]), what)
  assert.ok(FS_IMPORT.test("import { readFileSync } from 'node:fs'"))
})

const scratch = mkdtempSync(path.join(tmpdir(), 'first-load-apply-io-'))
after(() => rmSync(scratch, { recursive: true, force: true }))
let counter = 0
const fresh = (label: string) => path.join(scratch, `${label}-${++counter}`)

test('readPreparedDir reads regular files and refuses a symbolic link or a subdirectory', (t) => {
  const dir = fresh('prepared')
  mkdirSync(dir)
  writeFileSync(path.join(dir, 'a.csv'), 'x')
  writeFileSync(path.join(dir, 'b.csv'), 'y')
  assert.deepEqual([...readPreparedDir(dir).keys()], ['a.csv', 'b.csv'])
  const withLink = fresh('linked')
  mkdirSync(withLink)
  writeFileSync(path.join(withLink, 'real.csv'), 'x')
  symlinkSync(path.join(withLink, 'real.csv'), path.join(withLink, 'link.csv'))
  assert.throws(() => readPreparedDir(withLink), /symbolic link: link\.csv/)
  const withDir = fresh('nested')
  mkdirSync(path.join(withDir, 'sub'), { recursive: true })
  assert.throws(() => readPreparedDir(withDir), PreparedDirError)
  assert.throws(() => readPreparedDir(fresh('missing')), /cannot read the prepared directory/)
  precondition(t, 'refusal arms', 3)
})

test('readFileOrNull returns null for a missing file, a directory and a symbolic link', () => {
  const dir = fresh('one')
  mkdirSync(dir)
  writeFileSync(path.join(dir, 'f'), 'hello')
  symlinkSync(path.join(dir, 'f'), path.join(dir, 'l'))
  assert.equal(new TextDecoder().decode(readFileOrNull(path.join(dir, 'f'))!), 'hello')
  assert.equal(readFileOrNull(path.join(dir, 'nope')), null)
  assert.equal(readFileOrNull(dir), null)
  assert.equal(readFileOrNull(path.join(dir, 'l')), null)
})

test('writeExclusiveFile creates a 0600 file with the exact bytes, and refuses to overwrite a file or to follow a link', (t) => {
  const dir = fresh('out')
  mkdirSync(dir)
  const file = path.join(dir, 'residual.csv')
  writeExclusiveFile(file, new TextEncoder().encode('a,b\r\n1,2\r\n'))
  assert.equal(readFileSync(file, 'utf8'), 'a,b\r\n1,2\r\n')
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.throws(() => writeExclusiveFile(file, new TextEncoder().encode('other')), /EEXIST/)
  assert.equal(readFileSync(file, 'utf8'), 'a,b\r\n1,2\r\n', 'the existing file is untouched')
  const victim = path.join(dir, 'victim')
  writeFileSync(victim, 'keep')
  const link = path.join(dir, 'link')
  symlinkSync(victim, link)
  assert.throws(() => writeExclusiveFile(link, new TextEncoder().encode('x')), /EEXIST|ELOOP/)
  assert.equal(readFileSync(victim, 'utf8'), 'keep', 'the link target is untouched')
  assert.ok(lstatSync(link).isSymbolicLink())
  precondition(t, 'refusal arms', 2)
})
