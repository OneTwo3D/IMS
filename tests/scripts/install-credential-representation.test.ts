/**
 * o3d-2sm1.5 r39 — THE ROTATED PASSWORD COULD BE ONE THE APPLICATION CANNOT REPRESENT, AND A
 * FAILURE AFTER `ALTER ROLE` LEFT NO WAY BACK. Two Codex HIGHs, both about the same eleven lines.
 *
 * FINDING 1. `ALTER USER "x" WITH PASSWORD '${DB_PASSWORD}'` set the role's password to the
 * LITERAL bytes of DB_PASSWORD, and the next statement interpolated those same bytes RAW into
 * `postgresql://user:${DB_PASSWORD}@host:port/db`. The application does not read that URL the way
 * the installer wrote it: node-postgres percent-DECODES the userinfo. So `abc%2Fdef` was committed
 * on the role and `abc/def` was handed to the driver; a raw `/`, `?` or `#` made the URL
 * unparseable altogether; and an apostrophe never reached the URL at all, because it ended the SQL
 * literal. All of it happens AFTER the predecessor has been stopped and its credential taken away.
 *
 * FINDING 2. The `ALTER` COMMITS, and everything that made the new credential usable came after
 * it: two in-memory flags, a recomposed URL, and a `cat >` that TRUNCATED the application's only
 * environment file before writing a byte of the replacement. A kill, a power loss, an ENOSPC or a
 * refused chown anywhere in that sequence left PostgreSQL on the new password and `.env` on the old
 * one — inside the stopped, fenced window, with no record of what had happened.
 *
 * WHAT THIS FILE PROVES, against real PostgreSQL clusters and the real `pg` in node_modules:
 *
 *   1. the shipped encoder and the INSTALLED driver agree, byte for byte, on 28 reserved-character
 *      passwords — the URL install.sh composes parses back to the literal the ALTER set, and opens
 *      a connection the server accepts;
 *   2. an explicit rotation to a password full of reserved characters ends with the server holding
 *      that password, `.env` naming it, and node-postgres connecting with it;
 *   3. the shipped decoder reaches the same answer node-postgres does for 25 legacy raw URLs,
 *      including every malformed-escape spelling;
 *   4. `.env` is PUBLISHED BY RENAME and never truncated in place;
 *   5. each of the four interruption outcomes between the ALTER and the environment file is
 *      reconciled by the next run, and the one that cannot be is refused with the journal intact.
 *
 * THE DRIVER, NOT THE SPECIFICATION. Every encoding assertion here goes through
 * `pg-connection-string` and `pg.Client` out of this repo's node_modules, for the reason the
 * clusters are real: the finding is that the installer's model of what the application reads was
 * wrong, and a test written from the same model would agree with it.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, linkSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { parse } from 'pg-connection-string'

import {
  base64,
  connectWithDriver,
  DECODE_HELPER,
  decodeVar,
  envDatabaseUrl,
  installRoot,
  installVars,
  journalPath,
  journalValue,
  NEXT_RUN_BODY,
  readVar,
  REINSTALL_BODY,
  runShipped,
  seedLiveInstallation,
  SHIPPED_ROTATION_UP_TO_THE_CLEAR,
  writeInstalledEnv,
} from './install-shell-rig.ts'
import { type Cluster, currentUser, freePort, startCluster } from './real-postgres-cluster.ts'

/**
 * PASSWORDS THAT BREAK ONE OF THE TWO GRAMMARS. Every one of these is a password an operator can
 * type, and every one of them was mis-installed, mis-read or refused before r39.
 */
const RESERVED_CHARACTER_PASSWORDS = [
  'plain',
  'abc/def', // raw: "Invalid URL"
  'abc?def', // raw: "Invalid URL"
  'abc#def', // raw: "Invalid URL"
  'abc@def',
  'abc:def',
  "it's", // raw: ends the SQL literal
  'a b',
  'a%2Fb', // raw: the driver sees "a/b"
  'a%b',
  'a%',
  'a%2',
  '%FF', // raw: "URI malformed"
  'p@ss:w/rd?#%',
  '\\back\\slash',
  'unicode-ünïcodé',
  'a"b`c$d',
  '[]{}<>|^',
  'a+b',
  'a=b&c',
  ';;;',
  '~-._',
  'AAA%25BBB', // raw: the driver sees "AAA%BBB"
  // r40 (Codex HIGH) — THE BYTES `$( )` DELETES. Every one of these is a password the r39 encoder
  // and the r39 driver both handled correctly and the r39 SHELL CAPTURE truncated on the way back,
  // so the recovery reported a password the server does not have. They are in the corpus, not in a
  // test of their own, because the corpus is what says "these are the representations that work".
  'ends-with-a-newline\n',
  'two-trailing-newlines\n\n',
  '\n', // a password that is ONLY a newline: recovery used to return the empty string
  'has\na-newline-inside',
  'crlf-terminated\r\n', // the \r survives a capture and the \n does not, which is the subtle half
]

/** Legacy URLs no r39 installer wrote, where the only question is what the DRIVER makes of them. */
const LEGACY_RAW_USERINFO = [
  'plain', 'a%2Fb', 'a%2fb', 'AAA%25BBB', 'a%b', 'a%', 'a%2', 'a%zz', '%20', 'a b', "it's",
  'abc@def', 'abc:def', '\\back\\slash', '%C3%BC', '%41%42%43', '100%25pure', '50%off', '%%%',
  'a%2Fb%2Fc', '~-._',
  // r40: a legacy URL whose decoded form ends in a newline. pg-connection-string returns the
  // newline; a recovery that captures through `$( )` returns the string without it.
  'a%0A', '%0A', 'a%0D%0A', 'a%0A%0A',
]

// ---------------------------------------------------------------------------
// 1. THE LOAD-BEARING ONE: what the installer writes is what the driver reads
// ---------------------------------------------------------------------------

test('r39: a password of reserved characters survives SQL, the URL and the installed driver', async () => {
  // THE FINDING, MEASURED END TO END, ON THE ONE PASSWORD THE OLD CODE COULD BREAK IN EVERY WAY AT
  // ONCE: an apostrophe (SQL), a slash, a question mark and a hash (URL structure), a percent
  // (URL decoding) and an at-sign and colon (userinfo delimiters).
  //
  // THE CHAIN IS UNBROKEN AND EVERY LINK IS REAL: sql_quote_literal() puts it on a real server,
  // compose_database_url() writes it into a real .env, and `pg.Client` — the driver the application
  // uses, out of this repo's node_modules — opens a connection with what it reads back out.
  //
  // MUTATION ROUTES (each measured by making the change and re-running):
  //   1. drop the encode: make compose_database_url() interpolate `${password}` raw. This test
  //      fails at connectWithDriver with "Invalid URL", and test 2 fails with it too. Tests 3, 4
  //      and 5 stay green (3 is about DEcoding a URL this installer did not write, 4 is about
  //      rename semantics, 5 supplies no reserved characters).
  //   2. drop the SQL quote: put `'${DB_PASSWORD}'` back in the ALTER. The rotation refuses with a
  //      syntax error at the apostrophe and this test fails on the run status, alone.
  //   3. drop the decode from installed_database_password(): the recovered value is the URL's
  //      BYTES, so the second run below reads a different password than the one installed and
  //      reports a rotation nobody asked for — this test fails on ROTATION_PENDING, alone.
  const root = installRoot('ims-repr-')
  let cluster: Cluster | undefined
  try {
    cluster = startCluster(root, 'live', await freePort(), '127.0.0.1')
    seedLiveInstallation(cluster)
    writeInstalledEnv(root, cluster.port, 'live-password')

    const target = "p@ss:w/rd?#%2F'and-a-space [x]"
    const run = runShipped(
      { ...installVars(cluster, root), DB_PASSWORD_B64: base64(target) },
      `
        DB_PASSWORD="$(printf '%s' "\${DB_PASSWORD_B64}" | base64 -d)"
        ${REINSTALL_BODY}
        FENCE_ARMED=true
        DB_FENCE_UP=true
        rotate_database_password_in_fenced_window
        echo "FINAL_ROTATED=\${DB_ROLE_CREDENTIALS_ROTATED}"
      `,
    )
    assert.equal(run.status, 0, run.output)
    assert.match(run.output, /FINAL_ROTATED=true/, 'the rotation must have happened')

    // (a) THE SERVER HAS THE LITERAL. Asked with libpq, which does no URL parsing at all, so this
    //     is a statement about the bytes ALTER USER committed and nothing else.
    assert.equal(
      cluster.psql(['-c', 'SELECT 1'], { host: '127.0.0.1', user: 'imsuser', password: target, database: 'one_two_inventory' }),
      '1',
      'the server must hold the literal password, apostrophe and all',
    )

    // (b) THE URL THE INSTALLER WROTE PARSES BACK TO THAT LITERAL, through the installed parser.
    const written = envDatabaseUrl(root)
    const parsed = parse(written)
    assert.equal(parsed.password, target, `the driver must read back the literal from ${written}`)
    assert.equal(parsed.user, 'imsuser')
    assert.equal(parsed.host, '127.0.0.1')
    assert.equal(parsed.port, String(cluster.port))
    assert.equal(parsed.database, 'one_two_inventory')

    // (c) AND IT OPENS A CONNECTION. The application's own driver, the application's own file.
    assert.equal(await connectWithDriver(written), 'imsuser', 'node-postgres must authenticate with the URL install.sh wrote')

    // (d) A RE-RUN READS IT BACK AS THE INSTALLED CREDENTIAL AND ASKS FOR NOTHING. This is the
    //     decode half: without it the recovered value is the percent-encoded bytes, which differ
    //     from the literal, and an ordinary re-install would rotate a live credential again.
    const rerun = runShipped(installVars(cluster, root), `
      ${REINSTALL_BODY}
      echo "RECOVERED_B64=$(printf '%s' "\${DB_PASSWORD_INSTALLED}" | base64 | tr -d '\\n')"
    `)
    assert.equal(rerun.status, 0, rerun.output)
    assert.match(rerun.output, /ROTATION_PENDING=false/, 'pressing Enter over a reserved-character password must not ask for a rotation')
    assert.equal(
      Buffer.from(readVar(rerun.output, 'RECOVERED_B64'), 'base64').toString('utf8'),
      target,
      'and the credential it recovered is the literal the server has',
    )
  } finally {
    cluster?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. The encoder and the installed driver, across the whole reserved set
// ---------------------------------------------------------------------------

test('r39: the shipped encoder and the installed node-postgres agree on every reserved character', async () => {
  // ONE PASSWORD PROVES THE CHAIN; THIS PROVES THE SET. Every value in RESERVED_CHARACTER_PASSWORDS
  // is encoded by the SHIPPED url_encode_userinfo(), composed by the SHIPPED
  // compose_database_url(), parsed by the INSTALLED pg-connection-string, and — for the subset a
  // role can hold — used to open a real connection.
  //
  // THE DECODE IS ASSERTED AS THE INVERSE OF THE ENCODE, not as a second implementation of it: the
  // shipped url_decode_userinfo() is run over the shipped encoder's own output, in the same shell,
  // and must return the input. An encoder and a decoder that are wrong in the same direction pass
  // that; the driver comparison beside it is what makes it load-bearing.
  //
  // MUTATION ROUTES (each measured by making the change and re-running):
  //   1. narrow the encoder's kept set to `[A-Za-z0-9]` — i.e. encode `-._~` as well. Everything
  //      still round-trips (those four are unreserved, so decodeURIComponent restores them) and
  //      this test stays GREEN, correctly: it is a statement about agreement, not about minimality.
  //   2. widen it to keep `/` as well (`[A-Za-z0-9._~/-]`). `abc/def` then ends the authority and
  //      pg-connection-string reads the host as `def`; this test fails on that row, and test 1
  //      fails at connectWithDriver. Nothing else in either installer file notices.
  //   3. make url_decode_userinfo() decode `%` sequences that are not two hex digits (drop the
  //      `{2}` from the sed pattern): `a%2` and `a%` stop round-tripping and this test fails on
  //      those rows, and test 3 fails on four legacy rows. Alone in this file otherwise.
  const root = installRoot('ims-repr-')
  let cluster: Cluster | undefined
  try {
    cluster = startCluster(root, 'live', await freePort(), '127.0.0.1')
    seedLiveInstallation(cluster)

    const run = runShipped(
      { ...installVars(cluster, root), CASES_B64: base64(`${RESERVED_CHARACTER_PASSWORDS.map(base64).join('\n')}\n`) },
      `
        # THE CASES ARE CARRIED AS BASE64, ONE PER LINE (r40). The corpus now contains passwords
        # that CONTAIN newlines, and a \`while read\` over the raw values would split those into two
        # cases and measure neither — a transport that silently drops the rows the round is about.
        ${DECODE_HELPER}
        printf '%s' "\${CASES_B64}" | base64 -d > "\${APP_DIR}/cases"
        while IFS= read -r line; do
          # AND EVERY MEASUREMENT GOES THROUGH THE SHIPPED \`capture\` (r40, Codex HIGH). Written as
          # \`encoded="$(url_encode_userinfo ...)"\` this loop deletes exactly the bytes it exists to
          # prove are kept, and every row passes because both sides were truncated equally.
          capture pw decode_b64 "\${line}"
          capture encoded url_encode_userinfo "\${pw}"
          capture decoded url_decode_userinfo "\${encoded}"
          capture url compose_database_url "\${DB_USER}" "\${pw}" "\${DB_HOST}" "\${DB_PORT}" "\${DB_NAME}"
          printf 'ROW\\t%s\\t%s\\t%s\\n' \\
            "$(printf '%s' "\${encoded}" | base64 | tr -d '\\n')" \\
            "$(printf '%s' "\${decoded}" | base64 | tr -d '\\n')" \\
            "$(printf '%s' "\${url}" | base64 | tr -d '\\n')"
        done < "\${APP_DIR}/cases"
      `,
    )
    assert.equal(run.status, 0, run.output)

    const rows = run.output.split('\n').filter((line) => line.startsWith('ROW\t')).map((line) => line.split('\t').slice(1))
    assert.equal(rows.length, RESERVED_CHARACTER_PASSWORDS.length, `precondition: every case must be measured:\n${run.output}`)

    for (const [index, password] of RESERVED_CHARACTER_PASSWORDS.entries()) {
      const [encodedB64, decodedB64, urlB64] = rows[index]
      const encoded = Buffer.from(encodedB64, 'base64').toString('utf8')
      const decoded = Buffer.from(decodedB64, 'base64').toString('utf8')
      const url = Buffer.from(urlB64, 'base64').toString('utf8')

      // The encoder emits nothing that any of the three layers reads as structure.
      assert.match(encoded, /^[A-Za-z0-9._~%-]*$/, `${JSON.stringify(password)} encoded to ${encoded}, which is not unreserved-plus-percent`)
      assert.doesNotMatch(encoded, /%(?![0-9A-F]{2})/, `${JSON.stringify(password)} encoded to a malformed escape: ${encoded}`)

      // The shipped decoder inverts the shipped encoder...
      assert.equal(decoded, password, `the shipped decoder must invert the shipped encoder for ${JSON.stringify(password)}`)

      // ...and so does the INSTALLED driver, which is the half that matters.
      const parsed = parse(url)
      assert.equal(parsed.password, password, `node-postgres must read ${JSON.stringify(password)} back out of ${url}`)
      assert.equal(parsed.user, 'imsuser', `the userinfo must not leak into the role for ${JSON.stringify(password)}: ${url}`)
      assert.equal(parsed.host, '127.0.0.1', `the userinfo must not leak into the host for ${JSON.stringify(password)}: ${url}`)
      assert.equal(parsed.port, String(cluster.port), `the userinfo must not leak into the port for ${JSON.stringify(password)}: ${url}`)
      assert.equal(parsed.database, 'one_two_inventory', `the userinfo must not leak into the database for ${JSON.stringify(password)}: ${url}`)
    }

    // AND THREE OF THEM ARE PUT ON A REAL ROLE AND CONNECTED WITH. The parse assertions above are
    // about a string; these are about a server accepting it, which is the thing the finding says
    // stopped happening.
    for (const password of ["it's", 'a%2Fb', 'p@ss:w/rd?#%']) {
      const set = runShipped(
        { ...installVars(cluster, root), DB_PASSWORD_B64: base64(password) },
        `
          DB_PASSWORD="$(printf '%s' "\${DB_PASSWORD_B64}" | base64 -d)"
          quoted="$(sql_quote_literal "\${DB_PASSWORD}")"
          pg_local_psql -q >/dev/null <<EOSQL || exit 7
            SET standard_conforming_strings = on;
            ALTER USER "\${DB_USER}" WITH PASSWORD \${quoted};
EOSQL
          echo "URL_B64=$(printf '%s' "$(compose_database_url "\${DB_USER}" "\${DB_PASSWORD}" "\${DB_HOST}" "\${DB_PORT}" "\${DB_NAME}")" | base64 | tr -d '\\n')"
        `,
      )
      assert.equal(set.status, 0, `${JSON.stringify(password)} must be settable as a SQL literal:\n${set.output}`)
      const url = Buffer.from(readVar(set.output, 'URL_B64'), 'base64').toString('utf8')
      assert.equal(await connectWithDriver(url), 'imsuser', `node-postgres must authenticate as imsuser with ${JSON.stringify(password)}`)
    }
  } finally {
    cluster?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. The decoder against a URL this installer did not write
// ---------------------------------------------------------------------------

test('r39: the shipped decoder reaches node-postgres\'s answer for a legacy raw URL', () => {
  // WHY THIS IS NOT THE SAME TEST AS 2. Test 2 asks whether the pair is self-consistent over bytes
  // the encoder produced. This asks what happens to a `.env` an OLDER installer wrote by raw
  // interpolation, which is what every existing installation has: the recovered value has to be the
  // credential the APPLICATION has been authenticating with — the DECODED one — or the next re-run
  // compares a literal against URL bytes and reports a rotation nobody asked for.
  //
  // The comparison is against the installed pg-connection-string, evaluated here, on the same
  // inputs. There is no second decoder in this file.
  //
  // MUTATION ROUTES (each measured by making the change and re-running):
  //   1. stop decoding — return the raw userinfo, which is what r38 shipped. Rows `a%2Fb`, `a%2fb`,
  //      `AAA%25BBB`, `%20`, `%C3%BC`, `%41%42%43`, `100%25pure` and `a%2Fb%2Fc` all disagree with
  //      the driver and this test fails on the first of them. Test 1's re-run assertion fails too.
  //   2. decode with `printf '%b'` WITHOUT protecting literal backslashes first: `\back\slash`
  //      becomes a backspace and a `\s`, and this test fails on that row alone.
  //   3. drop the `{2}` from the hex pattern so a single hex digit decodes: `a%2` disagrees and
  //      this test fails on it; test 2 fails on `a%` and `a%2` as well.
  const root = installRoot('ims-repr-')
  try {
    const run = runShipped(
      { APP_DIR: root, APP_USER: currentUser(), CASES_B64: base64(`${LEGACY_RAW_USERINFO.join('\n')}\n`) },
      `
        printf '%s' "\${CASES_B64}" | base64 -d > "\${APP_DIR}/cases"
        while IFS= read -r raw; do
          # \`capture\`, because four of these rows decode to a value ENDING IN A NEWLINE and a
          # plain command substitution would delete it — agreeing with a broken recovery instead
          # of with the driver (r40).
          capture decoded url_decode_userinfo "\${raw}"
          printf 'ROW\\t%s\\n' "$(printf '%s' "\${decoded}" | base64 | tr -d '\\n')"
        done < "\${APP_DIR}/cases"
      `,
    )
    assert.equal(run.status, 0, run.output)
    const rows = run.output.split('\n').filter((line) => line.startsWith('ROW\t')).map((line) => line.slice(4))
    assert.equal(rows.length, LEGACY_RAW_USERINFO.length, `precondition: every case must be measured:\n${run.output}`)

    let differed = 0
    for (const [index, raw] of LEGACY_RAW_USERINFO.entries()) {
      const shipped = Buffer.from(rows[index], 'base64').toString('utf8')
      const driver = parse(`postgresql://imsuser:${raw}@127.0.0.1:5432/one_two_inventory`).password
      assert.equal(shipped, driver, `install.sh and node-postgres must agree on the userinfo ${JSON.stringify(raw)}`)
      if (shipped !== raw) differed += 1
    }
    // PRECONDITION: the comparison is not vacuous. If decoding were the identity function these
    // rows would all agree with a decoder that does nothing, and this test would pass on r38's
    // code. Twelve of the twenty-five differ from their input.
    assert.ok(differed >= 12, `precondition: the corpus must contain rows a non-decoding recovery gets wrong, found ${differed}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. The environment file is published, not truncated
// ---------------------------------------------------------------------------

test('r39: .env is published by rename, so the previous file is never truncated', async () => {
  // THE PROOF IS A HARD LINK, and it is deterministic. A second name for the SAME INODE cannot be
  // moved by a rename, so after the write it holds whatever the old inode holds. With `cat >` the
  // old inode is truncated and refilled in place, and the witness sees the NEW content — which is
  // exactly the state a crash mid-write leaves behind, only permanent. With publish_durable_file()
  // the old inode is never opened for writing at all.
  //
  // A racing reader would prove the same thing and would prove it flakily. This does not race.
  //
  // MUTATION ROUTES (each measured by making the change and re-running):
  //   1. revert write_app_env_file() to `cat > "${APP_DIR}/.env" <<EOF`: the witness holds the NEW
  //      content and the inode is unchanged; this test fails on both, ALONE in every installer
  //      file — the preservation tests read `.env` by name and cannot see which inode it is.
  //   2. move the chmod after the rename (`publish_durable_file` then `chmod 600`): the mode
  //      assertion still passes, because the end state is the same; that half is asserted here
  //      only as a statement about the end state, and the ATOMICITY of it is what route 1 covers.
  //   3. drop the `[[ -n "${rendered}" ]]` guard: nothing here fails. It is asserted below by
  //      rendering into a variable and checking the published bytes equal it exactly.
  const root = installRoot('ims-repr-')
  let cluster: Cluster | undefined
  try {
    cluster = startCluster(root, 'live', await freePort(), '127.0.0.1')
    seedLiveInstallation(cluster)
    const previous = writeInstalledEnv(root, cluster.port, 'live-password')

    // A SECOND NAME FOR THE FILE THAT IS THERE NOW.
    const witness = join(root, 'env.witness')
    linkSync(join(root, '.env'), witness)
    const before = statSync(join(root, '.env'))
    assert.equal(statSync(witness).ino, before.ino, 'precondition: the witness must be the same inode')

    const run = runShipped(installVars(cluster, root), `
      ${REINSTALL_BODY}
      echo "RENDERED_B64=$(render_app_env_file | base64 | tr -d '\\n')"
    `)
    assert.equal(run.status, 0, run.output)

    // THE OLD BYTES ARE STILL THERE, WHOLE, under the name that still points at the old inode.
    assert.equal(readFileSync(witness, 'utf8'), previous, 'the previous inode must be untouched: publication is a rename, not a truncation')
    // And .env is a DIFFERENT inode, with the new content.
    const after = statSync(join(root, '.env'))
    assert.notEqual(after.ino, before.ino, 'the published file must be a new inode')
    assert.equal(after.mode & 0o777, 0o600, 'and it must arrive at mode 0600')
    assert.equal(after.uid, statSync(root).uid, 'and owned by the account the installer gives it to')

    // THE PUBLISHED BYTES ARE THE RENDERED BYTES, exactly — which is what makes the render-then-
    // publish split honest. A pipeline would have published whatever it had received before a
    // failing producer died; this compares the whole file against the whole render.
    const rendered = Buffer.from(readVar(run.output, 'RENDERED_B64'), 'base64').toString('utf8')
    assert.equal(readFileSync(join(root, '.env'), 'utf8'), rendered, 'the published file must be exactly the rendered content')
  } finally {
    cluster?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 5. THE OTHER HIGH: every boundary between ALTER ROLE and durable publication
// ---------------------------------------------------------------------------

test('r39: a rotation that cannot be journalled does not ALTER anything', async () => {
  // THE ORDER IS THE POINT. The journal is not bookkeeping the rotation does on its way past; it is
  // the thing that makes the ALTER recoverable, so a run that cannot write it must not ALTER. If
  // the record went down AFTER — or not at all — this refusal would be the r39 defect wearing a
  // different message.
  //
  // MUTATION ROUTES (each measured by making the change and re-running):
  //   1. move the write_role_rotation_journal call to AFTER the ALTER: this test fails on its
  //      status assertion (the run gets past the journal and rotates) and on its live-credential
  //      assertion. It fails ALONE — the reconciliation tests below still pass, because on their
  //      paths the journal does get written.
  //   2. drop the `|| die` from it: same two failures, same test, alone.
  const root = installRoot('ims-repr-')
  let cluster: Cluster | undefined
  try {
    cluster = startCluster(root, 'live', await freePort(), '127.0.0.1')
    seedLiveInstallation(cluster)
    writeInstalledEnv(root, cluster.port, 'live-password')

    const run = runShipped({ ...installVars(cluster, root), DB_PASSWORD: 'rotated-secret' }, `
      ${REINSTALL_BODY}
      # The journal's directory cannot be created: a read-only parent is the ENOSPC/EROFS class of
      # failure the finding names, reached deterministically.
      DB_ENV_SNAPSHOT_DIR="\${APP_DIR}/unwritable/journal"
      DB_ROLE_ROTATION_JOURNAL="\${DB_ENV_SNAPSHOT_DIR}/db-role-rotation.journal"
      mkdir -p "\${APP_DIR}/unwritable"
      chmod 500 "\${APP_DIR}/unwritable"
      FENCE_ARMED=true
      DB_FENCE_UP=true
      rotate_database_password_in_fenced_window
      echo "ROTATED_ANYWAY"
    `)
    assert.equal(run.status, 9, `a rotation that cannot journal must refuse:\n${run.output}`)
    assert.doesNotMatch(run.output, /ROTATED_ANYWAY/, 'and must not continue past the refusal')
    assert.match(run.output, /could not be journalled durably/, 'for the reason the finding names')
    assert.match(run.output, /The ALTER has NOT been issued/, 'and it says what state the role is in')

    // AND THE REFUSAL IS TRUE.
    assert.equal(
      cluster.psql(['-c', 'SELECT 1'], { host: '127.0.0.1', user: 'imsuser', password: 'live-password', database: 'one_two_inventory' }),
      '1',
      'the role must still have the credential its clients hold',
    )
    assert.throws(
      () => cluster!.psql(['-c', 'SELECT 1'], { host: '127.0.0.1', user: 'imsuser', password: 'rotated-secret', database: 'one_two_inventory' }),
      /password authentication failed/,
      'and the requested password must not have reached the server',
    )
    assert.equal(envDatabaseUrl(root), `postgresql://imsuser:live-password@127.0.0.1:${cluster.port}/one_two_inventory`, 'and the environment file still agrees with it')
  } finally {
    chmodSync(join(root, 'unwritable'), 0o700)
    cluster?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test('r39: boundary (1) — journalled, ALTER not run: the next run finds the OLD password and clears the record', async () => {
  // THE FIRST OF THE THREE INTERRUPTION POINTS. Nothing has been taken away: the server has the old
  // password, `.env` names it, and the two agree. The next run must NOT assume a rotation happened
  // just because a record exists — it asks the server, gets the old password, and clears the record
  // it can now account for.
  //
  // CONSTRUCTED, AND SAID SO. There is no statement between the journal and the ALTER that can be
  // made to fail, so this point is reached by running the journal write alone. The other two use
  // the shipped sequence.
  //
  // MUTATION ROUTES (each measured by making the change and re-running):
  //   1. delete the old-password probe from reconcile_interrupted_role_rotation() (leave only the
  //      new one): the run refuses with "NEITHER of the two passwords", and this test fails on its
  //      status assertion, alone.
  //   2. delete the clear_role_rotation_journal() call from
  //      resolve_role_rotation_journal_after_env_publication(): JOURNAL_LEFT is `yes` and this test
  //      fails on it — as do the two boundary tests below, which is right: they are three
  //      statements about the same clear.
  const root = installRoot('ims-repr-')
  let cluster: Cluster | undefined
  try {
    cluster = startCluster(root, 'live', await freePort(), '127.0.0.1')
    seedLiveInstallation(cluster)
    writeInstalledEnv(root, cluster.port, 'live-password')

    const interrupted = runShipped({ ...installVars(cluster, root), DB_PASSWORD: 'rotated-secret' }, `
      ${REINSTALL_BODY}
      FENCE_ARMED=true
      DB_FENCE_UP=true
      write_role_rotation_journal "\${DB_PASSWORD_EFFECTIVE}" "\${DB_PASSWORD}" || exit 7
      # THE RUN DIES HERE, between the journal and the ALTER.
    `)
    assert.equal(interrupted.status, 0, interrupted.output)
    assert.equal(journalValue(root, 'marker_complete'), '1', 'precondition: a complete journal was published')
    assert.equal(journalValue(root, 'identity'), `imsuser@127.0.0.1:${cluster.port}/one_two_inventory`)
    assert.equal(statSync(journalPath(root)).mode & 0o777, 0o600, 'and it is mode 0600')
    assert.equal(Buffer.from(journalValue(root, 'old_password_b64')!, 'base64').toString('utf8'), 'live-password')
    assert.equal(Buffer.from(journalValue(root, 'new_password_b64')!, 'base64').toString('utf8'), 'rotated-secret')

    const next = runShipped(installVars(cluster, root), NEXT_RUN_BODY)
    assert.equal(next.status, 0, next.output)
    assert.match(next.output, /RECONCILED=true/, 'the next run must notice the interrupted rotation')
    assert.match(next.output, /still has the OLD password/, 'and say which way it reconciled')
    assert.equal(decodeVar(next.output, 'INSTALLED_B64'), 'live-password', 'the credential the server actually has')
    assert.equal(decodeVar(next.output, 'EFFECTIVE_B64'), 'live-password', 'and the one everything before the stop uses')
    assert.match(next.output, /PENDING=false/, 'pressing Enter asks for no rotation')
    assert.match(next.output, /JOURNAL_LEFT=no/, 'and the record is cleared, because it is accounted for')

    const written = envDatabaseUrl(root)
    assert.equal(written, `postgresql://imsuser:live-password@127.0.0.1:${cluster.port}/one_two_inventory`)
    assert.equal(await connectWithDriver(written), 'imsuser', 'and the file the service restarts from opens a connection')
  } finally {
    cluster?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test('r39: boundary (2) — the ALTER commits and .env cannot be written: the next run finishes the transition', async () => {
  // THE OUTAGE, AND THE WRITE FAILURE, IN ONE RUN. The environment file is made unwritable AFTER
  // the build window and BEFORE the rotation, so the shipped rotate_database_password_in_fenced_
  // window() reaches its own publication and fails there — the exact boundary Codex names. The
  // service is stopped, the fence is up, the server has a password nothing on disk knows.
  //
  // TWO THINGS ARE ASSERTED ABOUT THE FAILED WRITE ITSELF, and they are the two `cat >` could not
  // give: the previous environment file is COMPLETE (not truncated to nothing on its way to being
  // refilled), and the run REFUSED rather than carrying on with flags that say the file agrees.
  //
  // MUTATION ROUTES (each measured by making the change and re-running):
  //   1. revert write_app_env_file() to `cat > "${APP_DIR}/.env" <<EOF`. The write still fails —
  //      the file is mode 0400 — but nothing checks it, so the rotation reports SUCCESS with the
  //      server on the new password and `.env` on the old one. This test fails on its status
  //      assertion and on "ROTATED_ANYWAY", alone in this file. (Test 4 is what catches the
  //      truncation itself, by hard link.)
  //   2. delete the write_role_rotation_journal call: the first half still passes and the SECOND
  //      RUN strands — it recovers `live-password` out of the stale `.env`, which the server no
  //      longer has, and publishes a file naming it. This test fails on RECONCILED, on
  //      INSTALLED_B64 and on connectWithDriver. That is the finding, and it fails here alone.
  //   3. make reconcile_interrupted_role_rotation() prefer the OLD password (swap the two probes):
  //      the same three assertions fail, and boundary (3) fails with them.
  const root = installRoot('ims-repr-')
  let cluster: Cluster | undefined
  try {
    cluster = startCluster(root, 'live', await freePort(), '127.0.0.1')
    seedLiveInstallation(cluster)
    writeInstalledEnv(root, cluster.port, 'live-password')

    const interrupted = runShipped({ ...installVars(cluster, root), DB_PASSWORD: 'rotated-secret' }, `
      ${REINSTALL_BODY}
      cp "\${APP_DIR}/.env" "\${APP_DIR}/env.before"
      # The journal's directory has to exist before the application directory is sealed: in
      # production it is /etc/ims-cutover and is not under \${APP_DIR} at all.
      mkdir -p "\${DB_ENV_SNAPSHOT_DIR}"
      # THE WRITE FAILURE, deterministic: neither the file nor its directory can be written, so
      # \`cat >\` fails on the file and publish_durable_file() cannot rename onto it — o3d-czpy
      # moved the temporary into a 0700 staging directory whose x-bit survives a 0500 parent, so
      # what refuses now is the rename into \${APP_DIR}, not the mktemp. Either way the file the
      # server has parted company with is left whole, which is what the assertions below measure.
      chmod 400 "\${APP_DIR}/.env"
      chmod 500 "\${APP_DIR}"
      FENCE_ARMED=true
      DB_FENCE_UP=true
      rotate_database_password_in_fenced_window
      echo "ROTATED_ANYWAY"
    `)
    assert.equal(interrupted.status, 9, `the rotation must refuse when it cannot publish:\n${interrupted.output}`)
    assert.doesNotMatch(interrupted.output, /ROTATED_ANYWAY/, 'and must not report success')
    assert.match(interrupted.output, /HAS BEEN ROTATED on the server/, 'the refusal must say the ALTER committed')
    assert.match(interrupted.output, /reconcile from the journal/, 'and tell the operator what fixes it')

    chmodSync(root, 0o700)
    chmodSync(join(root, '.env'), 0o600)

    // THE SERVER MOVED AND THE FILE DID NOT — and the file is WHOLE.
    assert.equal(
      cluster.psql(['-c', 'SELECT 1'], { host: '127.0.0.1', user: 'imsuser', password: 'rotated-secret', database: 'one_two_inventory' }),
      '1',
      'precondition: the ALTER committed',
    )
    assert.equal(
      readFileSync(join(root, '.env'), 'utf8'),
      readFileSync(join(root, 'env.before'), 'utf8'),
      'the previous environment file must be complete and unchanged: a failed publication is a rename that did not happen',
    )
    assert.equal(envDatabaseUrl(root), `postgresql://imsuser:live-password@127.0.0.1:${cluster.port}/one_two_inventory`, 'precondition: it names the password the server no longer has')
    assert.equal(journalValue(root, 'marker_complete'), '1', 'and the journal is standing')

    // THE NEXT RUN FINISHES THE TRANSITION.
    const next = runShipped(installVars(cluster, root), NEXT_RUN_BODY)
    assert.equal(next.status, 0, next.output)
    assert.match(next.output, /RECONCILED=true/, 'the next run must notice the interrupted rotation')
    assert.match(next.output, /server has the NEW password/, 'and say which way it reconciled')
    assert.equal(decodeVar(next.output, 'INSTALLED_B64'), 'rotated-secret', 'the installed credential is what the SERVER has, not what .env said')
    assert.equal(decodeVar(next.output, 'EFFECTIVE_B64'), 'rotated-secret')
    assert.match(next.output, /PENDING=false/, 'finishing a transition is not a second rotation')
    assert.match(next.output, /JOURNAL_LEFT=no/, 'and the record is cleared only after the publication succeeded')

    const written = envDatabaseUrl(root)
    assert.equal(written, `postgresql://imsuser:rotated-secret@127.0.0.1:${cluster.port}/one_two_inventory`)
    assert.equal(await connectWithDriver(written), 'imsuser', 'and the file the service restarts from opens a connection')
  } finally {
    try { chmodSync(root, 0o700) } catch { /* already restored */ }
    cluster?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test('r39: boundary (3) — both done, the record not cleared: the next run confirms and clears it', async () => {
  // THE CHEAP ONE, AND IT HAS TO BE CHEAP. The journal is removed LAST precisely so that this is
  // the outcome a crash produces most often, and it must cost one probe and nothing else: the
  // server has the new password, `.env` already names it, the rewrite is byte-identical.
  //
  // The setup is the SHIPPED rotation truncated one statement before clear_role_rotation_journal(),
  // so what is interrupted is the real sequence and not a model of it.
  //
  // MUTATION ROUTES (each measured by making the change and re-running):
  //   1. move clear_role_rotation_journal() to BEFORE write_app_env_file() in the shipped function.
  //      Nothing here fails — this test constructs the truncation itself — but boundary (2) fails
  //      on its journal assertion, which is where that ordering is load-bearing. Recorded so the
  //      next reader does not look for it here.
  //   2. delete the clear from resolve_role_rotation_journal_after_env_publication(): JOURNAL_LEFT
  //      is `yes` and this test fails on it, with boundary (1) and (2).
  //   3. make the reconciliation trust `.env` over the server (drop the DB_ROTATION_JOURNAL_FOUND
  //      branch in prompt_db_password): the recovered value here happens to be the same either way,
  //      so this test stays GREEN and boundary (2) fails. Recorded because it is the one route this
  //      test cannot see.
  const root = installRoot('ims-repr-')
  let cluster: Cluster | undefined
  try {
    cluster = startCluster(root, 'live', await freePort(), '127.0.0.1')
    seedLiveInstallation(cluster)
    writeInstalledEnv(root, cluster.port, 'live-password')

    const interrupted = runShipped({ ...installVars(cluster, root), DB_PASSWORD: 'rotated-secret' }, `
      ${REINSTALL_BODY}
      FENCE_ARMED=true
      DB_FENCE_UP=true
      ${SHIPPED_ROTATION_UP_TO_THE_CLEAR}
      # THE RUN DIES HERE, one statement before clear_role_rotation_journal().
      echo "AT_THE_CLEAR"
    `)
    assert.equal(interrupted.status, 0, interrupted.output)
    assert.match(interrupted.output, /AT_THE_CLEAR/, 'precondition: the whole rotation ran except the clear')
    assert.equal(journalValue(root, 'marker_complete'), '1', 'precondition: the record is still standing')
    const settled = readFileSync(join(root, '.env'), 'utf8')
    assert.match(settled, new RegExp(`^DATABASE_URL=postgresql://imsuser:rotated-secret@127\\.0\\.0\\.1:${cluster.port}/one_two_inventory$`, 'm'), 'precondition: .env already names the new credential')

    const next = runShipped(installVars(cluster, root), NEXT_RUN_BODY)
    assert.equal(next.status, 0, next.output)
    assert.match(next.output, /RECONCILED=true/)
    assert.match(next.output, /server has the NEW password/, 'the probe cannot tell (2) from (3), and does not need to')
    assert.equal(decodeVar(next.output, 'INSTALLED_B64'), 'rotated-secret')
    assert.match(next.output, /PENDING=false/)
    assert.match(next.output, /JOURNAL_LEFT=no/, 'and the record is cleared')
    assert.equal(readFileSync(join(root, '.env'), 'utf8'), settled, 'the rewrite is byte-identical: nothing moved')
    assert.equal(await connectWithDriver(envDatabaseUrl(root)), 'imsuser')
  } finally {
    cluster?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test('r39: boundary (4) — neither password authenticates: the run refuses and keeps the record', async () => {
  // THE ONE OUTCOME THAT CANNOT BE RECONCILED, and the one where guessing loses a credential.
  // Somebody has rotated the role out of band. This script cannot tell that from an unreachable
  // server, so it stops before it has prompted for anything else, before anything is stopped, and
  // it LEAVES THE JOURNAL — which is the only remaining record of the two candidate passwords.
  //
  // MUTATION ROUTES (each measured by making the change and re-running):
  //   1. make the final `die` a `warn` and return 0: the run continues with DB_PASSWORD_INSTALLED
  //      empty, mints a fresh password nothing has, and publishes a `.env` naming it. This test
  //      fails on its status assertion and on JOURNAL_LEFT, alone.
  //   2. delete the journal from the failure path (add clear_role_rotation_journal before the die):
  //      this test fails on its journal assertion, alone — the two candidate passwords would be
  //      gone and no re-run could ever reconcile.
  const root = installRoot('ims-repr-')
  let cluster: Cluster | undefined
  try {
    cluster = startCluster(root, 'live', await freePort(), '127.0.0.1')
    seedLiveInstallation(cluster)
    writeInstalledEnv(root, cluster.port, 'live-password')

    const interrupted = runShipped({ ...installVars(cluster, root), DB_PASSWORD: 'rotated-secret' }, `
      ${REINSTALL_BODY}
      FENCE_ARMED=true
      DB_FENCE_UP=true
      write_role_rotation_journal "\${DB_PASSWORD_EFFECTIVE}" "\${DB_PASSWORD}" || exit 7
    `)
    assert.equal(interrupted.status, 0, interrupted.output)

    // Somebody else moves the role to a third password.
    cluster.psql(['-c', "ALTER USER imsuser WITH PASSWORD 'somebody-elses-idea'"])

    const next = runShipped(installVars(cluster, root), NEXT_RUN_BODY)
    assert.equal(next.status, 9, `neither candidate authenticates, so the run must refuse:\n${next.output}`)
    assert.match(next.output, /could not find a single endpoint that both checks POSTGRESQL'S OWN role credential for 'imsuser' and can tell one password from another/, 'for the reason the operator needs')
    assert.match(next.output, /NEITHER of the two passwords it recorded was accepted/, 'and it names the out-of-band rotation this looks like')
    // r40: the refusal now shows its WORKING — what each endpoint it asked actually did. Without
    // that, "no endpoint could discriminate" is indistinguishable from "the server is down", and
    // the operator has nothing to act on.
    assert.match(next.output, /'postgres' refused BOTH recorded candidates/, 'and it reports what the maintenance database said')
    assert.match(next.output, /'one_two_inventory' refused BOTH recorded candidates/, 'and what the application database said')
    assert.match(next.output, /LEFT IN PLACE/, 'and it says the record is kept')
    assert.doesNotMatch(next.output, /INSTALLED_B64/, 'and nothing past the refusal ran')
    assert.equal(journalValue(root, 'marker_complete'), '1', 'the two candidate passwords must survive the refusal')
    assert.equal(Buffer.from(journalValue(root, 'old_password_b64')!, 'base64').toString('utf8'), 'live-password')
    assert.equal(Buffer.from(journalValue(root, 'new_password_b64')!, 'base64').toString('utf8'), 'rotated-secret')
  } finally {
    cluster?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test('r39: an interrupted rotation for a DIFFERENT connection is refused, not adopted and not cleared', async () => {
  // A PASSWORD IS A PROPERTY OF ONE ROLE ON ONE SERVER — the rule installed_database_password()
  // already applies to recovery, applied to reconciliation. A run installing a different database
  // cannot finish this transition and must not delete its record on the way past: doing either
  // leaves the connection the journal is about with a credential nothing on the host names.
  //
  // MUTATION ROUTES (each measured by making the change and re-running):
  //   1. delete the identity comparison from reconcile_interrupted_role_rotation(): the run probes
  //      a role on a database it is not installing, both probes fail, and it dies with "NEITHER of
  //      the two passwords" — this test fails on its message assertion, alone.
  //   2. replace the die with a `clear_role_rotation_journal`: the journal assertion fails, alone.
  const root = installRoot('ims-repr-')
  let cluster: Cluster | undefined
  try {
    cluster = startCluster(root, 'live', await freePort(), '127.0.0.1')
    seedLiveInstallation(cluster)
    writeInstalledEnv(root, cluster.port, 'live-password')

    const interrupted = runShipped({ ...installVars(cluster, root), DB_PASSWORD: 'rotated-secret' }, `
      ${REINSTALL_BODY}
      FENCE_ARMED=true
      DB_FENCE_UP=true
      write_role_rotation_journal "\${DB_PASSWORD_EFFECTIVE}" "\${DB_PASSWORD}" || exit 7
    `)
    assert.equal(interrupted.status, 0, interrupted.output)

    const elsewhere = runShipped({ ...installVars(cluster, root), DB_NAME: 'a_different_database' }, NEXT_RUN_BODY)
    assert.equal(elsewhere.status, 9, `a journal for another connection must stop the run:\n${elsewhere.output}`)
    assert.match(elsewhere.output, /was interrupted for imsuser@127\.0\.0\.1:\d+\/one_two_inventory and this run is installing imsuser@127\.0\.0\.1:\d+\/a_different_database/, 'and it must name both connections')
    assert.doesNotMatch(elsewhere.output, /INSTALLED_B64/, 'nothing past the refusal ran')
    assert.equal(journalValue(root, 'marker_complete'), '1', 'and the other connection\'s record is untouched')
  } finally {
    cluster?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 6. r40 (Codex HIGH): THE BYTES THE SHELL CAPTURE DELETED
// ---------------------------------------------------------------------------

/**
 * A password ending in a newline is not exotic — it is what an operator gets from a copy-paste,
 * from `echo secret > pw.txt`, or from any generator that terminates its line. r39 encoded it
 * correctly (`%0A`), the driver decoded it correctly, the server held it correctly, and the shell
 * capture in the RECOVERY threw the last byte away.
 */
const TERMINAL_NEWLINE_PASSWORD = "p@ss:w/rd?#%2F'ends-with\n"


test('r40: a password whose decoded form ends in a newline installs, authenticates, and is recovered whole', async () => {
  // THE LOAD-BEARING ONE FOR THE FIRST HIGH, and every link in it is real: the shipped
  // sql_quote_literal() puts the bytes on a real server, the shipped compose_database_url() writes
  // them into a real `.env`, `pg-connection-string` and `pg.Client` out of node_modules read them
  // back, and the shipped recovery — running in the shipped prompt_db_password() — has to return
  // the SAME bytes or the next re-install rotates a live credential nobody asked to rotate.
  //
  // WHY THE ASSERTION IS ON A BYTE COUNT AND NOT ONLY ON EQUALITY. The whole failure is the loss of
  // ONE trailing byte, and a test that compares two values which have both been truncated by the
  // same capture agrees with the defect. So the value is carried out of the shell as base64 and
  // compared as a Buffer, and the last byte is asserted to be 0x0a explicitly.
  //
  // MUTATION ROUTES (each measured by making the change and re-running):
  //   1. revert the password decode in installed_database_password() to
  //      `password="$(url_decode_userinfo "${password}")"`. The recovered value loses its newline,
  //      so it differs from the installed one and the re-run reports ROTATION_PENDING=true over a
  //      live role — this test fails on RECOVERED_B64 and on ROTATION_PENDING, ALONE across both
  //      installer credential files. Nothing else in the repo notices a missing trailing byte.
  //   2. revert the OUTER capture to
  //      `DB_PASSWORD_INSTALLED="$(installed_database_password ... || true)"`. Identical symptoms,
  //      also alone — which is the point of measuring it separately: fixing only one of the two
  //      leaves the defect exactly where it was, and one test failing for two different reasons is
  //      the only thing that says so.
  //   3. drop the sentinel from url_decode_userinfo()'s internal sed pipeline: nothing here fails,
  //      because no value reaching it through a URL carries a LITERAL trailing newline. Recorded so
  //      the next reader does not go looking for it; that half is asserted directly in test 13.
  const root = installRoot('ims-repr-')
  let cluster: Cluster | undefined
  try {
    cluster = startCluster(root, 'live', await freePort(), '127.0.0.1')
    seedLiveInstallation(cluster)
    writeInstalledEnv(root, cluster.port, 'live-password')

    const target = TERMINAL_NEWLINE_PASSWORD
    const run = runShipped(
      { ...installVars(cluster, root), DB_PASSWORD_B64: base64(target) },
      `
        ${DECODE_HELPER}
        capture DB_PASSWORD decode_b64 "\${DB_PASSWORD_B64}"
        ${REINSTALL_BODY}
        FENCE_ARMED=true
        DB_FENCE_UP=true
        rotate_database_password_in_fenced_window
        echo "FINAL_ROTATED=\${DB_ROLE_CREDENTIALS_ROTATED}"
      `,
    )
    assert.equal(run.status, 0, run.output)
    assert.match(run.output, /FINAL_ROTATED=true/, 'the rotation must have happened')

    // (a) THE SERVER HOLDS THE NEWLINE. libpq does no URL parsing, so this is about the bytes
    //     ALTER USER committed and nothing else.
    assert.equal(
      cluster.psql(['-c', 'SELECT 1'], { host: '127.0.0.1', user: 'imsuser', password: target, database: 'one_two_inventory' }),
      '1',
      'the server must hold the literal password, terminating newline and all',
    )
    // And it is the newline that is load-bearing: the same password WITHOUT it must be refused.
    assert.throws(
      () => cluster!.psql(['-c', 'SELECT 1'], { host: '127.0.0.1', user: 'imsuser', password: target.slice(0, -1), database: 'one_two_inventory' }),
      /password authentication failed/,
      'precondition: the truncated form must NOT authenticate, or this test proves nothing',
    )

    // (b) THE URL SPELLS IT `%0A` AND THE INSTALLED PARSER READS IT BACK.
    const written = envDatabaseUrl(root)
    assert.match(written, /%0A@/, `the composed URL must percent-encode the terminating newline: ${written}`)
    assert.equal(parse(written).password, target, 'the driver must read the newline back out of the URL install.sh wrote')

    // (c) AND IT OPENS A CONNECTION.
    assert.equal(await connectWithDriver(written), 'imsuser', 'node-postgres must authenticate with it')

    // (d) THE RE-RUN RECOVERS IT WHOLE AND ASKS FOR NOTHING. This is the half r39 lost.
    const rerun = runShipped(installVars(cluster, root), `
      ${REINSTALL_BODY}
      echo "RECOVERED_B64=$(printf '%s' "\${DB_PASSWORD_INSTALLED}" | base64 | tr -d '\\n')"
    `)
    assert.equal(rerun.status, 0, rerun.output)
    const recovered = Buffer.from(readVar(rerun.output, 'RECOVERED_B64'), 'base64')
    assert.equal(recovered.length, Buffer.byteLength(target, 'utf8'), `the recovery must return every byte: got ${JSON.stringify(recovered.toString('utf8'))}`)
    assert.equal(recovered[recovered.length - 1], 0x0a, 'and the last of them is the newline')
    assert.equal(recovered.toString('utf8'), target)
    assert.match(rerun.output, /ROTATION_PENDING=false/, 'so pressing Enter does not rotate a live credential')
  } finally {
    cluster?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test('r40: an interrupted rotation to a newline-terminated password reconciles to the exact bytes', async () => {
  // THE SAME BYTE, ON THE OTHER PATH. The journal carries both candidates as base64 — which is
  // precisely what makes a newline survive the FILE — and r39 then decoded them through `$( )`,
  // which threw it away again. On this path the loss is not a spurious rotation but an OUTAGE: the
  // reconciliation publishes a `.env` naming a password the server does not have, inside the
  // stopped, fenced window, and the next restart is locked out.
  //
  // MUTATION ROUTES (each measured by making the change and re-running):
  //   1. revert the two journal decodes to
  //      `old_password="$(rotation_journal_decode "$(...)")"`. The reconciliation adopts the
  //      truncated form, `.env` names it, and connectWithDriver is refused — this test fails on
  //      RECONCILED_B64 and at the driver connection. It fails ALONE: every other reconciliation
  //      test uses a password with no trailing newline, so their decode is unaffected.
  //   2. revert the outer capture in prompt_db_password(): DB_ROTATION_RECONCILED_PASSWORD is
  //      assigned to DB_PASSWORD_INSTALLED directly and does not cross a capture, so this test
  //      stays GREEN and test 6 fails. Recorded because it is the one route this test cannot see.
  const root = installRoot('ims-repr-')
  let cluster: Cluster | undefined
  try {
    cluster = startCluster(root, 'live', await freePort(), '127.0.0.1')
    seedLiveInstallation(cluster)
    writeInstalledEnv(root, cluster.port, 'live-password')

    const target = TERMINAL_NEWLINE_PASSWORD
    // The rotation runs and is killed one statement before the journal is cleared: the server has
    // the newline-terminated password and the record names both candidates.
    const interrupted = runShipped(
      { ...installVars(cluster, root), DB_PASSWORD_B64: base64(target) },
      `
        ${DECODE_HELPER}
        capture DB_PASSWORD decode_b64 "\${DB_PASSWORD_B64}"
        ${REINSTALL_BODY}
        FENCE_ARMED=true
        DB_FENCE_UP=true
        DB_PROBE_REPORT=""
        db_endpoint_is_password_sensitive postgres "\${DB_PASSWORD_EFFECTIVE}" || exit 6
        DB_ROTATION_PROBE_DATABASE=postgres
        ${SHIPPED_ROTATION_UP_TO_THE_CLEAR}
        echo "AT_THE_CLEAR"
      `,
    )
    assert.equal(interrupted.status, 0, interrupted.output)
    assert.match(interrupted.output, /AT_THE_CLEAR/, 'precondition: the rotation ran except the clear')
    assert.equal(
      Buffer.from(journalValue(root, 'new_password_b64')!, 'base64').toString('utf8'),
      target,
      'precondition: base64 carried the newline into the journal — the loss is in the DECODE, not the encode',
    )

    const next = runShipped(installVars(cluster, root), `
      ${NEXT_RUN_BODY}
      echo "RECONCILED_B64=$(printf '%s' "\${DB_ROTATION_RECONCILED_PASSWORD}" | base64 | tr -d '\\n')"
    `)
    assert.equal(next.status, 0, next.output)
    assert.match(next.output, /server has the NEW password/, 'the reconciliation must find the rotated credential')
    const reconciled = Buffer.from(readVar(next.output, 'RECONCILED_B64'), 'base64')
    assert.equal(reconciled[reconciled.length - 1], 0x0a, 'and it must carry the terminating newline out of the journal')
    assert.equal(reconciled.toString('utf8'), target)
    assert.equal(decodeVar(next.output, 'INSTALLED_B64'), target, 'which is the credential the published file is composed from')
    assert.match(next.output, /JOURNAL_LEFT=no/, 'and the record is cleared')

    const written = envDatabaseUrl(root)
    assert.match(written, /%0A@/, `the republished URL must still spell the newline: ${written}`)
    assert.equal(await connectWithDriver(written), 'imsuser', 'and the file the service restarts from opens a connection')
  } finally {
    cluster?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test('r40: capture() returns every byte its command wrote, including trailing newlines', async () => {
  // THE PRIMITIVE, ON ITS OWN, because everything above depends on it and a bug in it would be
  // invisible in exactly the tests that use it. Three properties, and each is a way the mechanism
  // could be built wrongly:
  //
  //   - trailing newlines survive, however many;
  //   - a value that ENDS WITH THE SENTINEL'S OWN TEXT loses only the one the capture appended,
  //     which is what makes `${var%"..."}` (shortest suffix) the right expansion and `${var%%...}`
  //     the wrong one;
  //   - a command that FAILS still yields its exit status, so the `|| DB_PASSWORD_INSTALLED=""`
  //     at the call site is a decision and not an accident, and its output still reaches the
  //     caller.
  //
  // MUTATION ROUTES (each measured by making the change and re-running):
  //   1. change `${__capture_raw%"${CAPTURE_TERMINATOR}"}` to `%%`: the sentinel-suffixed row
  //      loses BOTH copies and this test fails on it, alone in the repo.
  //   2. add `set +e` back to the subshell as a guard against errexit killing it before the
  //      terminator is written: NOTHING changes, in this test or anywhere else. It was measured
  //      under `set -euo pipefail` with `shopt -s inherit_errexit` both set and unset, and the
  //      value and the status are identical either way — because capture()'s own
  //      `|| __capture_status=$?` puts the substitution in a tested context, where errexit does
  //      not apply. The line was removed rather than shipped as decoration.
  //   3. remove the `exit "${__capture_inner}"`: the status row reports 0 and this test fails on
  //      it. That one is load-bearing at the call site in prompt_db_password(), where a failed
  //      recovery has to fall through to `DB_PASSWORD_INSTALLED=""`.
  const root = installRoot('ims-repr-')
  try {
    const run = runShipped({ APP_DIR: root, APP_USER: currentUser() }, `
      ${DECODE_HELPER}
      emit() { printf '%s' "$1"; }
      fails() { printf 'partial-output'; return 3; }
      for spec in "one-newline:$(printf 'a\\n' | base64 | tr -d '\\n')" \\
                  "three-newlines:$(printf 'a\\n\\n\\n' | base64 | tr -d '\\n')" \\
                  "only-newline:$(printf '\\n' | base64 | tr -d '\\n')" \\
                  "sentinel-suffixed:$(printf 'a%s' "\${CAPTURE_TERMINATOR}" | base64 | tr -d '\\n')"; do
        name="\${spec%%:*}"
        capture want decode_b64 "\${spec#*:}"
        capture got emit "\${want}"
        printf 'ROW\\t%s\\t%s\\t%s\\n' "\${name}" \\
          "$(printf '%s' "\${want}" | base64 | tr -d '\\n')" \\
          "$(printf '%s' "\${got}" | base64 | tr -d '\\n')"
      done
      status=0
      capture failed fails || status=$?
      echo "FAILED_STATUS=\${status}"
      echo "FAILED_VALUE_B64=$(printf '%s' "\${failed}" | base64 | tr -d '\\n')"
    `)
    assert.equal(run.status, 0, run.output)

    const rows = run.output.split('\n').filter((line) => line.startsWith('ROW\t')).map((line) => line.split('\t').slice(1))
    assert.equal(rows.length, 4, `precondition: every case must be measured:\n${run.output}`)
    const expected: Record<string, string> = {
      'one-newline': 'a\n',
      'three-newlines': 'a\n\n\n',
      'only-newline': '\n',
    }
    for (const [name, wantB64, gotB64] of rows) {
      const want = Buffer.from(wantB64, 'base64').toString('utf8')
      const got = Buffer.from(gotB64, 'base64').toString('utf8')
      if (name in expected) {
        assert.equal(want, expected[name], `precondition: the ${name} case must reach the shell intact`)
      } else {
        // The sentinel-suffixed row: the value the rig built ends with the terminator's own text,
        // and it must come back with exactly that text still on it.
        assert.match(want, /^a--ims-end-of-captured-value--$/, 'precondition: the sentinel-suffixed case must reach the shell intact')
      }
      assert.equal(got, want, `capture must return ${name} byte for byte`)
    }

    // AND THE ONE CAPTURE `capture` CANNOT REACH: the sed pipeline INSIDE url_decode_userinfo().
    // It is a substitution one layer below the call site, so a userinfo carrying a LITERAL trailing
    // newline would be truncated there however the caller captures it. No URL read out of a `.env`
    // line can be in that state, which is why nothing else in this file fails when the sentinel is
    // removed from it — so it is stated here, directly, as a property of the decoder.
    //
    // MUTATION ROUTE: remove the terminator from that pipeline (`printf '%s' "${escaped}" | sed`).
    // LITERAL_LF_LEN drops from 4 to 3 and this assertion fails, alone in the repo.
    const literal = runShipped({ APP_DIR: root, APP_USER: currentUser() }, `
      ${DECODE_HELPER}
      capture raw decode_b64 "$(printf 'abc\n' | base64 | tr -d '\n')"
      capture decoded url_decode_userinfo "\${raw}"
      echo "LITERAL_LF_LEN=\${#decoded}"
      echo "LITERAL_LF_B64=$(printf '%s' "\${decoded}" | base64 | tr -d '\n')"
    `)
    assert.equal(literal.status, 0, literal.output)
    assert.equal(readVar(literal.output, 'LITERAL_LF_LEN'), '4', 'url_decode_userinfo must not eat a literal trailing newline in its own pipeline')
    assert.equal(Buffer.from(readVar(literal.output, 'LITERAL_LF_B64'), 'base64').toString('utf8'), 'abc\n')

    assert.equal(readVar(run.output, 'FAILED_STATUS'), '3', 'capture must return its command\'s own exit status')
    assert.equal(
      Buffer.from(readVar(run.output, 'FAILED_VALUE_B64'), 'base64').toString('utf8'),
      'partial-output',
      'and a failing command\'s output must still reach the caller, terminator removed',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
