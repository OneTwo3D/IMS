import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { storeInvoicePdfUpload } from '@/lib/invoice-upload-storage'
import { getInvoiceQuarantineDir, getInvoiceUploadDir } from '@/lib/upload-storage'

// onetwo3d-ims-xfy2: end-to-end proof that a REAL detecting command scanner,
// wired through the actual quarantine → scan → promote/reject storage path,
// (1) rejects and deletes a malicious fixture, (2) promotes a clean PDF, and
// (3) fails CLOSED when the scanner errors / times out / is unavailable —
// leaving no file in the served upload directory in any failure case.

// The EICAR anti-malware test string — the industry-standard benign fixture
// every real scanner (ClamAV included) flags as malware. Split so this test
// file itself is not flagged by scanners crawling the repo.
const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}', '$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!', '$H+H*'].join('')

/** A minimal PDF that embeds the EICAR signature, like a weaponized invoice. */
const maliciousPdf = () => Buffer.from(`%PDF-1.7\n% ${EICAR}\n`)
const cleanPdf = () => Buffer.from('%PDF-1.7\n% ordinary invoice\n')

/**
 * A real command scanner (not a fixed exit code): it reads the target file and
 * follows the ClamAV convention — exit 1 when the EICAR signature is present
 * (infected), exit 0 otherwise (clean). Proves detection is content-driven.
 */
async function writeEicarScanner(dir: string): Promise<string> {
  const scriptPath = path.join(dir, 'eicar-scanner.mjs')
  await writeFile(scriptPath, [
    'import { readFile } from "node:fs/promises"',
    'const body = await readFile(process.argv[2], "utf8")',
    // Reconstruct the signature here too so the script file is not itself flagged.
    'const sig = ["X5O!P%@AP[4\\\\PZX54(P^)7CC)7}", "$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!", "$H+H*"].join("")',
    'process.exit(body.includes(sig) ? 1 : 0)',
    '',
  ].join('\n'))
  return scriptPath
}

async function withUploadSandbox(run: (scannerDir: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'ims-invoice-scan-e2e-'))
  const prevUploadDir = process.env.UPLOAD_STORAGE_DIR
  process.env.UPLOAD_STORAGE_DIR = root
  try {
    await run(root)
  } finally {
    if (prevUploadDir === undefined) delete process.env.UPLOAD_STORAGE_DIR
    else process.env.UPLOAD_STORAGE_DIR = prevUploadDir
    await rm(root, { recursive: true, force: true })
  }
}

async function countFiles(dir: string): Promise<number> {
  try {
    return (await readdir(dir)).length
  } catch {
    return 0
  }
}

test('E2E: a malicious (EICAR) invoice PDF is quarantined, rejected 400, and deleted — nothing reaches the served dir', async () => {
  await withUploadSandbox(async (dir) => {
    const scanner = await writeEicarScanner(dir)
    const result = await storeInvoicePdfUpload('evil-invoice.pdf', maliciousPdf(), {
      scan: { env: { FILE_SCAN_MODE: 'command', FILE_SCAN_COMMAND: `${process.execPath} ${scanner} {file}` } },
    })

    assert.equal(result.ok, false)
    assert.equal(result.ok === false && result.status, 400)
    assert.equal(result.ok === false && result.error, 'File failed security scan.')
    assert.equal(result.scan.status, 'infected')
    assert.equal(result.scan.reason, 'nonzero-exit')
    // Fail-closed: neither the served upload dir nor quarantine retains the file.
    assert.equal(await countFiles(getInvoiceUploadDir()), 0)
    assert.equal(await countFiles(getInvoiceQuarantineDir()), 0)
  })
})

test('E2E: a clean invoice PDF passes the same real scanner and is promoted to the served dir', async () => {
  await withUploadSandbox(async (dir) => {
    const scanner = await writeEicarScanner(dir)
    const result = await storeInvoicePdfUpload('good-invoice.pdf', cleanPdf(), {
      scan: { env: { FILE_SCAN_MODE: 'command', FILE_SCAN_COMMAND: `${process.execPath} ${scanner} {file}` } },
    })

    assert.equal(result.ok, true)
    assert.equal(result.scan.status, 'clean')
    assert.equal(await countFiles(getInvoiceUploadDir()), 1)
    // Quarantine is emptied once the clean file is promoted.
    assert.equal(await countFiles(getInvoiceQuarantineDir()), 0)
  })
})

test('E2E: an unavailable scanner fails CLOSED (503) and leaves nothing in the served dir', async () => {
  await withUploadSandbox(async () => {
    const result = await storeInvoicePdfUpload('good-invoice.pdf', cleanPdf(), {
      scan: { env: { FILE_SCAN_MODE: 'command', FILE_SCAN_COMMAND: '/nonexistent/scanner {file}' } },
    })

    assert.equal(result.ok, false)
    assert.equal(result.ok === false && result.status, 503)
    assert.equal(result.ok === false && result.error, 'File scan failed.')
    assert.equal(result.scan.status, 'error')
    assert.equal(result.scan.reason, 'spawn-error')
    assert.equal(await countFiles(getInvoiceUploadDir()), 0)
    assert.equal(await countFiles(getInvoiceQuarantineDir()), 0)
  })
})

test('E2E: a scanner that times out fails CLOSED (503) and leaves nothing in the served dir', async () => {
  await withUploadSandbox(async (dir) => {
    const slow = path.join(dir, 'slow-scanner.mjs')
    await writeFile(slow, 'setTimeout(() => process.exit(0), 60_000)\n')
    const result = await storeInvoicePdfUpload('good-invoice.pdf', cleanPdf(), {
      scan: {
        env: { FILE_SCAN_MODE: 'command', FILE_SCAN_COMMAND: `${process.execPath} ${slow} {file}` },
        timeoutMs: 150,
      },
    })

    assert.equal(result.ok, false)
    assert.equal(result.ok === false && result.status, 503)
    assert.equal(result.scan.status, 'error')
    assert.equal(result.scan.reason, 'timeout')
    assert.equal(await countFiles(getInvoiceUploadDir()), 0)
    assert.equal(await countFiles(getInvoiceQuarantineDir()), 0)
  })
})
