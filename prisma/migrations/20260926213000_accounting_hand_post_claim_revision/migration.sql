-- o3d-j625 r24 (Codex round 23, HIGH) — A STRICTLY INCREASING REVISION OF THE ACTIVE HAND-POST CLAIM SET.
--
-- r22 made the claims walk complete by construction against a RE-TAKE (the cursor is the refusal row's id,
-- which nothing rewrites) and then guarded the "that is every active claim" sentence with a COUNT: the total
-- as of the last page, compared with how many rows had been shown. Round 23 took the count apart, and the
-- counter-example is not exotic. With 51 active claims, page one shows 50; before page two one operator
-- TAKES a pre-existing refusal whose id sorts before the cursor while another RELEASES a claim page one
-- already showed. 51 rows shown, total 51, and the page says it showed everything — while the newly held
-- posting was never in the walk and goes on suppressing automatic posting. Two releases against one take
-- give `shown > total`, which fell through to the same sentence.
--
-- AND THE WINDOW IS WIDER THAN r22 DESCRIBED IT. r22 called "a claim taken mid-walk whose id sorts before
-- the cursor" a rare tail that the id's time-ordered prefix mostly covered. It does not: the walk's key is
-- the REFUSAL row's id, and taking a claim CREATES NO ROW — it sets `handPostClaimedAt` on a refusal that may
-- be months old. So ANY pre-existing refusal claimed mid-walk sorts before the cursor. That is the ordinary
-- case whenever somebody takes a claim while a colleague is paging, not an edge.
--
-- SO COMPLETENESS IS NO LONGER INFERRED FROM A SIZE. This table holds ONE counter, bumped by every act that
-- changes which postings are held — taking a claim, releasing one, and marking one handled (which ends a
-- claim too). The walk reads it with its first page and again with its last, and the sentence is printed only
-- if it did not move.
--
-- STRICTLY INCREASING, NOT A NET QUANTITY, and that is the whole point: the defect being fixed is two
-- changes CANCELLING, so anything that counts a size or a balance reproduces it. A take plus a release is
-- +2, never 0.
--
-- TRANSACTIONAL, deliberately. The bump happens inside the same transaction as the act, under the posting
-- key's advisory lock, so an act that rolls back does not move the revision and cannot make a walk report
-- itself incomplete for something that never happened. A sequence would have been cheaper and is NOT used
-- for exactly that reason: `nextval` survives a rollback.
--
-- ONE ROW, AND THE CONTENTION IS IRRELEVANT. Every take/release/mark serialises on this row. Those are human
-- acts on an exception queue — a handful a day — and none of them is on a posting path: the enqueues read
-- the claim, they never bump the revision. BIGINT because an overflow must raise rather than wrap; at one
-- act per second it would take 292 billion years.
CREATE TABLE "accounting_hand_post_claim_revisions" (
    "id" TEXT NOT NULL,
    "revision" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "accounting_hand_post_claim_revisions_pkey" PRIMARY KEY ("id")
);

-- The single row, so a read before the first claim is a 0 rather than an absence every caller must handle.
INSERT INTO "accounting_hand_post_claim_revisions" ("id", "revision") VALUES ('global', 0);
