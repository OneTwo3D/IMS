### Xero: IMS's own call-budget refusal (day cap, minute cap) now defers the work instead of failing it
When IMS's own limiter (950 calls per rolling 24 hours, 55 per minute, per organisation and process) refused a Xero call, the refusal text was not recognised as a rate limit, so sales invoices, credit notes, bills and payments spent a retry on every attempt and could end FAILED without ever being sent.

- The refusal now carries a machine-readable tag with the computed wait. Every posting path treats it as a deferral: no retry is spent, the row is never FAILED, and the next attempt is when calls fall out of the window (at least 30 seconds). This covers the direct and outbox sync runners, money posts, follow-ups, the daily batch and manual journals, whose hand-back used to come straight back every tick.
- The releases that hand a deferred row back now fence on the renewed claim, so they land instead of leaving the row Processing until the stale-claim cut-off.
- Xero's own `429` handling and the bounded (under-lock) refusal are unchanged. The limiter is per process and does not see other integrations' calls (Xeroom), so Xero's own `429` can still arrive first.
- Docs: the call-budget section of the Xero sync help page and the Xero section of the architecture doc.
