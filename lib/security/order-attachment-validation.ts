import path from 'node:path'
import { MAX_ORDER_ATTACHMENT_BYTES, ORDER_ATTACHMENT_ALLOWED_TEXT } from '@/lib/order-attachment-types'

/**
 * WHAT MAY BE ATTACHED TO AN ORDER, decided from the BYTES as well as the name.
 *
 * The browser's file name and content type are claims, not evidence. A file is accepted only when its extension is on the allowlist AND its
 * leading bytes (and, for text types, its whole body) are what that extension says. The stored type, the stored extension and the type served
 * on download all come from the verified kind below, never from the claim, so a renamed executable or an HTML page called `.pdf` is refused
 * here and could not be served as anything but a download anyway.
 *
 * SVG, HTML, scripts and archives are deliberately NOT allowed: they can carry active content. XLSX and DOCX are zip packages and are checked
 * for their own package parts, so an arbitrary zip renamed `.xlsx` is refused.
 */
export { MAX_ORDER_ATTACHMENT_BYTES, ORDER_ATTACHMENT_ACCEPT, ORDER_ATTACHMENT_ALLOWED_TEXT } from '@/lib/order-attachment-types'

export type OrderAttachmentFileKind = 'pdf' | 'png' | 'jpg' | 'gif' | 'webp' | 'csv' | 'xlsx' | 'docx' | 'eml' | 'msg'

export type OrderAttachmentTypeInfo = { extension: OrderAttachmentFileKind; mimeType: string; label: string }

export const ORDER_ATTACHMENT_TYPES: Readonly<Record<OrderAttachmentFileKind, OrderAttachmentTypeInfo>> = {
  pdf: { extension: 'pdf', mimeType: 'application/pdf', label: 'PDF' },
  png: { extension: 'png', mimeType: 'image/png', label: 'PNG image' },
  jpg: { extension: 'jpg', mimeType: 'image/jpeg', label: 'JPEG image' },
  gif: { extension: 'gif', mimeType: 'image/gif', label: 'GIF image' },
  webp: { extension: 'webp', mimeType: 'image/webp', label: 'WebP image' },
  csv: { extension: 'csv', mimeType: 'text/csv', label: 'CSV' },
  xlsx: { extension: 'xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', label: 'Excel workbook' },
  docx: { extension: 'docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', label: 'Word document' },
  eml: { extension: 'eml', mimeType: 'message/rfc822', label: 'Email (.eml)' },
  msg: { extension: 'msg', mimeType: 'application/vnd.ms-outlook', label: 'Email (.msg)' },
}

const EXTENSION_TO_KIND: Readonly<Record<string, OrderAttachmentFileKind>> = {
  pdf: 'pdf', png: 'png', jpg: 'jpg', jpeg: 'jpg', gif: 'gif', webp: 'webp', csv: 'csv', xlsx: 'xlsx', docx: 'docx', eml: 'eml', msg: 'msg',
}

export type OrderAttachmentValidation =
  | { ok: true; kind: OrderAttachmentFileKind; mimeType: string; extension: string }
  | { ok: false; error: string; status: 400 | 413 }

export function orderAttachmentKindFromName(name: string): OrderAttachmentFileKind | null {
  const ext = path.extname(name).slice(1).toLowerCase()
  return EXTENSION_TO_KIND[ext] ?? null
}

const startsWith = (buffer: Buffer, bytes: readonly number[]) => buffer.length >= bytes.length && bytes.every((b, i) => buffer[i] === b)
const asciiAt = (buffer: Buffer, offset: number, text: string) => buffer.length >= offset + text.length && buffer.subarray(offset, offset + text.length).toString('latin1') === text

/** Text must be UTF-8 (a BOM is fine), with no NUL byte and no other C0 control but tab, CR, LF, form feed (a binary file renamed .csv has them). */
function looksLikeText(buffer: Buffer): boolean {
  if (buffer.length === 0) return false
  if (buffer.includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return false
  }
  for (const byte of buffer) {
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x0c) return false
  }
  return true
}

/** Text that opens like another document type (a PDF, HTML, SVG/XML, a script) is not a CSV, whatever its name says. */
const FOREIGN_TEXT_PREFIX = /^(?:\uFEFF)?\s*(?:%PDF-|GIF8[79]a|<\s*(?:!doctype|html|\?xml|svg|script|iframe|body|head)\b)/i

function looksLikeCsv(buffer: Buffer): boolean {
  if (!looksLikeText(buffer)) return false
  return !FOREIGN_TEXT_PREFIX.test(buffer.subarray(0, 256).toString('utf8'))
}

/** A zip package: local file header, and the package parts that make it an Office document of the claimed kind. */
function isOfficePackage(buffer: Buffer, requiredPart: string): boolean {
  if (!startsWith(buffer, [0x50, 0x4b, 0x03, 0x04])) return false
  // Entry names sit in clear text in the local headers and the central directory; both must name the content-types part and the kind's own part.
  const text = buffer.toString('latin1')
  return text.includes('[Content_Types].xml') && text.includes(requiredPart)
}

const EML_HEADER = /^(from|to|cc|bcc|date|subject|message-id|mime-version|received|return-path|delivered-to|reply-to|x-[a-z0-9-]+|content-type):/i

/** An .eml is a header block (RFC 5322) then a body. Only the header block is held to text rules: a body may legitimately be 8-bit. */
function looksLikeEml(buffer: Buffer): boolean {
  const window = buffer.subarray(0, 64 * 1024)
  const crlf = window.indexOf('\r\n\r\n')
  const lf = window.indexOf('\n\n')
  const ends = [crlf, lf].filter((i) => i >= 0)
  const headerBytes = ends.length > 0 ? window.subarray(0, Math.min(...ends)) : window
  if (headerBytes.includes(0)) return false
  const lines = headerBytes.toString('latin1').replace(/^\xEF\xBB\xBF/, '').split(/\r?\n/)
  let first = 0
  while (first < lines.length && lines[first]!.trim() === '') first += 1
  // A mailbox export may start with an mbox "From " separator line.
  if (lines[first]?.startsWith('From ')) first += 1
  if (!EML_HEADER.test(lines[first] ?? '')) return false
  let recognised = 0
  let core = false
  for (let i = first; i < lines.length; i += 1) {
    const line = lines[i]!
    if (/^[ \t]/.test(line)) continue // folded header
    if (!/^[A-Za-z][A-Za-z0-9-]*:/.test(line)) return false
    if (EML_HEADER.test(line)) recognised += 1
    if (/^(from|to|date|subject|message-id|mime-version|received):/i.test(line)) core = true
  }
  return recognised >= 2 && core
}

function contentMatches(kind: OrderAttachmentFileKind, buffer: Buffer): boolean {
  switch (kind) {
    case 'pdf': return asciiAt(buffer, 0, '%PDF-')
    case 'png': return startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    case 'jpg': return startsWith(buffer, [0xff, 0xd8, 0xff])
    case 'gif': return asciiAt(buffer, 0, 'GIF87a') || asciiAt(buffer, 0, 'GIF89a')
    case 'webp': return asciiAt(buffer, 0, 'RIFF') && asciiAt(buffer, 8, 'WEBP')
    case 'csv': return looksLikeCsv(buffer)
    case 'xlsx': return isOfficePackage(buffer, 'xl/')
    case 'docx': return isOfficePackage(buffer, 'word/')
    case 'eml': return looksLikeEml(buffer)
    // OLE2 compound file (Outlook .msg).
    case 'msg': return startsWith(buffer, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
  }
}

/**
 * Validate an upload. `claimedName` selects the kind by extension; the bytes must then be that kind. Size is checked first (cheap) and the
 * limit is the existing upload limit (MAX_INVOICE_UPLOAD_BYTES). An empty file is refused.
 */
export function validateOrderAttachment(claimedName: string, buffer: Buffer): OrderAttachmentValidation {
  if (buffer.length === 0) return { ok: false, status: 400, error: 'The file is empty.' }
  if (buffer.length > MAX_ORDER_ATTACHMENT_BYTES) {
    return { ok: false, status: 413, error: `File too large. Maximum ${Math.round(MAX_ORDER_ATTACHMENT_BYTES / (1024 * 1024))}MB.` }
  }
  const kind = orderAttachmentKindFromName(claimedName)
  if (!kind) return { ok: false, status: 400, error: `This file type is not accepted. Allowed: ${ORDER_ATTACHMENT_ALLOWED_TEXT}.` }
  if (!contentMatches(kind, buffer)) {
    return { ok: false, status: 400, error: `The file content does not match its ${ORDER_ATTACHMENT_TYPES[kind].label} type.` }
  }
  const info = ORDER_ATTACHMENT_TYPES[kind]
  return { ok: true, kind, mimeType: info.mimeType, extension: info.extension }
}

/**
 * The name shown to staff and offered on download: the base name only, control characters, path separators and quotes replaced, length capped,
 * the verified extension kept. It never locates a file.
 */
export function displayNameForAttachment(claimedName: string, extension: string): string {
  const base = claimedName.split(/[\\/]/).pop() ?? ''
  const stem = base.replace(/\.[^.]*$/, '')
  const cleaned = stem
    .replace(/[\u0000-\u001f\u007f"\\/:*?<>|;]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
  return `${cleaned || 'attachment'}.${extension}`
}

/** A Content-Disposition value with an ASCII fallback and the RFC 5987 form for the full name. */
export function attachmentContentDisposition(displayName: string): string {
  const ascii = displayName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(displayName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`
}
