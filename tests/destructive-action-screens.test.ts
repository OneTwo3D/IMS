import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { isConfirmReady } from '@/lib/typed-confirmation'

/**
 * The screens that reach the confirmed server actions. Dialogs cannot be rendered without a DOM in
 * this repo's test setup, so the rule that decides when the confirm button enables is tested as a
 * function, and the wiring of each screen is pinned against its source: no handler may call the
 * action except from the dialog's confirm, and every control must carry a visible label and an
 * accessible name.
 */
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('the confirm button enables only when the typed value, the tick and idleness all hold', () => {
  const base = { typedExpected: 'MIL1', typed: 'MIL1', acknowledgementRequired: true, acknowledged: true, pending: false }
  assert.equal(isConfirmReady(base), true, 'CONTROL: everything satisfied')
  assert.equal(isConfirmReady({ ...base, typed: 'MIL' }), false)
  assert.equal(isConfirmReady({ ...base, typed: '' }), false)
  assert.equal(isConfirmReady({ ...base, acknowledged: false }), false)
  assert.equal(isConfirmReady({ ...base, pending: true }), false)
  assert.equal(isConfirmReady({ typed: '', acknowledgementRequired: false, acknowledged: false, pending: false }), true, 'a dialog with no requirements is ready')
})

test('Mintsoft binding row: every action is labelled, named for its warehouse, and confirmed before it runs', () => {
  const src = read('app/(dashboard)/sync/mintsoft-client.tsx')
  assert.match(src, /aria-label=\{`Go live with stock corrections for \$\{binding\.warehouseCode\}`\}/)
  assert.match(src, /aria-label=\{`Sync stock now for \$\{binding\.warehouseCode\}`\}/)
  assert.match(src, /aria-label=\{`Deactivate binding for \$\{binding\.warehouseCode\}`\}/)
  for (const text of ['Go live…', 'Sync now', 'Deactivate…']) assert.ok(src.includes(text), `visible text ${text}`)
  // The row buttons open a dialog; the actions are reachable only from the dialogs' onConfirm.
  assert.match(src, /onClick=\{\(\) => openBindingDialog\('go-live', binding\)\}/)
  assert.match(src, /onClick=\{\(\) => openBindingDialog\('deactivate', binding\)\}/)
  assert.equal((src.match(/handleConfirmAlignment\(/g) ?? []).length, 2, 'declared once, called once (from the dialog)')
  assert.equal((src.match(/handleDeleteBinding\(/g) ?? []).length, 2, 'declared once, called once (from the dialog)')
  assert.match(src, /confirmMintsoftAlignmentMode\(bindingId, \{ confirmed: true, typedName: typedWarehouseCode \}\)/)
  // The go-live dialog requires the warehouse code and says what live corrections mean.
  assert.match(src, /typedConfirmation=\{bindingDialog \? \{ expected: bindingDialog\.binding\.warehouseCode/)
  assert.match(src, /live stock corrections<\/strong>/)
})

test('Backup list: Delete is labelled, apart from Restore, and needs the backup name typed', () => {
  const src = read('components/settings/backup-restore.tsx')
  assert.match(src, /aria-label=\{`Delete \$\{b\.filename\}`\}/)
  assert.match(src, /aria-label=\{`Restore \$\{b\.filename\}`\}/)
  const restoreAt = src.indexOf('title="Restore this backup"')
  const deleteAt = src.indexOf('aria-label={`Delete ${b.filename}`}')
  assert.ok(restoreAt > 0 && deleteAt > restoreAt, 'Delete comes after Restore')
  assert.match(src.slice(restoreAt, deleteAt), /ml-4 border-l pl-4/, 'in its own divided group, not beside Restore')
  assert.doesNotMatch(src, /onClick=\{\(\) => handleDelete\(/, 'the row button never deletes directly')
  assert.match(src, /typedConfirmation=\{showDelete \? \{ expected: showDelete\.filename/)
  assert.match(src, /deleteBackup\(filename, confirmation\)/)
})

test('Retry all failed: both entry points open the shared dialog and never call the bulk action directly', () => {
  for (const path of ['app/(dashboard)/sync/failed-sync-banner.tsx', 'app/(dashboard)/sync/xero-client.tsx']) {
    const src = read(path)
    assert.match(src, /<RetryAllFailedDialog/, `${path} mounts the dialog`)
    assert.doesNotMatch(src, /retryFailedAccountingSync\(\)/, `${path} no longer calls the bulk retry with no confirmation`)
  }
  const dialog = read('app/(dashboard)/sync/retry-all-failed-dialog.tsx')
  assert.match(dialog, /retryFailedAccountingSync\(undefined, undefined, \{ confirmed: true, expectedCount: count \}\)/)
  assert.match(dialog, /acknowledgement=/)
})
