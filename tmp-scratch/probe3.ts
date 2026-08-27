import { DOCUMENT_INCIDENT_WORDING, NON_DOCUMENT_INCIDENT_WORDING, QBO_OPERATIONS_WITHOUT_REQUEST_ID } from '@/lib/domain/accounting/unrecorded-posted-document'
const PAT = /[^.;]*\b(?:exists?|is in (?:Xero|QuickBooks|\{ledger\}|the \{ledger\})|is still|are still|now exists|remains?)\b[^.;]*/gi
function scan(label: string, w: any) {
  const { needs, lookup, ...rest } = w
  for (const [k, v] of Object.entries<any>(rest)) {
    if (typeof v !== 'string') continue
    const m = v.match(PAT)
    if (m) for (const s of m) console.log(`${label}.${k}: «${s.trim()}»`)
  }
}
for (const [k, w] of Object.entries(DOCUMENT_INCIDENT_WORDING)) scan(`DOC.${k}`, w)
for (const [t, e] of Object.entries<any>(NON_DOCUMENT_INCIDENT_WORDING)) {
  const vs = 'did' in e ? { '': e } : e
  for (const [vn, w] of Object.entries<any>(vs)) scan(`NONDOC.${t}${vn ? '.' + vn : ''}`, w)
}
for (const [t, e] of Object.entries<any>(QBO_OPERATIONS_WITHOUT_REQUEST_ID)) {
  if (!e) continue
  const vs = 'effect' in e ? { '': e } : e
  for (const [vn, w] of Object.entries<any>(vs)) scan(`REPLAY.${t}${vn ? '.' + vn : ''}`, w)
}
