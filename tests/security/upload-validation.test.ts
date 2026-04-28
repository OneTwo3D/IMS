import assert from 'node:assert/strict'
import test from 'node:test'

import sharp from 'sharp'

import {
  AVATAR_IMAGE_MIME_TO_EXT,
  LOGO_IMAGE_MIME_TO_EXT,
  MAX_AVATAR_UPLOAD_BYTES,
  MAX_INVOICE_UPLOAD_BYTES,
  MAX_LOGO_UPLOAD_BYTES,
  hasPdfMagicBytes,
  reencodeTrustedImage,
  sanitizeInvoiceUploadFilename,
  validateImageUploadMetadata,
  validateInvoicePdfMetadata,
} from '@/lib/security/upload-validation'

test('image upload metadata rejects wrong MIME types, SVG, and oversized files', () => {
  const invalidAvatar = validateImageUploadMetadata(
    { name: 'avatar.txt', type: 'text/plain', size: 12 },
    {
      mimeToExt: AVATAR_IMAGE_MIME_TO_EXT,
      maxBytes: MAX_AVATAR_UPLOAD_BYTES,
      invalidTypeMessage: 'invalid avatar type',
      tooLargeMessage: 'avatar too large',
    },
  )
  assert.deepEqual(invalidAvatar, { ok: false, error: 'invalid avatar type' })

  const svgLogo = validateImageUploadMetadata(
    { name: 'logo.svg', type: 'image/svg+xml', size: 128 },
    {
      mimeToExt: LOGO_IMAGE_MIME_TO_EXT,
      maxBytes: MAX_LOGO_UPLOAD_BYTES,
      invalidTypeMessage: 'invalid logo type',
      tooLargeMessage: 'logo too large',
    },
  )
  assert.deepEqual(svgLogo, { ok: false, error: 'invalid logo type' })

  const oversizedLogo = validateImageUploadMetadata(
    { name: 'logo.png', type: 'image/png', size: MAX_LOGO_UPLOAD_BYTES + 1 },
    {
      mimeToExt: LOGO_IMAGE_MIME_TO_EXT,
      maxBytes: MAX_LOGO_UPLOAD_BYTES,
      invalidTypeMessage: 'invalid logo type',
      tooLargeMessage: 'logo too large',
    },
  )
  assert.deepEqual(oversizedLogo, { ok: false, error: 'logo too large' })
})

test('image upload re-encoding rejects empty files and SVG script payloads disguised as PNG', async () => {
  assert.equal(await reencodeTrustedImage(Buffer.alloc(0), 'png'), null)

  const svgScript = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
  assert.equal(await reencodeTrustedImage(svgScript, 'png'), null)
})

test('image upload re-encoding accepts a real image matching the claimed MIME family', async () => {
  const input = await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 4,
      background: '#ffffff',
    },
  }).png().toBuffer()

  const output = await reencodeTrustedImage(input, 'png')
  assert.ok(output)
  assert.equal((await sharp(output).metadata()).format, 'png')
})

test('invoice PDF upload validation rejects wrong MIME, oversized, and empty files', () => {
  assert.deepEqual(validateInvoicePdfMetadata({ name: 'invoice.png', type: 'image/png', size: 10 }), {
    ok: false,
    error: 'Only PDF files are accepted',
  })
  assert.deepEqual(validateInvoicePdfMetadata({
    name: 'invoice.pdf',
    type: 'application/pdf',
    size: MAX_INVOICE_UPLOAD_BYTES + 1,
  }), {
    ok: false,
    error: 'File too large. Maximum 20MB.',
  })
  assert.equal(hasPdfMagicBytes(Buffer.alloc(0)), false)
  assert.equal(hasPdfMagicBytes(Buffer.from('%PDF-1.7\n')), true)
})

test('invoice upload filename sanitizer contains traversal and documents double-extension behavior', () => {
  assert.equal(sanitizeInvoiceUploadFilename('../../secret.pdf', 1234), '1234-secret.pdf')

  const windowsTraversal = sanitizeInvoiceUploadFilename('..\\..\\secret.pdf', 1234)
  assert.equal(windowsTraversal.includes('/'), false)
  assert.equal(windowsTraversal.includes('\\'), false)
  assert.equal(windowsTraversal, '1234-.._.._secret.pdf')

  // Current behavior: a double-extension base is preserved, but the served file
  // is forced to the PDF extension and validated by MIME plus PDF magic bytes.
  assert.equal(sanitizeInvoiceUploadFilename('invoice.jpg.pdf', 1234), '1234-invoice.jpg.pdf')
})
