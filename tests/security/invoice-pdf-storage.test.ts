import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  getInvoicePdfPath,
  getInvoicePdfStorageDir,
  loadInvoicePdf,
  saveInvoicePdfFile,
} from '@/lib/invoice-pdf'

async function withInvoicePdfStorageEnv<T>(
  value: string | undefined,
  run: () => Promise<T> | T,
): Promise<T> {
  const previous = process.env.INVOICE_PDF_STORAGE_DIR
  try {
    if (value === undefined) {
      delete process.env.INVOICE_PDF_STORAGE_DIR
    } else {
      process.env.INVOICE_PDF_STORAGE_DIR = value
    }
    return await run()
  } finally {
    if (previous === undefined) {
      delete process.env.INVOICE_PDF_STORAGE_DIR
    } else {
      process.env.INVOICE_PDF_STORAGE_DIR = previous
    }
  }
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
      const storedPath = await saveInvoicePdfFile('order-123', Buffer.from('%PDF-1.4 test'))

      assert.equal(getInvoicePdfStorageDir(), root)
      assert.equal(storedPath, 'invoice-pdfs/order-123.pdf')
      assert.equal(await readFile(path.join(root, 'order-123.pdf'), 'utf8'), '%PDF-1.4 test')
      assert.deepEqual(await loadInvoicePdf('order-123'), Buffer.from('%PDF-1.4 test'))
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('invoice PDF storage rejects unsafe order ids before resolving paths', async () => {
  await withInvoicePdfStorageEnv(path.join(os.tmpdir(), 'ims-invoice-pdfs'), async () => {
    assert.throws(() => getInvoicePdfPath('../secret'), /Invalid invoice PDF order id/)
    assert.throws(() => getInvoicePdfPath('nested/order'), /Invalid invoice PDF order id/)
    assert.equal(await loadInvoicePdf('../secret'), null)
  })
})
