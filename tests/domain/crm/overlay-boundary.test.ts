import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * THE CLUSTER OVERLAY IS A READ-TIME LENS, NOT A SOURCE OF TRUTH. Only the CRM page, its actions, the identity report, the backfill and the cluster erasure
 * may import it; the importer (apart from writing the audit row), the invoice routes, the accounting connectors and the erasure core must keep reading the
 * Customer row they always read. A new importer of lib/domain/crm fails here until it is decided.
 */
const cwd = new URL('../../..', import.meta.url).pathname
const grep = (pattern: string, ...paths: string[]) => {
  try {
    return execFileSync('git', ['grep', '-lE', '--untracked', pattern, '--', ...paths, ':!*.test.ts', ':!app/generated'], { encoding: 'utf8', cwd }).trim().split('\n').filter(Boolean).sort()
  } catch {
    return []
  }
}

test('only the decided modules import lib/domain/crm', () => {
  assert.deepEqual(grep("from '@/lib/domain/crm/", 'app', 'lib', 'scripts'), [
    'app/(dashboard)/sales/contacts/[id]/customer-timeline.tsx',
    'app/actions/customer-identity.ts',
    'lib/connectors/woocommerce/sync/field-mapping.ts',
    'lib/domain/crm/cluster-resolver.ts',
    'lib/domain/crm/company-group.ts',
    'lib/domain/crm/company-key.ts',
    'lib/domain/crm/identity-report.ts',
    'lib/domain/crm/merge-service.ts',
    'lib/domain/erasure/cluster-erasure-control.ts',
    'lib/domain/erasure/cluster-erasure.ts',
    'scripts/crm-backfill-order-customer-id.ts',
    'scripts/report-customer-identity.ts',
  ])
})

test('the importer imports only the audit writer from the overlay, never the resolver', () => {
  const src = execFileSync('git', ['grep', '-h', '--untracked', "@/lib/domain/crm/", '--', 'lib/connectors/woocommerce/sync/field-mapping.ts'], { encoding: 'utf8', cwd })
  assert.match(src, /merge-service/)
  assert.doesNotMatch(src, /cluster-resolver|timeline|company/)
})

test('customer_merge_events is written only by the merge service', () => {
  assert.deepEqual(grep('customerMergeEvent\\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\\(', 'app', 'lib', 'scripts'), ['lib/domain/crm/merge-service.ts'])
})

test('the resolver reads only OPERATOR rows: the derived rule is re-evaluated on every read, so a stale AUTO_EMAIL row can not keep two customers joined', () => {
  const src = readFileSync(new URL('../../../lib/domain/crm/cluster-resolver.ts', import.meta.url), 'utf8')
  assert.match(src, /customerMergeEvent\.findMany\(\{\s*where: \{ source: 'OPERATOR'/)
  assert.doesNotMatch(src, /'AUTO_EMAIL'/)
})
