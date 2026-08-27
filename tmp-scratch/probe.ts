import {
  DOCUMENT_INCIDENT_WORDING,
  NON_DOCUMENT_INCIDENT_WORDING,
  QBO_OPERATIONS_WITHOUT_REQUEST_ID,
} from '@/lib/domain/accounting/unrecorded-posted-document'

type View = { label: string; templates: string[]; lookup: readonly string[] }
const out: View[] = []
for (const [key, w] of Object.entries(DOCUMENT_INCIDENT_WORDING)) {
  const { needs, lookup, ...rest } = w as any
  out.push({ label: `DOC.${key}`, templates: Object.values(rest) as string[], lookup: lookup ?? [] })
}
for (const [type, entry] of Object.entries(NON_DOCUMENT_INCIDENT_WORDING)) {
  const variants: any = 'did' in (entry as any) ? { '': entry } : entry
  for (const [variant, w] of Object.entries<any>(variants)) {
    const { needs, lookup, ...rest } = w
    out.push({ label: `NONDOC.${type}${variant ? '.' + variant : ''}`, templates: Object.values(rest) as string[], lookup: lookup ?? [] })
  }
}
for (const [type, entry] of Object.entries(QBO_OPERATIONS_WITHOUT_REQUEST_ID)) {
  if (!entry) continue
  const variants: any = 'effect' in (entry as any) ? { '': entry } : entry
  for (const [variant, w] of Object.entries<any>(variants)) {
    const { needs, lookup, ...rest } = w
    out.push({ label: `REPLAY.${type}${variant ? '.' + variant : ''}`, templates: Object.values(rest) as string[], lookup: lookup ?? [] })
  }
}

const ACT_STEM = '(?:open|remove|delete|void|reverse|correct|archive|cancel|credit-note|amend|edit|detach|undo|clear|strip)'
const MUTATING_ACT = new RegExp(`\\b${ACT_STEM}(?:e?s|ed|ing)?\\b`, 'gi')
const NEGATED = /\b(?:not|never|no|nothing|none|cannot|can't|without|rather than|neither)\b/i
const CLAUSE_BOUNDARY = /(?:\.\s|;\s|:\s|—\s|,\s|\band\s|\bor\s|\bbut\s|\bso\s)/

function acts(templates: string[]): string[] {
  const found: string[] = []
  for (const t of templates) {
    const prose = t.replace(/\{Lookup\}|\{lookup\}/g, ' ')
    for (const clause of prose.split(CLAUSE_BOUNDARY)) {
      if (NEGATED.test(clause)) continue
      const m = clause.match(MUTATING_ACT)
      if (m) found.push(...m.map((x) => `${x.toLowerCase()}[${clause.trim().slice(0, 80)}]`))
    }
  }
  return found
}

for (const v of out) {
  const a = acts(v.templates)
  if (a.length) console.log(`${v.lookup.length ? 'LOOKUP-OK ' : 'NO-LOOKUP '} ${v.label}\n    ${a.join('\n    ')}`)
}
