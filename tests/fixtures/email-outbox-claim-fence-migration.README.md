# `email-outbox-claim-fence-migration.sql`

A pinned copy of `prisma/migrations/20260910120000_email_outbox_claim_fence/migration.sql`.
`tests/email-outbox-claim-fence.test.ts` compares the two byte for byte, because three successive
attempts to *parse* that file each diverged from PostgreSQL's lexer somewhere an attacker could reach,
and a fourth (a line-anchored scan for the transaction's terminator) missed a closer written mid-line.

Round 40 pinned only the region before `BEGIN;`; round 42 widened it to the whole file, because a
transaction closed early — `COMMIT` or `END`, any spelling, anywhere on a line — makes everything after
it commit on its own, and finding that reliably means parsing.

**This file ends mid-line, with no trailing newline** (the migration ends at its final `COMMIT;`), so an
editor or tool that helpfully appends one turns the guard red. The test says so explicitly.

If the refusal is edited deliberately, this copy is updated in the **same commit, by hand**, and the
diff of both files is what a reviewer reads. That is the whole mechanism: it makes a change to the
pre-transaction region impossible to land unseen — it does not prevent one.

## One caveat on "byte for byte"

The comparison normalises line endings on both sides before comparing: `\r\n` **and a lone `\r`** both
become `\n`. So this copy is byte-identical to what executes *up to line endings* — a lone `\r` inside
the region would compare equal to an `\n`. That is deliberate (a CRLF checkout must not fail the test)
and inert here: to PostgreSQL, `\r` and `\n` are interchangeable as whitespace and both end a `--`
comment, and this region contains no multi-line string literal where the difference could matter.
Everything else — every other byte, including invalid UTF-8 — is compared exactly, on bytes read as
bytes.
