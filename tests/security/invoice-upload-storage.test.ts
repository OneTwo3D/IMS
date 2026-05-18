import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { storeInvoicePdfUpload } from '@/lib/invoice-upload-storage'
import {
  getInvoiceQuarantineDir,
  resolveInvoiceQuarantineFilePath,
  resolveInvoiceUploadFilePath,
} from '@/lib/upload-storage'

const PDF_BUFFER = Buffer.from('%PDF-1.7\ninvoice')

async function exists(filePath: string | null): Promise<boolean> {
  if (!filePath) return false
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function withUploadRoot(run: (root: string) => Promise<void>): Promise<void> {
  const previousRoot = process.env.UPLOAD_STORAGE_DIR
  const root = await mkdtemp(path.join(tmpdir(), 'ims-invoice-upload-'))
  try {
    process.env.UPLOAD_STORAGE_DIR = root
    await run(root)
  } finally {
    if (previousRoot === undefined) {
      delete process.env.UPLOAD_STORAGE_DIR
    } else {
      process.env.UPLOAD_STORAGE_DIR = previousRoot
    }
    await rm(root, { recursive: true, force: true })
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

async function listQuarantineFiles(): Promise<string[]> {
  try {
    return await readdir(getInvoiceQuarantineDir())
  } catch {
    return []
  }
}

test('disabled scan mode writes invoice PDFs directly to final storage', async () => {
  await withUploadRoot(async () => {
    const result = await storeInvoicePdfUpload('invoice.pdf', PDF_BUFFER, {
      scan: { env: { FILE_SCAN_MODE: 'disabled' } },
    })

    assert.equal(result.ok, true)
    assert.equal(result.scan.status, 'skipped')
    const finalPath = resolveInvoiceUploadFilePath('invoice.pdf')
    assert.equal(await exists(finalPath), true)
    assert.equal(await exists(resolveInvoiceQuarantineFilePath('invoice.pdf')), false)
    assert.deepEqual(await readFile(finalPath as string), PDF_BUFFER)
  })
})

test('clean command scan moves invoice PDFs from quarantine to final storage', async () => {
  await withUploadRoot(async (root) => {
    const scriptPath = await writeScannerScript(root, 0)
    const result = await storeInvoicePdfUpload('clean.pdf', PDF_BUFFER, {
      scan: {
        env: {
          FILE_SCAN_MODE: 'command',
          FILE_SCAN_COMMAND: `${process.execPath} ${scriptPath} {file}`,
        },
      },
    })

    assert.equal(result.ok, true)
    assert.equal(result.scan.status, 'clean')
    assert.equal(await exists(resolveInvoiceUploadFilePath('clean.pdf')), true)
    assert.deepEqual(await listQuarantineFiles(), [])
  })
})

test('infected command scan rejects invoice PDFs and removes quarantine file', async () => {
  await withUploadRoot(async (root) => {
    const scriptPath = await writeScannerScript(root, 1)
    const result = await storeInvoicePdfUpload('infected.pdf', PDF_BUFFER, {
      scan: {
        env: {
          FILE_SCAN_MODE: 'command',
          FILE_SCAN_COMMAND: `${process.execPath} ${scriptPath} {file}`,
        },
      },
    })

    assert.equal(result.ok, false)
    assert.equal(result.status, 400)
    assert.equal(result.scan.status, 'infected')
    assert.equal(await exists(resolveInvoiceUploadFilePath('infected.pdf')), false)
    assert.deepEqual(await listQuarantineFiles(), [])
  })
})

test('scan command failures fail closed without moving invoice PDFs to final storage', async () => {
  await withUploadRoot(async () => {
    const result = await storeInvoicePdfUpload('failure.pdf', PDF_BUFFER, {
      scan: {
        env: {
          FILE_SCAN_MODE: 'command',
          FILE_SCAN_COMMAND: '/missing/scanner {file}',
        },
      },
    })

    assert.equal(result.ok, false)
    assert.equal(result.status, 503)
    assert.equal(result.scan.status, 'error')
    assert.equal(await exists(resolveInvoiceUploadFilePath('failure.pdf')), false)
    assert.deepEqual(await listQuarantineFiles(), [])
  })
})

test('same-name concurrent uploads scan isolated quarantine files', async () => {
  await withUploadRoot(async (root) => {
    const scriptPath = path.join(root, 'content-scanner.mjs')
    await writeFile(scriptPath, [
      'import { readFile } from "node:fs/promises"',
      'const content = await readFile(process.argv[2], "utf8")',
      'if (content.includes("infected")) process.exit(1)',
      'await new Promise((resolve) => setTimeout(resolve, 25))',
      'process.exit(0)',
      '',
    ].join('\n'))
    const scan = {
      env: {
        FILE_SCAN_MODE: 'command',
        FILE_SCAN_COMMAND: `${process.execPath} ${scriptPath} {file}`,
      },
    }

    const [clean, infected] = await Promise.all([
      storeInvoicePdfUpload('duplicate.pdf', Buffer.from('%PDF-1.7\nclean'), { scan }),
      storeInvoicePdfUpload('duplicate.pdf', Buffer.from('%PDF-1.7\ninfected'), { scan }),
    ])

    assert.equal(clean.ok, true)
    assert.equal(infected.ok, false)
    assert.equal(infected.scan.status, 'infected')
    assert.deepEqual(await readFile(resolveInvoiceUploadFilePath('duplicate.pdf') as string), Buffer.from('%PDF-1.7\nclean'))
    assert.deepEqual(await listQuarantineFiles(), [])
  })
})

test('promotion failures after a clean scan remove the quarantine file', async () => {
  await withUploadRoot(async (root) => {
    const finalPath = resolveInvoiceUploadFilePath('blocked.pdf') as string
    await mkdir(finalPath, { recursive: true })
    const scriptPath = await writeScannerScript(root, 0)

    await assert.rejects(
      storeInvoicePdfUpload('blocked.pdf', PDF_BUFFER, {
        scan: {
          env: {
            FILE_SCAN_MODE: 'command',
            FILE_SCAN_COMMAND: `${process.execPath} ${scriptPath} {file}`,
          },
        },
      }),
    )
    assert.deepEqual(await listQuarantineFiles(), [])
  })
})

test('disabled mode refuses to follow final-path symlinks', async () => {
  await withUploadRoot(async (root) => {
    const finalPath = resolveInvoiceUploadFilePath('symlink.pdf') as string
    const targetPath = path.join(root, 'target.txt')
    await mkdir(path.dirname(finalPath), { recursive: true })
    await writeFile(targetPath, 'original')
    await symlink(targetPath, finalPath)

    await assert.rejects(storeInvoicePdfUpload('symlink.pdf', PDF_BUFFER, {
      scan: { env: { FILE_SCAN_MODE: 'disabled' } },
    }))
    assert.equal(await readFile(targetPath, 'utf8'), 'original')
  })
})
