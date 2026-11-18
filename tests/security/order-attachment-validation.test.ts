import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_ORDER_ATTACHMENT_BYTES,
  ORDER_ATTACHMENT_TYPES,
  attachmentContentDisposition,
  displayNameForAttachment,
  validateOrderAttachment,
} from '../../lib/security/order-attachment-validation.ts'
import { MAX_INVOICE_UPLOAD_BYTES } from '../../lib/security/upload-validation.ts'

/**
 * WHAT MAY BE ATTACHED TO AN ORDER. The type is decided from the bytes as well as the name: every allowed type has a genuine sample that must be
 * accepted (so the validator is not vacuously refusing everything), and each spoof below is a sample of one type under another type's name.
 */
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n', 'latin1')
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)])
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)])
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(32)])
const WEBP = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 ', 'latin1'), Buffer.alloc(32)])
const CSV = Buffer.from('sku,qty,price\nA-1,2,3.50\nB-2,1,9.00\n', 'utf8')
const XLSX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('[Content_Types].xml'), Buffer.alloc(8), Buffer.from('xl/workbook.xml')])
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('[Content_Types].xml'), Buffer.alloc(8), Buffer.from('word/document.xml')])
const PLAIN_ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('readme.txt'), Buffer.alloc(8)])
const EML = Buffer.from('From: Supplier <sales@supplier.example>\r\nTo: buyer@example.test\r\nSubject: Quote 123\r\nDate: Mon, 16 Nov 2026 10:00:00 +0000\r\nMIME-Version: 1.0\r\n\r\nPlease find the quote attached.\r\n', 'utf8')
const MSG = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)])
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64)])
const HTML = Buffer.from('<html><script>alert(1)</script></html>', 'utf8')

const GENUINE: Array<[string, Buffer, string]> = [
  ['quote.pdf', PDF, 'pdf'], ['photo.png', PNG, 'png'], ['photo.jpg', JPG, 'jpg'], ['photo.JPEG', JPG, 'jpg'], ['anim.gif', GIF, 'gif'], ['pic.webp', WEBP, 'webp'],
  ['lines.csv', CSV, 'csv'], ['book.xlsx', XLSX, 'xlsx'], ['letter.docx', DOCX, 'docx'], ['mail.eml', EML, 'eml'], ['mail.msg', MSG, 'msg'],
]

test('CONTROL: a genuine sample of every allowed type is accepted, and the stored type comes from the verified kind', () => {
  for (const [name, bytes, kind] of GENUINE) {
    const verdict = validateOrderAttachment(name, bytes)
    assert.equal(verdict.ok, true, `${name}: ${JSON.stringify(verdict)}`)
    if (verdict.ok) {
      assert.equal(verdict.kind, kind)
      assert.equal(verdict.mimeType, ORDER_ATTACHMENT_TYPES[verdict.kind].mimeType)
    }
  }
})

test('type spoofing: every type under every other type\'s extension is refused', () => {
  let refusals = 0
  for (const [, bytes, kind] of GENUINE) {
    for (const [name, , otherKind] of GENUINE) {
      if (otherKind === kind) continue
      // CSV is plain text: a text sample is genuinely what a .csv may be, and an .eml is text too. Those two pairs are not spoofs of each other.
      if ((kind === 'eml' && otherKind === 'csv') || (kind === 'csv' && otherKind === 'eml')) continue
      if (kind === 'jpg' && otherKind === 'jpg') continue
      const verdict = validateOrderAttachment(name, bytes)
      assert.equal(verdict.ok, false, `${kind} bytes named ${name} must be refused`)
      refusals += 1
    }
  }
  assert.ok(refusals > 80, `PRECONDITION: the matrix ran (${refusals})`)
})

test('the claimed type is not trusted: HTML, an executable and a plain zip under allowed names are refused', () => {
  for (const [name, bytes] of [['page.pdf', HTML], ['page.csv', EXE], ['tool.pdf', EXE], ['pic.png', HTML], ['sheet.xlsx', PLAIN_ZIP], ['doc.docx', PLAIN_ZIP], ['sheet.xlsx', DOCX], ['doc.docx', XLSX], ['mail.eml', HTML], ['note.msg', EML]] as Array<[string, Buffer]>) {
    const verdict = validateOrderAttachment(name, bytes)
    assert.equal(verdict.ok, false, name)
    if (!verdict.ok) assert.equal(verdict.status, 400)
  }
  // A binary file with a text extension: NUL bytes and control characters are not CSV.
  assert.equal(validateOrderAttachment('data.csv', Buffer.from([0x41, 0x2c, 0x00, 0x42])).ok, false)
  assert.equal(validateOrderAttachment('data.csv', Buffer.from([0xff, 0xfe, 0xfd, 0x41])).ok, false, 'invalid UTF-8')
  // An email without the header block of one.
  assert.equal(validateOrderAttachment('mail.eml', Buffer.from('hello there\r\nthis is not an email\r\n')).ok, false)
})

test('a disallowed type is refused by name whatever the content: SVG, HTML, scripts, archives, executables, no extension', () => {
  for (const name of ['logo.svg', 'page.html', 'run.js', 'run.sh', 'tool.exe', 'bundle.zip', 'a.tar.gz', 'macro.xlsm', 'old.doc', 'old.xls', 'noextension', '.pdf.exe', 'file.pdf.html']) {
    const verdict = validateOrderAttachment(name, PDF)
    assert.equal(verdict.ok, false, name)
    if (!verdict.ok) assert.match(verdict.error, /not accepted|does not match/)
  }
})

test('size: the limit is the existing upload limit; one byte over is refused with 413, an empty file with 400', () => {
  assert.equal(MAX_ORDER_ATTACHMENT_BYTES, MAX_INVOICE_UPLOAD_BYTES, 'the existing upload limit, not a new number')
  const atLimit = Buffer.concat([PDF, Buffer.alloc(MAX_ORDER_ATTACHMENT_BYTES - PDF.length, 0x20)])
  assert.equal(atLimit.length, MAX_ORDER_ATTACHMENT_BYTES)
  assert.equal(validateOrderAttachment('big.pdf', atLimit).ok, true, 'CONTROL: exactly at the limit is accepted')
  const over = validateOrderAttachment('big.pdf', Buffer.concat([atLimit, Buffer.from('x')]))
  assert.equal(over.ok, false)
  if (!over.ok) { assert.equal(over.status, 413); assert.match(over.error, /too large/i) }
  const empty = validateOrderAttachment('empty.pdf', Buffer.alloc(0))
  assert.equal(empty.ok, false)
  if (!empty.ok) assert.equal(empty.status, 400)
})

test('the display name never carries a path, control characters or quotes, keeps the verified extension, and the disposition is an attachment', () => {
  assert.equal(displayNameForAttachment('../../etc/passwd', 'pdf'), 'passwd.pdf')
  assert.equal(displayNameForAttachment('C:\\Users\\a\\quote final.PDF', 'pdf'), 'quote final.pdf')
  assert.equal(displayNameForAttachment('we"ird\r\nname.pdf', 'pdf'), 'we_ird_name.pdf')
  assert.equal(displayNameForAttachment('.pdf', 'pdf'), 'attachment.pdf')
  assert.equal(displayNameForAttachment('x'.repeat(500) + '.pdf', 'pdf').length, 124)
  const header = attachmentContentDisposition('Zoë "quote".pdf')
  assert.match(header, /^attachment; filename="[^"\\]*"; filename\*=UTF-8''/)
  assert.doesNotMatch(header, /inline/)
})
