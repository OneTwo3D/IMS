import { POSTING_REFUSAL_KINDS, type PostingRefusalKind, type RefusalClearing } from '@/lib/domain/accounting/posting-refusal-kinds'

/**
 * o3d-j625 r7 (review: "help-docs tables regenerated from the classification, and checked") — the operator
 * doc's table of refusal kinds, RENDERED FROM THE CODE MAP. help-docs/xero-sync.md holds this exact text
 * between its markers, and tests/accounting/posting-refusal-kinds.test.ts fails when the two differ, so the
 * page cannot tell an operator that a kind clears itself when the code offers (or refuses) the button.
 */
export const POSTING_REFUSAL_KINDS_DOC_BEGIN = '<!-- posting-refusal-kinds:begin (generated from lib/domain/accounting/posting-refusal-kinds.ts; do not edit by hand) -->'
export const POSTING_REFUSAL_KINDS_DOC_END = '<!-- posting-refusal-kinds:end -->'

const HEADINGS: Record<RefusalClearing, string> = {
  auto: '**Clears itself** — IMS queues the same posting again and nothing can make it refuse for ever. No action is offered.',
  // o3d-j625 r16 (Codex round 15, HIGH 1): the order of operations is TAKE, post, confirm — the taking is
  // what stops IMS queueing the posting while the operator is in the ledger, and it is the step the previous
  // wording left out entirely.
  retried: '**IMS retries it, but the retry can get stuck** — press *Take for hand posting* first (that cancels IMS\'s own queued attempt and stops it queueing another), then post it by hand, then *Mark as handled*.',
  manual: '**Nothing in IMS posts it again** — press *Take for hand posting* first, then post it by hand, then *Mark as handled* (which also stops IMS ever posting it).',
}

export function renderPostingRefusalKindsDoc(): string {
  const lines: string[] = [POSTING_REFUSAL_KINDS_DOC_BEGIN]
  for (const clearing of ['auto', 'retried', 'manual'] as const) {
    lines.push('', HEADINGS[clearing], '', '| Refused posting | Why |', '| --- | --- |')
    for (const [kind, spec] of Object.entries(POSTING_REFUSAL_KINDS) as Array<[PostingRefusalKind, (typeof POSTING_REFUSAL_KINDS)[PostingRefusalKind]]>) {
      if (spec.clearing !== clearing) continue
      lines.push(`| \`${kind}\` (${spec.type} / ${spec.referenceType}) | ${spec.how.replace(/\|/g, '\\|')} |`)
    }
  }
  lines.push('', POSTING_REFUSAL_KINDS_DOC_END)
  return lines.join('\n')
}
