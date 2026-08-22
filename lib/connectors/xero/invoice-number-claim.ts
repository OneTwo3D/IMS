/**
 * Ask Xero who holds an invoice number, before we post under it (o3d-k26m.5).
 *
 * This is the one live read that licenses the sales-invoice create. The decision it feeds is in
 * lib/domain/accounting/invoice-number-ownership.ts — that file carries the reasoning; this one is
 * only the wire call, kept separate so the rule can be tested without a ledger.
 *
 * `GET /Invoices?InvoiceNumbers=<n>` is Xero's exact-match filter on the number and returns the
 * documents holding it (an empty `Invoices` array when none do). It is NOT cacheable: it is a
 * per-transaction question whose whole value is being current, which is why it goes through
 * `xeroGet` and not `xeroGetCached` — the latter refuses non-reference paths outright.
 *
 * EVERY UNEXPECTED SHAPE IS A LOOKUP FAILURE, NOT AN EMPTY RESULT. A 200 with no body, or a body
 * with no `Invoices` key, tells us nothing about who holds the number, and the caller turns
 * "nothing" into permission to post. Xero says "nobody holds it" with `{"Invoices":[]}` and
 * nothing else, so anything else is refused into the fail-closed branch.
 *
 * ------------------------------------------------------------------------------------------------
 * THE ANSWER MUST BE COMPLETE, NOT MERELY NON-EMPTY (Codex round 3)
 * ------------------------------------------------------------------------------------------------
 * An "unclaimed" verdict is what authorises the post, so a lookup that can MISS a holder makes the
 * whole fence unsound — the one wrong answer that ends in an overwrite rather than a refusal.
 *
 * AND IT IS THE PROPERTY THE FENCE RESTS ON AFTER CUTOVER. Xeroom is being removed, not run
 * alongside, so the documents this protects are not a concurrent writer's — they are the ~14,415
 * documents xeroom ALREADY posted, standing in the ledger under exactly the numbers IMS now derives
 * from `_wcpdf_invoice_number`. They are always present when the question is asked. A false
 * "unclaimed" on one of them is IMS silently replacing a real historical invoice, with no second
 * system left to notice.
 *
 * Round 2 sent this request UNPAGED and read the array it got back. That array is one PAGE. Xero's
 * page cap is verified live in invoice-delta.ts: an unpaged response SILENTLY STOPS AT 100
 * (see PAGE_SIZE there — the same defect cost the payment poller invoices in #494). A holder past
 * that cut is invisible, and invisible reads as unclaimed.
 *
 * Reaching the cap on an exact-number filter needs an unusual ledger — Xero enforces uniqueness on
 * ACCREC numbers, so the extra documents would be voided predecessors under a reused number and
 * ACCPAY bills that happen to carry it — but "unusual" is not "impossible", the historical
 * population is large and was written by a system whose numbering IMS does not control, and the
 * cost of being wrong here is an unrecoverable write. So the page is treated as evidence only when
 * it PROVES it is the whole result set:
 *
 *   - the request is explicitly paged (`page=1&pageSize=100`) rather than relying on a default;
 *   - a page shorter than `pageSize` IS the complete set — nothing follows a short page;
 *   - a FULL page, or a `pagination` block that admits to more than one page, is a LOOKUP FAILURE.
 *     It fails closed to LEDGER_LOOKUP_UNAVAILABLE, which refuses and retries, rather than
 *     reporting the fraction it happened to see.
 *
 * Deliberately NOT a multi-page walk. Offset paging over a live result set is not a snapshot — a
 * concurrent edit shifts rows between requests and can slide a row into a page already read (the
 * o3d-8f9 analysis in invoice-delta.ts), which would reintroduce exactly the missed holder this
 * closes. One page, or no answer. It also keeps the fence at ONE call per create, which is what
 * the daily-budget argument for the fence was costed on.
 *
 * EVERY HOLDER IS RETURNED, not the first one found. Which document a POST would replace is a
 * question about the whole set (a live document plus voided predecessors is a different answer
 * from two live documents), and picking `find()`'s first match answered it by accident of
 * ordering — Xero pages oldest-first, so that was systematically the OLDEST holder.
 *
 * ------------------------------------------------------------------------------------------------
 * AND THE QUESTION MUST BE ASKABLE IN THE FIRST PLACE (Codex round 4)
 * ------------------------------------------------------------------------------------------------
 * `InvoiceNumbers` is a LIST parameter: `InvoiceNumbers=A,B` asks about two numbers. A number that
 * CONTAINS a comma therefore has a second reading, and which one Xero takes decides whether the
 * fence works at all:
 *
 *   - if the value is split AFTER percent-decoding, `A,1` asks about `A` and `1` — two numbers
 *     nobody may hold — and the answer comes back EMPTY. Empty is exactly what authorises the post,
 *     so the one document actually numbered `A,1` gets silently replaced;
 *   - if it is split BEFORE decoding, `%2C` stays literal and the question is the intended one.
 *
 * WE CANNOT TELL WHICH, and finding out means a live call against an organisation holding ~14,415
 * real documents. The response-side re-comparison does not save it either: that catches EXTRA rows,
 * and this defect produces MISSING ones. So the same rule round 3 established for a page that
 * cannot prove it is complete applies to a question that cannot be asked precisely — IT REFUSES.
 * The refusal is marked `unaskable`, because unlike an unreachable ledger it will never come right
 * on its own: the number has to change in WooCommerce, or a human has to post the invoice.
 *
 * WHAT `_wcpdf_invoice_number` CAN ACTUALLY CONTAIN. Any non-blank string. The plugin's number
 * format is `[prefix][number][suffix]` with all three free-text and admin-editable, and
 * lib/connectors/woocommerce/sync/invoice-number.ts takes the value VERBATIM by design (a prefix of
 * our own would disagree with the customer's PDF and with every historical document). Nothing
 * between that meta field and this request rejects, escapes or normalises punctuation, so a comma
 * is not hypothetical — it is one settings change away.
 *
 * A `where=InvoiceNumber=="A,1"` fallback was considered and REJECTED. A quoted where-clause has no
 * list grammar, so it would express the question — but it is a DIFFERENT filter with different
 * matching, reached only in the case we cannot test, and the fence's soundness would then rest on
 * an unverified premise in exactly the branch that carries the irreversible write. Refusing a
 * handful of orders is recoverable; guessing right about Xero's parser is not.
 *
 * ACCREC ONLY. Purchase bills (ACCPAY) share the endpoint and their numbers are the SUPPLIER's,
 * explicitly non-unique, and posted create-only via PUT (see bills.ts). A bill that happens to
 * carry the same number as a sales invoice is not a claim on the sales-invoice sequence and must
 * not block a receivable. They are still COUNTED against the page cap above, because they occupy
 * rows that could push a real holder out of the page.
 *
 * ------------------------------------------------------------------------------------------------
 * AND THE ANSWER IS ABOUT ONE ORGANISATION, WHICH IT NOW SAYS (Codex round 7)
 * ------------------------------------------------------------------------------------------------
 * `xeroGet` resolves the connection for itself, and the create resolves it again later. A reconnect,
 * a tenant re-pin, or a refresh landing on a different tenant between the two makes this an answer
 * about org A and the post a write to org B — where nobody was asked anything, and where the number
 * may well be held. The lookup therefore reports the tenant that answered it, and the fence rechecks
 * that tenant against the one on the outgoing request at the instant of the write
 * (lib/connectors/accounting-egress-authorization.ts). A response that does not say which
 * organisation produced it is a LOOKUP FAILURE, for the same reason a page that cannot prove it is
 * complete is: an answer that cannot be attributed is not evidence, and here "not evidence" is being
 * read as permission.
 */

import { xeroGet } from './api'
import { PAGE_SIZE } from './invoice-delta'
import {
  xeroInvoiceNumberIdentity,
  type InvoiceNumberLookup,
  type LedgerInvoiceClaim,
} from '@/lib/domain/accounting/invoice-number-ownership'

type XeroInvoiceNumberLookupResponse = {
  Invoices?: Array<{
    InvoiceID?: unknown
    InvoiceNumber?: unknown
    Type?: unknown
    Status?: unknown
    Total?: unknown
    Contact?: { Name?: unknown }
  }>
  /** Xero returns this alongside a paged request. Used only to fail closed, never to widen. */
  pagination?: { pageCount?: unknown; itemCount?: unknown }
}

/**
 * `InvoiceNumbers` is a comma-separated LIST. A number containing one cannot be asked about — see
 * the header — and percent-encoding it does not settle which reading Xero takes.
 */
const LIST_SEPARATOR = ','

type LookupDeps = {
  get: <T>(path: string) => Promise<{ ok: boolean; status: number; data?: T; error?: string; tenantId?: string }>
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * Who — if anyone — holds `invoiceNumber` as an ACCREC document in the connected organisation.
 *
 * The number is compared again on the way back rather than trusted from the filter. Xero's
 * matching on this parameter is its own, and an ownership fence that accepts "close enough" is
 * not a fence; a document that comes back under a DIFFERENT number is not a claim on this one.
 * The comparison is case-insensitive because Xero's invoice numbers are, so `AB-1` and `ab-1`
 * are the same claim to the ledger and must be to us.
 *
 * That rule now lives in ONE place — `xeroInvoiceNumberIdentity` — because round 4's post-slot
 * mutex used a narrower one and the two silently disagreed about which numbers name one document
 * (round 5). A definition written out twice is a definition that can drift; here it drifted in the
 * direction that ends in an overwrite.
 */
export async function lookupXeroInvoiceNumberClaim(
  invoiceNumber: string,
  deps: LookupDeps = { get: (path) => xeroGet(path) },
): Promise<InvoiceNumberLookup> {
  const wanted = invoiceNumber.trim()
  if (!wanted) return { ok: false, error: 'no invoice number to look up' }

  // The list separator, and the one character that makes this request ask a DIFFERENT question
  // from the one intended — see the header. Refused before anything is sent, and marked as a
  // refusal no retry can clear.
  if (wanted.includes(LIST_SEPARATOR)) {
    return {
      ok: false,
      unaskable: true,
      error:
        `invoice number ${JSON.stringify(wanted)} contains a comma, which Xero's InvoiceNumbers filter reads as `
        + 'the separator between two numbers, so IMS cannot ask who holds THIS number and must not treat the '
        + 'answer to a different question as "nobody holds it"',
    }
  }

  let res: { ok: boolean; status: number; data?: XeroInvoiceNumberLookupResponse; error?: string; tenantId?: string }
  try {
    res = await deps.get<XeroInvoiceNumberLookupResponse>(
      `Invoices?InvoiceNumbers=${encodeURIComponent(wanted)}&page=1&pageSize=${PAGE_SIZE}`,
    )
  } catch (error) {
    // A throw here is a lookup failure like any other. Letting it propagate would abort the entry
    // with a stack trace instead of the fail-closed refusal the caller knows how to describe.
    return { ok: false, error: `the invoice-number lookup threw: ${String(error)}` }
  }

  if (!res.ok) {
    return { ok: false, error: res.error ?? `invoice-number lookup failed with HTTP ${res.status}` }
  }
  if (!res.data || !Array.isArray(res.data.Invoices)) {
    return { ok: false, error: 'the invoice-number lookup returned no Invoices array' }
  }
  // WHICH ORGANISATION ANSWERED, OR NO ANSWER AT ALL (Codex round 7, finding 2).
  //
  // The verdict this produces is spent later, on a WRITE, and which organisation that write lands in
  // is resolved separately — so the caller has to be able to state the ledger its permission came
  // from and re-check it against the tenant the outgoing request actually carries. An answer nobody
  // can attribute cannot be bound to anything, and an unbound "nobody holds this number" is a
  // sentence that ANY organisation satisfies, including one where the number is held. Failing closed
  // costs a retry; the alternative is the overwrite this whole module exists to prevent.
  const tenantId = typeof res.tenantId === 'string' ? res.tenantId.trim() : ''
  if (!tenantId) {
    return {
      ok: false,
      error:
        `the invoice-number lookup for ${wanted} did not report which organisation answered it, so its answer `
        + 'cannot be bound to the organisation the post would be sent to',
    }
  }

  const rows = res.data.Invoices
  if (rows.length >= PAGE_SIZE) {
    return {
      ok: false,
      error:
        `the invoice-number lookup filled its page (${rows.length} documents at pageSize ${PAGE_SIZE}) for `
        + `${wanted}, so it cannot show that it saw every document holding that number`,
    }
  }
  const pageCount = res.data.pagination?.pageCount
  if (typeof pageCount === 'number' && pageCount > 1) {
    return {
      ok: false,
      error: `the invoice-number lookup for ${wanted} spans ${pageCount} pages, so one page is not the whole answer`,
    }
  }

  const wantedIdentity = xeroInvoiceNumberIdentity(wanted)
  const claims: LedgerInvoiceClaim[] = []
  for (const inv of rows) {
    const number = asString(inv?.InvoiceNumber)
    if (!number || xeroInvoiceNumberIdentity(number) !== wantedIdentity) continue
    const type = asString(inv?.Type)
    // Absent Type is treated as a match: the endpoint returns it, so a missing one is a shape we
    // do not understand, and on this fence an unknown document counts as a claim.
    if (type !== undefined && type.toUpperCase() !== 'ACCREC') continue

    const invoiceId = asString(inv?.InvoiceID)
    if (!invoiceId) {
      // Something holds the number and the ledger did not say what. That is the least safe possible
      // state to guess in.
      return { ok: false, error: `a document holds invoice number ${wanted} but the lookup returned no InvoiceID` }
    }

    const claim: LedgerInvoiceClaim = {
      invoiceId,
      invoiceNumber: number,
      status: asString(inv?.Status) ?? 'UNKNOWN',
    }
    const contactName = asString(inv?.Contact?.Name)
    if (contactName) claim.contactName = contactName
    if (typeof inv?.Total === 'number' && Number.isFinite(inv.Total)) claim.total = inv.Total
    claims.push(claim)
  }

  return { ok: true, claims, tenantId }
}
