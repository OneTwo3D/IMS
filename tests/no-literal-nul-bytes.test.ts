import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

// A literal NUL byte in a source file makes file(1) classify it as binary, so grep silently returns NO
// matches for the whole file — a grep-based audit reads as "the code isn't there" (onetwo3d-ims-6oyu.21).
// It bit real work: sync-processor.ts used NUL as a composite-key delimiter and hs-classification-fields.ts
// as a join delimiter. Both are now the \x00 ESCAPE (identical runtime, text source).
//
// This guard scans EVERY tracked file except a small, explicit BINARY allowlist, so shell scripts, the
// PHP plugin, TOML/YAML, .env examples, systemd units, CSVs and extensionless hooks are all covered — a
// NUL anywhere in them would otherwise still blind grep while a narrow extension allowlist passed. It
// FAILS (does not skip) if a selected tracked file cannot be read.
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.bmp',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.pdf', '.zip', '.gz', '.tgz', '.bz2', '.7z', '.bundle', '.wasm',
  '.mp4', '.mov', '.webm', '.mp3', '.wav', '.ogg',
  '.db', '.sqlite', '.sqlite3', '.parquet',
])

test('no tracked text file contains a literal NUL byte (grep-blindness guard, 6oyu.21)', () => {
  const repoRoot = path.resolve(__dirname, '..')
  const files = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((f) => !BINARY_EXTENSIONS.has(path.extname(f).toLowerCase()))

  const offenders: string[] = []
  for (const rel of files) {
    // Intentionally NOT wrapped in try/catch: a tracked non-binary file that cannot be read is itself a
    // problem, and a silent skip is exactly how the original NUL hazard hid. Let it throw and fail loudly.
    if (readFileSync(path.join(repoRoot, rel)).includes(0)) offenders.push(rel)
  }
  assert.deepEqual(offenders, [], `literal NUL bytes found in: ${offenders.join(', ')} — use the \\x00 escape instead`)
})
