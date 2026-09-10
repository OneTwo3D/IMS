#!/usr/bin/env node

/**
 * o3d-n3yt r20 — HOW `scripts/check-db-test-gates.mjs` LEARNS WHICH FILES A TEST COMMAND COLLECTS,
 * AND WITH WHICH GATES.
 *
 * WHAT THIS REPLACED (Codex r19, HIGH). The census used to accept `command.includes('tests/db')` as
 * proof that the npm script ran the directory. `RUN_DB_RETENTION_TESTS=1 REQUIRE_DB_RETENTION_TESTS=1
 * true tests/db` satisfies that substring and then exits 0 having collected nothing — the
 * green-with-no-suite state the guard exists to prevent, re-entered through the guard itself. It also
 * had to model the shell by hand to decide which command an assignment prefix reached, and refused
 * `;`, `&&` and pipes because it could not.
 *
 * BOTH QUESTIONS ARE ANSWERED BY OBSERVATION INSTEAD. The census runs the script for real with
 * `NODE_OPTIONS=--import <this file>` and `DB_TEST_GATE_COLLECTION_LOG` naming a file. Node's test
 * runner spawns ONE PROCESS PER COLLECTED TEST FILE and sets `NODE_TEST_CONTEXT` in each, so in a
 * child this module sees:
 *
 *   * the collected file, as `process.argv[1]` — the runner's own collection, not a glob this guard
 *     re-implemented and not a substring of the command;
 *   * the `RUN_DB_*`/`REQUIRE_DB_*` values that file would ACTUALLY have run under — whatever shell
 *     shape put them there.
 *
 * It records both and EXITS BEFORE THE TEST FILE IS LOADED. Nothing in the suite executes: no
 * database is opened, no Prisma client is required, no test body runs.
 *
 * IT IS INERT EVERYWHERE ELSE, which is what the two conditions below are for:
 *   * no `DB_TEST_GATE_COLLECTION_LOG` — an ordinary run, and this file does nothing at all;
 *   * no `NODE_TEST_CONTEXT` — npm's own node process, the parent test runner, or anything else the
 *     inherited NODE_OPTIONS value reaches. Exiting there would kill the run before it spawned a
 *     single child, and the census would then be measuring its own probe.
 *
 * SO AN EMPTY LOG IS A FAILURE, NOT AN ABSENCE, and the census treats it as one. A command that never
 * starts a Node test runner, a runner pointed at the wrong directory, or a runner whose isolation
 * mode no longer spawns children all record nothing and all fail there, naming what was expected.
 */

import { appendFileSync } from 'node:fs'

const log = process.env.DB_TEST_GATE_COLLECTION_LOG

if (log && process.env.NODE_TEST_CONTEXT && process.argv[1]) {
  const gates = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (/^(RUN|REQUIRE)_DB_[A-Z0-9_]*$/.test(name)) gates[name] = value
  }
  // One line per collected file. `appendFileSync` because every child writes to the same log.
  appendFileSync(log, `${JSON.stringify({ file: process.argv[1], gates })}\n`)
  process.exit(0)
}
