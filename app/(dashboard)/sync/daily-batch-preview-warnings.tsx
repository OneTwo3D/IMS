import React from 'react'

/**
 * o3d-3la07 (M6, D3): the per-order sentences the daily-batch preview builds when its deferred-revenue
 * netting rests on UNEARNED_REV_REVERSAL rows nobody read in the ledger. Report only: the figures above it
 * are unchanged by them. Renders nothing when there are none.
 */
export function DailyBatchPreviewWarnings({ warnings }: { warnings?: readonly string[] }) {
  if (!warnings || warnings.length === 0) return null
  return (
    <div
      role="alert"
      data-testid="daily-batch-preview-warnings"
      className="mb-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900"
    >
      <p className="font-medium">
        {warnings.length === 1 ? '1 order' : `${warnings.length} orders`} netted against a reversal the IMS cannot vouch for
      </p>
      <ul className="mt-1 list-disc space-y-1 pl-4">
        {warnings.map((warning) => (
          <li key={warning}>{warning}</li>
        ))}
      </ul>
    </div>
  )
}
