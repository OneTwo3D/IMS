#!/usr/bin/env bash
# =============================================================================
# THE ONE VALIDATION SEQUENCE, RUN WHOLE (o3d-amy8)
# =============================================================================
# EVERY STEP RUNS, EVERY TIME, AND THE FAILURES ARE REPORTED TOGETHER. This script used to run
# under `set -e` with `npm run lint` first and `npm run test:unit` eighth, which means a lint error
# — any lint error, from any file, including a warning-level rule promoted to error — aborted it
# before the type check, the three boundary guards, the migration-convention check, the Server
# Action authorization guards, the unit suite, the workflow-doc check and the schema-scope check
# had run. `development` carried a `next/no-assign-module-variable` error for a while, and for the
# whole of that period the CI job that runs this script executed exactly one of its ten steps on
# every pull request. Three merged in that state on one day.
#
# THE FAILURE MODE IS SILENT BY CONSTRUCTION, which is why "read the log more carefully" is not the
# fix. The job goes red, the log names a lint error, the lint error is real, and nothing anywhere
# in the output says that nine further gates never ran. A red job that is missing nine results
# looks exactly like a red job that has ten.
#
# WHY AGGREGATION AND NOT A REORDERING. Putting the security and correctness gates ahead of lint
# was the other option on the issue, and it only moves the mask: whichever step is first is the one
# that can hide the other nine, and the argument for `check:server-action-guards` not being
# skippable is an argument against ANY step being able to skip it. Ordering is a tie-break, not a
# mechanism.
#
# WHAT FAIL-FAST NORMALLY BUYS, AND WHY IT BUYS NOTHING HERE. The usual reason to abort on the
# first failure is that a later step is UNSAFE after it — it deploys, it migrates, it writes
# somewhere shared, or it acts on an artefact the failed step was supposed to produce. None of that
# is true of this sequence. Nine of these ten steps only READ the working tree: eslint, tsc
# --noEmit, four repository scans, the Server Action guards, the unit suite and the workflow-doc
# check in --check mode. The tenth, `prisma generate`, writes only into the generated client
# directory, which is generated output and not source. Nothing here talks to a database, a
# registry, a deployment target or the network. There is no state for a step to corrupt for the
# step after it, so running all ten costs a red run some wall-clock time and costs a green run
# nothing at all — a green run took every step already.
#
# THE ONE REAL DEPENDENCY, MADE EXPLICIT RATHER THAN ENFORCED BY ABORTING. `prisma generate` is the
# producer of the Prisma client that `type-check` and `test:unit` both import, and it used to run
# SIXTH — after the type check that needs it. It now runs FIRST, so the two consumers see a client
# generated from the schema in this tree rather than whatever a previous run left. When it fails,
# the summary says so and says that the failures under it may be downstream of it; that is a
# reporting problem, and it is answered by reporting, not by hiding the other eight results.
#
# NOT `set -e`. It is the whole defect. `pipefail` and `nounset` stay: an unset variable here is a
# bug in this script, and a pipeline whose producer dies must not read as a pass.
set -uo pipefail

schema_scope_base_ref="${SCHEMA_SCOPE_BASE_REF:-origin/development}"
schema_scope_head_ref="${SCHEMA_SCOPE_HEAD_REF:-HEAD}"

# The steps that have run, in order, and the ones that failed. `STEP_ORDER` exists so the summary
# can list every step with its result: "which gates ran" is precisely the question the old script
# could not answer, and a list of failures alone still cannot.
STEP_ORDER=()
declare -A STEP_RESULT=()
FAILED_COUNT=0

# Run one step, record its result, and DO NOT abort. The label is what the summary prints, so it
# names the gate rather than the command: an operator reading a red summary is looking for "the
# unit suite failed", not for an npm invocation.
run_step() {
  local label="$1"
  shift
  printf '\n===== %s =====\n' "${label}"
  if "$@"; then
    STEP_RESULT["${label}"]=pass
  else
    STEP_RESULT["${label}"]=fail
    FAILED_COUNT=$(( FAILED_COUNT + 1 ))
    printf '\n!! FAILED: %s\n' "${label}"
  fi
  STEP_ORDER+=("${label}")
}

# FIRST, because both the type check and the unit suite import what it writes. Direct `prisma
# generate` rather than a package script so the baseline does not require DATABASE_URL.
run_step 'prisma generate'                npx prisma generate --schema prisma/schema.prisma
run_step 'lint'                           npm run lint
run_step 'type-check'                     npm run type-check
run_step 'decimal boundaries'             npm run check:decimal-boundaries
run_step 'connector fetch boundaries'     npm run check:connector-fetch-boundaries
run_step 'migration conventions'          npm run check:migration-conventions
# o3d-hic9: the Server Action authorization guards were in check:all but in no CI workflow, so they
# only ran when someone remembered to type check:all locally. validate-local.sh exists so local and
# CI run the same policy, so they belong here too. They are ALSO run by
# .github/workflows/server-action-auth-guard.yml, which is ungated — the validate job that runs
# this script is conditional on classify_changes.run_expensive, and a security gate should not be
# skippable. o3d-amy8 finished that argument: they were skippable anyway, by any lint error, until
# this script stopped aborting.
run_step 'server action guards'           npm run check:server-action-guards
run_step 'unit tests'                     npm run test:unit
run_step 'workflow docs'                  npm run docs:workflows:check
run_step 'prisma schema scope'            npm run db:schema:scope -- "${schema_scope_base_ref}" "${schema_scope_head_ref}"

# THE SUMMARY IS THE POINT OF THE EXERCISE. It lists every step and its result, so a reader can see
# both what failed and that nothing was skipped — the second of which the old script could never
# show, because it was not true.
printf '\n===== validate-local summary =====\n'
for label in "${STEP_ORDER[@]}"; do
  if [[ "${STEP_RESULT[${label}]}" == "pass" ]]; then
    printf '  PASS  %s\n' "${label}"
  else
    printf '  FAIL  %s\n' "${label}"
  fi
done
printf '%d of %d steps failed; all %d ran.\n' \
  "${FAILED_COUNT}" "${#STEP_ORDER[@]}" "${#STEP_ORDER[@]}"

if (( FAILED_COUNT > 0 )); then
  if [[ "${STEP_RESULT['prisma generate']:-pass}" == "fail" ]]; then
    printf '\nNOTE: `prisma generate` failed. The type check and the unit suite import the client it\n'
    printf 'writes, so failures in those two may be downstream of it — fix this one first.\n'
  fi
  exit 1
fi
