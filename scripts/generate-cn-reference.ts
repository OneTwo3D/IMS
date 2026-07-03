/**
 * Regenerate the 2026 EU CN8 code list consumed by lib/trade/cn-validate.ts.
 *
 * Source of truth: lib/trade/cn-reference/cn2026.csv (a copy of the hs-code-woo plugin's
 * cn-reference/cn2026.csv — see docs; keep the two in sync when the CN list is updated).
 * Output: lib/trade/cn-reference/cn2026-codes.json (a sorted JSON array of declarable CN8 codes).
 *
 * Columns: code,description,status,superseded_by. Only `description` is quoted / may contain
 * commas, so after splitting on ',' the `code` is field 0 and `status` is the second-from-last
 * field (superseded_by, a bare CN code or empty, is last). No CSV row spans multiple lines
 * (row count == line count), so line-based parsing is safe. Only `status: current` codes are
 * emitted (parity with the plugin — a superseded/absent code is not declarable).
 *
 * Run: npm run cli -- ... is not wired; invoke directly with `npx tsx scripts/generate-cn-reference.ts`.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REF_DIR = join(process.cwd(), 'lib', 'trade', 'cn-reference')
const CSV_PATH = join(REF_DIR, 'cn2026.csv')
const JSON_PATH = join(REF_DIR, 'cn2026-codes.json')

function main(): void {
  const lines = readFileSync(CSV_PATH, 'utf8').split(/\r?\n/)
  const header = lines.shift() ?? ''
  if (header.split(',').join(',') !== 'code,description,status,superseded_by') {
    throw new Error(`Unexpected CN reference header: ${header}`)
  }

  const unquote = (value: string): string => value.trim().replace(/^"|"$/g, '').trim()

  const codes = new Set<string>()
  for (const line of lines) {
    if (!line.trim()) continue
    const fields = line.split(',')
    // description (field 1) is the only comma-bearing field; status is second-from-last.
    const code = unquote(fields[0] ?? '')
    const status = unquote(fields[fields.length - 2] ?? 'current')
    if (!/^\d{8}$/.test(code)) {
      throw new Error(`Non-8-digit CN code in reference: "${code}"`)
    }
    if (status === 'current') codes.add(code)
  }

  const sorted = [...codes].sort()
  writeFileSync(JSON_PATH, `${JSON.stringify(sorted)}\n`, 'utf8')
  // eslint-disable-next-line no-console
  console.log(`Wrote ${sorted.length} CN8 codes to ${JSON_PATH}`)
}

main()
