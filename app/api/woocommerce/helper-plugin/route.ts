/**
 * Download endpoint for the "onetwoInventory Helper" WordPress plugin.
 *
 * Serves a zip uploadable via WP admin → Plugins → Add New → Upload.
 *
 * The zip wraps the single-file plugin under
 * `onetwoinventory-helper/onetwoinventory-helper.php`, which is the layout
 * WordPress's plugin installer expects.
 *
 * Implementation note: we hand-roll a minimal STORED (uncompressed) zip rather
 * than pull in jszip / archiver. The plugin file is small (~10 KB) so the
 * size cost of skipping deflate is negligible, and the resulting code has no
 * external dependencies. Node 22's built-in `zlib.crc32` covers the only
 * non-trivial part of the zip format.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'

import { requirePermission } from '@/lib/auth/server'

const PLUGIN_FOLDER = 'onetwoinventory-helper'
const PLUGIN_FILENAME = 'onetwoinventory-helper.php'

export async function GET() {
  // Same gate as other WooCommerce sync controls.
  await requirePermission('sync')

  const sourcePath = join(
    /* turbopackIgnore: true */ process.cwd(),
    'lib/connectors/woocommerce/wp-plugin',
    PLUGIN_FILENAME,
  )
  const phpBytes = await readFile(sourcePath)

  const zipBytes = buildZip([
    { path: `${PLUGIN_FOLDER}/${PLUGIN_FILENAME}`, content: phpBytes },
  ])

  return new Response(new Uint8Array(zipBytes), {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${PLUGIN_FOLDER}.zip"`,
      'Content-Length': String(zipBytes.length),
      'Cache-Control': 'no-store',
    },
  })
}

// ---------------------------------------------------------------------------
// Minimal STORED-only zip writer.
//
// References:
//   - PKZIP APPNOTE.TXT, sections 4.3.7 (local file header) and 4.3.16
//     (central directory).
//
// Only supports STORED (compression method 0). All file paths are encoded
// as UTF-8 (general-purpose flag bit 11).
// ---------------------------------------------------------------------------

type ZipEntry = { path: string; content: Buffer }

function buildZip(entries: ZipEntry[]): Buffer {
  const localChunks: Buffer[] = []
  const centralChunks: Buffer[] = []
  let offset = 0

  // DOS time/date — pin to a fixed value so identical inputs produce
  // identical zips (handy for caching / hashing).
  const dosTime = 0
  const dosDate = (((2026 - 1980) & 0x7f) << 9) | (1 << 5) | 1 // 2026-01-01

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.path, 'utf8')
    const crc = crc32(entry.content) >>> 0
    const size = entry.content.length

    const local = Buffer.alloc(30 + nameBytes.length + size)
    local.writeUInt32LE(0x04034b50, 0) // local file header signature
    local.writeUInt16LE(20, 4)         // version needed to extract
    local.writeUInt16LE(0x0800, 6)     // general purpose bit flag (UTF-8 names)
    local.writeUInt16LE(0, 8)          // compression method (STORED)
    local.writeUInt16LE(dosTime, 10)
    local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(size, 18)      // compressed size
    local.writeUInt32LE(size, 22)      // uncompressed size
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)         // extra field length
    nameBytes.copy(local, 30)
    entry.content.copy(local, 30 + nameBytes.length)
    localChunks.push(local)

    const central = Buffer.alloc(46 + nameBytes.length)
    central.writeUInt32LE(0x02014b50, 0) // central directory file header signature
    central.writeUInt16LE(20, 4)         // version made by
    central.writeUInt16LE(20, 6)         // version needed to extract
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(dosTime, 12)
    central.writeUInt16LE(dosDate, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(size, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0, 30)         // extra field length
    central.writeUInt16LE(0, 32)         // file comment length
    central.writeUInt16LE(0, 34)         // disk number start
    central.writeUInt16LE(0, 36)         // internal file attributes
    central.writeUInt32LE(0, 38)         // external file attributes
    central.writeUInt32LE(offset, 42)    // local header offset
    nameBytes.copy(central, 46)
    centralChunks.push(central)

    offset += local.length
  }

  const localBuf = Buffer.concat(localChunks)
  const centralBuf = Buffer.concat(centralChunks)

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)              // end of central dir signature
  eocd.writeUInt16LE(0, 4)                        // disk number
  eocd.writeUInt16LE(0, 6)                        // disk with central dir
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(localBuf.length, 16)         // central dir offset
  eocd.writeUInt16LE(0, 20)                       // comment length

  return Buffer.concat([localBuf, centralBuf, eocd])
}
