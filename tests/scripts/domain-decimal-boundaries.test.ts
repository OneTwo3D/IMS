import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test, { type TestContext } from 'node:test'

import { createTempDirSync } from './temp-dir.ts'

const scriptPath = path.resolve('scripts/check-domain-decimal-boundaries.mjs')

function runCheck(
  t: TestContext,
  files: Record<string, string>,
  targets: Array<{ path: string } | { glob: string }> = [{ path: 'lib/domain' }],
) {
  const root = createTempDirSync('decimal-boundary-', t)
  const allFiles = {
    'scripts/decimal-boundary-targets.json': JSON.stringify({ targets }),
    ...files,
  }
  for (const [filePath, source] of Object.entries(allFiles)) {
    const absolutePath = path.join(root, filePath)
    mkdirSync(path.dirname(absolutePath), { recursive: true })
    writeFileSync(absolutePath, source)
  }
  return spawnSync(process.execPath, [scriptPath], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' },
  })
}

test('domain decimal boundary check rejects decimalToNumber imports without an exception', (t) => {
  const result = runCheck(t, {
    'lib/domain/inventory/example.ts': "import { decimalToNumber } from '@/lib/decimal'\n",
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /lib\/domain\/inventory\/example\.ts:1/)
})

test('domain decimal boundary check accepts file-scope explicit exception comments', (t) => {
  const result = runCheck(t, {
    'lib/domain/inventory/example.ts': [
      '// decimal-boundary-ok: display-only (UI serialization)',
      '',
      'const unrelated = 1',
      'const anotherLine = 2',
      'const formattingCanMoveImports = true',
      "import { decimalToNumber } from '@/lib/decimal'",
      '',
    ].join('\n'),
  })

  assert.equal(result.status, 0)
})

test('domain decimal boundary check rejects unsupported rationale tokens', (t) => {
  const result = runCheck(t, {
    'lib/domain/inventory/example.ts': [
      '// decimal-boundary-ok: anything-goes',
      "import { decimalToNumber } from '@/lib/decimal'",
      '',
    ].join('\n'),
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /unsupported rationale "anything-goes"/)
})

test('domain decimal boundary check accepts rationale tokens followed by punctuation', (t) => {
  const result = runCheck(t, {
    'lib/domain/inventory/example.ts': [
      '// decimal-boundary-ok: display-only, UI serialization.',
      "import { decimalToNumber } from '@/lib/decimal'",
      '',
    ].join('\n'),
  })

  assert.equal(result.status, 0)
})

test('domain decimal boundary check flags aliased decimalToNumber imports', (t) => {
  const result = runCheck(t, {
    'lib/domain/inventory/example.ts': "import { decimalToNumber as toNum } from '@/lib/decimal'\n",
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /lib\/domain\/inventory\/example\.ts:1/)
})

test('domain decimal boundary check flags mixed decimalToNumber imports', (t) => {
  const result = runCheck(t, {
    'lib/domain/inventory/example.ts': "import { decimalToNumber, type DecimalLike } from '@/lib/decimal'\n",
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /lib\/domain\/inventory\/example\.ts:1/)
})

test('domain decimal boundary check ignores DecimalLike-only imports', (t) => {
  const result = runCheck(t, {
    'lib/domain/inventory/example.ts': "import { type DecimalLike } from '@/lib/decimal'\n",
  })

  assert.equal(result.status, 0)
})

test('domain decimal boundary check ignores generated Prisma files', (t) => {
  const result = runCheck(t, {
    'app/actions/example.ts': "import { type DecimalLike } from '@/lib/decimal'\n",
    'app/generated/prisma/example.ts': "import { decimalToNumber } from '@/lib/decimal'\n",
  }, [{ path: 'app' }])

  assert.equal(result.status, 0)
})

test('domain decimal boundary check fails loudly for missing target paths', (t) => {
  const result = runCheck(t, {}, [{ path: 'lib/domani' }])

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /target "lib\/domani" could not be scanned/)
})

test('domain decimal boundary check fails loudly for target globs with zero matches', (t) => {
  const result = runCheck(t, {
    'app/actions/other.ts': "import { type DecimalLike } from '@/lib/decimal'\n",
  }, [{ glob: 'app/actions/xero*.ts' }])

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /target "app\/actions\/xero\*\.ts" matched zero source files/)
})
