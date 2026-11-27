import type { QuarantineWarehouseIssue } from '@/lib/domain/inventory/quarantine-warehouse'

type Props = { enabled: boolean; issues: QuarantineWarehouseIssue[] }

/**
 * Read only: the condition check on returns is an ADMIN system switch (`return_condition_check_enabled`), set from the command line
 * (`npm run settings:set -- --key return_condition_check_enabled --value true ... --yes --confirm-admin`). This card shows its state and
 * every quarantine warehouse that is not clean for it.
 */
export function ReturnConditionCheckStatus({ enabled, issues }: Props) {
  return (
    <div className="space-y-3">
      <p className="text-sm">
        Status: <span className="font-medium">{enabled ? 'On' : 'Off (default)'}</span>.{' '}
        <span className="text-muted-foreground">
          An administrator switches it with <code className="text-xs">npm run settings:set -- --key return_condition_check_enabled --value true --by &lt;name&gt; --reason &quot;&lt;text&gt;&quot; --yes --confirm-admin</code>.
        </span>
      </p>
      {issues.length > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <p className="font-medium">
            {enabled ? 'Quarantine warehouses that still look sellable:' : 'Before switching it on, fix these quarantine warehouses:'}
          </p>
          <ul className="mt-1 list-disc pl-5">
            {issues.map((issue) => (
              <li key={issue.id}><span className="font-mono">{issue.code}</span> ({issue.name}): {issue.problems.join('; ')}</li>
            ))}
          </ul>
          <p className="mt-1 text-xs">
            While the switch is on their stock is never allocated, counted as available or pushed whatever these flags say. Clear the flags in Inventory Settings, Warehouses, and release or move the allocations.
          </p>
        </div>
      )}
    </div>
  )
}
