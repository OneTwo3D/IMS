import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildOtiCrontabBlock,
  emulateRuntimeSecretExtraction,
  isCronSafePath,
  isCrontabEmbeddableSecret,
  parseOtiCrontabStatus,
  spliceOtiBlock,
  stripOtiBlocks,
  DEFAULT_CRON_LOG_PATH,
  OTI_CRON_START_MARKER,
  OTI_CRON_END_MARKER,
  type CrontabJobDef,
} from '../lib/crontab-sync.ts'

const JOB: CrontabJobDef = {
  slug: 'wms-watchdog',
  settingKey: 'wms_watchdog',
  label: 'WMS Silent-Failure Watchdog',
  defaultSchedule: '15 * * * *',
  defaultEnabled: false,
}

const BASE = 'https://ims.example.com'

test('build: env-file mode reads the secret at runtime — no embedded literal (ryxy)', () => {
  const result = buildOtiCrontabBlock({
    jobs: [JOB],
    settings: new Map([['cron_wms_watchdog_enabled', 'true']]),
    secretRef: { kind: 'env-file', envFilePath: '/opt/app/.env' },
    baseUrl: BASE,
  })
  assert.ok(result.ok)
  const text = result.lines.join('\n')
  assert.doesNotMatch(text, /^CRON_SECRET="/m)
  assert.match(text, /CRON_SECRET=\$\(grep -m1 '\^CRON_SECRET=' '\/opt\/app\/\.env' \| cut -d= -f2- \| tr -d '"'\) && \[ -n "\$CRON_SECRET" \] && curl/)
  assert.match(text, /"\$BASE_URL\/wms-watchdog"/)
})

test('build: literal fallback embeds the secret exactly as before', () => {
  const result = buildOtiCrontabBlock({
    jobs: [JOB],
    settings: new Map([['cron_wms_watchdog_enabled', 'true']]),
    secretRef: { kind: 'literal', secret: 'sekrit' },
    baseUrl: BASE,
  })
  assert.ok(result.ok)
  const text = result.lines.join('\n')
  assert.match(text, /^CRON_SECRET="sekrit"$/m)
  assert.doesNotMatch(text, /grep -m1/)
})

test('build: disabled jobs are omitted; legacy key and defaults are honoured', () => {
  const legacyJob: CrontabJobDef = { ...JOB, slug: 'wc-sync', settingKey: 'wc_sync', label: 'WC', legacyEnabledKey: 'wc_sync_enabled' }
  const defaultOn: CrontabJobDef = { ...JOB, slug: 'fx-rates', settingKey: 'fx', label: 'FX', defaultEnabled: true }
  const result = buildOtiCrontabBlock({
    jobs: [JOB, legacyJob, defaultOn],
    settings: new Map([
      ['cron_wms_watchdog_enabled', 'false'],
      ['wc_sync_enabled', 'true'],
    ]),
    secretRef: { kind: 'literal', secret: 's' },
    baseUrl: BASE,
  })
  assert.ok(result.ok)
  const text = result.lines.join('\n')
  assert.doesNotMatch(text, /wms-watchdog/)
  assert.match(text, /wc-sync/)
  assert.match(text, /fx-rates/)
})

test('build: an invalid schedule is rejected, not written', () => {
  const result = buildOtiCrontabBlock({
    jobs: [JOB],
    settings: new Map([
      ['cron_wms_watchdog_enabled', 'true'],
      ['cron_wms_watchdog_schedule', '15 * * * * ; rm -rf /'],
    ]),
    secretRef: { kind: 'literal', secret: 's' },
    baseUrl: BASE,
  })
  assert.equal(result.ok, false)
})

test('splice: replaces an existing block and preserves everything outside it', () => {
  const existing = `# my own job\n0 9 * * * /usr/local/bin/thing\n${OTI_CRON_START_MARKER}\nOLD CONTENT\n${OTI_CRON_END_MARKER}\n# trailing\n`
  const next = spliceOtiBlock(existing, [OTI_CRON_START_MARKER, 'NEW', OTI_CRON_END_MARKER])
  assert.match(next, /my own job/)
  assert.match(next, /# trailing/)
  assert.match(next, /NEW/)
  assert.doesNotMatch(next, /OLD CONTENT/)
})

test('status: runtime-env block cannot drift; embedded stale secret is flagged', () => {
  const runtime = `${OTI_CRON_START_MARKER}\nBASE_URL="x"\n15 * * * *  CRON_SECRET=$(grep -m1 '^CRON_SECRET=' '/a/.env' | cut -d= -f2- | tr -d '"') && curl "$BASE_URL/api/cron/x"\n${OTI_CRON_END_MARKER}\n`
  const runtimeStatus = parseOtiCrontabStatus(runtime, 'current')
  assert.equal(runtimeStatus.blockPresent, true)
  assert.equal(runtimeStatus.secretMode, 'runtime-env')
  assert.equal(runtimeStatus.embeddedSecretMatches, null)

  const embedded = `${OTI_CRON_START_MARKER}\nCRON_SECRET="old"\nBASE_URL="x"\n15 * * * *  curl "$BASE_URL/api/cron/x"\n${OTI_CRON_END_MARKER}\n`
  const stale = parseOtiCrontabStatus(embedded, 'current')
  assert.equal(stale.secretMode, 'embedded')
  assert.equal(stale.embeddedSecretMatches, false)
  const fresh = parseOtiCrontabStatus(embedded, 'old')
  assert.equal(fresh.embeddedSecretMatches, true)
})

test('status: unmanaged /api/cron/ lines outside the block are counted (legacy-block drift)', () => {
  const text = `CRON_SECRET="legacy"\n0 1 * * * curl "$BASE_URL/api/cron/backup"\n0 2 * * * curl "$BASE_URL/api/cron/xero-sync"\n${OTI_CRON_START_MARKER}\n15 * * * * curl "$BASE_URL/api/cron/wms-watchdog"\n${OTI_CRON_END_MARKER}\n`
  const status = parseOtiCrontabStatus(text, 'legacy')
  assert.equal(status.managedJobCount, 1)
  assert.equal(status.unmanagedCronApiLines, 2)
})

test('status: missing block reports absent with no secret mode', () => {
  const status = parseOtiCrontabStatus('0 9 * * * /bin/true\n', 'x')
  assert.equal(status.blockPresent, false)
  assert.equal(status.secretMode, 'none')
  assert.equal(status.managedJobCount, 0)
})

// --- Codex r1: runtime-mode safety --------------------------------------

test('emulate: mirrors the shell pipeline for the formats it must handle', () => {
  // plain and double-quoted values yield the clean secret
  assert.equal(emulateRuntimeSecretExtraction('CRON_SECRET=abc123\nOTHER=x\n'), 'abc123')
  assert.equal(emulateRuntimeSecretExtraction('CRON_SECRET="abc123"\n'), 'abc123')
  // values with = are preserved after the first = (cut -f2-)
  assert.equal(emulateRuntimeSecretExtraction('CRON_SECRET=a=b\n'), 'a=b')
  // single quotes are NOT stripped (tr only drops double quotes) — value differs from what Next loads
  assert.equal(emulateRuntimeSecretExtraction("CRON_SECRET='abc'\n"), "'abc'")
  // trailing comment stays in the value (differs from Next's parsing)
  assert.equal(emulateRuntimeSecretExtraction('CRON_SECRET=abc # rotate soon\n'), 'abc # rotate soon')
  // CRLF keeps the \r byte
  assert.equal(emulateRuntimeSecretExtraction('CRON_SECRET=abc\r\n'), 'abc\r')
  // export prefix does not match grep ^CRON_SECRET=
  assert.equal(emulateRuntimeSecretExtraction('export CRON_SECRET=abc\n'), null)
  // no line at all
  assert.equal(emulateRuntimeSecretExtraction('OTHER=x\n'), null)
})

test('build: runtime job lines guard against empty extraction ([ -n ]) so no empty bearer is sent', () => {
  const result = buildOtiCrontabBlock({
    jobs: [JOB],
    settings: new Map([['cron_wms_watchdog_enabled', 'true']]),
    secretRef: { kind: 'env-file', envFilePath: '/opt/app/.env' },
    baseUrl: BASE,
  })
  assert.ok(result.ok)
  assert.match(result.lines.join('\n'), /\[ -n "\$CRON_SECRET" \] && curl/)
})

test('build: env paths with cron-special characters are rejected', () => {
  assert.equal(isCronSafePath('/opt/app/.env'), true)
  assert.equal(isCronSafePath('/opt/50%off/.env'), false)
  assert.equal(isCronSafePath("/opt/o'brien/.env"), false)
  assert.equal(isCronSafePath('/opt/app\n/.env'), false)
  const result = buildOtiCrontabBlock({
    jobs: [JOB],
    settings: new Map([['cron_wms_watchdog_enabled', 'true']]),
    secretRef: { kind: 'env-file', envFilePath: '/opt/50%off/.env' },
    baseUrl: BASE,
  })
  assert.equal(result.ok, false)
})

test('status: parser counts the builder\'s own job lines (round-trip)', () => {
  const built = buildOtiCrontabBlock({
    jobs: [JOB],
    settings: new Map([['cron_wms_watchdog_enabled', 'true']]),
    secretRef: { kind: 'env-file', envFilePath: '/opt/app/.env' },
    baseUrl: BASE,
  })
  assert.ok(built.ok)
  const status = parseOtiCrontabStatus(built.lines.join('\n') + '\n', 'whatever')
  assert.equal(status.blockPresent, true)
  assert.equal(status.secretMode, 'runtime-env')
  assert.equal(status.managedJobCount, 1)
  assert.equal(status.unmanagedCronApiLines, 0)
})


// --- Codex r2: pipeline equivalence, status precision, log path ----------

test('emulate: binary (NUL-containing) .env is refused so runtime mode is never chosen (Codex r2)', () => {
  // GNU grep prints "Binary file … matches" for NUL content — the pipeline
  // then diverges from process.env, so the emulation must return null.
  assert.equal(emulateRuntimeSecretExtraction('CRON_SECRET=abc\n\0junk\n'), null)
  assert.equal(emulateRuntimeSecretExtraction('\0\nCRON_SECRET=abc\n'), null)
})

test('build: the cron log path defaults to the installer-owned LOG_DIR and is overridable (Codex r2)', () => {
  const def = buildOtiCrontabBlock({
    jobs: [JOB],
    settings: new Map([['cron_wms_watchdog_enabled', 'true']]),
    secretRef: { kind: 'literal', secret: 's' },
    baseUrl: BASE,
  })
  assert.ok(def.ok)
  assert.ok(def.lines.join('\n').includes(`>> '${DEFAULT_CRON_LOG_PATH}' 2>&1`))
  assert.doesNotMatch(def.lines.join('\n'), /\/var\/log\/oti-cron\.log/)

  const custom = buildOtiCrontabBlock({
    jobs: [JOB],
    settings: new Map([['cron_wms_watchdog_enabled', 'true']]),
    secretRef: { kind: 'literal', secret: 's' },
    baseUrl: BASE,
    logPath: '/srv/logs/cron.log',
  })
  assert.ok(custom.ok)
  assert.match(custom.lines.join('\n'), />> '\/srv\/logs\/cron\.log' 2>&1/)

  // an unsafe log path is rejected, not written
  const bad = buildOtiCrontabBlock({
    jobs: [JOB],
    settings: new Map([['cron_wms_watchdog_enabled', 'true']]),
    secretRef: { kind: 'literal', secret: 's' },
    baseUrl: BASE,
    logPath: '/srv/50%/cron.log',
  })
  assert.equal(bad.ok, false)
})

test('status: runtime-env exposes the ACTUAL .env path the cron line reads (Codex r2)', () => {
  const built = buildOtiCrontabBlock({
    jobs: [JOB],
    settings: new Map([['cron_wms_watchdog_enabled', 'true']]),
    secretRef: { kind: 'env-file', envFilePath: '/etc/ims/.env' },
    baseUrl: BASE,
  })
  assert.ok(built.ok)
  const status = parseOtiCrontabStatus(built.lines.join('\n') + '\n', 's')
  assert.equal(status.secretMode, 'runtime-env')
  assert.equal(status.runtimeEnvPath, '/etc/ims/.env')
})

test('status: a block with neither embedded literal nor runtime command is unknown/malformed (Codex r2)', () => {
  const malformed = `${OTI_CRON_START_MARKER}\nBASE_URL="x"\n15 * * * * curl "$BASE_URL/api/cron/x"\n${OTI_CRON_END_MARKER}\n`
  const status = parseOtiCrontabStatus(malformed, 'current')
  assert.equal(status.blockPresent, true)
  assert.equal(status.secretMode, 'unknown')
  assert.equal(status.runtimeEnvPath, null)
  assert.equal(status.embeddedSecretMatches, null)
})


// --- Codex r3: log-path quoting + precise runtime classification --------

test('build: the log path is single-quoted in the redirect (no injection via spaces/operators) (Codex r3)', () => {
  const result = buildOtiCrontabBlock({
    jobs: [JOB],
    settings: new Map([['cron_wms_watchdog_enabled', 'true']]),
    secretRef: { kind: 'literal', secret: 's' },
    baseUrl: BASE,
    logPath: '/var/log/one-two-inventory/cron.log',
  })
  assert.ok(result.ok)
  assert.match(result.lines.join('\n'), />> '\/var\/log\/one-two-inventory\/cron\.log' 2>&1/)
})

test('status: a block whose job lines read DIFFERENT env paths is unknown, not runtime-env (Codex r3)', () => {
  const mixed = [
    OTI_CRON_START_MARKER,
    'BASE_URL="x"',
    "15 * * * *  CRON_SECRET=$(grep -m1 '^CRON_SECRET=' '/a/.env' | cut -d= -f2- | tr -d '\"') && [ -n \"$CRON_SECRET\" ] && curl \"$BASE_URL/api/cron/a\"",
    "30 * * * *  CRON_SECRET=$(grep -m1 '^CRON_SECRET=' '/b/.env' | cut -d= -f2- | tr -d '\"') && [ -n \"$CRON_SECRET\" ] && curl \"$BASE_URL/api/cron/b\"",
    OTI_CRON_END_MARKER,
    '',
  ].join('\n')
  const status = parseOtiCrontabStatus(mixed, 'current')
  assert.equal(status.secretMode, 'unknown')
  assert.equal(status.runtimeEnvPath, null)
})

test('status: a block where only SOME job lines carry the runtime command is unknown (Codex r3)', () => {
  const partial = [
    OTI_CRON_START_MARKER,
    'BASE_URL="x"',
    "15 * * * *  CRON_SECRET=$(grep -m1 '^CRON_SECRET=' '/a/.env' | cut -d= -f2- | tr -d '\"') && [ -n \"$CRON_SECRET\" ] && curl \"$BASE_URL/api/cron/a\"",
    '30 * * * *  curl "$BASE_URL/api/cron/b"',
    OTI_CRON_END_MARKER,
    '',
  ].join('\n')
  const status = parseOtiCrontabStatus(partial, 'current')
  assert.equal(status.secretMode, 'unknown')
})

test('status: a commented-out runtime command does not classify a block as runtime-env (Codex r3)', () => {
  const commented = [
    OTI_CRON_START_MARKER,
    'BASE_URL="x"',
    "# 15 * * * *  CRON_SECRET=$(grep -m1 '^CRON_SECRET=' '/a/.env' | cut -d= -f2- | tr -d '\"') && curl \"$BASE_URL/api/cron/a\"",
    OTI_CRON_END_MARKER,
    '',
  ].join('\n')
  const status = parseOtiCrontabStatus(commented, 'current')
  // The commented command is NOT counted as a live runtime job — no job lines,
  // no literal → the benign all-disabled block, not a false runtime path.
  assert.equal(status.managedJobCount, 0)
  assert.equal(status.runtimeEnvPath, null)
})


// --- Codex r4: literal-secret safety + tighter runtime classification ---

test('build: a literal secret that could break out of the crontab quote is rejected (Codex r4)', () => {
  for (const bad of ['abc"def', 'abc\\def', 'abc`id`', 'abc$x', 'abc\nrm -rf /']) {
    const result = buildOtiCrontabBlock({
      jobs: [JOB],
      settings: new Map([['cron_wms_watchdog_enabled', 'true']]),
      secretRef: { kind: 'literal', secret: bad },
      baseUrl: BASE,
    })
    assert.equal(result.ok, false, `secret ${JSON.stringify(bad)} should be rejected`)
  }
  assert.equal(isCrontabEmbeddableSecret('a1b2c3d4e5f6'), true)
  assert.equal(isCrontabEmbeddableSecret('has"quote'), false)
})

test('status: a decoy echo of the grep fragment is NOT classified runtime-env (Codex r4)', () => {
  const decoy = [
    OTI_CRON_START_MARKER,
    'BASE_URL="x"',
    // contains the leading grep fragment but not the full extraction pipeline
    "15 * * * *  echo \"CRON_SECRET=$(grep -m1 '^CRON_SECRET=' '/a/.env')\" && curl \"$BASE_URL/api/cron/a\"",
    OTI_CRON_END_MARKER,
    '',
  ].join('\n')
  const status = parseOtiCrontabStatus(decoy, 'current')
  assert.equal(status.secretMode, 'unknown')
})

test('status: an embedded literal does NOT short-circuit — all-runtime job lines classify runtime-env and get path-verified (Codex r4)', () => {
  const hybrid = [
    OTI_CRON_START_MARKER,
    'CRON_SECRET="stale-leftover"',
    'BASE_URL="x"',
    "15 * * * *  CRON_SECRET=$(grep -m1 '^CRON_SECRET=' '/a/.env' | cut -d= -f2- | tr -d '\"') && curl \"$BASE_URL/api/cron/a\"",
    OTI_CRON_END_MARKER,
    '',
  ].join('\n')
  const status = parseOtiCrontabStatus(hybrid, 'current')
  // NOT falsely 'embedded/healthy' off the stale literal — the job line reads
  // the .env at runtime, so we classify runtime-env and verify that path.
  assert.equal(status.secretMode, 'runtime-env')
  assert.equal(status.runtimeEnvPath, '/a/.env')
})

test('status: a truly mixed block (embedded literal + DIFFERING runtime paths) is unknown (Codex r4)', () => {
  const mixed = [
    OTI_CRON_START_MARKER,
    'CRON_SECRET="current"',
    'BASE_URL="x"',
    "15 * * * *  CRON_SECRET=$(grep -m1 '^CRON_SECRET=' '/a/.env' | cut -d= -f2- | tr -d '\"') && curl \"$BASE_URL/api/cron/a\"",
    "30 * * * *  CRON_SECRET=$(grep -m1 '^CRON_SECRET=' '/b/.env' | cut -d= -f2- | tr -d '\"') && curl \"$BASE_URL/api/cron/b\"",
    OTI_CRON_END_MARKER,
    '',
  ].join('\n')
  const status = parseOtiCrontabStatus(mixed, 'current')
  assert.equal(status.secretMode, 'unknown')
})

test('status: a clean embedded block (literal + $CRON_SECRET job lines) is still classified embedded (Codex r4)', () => {
  const embedded = [
    OTI_CRON_START_MARKER,
    'CRON_SECRET="current"',
    'BASE_URL="x"',
    '15 * * * *  curl -H "Authorization: Bearer $CRON_SECRET" "$BASE_URL/api/cron/a"',
    OTI_CRON_END_MARKER,
    '',
  ].join('\n')
  const status = parseOtiCrontabStatus(embedded, 'current')
  assert.equal(status.secretMode, 'embedded')
  assert.equal(status.embeddedSecretMatches, true)
})


// --- Codex r5: robust splice + anchored runtime + benign zero-job ---

test('splice: strips ALL existing blocks (multiple, whitespace/CRLF markers) and preserves operator lines (Codex r5)', () => {
  const existing = [
    '0 9 * * * /opt/op.sh',
    OTI_CRON_START_MARKER, 'A', OTI_CRON_END_MARKER,
    '5 * * * * /opt/other.sh',
    OTI_CRON_START_MARKER + '  ',  // trailing whitespace
    'B',
    OTI_CRON_END_MARKER + '\t',
    '@reboot /opt/init.sh',
  ].join('\n')
  const out = spliceOtiBlock(existing, [OTI_CRON_START_MARKER, 'FRESH', OTI_CRON_END_MARKER])
  assert.match(out, /\/opt\/op\.sh/)
  assert.match(out, /\/opt\/other\.sh/)
  assert.match(out, /@reboot \/opt\/init\.sh/)
  assert.doesNotMatch(out, /^A$/m)
  assert.doesNotMatch(out, /^B$/m)
  // exactly one managed block remains
  assert.equal(out.split(OTI_CRON_START_MARKER).length - 1, 1)
  assert.match(out, /FRESH/)
})

test('splice: an unclosed START marker does not delete the operator lines after it (Codex r5)', () => {
  const existing = ['0 8 * * * /opt/keep.sh', OTI_CRON_START_MARKER, '0 9 * * * /opt/keep2.sh'].join('\n')
  const out = spliceOtiBlock(existing, [OTI_CRON_START_MARKER, 'FRESH', OTI_CRON_END_MARKER])
  assert.match(out, /\/opt\/keep\.sh/)
  assert.match(out, /\/opt\/keep2\.sh/)
})

test('splice: is idempotent across repeated saves (Codex r5)', () => {
  const block = [OTI_CRON_START_MARKER, 'X', OTI_CRON_END_MARKER]
  const once = spliceOtiBlock('0 9 * * * /opt/op.sh\n', block)
  const twice = spliceOtiBlock(once, block)
  assert.equal(once, twice)
  assert.equal(twice.split(OTI_CRON_START_MARKER).length - 1, 1)
})

test('stripOtiBlocks: END-before-START does not corrupt surrounding lines (Codex r5)', () => {
  const text = [OTI_CRON_END_MARKER, '0 8 * * * /opt/a.sh', OTI_CRON_START_MARKER, '0 9 * * * /opt/b.sh'].join('\n')
  const out = stripOtiBlocks(text)
  assert.match(out, /\/opt\/a\.sh/)
  assert.match(out, /\/opt\/b\.sh/)
  assert.doesNotMatch(out, /OTI CRON/)
})

test('status: a full-pipeline extraction buried inside echo (never assigned) is NOT runtime-env (Codex r5)', () => {
  const decoy = [
    OTI_CRON_START_MARKER,
    'BASE_URL="x"',
    "15 * * * *  echo \"CRON_SECRET=$(grep -m1 '^CRON_SECRET=' '/a/.env' | cut -d= -f2- | tr -d '\"')\" && curl \"$BASE_URL/api/cron/a\"",
    OTI_CRON_END_MARKER,
    '',
  ].join('\n')
  const status = parseOtiCrontabStatus(decoy, 'current')
  assert.equal(status.secretMode, 'unknown')
})

test('status: an all-disabled (zero-job) embedded block is embedded, and runtime is runtime-env — not unknown (Codex r5)', () => {
  const emptyEmbedded = [OTI_CRON_START_MARKER, 'CRON_SECRET="cur"', 'BASE_URL="x"', OTI_CRON_END_MARKER, ''].join('\n')
  const e = parseOtiCrontabStatus(emptyEmbedded, 'cur')
  assert.equal(e.secretMode, 'embedded')
  assert.equal(e.embeddedSecretMatches, true)
  assert.equal(e.managedJobCount, 0)

  const emptyRuntime = [OTI_CRON_START_MARKER, '# CRON_SECRET is read from /opt/app/.env at runtime — rotating it needs no crontab re-sync.', 'BASE_URL="x"', OTI_CRON_END_MARKER, ''].join('\n')
  const r = parseOtiCrontabStatus(emptyRuntime, 'cur')
  assert.equal(r.secretMode, 'runtime-env')
  assert.equal(r.runtimeEnvPath, '/opt/app/.env')
  assert.equal(r.managedJobCount, 0)
})

// --- Codex r6: orphaned managed lines + malformed zero-job block ----------

test('splice/strip: an unclosed block\'s own generated job lines do NOT survive as duplicates (Codex r6)', () => {
  const orphan = "15 * * * *  CRON_SECRET=$(grep -m1 '^CRON_SECRET=' '/a/.env' | cut -d= -f2- | tr -d '\"') && [ -n \"$CRON_SECRET\" ] && curl -sf -o /dev/null -H \"Authorization: Bearer $CRON_SECRET\" \"$BASE_URL/wms-watchdog\" >> '/var/log/x' 2>&1"
  const existing = ['0 9 * * * /opt/operator.sh', OTI_CRON_START_MARKER, 'BASE_URL="x"', orphan].join('\n')  // unclosed: no END
  const stripped = stripOtiBlocks(existing)
  assert.match(stripped, /\/opt\/operator\.sh/)            // operator line kept
  assert.doesNotMatch(stripped, /wms-watchdog/)             // orphaned managed job removed
  // and a full splice yields exactly one live watchdog job
  const out = spliceOtiBlock(existing, [OTI_CRON_START_MARKER, orphan.replace('wms-watchdog', 'wms-watchdog'), OTI_CRON_END_MARKER])
  assert.equal((out.match(/wms-watchdog/g) || []).length, 1)
})

test('status: a marker-only / arbitrary zero-job block (no literal, no runtime header) is unknown (Codex r6)', () => {
  const markerOnly = [OTI_CRON_START_MARKER, OTI_CRON_END_MARKER, ''].join('\n')
  assert.equal(parseOtiCrontabStatus(markerOnly, 'cur').secretMode, 'unknown')
  const arbitrary = [OTI_CRON_START_MARKER, '# hand-edited junk', 'FOO="bar"', OTI_CRON_END_MARKER, ''].join('\n')
  assert.equal(parseOtiCrontabStatus(arbitrary, 'cur').secretMode, 'unknown')
})

test('strip: an operator line that merely mentions Bearer is not our managed signature (kept)', () => {
  // Our signature is specifically `Bearer $CRON_SECRET" "$BASE_URL/` — a plain
  // operator curl with a different auth is preserved.
  const existing = '0 3 * * * curl -H "Authorization: Bearer mytoken" https://ops.example.com/health'
  assert.equal(stripOtiBlocks(existing), existing)
})


// --- Codex r7: bounded orphan sweep + strict header path ----------------

test('strip: an operator line matching our signature OUTSIDE any block is preserved (Codex r7)', () => {
  // No block at all — a coincidental operator match must never be stripped.
  const op = '0 3 * * * curl -sf -o /dev/null -H "Authorization: Bearer $CRON_SECRET" "$BASE_URL/operator-owned"'
  assert.equal(stripOtiBlocks(op), op)
  // And after a complete block elsewhere, the outside operator line still survives.
  const withBlock = [op, OTI_CRON_START_MARKER, 'X', OTI_CRON_END_MARKER].join('\n')
  assert.match(stripOtiBlocks(withBlock), /operator-owned/)
})

test('strip: an unclosed block sweeps our remnants but keeps an operator line in the tail (Codex r7)', () => {
  const orphan = '15 * * * *  x && curl -sf -o /dev/null -H "Authorization: Bearer $CRON_SECRET" "$BASE_URL/wms-watchdog" >> (log)'
  const existing = [
    OTI_CRON_START_MARKER,
    '# Managed by One Two Inventory — do not edit manually',
    'BASE_URL="x"',
    orphan,
    '0 2 * * * /opt/operator-in-tail.sh',   // operator line inside the malformed tail
  ].join('\n')
  const out = stripOtiBlocks(existing)
  assert.doesNotMatch(out, /wms-watchdog/)          // our orphan removed
  assert.doesNotMatch(out, /BASE_URL="x"/)          // our remnant removed
  assert.match(out, /\/opt\/operator-in-tail\.sh/)  // operator line kept
})

test('strip: a second START after an unclosed one bounds the tail (Codex r7)', () => {
  const orphan = '15 * * * *  -H "Authorization: Bearer $CRON_SECRET" "$BASE_URL/a"'
  const existing = [
    OTI_CRON_START_MARKER, orphan,                 // unclosed
    OTI_CRON_START_MARKER, 'Y', OTI_CRON_END_MARKER, // complete
    '0 9 * * * /opt/keep.sh',
  ].join('\n')
  const out = stripOtiBlocks(existing)
  assert.doesNotMatch(out, /"\$BASE_URL\/a"/)
  assert.doesNotMatch(out, /^Y$/m)
  assert.match(out, /\/opt\/keep\.sh/)
  assert.doesNotMatch(out, /OTI CRON/)
})

test('status: a zero-job runtime header with a non-cron-safe path is unknown, not runtime-env (Codex r7)', () => {
  const bad = [
    OTI_CRON_START_MARKER,
    "# CRON_SECRET is read from /opt/o'brien/.env at runtime — rotating it needs no crontab re-sync.",
    'BASE_URL="x"',
    OTI_CRON_END_MARKER,
    '',
  ].join('\n')
  assert.equal(parseOtiCrontabStatus(bad, 'cur').secretMode, 'unknown')
})


// --- Codex r8: in-place replacement + identical signature + %-path -------

test('splice: the managed block keeps its POSITION (before an operator env assignment) (Codex r8)', () => {
  // Block originally sits between PATH and SHELL. A restrictive SHELL below it
  // must stay below it — moving the block past SHELL would break every job.
  const existing = ['PATH=/custom/bin', OTI_CRON_START_MARKER, 'OLD', OTI_CRON_END_MARKER, 'SHELL=/bin/bash', '0 9 * * * below'].join('\n')
  const out = spliceOtiBlock(existing, [OTI_CRON_START_MARKER, 'NEW', OTI_CRON_END_MARKER]).split('\n')
  const startAt = out.indexOf(OTI_CRON_START_MARKER)
  const pathAt = out.indexOf('PATH=/custom/bin')
  const shellAt = out.indexOf('SHELL=/bin/bash')
  assert.ok(pathAt < startAt && startAt < shellAt, 'block must stay between PATH and SHELL')
  assert.match(out.join('\n'), /NEW/)
  assert.doesNotMatch(out.join('\n'), /OLD/)
})

test('splice: with no prior block the fresh block is appended after operator lines (Codex r8)', () => {
  const out = spliceOtiBlock('PATH=/custom/bin\n0 9 * * * op\n', [OTI_CRON_START_MARKER, 'X', OTI_CRON_END_MARKER]).split('\n')
  assert.ok(out.indexOf('0 9 * * * op') < out.indexOf(OTI_CRON_START_MARKER))
})

test('splice: repeated saves keep the block position stable and are idempotent (Codex r8)', () => {
  const block = [OTI_CRON_START_MARKER, 'X', OTI_CRON_END_MARKER]
  const once = spliceOtiBlock('PATH=/p\n' + block.join('\n') + '\nSHELL=/s\n', block)
  const twice = spliceOtiBlock(once, block)
  assert.equal(once, twice)
})

test('strip: an operator line using --header long form (not -H) is preserved in a malformed tail (Codex r8)', () => {
  const existing = [
    OTI_CRON_START_MARKER,
    '30 * * * * curl --header "Authorization: Bearer $CRON_SECRET" "$BASE_URL/operator-owned"',
  ].join('\n')  // unclosed
  const out = stripOtiBlocks(existing)
  assert.match(out, /operator-owned/)   // --header form is NOT our -H signature
})

test('status: multi-job runtime block whose path is not cron-safe is unknown (Codex r8)', () => {
  const cmd = (p: string) => `15 * * * *  CRON_SECRET=$(grep -m1 '^CRON_SECRET=' '${p}' | cut -d= -f2- | tr -d '"') && curl -H "Authorization: Bearer $CRON_SECRET" "$BASE_URL/a"`
  const bad = [OTI_CRON_START_MARKER, 'BASE_URL="x"', cmd('/opt/50%off/.env'), OTI_CRON_END_MARKER, ''].join('\n')
  assert.equal(parseOtiCrontabStatus(bad, 'cur').secretMode, 'unknown')
})
