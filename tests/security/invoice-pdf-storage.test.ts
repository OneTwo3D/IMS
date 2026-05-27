import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  getInvoicePdfPath,
  getInvoicePdfStorageDir,
  loadInvoicePdf,
  saveInvoicePdfFile,
} from '@/lib/invoice-pdf'
import { withEnvPatch } from '@/tests/helpers/env'

const BINARY_PDF_BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0xff, 0x00, 0x80, 0x0a])

async function withInvoicePdfStorageEnv<T>(value: string | undefined, run: () => Promise<T> | T): Promise<T> {
  return withEnvPatch({ INVOICE_PDF_STORAGE_DIR: value }, run)
}

test('invoice PDF storage defaults to the local development data directory', async () => {
  await withInvoicePdfStorageEnv(undefined, () => {
    assert.equal(getInvoicePdfStorageDir(), path.resolve(process.cwd(), 'data', 'invoices'))
    assert.equal(getInvoicePdfPath('order-123'), path.resolve(process.cwd(), 'data', 'invoices', 'order-123.pdf'))
  })
})

test('invoice PDF storage uses the configured persistent directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ims-invoice-pdfs-'))
  try {
    await withInvoicePdfStorageEnv(root, async () => {
      const storedPath = await saveInvoicePdfFile('order-123', BINARY_PDF_BYTES)

      assert.equal(getInvoicePdfStorageDir(), root)
      assert.equal(storedPath, 'invoice-pdfs/order-123.pdf')
      assert.deepEqual(await readFile(path.join(root, 'order-123.pdf')), BINARY_PDF_BYTES)
      assert.deepEqual(await loadInvoicePdf('order-123'), BINARY_PDF_BYTES)
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('invoice PDF storage resolves relative configured directories against the current working directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ims-invoice-pdfs-relative-'))
  try {
    const relativeRoot = path.relative(process.cwd(), root)
    await withInvoicePdfStorageEnv(relativeRoot, () => {
      assert.equal(getInvoicePdfStorageDir(), root)
      assert.equal(getInvoicePdfPath('order-123'), path.join(root, 'order-123.pdf'))
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('invoice PDF storage treats empty configured directories as the local fallback', async () => {
  await withInvoicePdfStorageEnv('', () => {
    assert.equal(getInvoicePdfStorageDir(), path.resolve(process.cwd(), 'data', 'invoices'))
  })
})

test('invoice PDF storage rejects unsafe order ids before resolving paths', async () => {
  await withInvoicePdfStorageEnv(path.join(os.tmpdir(), 'ims-invoice-pdfs'), async () => {
    for (const unsafeId of [
      '',
      '.',
      '..',
      '../secret',
      'nested/order',
      'nested\\order',
      'foo\0bar',
      '-rf',
      'a'.repeat(10_000),
    ]) {
      assert.throws(() => getInvoicePdfPath(unsafeId), /Invalid invoice PDF order id for storage path/)
      assert.equal(await loadInvoicePdf(unsafeId), null)
    }
  })
})

test('invoice PDF storage allows portable ids and preserves binary bytes end to end', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ims-invoice-pdfs-safe-id-'))
  try {
    await withInvoicePdfStorageEnv(root, async () => {
      const orderId = 'Order_123-ABC.9'
      assert.equal(await saveInvoicePdfFile(orderId, BINARY_PDF_BYTES), 'invoice-pdfs/Order_123-ABC.9.pdf')
      assert.deepEqual(await loadInvoicePdf(orderId), BINARY_PDF_BYTES)
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('invoice PDF storage refuses symlinked target files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ims-invoice-pdfs-symlink-'))
  try {
    await symlink('/etc/passwd', path.join(root, 'pwn.pdf'))
    await withInvoicePdfStorageEnv(root, async () => {
      assert.equal(await loadInvoicePdf('pwn'), null)
      await assert.rejects(() => saveInvoicePdfFile('pwn', BINARY_PDF_BYTES), /symlink/)
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('invoice PDF storage does not create the production storage root implicitly', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ims-invoice-pdfs-prod-'))
  const missingRoot = path.join(root, 'missing')
  try {
    await withEnvPatch({ NODE_ENV: 'production', INVOICE_PDF_STORAGE_DIR: missingRoot }, async () => {
      await assert.rejects(() => saveInvoicePdfFile('order-123', BINARY_PDF_BYTES), /ENOENT/)
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
