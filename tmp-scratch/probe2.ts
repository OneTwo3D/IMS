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

const ACT_VERBS = ['open','remove','delete','void','reverse','correct','archive','cancel','credit-note','amend','edit','detach','undo','clear','strip']
const EXTRA_FORMS = ['undid','undone','cancelling','cancelled','stripping','stripped']
const ACT_NOUNS = ['removal','deletion','reversal','correction','cancellation','amendment','archival','detachment']
function verbForms(v: string): string { const stem = v.endsWith('e') ? v.slice(0, -1) : v; return `${stem}(?:e|es|ed|ing|d|s)?` }
const VERB = `(?:${[...ACT_VERBS.map(verbForms), ...EXTRA_FORMS].join('|')})`
const NOUN = `(?:${ACT_NOUNS.join('|')})`
const OBJECT = `(?:the|that|this|those|these|its|their|any|either|both|each|an|a|it|them|one)\\b`
const INSTRUCTED_ACT = new RegExp(`\\b(?:(${VERB})\\s+${OBJECT}|(${NOUN})\\s+of\\s+${OBJECT})`, 'gi')
const NEGATION = /\b(?:not|never|no|nothing|none|cannot|neither|nor|without|rather than)\b/gi
const CLAUSE_BOUNDARY = /(?:\.\s|;\s|:\s|—\s|\band\s)/

function acts(templates: string[]): string[] {
  const found: string[] = []
  for (const t of templates) {
    const prose = t.replace(/\{Lookup\}|\{lookup\}/g, ' ')
    for (const raw of prose.split(CLAUSE_BOUNDARY)) {
      const clause = raw.trim()
      let firstNegation = Infinity
      NEGATION.lastIndex = 0
      const n = NEGATION.exec(clause)
      if (n) firstNegation = n.index
      INSTRUCTED_ACT.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = INSTRUCTED_ACT.exec(clause)) !== null) {
        if (m.index > firstNegation) continue
        found.push(`${(m[1] ?? m[2]).toLowerCase()}  «${clause.slice(0, 90)}»`)
      }
    }
  }
  return found
}

for (const v of out) {
  const a = acts(v.templates)
  if (a.length) console.log(`${v.lookup.length ? 'LOOKUP-OK ' : '*** NO-LOOKUP '} ${v.label}\n    ${a.join('\n    ')}`)
}
