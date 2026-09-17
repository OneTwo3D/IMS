# `email-outbox-claim-fence-pre-transaction.sql`

A pinned copy of everything `prisma/migrations/20260910120000_email_outbox_claim_fence/migration.sql`
runs **before** its transaction opens. `tests/email-outbox-claim-fence.test.ts` compares the two byte
for byte, because three successive attempts to *parse* that region each diverged from PostgreSQL's
lexer somewhere an attacker could reach.

**This file ends mid-line, with no trailing newline.** The region it pins stops at the `\n` before
`BEGIN;`, so an editor or tool that helpfully appends a final newline turns the guard red. The test
says so explicitly when it happens.

If the refusal is edited deliberately, this copy is updated in the **same commit, by hand**, and the
diff of both files is what a reviewer reads. That is the whole mechanism: it makes a change to the
pre-transaction region impossible to land unseen — it does not prevent one.
