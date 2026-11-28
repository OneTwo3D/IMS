### Refund payment cash-out date: review follow-ups before the switch goes on (accounting, Xero)

Behind `xero_refund_payment_cash_out_date_enabled` (still off). With the switch off nothing here changes what is sent, with one exception noted under LOW-3.

- **Fixed (MED-1): a settlement row that may already have reached Xero is never re-dated.** A row with `remoteAttemptedAt` set whose decision was pinned before `rateDecided` existed is not replayed as it is, so it was decided again, and with the switch on its date could move to the cash-out day. The ledger fence would then look for its landed payment on the wrong day and could pay the customer twice. The re-date is now taken only for a row that never attempted a call, and the restore to the credit note's date likewise. An attempted row keeps its stored date.
- **Fixed (LOW-1): the restore to the credit note's date happens before the operation is decided.** A row re-dated under the switch, then failed before any call, then decided as an ALLOCATE (its receipt was removed, say) used to carry the cash-out date into the allocation. The credit note's date (`creditNoteDate`) is now restored where the unsent decision is dropped.
- **Fixed (MED-3): a refund payment dated after today is not a cash-out.** The credit note's date stands: money that has not gone out is not booked as gone out, and no rate exists for a future day.
- **Fixed (LOW-2): the outbound write hold judges a re-dated settlement on the credit note's date.** `CREDIT_NOTE_ALLOCATION` reads its obligation date as `creditNoteDate ?? date`. A creditNoteDate that is present but unreadable is not replaced by `date`.
- **Changed (LOW-6): `xero_credit_note_allocation_enabled` is a registered prerequisite of the switch.** It cannot be turned on while settlement is off, and settlement cannot be turned off while it is on.
- **LOW-3, a change with the switch off, already on development since #1130:** the reader orders refund and receipt payments by `paidAt`, then `id`. Before #1130 it ordered by `paidAt` alone. For payments tied on `paidAt`, the "first" one is therefore now chosen deterministically: the one with the smaller id. This affects the refund method taken when several are recorded (`refundPaymentMethodOf`) and, with the switch on, the as-of instant of "the latest" payment. The dates of tied payments are the same either way. This PR makes no further change to the order.
- **Accepted limits, documented and not changed:**
  - LOW-4: several refund payments are rated at one instant, the latest. The one Xero payment carries their sum.
  - LOW-5: a payment stored at London midnight without an explicit instant is rated as of the end of its stored UTC day. This is the house date rule for date-only input.
  - LOW-7: an edit of the payment's Paid date between the pin and the call sends the pinned (older) date. The next unsent decision would take the new one.
- **Tests (MED-2, MED-4):**
  - The CREDIT_NOTE_ALLOCATION fence census now finds every form of assignment to the settlement date, including compound, logical and destructuring forms. It requires exactly one re-date, to `cashOut.date`, paired with `pin.date` of the same value. It also asserts the never-attempted guard and the position of the restore.
  - New database tests:
    - an attempted row with the switch flipped, both ways;
    - an attempted row pinned before `rateDecided`;
    - an unusable rate on the cash-out day, which refuses with nothing pinned;
    - several payments, where the latest wins;
    - a Paid date edited before the decision, which is decided again;
    - the ALLOCATE restore.
  - New unit tests cover the future-date rule, the prerequisite, and the obligation date.
