import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  checkFileScanHealth,
  fileScanAuditMetadata,
  parseFileScanCommand,
  parseFileScanCommandArgv,
  scanFile,
} from '@/lib/security/file-scan'

async function withTempFile(run: (filePath: string, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ims-file-scan-'))
  try {
    const filePath = path.join(dir, 'invoice.pdf')
    await writeFile(filePath, Buffer.from('%PDF-1.7\n'))
    await run(filePath, dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function writeScannerScript(dir: string, exitCode: number): Promise<string> {
  const scriptPath = path.join(dir, `scanner-${exitCode}.mjs`)
  await writeFile(scriptPath, [
    'import { access } from "node:fs/promises"',
    'await access(process.argv[2])',
    `process.exit(${exitCode})`,
    '',
  ].join('\n'))
  return scriptPath
}

test('disabled file scan mode skips command execution', async () => {
  await withTempFile(async (filePath) => {
    assert.deepEqual(await scanFile(filePath, {
      env: { FILE_SCAN_MODE: 'disabled', FILE_SCAN_COMMAND: '/missing/scanner' },
    }), {
      mode: 'disabled',
      status: 'skipped',
      reason: 'disabled',
    })
  })
})

test('command file scan mode reports clean scanner exits', async () => {
  await withTempFile(async (filePath, dir) => {
    const scriptPath = await writeScannerScript(dir, 0)
    const result = await scanFile(filePath, {
      env: {
        FILE_SCAN_MODE: 'command',
        FILE_SCAN_COMMAND: `${process.execPath} ${scriptPath} {file}`,
      },
    })

    assert.equal(result.mode, 'command')
    assert.equal(result.status, 'clean')
    assert.equal(result.exitCode, 0)
    assert.match(result.scannerId ?? '', /^sha256:[a-f0-9]{12}$/)
    assert.match(String(fileScanAuditMetadata(result).scanScannerId), /^sha256:[a-f0-9]{12}$/)
  })
})

test('command file scan mode treats nonzero scanner exits as infected', async () => {
  await withTempFile(async (filePath, dir) => {
    const scriptPath = await writeScannerScript(dir, 1)
    const result = await scanFile(filePath, {
      env: {
        FILE_SCAN_MODE: 'command',
        FILE_SCAN_COMMAND: `${process.execPath} ${scriptPath} {file}`,
      },
    })

    assert.equal(result.mode, 'command')
    assert.equal(result.status, 'infected')
    assert.equal(result.exitCode, 1)
    assert.equal(result.reason, 'nonzero-exit')
  })
})

test('command file scan mode fails closed on command spawn errors', async () => {
  await withTempFile(async (filePath) => {
    const result = await scanFile(filePath, {
      env: {
        FILE_SCAN_MODE: 'command',
        FILE_SCAN_COMMAND: `/missing/scanner {file}`,
      },
    })

    assert.equal(result.mode, 'command')
    assert.equal(result.status, 'error')
    assert.equal(result.reason, 'spawn-error')
  })
})

test('file scan command parser appends file path when no placeholder is present', () => {
  assert.deepEqual(parseFileScanCommand('scanner --flag', '/tmp/invoice.pdf'), [
    'scanner',
    '--flag',
    '/tmp/invoice.pdf',
  ])
  assert.deepEqual(parseFileScanCommand('scanner "--name=value with space" {file}', '/tmp/invoice.pdf'), [
    'scanner',
    '--name=value with space',
    '/tmp/invoice.pdf',
  ])
  assert.equal(parseFileScanCommand('scanner "unterminated', '/tmp/invoice.pdf'), null)
  assert.equal(parseFileScanCommand('   ', '/tmp/invoice.pdf'), null)
  assert.deepEqual(parseFileScanCommand('scanner "" trailing\\', '/tmp/invoice.pdf'), [
    'scanner',
    '',
    'trailing\\',
    '/tmp/invoice.pdf',
  ])
  assert.deepEqual(parseFileScanCommand('scanner {file}', '/var/lib/{file}-uploads/invoice.pdf'), [
    'scanner',
    '/var/lib/{file}-uploads/invoice.pdf',
  ])
})

test('file scan command argv parser accepts explicit JSON arguments', () => {
  assert.deepEqual(parseFileScanCommandArgv('["scanner","--flag","{file}"]', '/tmp/invoice.pdf'), [
    'scanner',
    '--flag',
    '/tmp/invoice.pdf',
  ])
  assert.deepEqual(parseFileScanCommandArgv('["scanner",""]', '/tmp/invoice.pdf'), [
    'scanner',
    '',
    '/tmp/invoice.pdf',
  ])
  assert.equal(parseFileScanCommandArgv('{"command":"scanner"}', '/tmp/invoice.pdf'), null)
})

test('scanner subprocess receives an allowlisted environment only', async () => {
  await withTempFile(async (filePath, dir) => {
    const outputPath = path.join(dir, 'env.txt')
    const scriptPath = path.join(dir, 'env-scanner.mjs')
    await writeFile(scriptPath, [
      'import { writeFile } from "node:fs/promises"',
      `await writeFile(${JSON.stringify(outputPath)}, JSON.stringify(process.env))`,
      '',
    ].join('\n'))

    const result = await scanFile(filePath, {
      env: {
        FILE_SCAN_MODE: 'command',
        FILE_SCAN_COMMAND: `${process.execPath} ${scriptPath} {file}`,
        DATABASE_URL: 'postgresql://secret',
        AUTH_SECRET: 'secret',
        PATH: process.env.PATH,
      },
    })

    assert.equal(result.status, 'clean')
    const scannerEnv = JSON.parse(await readFile(outputPath, 'utf8')) as Record<string, string>
    assert.equal(scannerEnv.DATABASE_URL, undefined)
    assert.equal(scannerEnv.AUTH_SECRET, undefined)
    assert.equal(scannerEnv.PATH, process.env.PATH)
  })
})

test('scanner subprocess drains stdout and stderr without changing clean verdicts', async () => {
  await withTempFile(async (filePath, dir) => {
    const scriptPath = path.join(dir, 'verbose-scanner.mjs')
    await writeFile(scriptPath, [
      'process.stdout.write("x".repeat(128 * 1024))',
      'process.stderr.write("warning on stderr")',
      'process.exit(0)',
      '',
    ].join('\n'))

    const result = await scanFile(filePath, {
      env: {
        FILE_SCAN_MODE: 'command',
        FILE_SCAN_COMMAND: `${process.execPath} ${scriptPath} {file}`,
      },
    })

    assert.equal(result.status, 'clean')
  })
})

test('file scan health smoke check warns on scanner failures', async () => {
  const result = await checkFileScanHealth({
    env: {
      FILE_SCAN_MODE: 'command',
      FILE_SCAN_COMMAND: '/missing/scanner {file}',
    },
    timeoutMs: 100,
  })

  assert.equal(result.status, 'error')
  assert.equal(result.reason, 'spawn-error')
})
