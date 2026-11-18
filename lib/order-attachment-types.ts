/**
 * CLIENT-SAFE CONSTANTS for order attachments (no Node or server imports), shared by the upload validation (lib/security/order-attachment-validation.ts)
 * and the attachments card. The server is the authority: these only shape the file picker and the hint text.
 */

/** The existing upload limit (MAX_INVOICE_UPLOAD_BYTES in lib/security/upload-validation.ts, 20 MB); a test pins that they are equal. */
export const MAX_ORDER_ATTACHMENT_BYTES = 20 * 1024 * 1024

/** Browser-side `accept` list for the file picker (a convenience only: the server decides). */
export const ORDER_ATTACHMENT_ACCEPT = '.pdf,.png,.jpg,.jpeg,.gif,.webp,.csv,.xlsx,.docx,.eml,.msg'

export const ORDER_ATTACHMENT_ALLOWED_TEXT = 'PDF, images (PNG, JPEG, GIF, WebP), CSV, Excel (.xlsx), Word (.docx) and email (.eml, .msg)'
