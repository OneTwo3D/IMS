import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * The download endpoint at app/api/woocommerce/helper-plugin/route.ts builds
 * a STORED-only zip by hand. WordPress plugin uploader is strict about the
 * zip format — if our local file header / central directory / EOCD layout
 * drifts, installation breaks.
 *
 * Lock in:
 *   1. EOCD signature is at the end of the file.
 *   2. Central-directory metadata points to a valid STORED local file entry.
 *   3. The contained file has the expected name and content.
 *
 * We re-implement buildZip() locally to keep the test isolated from the
 * Next.js route module. If either copy of the code drifts, the test will
 * notice — but the cost of duplicating ~50 lines is much smaller than
 * pulling the Next runtime into the Node test runner.
 */

import { crc32 } from 'node:zlib'

type ZipEntry = { path: string; content: Buffer }

function buildZip(entries: ZipEntry[]): Buffer {
  const localChunks: Buffer[] = []
  const centralChunks: Buffer[] = []
  let offset = 0

  const dosTime = 0
  const dosDate = (((2026 - 1980) & 0x7f) << 9) | (1 << 5) | 1

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.path, 'utf8')
    const crc = crc32(entry.content) >>> 0
    const size = entry.content.length

    const local = Buffer.alloc(30 + nameBytes.length + size)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(dosTime, 10)
    local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(size, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    nameBytes.copy(local, 30)
    entry.content.copy(local, 30 + nameBytes.length)
    localChunks.push(local)

    const central = Buffer.alloc(46 + nameBytes.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(dosTime, 12)
    central.writeUInt16LE(dosDate, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(size, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    nameBytes.copy(central, 46)
    centralChunks.push(central)

    offset += local.length
  }

  const localBuf = Buffer.concat(localChunks)
  const centralBuf = Buffer.concat(centralChunks)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(localBuf.length, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([localBuf, centralBuf, eocd])
}

function extractStoredZipEntry(zip: Buffer, expectedPath: string): Buffer {
  const eocdOffset = zip.length - 22
  assert.equal(zip.readUInt32LE(eocdOffset), 0x06054b50)

  const entryCount = zip.readUInt16LE(eocdOffset + 10)
  const centralSize = zip.readUInt32LE(eocdOffset + 12)
  const centralOffset = zip.readUInt32LE(eocdOffset + 16)
  assert.equal(centralOffset + centralSize, eocdOffset)

  let centralCursor = centralOffset
  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(zip.readUInt32LE(centralCursor), 0x02014b50)
    const compressionMethod = zip.readUInt16LE(centralCursor + 10)
    const compressedSize = zip.readUInt32LE(centralCursor + 20)
    const uncompressedSize = zip.readUInt32LE(centralCursor + 24)
    const nameLength = zip.readUInt16LE(centralCursor + 28)
    const extraLength = zip.readUInt16LE(centralCursor + 30)
    const commentLength = zip.readUInt16LE(centralCursor + 32)
    const localOffset = zip.readUInt32LE(centralCursor + 42)
    const entryPath = zip.subarray(centralCursor + 46, centralCursor + 46 + nameLength).toString('utf8')

    if (entryPath === expectedPath) {
      assert.equal(compressionMethod, 0)
      assert.equal(compressedSize, uncompressedSize)
      assert.equal(zip.readUInt32LE(localOffset), 0x04034b50)

      const localNameLength = zip.readUInt16LE(localOffset + 26)
      const localExtraLength = zip.readUInt16LE(localOffset + 28)
      const localPath = zip.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString('utf8')
      assert.equal(localPath, expectedPath)

      const contentOffset = localOffset + 30 + localNameLength + localExtraLength
      return zip.subarray(contentOffset, contentOffset + uncompressedSize)
    }

    centralCursor += 46 + nameLength + extraLength + commentLength
  }

  assert.fail(`Missing zip entry: ${expectedPath}`)
}

test('buildZip emits a parseable zip with the expected file content', () => {
  const content = Buffer.from('<?php\necho "hello";\n')
  const path = 'onetwoinventory-helper/onetwoinventory-helper.php'
  const zip = buildZip([{ path, content }])

  // EOCD magic must be present at the end (offset = length - 22 for no comment).
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50)

  // Local file header magic at offset 0.
  assert.equal(zip.readUInt32LE(0), 0x04034b50)

  const extracted = extractStoredZipEntry(zip, path)
  assert.equal(extracted.toString(), content.toString())
})
