### Mintsoft ASN fixes

- An ASN the warehouse reports as booked in, but whose receipt IMS has not yet applied, now still counts as incoming stock (product incoming figure, end-of-life auto-archive gating and back-in-stock dating). It drops out once the receipt is accounted for.
- A purchase order whose reference is also quoted by an ASN the warehouse made in Mintsoft (every item without an IMS source line id, and different goods or quantities) no longer blocks ASN creation for that order. An ASN that could still be IMS's own, or a mix of identified and unidentified items, is still refused.
- The ASN status is now read only from the two fields Mintsoft actually serves (`ASNStatus` and `ASNStatusId`); guessed spellings are ignored.
- The end-to-end Mintsoft fake serves all three status fields on its ASN list, so a status disagreement is exercised on the list path too.
- No migration.
