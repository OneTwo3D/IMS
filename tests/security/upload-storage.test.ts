import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import {
  filenameFromBrandingUploadUrl,
  getAvatarUploadDir,
  getAvatarUploadUrl,
  getBrandingUploadDir,
  getBrandingUploadUrl,
  getInvoiceStoredPath,
  getInvoiceUploadDir,
  getInvoiceUploadUrl,
  getPrivateUploadRoot,
  getPublicUploadRoot,
  getUploadStorageDirectories,
  resolveAvatarUploadFilePath,
  resolveBrandingUploadFilePath,
  resolveInvoiceUploadFilePath,
  resolveStoredInvoiceUploadPath,
} from '@/lib/upload-storage'

function withUploadEnv(
  env: { UPLOAD_STORAGE_DIR?: string; PUBLIC_UPLOAD_STORAGE_DIR?: string },
  run: () => void,
): void {
  const previousPrivate = process.env.UPLOAD_STORAGE_DIR
  const previousPublic = process.env.PUBLIC_UPLOAD_STORAGE_DIR
  try {
    if (env.UPLOAD_STORAGE_DIR === undefined) {
      delete process.env.UPLOAD_STORAGE_DIR
    } else {
      process.env.UPLOAD_STORAGE_DIR = env.UPLOAD_STORAGE_DIR
    }
    if (env.PUBLIC_UPLOAD_STORAGE_DIR === undefined) {
      delete process.env.PUBLIC_UPLOAD_STORAGE_DIR
    } else {
      process.env.PUBLIC_UPLOAD_STORAGE_DIR = env.PUBLIC_UPLOAD_STORAGE_DIR
    }
    run()
  } finally {
    if (previousPrivate === undefined) {
      delete process.env.UPLOAD_STORAGE_DIR
    } else {
      process.env.UPLOAD_STORAGE_DIR = previousPrivate
    }
    if (previousPublic === undefined) {
      delete process.env.PUBLIC_UPLOAD_STORAGE_DIR
    } else {
      process.env.PUBLIC_UPLOAD_STORAGE_DIR = previousPublic
    }
  }
}

test('upload storage roots default to local development directories', () => {
  withUploadEnv({}, () => {
    assert.equal(getPrivateUploadRoot(), path.resolve(process.cwd(), 'uploads'))
    assert.equal(getPublicUploadRoot(), path.resolve(process.cwd(), 'public', 'uploads'))
    assert.equal(getInvoiceUploadDir(), path.resolve(process.cwd(), 'uploads', 'invoices'))
    assert.equal(getAvatarUploadDir(), path.resolve(process.cwd(), 'public', 'uploads', 'avatars'))
    assert.equal(getBrandingUploadDir(), path.resolve(process.cwd(), 'public', 'uploads', 'branding'))
  })
})

test('upload storage roots use configured persistent directories', () => {
  const privateRoot = path.join('/tmp', 'ims-private-uploads')
  const publicRoot = path.join('/tmp', 'ims-public-uploads')

  withUploadEnv({ UPLOAD_STORAGE_DIR: privateRoot, PUBLIC_UPLOAD_STORAGE_DIR: publicRoot }, () => {
    assert.equal(getPrivateUploadRoot(), privateRoot)
    assert.equal(getPublicUploadRoot(), publicRoot)
    assert.deepEqual(getUploadStorageDirectories(), [
      { label: 'avatarUploads', directory: path.join(publicRoot, 'avatars') },
      { label: 'brandingUploads', directory: path.join(publicRoot, 'branding') },
      { label: 'invoiceUploads', directory: path.join(privateRoot, 'invoices') },
    ])
  })
})

test('upload file path resolution rejects traversal and disallowed extensions', () => {
  withUploadEnv({
    UPLOAD_STORAGE_DIR: path.join('/tmp', 'ims-private-uploads'),
    PUBLIC_UPLOAD_STORAGE_DIR: path.join('/tmp', 'ims-public-uploads'),
  }, () => {
    assert.equal(resolveInvoiceUploadFilePath('../invoice.pdf'), null)
    assert.equal(resolveInvoiceUploadFilePath('nested/invoice.pdf'), null)
    assert.equal(resolveInvoiceUploadFilePath('invoice.png'), null)
    assert.equal(resolveAvatarUploadFilePath('avatar.svg'), null)
    assert.equal(resolveBrandingUploadFilePath('..\\logo.png'), null)
    assert.equal(resolveBrandingUploadFilePath('logo.gif'), null)

    assert.equal(
      resolveInvoiceUploadFilePath('supplier-123.pdf'),
      path.join('/tmp', 'ims-private-uploads', 'invoices', 'supplier-123.pdf'),
    )
    assert.equal(
      resolveAvatarUploadFilePath('user_123.webp'),
      path.join('/tmp', 'ims-public-uploads', 'avatars', 'user_123.webp'),
    )
    assert.equal(
      resolveBrandingUploadFilePath('document-logo.png'),
      path.join('/tmp', 'ims-public-uploads', 'branding', 'document-logo.png'),
    )
  })
})

test('upload URL helpers preserve logical invoice paths and contain uploaded filenames', () => {
  withUploadEnv({ UPLOAD_STORAGE_DIR: path.join('/tmp', 'ims-private-uploads') }, () => {
    assert.equal(getInvoiceUploadUrl('123-invoice.pdf'), '/uploads/invoices/123-invoice.pdf')
    assert.equal(getInvoiceStoredPath('123-invoice.pdf'), 'uploads/invoices/123-invoice.pdf')
    assert.equal(
      resolveStoredInvoiceUploadPath('/uploads/invoices/123-invoice.pdf'),
      path.join('/tmp', 'ims-private-uploads', 'invoices', '123-invoice.pdf'),
    )
    assert.equal(resolveStoredInvoiceUploadPath('/uploads/invoices/../secret.pdf'), null)
    assert.equal(resolveStoredInvoiceUploadPath('/uploads/branding/logo.png'), null)
  })
})

test('branding upload URL extraction rejects traversal payloads', () => {
  assert.equal(filenameFromBrandingUploadUrl('/api/uploads/branding/logo.png?t=1'), 'logo.png')
  assert.equal(filenameFromBrandingUploadUrl('/uploads/branding/document-logo.webp'), 'document-logo.webp')
  assert.equal(filenameFromBrandingUploadUrl('/api/uploads/branding//file.png'), null)
  assert.equal(filenameFromBrandingUploadUrl('/api/uploads/branding/%2e%2e%2flogo.png'), null)
  assert.equal(filenameFromBrandingUploadUrl('/api/uploads/branding/logo.svg'), 'logo.svg')
})

test('avatar and branding URL helpers use stable path shapes', () => {
  assert.equal(getAvatarUploadUrl('user_123.webp', 1234), '/uploads/avatars/user_123.webp?t=1234')
  assert.equal(getBrandingUploadUrl('logo-1234.png'), '/api/uploads/branding/logo-1234.png')
})
