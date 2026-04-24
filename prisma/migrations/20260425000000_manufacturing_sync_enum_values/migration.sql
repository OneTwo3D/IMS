-- Extend AccountingSyncType with two new values used by the manufacturing
-- cost component: MANUFACTURING_JOURNAL (assembly/disassembly journal on
-- completion) and MANUFACTURING_RECLASS (retro reclass when a cost line is
-- edited after completion).
--
-- ALTER TYPE ... ADD VALUE must run in its own migration because Postgres
-- forbids it in the same transaction as any later DDL that uses the value.
ALTER TYPE "AccountingSyncType" ADD VALUE 'MANUFACTURING_JOURNAL';
ALTER TYPE "AccountingSyncType" ADD VALUE 'MANUFACTURING_RECLASS';
