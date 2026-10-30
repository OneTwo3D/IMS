# Installation & Deployment

## Prerequisites

- **Operating system**: Debian 11/12/13 or Ubuntu 22.04/24.04 (tested in LXC containers; Debian 13 was rehearsed end to end in a container). The installer accepts any Debian or Ubuntu release and only warns on another distribution.
- **Memory for the build**: `next build` needs a Node heap well above Node's default (about 2 GB). A rehearsal on an 8 GB host aborted the TypeScript pass at 2 GB and at 3 GB and completed at 5 GB. `install.sh`, `update.sh` and `deploy.sh` therefore start the build step (and only that step) with `NODE_OPTIONS=--max-old-space-size=6144`. This is a ceiling, not a reservation: plan for roughly 5 GB of free memory (RAM plus swap) while the build runs, and add swap on a smaller host, because a host that cannot supply it fails the build -- before anything is stopped or migrated. Override the ceiling with `IMS_BUILD_MAX_OLD_SPACE_MB` (whole megabytes, 1000-999999; pass it through sudo with `sudo env IMS_BUILD_MAX_OLD_SPACE_MB=8192 bash ...`); without it, a `--max-old-space-size` you already put in `NODE_OPTIONS` is left alone. A malformed value is refused up front, before anything is changed.
- **Node.js**: Version 22 (installed automatically by the install script)
- **PostgreSQL**: Version 14 or later (installed automatically, or provide an external connection)
- **nginx**: Used as the reverse proxy (installed automatically)
- **Internet access**: Required during installation for downloading packages


## The Install Script

<a id="supported-bootstrap"></a>
### The supported bootstrap

Run the installer as root, **from a release that root fetched into a directory root has just created**:

```bash
# 0. As root: a umask that does not hand the group or other a write bit. The startup check refuses a
#    tree that is group- or other-writable, and under a permissive root umask (002, 000) the clone
#    below comes out exactly that way — a refusal whose only remedy would be the relabel this section
#    rejects. 022 is the default on Debian and Ubuntu; set it explicitly rather than assume it.
umask 022

# 1. As root: a NEW directory no other account has ever had open, under a root-owned parent that
#    no other account can write (/root is root:root 0700 on Debian and Ubuntu).
RELEASE_DIR="$(mktemp -d /root/ims-release.XXXXXX)"

# 2. As root: fetch the release INTO it, so that every file is created by root, now.
git clone --branch <release-tag> --depth 1 <repository-url> "${RELEASE_DIR}/one-two-inventory"
#    ...or, from a release tarball root has downloaded into ${RELEASE_DIR}. Check what the archive's
#    top-level directory is called (tar -tzf | head -1) and use THAT name in step 3 — it is the
#    release's, not necessarily `one-two-inventory`:
#    tar -xzf "${RELEASE_DIR}/<release>.tar.gz" -C "${RELEASE_DIR}" --no-same-owner --no-same-permissions

# 3. Run the installer from there. NOT from /opt/one-two-inventory: that is the directory it
#    creates and hands to imsapp, and it refuses to be run from inside it.
bash "${RELEASE_DIR}/one-two-inventory/scripts/install.sh"
```

**Relabelling a tree does not make it trusted, and is not a supported bootstrap** (o3d-z5be r6).
`chown -R root:root <tree> && chmod -R go-w <tree>` over a checkout another account has had write
access to *looks* like the result above, and it is not. Permission to write a file is checked when the
file is **opened**; `chown` and `chmod` change the inode's owner and mode *now*, and revoke nothing that
was opened before. An account that could write that tree can keep a descriptor open for writing (or a
writable `mmap`, or hand the descriptor to another process), wait for the relabel and for the installer's
startup checks to pass, and then write the entrypoint or library bytes bash has not read yet — which root
then executes. **Nothing a script can inspect rules that out**: an open descriptor leaves no trace on the
file, one in transit over a Unix socket is in no process's descriptor table at all, and the ownership and
modes the startup check reads are exactly what the relabel set. So the installer **cannot detect a
relabelled tree** and does not claim to; the only answer is inodes no other account has ever had open,
which is what creating the directory and fetching into it as root produces. (A copy made by root writes
fresh inodes too, but its bytes are whatever the source held while it was being read, so it is only as
good as a source nobody else can write — which is the same question again.)

**A tree another account can write is refused** (o3d-z5be r5). As root, each of the three entrypoints
checks, before it reads any library, that the file itself, its directory, `lib/` and everything in `lib/`
are owned by root and writable by nobody else, and that every directory above it is owned by root and not
writable by group or other unless sticky; otherwise it stops and names the offending path. See *Which
invocations are supported* below for why this is not optional, and why the check is only best-effort.

**And no privileged run hands the tree it is running from to another account** (o3d-z5be r6–r11).

*The threat model, stated once.* What follows guards against a **mistake by someone editing these
scripts** — a new `chown -R`, a helper aimed at the wrong directory, a constant changed to point
somewhere else. It does not guard against an editor set on defeating it: they can change the test too.
Two mechanisms carry the guarantee at **run time**, and a static test keeps them in place:

- **The per-operation check in the entrypoints.** Immediately before a tree-wide ownership change,
  copy, move or delete, the entrypoint asks whether the target and the directory the running script
  lives in are **disjoint** — neither equals, contains nor lies inside the other. Disjoint is decided by
  **device and inode** along the same walk a recursive operation makes, and the set asked about is the
  running directory *and every file under it*, so a symbolic link, a bind mount, or a **hard link** to the
  entrypoint or a library inside the target cannot make two overlapping trees look separate. A walk that
  cannot be completed is a refusal, and a refusal ends the run.
- **The helpers' own refusals.** The library helpers that delete, rename, re-own or copy into a tree
  they are *handed* check the path when they run, each against its own rule:
  - `driver_publish_unwind`, the driver sweep and the driver publication accept only paths inside
    `/etc/ims-cutover-driver`. For an operation that follows the path (a recursive chown or chmod, a
    copy into it) the whole path must canonicalise strictly inside it (`driver_require_owned_path`,
    which takes no mode). An operation on a NAME itself — removing, renaming or creating a pointer — is
    done by `driver_unlink_owned`, `driver_rename_owned` or `driver_link_owned`, which check that the
    name's own location is inside the root and then perform that one operation on exactly that name,
    so a pointer whose target lies elsewhere can be removed but nothing can be done *through* it.
  - the fence's `_fence_vendor_into` and `_fence_stage_and_publish` accept only paths strictly inside
    `/etc/ims-cutover-recovery`, or a probe directory the caller passes explicitly that is what
    `mktemp -d` makes (named `tmp.` + ten characters, directly in `${TMPDIR:-/tmp}`, owned by this
    account). So re-aiming one of the fence's `readonly` names at the application tree is refused.
    What these checks read is readonly, cleared when the library loads, or — `TMPDIR` — able only to
    narrow the probe rule (it says where a caller-passed probe must be), never to widen it.
  - `copy_tree_into_new_dir` checks only that its destination does not overlap the tree the run is
    executing from; the destination itself is the caller's choice, checked at the guarded call site.
  - `chown_state_tree` re-owns `${DATA_DIR}` and nothing else, after the same overlap check.
  - `scripts/lib/chown-tree.mjs` refuses to run anywhere but the directory its caller named, and refuses
    `/`, a top-level directory and its own tree; which directory is named is `chown_state_tree`'s
    decision.

  Canonical means every symbolic link resolved and no `.` or `..` component. **A refusal means the
  refused operation never runs.** It also ends the run: in the top-level shell it exits; in a command
  substitution, subshell, pipeline or background job — where every fence publication runs — it also
  sends SIGTERM to the top-level shell, whose EXIT trap runs as it would for an operator's kill. What
  that does NOT cover, stated precisely:
  - with TERM trapped (update.sh and deploy.sh: `exit 143`), bash runs the trap after the *current*
    simple command finishes, so a refusal inside a substitution used as an ARGUMENT
    (`rm -rf "v$(f)"`) lets that command complete. Every real call site is an assignment
    (`x="$(resolve_fence_script)" || die`/`return`), which is why this is wording and not a defect;
  - if TERM is ignored (`trap '' TERM`, or inherited as ignored), the run continues after the refusal;
  - a guarded function run in a separate `bash -c` process ends only that process;
  - inside the entrypoints' own EXIT-trap handlers the refusal deliberately ends only its subshell, so
    the handler still reports (for example "the fence could not be re-established") and finishes.

  In every one of these cases the refused operation itself still never runs.

The operations that run **without** a per-operation check in the entrypoints are listed by line, each
with its reason, in the test described below: eleven deletes of the clone directory the same run has
just made with `mktemp -d -t` (three after a successful copy, eight in a guard's own failure branch);
nine single-file renames of a staged `mktemp` file onto its target, and `update.sh`'s rename of one
finished backup dump; and the four calls of `migrate_uploads`, which checks its own `find … -exec mv`
inside the function. The library operations are the helpers above, checked at run time.

`tests/scripts/privileged-helper-set.test.ts` keeps all of this in place. It is a **fixed word list and
a classifier over the shapes it can parse**; it is not a proof about what the scripts do.

- The **census** tokenises the three entrypoints — quoting, `$( … )`, backticks, continuations,
  here-documents fed to a shell, same-file functions (one-line ones included), the house pass-through
  wrappers `run`, `capture` and `run_as_user`, and the payloads of `sudo`/`runuser`/`su` — splits each
  line into its statements, and for each statement it classifies as tree-wide requires a table row
  anchored to that whole statement: guarded, with the guard immediately before it and a refusal that
  ends the run, or carrying a written reason. Nine review rounds each found a shape it could not parse.
- A **lexical backstop** does not parse. Every statement in the three entrypoints and the five libraries
  they source that spells a word on its list — `chown`, `chmod`, `chgrp`, `setfacl`, `rsync`, `rm`, `cp`
  and any word ending in `cp`, `mv`, `install`, `tar` and any word ending in `tar`, `ln`, `find`,
  `xargs`, `cpio`, `unzip`, `scp`, `useradd`, `usermod`, `chattr`, `chcon`, `rmtree`, `git` with
  `clean`/`checkout`/`reset`/`restore`/`switch`/`-f`, `read-tree`, `stash`, the two tree-copying helpers,
  and the house program `chown-tree` — must be wholly census rows or an entry in
  `tests/scripts/privileged-word-allowlist.json` whose text matches exactly and whose count agrees.
  Here-document bodies and strings are read; a `#` line is skipped only when it is a comment in code,
  and never when it carries `$(` or a backtick. Which lines are comments is decided by a lexer (quotes,
  ANSI-C `$'…'` escapes, substitutions, here-documents), and the test checks that lexer against bash
  itself (`bash --pretty-print`, which drops comments and keeps strings) on every file it reads.
- The allowlist binds **text, not values or context**. Moving an allowlisted line, or changing a
  variable it uses, does not fail it. That is why every entry that changes a tree (`code-owned-tree`,
  `census-helper`) names the run-time guard that checks its path, and the test binds each occurrence to
  a call of that guard. That binding is **textual**, and exactly this: the call is a plain statement
  (its line starts with the guard, or it opens the operation's own `{ guard; op; }` group — not in a
  subshell, a substitution, a background job, or after `||`/`&&`); it sits in the function body or in a
  block that encloses the operation, judged by the shell's block structure (`if`/`while`/`for`/`case`/
  `{`/`(` … `fi`/`done`/`esac`/`}`/`)`, with `else`/`elif` starting a new block), not by indentation; it
  is called with its own number of arguments; it is called on exactly `${NAME}`, and the operation acts
  on exactly `${NAME}` — or `${NAME}/…` for a check that canonicalises the whole path, never for the
  name check, which covers only `rm`, `mv` and `ln` of the name itself — with no parameter operator
  such as `${NAME%/*}`; and NAME is not reassigned in between (`=`, `+=`, `NAME[…]=`, `printf -v`,
  `read`, `mapfile`, `local`/`declare`/`typeset`/`readonly`/`export`, `for … in`, `unset`, or any
  `eval`) nor aliased by a nameref declared anywhere in the function. A reader who wants to defeat a
  textual rule can; **the run-time check is the guarantee**, and the binding keeps the calls where they
  do their job.

What this does **not** see: a privileged command whose name is computed at run time — assembled from
variables (`c=ch; ${c}own`), an escape (`$'\x63hown'`), array elements (`"${CMD[0]}${CMD[1]}"`) or brace
expansion (`r{m,m}`); a command that is not on the list (`dd`, a new tool, a new house program); code in
a file these scripts read but do not ship (`/etc/os-release`); and a variable whose value changes so that
an allowlisted line reaches another tree — which is exactly the case the helpers' run-time refusals, and
the per-operation checks, exist to stop.

`install.sh` **also** asks the same question of `${APP_DIR}`, the state directory and the log directory
when the configuration is collected, and refuses `LOCAL_SOURCE_DIR` that is equal to, inside or
containing `${APP_DIR}`. That is an **early refusal**, and this page does not claim more for it: it runs
before a package is installed and before the service account is created, so an operator hears about an
overlapping tree while nothing has been changed — but on a **first install** those three directories do
not exist yet, so all it can compare against is their nearest existing ancestor (`/opt`, `/var/lib`,
`/var/log`). The real question, against the real and populated tree, is the one asked at each operation.
`update.sh` and `deploy.sh` have no such early gate; `update.sh`'s copy into `${APP_DIR}`, its git
metadata copy, its recursive chown and its backup pruner each carry the per-operation check, and
`deploy.sh`'s own text makes no tree-wide ownership change, copy, move or delete: its census rows are
single-file renames and its allowlist entries are single-inode, read-only, text or comments. The tree-wide
operations in the library code it calls are on directories that code creates itself — `mktemp -d`
directories, and staging and publication directories under root-only directories — and each is an
allowlist entry of class `code-owned-tree` naming the run-time guard that checks its path.

```bash
# ...or, on a box you will later upgrade, with the release's digest, which publishes the
# protected fence artefact now instead of asking for it at the first cutover:
IMS_FENCE_ARTEFACT_SHA256=<digest published with this release> \
  bash scripts/install.sh
```

**A first install performs no credentialed fence execution, so `IMS_FENCE_ARTEFACT_SHA256` is not
required there — but the run has to *earn* that exemption, and most runs cannot.** There is no
writer to stop only when this invocation created the database itself; then there is no migration
window to hold closed, and the fence helper — whose whole risk is that it is executed with an
administrative database credential beside it — is never executed. `resolve_fence_script()`
**refuses** on that path rather than merely never being called, so the policy is a property of the
code and not a description of it.

**Two questions, and either answer fences the run.** `upgrade_in_place()` returning false means
there is no service, no crontab, no PM2 instance and no process in the application directory. That
is a statement about *this host*, not about the database, and treating it as one was the r35
defect: a fresh application host pointed at an existing, live, remote database answers "nothing
here to break" while other writers are connected to the schema it is about to migrate. So
`first_install_exemption_available()` asks the second question separately, and the exemption needs
**both**.

**What counts as proof that this run created the database.** `CREATE DATABASE` succeeding, issued
by this invocation against the local PostgreSQL server it just installed. PostgreSQL rejects that
statement with `42P04 duplicate_database` when the name is taken, so a zero exit is the *server*
saying the object did not exist an instant earlier and that this statement brought it into being.
An already-existing database cannot produce that exit status — it makes the statement fail, and it
fails identically whether the database is empty, full, idle or busy. **An empty schema is not the
same thing and is not accepted**: "no tables in `public`" is true of a brand-new database and
equally true of one another operator created five minutes ago and is about to migrate, and it is a
race besides, since content can arrive between the question and the migration. Connection counts
and `datconnlimit` are the same kind of instant and are not used either.

**...and proof about *which server*, read off the connection that produced it.** A `CREATE
DATABASE` that succeeds says a database is new; it does not say *where*. `libpq` fills every
connection value the command leaves out from the environment — `PGHOST`, `PGHOSTADDR`, `PGPORT`,
`PGDATABASE`, `PGSERVICE`, `PGUSER`, a `pg_service.conf` found through `PGSYSCONFDIR` — and a
`PSQLRC` can move the session with a `\c` before the statement is even sent. An inherited
`PGPORT=5433` therefore used to create the database on a second cluster while the installer wrote
down `localhost:5432` as proven: both halves true, of different servers, and the fence skipped over
a live database on 5432. So:

* every `psql` the installer runs has each exported `PG*`/`PSQL*` variable removed from its
  environment, and is then **told** where to go — socket directory, port and maintenance database
  for the local superuser connection; host, port, user and database for the endpoint one — with
  `-X` (ignore any `psqlrc`) and `-w` (never block on a password prompt);
* and the proof is **verified, not composed**. The identity is read on the connection that
  performed the `CREATE` — `pg_postmaster_start_time()`, the server's own `port`, and the new
  database's `oid` — and compared with the identity read on a connection opened to
  `DB_HOST:DB_PORT` the way the application opens its own. Unequal stops the run. This is the same
  server-identity rule `scripts/fence-db-connections.mjs` already uses to decide whether two
  connections are the same cluster; the *system identifier* is deliberately **not** used, because a
  `pg_basebackup` clone inherits its origin's — which is the whole reason, and enough of one. (It is
  **not** superuser-only, as an earlier version of this sentence claimed: on PostgreSQL 17 a plain
  `LOGIN` role with no grants reads `pg_control_system()`. The decision stands on the clone-inheritance
  reason alone.)

The endpoint connection is made as a throwaway role this run creates with a random name and
password and drops immediately. That is what lets the check run **before** anything has been done
to the application role — see the next section.

`IMS_PG_SOCKET_DIR` overrides the socket directory the local superuser connection uses (default
`/var/run/postgresql`). It exists so the regression suite can bring up clusters of its own, and it
cannot weaken the proof: pointing it at another cluster does not produce an exemption, it produces
the refusal above — which is what that suite asserts.

**Everything unproven is fenced**, which is every case below. Each requires the deploy admin
credential (`DEPLOY_ADMIN_DATABASE_URL`, held by root: see [Database identities](#database-identities))
and a protected fence artefact, exactly as an upgrade does:

| case | why |
| --- | --- |
| `INSTALL_POSTGRES=n` — an external or remote database | the installer creates no database on this path, so there is nothing for it to have proven. **Every remote database is here.** |
| `INSTALL_POSTGRES=y` over a database that already existed | `CREATE DATABASE` was refused as a duplicate. The run continues; it simply does not get the exemption. |
| any indeterminate creation result | `psql` unreachable, or a failure that is not duplication. The run **stops** rather than continuing over a database it cannot describe. |
| a proof about a different host, port or database name | proof about one database is not proof about another. |
| a `CREATE` that landed on a **different server** | the endpoint `DATABASE_URL` names answered with a different postmaster, port or database `oid`. The run **stops**: the database it is about to migrate is one it did not create. |

**Supply the digest if you have it, and it is enforced — but only the whole-tree one.** With
`IMS_FENCE_ARTEFACT_SHA256` on the invocation, a first install *publishes* the protected artefact
before it migrates — root reads and copies the tree, executing nothing — so the first upgrade
cutover finds a standing, authenticated artefact instead of discovering the bootstrap is still
outstanding at the worst possible moment. A pin that does **not** authenticate this checkout is a
**refusal**, never a warning: nothing has been migrated and nothing has been started.

<a id="first-install-pin-contract"></a>
**The first-install pin contract.** These are the exact bytes `scripts/install.sh` defines as
`FIRST_INSTALL_PIN_CONTRACT` and prints when it refuses;
`tests/scripts/fence-digest-and-first-install.test.ts` asserts that this block and that constant
are the same string, so the code is the source and this paragraph is derived from it:

> On a first install, IMS_FENCE_ARTEFACT_SHA256 is the ONLY input that publishes the protected fence artefact. IMS_FENCE_SCRIPT_SHA256 alone is REFUSED here: it authenticates the entry file, while the artefact also vendors that helper's dependency closure out of the application-owned checkout. Supply IMS_FENCE_ARTEFACT_SHA256 -- IMS_FENCE_SCRIPT_SHA256 may accompany it and is then also enforced -- or supply neither, in which case this install fences nothing, publishes nothing, and the first upgrade asks for the digest instead.

`install.sh` chowns the checkout to the application user before it reaches this point, so the
source the closure is vendored from is application-writable on **every** install this script
performs — which is why the rule is stated flatly rather than conditioned on a property that is
always true here.

**An upgrade is where the pin becomes mandatory.** Running this installer over an existing
installation, or running `scripts/update.sh` or `scripts/deploy.sh`, fences a real window and
executes the helper with an administrative credential. Until a protected artefact stands on the
box, that tree is assembled out of this checkout — which the application account owns — and must
be authenticated by a whole-tree digest that came from the release rather than from the box
([where to get it, on a first-ever install as much as any other](#artefact-digest-first-install)),
or the source must be one only root can write. Omit it there and the run stops before anything is
migrated, printing every route to the value it wants.

<a id="database-role-ordering"></a>
### What the installer may do to the database before it knows it may proceed

**Nothing that another client can feel.** The PostgreSQL section used to create *or alter* the
application role and its password, decide whether the database was new, then `GRANT` and move the
database's **owner** — all of it before the run had classified the cutover, and long before
`require_fenceable_database()` had established that a window could be held closed. On a fresh
application host pointed at a **pre-existing, live** database, a missing
admin credential or a missing fence artefact then aborted the run with *"nothing has
been stopped and nothing has been migrated"* — over a database whose application role had already
lost the password its clients were using and whose ownership had already moved.

A refusal is only safe at a point where refusing leaves the system consistent. So the section is
split along exactly one line — whether a statement can take something away from a client that is
using this database right now:

| before classification | after it |
| --- | --- |
| `CREATE ROLE` **when the role is absent**. Nothing can be connected as a role that does not exist. A role that is already there is left completely alone, and the run records — by SQLSTATE `42710` — that it found one. It has to happen here: `fence-db-connections.mjs --preflight` refuses outright when `--app-user` names a role the server does not have, and that preflight is what gates the fenced path. | `GRANT ALL PRIVILEGES ON DATABASE` and `ALTER DATABASE … OWNER TO`. |
| `CREATE DATABASE`, which either brings a database with no writers into being or is refused as a duplicate. Neither outcome alters an existing object. | *(nothing else — see the password, below, which is later still)* |

On the fenced path the second column runs after `require_fenceable_database()` has proved the
window can be held closed and after any standing fence has been adopted; on the first-install path
it runs once the exemption has been earned. **Inside a standing fence the grant and the ownership
change are skipped entirely** and only the password is set: `GRANT ALL PRIVILEGES ON DATABASE`
grants `CONNECT`, which is the one privilege the fence exists to take away, and changing the owner
rewrites the owner's ACL entry — either would re-open the door the run is holding shut while it
still reported the window as closed. A fence can only be standing over a database this run did not
create, so both are already what the statements would have set them to, and the fence's own
release is what restores what it revoked.

#### The database password is preserved, and a rotation waits for the fence

**An ordinary re-install does not change the application role's password at all.** The prompt
defaults to the credential already in `${APP_DIR}/.env` — recovered out of its `DATABASE_URL`, and
only when that URL names the same **role, host, port and database** this run is about to use, so a
changed `DB_USER` never inherits another role's secret. Pressing Enter through an upgrade therefore
changes nothing about the role, exactly as it already did for `REDIS_URL`. (Before this, the
local-database prompt defaulted to a freshly generated secret, so a routine re-install rotated a
live credential as a side effect of being run.)

**Supplying a different password asks for a rotation, and that rotation happens only inside the
stopped, fenced window** — after the reboot fence is installed, cron is fenced, `systemctl stop`
has returned, the port is free, the connection fence is up and `check-db-writers.mjs` has confirmed
no other backend is attached. It is refused, loudly, anywhere else.

That is compatible with the build running *before* the stop, because the build is handed a
credential that **works**, not the one being rotated to: until the `ALTER USER` runs, `DATABASE_URL`,
`${APP_DIR}/.env` and the `MIGRATION_DATABASE_URL` given to `prisma generate` and `npm run build`
all carry the **installed** password. A build that fails therefore leaves a predecessor whose
environment file and whose database still agree. Once the rotation succeeds, the run recomposes
`DATABASE_URL` and re-writes `${APP_DIR}/.env` with `write_app_env_file()` — the same function that
wrote it before the build, re-run from the variables this process already holds, so the installer
never becomes a *reader* of a file the application account owns.

Two things this cannot do, stated plainly:

* `ALTER USER … PASSWORD` is **cluster-wide** and the connection fence is **database-specific**. The
  window protects the clients of *this* database; any other client on the same server authenticating
  as that role, against any database, is refused from its next connection onwards. That is why the
  rotation is opt-in and says so out loud.
* On the **first-install** path there is no window at all, so a requested rotation is **refused**
  before the build: the exemption means this run created this database, but the role is cluster-wide
  and pre-existing. Re-run with the password that role already has.

If a rotation did happen and a later step fails, the post-stop failure banner says so: `.env` and
the server agree, and any *other* client using the old password for that role needs the new one.
The pre-stop banner now states the opposite, and can: no credential was rotated.

##### The password is a literal, and the URL is percent-encoded

`DB_PASSWORD` is the **literal server secret**. It is SQL-quoted for `CREATE USER`/`ALTER USER`
(with `standard_conforming_strings` SET on the same connection, so doubling the apostrophe is
complete escaping) and **percent-encoded** into `DATABASE_URL`, keeping only the RFC 3986
unreserved set `A-Z a-z 0-9 - . _ ~`. A `DATABASE_URL` found in an existing `${APP_DIR}/.env` is
**decoded** with the same semantics before it is compared with anything or used as a credential.

That matters because the application does not read the URL the way a naive installer writes it:
node-postgres percent-decodes the userinfo. Interpolating the password raw meant `abc%2Fdef` was
committed on the role and `abc/def` was handed to the driver; a raw `/`, `?` or `#` made the URL
unparseable altogether; `%FF` threw; and an apostrophe never reached the URL at all, because it
ended the SQL literal. All of it after the predecessor had been stopped.

The encode/decode pair is verified against the `pg` in this repo's `node_modules` rather than
against the specification — `tests/scripts/install-credential-representation.test.ts` runs the
shipped shell functions over 28 reserved-character passwords, parses their output with the
installed `pg-connection-string`, and opens real connections with `pg.Client`.

**A password ending in a newline is one of those 28, and it used to be truncated.** Command
substitution — `VALUE="$(some_function)"` — deletes every trailing newline from what it captures.
The encoder wrote such a password correctly (`%0A`), the driver read it back correctly, and the
server held it correctly; the *recovery* then dropped the last byte, so a re-install compared
`abc` against an installed `abc\n`, saw a difference, and asked to rotate a live credential nobody
had asked to rotate. On the journal path the same loss published a `.env` naming a password the
server does not have.

Every value on the credential path that crosses a command substitution now goes through a
`capture` helper, which appends a sentinel inside the substitution and removes it afterwards, so
the trailing newlines are no longer trailing. That covers the URL recovery (both the role and the
password halves), the outer `installed_database_password` capture, the two rotation-journal
decodes, the Redis userinfo recovery, and the `sed` pipeline inside the URL decoder itself. The
remaining substitutions on that path cannot carry a trailing newline: percent-encoders and
`base64 | tr -d '\n'` emit alphabets that exclude it, `sql_quote_literal` ends with an apostrophe,
the URL composer ends with the database name, and everything read from `.env` came out of a *line*,
which ends at the newline it cannot contain.

**Any password you can type is now installable.** If you are choosing one, a hex or base64 secret
still travels through the fewest layers.

##### An interrupted rotation is recorded, and the next run finishes it

`ALTER USER … PASSWORD` **commits**. Everything that makes the new credential usable happens after
it, so a kill, a power loss, an `ENOSPC` or a refused `chown` in between could leave PostgreSQL on
the new password and `${APP_DIR}/.env` on the old one — inside the stopped, fenced window.

Two things close that:

* **`${APP_DIR}/.env` is published by rename.** It is rendered whole from the variables this
  process holds, written to a temporary file, given its ownership and mode, flushed, renamed, and
  the directory flushed. The path never names a partial file, and the write is **checked** — a
  failure is a refusal, not a flag that says the file agrees.
* **A rotation journal is written before the `ALTER`.** Root-owned, mode `0600`, at
  `/etc/ims-cutover/db-role-rotation.journal` (*not* under the cutover state directory, which the
  application account can write). It carries the connection's identity and **both** candidate
  passwords, and it is removed **last** — only after an environment file naming the live credential
  is on the medium.

* **The endpoint the reconciliation will ask is proven before the `ALTER`, and recorded.** See
  *A probe that cannot say no is not evidence* below.

On the next run, `prompt_db_password` reconciles it before anything has been touched, by **asking
the server** which of the two passwords is live — on an endpoint whose matched `pg_hba` rule the
server itself named as one that checks `pg_authid.rolpassword`, and which has then been shown able
to **refuse** a password nothing can know:

| what the interrupted run got as far as | what the next run does |
| --- | --- |
| the journal, not the `ALTER` | the OLD password answers. Nothing was taken away and `.env` already agrees; the run adopts it as the installed credential and clears the journal. Supply the new password again to ask for the rotation a second time. |
| the `ALTER`, not the environment file | the NEW password answers. The run **finishes the transition**: it treats that credential as the installed one in place of what `.env` says, so the environment file it writes names what the server actually has, and the journal is cleared only once that file is published. |
| both, but not the clear | indistinguishable from the row above, and it does not need to be distinguished. The rewrite is byte-identical and the journal is cleared. |
| no endpoint both checks the role's own credential and can discriminate | the run **refuses**, before anything is stopped, and **leaves the journal** — it is the only remaining record of the two candidates. Restore one with `ALTER USER`, or set a password of your own and delete the file, then re-run. |
| an endpoint that can discriminate accepts **both** | also a refusal. Two passwords cannot both be the role's, so the server is not answering the way a password check answers, and preferring one of them would be a guess. |

A journal naming a **different** role, host, port or database is also a refusal: this run cannot
finish that transition and must not delete its record on the way past.

A rotation that cannot journal durably does **not** issue the `ALTER` at all.

##### A probe that cannot say no is not evidence

Reconciliation asks the server whether a candidate password authenticates. Whether a **successful**
connection proves anything is not a property of this installer — `pg_hba.conf` decides it, per
database, per host, per role, and PostgreSQL supports rules under which it proves nothing:

* a **`trust`** rule on the endpoint accepts *every* password. The probe cannot fail, so it would
  "prove" whichever candidate was tried first and could publish a credential the `ALTER` never set;
* a **revoked `CONNECT`** refuses the *session* rather than the password, so a role holding exactly
  the right credential reads as dead. **The connection fence does this to the application
  database**, and an interrupted rotation leaves that fence standing.

So an endpoint is admitted as evidence only after it has been shown, on that endpoint, in that run,
to **refuse** a freshly minted random 32-byte password **and accept** one asserted live. Both
halves: an endpoint that refuses everything has not been shown able to say yes.

##### ...and a probe that can say no still has to say whose password it checked

Those two halves prove an endpoint tells one password from another. They do **not** prove the
password it tells apart is PostgreSQL's own role credential, which is the only thing `ALTER ROLE`
changes. `pg_hba.conf` has password-dependent methods that consult somebody else's store —
**`ldap`**, **`pam`**, **`radius`**, **`bsd`** — and under every one of them both halves behave
exactly as they do on a healthy `scram-sha-256` endpoint:

> `postgres` authenticates through LDAP while the application database uses `scram-sha-256`. Before
> the rotation the LDAP endpoint refuses the random control and accepts the credential `.env` names,
> so it is admitted and recorded. The run dies after the `ALTER`. The next run re-proves that same
> endpoint; LDAP still accepts only the *old* password, because a directory never heard of an
> `ALTER ROLE`; so the reconciliation concludes the `ALTER` did not commit, publishes the old
> password and **clears the journal**. The application database wants the new one. The service
> cannot connect and the record that would have recovered it has been deleted.

So the matched method is **established rather than inferred**, and it is the server that states it.
`scripts/lib/pg-auth-request.mjs` performs the ordinary startup exchange and reads the
authentication request the server sends *after performing its own `pg_hba` match*:

| what the server asks for | matched method | admitted? |
| --- | --- | --- |
| SASL offering `SCRAM-SHA-256` | `scram-sha-256`, or `md5` over a SCRAM-format verifier | **yes** — it compares `pg_authid.rolpassword` |
| `AuthenticationMD5Password` | `md5` | **yes** — same secret |
| a cleartext password | `password`, `ldap`, `pam`, `radius` or `bsd` — *the wire cannot separate them* | no |
| nothing at all | `trust`, or a `peer`/`ident`/`cert` rule already satisfied | no |
| GSSAPI, SSPI, anything else | an external identity system | no |

It sends **no password** — the connection is dropped as soon as the request has been read — and it
is asked **first**, before any candidate credential leaves the host, so a rotation never hands the
role's password to a directory it has not yet established is uninvolved.

Two consequences worth knowing before you meet them:

* **`password` is refused even though it is sound.** Cleartext-against-PostgreSQL does compare the
  role's own secret, but it asks for the plaintext with the same protocol message `ldap` uses — and
  must, since an external verifier can only be consulted with the plaintext. All five are refused
  together. Use `scram-sha-256` or `md5` for the installer's host.
* **If the method cannot be established at all** — no `node`, or the installer was run from an
  incomplete checkout so `scripts/lib/pg-auth-request.mjs` is missing — that is an unknown, and an
  unknown **refuses**, before the `ALTER`.

### The route, and why the method alone was not enough

The method is read on a connection of the reader's own, and through r42 every probe that followed
was opened on libpq's default `sslmode=prefer` — which does not mean "use TLS". It means
*try TLS, and if that connection fails, retry without it*. `hostssl` and `hostnossl` are **different
records**, so an authentication failure could select a second one, and the two instruments then
answer about two different transports:

> `hostssl … scram-sha-256` over `hostnossl … radius`, with the directory holding the role's current
> password. The reader negotiates TLS, stops at the `hostssl` record and reports `scram-sha-256` —
> truthfully. The negative control's random password fails scram, drops to the clear and is refused
> by the directory too, so its **no** is satisfied. The asserted password succeeds over TLS, so its
> **yes** is satisfied. Both pass. After an interrupted rotation the new password is accepted by
> scram and the old one by the directory, both candidates read as live, and the reconciliation
> refuses — leaving a stopped, fenced installation that needs a person.

Removing that divergence by aligning the reader and the probes **with each other** left them
aligned with a connection nobody makes. The connection this gate exists to vouch for is the
**application's**, and the application does not use libpq at all: node-postgres, handed the
`DATABASE_URL` this installer emits, sends no `SSLRequest` — measured against the driver the
release installs, not read out of its documentation. It is matched by the `hostnossl`/`host` record
while every probe was reading the `hostssl` one. On the split above that publishes a SCRAM password
the application's own route has never heard of, and clears the journal that recorded the other
candidate.

**So the reference point is the application's connection.** The installer works out what
node-postgres does with the URL it is about to write, **tells** the reader to take exactly that
route, checks that the reader reports having taken it, and pins every credential-bearing psql to
it — with `gssencmode=disable` beside it so GSSAPI encryption cannot select a `hostgssenc` record
either. That route is whatever `DB_SSLMODE` states — `disable` unless the deployment says
otherwise, and `disable` for every installation that existed before it — and if the emitted URL
ever stops being of the shape the driver was measured against, the gate refuses rather than
assuming. `prefer` appears in no connection the installer opens. A method read on **any other
route** is refused exactly as an unestablished method is.

Two things follow, and they are the point rather than a side effect:

* **a cluster whose only password-checking rule is a `hostssl` one is refused while
  `DB_SSLMODE=disable`**, because the application cannot reach it either. Better a refusal before
  the `ALTER` than a rotation whose result the application can never present. Set `DB_SSLMODE` to
  the transport that cluster requires and the same rule is read, probed and rotated against — on
  the record the application will be matched by.
* **a cluster whose `hostssl` rule is useless but whose `hostnossl` rule is sound is accepted**,
  which an earlier round refused.

### The URL is only half of what decides that route

Working the route out from the `DATABASE_URL` alone is not enough, and the reason is the same one
that made every `psql` this installer runs go through an environment scrub. node-postgres leaves
its `ssl` setting **undefined** when the URL says nothing about it, and then reads
`PGSSLMODE` out of the process environment. A service started with `Environment=PGSSLMODE=require`
— or an operator who exports it before running the installer — therefore has an application on a
`hostssl` record while the gate reads, probes and rotates against `hostnossl`. That is the outage
this whole section exists to prevent, arriving through the one door the derivation did not look at.

Measured against the driver the release installs, the variables it consults for a URL of this shape
are `PGSSLMODE`, `PGREPLICATION`, `PGOPTIONS`, `PGAPPNAME`, `PGBINARY`, `PGCLIENT_ENCODING`,
`PGCONNECT_TIMEOUT` and `NODE_PG_FORCE_NATIVE`. `PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE` and
`PGPASSWORD` are **not** among them, because the emitted URL states all five. Three of the eight
change which `pg_hba.conf` record answers:

| variable | what it does to the record |
| --- | --- |
| `PGSSLMODE` | decides whether an `SSLRequest` is sent at all, so it chooses between `hostssl` and `hostnossl` |
| `PGREPLICATION` | turns the backend into a WAL sender, which `pg_hba.conf` matches on the `replication` keyword rather than on the database name |
| `NODE_PG_FORCE_NATIVE` | replaces node-postgres with libpq, which fills `sslmode`, `gssencmode`, `service` and `host` from the environment all over again |

**An ambient value of any of those three is still a refusal, and it is refused in the installer's
own process.** The migration, the build and `scripts/fence-db-connections.mjs` are Node processes
the installer starts; they run the application's own driver and inherit that environment verbatim,
and no systemd directive reaches them. If one is set, unset it and re-run — and if the deployment
needs an encrypted transport, **state it as `DB_SSLMODE=` instead**, which is the next section.

### What the service is handed is a property, not a survey

Everything the *service* could be given is closed rather than looked at. The installer writes a
permanent drop-in — `/etc/systemd/system/<unit>.service.d/zz-deploy-db-route.conf` —

```ini
[Service]
UnsetEnvironment=PGSSLMODE PGREPLICATION NODE_PG_FORCE_NATIVE
```

and `systemd.exec(5)` is explicit about when that is applied: *"as the final step all variables
listed in `UnsetEnvironment=` are removed from the compiled environment variable list, immediately
before it is passed to the executed process"* — after `DefaultEnvironment=`, `systemctl
set-environment`, the manager's own block, `Environment=`, `EnvironmentFile=` and PAM alike.

That replaces a reader which used to open the unit's environment files and grep them, and which was
wrong in two ways at once. `EnvironmentFile=` may be a **wildcard**, and a glob is not a file, so a
matching file that set `PGSSLMODE` was read as absent. And even a literal path was read by the
installer *here* while systemd opens it *there*, at exec, past a git clone, an `npm ci`, a Next
build and a migration — so a line added in that window moved the route after the gate had passed.
A directive removes the variable whatever set it and whenever it was set. The names are written
**bare**: `UnsetEnvironment=PGSSLMODE=require` would remove only that exact assignment.

The drop-in is not trusted because it was written. Immediately before `systemctl start` — after the
last `daemon-reload`, which is the point at which "composed" means anything — the installer reads
the loaded unit back off systemd's bus and refuses unless all three names are there. An empty
`UnsetEnvironment=` in a later drop-in *resets* the list, which is why this one sorts last and why
it is verified rather than assumed. It is left in place after the run, so the starts `deploy.sh`
and `update.sh` perform later are covered by the same directive.

**`ExecStart=` is the one layer the directive cannot reach**, and it gets its own check. A drop-in
saying

```ini
ExecStart=/usr/bin/env PGSSLMODE=no-verify /opt/ims/node_modules/.bin/next start -p 3000
```

sets the variable *inside* the launched program, one exec after systemd has finished composing the
environment. It appears in no `Environment=`, no `PassEnvironment=`, no `UnsetEnvironment=` and no
`EnvironmentFile=`, and it survives a rewrite of the base unit. So the composed `ExecStart` is read
off the bus too and compared, string for string, with the command the installer's own unit
here-doc emits — one command, that binary, that argv. A wrapper, an override, a second command or
a path systemd had to escape is a refusal that prints both what systemd would run and what was
expected.

### TLS: `DB_SSLMODE`, and why it is a supported input rather than a derivation

An external PostgreSQL that accepts **only** encrypted connections — which is every managed one — is
a supported deployment, and the way to say so is `DB_SSLMODE`. The installer prompts for it on the
external-database path (`INSTALL_POSTGRES=n`); the local path sets `disable` explicitly, because
that cluster is one this script installs on this host and reaches over `localhost`.

| `DB_SSLMODE` | what the application does | needs |
| --- | --- | --- |
| `disable` (default) | no `SSLRequest` at all; matched by `hostnossl`/`host` records only | — |
| `require` | encrypted; the certificate is **not** verified | — |
| `verify-ca` | encrypted; the certificate chain is verified, the hostname is not | `DB_SSLROOTCERT` |
| `verify-full` | encrypted; chain **and** hostname verified | `DB_SSLROOTCERT` |

`prefer` is deliberately absent: it picks its transport at run time, so an authentication *failure*
can fall onto a second `pg_hba.conf` record, which is precisely what pinning exists to prevent.

The mode goes into the emitted `DATABASE_URL` as
`?sslmode=<mode>&uselibpqcompat=true` (plus `&sslrootcert=<path>` where one is needed). **That
second parameter is the whole answer to the objection the previous section raises.** node-postgres's
`sslmode=` is not libpq's — without it, `require` means *verify-full against Node's own CA bundle*,
which no `psql` pin reproduces and which a Debian cluster's self-signed certificate fails. With it,
pg-connection-string switches to its libpq-compatible branch and the four words above mean exactly
what libpq and `psql` mean by them. Nothing is re-implemented here; the driver's own compatibility
switch is *selected*, and the gate and the application are then describing one transport with one
word.

Everything then runs on it. The authentication-request reader is told the mode (and the CA) and
reports the mode it took; the credential probes are `psql` under `PGSSLMODE=` and `PGSSLROOTCERT=`
with `PGGSSENCMODE=disable` beside them. `DB_SSLROOTCERT` must be an absolute path made only of
`A-Za-z0-9._-/`: it is placed verbatim into a URL query, an environment variable and a command-line
argument, and escaping it correctly for all three would be three more sets of somebody else's rules.

On an upgrade the mode and the CA are recovered from the `DATABASE_URL` the previous run wrote, so
pressing Enter through the prompts keeps a TLS-only installation on TLS.

#### Under `--non-interactive`

Both values are read from the process environment, and the precedence is explicit:

```
DB_SSLMODE=verify-full DB_SSLROOTCERT=/etc/pki/db-ca.pem bash install.sh --non-interactive
```

1. **what the caller supplied** — `DB_SSLMODE=` / `DB_SSLROOTCERT=` in the environment;
2. **what the previous run published** — recovered from the installed `DATABASE_URL`;
3. **`disable`**, on a first install where nobody said anything.

A supplied value therefore beats a recovered one, which is what makes it possible to *change* the
transport, or the CA, on an unattended upgrade. On the local-database path (`INSTALL_POSTGRES=y`)
a supplied `DB_SSLMODE` other than `disable` is refused as an input and the run says so: that
cluster is installed on this host and reached over `localhost`, where there is no transport
question to answer.

#### The CA is published, not merely named

`DB_SSLROOTCERT` names the operator's own file, and three different accounts have to open the trust
root: the installer and its authentication-request reader as **root**, the `psql` credential probes
as **postgres**, and the running service as **`imsapp`**. A CA that only root can read passes every
check an installer makes and then fails when the application starts — after the migration.

So the installer publishes the certificates to a path of its own:

```
/etc/ims-db-ca/db-ca-<sha256>.crt    root:root  0644   (in /etc/ims-db-ca, root:root 0755)
```

and repoints everything at it. From that moment the `sslrootcert=` in `DATABASE_URL`, the reader's
`--sslrootcert=` and `psql`'s `PGSSLROOTCERT` are the same file — readable by every account that
needs it, writable by root alone, so it cannot be swapped between the probe that vouched for it and
the service that connects with it. The installer records its SHA-256 at publication and re-checks
the digest, the ownership and the mode again once the `imsapp` account exists, opening the file **as
that account** before it writes any environment file or starts anything.

##### What the file may contain

The installer does not copy the bytes it is given. It **parses** them, and it publishes only what it
parsed. A trust root is a bundle of PEM certificate blocks and nothing else, and the accepted labels
are exactly the three the OpenSSL verification store behind all three readers of this file consumes:

```
CERTIFICATE        X509 CERTIFICATE        TRUSTED CERTIFICATE
```

That set was **measured, not assumed**: every PEM label OpenSSL defines a constant for was wrapped
around one real CA and offered to `openssl verify -CAfile`, to a Node TLS client and to `libpq`.
Three of them are consumed; the store skips every other label as if it were not in the file. (A
revocation list is a different parameter, `sslcrl`, against a different store.) Every block is
decoded with `openssl x509`, and what is written out is OpenSSL's own re-encoding of the
certificates it decoded:

- a `PRIVATE KEY` block, of any flavour, is **refused** — as is any label outside the three above;
- a combined key-and-certificate file is **refused**, and nothing is written, not even the
  certificates that came before the key;
- a block *labelled* as a certificate that is not one is **refused**, because the label is not
  evidence;
- a file with no certificate in it at all is **refused**;
- the subject/issuer commentary many vendor bundles carry around their certificates is simply
  dropped, because it is not published.

**`TRUSTED CERTIFICATE` blocks keep their trust settings.** The X509_AUX block such a certificate
carries (`openssl x509 -addtrust`/`-addreject`) *narrows* what the anchor may vouch for, and all
three readers enforce it. Re-encoding it as a plain `CERTIFICATE` would silently install a **wider**
trust root than you supplied, so the installer re-encodes it with `-trustout` and refuses to publish
if the result is not still a trusted block. A restricted anchor is byte-identical after publication,
and still refuses exactly what it refused before.

This matters because the installer runs as **root** and the published file is **world-readable**: a
mistyped `DB_SSLROOTCERT` naming a private key would otherwise disclose it to every account on the
host. If your CA file is a combined one, extract the certificates into a file of their own and name
that. A DER-encoded certificate is not accepted — convert it first with
`openssl x509 -inform DER -in <file> -out <file>.pem`.

##### Generations, and how to go back

The published name is the SHA-256 of the published bytes, so **a new CA is a new file**. Nothing is
ever written over the generation an installed `DATABASE_URL` names, and re-running an unchanged TLS
installation republishes onto the same path with the same content. Which generation is in use is
decided by `DATABASE_URL`, and that is rewritten only when the installer writes the environment
file — long after every probe.

**A failed refresh therefore changes no trust root.** If the CA you supplied is wrong, stale or
malformed, or the run refuses anywhere afterwards, the environment file still names the generation it
named before, that file is untouched, and `systemctl start one-two-inventory.service` brings the
installation back exactly as it was. Fix the certificate and re-run.

**When the cluster's CA changes**, re-run the installer with `DB_SSLROOTCERT=` pointing at the new
source file — a supplied value beats the recovered one. Doing nothing leaves the old trust root in
place, and that fails **closed**: under `verify-ca`/`verify-full` a certificate that no longer chains
to it is refused, so a rotated CA takes connections down loudly rather than quietly accepting a chain
nothing vouched for.

**To roll back to an earlier CA**, list the retained generations newest first and republish one:

```bash
ls -lt /etc/ims-db-ca/
DB_SSLMODE=verify-full DB_SSLROOTCERT=/etc/ims-db-ca/db-ca-<sha256>.crt bash install.sh --non-interactive
```

A generation is an ordinary PEM file, so it is a valid `DB_SSLROOTCERT` in its own right and
republishing it lands on its own path again. At the **end of a successful install** — never on a
failure — the installer removes superseded generations, keeping the one this run published, the one
the previous environment file named (whatever its age: that is the rollback target), and the three
most recently written of the rest. Each removal is printed.

**Only files the installer itself wrote are ever removed.** A generation is recognised by its exact
name — `db-ca-` followed by 64 lowercase hex characters and `.crt` — *and* by re-hashing the file to
check it really holds the bytes that name claims. Anything else in `/etc/ims-db-ca` is neither
deleted nor counted against the retention window, including files whose names look close: a
`db-ca-manual.crt` you put there yourself, or a copy restored under a generation's name whose
contents no longer match it. Both survive every prune, however old they are.

The postmaster-identity read performed just after `CREATE DATABASE` is the one credential-bearing
connection deliberately **left unpinned**. What it concludes — that the server answering
`DB_HOST:DB_PORT` is the one the `CREATE` landed on — is established from a start time, a port and
a database oid, none of which any transport can change; and it authenticates as a throwaway role
rather than as the application's, so under a pin a role-specific `pg_hba.conf` layout would turn a
run that would have completed into a stopped install, and buy nothing.

The negative control is *kept* alongside all of this, and is not redundant — but for two reasons
rather than the transport one:

* **its positive half is the only authentication in the gate.** The reader never completes one, so
  nothing else can tell a healthy `scram-sha-256` endpoint from one where the role has no
  `CONNECT` — and this installer's own connection fence revokes `CONNECT` on the application
  database.
* **its negative half is the only thing that catches a route that announces `scram-sha-256` and
  then accepts anything.** Pinning closes the transport divergence; it cannot close a `pg_hba.conf`
  **reload** landing between the two connections, and it says nothing about a pooler or proxy on
  the same host and port that speaks SASL without verifying.

**Before the `ALTER`**, the rotation searches for such an endpoint and records it in the journal.
The candidates are read from the server — every connectable, non-template database except the
application one, capped at eight, with `postgres` first — because the application database will be
behind the fence when a reconciliation runs, and a rotation whose journal could not be reconciled
must not happen. **If no endpoint can be shown to check the role's own credential *and* be able to
tell one password from another, the rotation refuses**: nothing has been `ALTER`ed, the role still
holds the credential `.env` names, and the two agree.

The usual cause of that refusal is a `trust` rule for this host, an authentication method that is
not `scram-sha-256` or `md5`, or `PUBLIC` `CONNECT` revoked on every database this role could
reach. Each is fixed before re-running:

```sql
GRANT CONNECT ON DATABASE postgres TO "imsuser";   -- or any database that is not the application one
```

together with a `scram-sha-256` or `md5` rule for the installer's host in `pg_hba.conf`.

The reconciliation asks the **recorded** endpoint first, then re-derives the same list, then the
application database as a last resort — and it re-establishes the proof every time, because
`pg_hba.conf` can change between the two runs.

The script performs the following steps:

1. **Pre-flight checks** — verifies root access, detects the OS, and checks internet connectivity
2. **Installs Node.js 22** via NodeSource
3. **Installs and configures PostgreSQL** — creates the database and user
4. **Installs nginx**, `fail2ban`, and automatic security updates
5. **Installs runtime tooling** used by deployment and maintenance scripts
6. **Prompts for configuration** values (see below)
7. **Creates the app system user** (`imsapp`)
8. **Deploys the application** — clones from git or copies from a local directory
9. **Installs npm dependencies** and builds the Next.js application
10. **Runs database migrations** via Prisma
11. **Optionally seeds public URL, SMTP settings, and a default admin user**
12. **Configures a native systemd service** for the application
13. **Configures nginx** as a reverse proxy
14. **Enables fail2ban and unattended security updates**
15. **Sets up cron jobs** for scheduled tasks
16. **Prints a post-install summary** with next steps

For unattended installation, use `--non-interactive` and set configuration values as environment variables.
For full Proxmox + Cloudflare + OpenLiteSpeed tenant rollout, see [Automated Tenant Provisioning](tenant-provisioning.md).

### Re-running the installer over an existing installation

This is supported and expected — the installer reads back the `.env` a previous run wrote, preserves
the secrets it cannot re-mint (`SETTINGS_ENCRYPTION_KEY`, `AUTH_SECRET`, `CRON_SECRET`) and keeps a
working `REDIS_URL`. Because it is an upgrade entrypoint, it applies **the same cutover sequence as
`scripts/deploy.sh` and `scripts/update.sh`** (o3d-2sm1.3).

**What counts as an existing installation** (o3d-2sm1.4): the `one-two-inventory.service` unit
*file* (not `is-active` — a stopped service still has a crontab, a database and a schema), an active
crontab line, **a legacy PM2 installation** (a `pm2-<user>` unit, an `${APP_DIR}/.pm2` home, or the
app registered with a PM2 daemon), or **any node process whose working directory is the app
directory**. Detecting only the new unit meant a PM2-run installation — which this script explicitly
supports and removes — was never recognised, so nothing was fenced, nothing was stopped, and the
migration ran with the old binary live. PM2 is now stopped, disabled and deleted, and stray
app-directory processes are terminated (`SIGTERM`, then `SIGKILL`), **before** the migration rather
than after it.

When it finds one it:

1. refuses immediately unless the migration window can be fenced (see
   [the connection fence](#deploy-order-and-what-happens-on-a-rollback)), and adopts any cutover
   fence a previous run left standing;
2. installs and **verifies** the reboot-fence drop-in, before anything is stopped;
3. stops the service **and every legacy launcher**, waits for the port to go free, **then** fences
   the crontab, revokes `CONNECT` for the window and proves nothing else is connected;
4. migrates, checks for drift, and runs the migrations' own `verify.sql` checks;
5. seeds, bootstraps and builds — all through the connection that survives the fence;
6. releases the connection fence, lifts the reboot fence, starts the service, **proves the process
   on the port is this build and belongs to this unit**, and only then restores the crontab, before
   the managed cron block is spliced back in.

On a failure after the stop it leaves the service **stopped and fenced** and never restarts it, on
exactly the same terms as the deploy scripts — see [Deploy order](#deploy-order-and-what-happens-on-a-rollback).
It previously migrated with the old service and the old cron writers live, which is the defect that
order exists to remove. A **first** install fences nothing, deliberately: there is no service, no
crontab and no data, so there is no writer to stop.


### Secrets are never on a command line

`ps` shows the command line of every process to every local account, so the installer hands secrets to the programs it starts through the environment (readable by root and the owner only) or through a mode-600 file, never as an argument. The bootstrap step exports the default administrator's password, the SMTP password and the WooCommerce key and secret inside a subshell and lets `runuser` pass them to the application account's `provision-instance.mjs` (it used to be `env NAME=value ... node`, which put all of them on the command line for the life of the step). The GitHub deploy-key token (`install.sh`), the Cloudflare token (`provision-ims-tenant.sh`) and the cron jobs' `CRON_SECRET` (the crontab lines the installer and the in-app scheduler write) reach `curl` on its standard input as a `-K -` config line instead of a `-H "Authorization: ..."` argument. A test (`tests/scripts/installer-secrets-argv.test.ts`) runs the shipped bootstrap block with stand-ins that record every command line, runs the RENDERED cron command from both the installer and the app renderer under `sh`, and scans every shell script under `scripts/` and the rendered output of the cron writers for the shapes that put a secret on an argument; it fails on any new one. Two sites remain and are listed in that test with their reasons: `pct create --password` in `provision-ims-tenant.sh` (the Proxmox tool has no other form; it is an operator tool, not the installer) and the unwired legacy `scripts/backup.sh`.

## Configuration Prompts

The installer asks for the following values during setup. Press Enter to accept the default shown in brackets.

**Re-running the installer keeps what the previous run configured.** Every prompt whose value is
written to `.env` defaults to the value already there, so an upgrade run accepting the defaults
re-writes the same configuration rather than the factory one. That applies to `REDIS_URL` and its
credential, `REDIS_KEY_PREFIX`, and to `AUTH_SECRET`, `CRON_SECRET` and `SETTINGS_ENCRYPTION_KEY`,
which are generated on a first install and never re-minted afterwards — re-minting
`SETTINGS_ENCRYPTION_KEY` would make every encrypted Setting already in the database (Xero tokens,
connector secrets) permanently undecryptable. Supplying a value explicitly — at the prompt, or as an
environment variable under `--non-interactive` — still overrides the preserved one, so rotation works
as before. A preserved credential is never echoed as the prompt default: the URL is shown redacted and
a preserved password is shown as `[unchanged]`.

**A `.env` the installer cannot read is not a `.env` with no secrets, and an absent one is not proof
of a fresh host either.** A path with nothing at all on it is a first install only when the host and
the database agree that it is — see *An absent `.env` is not permission to mint* below, which is the
o3d-xf9m gate. If `${APP_DIR}/.env` exists but is a directory, a dangling symlink, or
a file this process cannot open or read to the end, the installer **stops** rather than minting fresh
secrets over a live database. The same applies to a `.env` that was read but is missing any of
`AUTH_SECRET`, `SETTINGS_ENCRYPTION_KEY` or `CRON_SECRET`: this installer writes all three on every
run, so a file missing one was truncated or hand-edited, and minting a replacement for
`SETTINGS_ENCRYPTION_KEY` is irreversible. Restore the missing line from your backup or from the
running service's environment — or, if this really is a fresh start and the existing data is
expendable, re-run with `IMS_INSTALL_REMINT_SECRETS=yes`, which mints them and says out loud what it
just destroyed.

The **database password** is preserved on the same terms, with one extra condition: the
`DATABASE_URL` already in `.env` must name the same role, host, port and database this run will use.
Supplying a different one asks for a deliberate rotation, which happens inside the stopped, fenced
window — see *The database password is preserved, and a rotation waits for the fence* above.

The Turnstile site and secret keys and `INVOICE_PDF_STORAGE_DIR` are preserved: Enter keeps the pair already in `.env` (type `none`, or export `none`, to clear one -- a blank answer does not clear it), and an existing `INVOICE_PDF_STORAGE_DIR` is kept as is (it must be absolute; outside `/var/lib/one-two-inventory` it must already exist, be a real directory and be writable by the application account, or the run stops before `.env` is written).

**What a re-run does to `.env`.** The file is rewritten, but nothing in it is discarded silently:

* **Defaults come from the installed file** (Enter keeps them): the domain (from `NEXT_PUBLIC_APP_URL`), the
  port, the WooCommerce store URL, consumer key, consumer secret and **webhook secret** (a fresh webhook secret
  would break the signature check of every webhook WooCommerce is already sending), the Turnstile pair, and
  `INVOICE_PDF_STORAGE_DIR`. Typing a value changes it. **Only the WooCommerce four and the Turnstile pair can be
  cleared at the prompt**, by typing `none` (or exporting `none` for `--non-interactive`); a blank answer or blank
  export keeps the existing value. The domain and port are required, so they have no clearing form. The upload
  scanner settings (`FILE_SCAN_*`) and `INVOICE_PDF_STORAGE_DIR` are not prompted: the installer keeps what is in
  the file, and you change them by editing `.env` and restarting the service.
* **Only a short list of other settings is carried over, and only when the value looks like that setting.** A
  key of the old file that the installer does not set itself is copied into a `# Kept from the previous .env`
  block only if it is named on the list in `install.sh` (`ENV_PRESERVE_SHAPES`, one place) -- the non-secret
  settings this guide tells you to add by hand: `TRUSTED_PROXY_IPS`, `TRUSTED_PROXY_CIDRS`,
  `REQUIRE_TRUSTED_PROXY_CONFIG`, `BEHIND_PROXY`, `RATE_LIMIT_BACKEND`, `CSP_MODE`, `ALLOW_DATABASE_RESTORE`,
  `ALLOW_DATABASE_RESTORE_UPLOAD`, `PREFLIGHT_DB_CONNECT`, the `XERO_*` tenant and write-window settings,
  `WC_WRITES_LIVE_FROM`, `WC_WRITEBACK_ALLOWED_ORIGIN`, the `MINTSOFT_*` write and sweep settings, the
  `OUTBOX_RETRY_*`, `CONNECTOR_FETCH_*`, `FRESH_AUTH_MAX_AGE_SECONDS`, `INVOICE_PDF_TOKEN_*` and
  `DATABASE_RESTORE_MAX_FILE_BYTES` limits -- (exact, case-sensitive names) **and** its value has the shape that
  setting can have -- the format the application itself parses that setting from: a switch (`1 true yes on 0 false no off`, any
  case, as the application reads them), a number, a comma-separated list of IP addresses or CIDRs, a comma-separated list of
  Xero tenant ids (UUIDs), organisation names, an origin, an ISO-8601 UTC instant with a `Z`, the `<base URL>|<ClientId>`
  Mintsoft grant, `memory`/`redis`, `enforce`/`report-only`/`off`; bounded length, closed character set, one line, **and** it passes the admin-secret
  screen below. The WooCommerce credentials and webhook secret, the Turnstile pair, the scanner settings, the
  domain, the port and the invoice directory are the installer's own keys and are kept by their prompts.
* **Everything else is dropped from the new file, and said so.** Any other key -- an unlisted name, a listed
  name with a value that does not fit, a secret, a database URL, a base64, hex or layered-percent-encoded blob,
  `export KEY=v` spellings of any of these -- is not written to the new `.env`. The summary lists each dropped
  key by name, line number and reason (never the value). Nothing is lost: the whole old file is in the backup
  below. An operator who needs a dropped setting copies the line back by hand, or asks for the name to be added
  to the list. `DEPLOY_ADMIN_*` / `*ADMIN_DATABASE_URL` keys are refused outright, before anything is changed
  (they belong in `/etc/ims-db-admin/deploy-admin.env`).
* **A security setting that cannot be carried stops the run.** The listed settings that tighten behaviour --
  the trusted-proxy settings, `REQUIRE_TRUSTED_PROXY_CONFIG`, `RATE_LIMIT_BACKEND`, `CSP_MODE`, the database-restore
  switches, `PREFLIGHT_DB_CONNECT` (without it the production preflight skips the database and schema checks), the connector, restore and shopping-webhook size and time limits, `XERO_ACCOUNTING_OUTBOX_ENABLED`, the `XERO_*` tenant allowlists and write grants, `MINTSOFT_WRITE_ALLOWED` and the connector write windows,
  `WC_WRITEBACK_ALLOWED_ORIGIN`, the fresh-auth and invoice-token lifetimes -- are never dropped silently, because
  dropping one loosens a control (a proxied production would get a preflight warning where it used to get a failure).
  If one is present and its value is not in a form that setting accepts, or fails the admin-secret screen, the run stops
  in the configuration phase, before anything is changed, naming the key and never the value: *`<KEY>` is a security
  setting that this installer cannot carry across to the new file ...*. Correct or remove it and re-run. The value is read
  the way the application's dotenv loader reads it (CRLF removed, one pair of surrounding single or double quotes
  stripped, an inline `# comment` ignored, `export` accepted) and is written to the new file in one canonical unquoted
  form that means the same.
* **The in-tree `.env.bak*` files of earlier installer versions are left alone** by the source sync.
* **A file the installer cannot reproduce is not rewritten.** A line that is not `KEY=VALUE` (also read: `export
  KEY=value`, `KEY = value`, and quoted values that span several lines), or a quoted value that is never closed,
  stops the run in the configuration phase, before any package, account or file is touched, naming the line
  numbers.
* **A backup is written first, and it is root-only**: `/etc/ims-db-admin/previous-app-env-<UTC timestamp>-<pid>-<n>`,
  mode 600, owned by root, in the directory (root, 0700) that already holds the admin credential, and therefore
  outside the application tree where the application account can neither read nor replace it. It is the old file
  verbatim, made from the lines the run read at its start. The name is created exclusively, so two runs in the same
  second cannot replace each other's backup and a name planted by another account is skipped, never written
  through. The installer never prunes backups: they hold secrets, so delete old ones yourself.
* **It says what it did**, by key name only (never a value): the backup path, the keys kept, the values this
  run changed, the keys it added, and every key that was not carried over and why.
* **The screen needs a password worth screening against.** If the deploy admin password is shorter than 8 characters and the old file holds settings the installer does not set, the run stops in the configuration phase, before anything is changed, with: *the deploy admin password is too short to screen preserved settings against; set a password of at least 8 characters or remove the extra settings and re-run.* For the listed settings the screen runs a bounded fixed-point decoder: every decoder (percent, `+` as a space, hex, base64, base64url, padded or not) is applied to the value, to each comma/space/semicolon/pipe-separated token of it, and to every result, in any order, to a depth of 10 layers and 64 KiB of decoded output; the decoded admin password (and its percent-encoded forms) is searched for in every layer. A value that is still decodable when a bound is reached is refused (for a security setting that stops the run), as is a value that still contains a percent-escape after the passes or is longer than 4096 bytes. Because an encoding can also sit INSIDE longer text, every layer is also searched (case-insensitively) for the admin password under any composition, up to three deep, of percent (unreserved characters kept, or every byte), plus-for-space, hex, base64 and base64url at all three byte alignments (only the characters wholly inside the password are used), a set of a few hundred strings of at least 8 characters and bounded at 2000 (a value that would need more is refused). Organisation-name lists are also limited to 120 characters in total. Ordinary names such as `OneTwo3D Ltd` or `Acme-Widgets` are carried; the name, URL and role rules apply whatever the password's length.

Not preserved across a re-run, because they are not in `.env`: the SMTP values (they seed the settings
table once) and the database host, port, name and user (supply them again, or as environment variables).

### Application
- **Domain name** — the hostname for your installation (e.g. `ims.yourdomain.com`)
- **Internal port** — the port the app listens on (default: `3000`)
- **Default admin name/email/password** — optional bootstrap admin user for unattended installs. Leave the email blank to skip creating one (the password is then not asked for and is ignored); the installer still seeds the public URL and any SMTP and WooCommerce settings you gave it.
- **Notification email** — optional recipient for the bootstrap credentials email

After installation, sign in and set the organisation base currency in **Settings > Company** before entering live transactional data. The base currency is intended to be set once for a new system. Changing it later requires a database reset.

### Database
- **Install PostgreSQL** — install on this server, or connect to an external database
- **Database name** (default: `one_two_inventory`)
- **Database user** (default: `imsuser`)
- **Database TLS mode** (`DB_SSLMODE`, default: `disable`) — asked only for an **external** database.
  `disable`, `require`, `verify-ca` or `verify-full`; the last two also ask for
  **`DB_SSLROOTCERT`**, the CA the server's certificate is verified against. It is recovered from
  the previous run's `DATABASE_URL` on an upgrade, so an existing TLS-only installation stays on
  TLS when the prompts are accepted, and the certificates in it are parsed and republished to
  `/etc/ims-db-ca/db-ca-<sha256>.crt` so
  the service account can read the same trust root the probes used. Under `--non-interactive` both
  are read from the environment, where a supplied value beats the recovered one. See
  *TLS: `DB_SSLMODE`* above for what each mode means, how the CA is published and refreshed, and why
  an ambient `PGSSLMODE` is refused instead.
- **Database password** — on a first install, auto-generated if not provided. On a re-install it
  defaults to the credential already in `${APP_DIR}/.env`, so accepting the default changes nothing
  about the role. Entering a different one requests a rotation, performed only after the existing
  installation has been stopped and the database fenced.

### Redis
- **Install Redis on this server** — install and configure a local Redis, or point at one you already run
- **Redis URL** (default: `redis://localhost:6379`) — only asked when Redis is not installed here
- **Redis password** — leave blank if not required
- **Redis key prefix** — optional namespace for Redis-backed features

The password you enter is placed **inside `REDIS_URL`**, percent-encoded, and the `REDIS_PASSWORD`
line in `.env` is left empty. `REDIS_URL` is what the application authenticates with; a password that
reaches only `REDIS_PASSWORD` never reaches `AUTH`, and because the login rate-limit buckets fail
closed, a Redis answering `NOAUTH` does not look like a Redis fault — it looks like nobody can sign in.
This applies to both branches: a locally installed Redis, and a Redis you already run.

If the `REDIS_URL` you supply already carries a credential of its own, it is left exactly as you typed
it and a password entered at the prompt is ignored with a warning — the URL wins, and an operator's
connection string is never rewritten. "Already carries one" means an `@` in the **authority** — the
text between `://` and the first `/`, `?` or `#` — where an `@` can only be the userinfo separator. An
`@` further along, in a path or a query string, is none of the installer's business and does **not**
stop your password being placed in the URL.

If the authority is neither of those things — neither a `host[:port]` nor something carrying a
credential — the installer **stops**. That shape is what an unencoded `/` inside a password looks
like (`redis://:pa/ss@host:6379`, whose authority reads as `:pa`), and it cannot be told apart from a
malformed host: guessing one way splices a *second* credential in front of yours, and guessing the
other drops your password entirely. Percent-encode the password inside `REDIS_URL` (a `/` is `%2F`)
and leave the Redis password prompt blank, or give a plain `redis://host:port[/db]` and let the
installer place the password. The port, if present, must be numeric — that is what makes the two
readings distinguishable at all.

If you supply a password alongside a `REDIS_URL` with no `://` at all, the installer stops rather
than proceeding with a password it cannot place.

For a locally installed Redis, the same password is written to `/etc/redis/redis.conf` as a quoted
`\xHH` string literal, built from the same byte-by-byte walk as the URL encoding. `redis.conf` is
parsed by redis's own `sdssplitargs()`, which splits on whitespace and opens a quoted section on a
quote character anywhere in a token, so a password containing whitespace, a quote or a backslash cannot
be written into it literally — the server would either refuse to start or require different bytes than
the client sends.

### WooCommerce (Optional)
- Store URL, consumer key, consumer secret, webhook secret
- Can be configured later in Settings
- The store URL is a **seed**: the installer writes it into the `wc_url` setting once, and
  **Settings > Sync > Connection** owns it from then on. The three secrets are **overrides** —
  while they are set in `.env` they win over anything saved in the UI

### Xero (Optional)
- Client ID and client secret
- Can be configured later in Settings

### Cloudflare Turnstile (Optional)
- Site key and secret key for the login-page challenge (`NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`)
- On a first install, leave both blank (the default, and what `--non-interactive` uses when they are not exported) to keep the challenge disabled; on a re-run the existing pair is the default and `none` clears it; they are collected up front with the other prompts and written to `.env` either way

### Outbound Email (Optional)
- SMTP host, port, username, password, transport security
- From name, from email, reply-to
- Required if you want the installer to email the generated login details automatically

### nginx & SSL
- **Configure nginx** — set up the reverse proxy (default: yes)
- **Enable SSL** — obtain a Let's Encrypt certificate via certbot


## Directory Structure

| Path | Purpose |
|---|---|
| `/opt/one-two-inventory` | Application root directory |
| `/opt/one-two-inventory/.env` | Environment configuration (chmod 600) |
| `/var/lib/one-two-inventory/backups` | Runtime backup storage directory used by backup create/restore/upload flows |
| `/var/lib/one-two-inventory/invoice-pdfs` | Accounting connector invoice PDFs served through signed invoice links |
| `/var/lib/one-two-inventory/uploads` | Private uploaded files served through authenticated routes, such as supplier invoice PDFs |
| `/var/lib/one-two-inventory/public-uploads/branding` | Logo and branding images served through `/api/uploads/branding/*` |
| `/var/lib/one-two-inventory/public-uploads/avatars` | User avatar images served through `/uploads/avatars/*` |
| `/var/lib/one-two-inventory` | Persistent data directory |
| `/var/log/one-two-inventory` | Application logs |

Container deployments must set `UPLOAD_STORAGE_DIR`,
`PUBLIC_UPLOAD_STORAGE_DIR`, and `INVOICE_PDF_STORAGE_DIR` to mounted
persistent volumes. If an upload storage variable is unset in production, IMS
logs a warning and falls back to local development paths under the application
working tree, which may be ephemeral in containers. Production preflight fails
when `INVOICE_PDF_STORAGE_DIR` is unset because signed invoice links depend on
persisted connector-downloaded PDFs.
Create `/var/lib/one-two-inventory/invoice-pdfs` during deployment with the same
owner as the IMS application process and restrictive permissions, for example
`chown app:app /var/lib/one-two-inventory/invoice-pdfs` and
`chmod 750 /var/lib/one-two-inventory/invoice-pdfs`. Connector PDFs are usually
re-fetchable from the accounting connector, so they do not need the same backup policy
as the database, but include the directory in operational snapshots if customer
invoice links must remain available during connector outages. Plan disk capacity
for roughly 50-500 KB per invoice PDF; 100,000 invoices can consume about
5-50 GB. Pre-release files under the old local `data/invoices` path are not
migrated by IMS because production installs are not live yet.
Customer-facing invoice buttons in shopping platforms do not receive reusable
IMS public PDF URLs. The shopping platform must first verify the logged-in
customer owns the order, then call IMS server-to-server with a short-lived
HMAC-signed request to `/api/shopping/{connector}/invoice-pdf`. For WooCommerce,
the bundled helper plugin adds the My Account button and signs that request with
a dedicated `WC_INVOICE_PDF_SECRET` value. Do not reuse `WC_WEBHOOK_SECRET`
for invoice PDF requests. The helper plugin also requires an admin-configured
HTTPS IMS base URL and constructs the fixed IMS invoice endpoint itself; IMS
only writes `_ims_invoice_pdf_available=yes` to the order, never a per-order URL
for the plugin to follow.
Branding upload URLs include a unique filename per upload so browser and CDN
caches do not depend on query-string cache keys. Avatar URLs preserve the
historical `/uploads/avatars/*` path and rotate a `?t=` cache-busting query
string on upload; configure any CDN in front of avatar assets to include query
strings in its cache key.

Invoice PDF scanning is disabled by default. Set `FILE_SCAN_MODE=command` and
`FILE_SCAN_COMMAND_ARGV='["clamdscan","--no-summary","--fdpass","{file}"]'` to
enable fail-closed scanning. IMS writes uploaded PDFs to
`$UPLOAD_STORAGE_DIR/quarantine/invoices`, runs the command against the
quarantined path, and moves the file to `$UPLOAD_STORAGE_DIR/invoices` only when
the scanner exits `0`. Exit `1` (signature match) rejects the upload as infected
(`400`); any other outcome — exit `2+`, spawn error, or timeout — fails closed
and rejects the upload as a scan failure (`503`). Rejected quarantine files are
deleted by default for disk hygiene; the activity log records scanner mode,
status, reason, exit code, signal, and scanner identifier without scanner output
or filesystem paths.

Use the ClamAV **daemon** client `clamdscan`, not the standalone `clamscan`.
`clamscan` reloads the full (~110 MB+) signature database on every invocation
(typically several seconds per scan), which can exceed the 5-second scanner
health-check budget and fail the preflight; `clamdscan` reuses the resident
`clamd` over its socket, so scans are effectively immediate. Pass `--fdpass` so
the IMS-spawned `clamdscan` opens the quarantine file (owned `0600` by the IMS
service user) and hands the descriptor to `clamd`, which otherwise runs as the
`clamav` user and could not read it by path. A full deployment and
operational-response runbook — install, signature updates, verification, and the
handling of infected / timeout / scanner-unavailable outcomes — is in
[docs/ops/invoice-pdf-malware-scanning.md](ops/invoice-pdf-malware-scanning.md).

Scanner commands run without a shell. Prefer `FILE_SCAN_COMMAND_ARGV` when an
argument contains spaces or empty values. The scanner process receives only the
environment variables listed in `FILE_SCAN_ENV_ALLOWLIST`, which defaults to
basic process/runtime variables such as `PATH` and `TMPDIR`; application secrets
such as `DATABASE_URL` and `AUTH_SECRET` are not inherited. The admin health
endpoint runs a short scanner smoke check in command mode so misconfigured
scanner commands are visible before the first invoice upload.

Before starting or rolling a production instance, run:

```bash
NODE_ENV=production npm run preflight:production
```

The preflight checks required secrets, production URLs, PostgreSQL URL shape,
explicit persistent storage paths, writable upload/backup directories, scanner
policy and command health, trusted proxy configuration when
`REQUIRE_TRUSTED_PROXY_CONFIG=true`, and database-restore kill switches. Set
`PREFLIGHT_DB_CONNECT=true` during production rollout when the preflight process
can reach Postgres; this adds a short `SELECT 1` connectivity probe. It prints
variable names and status messages only; it does not print secret values.


## Application Service Management

Current installs run the application as a native systemd service named
`one-two-inventory.service`. Older deployments may still have PM2 installed, but
PM2 is not the current process manager for new installs.

### Common Commands

```bash
# View process status
systemctl status one-two-inventory.service

# View live logs
journalctl -u one-two-inventory.service -f

# Restart the application
systemctl restart one-two-inventory.service

# Stop the application
systemctl stop one-two-inventory.service

# Start the application
systemctl start one-two-inventory.service
```

The service is configured with:
- Automatic restart on crash
- Logs available through journald
- Boot persistence through systemd


## Cron Jobs

Scheduled tasks are configured automatically, in two ways. The installer's bootstrap crontab carries `account-balance-snapshot`, `fx-rates`, `activity-cleanup`, `backup`, `wc-reconcile`, `delivery-status`, `refund-reservation-release` and `wc-withdrawal-sweep`. Every other job below is a registered scheduled job (`lib/cron-jobs/`): it reaches the crontab when the in-app scheduler writes its managed block, so on an installation that already has one it is scheduled after **Settings > System > Scheduler > Save & Apply** (see "The installer bootstraps, it does not reconcile" below), and Settings shows whether each is switched on.

| Time | Endpoint | Purpose |
|---|---|---|
| 00:30 | `/api/cron/product-lifecycle-archive` | Archive EOL products once all warehouse stock and incoming supply are depleted |
| 01:00 | `/api/cron/account-balance-snapshot` | Fetch previous-day Xero Trial Balance account balances for GL variance reporting |
| 02:00 | `/api/cron/backup` | Scheduled backup (if enabled in settings) with retention and remote upload |
| 03:00 | `/api/cron/activity-cleanup` | Purge activity log entries past their retention period |
| 04:00 | `/api/cron/wc-reconcile` | WooCommerce backup reconciliation for orders/products plus stock retry draining |
| Every 15 min | `/api/cron/delivery-status` | Poll delivery tracking providers for shipment status updates |
| Every 15 min | `/api/cron/wc-withdrawal-sweep` | Durable backstop: re-check WooCommerce orders refused as EU withdrawals, so one whose request was rejected back to a status the poll does not query is still imported. Also screens a rotating slice of already-pushed, dispatch-eligible orders against the storefront, so a withdrawal whose webhook was missed is known locally before the warehouse's despatch is reconciled |
| Every 15 min | `/api/cron/refund-reservation-release` | Durable backstop: re-run allocation to release stock reservations for refunded units when the immediate post-refund release was bypassed or lost |
| Every 5 min | `/api/cron/mintsoft-webhook-sweeper` | Drain persisted Mintsoft ASN booked-in webhook events; also drains the post-maintenance re-check marker (`wms_booked_in_recheck_due_since`) by re-checking every open ASN after a maintenance window closes |
| Every 5 min | `/api/cron/shopping-webhook-inbox` | Process persisted WooCommerce webhook events, and retry queued WooCommerce **order completions**: the `completed` push (tracking first) that follows an IMS or warehouse shipment, and the `cancelled` / `on-hold` pushes that follow an operator cancelling or holding an order in IMS. Each is an `integration_outbox` row (`woocommerce/order.complete`, `order.cancel`, `order.hold`) written in the order's own transaction; it is retried with back-off (8 attempts, about four hours) and then lands in **Sync > Exceptions** where **Replay** re-reads the storefront order. A cancel/hold whose sender died mid-attempt is parked there after about 10 minutes. Runs whenever the WooCommerce plugin is enabled, even if inbound sync is off |
| Every 15 min | `/api/cron/mintsoft-dispatch-sync` | Poll pushed Mintsoft orders for despatch and progress the IMS shipment + tracking. A registered job, on by default; it only reads from Mintsoft, does nothing while the Mintsoft plugin is off, and has nothing to poll until IMS has pushed an order. **It never logs in:** with a fixed API key (in the Mintsoft connection settings) it runs; in username and password mode it runs on the stored key and, once that has expired, skips with a reason, because a login (`POST /api/Auth`) replaces the tenant API key for every integration sharing it. Use a fixed API key for an unattended poll. Not in the installer's bootstrap list: see below |
| 06:00 | `/api/cron/fx-rates` | Fetch latest exchange rates from frankfurter.dev |
| 03:00 (default; **off** by default) | `/api/cron/reconciliation-pack` | Run the whole reconciliation pack (`npm run reconcile:pack`) as a child process and record the run in the activity log. Off until an operator switches it on **and** sets a phase; contacts no vendor unless a second option is also on. See "Scheduling the pack" in the reconciliation pack section |

**Whether the service user needs the `crontab` group depends on one line in your unit.** `/usr/bin/crontab` is setgid (`-rwxr-sr-x root crontab`) and the spool directory is `drwx-wx--T root crontab`, so the binary reaches the spool through the group its setgid bit confers — and on an ordinary unit that transition works, so **no group grant is needed**. The units `scripts/install.sh` generates are in that category: they do not set `NoNewPrivileges`, and the setgid transition carries them. A hardened unit sets `NoNewPrivileges=true`, and that makes the kernel **ignore setuid/setgid bits on exec** — so `crontab` runs as the plain service user and fails with `Permission denied` on `crontab -l` *and* `crontab -`. `deploy/systemd/ims-stage.service` therefore carries `SupplementaryGroups=crontab` and (because `ProtectSystem=strict` also makes `/var` read-only) `ReadWritePaths=/var/spool/cron/crontabs`. `NoNewPrivileges=true` stays: a supplementary group is granted by systemd before the exec, not gained by it. Without those two lines the failure is loud rather than silent — the read fails closed, the crontab is left untouched, and the save reports that the scheduler is behind — but the Scheduler is unusable. If you run the application under a unit of your own, **the two directives answer two independent questions.** `SupplementaryGroups=crontab` is needed only when the unit sets `NoNewPrivileges=true`; without that line the setgid transition already supplies the group, and adding it anyway hands the whole service process direct spool access to buy something it already has. `ReadWritePaths=/var/spool/cron/crontabs` is needed whenever the unit sets `ProtectSystem=strict` (or otherwise makes `/var` read-only), **regardless of `NoNewPrivileges`** — setgid confers the group, not the ability to write through a read-only mount, so a strict unit without this line has the right group and still fails. Check both lines separately; a unit that sets neither hardening directive needs neither grant.

**A write that exits 0 is confirmed by reading it back.** `crontab -` exiting 0 says the command was issued, not that the schedule exists. The sandbox is *not* what this catches: a unit that cannot reach the spool fails the read the application performs **before** the write and stops there, so it never spawns `crontab -` at all. What this catches is a write accepted over a spool that holds something else — a writer outside the application's lock (`crontab -e` by hand, a configuration-management run, an edit to the spool file as root), or a `crontab` on `PATH` that is not the client you think it is. After a successful write the application re-reads the crontab **while still holding the lock** and compares the managed block against what it wrote. A block that does not match, and a read-back that does not resolve at all, are both reported as a failed reconciliation: the write is not finished until it is confirmed, so "unconfirmed" and "wrong" get the same answer. The recovery — Settings → System → Scheduler → Save & Apply — is idempotent, so the cost of being told this over a crontab that was in fact correct is one repeated save.

**One writer at a time.** The managed crontab block has two writers — the application (Settings → System → Scheduler, and every settings save that affects a schedule) and this installer — and both take the same host-local `flock` on `/etc/ims-cutover-state/locks/.crontab-reconcile.lock` before touching it. The application holds it across the whole read-modify-write (read the `cron_*` settings → read the crontab → write it) and hands the lock descriptor to the `crontab -` child, so the exclusion covers the write even if the app process dies mid-rewrite; the shell side takes it through `with_crontab_lock` in `scripts/lib/crontab-lock.sh`, which flocks the descriptor `prepare_crontab_lock` opened when it proved that file's identity, and releases it with `flock --unlock` at the end of the read-modify-write rather than by closing it.

**And that path moved, in this release, out of the service's state directory** (o3d-txoe). It used to be `${DATA_DIR}/locks/.crontab-reconcile.lock`. A mutual-exclusion primitive has two parties and the only property that matters is that they name the **same inode** — and `${DATA_DIR}` is the systemd `StateDirectory`, which systemd creates **owned by the service user** and which has to stay writable by it. `rename(2)` asks for write permission on the **parent** and asks nothing at all about the directory being moved, so that account could move the root-owned `locks` directory aside and leave its own at the name; each party then locked whatever inode it found when it opened the path, both reported exclusion, and the loser's schedule was discarded after being reported as saved. The lock now lives beneath `/etc/ims-cutover-state` — the root-owned cutover namespace that already holds the shared cutover lock and the connection-fence authority — where every component of the path is root-owned and writable by nobody else, so **no account but root can change what that pathname means**. Both writers derive it from the same three pieces: the application from `CRONTAB_RECONCILE_LOCK_ROOT` in `lib/crontab-reconcile-lock.ts`, and each entrypoint from its own `readonly CUTOVER_ROOT_DIR="/etc/ims-cutover-state"`. `ProtectSystem=strict` makes `/etc` read-only for the service and that is sufficient: `flock(2)` locks the open file description whatever its access mode, the lock file is root-owned `0644`, and the application opens it **read-only**. To see who holds it: `fuser -v /etc/ims-cutover-state/locks/.crontab-reconcile.lock`.

**The lock must be OPENABLE by the service account, and the installer now checks that by trying it as that account.** `0644` is not decoration: the application takes its half of the exclusion by opening that file read-only, so a lock file the service user cannot open leaves the *privileged* side able to rewrite the crontab while **every** application reconciliation is refused — and a schedule an operator saved, and the database has already committed, is then never projected into the crontab while every page reports it enabled. A root-owned `0600` lock file, which is what any privileged run under a `077` umask leaves behind, produced exactly that. So on every install, deploy and update the preparation asks whether `${APP_USER}` can open the file **by attempting it as that account** — not by comparing the mode bits, because a POSIX ACL can withhold read from a `0644` file and grant it on a `0640` one, and the bits cannot see either. If the answer is no, the file is widened to `0644` (an `fchmod` of the descriptor already proved, so no pathname is resolved again), the question is asked **again**, and a warning says what was widened and why. If it still cannot be opened — an ACL that withholds it, a read-only mount, an immutable attribute — the run **refuses** and names the file: those are states a privileged run cannot repair, and proceeding would ship a scheduler that has silently stopped working. The same question is asked of the pre-relocation lock during the rollout window, where it *declines the bridge* instead of ending the run, because the canonical exclusion is unaffected by anything at that path.

**What that costs, stated rather than glossed over:** the lock file is world-readable, so any local account can open it and hold the `flock`, which delays a cutover by up to `IMS_CRONTAB_LOCK_WAIT_SECONDS` and is then reported as a refusal that names the file. That is deliberate and it is the price of the application being a party to the exclusion at all — it is the trade the *cutover* lock (`/etc/ims-cutover-state/cutover.lock`, `0600`) declines, because no unprivileged process is meant to hold that one.

### The first run after the crontab lock moved

**Moving a lock is also a way to lose one, so read this before the first cutover of this release on an existing host.** The process serving that host was built before the relocation and goes on resolving `${DATA_DIR}/locks/.crontab-reconcile.lock`. What the release does about it, and what it does not:

* **The entrypoints take BOTH locks while the old one is there.** `prepare_crontab_lock` pins the new location and then, if `${DATA_DIR}/locks/.crontab-reconcile.lock` exists **and** that directory is one only the privileged run may write, pins that one too; `with_crontab_lock` holds the old one outside the new one for every crontab read-modify-write. So a predecessor-build reconciliation and a successor-build cutover still exclude each other during the rollout. The order is fixed (old outside, new inside) and cannot deadlock: a predecessor takes only the old one, an application on this build takes only the new one.
* **Where that precondition does not hold, the run says so and takes nothing.** If an older release handed `${DATA_DIR}/locks` to the service account, a lock taken on a name inside it proves nothing — the entry can be renamed between the predecessor's open and this run's — so nothing is opened, nothing is created, and the run prints a warning naming what is **not** excluded. On such a host, restart the service onto this build before anything changes the crontab.
* **The bridge is a continuity measure and not a security boundary, and it is not written down as one.** `${DATA_DIR}` belongs to the service account, so an account that is actively attacking can still rename that directory aside. The new location is what defends against that account; the old one is only there so an honest predecessor is not left out.
* **A fresh install creates nothing at the old location**, and the bridge is skipped. Nothing has to be migrated: the new lock file is created by the first privileged run.
* **When the rollout is finished you may remove the old location.** Once every host is on this release, `rm -rf ${DATA_DIR}/locks` on each of them ends the bridge; until then the only cost is one extra `flock` per crontab read-modify-write. The installer's recursive ownership change over `${DATA_DIR}` still **prunes** that directory by name, so it stays root-owned and the bridge keeps working if you leave it.
* **And the pre-relocation lock has to be openable by the service account too**, or there is nothing to bridge to: a predecessor that cannot open its own lock is already refusing every reconciliation for the same reason. The run repairs it the same way, asks again, and where it still cannot be opened it declines the bridge and says so.
* **What is NOT covered, stated plainly.** A predecessor built before the shared lock existed at all takes a PostgreSQL advisory lock or nothing, and no flock reaches it. That was already true before this release, and it is why all three entrypoints fence the crontab **after** `systemctl stop` and after the port is proved free.

**All three entrypoints are in it, not just the installer** (o3d-p9dq). `scripts/deploy.sh` and `scripts/update.sh` fence, adopt, unfence and unwind the same crontab around their own cutovers, and until this round none of those read-modify-writes took the lock. They now source the same library, compose the same path from the same root-owned cutover namespace, and prepare the same root-owned lock file — which matters on a host installed by an older release, where the lock file does not exist yet. Since o3d-p9dq round 30 **none of the three scripts invokes the `crontab` client at all**: every read goes through `read_crontab_for` and every write through `write_crontab_for`, both in `scripts/lib/crontab-lock.sh`, and every call to either sits in a `*_locked` function whose only caller is `with_crontab_lock`. `tests/settings/crontab-reconcile-serialization.test.ts` walks the repository and fails on the first one that does not.

**The fence is taken after the stop, and that ordering is doing work the lock cannot do.** Commenting the crontab out is itself a read-modify-write: read the crontab, back the reading up verbatim, write a commented-out copy, restore the backup later. Run while the application is still serving, a schedule an operator saves between the snapshot and the replacement lands in a crontab the cutover is about to overwrite and is absent from the backup it will restore — the settings rows and the UI go on reporting the job enabled and nothing runs it. The flock does not close that on its own the first time it ships: the predecessor was built before the flock existed and excludes itself some other way, so an flock taken there would serialise the script against nobody. The only exclusion that reaches that process is that it is not running, so all three entrypoints now fence the crontab **after** `systemctl stop` and after the port is proved free (`update.sh` gained that port proof for this reason), and still before the database drain probe. The `unfence` at the other end is the opposite case — the application is up, and it is up on **this** build, so it does participate in the flock and the lock alone is sufficient there. `--dry-run` is the one documented path that does not take the lock: it is unprivileged by design and every crontab body it reaches returns after printing what it would do and before any write.

**Putting the crontab back is a MERGE, and every read it rests on fails closed.** Exclusion establishes the ORDER two writers take; it does not establish which of their two versions is TRUE. Between the moment the new build starts serving and the moment the cutover unfences, an operator can save a schedule: the application takes the same flock, writes the block it projected from the committed `cron_*` rows, releases, and correctly reports success. A cutover that then installed the snapshot it took before the stop would be a perfectly ordered write of stale content — the rows say enabled, nothing is scheduled, and no error appears anywhere. So the restore decides rather than copies. If the live crontab is *exactly* the fence's own projection of the backup, nothing wrote and the backup goes back verbatim. Otherwise the fence is undone **where it was applied** — the live crontab minus the fence marks — which carries forward the managed block a reconciliation wrote and any line an operator added; and that candidate is accepted only if every unmanaged line of the backup still appears in it *as an ordered subsequence with the same number of occurrences*, because two identical entries run the job twice and `PATH=`, `SHELL=`, `MAILTO=` and `CRON_TZ=` apply only to the entries below them. If a line is missing or has moved, nothing is installed: the crontab is left fenced, the backup is left on disk, and the message names the lines. **An unclosed managed-block marker does not make the rest of the file managed** (o3d-p9dq, Codex r29): it means the block's extent is *unknown*, and within the malformed region only the marker, a stray END and lines positively identified as our own generated output are treated as managed — everything else stays an operator line and is counted by this check. That is the same bounded rule `lib/crontab-sync.ts` applies when it strips blocks, so a line the application would preserve is a line whose disappearance the restore refuses to call lossless; the shell loss check and the installer's bootstrap now share one awk source (`CRONTAB_MANAGED_BLOCK_AWK`) rather than keeping two hand-maintained copies of it. **A deletion is a write.** A crontab that has only *lost* lines since the snapshot is somebody having stopped a job on purpose, and restoring the backup over it would schedule that job again — so it takes the same refusal rather than a silent restore.

Every `crontab -l` in all three entrypoints goes through one reader, `read_crontab_for` in `scripts/lib/crontab-lock.sh`, and a read that cannot be resolved is **never** treated as an empty crontab. This matters because exit status alone cannot tell the cases apart: on the Vixie cron every supported platform ships, "this user has no crontab", "no such user" and "not privileged to use `-u`" all exit 1 with no output. The reader captures the diagnostic and resolves an absence *only* from the message that states one — `no crontab for <that user>`, matched whole, with nothing on stdout. Anything else stops the step that asked. At the fence that means the run **aborts before the connection fence and before the migration**, because a crontab that cannot be read is not a crontab with nothing in it and the entries it holds would otherwise be live over a moving schema; at the unfence it means the snapshot is not installed; on the resume path it means the interrupted run's backup is not installed; and in `upgrade_in_place` it means the installer refuses rather than guessing whether this host is a first install (guessing wrong in one direction migrates a live installation, in the other it stops and fences a box with nothing on it).

**And a crontab write that was REJECTED is not a crontab that was written** (o3d-p9dq, Codex r30). The reads were made to fail closed a round before the writes were, and the reason the gap survived review is worth stating because it is not visible at either site. `with_crontab_lock` runs its body as `"$@" || rc=$?` — it has to, because callers must be able to tell a lock it could not take from a write that failed — and a command on the **left of `||` runs with `errexit` suspended for its whole dynamic extent**, every line inside the called function included. The lock wrapper therefore disarmed error propagation inside all fifteen `*_locked` bodies at once, and the two writes that carried no explicit check stopped being covered by `set -e` without a word changing at either of them. A rejected fence write then set `CRON_FENCED=true`, printed *"Cron writers fenced."*, returned 0 — and the run took the connection fence and ran the migration **with the original schedule still live**. The unfence was the mirror image and worse: a rejected write was followed by `rm -f` of the crontab backup, the only copy of the operator's schedule, and by `CRON_FENCED=false`, which tells the unwind there is nothing left to put back.

Every write now goes through `write_crontab_for`, which takes its content as an **argument** rather than on stdin (a pipeline element is a subshell, so a piped writer would set its diagnostic in a child and the caller would read an empty string), captures the client's stderr, and returns non-zero with a reason. **The ordering is as much of the fix as the check**: at every call site the status is taken *before* any flag is set, any backup is deleted and any success line is printed. A rejected fence aborts the run before the connection fence and the migration, leaving `CRON_FENCED` false, the crontab as it was and the backup on disk; a rejected unfence returns its own status (`77`, distinct from `75` lock-conflict and `76` divergence) so the message says the write was rejected rather than blaming a lock the run did hold, keeps the backup, and prints `crontab -u <service user> <backup>` for a human. The wrapper cannot stop suspending `errexit` — it must run the body in the current shell, because `CRON_FENCED`, `CRON_BACKUP_CREATED` and `CRON_UNFENCE_TEXT` are set inside it and read by the unwind, and it must return the body's status — so the roster of `*_locked` bodies is **pinned by test** instead: adding a sixteenth fails `tests/settings/crontab-reconcile-serialization.test.ts` with the rule its author needs to read.

**And a computation that could not be run is not an answer of "nothing"** (o3d-p9dq, Codex r31). The same suspension reaches further than the writes. `plan_crontab_unfence` — the function that decides whether the backup goes back verbatim, whether the fence is merely undone in place, or whether neither is safe — is invoked by every caller as `plan_crontab_unfence … || return`, and that `|| ` at the *call site* suspends `errexit` for every line inside it just as the lock wrapper does. It held three command substitutions whose statuses nothing took: the fence projection of the backup, the unfence projection of the live crontab, and the comparison that asks which of the backup's unmanaged lines a merge would drop. An `awk` that is missing, killed by the OOM reaper or denied by seccomp made all three empty; the empty comparison was read as *"the merge loses nothing"*, the plan text was set to the empty projection, and the caller **installed an empty crontab and then deleted the backup** — the only copy of the schedule it had just erased. Worse than the rejected write it descends from: a rejected write installs nothing, a failed computation installs an emptiness the writer accepts.

**Taking the status is not enough on its own, and that is the whole difficulty here.** *"Produced no output"* is a **legitimate answer** at both sites: a crontab may genuinely be empty, and a subsequence check may genuinely find nothing missing. Failure therefore cannot be represented as emptiness, because emptiness is already taken — the same problem `read_crontab_for` solves by separating *"empty crontab"* from *"no crontab"*, and `port_listener_census` by refusing to read a failed `ss` as an absent listener. So each computation now establishes its success **positively**. The projections are line-for-line transforms — the fence prefixes each active line, the unfence removes that prefix, neither adds or drops one — so their output is accepted only when it holds exactly as many lines as the input did; an `awk` that exits 0 having printed nothing fails that, while the projection of a genuinely empty crontab (nought lines in, nought lines out) passes it. The subsequence check prints a **completion sentinel** as the last thing its `END` block does, which the shell strips again, so *"nothing is missing"* now arrives as the sentinel alone and a check that died part-way through arrives without it. Both projections use a here-string rather than a pipe, so the status is one command's and does not depend on whoever sourced the library having `pipefail` set.

A failed computation returns **`78`**, its own status alongside `75` lock-conflict, `76` divergence and `77` rejected write, and it is forwarded through the entrypoints rather than folded into the divergence they already knew about — because the two send the operator to different places. A divergence says *compare these two crontabs and install the union*; a failed computation has no two candidates to compare, and there is no write to look for. In every case the crontab is left **exactly** as it was and the backup is **not** deleted. Two more of the same shape were found by sweeping the library: `port_listener_census` took its listener count with an unchecked substitution whose empty result went into an arithmetic comparison against zero — and bash evaluates the empty string as **0** there, so a broken `awk` reported the port **drained** over a census it never read, in the very section whose own rule is that absence of evidence is not evidence of absence; and `crontab_read_says_no_crontab` was fail-closed only by accident. **A roster of the remaining unchecked substitutions is pinned by test.** Every command substitution inside a function that runs with `errexit` suspended — computed by transitive closure, not by assumption, since `plan_crontab_unfence` is reached that way and by nothing else — must either take its status or appear on that roster with a stated reason why its failure is already a refusal. Adding an unchecked one fails `tests/settings/crontab-reconcile-serialization.test.ts` with the rule its author needs to read, and a roster entry that no longer matches any shipped line fails it too, so a stale reason cannot hide the next finding behind it.

**And a sentinel proves the computation FINISHED, not that it SAW EVERYTHING** (o3d-p9dq, Codex r32). The completion sentinel above was the right idea aimed at the wrong end of the computation, and it was reviewed and accepted in that state. It establishes that `awk` reached its `END` block. It cannot establish that `awk`'s **input** was complete — and the comparison needed two inputs at once (`NR == FNR` is how one `awk` tells them apart, and a here-string supplies only one), so both were handed in through **process substitutions**: `<(printf '%s\n' "${candidate}") <(printf '%s\n' "${backup}")`. A process substitution's producer **reports its failure to nobody**. Its status is not `awk`'s — `awk` sees a file that ended, not a writer that failed — and it is not the shell's either, because the shell never waits for it and `$?` never carries it. So a backup-side `printf` killed, or dead after part of its output, handed `awk` a **truncated backup**; `awk` compared what it was given, found nothing of it missing, printed the sentinel and exited 0. The merge was approved as lossless, installed, and the backup — the only copy of the line it had just dropped — was deleted. Reproduced against the shipped function by failing only the backup-side producer: `rc=0`, `PLAN=merge`, the operator's job gone.

Both inputs are now written to **separately created temporary files**, each `mktemp` checked, and each write checked **before `awk` is invoked at all** — a failed write aborts the comparison rather than being discovered after its answer has been acted on. Two checks per write, catching different failures: `printf`'s own **status**, which unlike a producer's is this shell's to take; and a **read-back line count** taken with `mapfile`, a builtin, so the check cannot be taken down by the failure it exists to detect — that is the one that catches a short write reported as successful, which no status can. It is the projections' line-for-line proof said about an input instead of an output. The bytes are exactly what the process substitution supplied (the empty string included: one blank line, which the parser has always discarded), so the answer is unchanged; the sentinel stays, because it still proves its own end; and both files are removed on **every** path out of the function — either `mktemp` failing, either write failing, `awk` failing, the sentinel missing, and success — by `rm` rather than a `trap`, since three entrypoints source this library and an `EXIT` trap here would displace theirs.

**The third producer shape is enumerated too, and it has no "checked" form.** A command substitution has a status and `errexit` suspension merely throws it away, so the roster above is for the few whose failure is already a refusal. A process substitution has **no status to take at all**, which is why the two tiers differ: the crontab/fence `errexit`-suspended closure carries **none** — not one, not on a roster, because those are the functions that decide what crontab to install and whether to delete the only backup of the one they replace — and every other one in the shipped shell files (`install.sh`, `deploy.sh`, `update.sh`, `lib/crontab-lock.sh`, `lib/db-fence-protected.sh`) is on a roster with the reason an incomplete answer from it is not a decision made on nothing. The sweep that produced it found nine besides the finding: three are diagnostic report text; the systemd unit list can only *drop* units and an empty one refuses the migrating deploy before anything is stopped; `compgen -e` is a builtin over this process's own environment; the CA `find` is a prefilter for a deletion, so a short list deletes fewer files rather than more; the extra probe-candidate list is additive and already seeded; and the `verify.sql` `find` selects which verifications run, installs and deletes nothing, and prints the count it found. Three more were **converted rather than justified**, because emptiness read as a *pass* at each — `unit_route_env_guaranteed`'s and `db_application_route_env_refusal`'s route-variable loops, and the expected-`ExecStart` `mapfile` beside them, now capture the producer, take its status and feed the same bytes to the same reader through a here-string. Adding an unchecked process substitution anywhere in those files fails `tests/settings/crontab-reconcile-serialization.test.ts`, and a roster entry that no longer matches a shipped line fails it too.

**A `pgrep` that could not run is not a host with no cron daemon** (o3d-p9dq, Codex r30). The absence proof's own daemon census read every non-zero `pgrep` status as "not running". Measured on Debian's procps-ng 4.0.4: `0` matched, `1` no match, `2` a command line it could not parse, `3` a fatal error such as out of memory — and the shell adds `126`, `127` and `128+n` on top. Only `1` is evidence of absence; anything else now withholds the proof and stops the run, the same rule the rest of `require_crontab_command` is built on.

**The application's own reader fails closed on the same rule** (o3d-p9dq, Codex r29). `readOwnCrontabResult()` in `lib/crontab-reconcile.ts` used to resolve every `execFile` failure — timeout, permission denial, spool I/O error, failed fork — as an empty string, and the reconciliation then spliced the managed block into that fabricated empty crontab and handed the result to `crontab -`. A read that failed while the *write* would have succeeded deleted every unmanaged operator line and reported the save as successful. It now returns a discriminated result: a crontab that was read, a crontab that provably is not there, or a refusal that names what went wrong — and an unresolved read aborts **before** the splice, leaving the crontab untouched and reporting "the scheduler may be behind". Settings → System → Scheduler likewise reports an unreadable crontab as *unknown* rather than as a missing managed block, because the old reading sent the operator to press the one button that used to overwrite the file it could not read. The absence rule is shared with the shell reader in spirit and held to it in fact: the shell copy is `crontab_read_says_no_crontab`, the application copy is `isNoCrontabDiagnostic` in `lib/crontab-sync.ts` (a Next.js server build has no shell and no checkout to source one from), and `tests/settings/crontab-read-discrimination.test.ts` runs **both** over one table of stderr cases and fails if their verdicts ever differ. A host with **no `crontab` binary at all** is *not* an answer either (o3d-p9dq, Codex r29). `crontab(1)` is an **editor**: it puts a file into the spool and takes it out again, and the daemon reads that spool directly and keeps what it read in memory. Removing, renaming or un-executable-ing the client therefore unschedules nothing — the spool file survives it, a running `cron` keeps firing what it already parsed, and a `cron` restarted afterwards re-reads the spool without ever consulting the missing binary. Every cutover fence path now goes through `require_crontab_command`, which either finds the client, **proves** there is nothing to fence, or stops the run. The proof is a positive search and it is only as good as its lists: it requires the run to be root (the spool is mode 1730, and a directory that cannot be listed reads as an empty one), that no `cron`/`crond`/`fcron` daemon is running, and that none of `/var/spool/cron/crontabs`, `/var/spool/cron` or `/var/spool/fcron` holds an entry for the service user — with a root that exists but cannot be listed, a missing `pgrep`, or a spool entry that does exist all *withholding* the proof rather than granting it. It can still be wrong for a cron implementation whose spool is somewhere else, a daemon under another process name, or a daemon started after the check; `anacron` is deliberately not in that list because it runs `/etc/anacrontab` and never a per-user spool. On the **restore** paths there is no proof to be had at all and none is offered: a backup file on disk *is* the evidence that a schedule was fenced, so a missing client there is fatal and never a silent "nothing to put back".

**That path is a literal on both sides, and neither writer has one of its own.** `/etc/ims-cutover-state` is written into `lib/crontab-reconcile-lock.ts` as `CRONTAB_RECONCILE_LOCK_ROOT` and into each of the three entrypoints as `readonly CUTOVER_ROOT_DIR`, and `tests/settings/crontab-reconcile-serialization.test.ts` **resolves both** — bash evaluating the entrypoint's own declaration, the shipped function asked for its own answer — rather than comparing basenames. It is deliberately **not** configurable: a lock location an operator can move on one side and not the other is two locks pretending to be one. Do not put the lock beside the application: a hardened unit (`deploy/systemd/ims-stage.service`, `ProtectSystem=strict`) makes the app directory read-only, so a lock file there cannot even be created; and do not put it back under the `StateDirectory`, which is the account-owned directory the relocation above moved it out of. `OTI_CRONTAB_LOCK_PATH` and `OTI_CUTOVER_STATE_ROOT` are **test-only** overrides — the real namespace outranks both, and production refuses each outright with a warning on stderr. The queue wait is tunable on both sides: the application's with `OTI_CRONTAB_LOCK_WAIT_MS` (default 20 000 ms), and the entrypoints' with `IMS_CRONTAB_LOCK_WAIT_SECONDS` (default 60). The shell wait is deliberately the longer of the two — an entrypoint mid-cutover cannot simply come back later — and a wait that expires is a refusal that names the lock file, not a write without it.

**The lock is root's, and the service only reads it.** `${DATA_DIR}/locks` is created by the installer as `root:root` 0755 and the lock file inside it as `root:root` 0644 — the state directory around them stays owned by `imsapp`, as systemd requires, but nothing inside `locks/` can be created, replaced or removed by that user. That is deliberate: the installer runs as root, and a root-side `touch`/`chown`/`chmod` on a path the service account can turn into a symlink is a privilege-escalation primitive (it was one until r24). `flock(2)` ignores a descriptor's access mode, so the application opens the lock **read-only** and takes exactly the same exclusive lock; it never needs to write it. Do not `chown` the lock to `imsapp` "to fix permissions" — that re-opens the hole, and nothing needs it. On a host that was never installed by `scripts/install.sh` (a hand-deployed unit, `next dev`) the application creates `locks/` and the lock file itself, as the service user; there is no root writer there to be protected from.

**And that primitive was not confined to the lock** (o3d-czpy). The lock file was one instance of a class: `scripts/install.sh` runs as root and writes into `${DATA_DIR}` and `${APP_DIR}`, both of which *it* hands to `imsapp` with a recursive `chown` — so on the next run every path it resolves inside them is a name the service account can have replaced with a symlink. Eight further sites were converted, and they now share three primitives with `prepare_crontab_lock`:

* **Every publication is staged in a root-owned directory.** `publish_durable_file()` — the writer behind `${APP_DIR}/.env`, `${APP_DIR}/.deploy-meta`, `${DATA_DIR}/git-ssh/known_hosts`, `/etc/ims-cutover/DEPLOY-FENCED` and the crontab backup — creates `.ims-publish` beside the target as `root:root` 0700, `cd`s into it (so the shell holds the *inode*, which no rename can move), makes its temporary there, applies **owner and mode before the content**, and publishes with `mv -T`. `rename(2)` replaces a symlink entry instead of following it. **And the rename names the destination RELATIVELY** (`../known_hosts`, never the absolute path): a pinned inode does not pin the path used afterwards, and `${DATA_DIR}/git-ssh` is a directory `imsapp` can rename aside between the pin and the publication, which would have sent a root-written `known_hosts` to a directory of their choosing. **And the destination itself is reached by walking down from a directory `imsapp` cannot replace**, one component at a time, rather than by `stat`ing its pathname: a pin taken from a name proves the directory did not *move*, and says nothing about *which* directory was pinned, so `git-ssh` replaced by a symlink to `/root/.ssh` **before** the installer ran would have been pinned as `/root/.ssh` and passed every later check. The walk starts at the nearest of `/opt/one-two-inventory`, `/var/lib/one-two-inventory`, the cutover state directory, `/etc/ims-cutover`, `/etc/ims-cutover-state`, `/etc/ims-db-ca` and `/etc/ims-cutover-recovery` — each of which has a **root-owned parent** (`/opt`, `/var/lib`, `/etc`), so its own name cannot be renamed aside or forged — and refuses a publication whose destination lies under none of them. `deploy.sh` and `update.sh` carry the same publisher and the same table, byte for byte. From the moment the walk ends, the destination exists only as **a descriptor opened on it**, and is **never spelled again**: the staging directory, its `chown -h` and its `lstat` are all single relative components resolved from the working directory, and the publication and the final fsync go through `/proc/self/fd/N` — which the kernel resolves to the open directory, so `mv -T … /proc/self/fd/N/known_hosts` *is* `renameat(N, "known_hosts", …)`. It used to be `../known_hosts` and `fsync ..`. `..` is the kernel's own parent link, so no rename of any *name* above the staging directory can redirect it — but it is a property of **where the staging directory is**, re-read at every syscall, and a staging directory moved *wholesale* into another parent takes `../known_hosts` with it. What actually prevented that move was never written down: renaming a directory into a **different** parent requires write permission on the directory being moved, and the staging directory is `root:root` 0700, so `imsapp` gets `EACCES`. The publication's safety rested on the staging directory's *mode*, one inference away. It now rests on the descriptor, which is a fact about the destination and not about the staging directory at all (o3d-secops r19). The `..` checks are kept: they now **refuse** a moved staging directory instead of following it. **You will see a `.ims-publish` directory inside `/var/lib/one-two-inventory` and in `/opt/one-two-inventory`; leave it, and do not `chown` it to `imsapp`.** The installer's recursive chown over the state directory prunes it, at any depth, for the same reason it prunes `locks/` — and that walk is **no longer `find -exec chown`** (o3d-n8xx). `find -exec` enumerates *pathnames* and hands them to a `chown` that resolves them again afterwards, and `chown -h` protects only the final component; on an upgrade the service account owns this tree and the service is still running, so a descendant directory renamed into a symlink between the enumeration and the execution redirected a root-side ownership change through it (GNU find's own documentation calls `-exec` insecure for exactly this). `scripts/lib/chown-tree.mjs` now walks it **by descriptor**: every entry — directory, file, symlink, fifo, socket, device — is opened ONCE with `O_PATH|O_NOFOLLOW` relative to its parent's descriptor, `fstat` on that descriptor answers what it is and which inode it is, and the ownership change goes through `/proc/self/fd/N`, which the kernel resolves to the open file. There is no pathname left for anyone to re-resolve. **A name is never looked up twice** (o3d-secops r20): it used to `lstat` the name to decide the entry was not a directory and `lchown` the same name afterwards, so `imsapp` — who owns the parent and is still running — could plant a sacrificial regular file, wait for the walk to reach it, and rename the staging directory onto that name in the gap. The prune is only consulted for directories, so it never ran, and `lchown` on a directory is exactly `chown`: the debris of an interrupted publication was handed to the account that planted the swap. The directory branch had the same gap one step further along, in its fallback for an `O_DIRECTORY` open answered `ENOTDIR` or `ELOOP`. `O_PATH` is what lets one open cover every type: it needs no read permission, does not block on a fifo, and with `O_NOFOLLOW` opens a *symlink itself* instead of failing `ELOOP` — and a chown through the descriptor's own `/proc` name changes the link and not its target, exactly as `chown -h` promised. Because `open(2)` silently ignores flag bits it does not know, the walk proves it has `O_PATH` before using it: `fchown` on such a descriptor is `EBADF`, and anything else — a success included — is a refusal. `locks/` is pruned by **verified identity** — its `dev:ino` is taken once from the root's own descriptor, so renaming it mid-walk cannot get it chowned under another name. Staging directories are pruned by **shape**, not by name (o3d-secops r19): a directory owned by the uid running the walk whose mode is exactly `0700` is not handed over, wherever it is and whatever it is called. It used to be pruned by the name `.ims-publish`, and a name is not a boundary — `imsapp` owns the containing directory, so renaming `.ims-publish` to an ordinary name costs it nothing (a rename *within* one parent needs no permission on the directory being moved), and the walk then handed the directory over. That matters because a `SIGKILL` or a power loss between the fill and the rename cannot run a failure path, so the staging directory is left holding a **complete, root-owned copy of whatever was being published**. The shape is one `imsapp` can neither manufacture (it cannot `chown` to root) nor alter (it does not own it, so `chmod` is `EPERM`), so it survives every rename `imsapp` can perform. Everything the installer creates *for* `imsapp` it creates under `umask 022`, so `0755`; a `0700` root-owned directory is one `imsapp` cannot enter today, so withholding it takes away nothing that worked. `LOG_DIR`'s equivalent is `chown -Rh .` inside a root entered by descriptor, which coreutils walks with `fchownat` relative to descriptors it holds; the one over the application directory runs in section 9, before section 10 has created it, and the publisher re-takes root ownership with `chown -h` on every run and **refuses** — rather than correcting — anything at that path it does not end up inside.
* **Every directory below one of those roots is created with a plain `mkdir`, one component at a time, by a walk that never names an ancestor twice.** `mkdir -p a/b` succeeds *silently* when `a` is a symlink to a directory; a plain `mkdir` fails with `EEXIST` and the installer then `lstat`s the path and **refuses the run**, naming it. That covers the component being created and says nothing about the ones already accepted, so the walk `cd`s into each component as it goes and creates the next one **relative to the directory it is inside** — an ancestor that is renamed after it was checked cannot redirect anything, because the shell holds its inode. The one remaining window, between the `stat` that says "directory" and the `cd` into it, is closed by taking the component's **inode** in the same `lstat` that took its type and requiring the directory the walk lands in to be that exact inode — and by checking `..` after the step as well. The two catch different things and both are needed: the inode refuses a component swapped for a symlink to a **sibling under the same parent**, which `..` cannot tell apart from the real destination; `..` refuses a destination **moved wholesale into another parent**, which keeps its inode. Together they close the class in shell — no descriptor-relative `openat2` helper is needed, because an `lstat` names an inode and a `cd` lands in one, and a rename between them can only make the two differ. The same check protects `${APP_DIR}/.git`, where the previous version asked only whether the directory it had entered was root-owned — which a symlink to *any other* root-owned directory satisfies. The state roots themselves (`/var/lib/one-two-inventory`, `/var/log/one-two-inventory`) still use `mkdir -p`, because their parents are root-owned. **The root used to be the one hop that was not proved** (o3d-rn10 r5): it was entered with a `cd -P` that followed a symlink *deliberately*, so a state root symlinked onto a second disk kept working. Only the link's **name** is protected by its root-owned parent, though — the path its **target** resolves through is proved by nothing, so a target under a directory the application account owns can be renamed aside and rebound to `/root/.ssh`, and the unchanged root entry passes every check while the publication lands there as root. The root is therefore now created, `lstat`ed, entered and inode/`..` checked exactly like every component below it, and **a symlinked root is refused** — naming the bind mount that replaces it and pointing at the procedure under “Putting a state root on another disk” below. Put a state root on another disk with a **bind mount**, never a symlink.
* **No `chmod`, anywhere on these paths.** `chmod` has no `--no-dereference` on Linux, so a raced one is the same escalation with a different verb. `${DATA_DIR}/git-ssh` is now created at 0700 by `umask` and a wrong mode is **refused** rather than corrected — set it back to 0700 by hand if you ever changed it.

Two behaviour changes an operator may notice. `ssh-keyscan` output is captured and checked before it is published, so a keyscan that fails or returns nothing now **aborts the install** instead of leaving an empty `known_hosts`. The legacy-upload migration no longer requires its destination to be owned by the installer's uid — on any rerun the previous install has already chowned the upload roots to `imsapp`, so that check refused the ordinary upgrade; the walk above establishes the destination's identity instead, and the files are moved into the directory it is standing in. And `/tmp/one-two-inventory/pdf` and `/tmp/one-two-inventory/uploads` are **no longer created**: `/tmp` is world-writable, which made those the one pair of paths any local user could aim, and nothing in the application ever opened them (its own temporary uploads live under `os.tmpdir()/onetwoinventory`, created at runtime by the service).

Never delete and recreate the lock file — the lock lives on the inode, so a replaced file silently gives two writers two different locks. To see who holds it: `fuser -v /etc/ims-cutover-state/locks/.crontab-reconcile.lock`. A save that cannot get the lock within the wait reports "the scheduler may be behind" and changes nothing; re-apply from Settings → System → Scheduler. **If the lock file cannot be opened at all** — a missing `locks/` directory under `/etc/ims-cutover-state` (no privileged run has happened on this host yet), a directory the service user cannot traverse, a read-only mount — the reconciliation *refuses*: it does not read or write the crontab, and the error names the path it tried and which of its four sources produced it. A privileged run should have made this impossible, because it now proves the file is openable by this account before it finishes; seeing this error means the state changed after the last install, deploy or update. It never falls back to reconciling without the lock, because an unserialised reconciliation is exactly the defect the lock exists to prevent. **And an unanswerable state at that location is a refusal too, not a fallback**: a symbolic link where the `locks` directory should be, a file at that name, or a path that cannot be stat-ed at all. Only a genuine `ENOENT` is read as "no privileged run has been here", and only because nothing but root can create or unlink a name inside `/etc`.

**An upgrade proves the application is running *this* build before it touches the crontab.** That flock only excludes a process locking the *same* file, which is true only of a process running the build the installer just deployed, under the unit it just wrote. The installer establishes that in three steps, not one: the cutover **stops** the service before the migration and refuses to go on while anything is still bound to the app port; section 12 then `enable`s the unit and `start`s it — deliberately two statements, because `enable --now` reloads systemd implicitly and would re-read every unit file *after* the check that the loaded configuration binds the service to this run's database; and section 12b then asks the port *which build answered*, by fetching `/_next/static/<BUILD_ID>/`, a route only the process whose own build id is that one serves. `/api/health` alone is not enough — a predecessor still holding the port answers it just as well. **And the asset fetch alone is not enough either** (o3d-p9dq): it proves which *tree* is being served, not whose *process* is serving it. A same-build process started by hand out of `${APP_DIR}` after the port was drained can win the bind while `systemctl start` returns for a unit that then fails to bind. That used to matter because such a process, not being the unit's child, has no `$STATE_DIRECTORY` and resolved the crontab lock under its own working directory — **which is no longer true** (o3d-txoe): the lock is derived from a literal and does not depend on `$STATE_DIRECTORY` at all, so a same-build impostor takes the very same inode. The check stays, and what it now carries is an **identity** proof: that the process answering is the unit this run wrote, and therefore reads the database this run migrated and the environment file this run published, and is not a **predecessor** build — which does still resolve its lock under `$STATE_DIRECTORY` and is reached only by the rollout bridge described above. So section 12b also verifies that the unit is active, resolves its `MainPID` and `ControlGroup`, checks that every pid holding a listening socket on the app port is inside that control group (a cgroup rather than a pid equality, because a Next.js unit's listener is routinely a child of the `ExecStart` process), and reads each listener's **own** effective `STATE_DIRECTORY` out of `/proc/<pid>/environ` to confirm its first colon-separated entry is `${DATA_DIR}` — the value the unit this run wrote declares as `StateDirectory=`. An `environ` that cannot be read (the process exited, or `/proc` is mounted with `hidepid=` for this reader) is *proof not established* and aborts; it is not treated as an absent variable. **If either proof fails the install aborts** and the crontab section never runs, because taking a lock that excludes nothing is worse than not writing the crontab at all. The result is carried to the crontab section as `APP_SERVICE_ON_NEW_BUILD`, which section 16 refuses to open the lock without, so reordering the two sections fails loudly rather than silently reopening the race. A **hand-deployed** upgrade has none of this: nothing stopped the service, so it must rebuild, then `systemctl restart` (a `start` on a running unit is a no-op and leaves the old process on the old lock path), and only then touch the crontab — see `deploy/README.md`.

**The installer bootstraps, it does not reconcile.** Its schedules are defaults, not your committed settings, so on a re-run or upgrade it writes its bootstrap block only when no managed `# --- OTI CRON START ---` block exists. If one is already there the application owns it and the installer leaves it alone — which means a job newly registered by an upgrade is not scheduled until you open Settings → System → Scheduler and press Save & Apply. The scheduler page's warning banner flags a missing or malformed managed block.

All cron jobs run under the `imsapp` user and call the application's API endpoints via `curl`. Cron endpoints require the `CRON_SECRET` bearer header in production, and production startup fails fast if `CRON_SECRET` is unset, blank, or shorter than 32 characters. Installer-generated crontab entries read only the `CRON_SECRET=` line from the protected `${APP_DIR}/.env` file at runtime so the cron secret is not embedded directly in the crontab and unrelated environment values are not shell-sourced. The in-app scheduler sync (Settings → System → Scheduler) prefers the runtime-read pattern too, but only selects it when a byte-for-byte emulation of the exact `grep | cut | tr` pipeline proves the app's `.env` yields the *active* process secret; every other case (no readable `.env`, a value that shell-parses differently, binary/`NUL` content, or an env supplied by the service manager and not the file) falls back to embedding the current literal, which is always correct at sync time. In runtime mode a secret rotation needs only the `.env` edit and a service restart — no crontab re-sync — and each job line is a `case` on the extracted secret: an empty value, or one holding a backslash, runs nothing and writes `cron-auth: CRON_SECRET is missing or unusable ...; <job> was not run` to the cron log, so a missing file or empty extraction skips the request rather than sending an unauthenticated one. **The bearer is never on a command line:** the line pipes `echo "header = \"Authorization: Bearer $CRON_SECRET\""` (a shell builtin) into `curl ... -K -`, so `ps` shows neither the secret nor a file path, and no file holds it; the crontab itself holds the secret only in the embedded-literal fallback, as one `CRON_SECRET="..."` line in the user's crontab spool (mode 600 root:crontab on Debian/Ubuntu). Earlier releases wrote `curl -H "Authorization: Bearer $CRON_SECRET"`, which put the secret in curl's argv while a job ran; the installer, `update.sh` and `deploy.sh` now each rewrite them in place when they find them in an existing managed block (one shared function, `scripts/lib/crontab-lock.sh`; `update.sh` and `deploy.sh` run it after the cron restore and before they report completion, never in a dry run): under the crontab lock, each legacy job keeps its schedule (including any you set in the Scheduler), slug, log path and secret source and only its command changes, the result is re-read and verified, and a block it cannot rewrite (or a failed write, or a lock held by another writer that leaves the old lines) ends the run with an error instead of a warning (the service keeps running; fix the cause and re-run, or press Save & Apply in the Scheduler and re-run). It also rewrites the plain, unmarked jobs an older installer appended outside any marker (`curl -fsS -H "Authorization: Bearer ${CRON_SECRET}" http://localhost:<port>/api/cron/<job>`), keeping schedule, `.env` path, URL and redirect, and it refuses to finish while ANY other crontab line still runs `curl` with an `Authorization`/`Bearer` header argument (a literal secret, an extra flag, a different quoting): the error names the crontab line number(s) and never prints the line. The rewrite inserts the log path and job name verbatim: an `&`, backslash, `%` or space in a log path survives it unchanged. The installer and the in-app scheduler render the identical line (a test compares them byte for byte and runs the rendered command under `sh` with a recording `curl`). The generated cron log defaults to `/var/log/one-two-inventory/cron.log` (the installer-owned `LOG_DIR`, already covered by logrotate); override with `OTI_CRON_LOG_PATH`. The installer writes its bootstrap jobs inside the same OTI-marked managed block in this exact format, and on upgrade it removes every previous managed block (including whitespace- or CRLF-suffixed markers) and any legacy bootstrap lines that call `localhost:<app-port>/api/cron/`, while preserving the operator's own crontab entries — including unrelated `/api/cron/` calls to other hosts, a line that coincidentally matches the managed-job format but sits outside any managed block, and any operator lines after a malformed unclosed marker (never deleted to end-of-file; only the block's own remnants within that region are removed). So no duplicate or drifting One Two Inventory cron entries survive an upgrade. The first in-app scheduler save then replaces that block IN PLACE — at its original position among the operator's lines, so it never moves past an operator `PATH`, `SHELL`, or `CRON_TZ` assignment (which apply only to the jobs below them). `OTI_CRON_LOG_PATH` and the `.env` path are rejected if they contain a quote, `%`, or control character, and the embedded-literal fallback is rejected for a secret containing a quote, backslash, backtick, `$`, or newline (rotate to a hex/base64 secret) — so the crontab can never be corrupted by a crafted value. The scheduler page shows a warning banner when the managed block is missing, malformed, carries a stale embedded secret, has a runtime `.env` that no longer matches the running service, or when unmanaged `/api/cron/` lines exist outside the managed block. Rejected cron auth is also recorded (best-effort) as a WARNING activity (`cron_auth_rejected`), deferred off the 401 path and throttled to at most one per route per process per hour, so a stale secret surfaces instead of failing silently. Localhost bypass is available outside production only when no `CRON_SECRET` is configured; production never accepts localhost cron requests without the bearer header. After a valid cron secret, each cron endpoint is rate-limited per job and source IP when a client IP is available: daily/hourly jobs default to one accepted run per hour, 5-minute jobs allow 15 accepted runs per hour, and 15-minute jobs allow 6 accepted runs per hour. The sub-hourly quotas intentionally include scheduling-jitter headroom and should not be tightened to the exact cadence. Rate-limited calls return `429` with `Retry-After`. Single-process installs can use the default in-memory rate-limit backend. Multi-replica or load-balanced installs must set `RATE_LIMIT_BACKEND=redis` and `REDIS_URL` so cron throttles are cluster-wide. Rotating `CRON_SECRET` requires updating both `.env` and any external cron scheduler invocations in the same maintenance window because the application reads the environment value on restart; if an old or leaked secret consumed cron quota, restart the memory backend or clear the Redis rate-limit keys rather than waiting for the one-hour window to expire.

For WooCommerce specifically:

- real-time order/product intake should come from webhooks
- `/api/cron/wc-reconcile` is the daily backup reconcile path for orders/products and also runs the stock catch-up plus queued retry drain
- the **Import order statuses** selection (Settings > Sync > WooCommerce) decides which orders IMS takes on. It governs every route that *fetches* orders — the one-off active-order import and the poll/reconcile sweeps, each of which turns the selection into a WooCommerce `?status=` query — and **every route that receives an order without asking for a status**: the order webhook, the withdrawal-recovery sweep and the pending-FX retry queue. Those are gated inside the importer itself, at the read that decides create-versus-update, so a new ingress path is gated by default rather than when someone remembers to add the check. It is an **admission** rule: an order IMS has never seen is created only if it arrives in a selected status, and one that later moves into a selected status is imported by that update. An order IMS already holds is never gated, so it keeps following the store whatever status it moves to afterwards. Reconciliation additionally fetches `completed` so a finished order is never stranded, and the customer-withdrawal statuses are always included. An empty selection imports nothing, on every route. IMS also declines to create an order whose WooCommerce status it has no reading of — no status-mapping row and not one of WooCommerce's own statuses — rather than inventing `PROCESSING` for it, which used to allocate stock and queue an invoice off a status nothing had defined. **A refused order is never lost.** Each refusal writes a durable row naming the order id, and `/api/cron/wc-withdrawal-sweep` re-reads those orders by id every 15 minutes and puts them back through the same gate, so an order is imported as soon as you tick its status or add its mapping — with no dependence on WooCommerce ever pushing it again (the delivery was acknowledged, so it will not) or on a sweep cursor still reaching back to it. Widening the selection additionally rewinds the poll/reconcile cursor to the earliest order the selection had turned away, which imports a whole excluded status in one sweep instead of one by-id read at a time (logged as `wc_order_sync_cursor_rewound`; the by-id drain logs `wc_order_admission_refusal_drained`). The Sync page states all of this next to the checkboxes
- **an order must state its own currency.** IMS will not supply one. The currency decides the FX rate the order is converted at, the ledger its invoice posts to and the bank account its payment settles into, and an order created on a guessed currency agrees with itself in every one of those places — so nothing downstream can detect it. If a WooCommerce order arrives with `currency` absent, blank, or not a three-letter code (a degraded, filtered or partly-serialised REST response), the order is **not imported**: it goes into the same durable by-id refusal queue as an excluded status, is visible under **Sync > Exceptions** with the raw value IMS read quoted back to you, and is logged as `wc_order_webhook_currency_missing`. The 15-minute `/api/cron/wc-withdrawal-sweep` drain re-reads the **live** order, so fixing it in WooCommerce imports it with no further action here. A currency that *is* well formed but that IMS holds no FX rate for is a different case and is handled the way it always was — the order is retained in the pending-FX queue and imported automatically once a rate for that currency is fetched.
- **orders imported before that rule existed may be carrying a currency nobody stated.** Earlier versions defaulted a missing WooCommerce currency to GBP, and `SalesOrder.currency` also defaults to GBP, so an invented GBP and a genuine one are indistinguishable in the order row — there is no marker separating them, and no query over the orders alone can tell them apart. **No automated separation ships yet**, and none should be trusted until it can prove which delivery created each order: the archived `shopping_webhook_events` payloads are the only positive evidence, they cover webhook-arrived orders only, and a live WooCommerce read is actionable but is not proof of what the order was created with. Correcting such an order is also not a matter of rewriting `currency`: the invented code made the FX lookup return 1:1, so the converted `*Base` totals were computed at par, and a code-only rewrite would replace one inconsistency with another. Any affected order that has already been invoiced, paid or swept into a daily accounting batch must be reconciled by hand. **That evidence has an expiry date, and it is now held open.** The daily retention pass compacts the shopping webhook inbox — it replaces the `payloadJson` of every PROCESSED row past `retention_webhook_events_months` (default **3 months**) with `{}`, keeping the row as an idempotency tombstone — so the archived deliveries this depends on were on a three-month destruction clock. WooCommerce **order** deliveries (`connector = 'woocommerce'`, `resource = 'orders'`) are therefore **exempt from that compaction until `o3d-j7y4` closes**, by a code constant in `lib/connectors/shopping-webhook-retention.ts` rather than a setting, so that turning the destruction back on is a reviewed change. **The exemption covers every WooCommerce order delivery, at any age, and it has no automatic expiry — deliberately.** A version bounded by a per-installation cutoff (the instant this installation stopped running the old importer, recorded by the nightly pass) was built and then withdrawn: it saved nothing for a whole retention window, because a delivery on the far side of the cutoff is still compacted only once it is three months old; and the stored cutoff could be made to say the wrong thing — by a rollback to the old importer, on a fresh installation that never ran one, or by anyone able to write the settings row — in the one direction that destroys evidence irreversibly. Over-retention is reversible in one nightly statement; destruction is not. **The cost is real and is an accepted constraint owned by `o3d-j7y4`:** the exemption grows for as long as that issue is open, at roughly seven order payloads a day on the reference instance, and those payloads carry billing and delivery names and addresses retained past the window you configured. It is shown to the operator on **Settings > System > Data Retention**, beside the window it overrides, stating how many payloads are being kept alive *solely* by the exemption — held, past your window, and otherwise compactable — separately from the total order-delivery population, which is mostly inside the window and held back by nothing. The exemption is a hold on destruction only: it examines no payload and makes no claim about any order. Two limits are permanent and no later change can repair them: a payload that was **already compacted** cannot be reconstructed from anything else in the database, and a creator-identity column added to the order table later cannot prove, retroactively, what an earlier delivery said. Orders created by the initial import or by the poll/reconcile sweeps never touched the inbox at all and so have no archived delivery to preserve. Tracked as `o3d-j7y4`.

For Mintsoft specifically:

- accepted ASN booked-in webhooks return after persistence
- `/api/cron/mintsoft-webhook-sweeper` applies the pending stock and purchase-order effects asynchronously
- booked-in processing uses direct ASN lookup by default; `MINTSOFT_USE_BULK_ASN_LOOKUP=true` temporarily restores the legacy list-and-match path if Mintsoft endpoint discovery proves the direct path incompatible
- the sweeper drains up to `MINTSOFT_WEBHOOK_SWEEPER_PAGE_SIZE` persisted events per run; the default is `250`
- the same sweeper also carries the **post-maintenance re-check**: when a maintenance window closes, `disableMaintenanceMode` stamps `wms_booked_in_recheck_due_since`, and the next sweeper run re-checks every open ASN (both purchase-order and stock-transfer, up to 100 per tick, oldest first) so callbacks the maintenance fence refused recover without an operator. The stamp is kept until a full pass completes. See [`mintsoft.md`](./mintsoft.md#maintenance-mode-fence-o3d-hl8l)
- `wms-watchdog` (hourly) is **enabled by default**: it is the days-scale backstop that alerts admins on an open ASN with no booked-in callback, and on a binding whose stock sync went quiet
- `/api/cron/mintsoft-dispatch-sync` polls already-pushed orders (`WmsOrderPushLink.state` in `SYNCED`/`MERGED`, not yet shipped) for a despatched status and feeds the despatch into the IMS shipment via `applyExternalFulfillmentUpdate`, carrying the Mintsoft tracking number/courier through to the shipment + customer notifications; it is idempotent (a dispatched order leaves the poll set once reconciled to SHIPPED). It also handles:
  - **Split orders** — when Mintsoft splits an order into parts, each despatched part is pushed to the storefront as a partial shipment (via the onetwoInventory Helper plugin) and the IMS order is marked SHIPPED only once every part has despatched.
  - **Merged orders** — when Mintsoft merges an order into a survivor (combined `a+b` OrderNumber), the push link is repointed to the survivor and parked `MERGED` (so the order-push sweep no longer amends it), then reconciled. A merged-and-split survivor is completed atomically without per-part partial shipments (its parts mix several original orders).
- for a **storefront** order this also closes the customer-tracking loop end to end: the SHIPPED transition runs `pushOrderDeliveryMetadata` → `pushImsTrackingToWc`, writing the tracking into WooCommerce's `_wc_shipment_tracking_items` meta, so WooCommerce emails the customer their tracking (no separate IMS dispatch email is sent, to avoid double-emailing). Direct/non-storefront orders have no dispatch email yet — see issue `q66in.1.6`

Connector network requirements:

- WooCommerce and Mintsoft base URLs must use public HTTPS endpoints in normal operation.
- IMS rejects connector URLs that directly target localhost, loopback, RFC1918/private, link-local, multicast, or cloud metadata addresses. Local HTTP loopback URLs are accepted only for E2E tests with `E2E_TEST_MODE=1`, and this allowance is ignored when `NODE_ENV=production`.
- Connector HTTP requests validate DNS lookup results at connection time so a public-looking hostname cannot resolve or rebind to a blocked address.
- Connector redirects are followed only through the validated connector HTTP client. Every redirect hop is URL-validated and DNS-validated before connection, with sensitive headers stripped when the redirect crosses origins.
- Internal connector deployments behind a VPN should preferably be exposed to IMS through a public DNS name and public-routable gateway. If a private-IP connector target is unavoidable, set `CONNECTOR_PRIVATE_IP_ALLOWLIST` to a comma-separated list of exact IPs or CIDR ranges, for example `10.0.0.5,192.168.10.0/24`.
- The private-IP allow-list is intentionally narrow: it applies only to RFC1918 IPv4 or ULA IPv6 literal/DNS-resolved addresses, not `localhost`, loopback, link-local, metadata, multicast, credentials in URLs, fragments, query-string base URLs, or non-HTTPS production connector URLs.

Authentication note:

- login and TOTP throttling are currently in-process only
- this deployment assumes a single application instance/LXC
- if you add a second web instance or separate worker handling auth routes, move rate limiting to shared storage such as Redis before doing so
- if you deploy behind OpenLiteSpeed or another upstream proxy, strip/replace incoming `X-Forwarded-For` before proxying to the app tier
- set `TRUSTED_PROXY_IPS` / `TRUSTED_PROXY_CIDRS` so the app can walk the forwarded chain from right to left and ignore internal proxy hops
- set `REQUIRE_TRUSTED_PROXY_CONFIG=true` so `npm run preflight:production`
  fails if trusted proxy entries are missing on a proxied production deploy


## Production Readiness Checklist

Before declaring a deployment production-ready, work through this checklist. Each item maps to a real failure mode the system has hit before.

### Environment

- [ ] `NEXT_PUBLIC_APP_URL` set to the production URL (no trailing slash).
- [ ] `AUTH_SECRET`, `AUTH_URL` set; `AUTH_URL` matches the public URL.
- [ ] `CRON_SECRET` is set and is a strong random value (32+ chars). The system fails fast on startup if this is unset in production.
- [ ] `DATABASE_URL` points at the production database; verified by `npx prisma migrate status`.
- [ ] `SETTINGS_ENCRYPTION_KEY` set and backed up off-server (rotation procedure documented).
- [ ] If multi-replica: `RATE_LIMIT_BACKEND=redis` and `REDIS_URL` set.

### Cron jobs

Verify each scheduled job is registered with your cron daemon and has run successfully at least once:

- [ ] `/api/cron/fx-rates` — daily
- [ ] `/api/cron/wc-reconcile` — daily (if WooCommerce connected)
- [ ] `/api/cron/accounting-daily-batch` — daily at midnight (if Xero connected)
- [ ] `/api/cron/accounting-sync` — every 5 min. Schedule it even with no accounting connector connected: the
      first thing it does, before any connector gate, is settle accounting posting refusals that a business
      transaction had to hold because another job held the same posting's lock. Leave it unscheduled and those
      sit in **Sync → Exceptions** marked *Unconfirmed* instead of being settled.
- [ ] `/api/cron/accounting-payment-poll` — every 15 min (if accounting connected)
- [ ] `/api/cron/accounting-fx-revaluation` — daily (if accounting connected)
- [ ] `/api/cron/account-balance-snapshot` — daily (if accounting connected)
- [ ] `/api/cron/delivery-status` — every 15 min (if delivery tracking enabled)
- [ ] `/api/cron/mintsoft-dispatch-sync` — every 15 min (if Mintsoft receives orders from IMS; a registered job, so it is scheduled by Save & Apply on an existing crontab)
- [ ] `/api/cron/backup` — daily, off-peak window
- [ ] `/api/cron/invariant-check` — daily
- [ ] `/api/cron/product-lifecycle-archive` — daily

Each cron endpoint requires `Authorization: Bearer ${CRON_SECRET}` in the request. The system's per-route rate-limit quotas have headroom for jitter but not double-frequency abuse — verify your cron daemon doesn't retry aggressively.

### Backup & restore

- [ ] Backup cron schedule confirmed (`/api/cron/backup` daily).
- [ ] Remote upload (S3 or SFTP) configured under Settings > Backup. Local-only backups are vulnerable to the same incident that takes down the application server.
- [ ] Restore round-trip tested on a staging environment — confirm the manifest validation passes and the database is functional after restore.
- [ ] `DATABASE_RESTORE_MAX_FILE_BYTES` raised if your typical backup exceeds 50MB.
- [ ] A [fresh-install rehearsal](#fresh-install-rehearsal) is GREEN for the commit being deployed — it demonstrates the dump-and-restore round trip on a throwaway cluster before any data is loaded.

### Integrations

For each connected integration (WooCommerce, Xero, Mintsoft):

- [ ] Credentials configured.
- [ ] **Connection test passes** — the connection test gate blocks sync until you click "Test Connection" successfully. Verify by visiting Sync > {Integration} and looking for the green "Connected" badge.
- [ ] Sync enabled.
- [ ] Sync Log shows recent successful runs.

For WooCommerce specifically:

- [ ] OneTwoInventory Helper plugin installed in WordPress with matching shared secret.
- [ ] Webhook endpoints registered (use Setup Webhooks button).
- [ ] Initial order import completed (one-time, gates ongoing sync).
- [ ] Tax rate mappings imported and reviewed (Sync > WooCommerce > Tax Rates).

### Security

- [ ] Admin user has 2FA enabled (TOTP or passkey).
- [ ] Default passwords changed; password policy is enforced (12 chars + uppercase + number + symbol + not in common-password list).
- [ ] HTTPS only — no HTTP fallback.
- [ ] `INVOICE_PDF_TOKEN_TTL_SECONDS` set to a sensible value for your operator workflow (code default 10 minutes; the example 3-day value is reasonable for internal operator workflows; lower for high-security tenants).
- [ ] `INVOICE_PDF_TOKEN_MAX_TTL_SECONDS` left at or below the 30-day hard cap, or lowered for stricter tenants.
- [ ] Activity log redaction confirmed (Settings > System > Activity Log shows `[REDACTED]` placeholders, not raw secrets).

**The generic settings writers accept an allowlist of operator preferences and refuse everything
else.** The `settings` table serves two different kinds of row: operator preferences that a screen
offers and any value is a legitimate choice for, and system-managed rows whose value is a fact the
system established — the WooCommerce initial-import completion flag and sync cursors, the WooCommerce
credentials and settings version, the integration plugin flags, the accounting binding pins and the
Xero release witness, the maintenance fence and its booked-in re-check marker, the Mintsoft
token-refresh lease, and the per-connector claim and drift keys the WMS dispatch sweep builds at run
time. `setSetting` and `setSettings` are exported Server Actions taking an arbitrary key, so each is
its own addressable endpoint reachable by any principal holding `settings.company`.

Both now accept **only** the preference keys listed in
`lib/domain/settings/writable-setting-keys.ts`, and refuse every other key before opening a
transaction. That list is grouped by the settings screen that offers each key, and a repository test
fails unless the screens named in it are exactly the files that import a generic writer — so a
preference nobody can set from a screen cannot be on it, and a screen cannot save a key that is not.

"A screen offers it" is necessary but not sufficient. A control can be on a screen and still not be
an operator preference: the backup and FX schedule switches were, and both duplicated enablement the
cron registry owns. The backup schedule is now saved by `saveBackupScheduleSettings`, which writes
the scheduler's `cron_backup_enabled` and the route's `backup_schedule_enabled` together and
reconciles the crontab; the Scheduled Jobs editor mirrors the legacy row in the other direction. The
FX panel's switch and interval were removed — nothing in the application ever read them. The
repository test therefore cross-checks the allowlist against the cron registry's canonical and legacy
enablement keys as well as against the screens.

This is deliberately an allowlist rather than a list of keys to refuse. A denylist is only ever as
complete as the last search for system-managed keys, and the previous one had already missed the
WooCommerce sync cursors and completion flag. **Adding a new system-managed key therefore requires no
change here at all — it is refused because it is not a preference.** What needs a change is adding a
new *operator preference*: list it with its screen, or that screen's save fails loudly the first time
it is used. `lib/domain/settings/reserved-setting-keys.ts` survives only as the table that names the
owning writer in the refusal message for the families we have already documented; it no longer decides
anything.

That check is application-level. A **database-enforced** version is possible but needs a migration, so
it is written down here rather than shipped: a `CHECK` constraint cannot express it (system-managed
keys must still be insertable, by the code that owns them), so it would take a `BEFORE INSERT OR UPDATE` trigger
on `settings` that raises unless a transaction-local setting is present — `current_setting('ims.system_setting_write', true) = 'on'` — with every owning writer issuing `SET LOCAL ims.system_setting_write = 'on'` first. There is precedent on this table (the
`xero_pin_write_consumes_release` trigger, migration `20260819210000`). The cost is that `SET LOCAL`
only scopes to an explicit transaction, and several system writers today are bare `db.setting.upsert`
calls on the pooled client: adopting the trigger means converting each of them to a transaction, or the
flag leaks to whatever request next borrows that pooled connection. Until that is done the allowlist
above is the single enforcement point.

### Monitoring

- [ ] System Health page (Settings > System > Health) shows green for FX sync, accounting sync, integration outbox, and recent cron runs.
- [ ] Email notifications working — admin recipients receive critical-finding notifications from the invariant check cron.
- [ ] Application logs are being collected (stdout/journald → your log aggregator).


## Fresh-install rehearsal

`npm run rehearse:first-install` rehearses the **first install of a production instance** — `prisma migrate deploy`, `npm run db:seed`, `scripts/provision-instance.mjs` — on a PostgreSQL cluster created for the occasion and thrown away afterwards, and writes a readiness report. It does **not** run `scripts/install.sh`, `update.sh` or `deploy.sh`, touches no service, and never connects to the database the checkout's `.env` names. It is the rehearsal behind o3d-zjsb5.2 (provision production, AC2–AC6) and o3d-zjsb5.3 (the base currency is fixed before any data exists), and the restore drill the opening-stock load depends on.

```bash
# As the account that owns the checkout (NOT root), with PostgreSQL server binaries installed
# (Debian: apt-get install postgresql) and `npx prisma generate` already run:
npm run rehearse:first-install
# Optional: --root <dir> (parent of the throwaway cluster, default /var/tmp) and
#           --report-dir <dir> (default /var/tmp/ims-rehearsal-reports).
```

A first measured run, 279 migrations, took 18 seconds. It runs one `tsx`, `prisma` or `npm` process at a time beside the cluster; on a memory-constrained shared host take the same lock the test tiers take.

### What it builds, and what it refuses to touch

- **A cluster of its own** in a fresh `ims-rehearsal-*` directory under `--root`, on a private loopback TCP port, with `scram-sha-256` password authentication exactly as CI configures it (the report records that the stored password is a SCRAM verifier and that every `host` rule in `pg_hba.conf` is scram). `--root` is refused when it is on a RAM-backed file system (`tmpfs`, `ramfs`): the cluster and its dump would be held in memory. Every run creates a new directory, so a re-run never meets the previous run's cluster.
- **Its own superuser role** with a random password. The password and the other generated secrets live in a mode-600 `rehearsal.env` inside the run directory and in the environment of the child processes — never on a command line, so they are not visible in `ps`. The file is shredded in the teardown (`shred -u`; on a copy-on-write file system an overwrite is not a guarantee, which is acceptable because the cluster it unlocks is deleted in the same breath).
- **No inherited database.** The script never reads `DATABASE_URL` from the environment it was started in; if one is set the report says it was ignored. Every child process gets a **whitelisted** environment (`PATH`, `LANG`, `LC_ALL`, `TZ`; `HOME` and the npm cache are the run directory's own, so a user `.npmrc` (script shell, registries) is never read; the caller's `NODE_OPTIONS`, `NODE_PATH`, `LD_*` and proxy variables are never forwarded, because a `--require` there would run code in every child before any guard here, and the children get only the rehearsal's own `--max-old-space-size`) plus the throwaway cluster's own values, and immediately before a child is spawned or a connection opened the URL it would use is checked against the cluster's host, port, role and database names — anything else is refused, and so is an environment carrying `SMTP_*`, a connector credential or outbound grant, `NOTIFICATION_EMAIL`, or a libpq override (`PGHOST`, `PGPORT`, …). `IMS_SKIP_ENV_FILE=1` is set for the children so that `scripts/prisma-dev-db.sh` (behind `npm run validate:db`) does not source the checkout's `.env.local` / `.env` over the rehearsal's `DATABASE_URL`, and `dotenv` is pointed at an empty file so the `dotenv/config` imports in `prisma.config.ts` and `prisma/seed.ts` cannot pull an SMTP host, a connector key or a second database URL out of the checkout's `.env`.
- **No email, no connectors, no network.** SMTP stays unset, so `provision-instance.mjs` logs that it skipped the provisioning email (the rehearsal asserts that line and the absence of "Provisioning email sent"); no WooCommerce, Mintsoft, Xero or other credential exists in any environment; nothing leaves the loopback interface.

### Exit codes

This table is the only place the codes are documented; `REHEARSAL_EXIT` in `lib/ops/first-install-rehearsal.ts` is its source and `tests/scripts/rehearse-first-install.test.ts` fails if the two disagree.

| Code | Meaning |
| --- | --- |
| 0 | GREEN: every required step passed and the teardown left nothing behind. |
| 1 | RED: a required step failed, was skipped, or threw. The report says which. |
| 2 | Refused to start: bad arguments, no PostgreSQL server binaries, run as root, or the work directory is on a RAM-backed file system. Nothing was created. |
| 3 | The teardown could not remove everything it created (cluster, env file, directory or a process). The report names what is left. Takes precedence over RED. |

### The readiness report

Two files per run, `readiness-report.json` and `readiness-report.md`, under `<report-dir>/<run id>/` (the Markdown is also printed). Both are written under temporary names and renamed into place with the JSON last; if either write fails, everything is removed and an amended RED pair is attempted, so no GREEN file ever sits beside a failed one. A run interrupted by SIGINT/SIGTERM is RED even if every step that ran passed. The JSON carries `schemaVersion` (2: the report records the build it rehearsed), `build` (the git `commit`, source `tree` and whether the checkout was `clean`; null when git could not say, which the readiness gate refuses), `verdict`, `exitCode`, one entry per step (`id`, `item`, `required`, `status`, `reason`, `detail`) and the `teardown` record; a consumer needs only `verdict === "GREEN"` and, for the detail, `steps[].status`.

| Item | Step | What a PASS means |
| --- | --- | --- |
| 1 | `prisma migrate deploy`, `prisma migrate status` | Every migration directory on disk is recorded as applied (the count is in the report) and `migrate status` says the schema is up to date. |
| 2 | Seeded rows | Exactly one Organisation, `default`, with base currency **GBP** and country GB; the `DEFAULT` warehouse, flagged default and the only one; at least four tax rates including the default `UK Standard Rate (20%)`; the six seeded currencies; one active admin from `provision-instance.mjs`; no SMTP settings. **A non-GBP base currency makes the report RED.** |
| 3 | `isBaseCurrencyLocked()` | Asked of the application's own code (`scripts/lib/first-install-probe.ts`, run against the throwaway database) after the six tables the lock reads were counted at zero and the `base_currency_locked` setting was found absent: the answer must be `false`. |
| 4 | `system_identifier` | Read from `pg_control_system()` and recorded, so a later restore or clone can be told apart from the cluster that produced the report. |
| 5 | `npm run preflight:production` | Exits 0. It checks **infrastructure** readiness only (secrets, URLs, writable directories, the push-state enum); it is not a data check. Warnings are listed in the report. |
| 6 | `npm run validate:db` | Exits 0, which includes the check that the non-negative and `reservedQty <= quantity` constraints are installed and fire. The concurrency tier inside it is skipped unless `IMS_CONCURRENCY_SCRATCH_DB` is set, and the report says so. |
| 7 | `npm run invariant-check:preflight` | Exits 0: no critical invariant findings on the freshly provisioned database. |
| 8 | `npm run outbound:status` | **Optional while `package.json` has no `outbound:status` script** (the step is recorded as skipped, with the reason, and does not make the report RED); **required the moment the script exists**: it is run as `npm run outbound:status -- --json --expect-held`, must exit 0, and its JSON report must list each of woocommerce, mintsoft and xero exactly once with `state` equal to `held` and `anyGranted` false (a granted or unreadable grant, a missing, duplicated or unknown connector fails; the output must contain exactly one JSON report with nothing around it but the npm banner and the `Exit code` line, so two reports or any other text fail; free text is never searched for the word held). |
| 9 | Restore drill | `pg_dump -Fc` of the installed database, `pg_restore` into a **second** database on the same cluster, then for **every** table of either side the row count and an md5 over the sorted per-row digests must be identical. A table missing from or invented by the restore is a mismatch. A comparison that saw no tables, or only empty ones, fails as vacuous. The report also lists any table whose content changed between provisioning and the dump (informational). It compares the `public` schema's tables; it does not compare sequences, roles or large objects. |

**Every fact a step records is counted, with four deliberate exceptions recorded for information only and never part of a verdict:** the `warnings` of `preflight:production` (they are listed so a human can accept them), `concurrencyTierSkippedInsideValidateDb`, the invariant preflight `summary` line (its exit code is what counts) and `tablesChangedSinceProvisioning`. Anything else in a step's detail (the base-currency table counts and lock-setting row count, the parity counts, the seeded rows, the migration counts) is part of that step's pass condition.

**Report files.** Each run's report directory is created exclusively (mode 700; a pre-existing path of that name, including a planted symlink, refuses the publication) inside a `--report-dir` that must be a real directory owned by the running account and not writable by group or others. Files are created `O_EXCL|O_NOFOLLOW` under random temporary names, fsynced and renamed, Markdown first and the JSON last. **The JSON is the authoritative commit record** and carries `companionMarkdownSha256`; a consumer should treat a report as complete only when that digest matches the Markdown beside it. The two renames are not atomic as a pair: after a crash or power loss a directory can hold a Markdown without a JSON, or `*.tmp` leftovers, and neither is a report.

**Every process the rehearsal launches (none through a shell, none with the caller's environment).** `stat -f` (file-system type of `--root`); the PostgreSQL tools `initdb`, `pg_ctl` (start and stop), `psql`, `openssl` (not used by the rehearsal's own cluster), `pg_dump` and `pg_restore`, under a short whitelist (`PATH`, `HOME`, `LANG`, `LC_ALL`, `TZ`, `TMPDIR`; the dump and restore add only the `PG*` connection variables of the throwaway cluster); `id -un` for the cluster's bootstrap account; and the step children `prisma`, `tsx`, `node scripts/provision-instance.mjs`, `npm run ...`, which get the step environment described above. PostgreSQL binaries are found by reading `/usr/lib/postgresql` and `PATH` directly, not by running a shell. An exported `BASH_ENV`, `ENV`, `SHELLOPTS`, `PS4`, `LD_PRELOAD` or `NODE_OPTIONS` therefore executes nowhere in the run; a test exports canaries for the first four and proves, with a positive control, that none fires in any phase.

**What the rehearsal trusts on the host, and what it refuses.** `--root` and `--report-dir` are checked, with every ancestor up to `/`: each must be a real directory (never a symlink), owned by root or the running account, and not writable by group or others unless it is a root-owned sticky directory (`/tmp`, `/var/tmp`); otherwise the run is refused (exit 2, nothing created). The `--report-dir` itself must also be owned by the running account and not writable by anyone else. The secret env file is created exclusively and its device and inode recorded; the teardown overwrites it only through a descriptor opened `O_NOFOLLOW|O_NONBLOCK` whose device, inode and creation time still match (inode numbers are reused after a delete, so the number alone is not identity), and otherwise leaves it alone and exits 3 (there is no overwrite-by-path fallback). The report directory's device and inode are re-checked before the first write, before each rename and before the paths are returned; a replaced directory fails the publication (RED, exit 1) and nothing in it is cleaned up. **Residual, accepted:** Node has no directory-descriptor-anchored `openat`, so these are path walks with identity checks, not held handles. A same-host attacker who can already modify an ancestor that passed the check (the account itself, or root) is out of scope; the tool refuses configurations in which any OTHER account could.

A step that does not run because an earlier prerequisite failed (`migrate deploy`, `db:seed`, `provision-instance.mjs`) is recorded as **skipped** and, being required, keeps the report RED. Every step in the catalogue appears in every report, so an aborted run cannot read as green.

### The teardown

It runs in a `finally`, whether a step failed, a step threw, or the cluster never finished starting. A SIGINT or SIGTERM stops the running step, marks the remaining steps skipped and still writes the report (RED, exit 1) and the teardown record; a second signal skips the report and only tears down (exit 3). It stops the cluster, shreds the env file, removes the run directory, and then looks for what is left: any process that was a descendant of the postmaster this run started, and any process whose command line names the run directory. The postmaster is identified from the cluster's own `postmaster.pid` (also when the start itself failed after the fork): it must be a `postgres -D <run dir>` process whose start time matches the pid file's record. It is stopped with `pg_ctl` only after that identity is re-confirmed; there is no unconditional stop and no numeric-pid SIGKILL, and the run directory is not removed while any process still runs from it. Between the identity check and `pg_ctl` the pid file is re-confirmed to still name that pid, directory and start record. **Residual, accepted:** the check and `pg_ctl` remain two acts (there is no pidfd to hand to `pg_ctl`), so a replacement taking the directory in the microseconds after the last read would be stopped; the cluster is on a private port in a directory only this run knows. A postmaster that cannot be stopped that way, or that has been replaced, is left alone; survivors are listed as **orphan PIDs** in the report and turn the exit code to 3.

### How it feeds the go/no-go gate

The go/no-go gate (`npm run readiness:gate`, next section) wants evidence that a fresh install of **this build** provisions cleanly and that a backup taken before any load restores to an identical database. A GREEN report from the commit being deployed is that evidence for items 1-7, 8 and 9. The gate reads the **newest** report in the rehearsal report directory, checks that its JSON and Markdown still match (the digest the JSON records), recomputes the verdict from the steps and the teardown instead of trusting the `verdict` field, requires every one of the twelve steps to be present, required and passed (a rehearsal made before `outbound:status` existed, whose item 8 was skipped, does not satisfy it) and requires the report to have finished within 14 days. The report must also be about THIS build, and about nothing wider than that: since report format 2 the rehearsal records the git commit and source tree it ran from (and whether the checkout had uncommitted changes), and the gate requires both to equal those of the checkout it runs from, and both checkouts to be clean. A report of another commit, a report of a dirty checkout and a version-1 report (which records no build) are refused, each with its own message, so a GREEN rehearsal of last week's code cannot stand in for this build. The identifier is the source commit, the source tree and the real path of the checkout, not the `next build` id (`.next/BUILD_ID`), the `.env` configuration or the cut-over driver digest, because none of those exists in, or is built from, the source tree a rehearsal runs on; every GO says so. If the commit and tree match but the rehearsal ran in a different checkout path (a copy under `/var/tmp`, say, while the gate runs in the deployed tree), the gate raises a warning, `rehearsal-different-checkout-path:<rehearsal path>-><this path>`, that needs a written acceptance: ignored files such as `.env` and `.next` can differ between two checkouts of the same commit. **What the gate trusts about a rehearsal report.** The digest only ties the Markdown to the JSON that names it; both sit in the same directory, so whoever can write one can write the other, and the digest authenticates nothing. What makes a report worth reading is who could have written it. Before reading anything the gate checks the report directory and every ancestor, EVERY run directory (not only the newest) and both report files of each: they must be real (never symlinks), owned by root or the account running the gate, and not writable by group or others, with the directory rules of the rehearsal's own `--report-dir` check. Any violation refuses the whole location with "the rehearsal report location is not trusted" and the check fails; the default `/var/tmp/ims-rehearsal-reports` is held to the same rules. A process running as the same account, or as root, can still forge a report; that is outside what this defends. A newer RED or unverifiable report is never replaced by an older GREEN one. Attach the JSON, not a paraphrase of it. The rehearsal does not replace the gate's data checks (the invariant preflight against the **real** database, the reconciliation pack) and says nothing about the real host: `install.sh`, the service account, nginx and the production `.env` are outside it.

### Readiness gate

<!-- readiness-gate:overview -->
`npm run readiness:gate` collects the checks that decide whether an installation may go on to the next phase of the switchover and reduces them to one verdict: GO, GO-WITH-ACCEPTED-WARNINGS or NO-GO. It performs no database write and no write to the checkout, makes no call to WooCommerce, Mintsoft or Xero, and writes only its own report. Its schema check runs `prisma migrate status`, the schema diff and the drift check, which only read, and reads the constraint catalogue; it does not run `npm run validate:db`.

The verdict is only as wide as the checks that ran. A GO says that every check listed as required for the phase passed on the database and environment the gate was run against, at the time stated in the report. The rehearsal is tied to this build by source commit and source tree only; it is NOT tied to the build artefact (.next/BUILD_ID) and NOT to the .env configuration. It does not inspect the environment of any running service (the outbound check reads the environment of the gate process, so run the gate with the environment the services use), and it does not say the data matches Qoblex, Mintsoft, WooCommerce or Xero unless a reconciliation pack item for that comparison is listed in the report as run and passed. A check that is missing, unreadable or unknown is a NO-GO, never a skipped check; the only checks that may be absent are the ones the report names as optional until they exist.

Not checked by the gate: that the CHECK constraints actually fire, and that the Prisma client is generated. Both belong to `npm run validate:db`, which inserts probe rows in a transaction it rolls back and regenerates the client, so it is an operator pre-step run on a scratch database (the fresh-install rehearsal runs it on its own cluster). Also not checked: the build artefact, the `.env` configuration, every item the report lists as NOT YET AVAILABLE, and the authenticity of the rehearsal report beyond who could have written it (see the rehearsal section).
<!-- /readiness-gate:overview -->

#### Running it

<!-- readiness-gate:usage -->
`npm run readiness:gate -- --phase <P0|P1|P2> [--expect-granted <connector[,connector]|none>] [--acceptances <file>] [--rehearsal-dir <dir>] [--apply-report-dir <dir>] [--pack-report-dir <dir>] [--report-dir <dir>] [--json]`

The phase is required; there is no default, because the same installation can be ready for one phase and not for the next. `DATABASE_URL` must be set in the environment of the gate: it does not read `.env` files, and it never puts a credential on a command line. `--expect-granted` is required for P2 and refused for P0 and P1: it names the connectors (woocommerce, mintsoft, xero) that are meant to be able to write at P2, or `none`, and the outbound check then requires exactly those to be granted and the others held. `--acceptances` names the written warning-acceptance file (default `ops/readiness-warning-acceptances.json` in the checkout; absent means no warning is accepted). `--rehearsal-dir` is where `npm run rehearse:first-install` publishes its reports. `--apply-report-dir` is where `npm run first-load:apply -- --apply` published its report (default `/var/tmp/ims-first-load-apply-reports`); only P0 requires it. `--pack-report-dir` is where `npm run reconcile:pack` publishes its reports (default `/var/tmp/ims-reconciliation-pack-reports`); the gate reads the newest one (see the reconciliation pack section). `--json` prints the JSON report on standard output and nothing else; progress and the Markdown go to standard error. The report is published as `readiness-gate.json` and `readiness-gate.md` under `<report-dir>/<run id>/`, Markdown first and the JSON last; the JSON names the Markdown by its sha256 and is the commit record.
<!-- /readiness-gate:usage -->

The gate collects, in order: the invariant report, the schema state (migrate status, schema diff, drift check and the CHECK constraint catalogue), the outbound status, the newest rehearsal report, the accounting reconciliation completeness proof, the read-sync status (only when the tree defines `read-sync:status`) and the reconciliation pack slots. A check that throws, times out or cannot be read is recorded as unreadable and is a NO-GO; it is never recorded as empty or skipped.

#### What each phase requires

<!-- readiness-gate:phases -->
What each phase requires. Every row is collected on every run; a required check that is missing, unreadable, unavailable or failed is a NO-GO, and so is an optional-until-present check whose signal exists but cannot be read. A reconciliation pack item that is not yet available is listed, and blocks only at P2.

| Phase | Meaning |
|---|---|
| P0 | the first load: IMS has been loaded and nothing outside IMS may be written |
| P1 | the parallel run: IMS reads and reconciles, every write to WooCommerce, Mintsoft and Xero stays held |
| P2 | the switch of writers: exactly the declared writers may write, and the reconciliation pack must be available |

| Check | P0 | P1 | P2 |
|---|---|---|---|
| Invariant report complete, with zero critical findings | required | required | required |
| Database schema is applied, has not drifted, and the CHECK constraints are installed (read-only) | required | required | required |
| Outbound writes are in the state this phase expects | required | required | required |
| Latest first-install rehearsal is present, GREEN and fresh | required | required | required |
| The first load was applied, verified, and its published report is intact and about this database | required | listed only | listed only |
| Accounting reconciliation is proven complete | required | required | required |
| Read-sync streams are fresh | optional until present | optional until present | optional until present |
| R1: Stock on hand, IMS against Mintsoft, per SKU per warehouse | listed only | listed only | required |
| R2: Stock on hand, IMS against Qoblex, per SKU per warehouse | listed only | listed only | required |
| R3: StockLevel.quantity against the sum of CostLayer.remainingQty | listed only | listed only | required |
| R4: StockLevel.reservedQty against the sum of OrderAllocation.qty | listed only | listed only | required |
| R5: Inventory valuation, IMS against Qoblex | listed only | listed only | required |
| R6: Inventory subledger against Xero Inventory plus Allocated Inventory | listed only | listed only | required |
| R7: Open purchase-order commitment | listed only | listed only | required |
| R8: Part-received purchase-order outstanding quantity, per line | listed only | listed only | required |
| R9: Open sales orders, IMS against WooCommerce | listed only | listed only | required |
| R10: Xero control accounts (Inventory, Allocated, Transit, COGS, Unearned Revenue) | listed only | listed only | required |
| R11: Stock in Transit against the open-PO goods-in-transit schedule | listed only | listed only | required |
| R12: VAT by country and reporting category, IMS against Xero and WooCommerce | listed only | listed only | required |
| R13: VAT rate set identity: WooCommerce, IMS and Xero | listed only | listed only | required |
| R14: SKU coverage across Qoblex, WooCommerce, Mintsoft and IMS | listed only | listed only | required |
| R15: The invariant report: zero critical findings, every warning accepted | listed only | listed only | required |
| R16: Xero exchange rates, IMS central rate against the rate on each foreign-currency Xero document and payment | listed only | listed only | listed only |
<!-- /readiness-gate:phases -->

The outbound check reads the grant variables (`WC_WRITEBACK_ALLOWED_ORIGIN`, `MINTSOFT_WRITE_ALLOWED`, `XERO_WRITE_ALLOWED_TENANT`) of the process that runs the gate and the activity log of the database `DATABASE_URL` names. If the gate is run from a shell whose environment differs from the services', its answer describes the shell, not the services. The children the gate runs (`npm run db:migrate:status`, `db:schema:diff`, `db:schema:drift` and, when the tree defines it, `read-sync:status`) receive a short whitelist of the gate's environment (`PATH`, `HOME`, `LANG`, `LC_ALL`, `TZ`, `TMPDIR`, `npm_config_cache`, `DATABASE_URL` and, only if you set it, `PRISMA_DEV_DB_CONFIRM`, plus fixed switches that stop them sourcing a `.env` file over `DATABASE_URL`): no connector credential, write grant, SMTP setting or `NODE_OPTIONS`. The schema commands refuse a `DATABASE_URL` that is not on the host the gate runs on unless `PRISMA_DEV_DB_CONFIRM=1` is exported (that refusal is a failure of the schema check, quoted in the report); the gate never sets it for you. The three schema commands were checked to be read-only by running them against a scratch database (no table statistics moved and no file of the checkout changed); the gate's test also runs the whole gate over connections that refuse writes, and fails if any file of the generated client, schema, code or manifests changes.

The read-sync check reads `npm run --silent read-sync:status -- --json` and requires it to declare `schemaVersion` 1 and to be internally consistent (the report time, each entry's age against its last success and the report time, the future-timestamp flag, and the counts against the entries). That is the output of the WP8 producer at commit e6eb79b2 (the branch of the read-sync liveness work, not yet merged), which this reading was matched against by running its report assembly and feeding the result to the gate's parser; the contract is unproven until that branch merges, and a change to its JSON must change the gate with it. The scheduler object must be present with `examined` true, `unreadable` and `blockProblem` exactly null, and `unscheduled` and `disabled` empty lists. Every field the gate relies on must be present with its type: a producer that omits or renames one makes the output unreadable (a NO-GO), never fresh by default. It is optional only while the tree has no `read-sync:status` script. Once the script exists it is required in full: all six streams must be reported, each fresh with a valid last-success time that is not in the future and within the age limit the status reports.

The reconciliation pack (R1-R15, see the pack definition for each item) feeds the gate from its newest published report (`npm run reconcile:pack`, read from `--pack-report-dir`): the gate maps each item's outcome (pass is pass, fail is fail, inconclusive is unreadable, not-applicable is not available), requires the report to be trusted, about this installation and this phase, and inside the item's cadence, and requires R3, R4 and R15 to agree with the gate's own reading of the invariant report (the codes `stock_cost_layer_quantity_mismatch` and `stock_reserved_source_mismatch`, and the invariant check itself). The rules, and what blocks, are under "The readiness gate reads the pack" in the reconciliation pack section below. An item the pack's report lists as inconclusive because its build has no runner for it yet is listed as NOT YET AVAILABLE and was not checked; that does not block P0 or P1 and does block P2. An item that is unreadable (no usable report, a stale or untrusted one, or an item the pack could not prove) blocks in every phase; a pack item that is available and fails is reported at P0 and P1 and blocks at P2.

The reconciliation completeness check is the same code the rollout-readiness endpoint uses. It passes only when a reconciliation run exists, the run history shows no truncation that a later complete run over the same period has not covered, no run record is unreadable, and the check could read the history at all. A newest run that predates completeness recording is reported as a warning (its completeness is unknown, not shown to be incomplete) and needs a written acceptance; a partial run, a missing run, or an unreadable history is a failure. For an unresolved truncation the way to clear it is a later accounting reconciliation run, recorded as complete for that check, whose period contains the truncated one (several later runs together can cover it); for a missing or partial run it is a new run. The gate does not start a reconciliation.

<!-- readiness-gate:endpoint -->
The `/api/admin/rollout-readiness` endpoint reads the same reconciliation findings as the gate. These are blockers there: the endpoint answers HTTP 412 and `?allowWarnings=true` does NOT turn them into 200, because that override records no reason: an unresolved truncation, an unreadable completeness record, a run history that could not be evaluated, a newest-run read that failed, a newest run whose own report recorded a truncation, and a newest run that did not complete. **Changed behaviour:** a newest run with status PARTIAL used to be only a warning that `?allowWarnings=true` accepted; a PARTIAL or FAILED newest run is now a blocker, and so is a RUNNING, queued or otherwise unrecognised one (the newest run is the newest row of ANY status, never an older finished row chosen because a newer one is unfinished; the message says a reconciliation run is in progress or was left unfinished). Today the database only accepts COMPLETED, FAILED and PARTIAL (a check constraint), and this build writes a run row once, in one transaction, so an unfinished row cannot appear unless a later migration allows one; the check is fail-closed so that such a row could never be skipped. Only a COMPLETED run can ever clear an earlier truncation. Several runs created at the same instant are read together and judged as their worst member, and runs created at the same instant never clear each other's truncations, because their order cannot be proven.
<!-- /readiness-gate:endpoint -->

#### Written warning acceptance

<!-- readiness-gate:acceptances -->
A warning is not a failure, and it is not a pass either: it must be accepted in writing, one warning at a time, or the verdict is NO-GO. The acceptance file is JSON with `schemaVersion` 1 and an `acceptances` list. Every entry names exactly one warning by its `warningId` (no patterns, no wildcards) and carries `acceptedBy` (who), `acceptedAt` (when, an ISO time not in the future), `reason` (why, at least 15 characters), `expiresAt` (an ISO time after `acceptedAt`, no more than 90 days later) and `phases` (the phases it applies to, a non-empty list of P0, P1, P2). An entry that has expired, that is not yet in effect, that does not list the phase being asked about, or that is malformed does not accept anything; a file that cannot be read, has an unknown field, names the same member twice at any depth (two `expiresAt` in one entry, say: which one was meant is not known, so the parser does not keep the last), or names the same warning twice is rejected as a whole and nothing is accepted. A failure is never acceptable: only findings the report labels as warnings can be covered. An acceptance for a warning that no longer occurs is listed as unused and does no harm. Because an acceptance is a decision, the file is used only if it is a regular file (a symlink is never followed) owned by root or the account running the gate, not writable by group or others, in a directory whose every ancestor only root or that account can modify; otherwise the whole file is rejected, the report says why, and nothing is accepted.
<!-- /readiness-gate:acceptances -->

An example of the file (`ops/readiness-warning-acceptances.json` in the checkout, or any path given with `--acceptances`). The warning ids come from the report; invariant warnings are named `invariant:<domain>:<code>:<subject>`.

```json
{
  "schemaVersion": 1,
  "acceptances": [
    {
      "warningId": "accounting-reconciliation:completeness-not-recorded",
      "acceptedBy": "Name of the person who read the finding",
      "acceptedAt": "2026-10-08T09:30:00Z",
      "reason": "Why this is acceptable for the phases named, in a sentence someone else can check.",
      "expiresAt": "2026-11-08T09:30:00Z",
      "phases": ["P0"]
    }
  ]
}
```

A written acceptance is a person's recorded decision that a warning does not stop the phase. It is not evidence that the warning is harmless, and the gate does not judge the reason.

#### Exit codes

<!-- readiness-gate:exit-codes -->
| Exit code | Name | Meaning |
|---|---|---|
| 0 | go | GO: every check for the phase passed and there are no warnings; the report was published |
| 1 | no-go | NO-GO: at least one check failed, was unreadable, was missing, was not available where it is required, or raised a warning with no current written acceptance. The report names each |
| 2 | refused | the gate refused to run (bad or missing arguments, no DATABASE_URL, an unsafe report directory); no check was run and nothing was written |
| 3 | report-not-published | a GO verdict was reached but the report could not be durably published; the verdict is printed but is not a GO, because a verdict nobody can read back is not evidence |
| 4 | failed | the gate itself failed unexpectedly before it could reach a verdict; treat as NO-GO |
| 10 | go-with-accepted-warnings | GO-WITH-ACCEPTED-WARNINGS: every check passed and every warning is covered by a current written acceptance; the report was published. Deliberately not 0, so a script that wants a clean GO cannot mistake this for one |
<!-- /readiness-gate:exit-codes -->

The same table is printed by `npm run readiness:gate -- --help`.

## VAT difference report

`npm run vat:diff` (add `-- --json` for machine-readable output; `-- --scheme uk|ioss|voec|other|all` limits it to one scheme, default `all`) compares the VAT rates held in Xero, IMS and WooCommerce and lists every difference with a closed reason code, as FOUR reports, one per VAT scheme (UK, IOSS, VOEC (Norway), other foreign: EU OSS and any other foreign registration), plus an **unclassified** section that is shown with every selection. The owner ruled on 2026-10-25 that all three use the SAME set of VAT rates and that Xero is the master; WooCommerce tax-rate writes are operator-manual at P1 (you correct WooCommerce by hand from this report) and IMS's own from P2 (a later build). The command is read only:

- **Xero** is read from IMS's stored copy of its tax-rate list, proven first (header, row count, digest, last-success stamp, the organisation connected now, read within 26 hours). Xero is never called. An unusable list refuses the whole report (`XERO_NOT_CONNECTED`, `XERO_LIST_MISSING`, `XERO_LIST_NOT_STAMPED`, `XERO_LIST_STALE`, `XERO_LIST_WRONG_ORGANISATION`, `XERO_LIST_UNREADABLE`).
- **IMS** is read in one `REPEATABLE READ`, `READ ONLY` transaction: the tax rates, their active components and the WooCommerce tax-rate mappings (the same mapping reconciliation-pack item R13 uses).
- **WooCommerce** is read with `GET /wp-json/wc/v3/taxes`, every page, twice, through the reconciliation pack's GET-only transport (any other method or path is refused before it is sent), with the stored credentials read in a read-only transaction. A failed or unproven read refuses the report (`WOO_READ_FAILED`, with the pack's reason code in `wooReason`).

The environment is replaced by a short whitelist (`PATH`, `LANG`, `LC_ALL`, `TZ`, `HOME`, `DATABASE_URL`, `SETTINGS_ENCRYPTION_KEY`, `ENCRYPTION_KEY`); the account must be root or the checkout's owner; an argument that looks like a credential is refused.

| Exit code | Meaning |
|---|---|
| 0 | All three systems were read and proven and use the same rates in every shown scheme. |
| 1 | Read and proven; any scheme report (or the unclassified section) lists a difference. Each scheme contributes its own status; any difference anywhere gives 1. |
| 2 | Refused: a side could not be read or proven. Nothing was compared; this is NOT "no differences". |
| 3 | The command could not start or failed. |

`--json` is keyed by scheme: `schemes.uk`, `schemes.ioss`, `schemes.voec`, `schemes.other`, `schemes.unclassified`, each with its title, its own `exitStatus`, its `differences` and its per-reason `counts`.

**How a rate gets its scheme** (`lib/tax/vat-scheme.ts`; every row cites the rule in `schemeSource`). In order: (1) IMS `TaxRate.reportingCategory`: today's values are DOMESTIC, REVERSE_CHARGE, EC_SALES and OSS; IOSS and VOEC are not written by IMS, so the tokens `IOSS` and `VOEC` are accepted as explicit markers you set on the rate, and `OSS` means other foreign. (2) The country (IMS `countryCode`, the WooCommerce rate's country, or for a Xero type no IMS rate carries, its upper-case ISO name prefix as in `lib/connectors/xero/tax-rate-report-type.ts`): `NO` is VOEC, `GB` is UK, an EU member state defaults to **other foreign (EU OSS)**, and goes to IOSS only when its `reportingCategory` is marked `IOSS` (owner ruling 2026-10-25); any other country is other foreign. (3) A rate with no country is UK when its category is empty, DOMESTIC, REVERSE_CHARGE or EC_SALES and Xero's report type is not `MOSSSALES`. A WooCommerce rate is judged as the IMS rate it is mapped to, a Xero type as the IMS rate that carries it. `UNCLASSIFIED_SCHEME` remains only for: an `IOSS`, `VOEC` or `OSS` marker on a GB rate (conflict), an unknown category on a GB rate or a rate with no country, a rate with no country whose Xero report type is `MOSSSALES`, a Xero-only type with no ISO name prefix and no UK report type, and a WooCommerce rate with no country and no IMS mapping. Those are listed in the unclassified section and never dropped.

**Presence is per side.** A Xero type is present in IMS on a side only if an active IMS rate usable on that side carries it: a type Xero can apply to revenue needs a rate used for Sales (or Both), one it can apply to expenses needs a rate used for Purchases (or Both); a rate used on a side its Xero type cannot be applied to is `USED_FOR_NOT_ALLOWED_BY_XERO`, and a WooCommerce rate mapped to an IMS rate that is not usable for sales is `WOO_MAPPED_TO_NON_SALES_RATE`.

Rules of the comparison (owner rulings 2026-10-25): shipping always carries the VAT rate of the goods, so a WooCommerce rate above zero that does not apply to shipping is `WOO_SHIPPING_NOT_TAXED`. Regional WooCommerce rates (state, postcode or city, for example the Canary Islands) are legitimate and are not a difference by themselves: they are compared like any other rate against the IMS rate they are mapped to (percentage, class, compound, shipping, and the country, which must be equal), and the region is shown on the row as information.

Reason codes: `MISSING_IN_IMS`, `MISSING_IN_XERO`, `INACTIVE_IN_XERO`, `IMS_RATE_NO_XERO_TYPE`, `AMBIGUOUS_IMS_MAPPING`, `XERO_RATE_NOT_STATED`, `PERCENTAGE_MISMATCH_IMS_XERO`, `USED_FOR_NOT_ALLOWED_BY_XERO`, `MISSING_IN_WOO`, `WOO_RATE_NO_IMS_MAPPING`, `WOO_RATE_GONE`, `WOO_MAPPED_TO_INACTIVE_IMS_RATE`, `WOO_MAPPED_TO_NON_SALES_RATE`, `WOO_PERCENTAGE_MISMATCH`, `WOO_COUNTRY_MISMATCH` (country scope; no country means everywhere, on either side), `WOO_CLASS_MISMATCH` (a mapping with no recorded class means standard), `WOO_COMPOUND_MISMATCH`, `WOO_SHIPPING_NOT_TAXED`, `UNCLASSIFIED_SCHEME`. `npm run vat:diff -- --help` prints each with its meaning. The same report is on **Settings > Accounting > Tax > VAT rate differences** (permission `settings.company`), with one tab per scheme and an Unclassified section.

## WooCommerce tax-rate writer (`npm run woo:tax-plan`), held at P1

Owner rulings: WooCommerce, IMS and Xero use the same set of VAT rates; the owner maintains the WooCommerce tax rates by hand at P1 and IMS owns them from P2; shipping always carries the goods' VAT rate. The ownership map row is `woocommerce` / `tax-rate` (P1 `operator-manual`, P2 `IMS`).

```
npm run woo:tax-plan                                      # read-only preview: the plan and its digest
npm run woo:tax-plan -- --json                            # the same, machine-readable
npm run woo:tax-plan -- --apply --confirm <digest>        # apply exactly the previewed plan, behind the hold
```

- **The plan** is computed from the active IMS rates used for sales (not reverse charge) and the WooCommerce rates read with GET only, using the comparisons of R13 (`lib/reconciliation-pack/vat-set-identity.ts`): CREATE a missing rate, UPDATE one whose name, percentage, country, region (the end of the IMS name, "PT-30 VAT" is region 30), class, compound or shipping differs, DELETE one mapped to an out-of-scope IMS rate (or a second counterpart of one IMS rate). Shipping is always on for a positive rate; a 0% rate may keep it off. A region, country, postcode or city on a store rate is never cleared.
- **Ownership.** A store rate is owned when it is mapped in `ShoppingTaxRateMapping` (connector `woocommerce`) with `store_identity` equal to the normalised URL of the store configured now (scheme, host, path), or was created by the writer and recorded in `woo_tax_rate_writes` with that identity. Rows with no identity (every row from before the rule) or another store's identity are not owned: `MAPPING_NOT_ADOPTED` findings, no change, no CREATE next to them. A rate is only updated or deleted while the mapping's snapshot (name, country, percentage, class: the four fields every mapping row stores) still equals the live rate; otherwise `RE_ADOPTION_REQUIRED` and it is left alone. `npm run woo:tax-plan -- --adopt` (preview, then `--adopt --apply --confirm <digest>`) stamps the rows and rewrites their snapshot from the live rate, in one transaction, sending nothing to WooCommerce. **A stamp ends when its row stops meaning what it was stamped for:** every other writer of the mapping table (the tax-rate import, the mapper's re-map, a tax re-key, `scripts/copy-tax-rates.ts`, the rehearsal driver) clears `store_identity` in the same write when it changes the row's IMS rate or any of name, country, percentage and class (`lib/tax/storefront-mapping-write.ts`); a write that changes none of them keeps it, and a row an import creates is unstamped. The decision is made by the database in the write itself (one `INSERT ... ON CONFLICT DO UPDATE` / `UPDATE` with a `CASE` on `store_identity`), so a row another transaction creates and adopts first is judged as it then stands. A DELETE the tax-rate writer makes keeps the mapping row (historic orders resolve through it) but unstamps it, so an id the store later reuses is never owned without a new adoption. So replacing a WooCommerce rate and importing makes its mapping `MAPPING_NOT_ADOPTED` until the operator adopts it again. `tests/tax/storefront-mapping-writers-census.test.ts` lists every writer and fails on a new one that does not do this. The REST index (`/wp-json`) was not used as a steadier identity: the GET-only port reads only the reconciliation pack's three collections. No other rate is ever touched (the plan counts them). An unmapped store rate that looks like one the plan would create is a blocker (`UNMAPPED_TWIN`): map it instead.
- **The hold.** Not enforced for WooCommerce (`PRODUCER_HOLD_ENFORCED_DESTINATIONS` does not name `woocommerce` or `all`): the apply is refused. Enforced and held (P1): each change is recorded in `outbound_shadow_writes`, nothing is sent, and no mapping or change record is written. Only when the grant and live-from instant are in force and IMS owns the operation (P2) are the changes sent, one at a time, each recorded with its mapping row in one transaction. A single-runner advisory lock serialises applies; a second apply waits and finds nothing to do. The apply needs the exact digest of the preview and rebuilds the plan under the lock.
- The environment is replaced by the whitelist of `npm run vat:diff` plus `PRODUCER_HOLD_ENFORCED_DESTINATIONS`, `WC_WRITEBACK_ALLOWED_ORIGIN` and `WC_WRITES_LIVE_FROM`. Exit codes: 0 nothing to do or applied (a held apply that only recorded shadows), 1 the preview lists work, 2 refused or a store refusal, 3 the command could not start.
- **Re-checked before every send.** The apply holds an exclusive advisory lock (`WOO_TAX_RATE_WRITE_LOCK_KEY`) for its whole run, and every writer of the mapping table takes the same key shared for its transaction (`lockStorefrontMappingWrites`: the helper's upsert and re-point, the unlink and the factory reset in `app/actions`, the re-key, `scripts/copy-tax-rates.ts`, the e2e fixture; the census fails on a writer that does not). A mapping writer therefore waits for a running apply (and an apply waits for writers already in flight, then reports BUSY). Immediately before each send the apply reads again, inside that lock, what the change rests on, and stops without sending (the result and the CLI report `STOPPED ... BEFORE SENDING IT` with the reason, exit 2) if anything differs: for an UPDATE or DELETE the mapping row must exist with the same IMS rate and this store's stamp and its snapshot must be the planned rate, the store's rates are read again through the same proven GET-only walk and that one rate must equal it, and the IMS rate must still justify the change; for a CREATE the IMS rate must still be in scope with the same desired rate and no mapping may have appeared for it. The factory reset takes the lock too: a row that vanished under a running apply would take away the ownership the next send rests on.
- **One credential set per run.** The credentials are resolved once at the start of a preview, apply or adoption and passed explicitly to the GET reads and to the write port (`lib/connectors/woocommerce/tax-rate-session.ts`); `wcPost` and `wcPut` get them as an argument and never reload the settings for these sends. The store URL in the settings is compared with the pinned one before the apply starts (`STORE_CHANGED`) and before every send; if `wc_url` changed, the run stops and nothing goes to the new store.
- Limits: IMS tax rates themselves (not their mappings) are not locked, so an edit in the instant between the re-check and the send is not excluded (it shows at the next preview), and neither is a change the store owner makes in that instant; a send whose mapping row is no longer the planned one (id, IMS rate, store) is reported as UNRECORDED with the reason, its record is rolled back and the run stops; the rate then shows as an `UNMAPPED_TWIN` or a re-adoption finding until settled; the store must already have the tax classes the plan names. **A duplicate DELETE re-reads the other counterpart** (GET only, under the lock, just before the send) and is refused with `KEEPER_GONE` unless one of them is still in the store as its mapping snapshot describes it, so the writer never deletes the last live counterpart of an IMS rate. **Known limit:** a CREATE is not re-checked for an unmapped store rate that looks like it and appeared after the plan (a store owner or another system writing at that instant; the client has no filtered read, and a full re-walk per send is not done); the `UNMAPPED_TWIN` blocker catches the duplicate at the next plan, and the operator maps or removes one.

## Re-keying tax rates to the Xero organisation's custom tax codes

**A re-key is a pre-go-live (pre-P2) operation.** The apply is refused (`XERO_NOT_HELD`) unless Xero writes are held: `PRODUCER_HOLD_ENFORCED_DESTINATIONS` names `xero` (or `all`) and Xero is not live (no `XERO_WRITE_ALLOWED_TENANT` grant and no `XERO_WRITES_LIVE_FROM` instant, the `agreed_held` state `npm run outbound:status` reports; `xeroHoldState` in `lib/tax/tax-rekey.ts`). While held, every Xero producer writes a shadow that is never delivered, and at go-live the writer-side cut-off (`xeroCutoffFloor` / `xeroBeforeCutoffRefusal`) refuses to deliver any row created before the live-from instant, so no payload built around the re-key, however long its producer paused, can reach Xero. The command reads these variables from its own environment (run it with the application's environment file); the settings action reads the application's. The enqueue guard below is belt and braces.

Xero numbers its **custom** tax types (`TAX001`..`TAXnnn`) per organisation, in creation order. IMS's per-country VAT rates were created against a Demo organisation, so their `accountingTaxType` holds that organisation's numbers; in the live organisation the same codes mean other rates (live `TAX005` is *BG VAT*, IMS's `TAX005` is *CY VAT*), and IMS posts a line's code. `npm run tax:rekey` fixes this by NAME, never by code. After connecting an organisation whose rates were not created for it (and after the first load's tax import), run the preview, read it, and apply it.

```
npm run tax:rekey                                         # read-only preview: the plan and its digest
npm run tax:rekey -- --json                                # the same, machine-readable
npm run tax:rekey -- --apply --confirm <digest>            # apply exactly the plan the preview printed
npm run tax:rekey -- --apply --confirm <digest> --allow-unposted
```

- **The plan.** For every ACTIVE rate whose code is not a Xero built-in (`lib/tax/xero-built-in-tax-types.ts`): the live type whose name equals the rate's name (trimmed, with runs of whitespace collapsed, so a live `AT IOSS  VAT` is `AT IOSS VAT`; case-sensitive first, then case-insensitive; the plan says which), status ACTIVE in the proven stored list, the same VAT-return treatment (the live type's `ReportTaxType` must equal what IMS assigns the rate with the helper that creates Xero rates: EU and Norway sales report as `MOSSSALES`, EC sales `ECOUTPUTSERVICES`, reverse charge `REVERSECHARGES`, purchases `INPUT`, otherwise `OUTPUT`; another box is `REPORT_TYPE_DIFFERS` with both shown, a name whose country statements disagree (the live name's two-letter prefix, the IMS name's own prefix and the IMS country code, all compared case-insensitively, so a live `cy VAT` counts as Cyprus) `COUNTRY_DIFFERS`, an unstated one or an unmapped reporting category `REPORT_TYPE_UNKNOWN`), exactly the same percentage (Xero EffectiveRate, else DisplayTaxRate; against the rate column and the percentage tax is computed at), and a consistent country where both IMS and the Xero name (`CY VAT`) state one, and the same region where a name states one (`PT-30 VAT`, read by the parser R13 uses; a different or unreadable region such as `PT Madeira VAT` is `COUNTRY_DIFFERS`). A reporting category of `IOSS` or `VOEC` is mapped to a box only where the helper files the rate under `MOSSSALES` (a sales rate named for an EU member state or Norway); on any other name it is `REPORT_TYPE_UNKNOWN`, as R13 treats it. Outcomes: `ALREADY_CORRECT`, `REKEY`, `NO_MATCH`, `AMBIGUOUS`, `PERCENTAGE_DIFFERS` (both percentages shown; not re-keyed), `SIDE_NOT_ALLOWED` (the live type's stored `canApply` revenue / expenses must allow every side the rate is used for), `MEANING_DIFFERS` (component count, each component's rate and compound flag must match and no live component may be non-recoverable), `NAME_MATCHES_INACTIVE`. Blockers refuse the apply: two rates tied to one live type on an overlapping side, and a live type already carried by another active rate that stays.
- **The apply** needs the exact digest (SHA-256 of the decision-bearing plan). The digest binds the plan: the list's own digest, each rate's outcome, name, percentages, target type, report type, component clearing, and the document, supplier, mapping, refund and queued-payload counts, and the clear choice. It does NOT bind every field copied to the new rate (reverse-charge flag, compounding flag, tax category and the component details beyond count, rate, compounding and active flag): those are protected differently, by the row locks the apply holds on every rate and component row before it plans and by a comparison of the old row after its deactivation, not by the operator's digest (tracked as a known limit). The apply rebuilds the plan inside the Xero connection fence (the lock the tax import takes), refuses a different digest, and in that one transaction creates a new rate per `REKEY` (live code; same name, rate, type, category, use, country, flags, components; the default flag moves), deactivates the old one (never edited), and re-points supplier default tax rates and `shopping_tax_rate_mappings`. A re-run finds nothing to do. One `activity_logs` row (`tax_rates_rekeyed_to_xero_codes`) records it.
- **No partial apply.** The Apply is refused (`UNRESOLVED_RATES`, listing each rate and its outcome) while any active rate with a custom code has no resolved live type (NO_MATCH, AMBIGUOUS, PERCENTAGE_DIFFERS, SIDE_NOT_ALLOWED, MEANING_DIFFERS, REPORT_TYPE_*, NAME_MATCHES_INACTIVE), because it would stay active with its Demo-organisation code. Choosing `--clear-unresolved` (a checkbox in Settings; preview and apply must both use it, and it is part of the digest) shows those rates as `CLEAR` and retires each the same way as a re-key, but its replacement carries NO tax code (`accounting_tax_type` null, components too) and the old code is added to the retired set. The connectors send `NONE` when a line has no tax type and the sales invoice falls back to the order default's code, so a document on a cleared rate is refused at the enqueue (`missing_tax_code`) until the rate is mapped to a live tax type in Settings > Accounting > Tax; pending refund snapshots on a cleared rate become null, which the credit note refuses. The command exits 0 only when every in-scope rate ends REKEY, ALREADY_CORRECT or CLEAR (a refused apply exits 2).
- **Pending refund snapshots move by id, once.** They hold a code, so in a code swap (A: X to Y, B: Y to X) or a rotation an update by the old code's value would move rows twice. The apply captures the ids of the pending snapshots per original code in one pass after every rate is deactivated, then updates each captured set once to its own replacement's code.
- **Open documents.** A line's code is read from its rate whenever a Xero document is built from it, not once: `queueSalesInvoiceForOrder` (invoice and every update) and the refund / credit-note actions in `app/actions/sales.ts`, `app/actions/sync-exceptions.ts`, `lib/domain/sales/refund-posted-tax-identity.ts`; `createInvoice`, `updateInvoice` and `postSupplierCreditNote` in `app/actions/purchase-orders.ts` and `lib/domain/purchasing/purchase-invoice-edit.ts` (a further bill for a part-billed PO included). So every not-cancelled order or PO that references a re-keyed rate, posted or not, can still send the old code: the apply is refused with the counts (never-posted and already-posted) unless `--allow-unposted`, which re-points those lines to the new rate (same name, percentage, sides and component breakdown, so the same tax meaning and no amount change; a posted Xero document gets the new code on its next update, a correction). `sales_order_refund_lines.accounting_tax_type` is a stored snapshot (resolved at refund creation, preferred by `creditNoteLineTaxTypeResolver` in `lib/domain/sales/refund-posted-tax-identity.ts` when the credit note is built or retried): lines on refunds with no `accounting_credit_note_id` refuse the apply (`PENDING_REFUND_SNAPSHOTS`) and with `--allow-unposted` are migrated to the new code only if EVERY other carrier of the old code (active or not) means exactly what the re-keyed rate means: same name, percentage, component breakdown, country, side, compounding, reverse-charge flag and reporting category (otherwise `REFUND_SNAPSHOT_IDENTITY`, no override); posted credit notes are history. Other stored tax types: sync-row payloads and accounting events (in-flight ones block as below, sent ones are history), component codes (cleared), and the reverse-charge tax-type settings (separate configuration, not changed). A rate the apply replaced is read-only (`tax_rates.replaced_by_id`): the tax-rate editor refuses to reactivate it or change its code, percentage or components (`TaxRateReplacedError`; the settings table shows it as replaced and disables its buttons), the link-by-name and generate-missing code writers, the demo provisioning remaps and `copy-tax-rates` skip it, and the enqueue guard never counts it as a carrier of its old code even if something reactivated it. The editor takes the row lock (`FOR NO KEY UPDATE`) that the apply takes on every active rate and component row before it builds the plan it copies from, so an edit and an apply serialise: the apply either plans from the edited row (its digest then differs and it refuses) or the editor finds the row replaced. The old rate stays reachable from forms opened before the apply and from imports that read it earlier, so every writer that stores a tax rate id (sales and purchase order create and edit, clone, supplier default tax rate, storefront rate mappings, the WooCommerce order import) resolves the id it is given: a rate a re-key retired (`tax_rates.replaced_by_id`, set by the apply) resolves to its replacement, a rate that is simply inactive is refused (`TAX_RATE_INACTIVE`) for a new record, kept when editing a record that already has it, and let through for inbound storefront orders. The resolution runs inside the writing transaction and takes a row share lock held to commit (a refund share-locks the rate rows its tax identity is read from, before reading them), which the apply's update of the old row waits for; after deactivating, the apply re-points suppliers and mappings again and counts pending refund snapshots again (migrating them or rolling back), so a document created while the apply runs ends on the replacement (re-pointed with `--allow-unposted`) or the apply rolls back (`DOCUMENT_CREATED_DURING_APPLY`). The queued-payload check looks at EVERY tax-code field of the payload (any key `taxType` or ending `TaxType` other than `reportTaxType`: line `taxType`, `shippingTaxType`, `discountTaxType`, header `taxType`; `lib/tax/tax-code-fields.ts`) in the sync rows themselves, not through the best-effort event mirror. A producer reads a line's rate before it takes the enqueue lock, so the one insert of a sync row (`createAccountingSyncLogRow`) also refuses, under the same connector-selection advisory lock the apply holds, any payload carrying a code that a re-key recorded as retired (setting `tax_rekey_retired_codes`) and that is not bound to a live carrier of it. Each tax-code field of a payload carries, beside it and never sent, the id of the rate the producer read the code from (`taxType` + `taxRateId`, `shippingTaxType` + `shippingTaxRateId`, `discountTaxType` + `discountTaxRateId`). For a retired code every occurrence is admitted only if its rate is, under the lock, active, not replaced and carrying exactly that code (`retired_tax_code` otherwise; `retired_tax_code_unbound` when no rate is named). There is no time window: elapsed time proves nothing (a producer can pause for hours, and in a code swap such as CY VAT's retired `TAX005` becoming the live BG VAT's, only the source tells a Cyprus line from a Bulgarian one). A payload built from the new row is admitted whenever it is enqueued; a stale one never is. The sales invoice and update, sales credit notes, the WooCommerce order import (whose codes are taken from the rate rows its lines are persisted with, read at payload time), purchase bills and updates and supplier credit notes all bind their codes (both refusals are recorded in the posting-refusal inbox; repeating the action rebuilds the payload from the re-pointed rates). A code an operator merely deactivated is not refused, so credit notes for old invoices still work. Documents and payloads already sent are not touched. CANCELLED orders and purchase orders are re-pointed by every apply and never block it: re-pointing changes nothing that was posted (the new rate means the same by construction), and a storefront status sync can move a cancelled order back to a posting status, whose next invoice build would otherwise read the retired code. They are their own bucket in the plan (cancelled orders and lines, in the digest). Accounting sync rows (`PENDING`/`PROCESSING`/`FAILED`) and accounting events (`PENDING`/`FAILED`) whose lines carry the old code are snapshots the processor sends as stored: the apply is always refused until they have posted or been cancelled (a `FAILED` row keeps blocking until it is retried or cancelled; there is no override). A rate component's own custom code that is not a live ACTIVE type (a built-in or live-valid code is kept) is set to null on the new rate's copy, listed per rate in the plan (`clearedComponents`) and covered by the digest.
- **Hardening and exit codes.** As `npm run vat:diff`: the environment is replaced by the same whitelist, the account must be root or the checkout's owner, a credential-shaped argument is refused, nothing from a failure is echoed. Exit 0 nothing to do / applied, 1 the preview lists work, 2 refused (stored list not provable, digest mismatch, blockers, unposted documents, queued payloads, connection changed), 3 could not start. Settings > Accounting > Tax > *Re-key VAT rates* (permission `settings.company`) is the same function. Afterwards `npm run vat:diff` shows no `PERCENTAGE_MISMATCH_IMS_XERO` for a re-keyed rate.

## Reconciliation pack

<!-- reconciliation-pack:overview -->
`npm run reconcile:pack` is the reconciliation pack: sixteen items (R1 to R16), each a claim that IMS agrees with a vendor or with its own ledger. It is not a second readiness gate and renders no overall verdict; the gate reads the newest report. This build runs R3, R4 and R15 end to end from the invariant report, R6, R10 and R11 from the as-of basis (the ledger items, below), R7 and R8 against the Qoblex export (below), R1 against Mintsoft, R9 and R13 against WooCommerce and R12 against WooCommerce and Xero (the vendor items, below), and reports every other item the phase applies as inconclusive with NO_RUNNER and nothing listed until its runner arrives. The liveness bracket and the as-of basis described below are wired into the command, and the readiness gate reads the newest report (see the gate section). The pack contacts NO vendor unless the run is started with `--vendor-reads-only`; with it, it makes GET requests to WooCommerce and Mintsoft and, for R12 only, to Xero, and the vendor items it serves are R1, R9, R12 and R13.

A run publishes `<report-dir>/<run id>/evidence.jsonl`, then `reconciliation-pack.md`, then `reconciliation-pack.json` last, each created exclusively and never through a symlink, fsynced and renamed into place under an exclusive 0700 directory. The JSON is the commit record: it names the Markdown by sha256 (`companionMarkdownSha256`) and the evidence by sha256 and line count, carries a `sequence` and the sha256 of the previous report's JSON (`previousReportSha256`), and counts that the reader recomputes from the evidence. Every identity is one line of the evidence, equal ones included: the reader recomputes every count and the digest of the equal identities from those lines, and re-judges each line against the item's catalogue row (which sides had the identity, recorded as explicit presence flags; the value shape the item's mode demands; the true difference of the two values; the tolerance verdict; and, for a minor-unit item, the currencies). The bucket of every pair entry is DERIVED from those fields in the builder and again in the reader (both sides present is equal or differing, one side is onlyIms or onlyVendor, neither is invalid) and a label that disagrees is refused. Nothing the caller owns is serialised: the input is copied field by field into plain objects (an unknown field, an accessor, a symbol key, a Proxy, a class instance or a hole is refused), and the finished report is read back by the reader's own validation before the first byte is written. Problem text is closed reason codes and counts only; identities appear only as sanitised tokens (a cuid, a numeric vendor id, a validated SKU or `sku#` and eight hex digits, a warehouse code).
<!-- /reconciliation-pack:overview -->

### Running it

<!-- reconciliation-pack:usage -->
`npm run reconcile:pack -- --phase <P0|P1|P2> [--as-of <YYYY-MM-DD>] [--items <R3,R4,...>] [--acceptances <file>] [--report-dir <dir>] [--basis-only] [--vendor-reads-only]`

| Flag | Value | Meaning |
|---|---|---|
| --phase | P0, P1 or P2 | required; there is no default, because an item applies in some phases and not others |
| --as-of | YYYY-MM-DD | the cycle date D (default: yesterday, UTC); a real calendar date before today (UTC) |
| --items | R1 to R16, comma-separated, each once | run only these items (default: all); every other item is reported inconclusive with NOT_SELECTED, so a partial run never exits 0 unless every other item the phase applies is not applicable |
| --acceptances | file | the written warning-acceptance file R15 uses, in the readiness gate's format (default ops/readiness-warning-acceptances.json in the checkout; absent means no warning is accepted; a named file that cannot be read is a refusal) |
| --report-dir | directory | where reports are published (default /var/tmp/ims-reconciliation-pack-reports); created mode 0700 if absent, and it and every ancestor must be modifiable only by root or the running account |
| --basis-only | - | check only whether the as-of basis for --as-of exists, and run no item: it makes the same two liveness reads and the same basis read and settle a run makes, prints `ready` or `not ready` with the first reason from the basis table (and the transit leg's reason, which only R10 needs), and exits 0 when ready and 5 when not; ready means the basis is available and the inventory comparison is not withheld |
| --vendor-reads-only | - | allow the vendor items (R1, R9, R12, R13, R14, R16) to read the vendors, GET requests only, to the paths and parameters the pack lists and at the pace it sets (WooCommerce for R9, R12, R13 and R14; Mintsoft for R1 and R14, with its stored fixed API key and never a login; Xero for R12 and R16, with the stored token, never refreshed); without it NO vendor is contacted, no vendor credential is read, and those items are inconclusive with VENDOR_READS_OFF (the readiness gate reads that as not available, like NO_RUNNER). It never enables a write: the vendor transports refuse any other method |
| --qoblex-export | directory | the operator-supplied Qoblex export (R2, R5, R7, R8, R14): a directory holding a manifest and the files it names, each read once. Without it the Qoblex items are inconclusive with QOBLEX_EXPORT_OFF and nothing is read. See the Qoblex export contract |
| --sku-exclusions | file | the written SKU-coverage exclusions R14 uses, one per SKU and system, each expiring within 90 days (default ops/reconciliation-sku-exclusions.json in the checkout; absent means none; a named file that cannot be read is a refusal; a file that is not trusted or not well formed accepts nothing) |
| --help | - | print the usage and the exit codes |

The command is started as root or as the account that owns the checkout; any other account is refused. `DATABASE_URL` must be in the environment: the command does not read `.env` files, replaces its whole environment with a short whitelist (PATH, HOME, LANG, LC_ALL, TZ and DATABASE_URL) before the application's database client is loaded, and refuses an argument that looks like it carries a credential. It makes no call to Xero or Qoblex, and none to WooCommerce or Mintsoft unless `--vendor-reads-only` is given (then only the GET requests described in the vendor items section); it writes nothing to the database and writes only its report. With `--vendor-reads-only` the environment whitelist also keeps `SETTINGS_ENCRYPTION_KEY` and `ENCRYPTION_KEY`, which decrypt the stored storefront and Mintsoft credentials; without it the command never reads a vendor credential and does not keep the key. The invariant report behind R3, R4 and R15 runs in the same process with no-op activity-log and notification writers, in ONE transaction opened `REPEATABLE READ` and set `READ ONLY`, with the application's database client bound to that transaction, so its three reports and every page of them read one database state and any write is refused by the server. The run records its proof (the isolation level, the read-only flag and `pg_current_snapshot()`, read at its start and its end and required to agree, and that the application's client was the transaction), and R3, R4 and R15 are inconclusive without it.

The read-sync status report behind the liveness bracket is read by a CHILD PROCESS (`npm run --silent read-sync:status -- --json`, the command the readiness gate runs, with the same short environment whitelist) at the start of the run and again at its end, and the as-of basis is read through a database client of its own, one per transaction. Neither uses the application's client: the invariant run binds that client to its one snapshot and needs to be the first to load it, so a test loads the command and every pack module in a fresh process and fails if the client exists afterwards. The child's exit code is not the verdict (it is non-zero whenever a stream is stale, and the report says so in its own fields): only a report that parses and checks out against itself is a read, and a child that timed out, was killed or printed anything else is a failed read, so every item is inconclusive.

R3 and R4 name each stock level the invariant report flags (the product and warehouse ids) with the two quantities that disagree; with no flagged level they pass on the named proof that the report ran to the end and lists nothing. R15 names each critical finding and each warning by a digest of the gate's warning id (`finding-` and 20 hex digits; the id itself carries product, order and sync-log ids and is never printed), with 1 for the finding and, as the number the claim allows, 0 for a critical finding or a warning with no current written acceptance, and 1 for a warning the acceptance file covers. Findings that share one id (the id carries no severity) are one entry, and it takes the strictest number any of them allows, so an accepted warning never hides a critical finding with the same id. A report that did not run to the end (a run that was not completed or listed errors, a missing domain, a truncated list, an inventory cursor that is not null or any cursor on the accounting or sales report, a finding that says its scan stopped at a row cap, any count of a report or of the run's own summary (total, info, warning or critical, per domain and overall) that differs from the findings listed, a critical-findings list, an `ok` flag or a preflight `failure` value that disagrees with them, a severity the module does not know, a subject id that is present but not a non-empty string, a critical-findings list that is not exactly the reports' critical findings identity by identity, a stock-claim code under the accounting or sales report, a run without the one-snapshot proof) is inconclusive, never a pass, and so is a flagged level that the pack's own comparison would call equal. The stock-movement branch of the report is read over all history here, not over the 90-day window the scheduled check uses, so R15 is not a windowed claim. R3, R4 and R15 all validate the whole run (all three domains and the run summary) before reading a finding.
<!-- /reconciliation-pack:usage -->

### Codes printed when the command stops without a report

<!-- reconciliation-pack:cli-codes -->
When the command stops without a report it prints one of these codes and nothing else about the cause.

| Code | Meaning |
|---|---|
| BAD_ARGUMENTS | an argument is unknown, repeated, missing its value, or not in the allowed form |
| CREDENTIAL_ARGUMENT | an argument value looks like it carries a credential; secrets are never given on a command line |
| ACCOUNT_NOT_ALLOWED | the command was started by an account that is neither root nor the owner of the checkout |
| DATABASE_URL_MISSING | DATABASE_URL is not in the environment (the command does not read .env files) |
| ACCEPTANCE_FILE_UNREADABLE | the acceptance file named with --acceptances could not be read |
| EXCLUSION_FILE_UNREADABLE | the exclusion file named with --sku-exclusions could not be read |
| DATABASE_UNREADABLE | the database could not be read, so the report could not be attributed to a cluster; nothing was published |
<!-- /reconciliation-pack:cli-codes -->
### Outcomes

<!-- reconciliation-pack:outcomes -->
Each item ends in exactly one outcome.

| Outcome | Meaning |
|---|---|
| pass | the claim was compared on a complete, stable basis and held; nothing differs, nothing is unsettled |
| fail | at least one identity is on one side only, or differs beyond the tolerance, and the difference has persisted (or needs no settling) |
| inconclusive | the claim could not be proven either way (unreadable, incomplete, stale or still settling); never a pass, and the gate reads it as unreadable |
| not-applicable | the claim does not apply in this phase; the gate reads it as not available |
<!-- /reconciliation-pack:outcomes -->
### What a pass must prove

<!-- reconciliation-pack:proof -->
An outcome of pass is only accepted, when a report is written and again when it is read back, if the item record proves it. A pass must carry all of: a proof that at least one identity was compared (bothEqual above zero, with nothing on one side only, differing or unsettled), or the name of the evidence that an empty population is the true one; exactly the sources its catalogue row lists; a start and an end stamp, equal to each other, for every stream the item depends on; no reason code. A fail names a difference; an inconclusive item names why it could not be proven and lists no finding; a not-applicable item is the phase's doing alone and carries nothing. Any other combination makes the report invalid and a reader refuses it.

| Source code | Meaning |
|---|---|
| ims-database | the IMS database, read in one read-only transaction |
| ims-ledger | the IMS accounting subledger as of the cycle date |
| invariant-report | the IMS invariant report |
| mintsoft-api | Mintsoft (GET only) |
| woocommerce-api | WooCommerce (GET only) |
| xero-api | Xero (GET only) |
| xero-trial-balance | the stored Xero trial-balance snapshot |
| qoblex-file | the Qoblex export file named in its manifest |

| Empty-population proof | Meaning |
|---|---|
| snapshot-run-row-present | the as-of snapshot run row exists and records no rows for the population |
| per-status-total-zero | every enumerated status reported a vendor total of zero, in both of two full sweeps |
| vendor-total-zero | the vendor reported a total of zero for the whole population |
| invariant-report-clean | the invariant report ran to the end and lists no finding |
| qoblex-incoming-report-empty | the Qoblex incoming report passed its header check and lists no open purchase order, and IMS holds no open goods purchase order in the same snapshot |
| no-foreign-currency-documents | every Xero invoice, bill, credit note and payment dated in the closed months was read as a proven complete list (two equal full scans) and none is in a currency other than the base currency, so there is no rate to check |
| alignment-confirmed | every vendor-warehouse binding, inactive and disabled ones included, has its alignment confirmed and at least one exists, read in one IMS snapshot twice (before and after the vendor reads), so the claim is retired by construction and nothing was asked of the vendor |
<!-- /reconciliation-pack:proof -->
### Identity tokens and every published field

<!-- reconciliation-pack:tokens -->
Identity tokens (what evidence.jsonl prints for a SKU, a warehouse code or an id) are TRUSTED DATA KEYS: values the owner's own systems produced, not free text. Nothing a vendor or a file says in prose ever reaches output. The screen below is defence in depth for the day a credential is pasted into a SKU column; it is a denylist and incomplete by nature.

A token is printed as it is only if it matches the allowed-character pattern for its kind (a SKU: letters, digits, dot, slash, underscore and hyphen, starting with a letter or digit, at most 64 characters; a warehouse code: upper-case letters, digits, underscore and hyphen, at most 32; a purchase-order number or reference, which follows the SKU pattern; a cuid; a numeric vendor id of at most 18 digits) AND passes the credential screen. Otherwise it is printed as its kind, a hash sign and the first 8 hex digits of its sha256 (for example sku#3aaf0386). The screen digests a token that contains, in any case, one of key, secret, token, passw, pwd, bearer, auth, cred, private, cookie, session, signature, jwt, sk_, pk_, ghp_, gho_, ghs_, xox, akia or asia; or a run of 24 or more letters, digits, plus, slash or equals with no separator; or that starts with eyJ or http; or that is longer than 64 characters. The same screen is applied again to every token read back from a file.

What this does not cover (the residual): a credential that avoids every listed word, has no 24-character unbroken run and is built from allowed characters would still print; an 8-hex-digit digest of a LOW-entropy secret (a short password) could be guessed offline; a legitimate SKU that contains a listed word (MONKEY-WRENCH, AUTHOR-GUIDE) prints as a digest and is harder to read; cuid and numeric-id parts are not screened; and evidence.jsonl lists every identity, so it is as sensitive as the stock list itself and is written 0600 in a 0700 directory. Free-form fields do not exist: every other field that can reach output has the anchored allowlist grammar in this table.

| Field | Appears in | Grammar |
|---|---|---|
| schemaVersion | JSON | the integer 2 (a report published before R16 carries the integer 1 and exactly R1 to R15; it stays readable under the rules it was published under) |
| kind | JSON; proof.kind | reconciliation-pack, compared or proven-empty |
| runId | JSON, Markdown, directory name, claim file | 8 digits, T, 6 digits, Z, a hyphen and 12 lower-case hex digits |
| systemIdentifier | JSON, Markdown | 10 to 20 digits: the identifier PostgreSQL itself produces for the cluster |
| phase | JSON, Markdown | P0, P1 or P2 |
| asOf | JSON, Markdown | a real calendar date, YYYY-MM-DD |
| startedAt | JSON, Markdown | an ISO time in UTC with a trailing Z |
| finishedAt | JSON, Markdown | an ISO time in UTC with a trailing Z |
| start | JSON stream brackets | an ISO time in UTC with a trailing Z, or null |
| end | JSON stream brackets | an ISO time in UTC with a trailing Z, or null |
| first | evidence settling | an ISO time in UTC with a trailing Z |
| later | evidence settling | a list of ISO times in UTC with a trailing Z |
| count | evidence settling | a whole number equal to the length of later |
| streams | JSON | at most six stream brackets |
| items | JSON | exactly sixteen item records, R1 to R16 in order (fifteen, R1 to R15, in a schemaVersion 1 report) |
| evidence | JSON | an object with file, sha256 and lines |
| proof | JSON items | null, or an object with kind (and source) |
| sequence | JSON | a positive whole number |
| previousReportSha256 | JSON | 64 lower-case hex digits, or null for sequence 1 |
| companionMarkdownSha256 | JSON | 64 lower-case hex digits |
| sha256 | JSON evidence record | 64 lower-case hex digits |
| bothEqualSha256 | JSON items | 64 lower-case hex digits, or null |
| file | JSON evidence record | the file name evidence.jsonl |
| lines | JSON evidence record | a non-negative whole number |
| stream | JSON stream brackets | one of the read-sync stream ids |
| id | JSON items | R1 to R16 |
| item | evidence lines | R1 to R16 |
| bucket | evidence lines | one of the seven comparison buckets |
| applicability | JSON items | applicable, listed-only or not-applicable |
| outcome | JSON items | pass, fail, inconclusive or not-applicable |
| reasons | JSON items | a list of reason codes from the closed table |
| source | JSON items proof | a code from the empty-proof table |
| sources | JSON items | a list of codes from the source table |
| key | evidence lines | one or more identity tokens joined by |: a digested form kind#8 hex digits, a cuid, a numeric id, or a SKU or warehouse token that passes the allowed-character pattern AND the credential screen (see Identity tokens) |
| ims | evidence lines | a canonical plain decimal, or null |
| vendor | evidence lines | a canonical plain decimal, or null |
| delta | evidence lines | a canonical plain decimal, or null |
| imsCurrency | evidence lines | a code from the known-currency list, or null |
| vendorCurrency | evidence lines | a code from the known-currency list, or null |
| imsPresent | evidence lines | true or false |
| vendorPresent | evidence lines | true or false |
| settling | evidence lines (unsettled entries, and the failing entries of an item that settles) | an object with sequence, first, later and count |
| counts | JSON items | seven non-negative whole numbers named by bucket |
| evidenceLines | JSON items | a non-negative whole number |
| summary | JSON | four non-negative whole numbers |
| exitCode | JSON, Markdown | one of 0, 1 or 5 |
| host | run lock only, never a report | a DNS-style host name: dot-separated labels of letters, digits and hyphens, at most 253 characters |
| token | run lock only | 32 lower-case hex digits |
| pid | run lock only | a positive whole number |
| createdAt | run lock only | an ISO time in UTC with a trailing Z |
| startTime | run lock only | digits (field 22 of /proc/<pid>/stat), or null |
| bootId | run lock only | hex digits and hyphens (the kernel boot id), or null |
<!-- /reconciliation-pack:tokens -->
### Unreadable input shapes

<!-- reconciliation-pack:inputs -->
The comparator never reads an unreadable input as equal, and never fills a gap with a default. Each of these shapes is inconclusive with the code shown; none reaches a bucket or a pass. A difference of zero is the only thing that is equal, and minus zero is read as zero. The comparison mode (values or presence) is fixed per item in the catalogue, and a currency outside the known list has no default number of decimals.

| Unreadable input | Reason code |
|---|---|
| a side that is not a list of rows | SOURCE_UNREADABLE |
| a row that is null, a number, a string or a list | BAD_KEY |
| a row whose key is not a list of parts | BAD_KEY |
| a row with no key parts | BAD_KEY |
| a key part that is not an object | BAD_KEY |
| a key part of an unknown kind | BAD_KEY |
| a key part whose raw value is an object, a list, a date, a boolean, a bigint, null or undefined | BAD_KEY |
| a key part whose raw value is NaN, infinite, negative, fractional, or not a safe integer | BAD_KEY |
| a key part whose raw value is an empty string, a string over 512 characters, or contains a control character | BAD_KEY |
| two rows on one side with the same identity | DUPLICATE_KEY |
| a comparison mode that is missing or not values or presence | BAD_MODE |
| a value-bearing comparison with a row whose value is missing, null or undefined (either side, or both) | VALUE_MISSING |
| a value that is not a plain decimal string: NaN, Infinity, empty, spaces, exponent, plus sign, hex, comma, non-ASCII digits, a number type, more than 12 decimals or 30 integer digits | BAD_VALUE |
| a presence-only comparison with a row that carries a value | VALUE_SHAPE_MISMATCH |
| a value-bearing comparison with no tolerance, an unknown rule, or a limit that is missing, negative or not a plain decimal | BAD_TOLERANCE |
| a minor-unit comparison where either currency is missing, lower case, padded, or not in the known list | CURRENCY_UNKNOWN |
| a comparison where one side carries a currency and the other does not | CURRENCY_UNKNOWN |
| a side whose completeness is anything other than the boolean true | READ_INCOMPLETE |
| nothing compared and no valid empty-population proof | EMPTY_UNPROVEN |
| a population or exclusion list that is not a set | NO_POPULATION_RECORD |
| carried settling state that is not a map of well-formed records | SOURCE_UNREADABLE |
| a settling stamp that is missing or not an ISO time | STALE_BASIS |
<!-- /reconciliation-pack:inputs -->
### Reason codes

<!-- reconciliation-pack:reasons -->
Every reason a report can give is one of these codes; no other text describes a problem.

| Reason code | Meaning |
|---|---|
| DIFFERENCES | one or more identities are on one side only or differ beyond the tolerance |
| UNSETTLED_PENDING | a difference was seen but has not yet persisted across two later successful runs of its stream |
| SETTLING_STATE_UNUSABLE | the settling state carried from the previous report could not be used (no previous report, another phase, an item that was not compared to the end, a capped listing, or a stream that moved), so every current difference was treated as first seen and none can mature into a failure until a usable report precedes the run; it is never a pass |
| STALE_BASIS | a stream the item depends on is stale, off, or reported no usable last-success stamp |
| BASIS_MOVED | the stream stamp changed between the start and the end of the read, so the read is not one consistent basis |
| READ_INCOMPLETE | a side of the comparison was not read completely |
| EMPTY_UNPROVEN | both sides were empty and nothing positively proves that empty is the true answer |
| DUPLICATE_KEY | two rows on one side carry the same identity; they are never summed or picked between |
| BAD_KEY | a row has no usable identity (a key part that is not a non-empty string or a safe whole number, an unknown kind, no parts, or a row that is not an object); nothing is matched on a guessed identity |
| VALUE_MISSING | a value-bearing comparison has a row with no value on one side or both; a missing value is never read as equal |
| BAD_TOLERANCE | the tolerance rule is missing, unknown or carries a limit that is not a non-negative plain decimal |
| BAD_MODE | the comparison mode (values or presence) is missing or unknown |
| BAD_VALUE | a row carries a value that is not a finite decimal number |
| VALUE_SHAPE_MISMATCH | one side carries values and the other does not |
| CURRENCY_UNKNOWN | the currency of a money comparison is missing or not a known code |
| SOURCE_UNREADABLE | a source (database, file or vendor) could not be read or was not trusted |
| GL_LEG_ABSENT | a ledger balance the comparison needs is the zero the pull records for an account the trial balance omitted without the report proving itself complete, not a balance Xero reported; it is never compared as a zero (a zero the pull stored under the completeness proof is a real balance and is not this) |
| CAP_EXCEEDED | a read hit its cap, so the population is not proven complete; capped scans never pass |
| NO_POPULATION_RECORD | the recorded population the comparison is bounded by is missing or unreadable |
| NO_RUNNER | no runner exists on this build for the item |
| VENDOR_READS_OFF | the run was not started with --vendor-reads-only, so no vendor was contacted and the item was not read; it is never a pass |
| VENDOR_READ_UNSTABLE | a vendor list could not be proven stable: its two full reads differ, its pages disagree about the total, its row count is not the total the vendor reported, a row repeats, or a page is short; no partial list is ever compared |
| UNKNOWN_STATUS | a storefront order status the importer admits has no reading (neither a mapping row nor a built-in default), or its mapping rows disagree, so which orders are open cannot be decided |
| AMBIGUOUS_STATUS_MAPPING | a stored status-mapping row has a key that only NORMALISES to an admitted storefront status (padding, an odd prefix): the importer's own lookup would never match it, so it is neither used nor ignored and which orders are open cannot be decided |
| VENDOR_LIST_UNPROVEN | the list of the vendor's rates held in IMS is not proven to be the whole list (for Xero: no stored list for the connected organisation, a missing header row, or a row count or digest that does not match the stored rows), so unmapped vendor rates cannot be listed; never a pass |
| VAT_MAPPING_UNVERIFIED | a VAT figure depends on a mapping between a Xero tax type and an IMS country and reporting category that is not verified (a reporting category other than the verified one, a tax rate with no country, no category or no Xero tax type, a Xero tax type shared by two IMS rates or absent from the proven Xero list, a tax line no mapping explains, or a shipping account that is not configured, not in the chart or shared with sales or discount, a sales account that is not configured, a taxable Xero line with no account code or on an account that is neither sales, discount nor shipping, a non-zero WooCommerce fee-line tax), so the three systems cannot be compared per key; it is never a pass and nothing is assumed |
| XERO_CONNECTION_UNUSABLE | the stored Xero connection cannot be used for a read-only request: no token, a token that is not current (the pack never refreshes a token, because that writes), a connection the tenant guard refuses, an organisation that is not the one whose tax-rate list is proven, or a connection that changed during the run |
| BASE_CURRENCY_NOT_GBP | the IMS base currency or the Xero organisation base currency is not GBP, so the GBP tolerance has no stated meaning and nothing is compared |
| VENDOR_AUTH_REFUSED | the vendor connection is not in the read-only mode the pack requires (a fixed API key with nothing else configured to log in; a login would replace the key every other integration of the tenant uses), or its address, key or client scope is missing or unusable, so no request was made |
| IDENTITY_CONFLICT | the two sides disagree about what one identity IS (the vendor product id recorded for a SKU is not the id the vendor holds for it, a product is a bundle on one side only, or the vendor lists two ids for one SKU), so nothing is matched on a guess; no partial comparison is made |
| BINDING_UNCONFIRMED_NOT_COMPARED | a warehouse-system binding whose alignment is not confirmed is not in the comparison population (it is inactive or its stock sync is DISABLED) while another binding is confirmed, so the claim cannot be called retired and nothing was compared for it; never a pass |
| NOT_SELECTED | the run was not asked to run the item (--items), so it was not read; it is never a pass |
| PHASE_NOT_APPLICABLE | the item does not apply in the phase asked about |
| INTERNAL_ERROR | the item runner failed unexpectedly |
| QOBLEX_EXPORT_OFF | the run was not started with --qoblex-export, so no Qoblex export was named and nothing was read; it is never a pass (the readiness gate reads it as not available, like VENDOR_READS_OFF) |
| QOBLEX_EXPORT_STALE | the Qoblex export is not usable for this run: it is for another cycle date than --as-of, was exported before that day ended, is dated in the future, or is older than the weekly cadence allows |
| SNAPSHOT_UNAVAILABLE | the IMS inventory snapshot for the cycle date cannot be relied on: no snapshot run row, rows that are not point-in-time reliable (R5), or a location, product or warehouse the snapshot names that IMS does not hold |
| COLUMN_MAP_NOT_NATIVE | the Qoblex export names a column map whose bytes are not exactly the repository's native Qoblex map; a column map can rename, replace, fix or skip values, so only the native one is accepted |
| IDENTITY_NOT_CANONICAL | a SKU or warehouse code in the Qoblex export is not already in its exact, canonical text (outer whitespace, a non-NFC spelling, a control, zero-width or no-break character, a lower-case warehouse code): the import tool would change it before comparison, and an identity is only ever compared as the system holds it |
| MANIFEST_INCONSISTENT | the Qoblex export manifest contradicts itself about a file (one name declared with two digests or spellings, names that differ only in case, a file used both as data and as a column map, or one data file used by two parts with different column maps); the whole manifest is rejected and no part of the export is used |
| EXPORT_INCONSISTENT | the Qoblex export disagrees with itself: a SKU its stock part holds is not in its product list, so the product list is incomplete and a comparison built on it would pass by omission |
| XERO_RATE_DIFFERS | R16: a foreign-currency Xero document or payment carries a CurrencyRate that differs, to six decimal places, from the IMS central rate at its date converted to Xero's convention; both rates are listed on the entry |
| IMS_RATE_MISSING | R16: a foreign-currency Xero document or payment has no usable IMS central rate at its date (no fx_rates row, a rate that is not positive, or two rows that disagree), so its Xero rate cannot be judged; the entry is listed under the Xero rate with the closed refusal reason of the rate lookup in its identity |
| DOCUMENT_UNREADABLE | R16: a Xero document or payment of the proven list cannot be judged on its own (its date, currency or CurrencyRate is missing or not a usable value); the entry is listed with the value 0, which Xero never records as a rate, and is never read as a pass |
| IMS_POSTED_RATE_NOT_TABLE_RATE | R16: a Xero document or payment that IMS posted (a connector-confirmed sync record names its Xero id) carries a rate that IMS stored on the posting but that is not the central fx_rates rate under that record's date rule (a storefront receipt: the order's own rate on the order's UTC day, otherwise the central rate at the end of the payment day; a storefront invoice: the central rate at the order's creation instant, or one in force on the order's day when the instant is unknown); the stored rate and the table rate are listed as a pair |
| XERO_DATE_DIFFERS | R16: a Xero document or payment that IMS posted carries a date that is not the date the posting carried (the poster's Date, compared as the same UTC calendar day); the posted date and Xero's date are listed as a pair (as YYYYMMDD), whatever the rates say, because the rate rule belongs to the posted date and Xero may since have been moved to another day |
| IMS_POSTING_UNREADABLE | R16: a Xero document or payment is named by an IMS sync record but the rate that posting carried cannot be read (the payload is gone, the rate is missing or not positive, the record disagrees with Xero on kind or currency, or two sync records name the same Xero id); the Xero row is listed with the value of its own rate and the sync record, and is never a pass |
| LEG_UNAVAILABLE | one system of a several-system comparison could not be read or has no reader on this build, so the systems it covers were not compared; a finding among the systems that were read is still reported, and the item never passes |
<!-- /reconciliation-pack:reasons -->
### Refusal codes

<!-- reconciliation-pack:refusals -->
A run is refused, and the trend reader refuses a directory, with exactly one of these codes.

| Refusal code | Meaning |
|---|---|
| DIR_UNTRUSTED | the report directory or an ancestor could be modified by another account, or is not a real directory |
| DIR_UNREADABLE | the report directory could not be listed |
| TOO_MANY | more report directories than the reader will walk |
| PAIR_INVALID | a report pair failed verification (untrusted, unreadable, malformed, or its digests or derived values disagree) |
| GAP | a sequence number is missing from the chain |
| FORK | two reports claim the same sequence or the same predecessor |
| LINK_BROKEN | a report's previousReportSha256 is not the digest of the report before it |
| SYSTEM_MISMATCH | the chain mixes reports of different system identifiers |
| SCHEMA_REGRESSED | a report claims an older schema version than the report before it (a pre-R16 report may only precede the first current one, never follow it) |
| LOCK_HELD | another run holds the run lock (a live holder is never displaced, however old its lock) |
| LOCK_UNREADABLE | the run lock exists but cannot be read or understood, so it was not taken |
| LOCK_STALE_CONTENDED | a stale lock is being reclaimed by another run, or a reclaim guard was left behind |
| LOCK_UNPROVABLE | the run lock exists but its holder cannot be shown dead (no process identity on this host, or a lock written without one); an operator must check the holder and remove the lock by hand |
| LOCK_ERROR | the run lock could not be created |
| SEQUENCE_CLAIMED | the next sequence number already has a claim file (a run committed it, or died after claiming it); an operator must check the report directory |
| LOCK_LOST | the run lock was no longer this run's at the moment of commit, so nothing was published |
| WRITE_FAILED | a report file could not be written or renamed |
<!-- /reconciliation-pack:refusals -->
### Items

<!-- reconciliation-pack:items -->
The catalogue. Tolerances are chosen defaults (owner decisions D1 and D2); an exact quantity comparison allows 0.0001.

| Item | Claim | Exactness | Tolerance | Cadence | Phases | Dependent streams | Sources | Population |
|---|---|---|---|---|---|---|---|---|
| R1 | IMS stock_levels equal Mintsoft on-hand per (SKU, bound warehouse) | exact | exact: 0.0001 (stored quantities carry four decimals (plan)) | daily | P0 not-applicable, P1 applicable, P2 applicable | mintsoft-stock-sync | ims-database, mintsoft-api | the warehouses bound to Mintsoft that are active, sync-enabled and whose alignment is unconfirmed (read in the same snapshot), and in them every stock-tracked IMS product that is linked to Mintsoft (or that Mintsoft lists by SKU) against every non-bundle Mintsoft stock row; KIT products and Mintsoft bundles are set aside |
| R2 | IMS equals Qoblex StockOnHand per non-3PL location | exact | exact: 0.0001 (stored quantities carry four decimals (plan)) | weekly | P0 not-applicable, P1 listed-only, P2 applicable | none | ims-database, qoblex-file | every active IMS warehouse that has no WMS binding (the manifest must declare exactly these as its non-3PL locations); the IMS side is the inventory snapshot of the cycle date |
| R3 | StockLevel.quantity equals the sum of CostLayer.remainingQty | exact | none: - (a count of identities, not a measure) | daily | P0 applicable, P1 applicable, P2 applicable | none | invariant-report | every stock level the invariant report examined |
| R4 | StockLevel.reservedQty equals the sum of OrderAllocation.qty | exact | none: - (a count of identities, not a measure) | daily | P0 applicable, P1 applicable, P2 applicable | none | invariant-report | every stock level the invariant report examined |
| R5 | inventory valuation per warehouse and company equals Qoblex | tolerance | composite-max-abs-or-relative: max(GBP 1, 0.0005 of the larger total) (owner decision D2 and unverified formula U14) | weekly | P0 not-applicable, P1 applicable, P2 applicable | none | ims-database, qoblex-file | every active IMS warehouse that has no WMS binding (declared exactly by the Qoblex export manifest, with the company it groups each under); the IMS side is the inventory snapshot of the cycle date |
| R6 | the IMS inventory subledger as of the cycle date equals Xero Inventory plus Allocated Inventory | tolerance | absolute: 1 (owner decision D1) | daily | P0 not-applicable, P1 applicable, P2 applicable | xero-balance-snapshots | ims-ledger, xero-trial-balance | the accounts configured for inventory and allocated inventory |
| R7 | open purchase orders equal Qoblex Incoming (set exact, value exact in GBP, GBP 1 across FX) | set-exact-value-tolerance | absolute: 1 (owner decision D1) | weekly | P0 not-applicable, P1 not-applicable, P2 applicable | none | ims-database, qoblex-file | every goods purchase order the VERIFIED first load created (recorded provenance) that IMS holds in a committed-incoming status, matched to the Qoblex incoming report by the recorded order reference; orders without first-load provenance are listed, not judged (the export cannot narrow it) |
| R8 | outstanding quantity of part-received purchase-order lines equals Qoblex Incoming | exact | exact: 0.0001 (stored quantities carry four decimals (plan)) | weekly | P0 not-applicable, P1 not-applicable, P2 applicable | none | ims-database, qoblex-file | every open line of those first-load orders, identified by order reference and SKU (the export cannot narrow it) |
| R9 | open sales orders equal WooCommerce by order id (set exact, value within one minor unit of the order currency) | set-exact-value-tolerance | order-currency-minor-unit: 1 minor unit (owner decision D1) | daily | P0 not-applicable, P1 applicable, P2 applicable | woocommerce-order-sweep | ims-database, woocommerce-api | the open order statuses the importer admits, enumerated one by one and walked in two full sweeps; no order is excluded by age |
| R10 | Xero control accounts (Inventory, Allocated, Transit) agree with IMS, and no IMS-originated posting reached COGS or Unearned Revenue | tolerance | absolute: 1 (owner decision D1) | daily | P0 not-applicable, P1 applicable, P2 applicable | xero-balance-snapshots | ims-ledger, xero-trial-balance | the configured control accounts; postings since the P0 start |
| R11 | Stock in Transit equals the open-purchase-order transit schedule, and the transit account differs from the allocated account | tolerance | absolute: 1 (owner decision D1) | weekly | P0 not-applicable, P1 not-applicable, P2 applicable | xero-balance-snapshots | ims-database, xero-trial-balance | the whole IMS transit sub-ledger up to the cycle date: open purchase orders, non-open orders still holding transit (named), and the refund-in-transit leg |
| R12 | VAT per (country, reporting category, period) agrees across IMS, Xero and WooCommerce | set-exact-value-tolerance | absolute: 0.05 (owner decision D1) | monthly | P0 not-applicable, P1 applicable, P2 applicable | xero-tax-rates, woocommerce-order-sweep | ims-ledger, xero-api, woocommerce-api | the latest 2 calendar months (UTC) closed for the cycle date (it is the 8th of the following month or later) that began at or after the recorded first load and storefront import, sales VAT excluding shipping |
| R13 | WooCommerce, IMS and Xero use the same set of VAT rates: every tax rate is mapped, and the three agree on percentage, country, report type, tax class, compounding and components | presence | none: - (a count of identities, not a measure) | daily | P0 not-applicable, P1 applicable, P2 applicable | xero-tax-rates | ims-database, woocommerce-api, xero-api | the full tax-rate lists of WooCommerce and Xero and the IMS tax rates: every WooCommerce rate, every active IMS sales rate and every active custom Xero sales type (the VAT set, judged by identity); Xero's built-in types, inactive, purchase-only and reverse-charge IMS rates and Xero types that are not active or cannot be applied to revenue are out of scope |
| R14 | every SKU is present in Qoblex, WooCommerce, Mintsoft and IMS, except the written exclusions | presence | none: - (a count of identities, not a measure) | weekly | P0 not-applicable, P1 applicable, P2 applicable | none | ims-database, qoblex-file, woocommerce-api, mintsoft-api | the union of the SKUs of the systems read (Qoblex, WooCommerce top-level products, Mintsoft, IMS), each in every system, minus the unexpired written exclusions (one SKU in one system) and the variations the storefront walk cannot see |
| R15 | the invariant report shows zero critical findings and every warning is accepted in writing | exact | none: - (a count of identities, not a measure) | daily | P0 applicable, P1 applicable, P2 applicable | none | invariant-report | the whole invariant report |
| R16 | every foreign-currency Xero invoice, bill, credit note and payment carries the IMS central rate at its date (Xero convention, six decimal places) | exact | absolute: 0 (owner ruling 2026-10-24: one central rate, compared to six decimal places) | monthly | P0 not-applicable, P1 applicable, P2 applicable | none | ims-database, xero-api | every foreign-currency Xero invoice, bill, credit note (draft, submitted, authorised or paid) and payment dated in the latest 2 calendar months (UTC) closed for the cycle date (the 8th of the following month or later); documents in the base currency, and voided or deleted documents, are out of scope and counted |
<!-- /reconciliation-pack:items -->

### Reading the IMS side

<!-- reconciliation-pack:readers -->
The IMS side of every comparison is read by lib/reconciliation-pack/ims-readers.ts in ONE transaction opened `REPEATABLE READ, READ ONLY` with a statement timeout. The transaction proves what it asked for: `transaction_read_only` and `transaction_isolation` are read back, the snapshot is read at the start and at the end and must be equal (else BASIS_MOVED), the only statements sent are SELECTs and three fixed SET LOCALs, and it is always rolled back. Sections: the cluster identity, the population boundaries, stock levels (stock-tracked product types; the others are returned in a separate list, excluded and never compared), products, open sales orders (PENDING_PAYMENT, ON_HOLD, PROCESSING, ALLOCATED, PICKING, PACKING) with their storefront links and external dates, the importer's admitted storefront order statuses and the storefront connector's status mapping rows, tax rates and mappings, the stored copy of Xero's tax-rate list for the connected organisation with its header (count and digest, which prove it is one complete read), connector-confirmed Xero sync rows (SYNCED, a document id, no operator assertion), the stored inventory and balance snapshots of the cycle date (rows without a run row, or a different number of rows than the run row counts, are READ_INCOMPLETE), the warehouse bindings with their stock-sync mode and whether alignment is confirmed, and the Xero postings of R10 (the first-load record, and every sync-log row of the Xero connector that could be a write: SYNCED, PROCESSING, or carrying a document id, of any type, with its own status and instant). Every section is read in full: a section over its row cap is CAP_EXCEEDED, a statement timeout is READ_INCOMPLETE, and a row that cannot be read exactly (no id, a value that is not a plain decimal, an unknown enum, a duplicate identity) makes its whole section unreadable; nothing is dropped, defaulted or shortened.
<!-- /reconciliation-pack:readers -->

### Population boundaries

<!-- reconciliation-pack:population -->
The population an item compares is bounded by RECORDED identities, never by a guess: the first-load run record (only a VERIFIED run counts), the storefront initial-import completion setting (only the text `true` counts) and the sales-order retention setting (absent means keep everything). An identity created before a recorded boundary is listed as out of population with one of these reasons, and is never a finding; an identity whose boundary has no record, or that has no creation instant, is unknown and makes its item inconclusive. An instant equal to a boundary is inside. A recorded instant bounds a population here and nowhere else: two runs are never ordered by a timestamp.

| Out-of-population reason | Meaning |
|---|---|
| BEFORE_FIRST_LOAD | the identity was created before the recorded, verified first load, so IMS never held it |
| BEFORE_STOREFRONT_IMPORT | the storefront order was created before the recorded initial import, which brought in active orders only |
| OLDER_THAN_RETENTION | the identity is older than the recorded sales-order retention horizon |
| NOT_REFERENCED_BY_IMS | an ACTIVE Xero tax type that no active IMS tax rate, no active component of one and no reverse-charge setting names, so IMS does not use it and it is not compared |
| ALIGNMENT_CONFIRMED | stock of a warehouse bound to the warehouse system whose alignment is confirmed (ALIGN_TO_WMS with a confirmation stamp): the sync keeps IMS equal to the warehouse system by construction, so the claim says nothing there |
| BINDING_NOT_ACTIVE | stock of a warehouse bound to the warehouse system whose binding is inactive or whose stock sync is DISABLED: nothing keeps it current and nothing reads it |
| KIT_DERIVED_STOCK | an IMS KIT product, or a warehouse-system row flagged as a bundle: the stock is derived from components on both sides, so no stored figure is compared |
| NO_WMS_LINK | an IMS stock-tracked product that has no warehouse-system product link and whose SKU the warehouse system does not list, so it has no identity there to compare |
| WMS_ZERO_NO_IMS_PRODUCT | a warehouse-system stock row of zero for a SKU that no stock-tracked IMS product carries, so there is no IMS figure to differ from |
| NO_STOREFRONT_LINK | an open IMS sales order that no WooCommerce order id is recorded for (created in IMS, or from another channel), so it has no storefront identity to compare |
| VARIATION_NOT_WALKED | R14: a SKU that is a product variation (VARIANT in IMS or in the Qoblex export); the storefront walk lists top-level products only, so the storefront side of that SKU is not judged |
| NO_SKU_ON_STOREFRONT | R14: a storefront product with an empty SKU, which has no SKU identity to compare; it is listed under its storefront id |
| REPORTED_NOT_JUDGED | R5: a SKU and warehouse whose own valuation differs between IMS and Qoblex by more than 0.5% of the larger value; reported for the operator, never decisive (the warehouse and company totals decide) |
<!-- /reconciliation-pack:population -->
### Settling a difference

<!-- reconciliation-pack:settling -->
A difference is not a failure the first time it is seen: a vendor can lag, and an order created moments before the read is on one side only. Only an item whose catalogue row says it settles does this (today R9, whose dependent stream is woocommerce-order-sweep, and R1, whose dependent stream is mintsoft-stock-sync, because stock moves between the IMS read and the Mintsoft read exactly as an order is created between two reads); every other item still fails on the run that sees a difference. A keyed difference (an identity on one side only, or a value beyond the tolerance) is carried as unsettled with the last-success stamp of the stream it was read under. It becomes a failure only when it is still there after 2 LATER successful runs of that stream, observed as 2 further DISTINCT last-success values. The stamps are compared for equality only, never for order: a repeated stamp is the same run and makes no progress, and a stamp that merely looks older than the one before still counts as a distinct run. A difference that disappears is dropped (it is no longer listed, and if it returns it starts again). While anything is unsettled the item is inconclusive (UNSETTLED_PENDING), never a pass. The stream stamp is also read at the start and end of an item's read; if it differs the read is BASIS_MOVED and that run counts for nothing. The same item's result is also never a pass when the stream is stale or off. IDENTITY: a difference is the identity token plus its kind (on the IMS side only, on the vendor side only, or a value that differs) plus the values and currencies it was seen with; a value that changes between runs is a NEW difference, first seen now, not a continuation. CARRIED STATE comes only from the newest report of the trusted chain (the same trust rules the readiness gate uses): each unsettled entry, and each failing entry of an item that settles, records the report sequence it was first seen in, the stamp it was first seen under, the later distinct stamps counted so far and their count. It is used only if that report is for the same installation (system identifier) and phase, its item was compared to the end (a pass, a fail, or unsettled-pending), its listing was not capped, its stream bracket was stable, and the entries add up to the item's own counts. Otherwise there is NO carried state: every current difference is first seen, the item carries SETTLING_STATE_UNUSABLE beside UNSETTLED_PENDING, and it cannot mature into a failure until a usable report precedes the run; it is never a pass and never taken as settled. The state is not looked for further back than the newest report, so a run that did not compare the item (not selected, vendor reads off, a stale or moved stream) starts the count again; that delays a failure and never brings one forward. An unreadable, untrusted or forked chain refuses the run before anything is compared. Carried identities are judged first and listed first within each bucket, so a cap on the listing cuts an identity first seen now before one already settling. The readiness gate reads UNSETTLED_PENDING (and SETTLING_STATE_UNUSABLE) as unreadable, never as a pass.
<!-- /reconciliation-pack:settling -->

### Liveness bracket

<!-- reconciliation-pack:liveness -->
Before and after its reads the pack reads the read-sync status report (the same report `npm run read-sync:status` prints) and compares the two reads. Each item names, in the catalogue above, the streams it depends on. An item cannot pass unless every entry of every such stream (one per binding for the Mintsoft stock sync) was `fresh` at BOTH reads, with a last-success stamp, and the stamp is EQUAL at both reads. Stamps are compared for equality only, never for order or age; "fresh" is the status report's own judgement against the stream's limit.

An item is also withheld when the scheduler could not be examined, the crontab could not be read or the managed block cannot be trusted, at either read (this applies to EVERY item, including those with no dependent stream, such as R2 to R4), or when a job the item's streams depend on is unscheduled or switched off. A stream with no entry, two entries for one instance, or an entry that appears in only one read is not fresh. If either read of the status report fails, is not the shape the report defines, or contradicts itself (an entry marked `fresh` that is older than its own limit, dated in the future or without a stamp; a `stale` one that is young; an age that is not the distance from the report's clock to the stamp; counts that are not the tally of the entries; a scheduler that was not examined yet names a problem), EVERY item is inconclusive, including items with no dependent stream: liveness that could not be read is never taken as healthy. The command makes the two reads by running the status command as a child process (see usage). The item keeps its numbers; its outcome is inconclusive with STALE_BASIS (not fresh, or the scheduler), BASIS_MOVED (fresh, but a stamp or an instance moved between the reads) or SOURCE_UNREADABLE (a read failed). The published stream bracket of a stream that is not clean has no end stamp, so the report writer and reader refuse a pass on it.
<!-- /reconciliation-pack:liveness -->

### As-of basis and what to switch on

<!-- reconciliation-pack:basis -->
The as-of basis is the stored evidence a ledger item (R6, R10, R11) compares on. It is read for one cycle date D (default: yesterday, UTC) and reads stored snapshots only: it makes no vendor call and writes nothing. It is AVAILABLE only when ALL of the following hold, and otherwise it names the first reason that fails, from the table below.

- the Xero plugin is on and each of the five accounts has a configured code: Inventory, Allocated Inventory, Stock in Transit, Cost of Goods Sold and Unearned Revenue;
- for each of the five accounts there is exactly one stored trial-balance balance, fetched under the Xero organisation connected now (a balance with another or no recorded organisation is never used), whose balance date is EXACTLY D, in the base currency. The latest balance on or before D is never used, and neither is a later one: a balance for another date is `not_for_date`;
- every one of those balances says where it came from: a row Xero reported, `absent-from-complete-tb`, the zero the pull records for a configured account that a trial balance which proved itself complete omitted (one Total summary row, with the YTD Debit and YTD Credit of every row adding up to it exactly; Xero leaves a no-balance account out, so the omission is then a true zero), or `absent-from-tb`, a zero recorded for an omitted account without that proof (stored by an earlier build). The proven zero is read as a real, reported zero (the inventory comparison and the transit leg use it) only when it is stored at the current parser version with an amount of exactly zero; the report evidence lists it under `provenFromCompleteTrialBalance`. An absent-from-tb zero is carried with that label, is listed under `absentFromTrialBalance` and is never an explicit zero; a non-zero amount under either absent label is `basis_unreadable`; a balance with none of the labels (stored by an older build) makes the basis unavailable until the date is pulled again;
- an inventory snapshot run row exists for D, every inventory snapshot row for D is point-in-time reliable, and the rows are exactly as many as the run row recorded. A run row with no rows is a true zero stock position, and is the named empty-population proof;
- the Xero balance-snapshot stream was fresh and unmoved at both liveness reads.

Every IMS read of the basis is made in ONE read-only REPEATABLE READ transaction with a statement timeout, so the settings, the ledger balances and the snapshots are one consistent view; the transaction's mode is read back and a basis is not built if it is not what was asked for. The inventory subledger is compared with Inventory plus Allocated Inventory by the existing pure evaluator, unchanged. The pull that stores the balances now includes Unearned Revenue, taken from the same trial-balance response as the other four (no extra call); Unearned Revenue is a credit-balance liability, so its stored amount (debit minus credit) is normally negative.

The Stock in Transit leg (R10 only) is separate and never makes the basis unavailable. Transit is a clearing account whose sub-ledger has no opening balance, so only a MOVEMENT is comparable (the existing transit evaluator says why): the movement of the stored transit balance between the day before D and D, against the transit sub-ledger movement with a journal date after the day before D and up to D. The balance for the day before D must meet every rule of the five above (exactly one stored row, for exactly that day, the connected organisation, the base currency, a finite number, a provenance label), the sub-ledger must be recorded as covering that day (the `transit_ledger_coverage_start_date` setting, a plain date on or before the day before D), and a balance that is the unproven zero the pull records for an account the trial balance omitted (absent-from-tb) is never a reported zero at either end of the window, whereas a zero stored under the completeness proof (absent-from-complete-tb) is. The leg's rows are part of what the settle step compares, so a change to any of them while the run was reading is `basis_moved`.

| Basis reason | Meaning |
|---|---|
| no_account_configured | the Xero plugin is not on, or one of the five accounts (Inventory, Allocated Inventory, Stock in Transit, Cost of Goods Sold, Unearned Revenue) has no configured code |
| inventory_accounts_shared | Inventory or Allocated Inventory is configured with an account code another of the five accounts also uses, so the inventory comparison would not be over the inventory ledger alone |
| no_gl_snapshot | no stored trial-balance balance exists, on any date, for a configured account |
| not_for_date | stored balances exist for a configured account but none for exactly the cycle date; a balance for an earlier or later date is never substituted |
| gl_account_identity | the chart does not name exactly one active account for a configured account code, or the stored balances under that code were pulled for a different account (the code was reassigned) |
| gl_snapshot_ambiguous | more than one stored balance exists for one configured account on the cycle date |
| gl_snapshot_other_tenant | the stored balances for a configured account on the cycle date were fetched under a different Xero organisation than the one now connected, or do not record which one; they are never used. Pull the date again under the connected organisation |
| gl_snapshot_unlabelled | a stored balance for the cycle date does not say whether Xero reported the account or the account was absent from the trial balance, with or without the completeness proof (it was stored by an older build); pull the date again |
| no_subledger_snapshot | no inventory snapshot run row exists for the cycle date |
| unreliable_subledger_snapshot | at least one inventory snapshot row for the cycle date is not point-in-time reliable |
| subledger_snapshot_incomplete | the number of inventory snapshot rows for the cycle date is not the number its run row recorded |
| basis_moved | the stored balances or the subledger for the cycle date changed between the read inside the liveness bracket and the read after it (a scheduled pull or an on-demand refresh wrote them during the run) |
| stream_not_fresh | the Xero balance-snapshot stream was not fresh and unmoved at both liveness reads, or liveness could not be read |
| basis_unreadable | the basis could not be read: the cycle date is not a real calendar date, a database error or timeout, or a stored value that is not a finite number |

| Transit leg reason | Meaning |
|---|---|
| transit_ledger_not_covering | the recorded first day the transit sub-ledger covers is missing, is not a date, or is later than the day before the cycle date, so the sub-ledger does not cover the window |
| transit_balance_unusable | the stored transit balance for the day before the cycle date is missing, ambiguous, from another organisation, unlabelled, in another currency or not a finite number, or the transit account shares its code with another of the five accounts, or the sub-ledger sum is not a finite number |
| transit_absent_from_tb | the transit balance at the start or the end of the window is the zero the pull records for an account the trial balance omitted without the completeness proof; an account Xero did not report is never read as a reported zero (the proven zero, stored under the absent-from-complete-tb reference, is a real zero) |
<!-- /reconciliation-pack:basis -->

### Ledger items R6 and R10

<!-- reconciliation-pack:ledger -->
R6, R10 and R11 compare IMS with the Xero ledger for one cycle date D, from the SETTLED as-of basis alone: they read no live balance, make no vendor call and run only after the liveness bracket is closed. A basis that is not available is the item's inconclusive result with the basis's own reason (STALE_BASIS, BASIS_MOVED or SOURCE_UNREADABLE); a basis for another date is never used; and a base currency other than GBP is CURRENCY_UNKNOWN, because the tolerances are stated in GBP. A difference needs no settling: both sides are stored for D.

**R6.** The IMS inventory sub-ledger as of D against Xero Inventory plus Allocated Inventory, within GBP 1 inclusive (owner decision D1), as one identity, `ledger-inventory-allocated`. The existing evaluator (`evaluateAccountGlReconciliation`) is used unchanged and the pack's own comparison must agree with its verdict; if the two disagree the item is inconclusive and nothing passes. At P1 the strict figure is recorded and the P1 pass rule is R5 (owner decision D2); strict at P2. If either Xero balance is the zero the pull records for an account the trial balance omitted, the comparison is withheld, not made against a zero: GL_LEG_ABSENT.

**R10.** Phase P1 only (IMS posts to Xero by design at P2, so the claim below cannot be made there; at P2 the item reports NO_RUNNER, and at P0 it is not applicable). (a) the same inventory comparison as R6, and the Stock in Transit movement of the cycle day against the transit sub-ledger movement (the transit leg of the basis), each within GBP 1 inclusive, as the identities `ledger-inventory-allocated` and `ledger-transit-movement`; (b) ZERO IMS-originated writes to Xero since the first load began (owner decision D5, measured on the IMS side: COGS and Unearned Revenue have no other test at P1). Each sync-log row of the Xero connector that could be a write (SYNCED, PROCESSING, or carrying a document id; any type; an operator-asserted row and a failed row with a document id included) is an identity on the IMS side only, named by its id; one is a finding, so the item FAILS and lists each. The population is bounded by the RECORDED first-load run (only a VERIFIED run counts, and the instant is when the load STARTED); a row's instant is the latest of its sync time, processing start and creation time: a row older than that is listed as out of the population and is never a finding; a row at exactly that instant is inside; a row whose instant cannot be read, or a first load that is not recorded and verified, is NO_POPULATION_RECORD (never a pass, even when nothing was sent). The postings are read at run time, not as of D: a write made after D is still a write since the first load. The postings are read in full or CAP_EXCEEDED.

**R11.** Phase P2 only (at P0 and P1 it is not applicable and nothing is read). The stored Stock in Transit balance of Xero for the cycle date against the OPEN-PURCHASE-ORDER TRANSIT SCHEDULE of IMS, within GBP 1 inclusive (owner decision D1), as the identity `ledger-transit-balance`; the existing evaluator must agree with the pack's own comparison, and because it rounds to the penny a gap in the sub-penny sliver just above GBP 1.00 is inconclusive (SOURCE_UNREADABLE), never a pass. **The schedule** is IMS's WHOLE transit sub-ledger up to the cycle date (`transit_subledger_movements`, one signed base-currency row for every posting to the Stock in Transit account; owner ruling 2026-10-24: the balance holds all of it, so the comparison must): the sum of every row, which is the value in transit of each purchase order (open or not) plus the refund-in-transit leg. The source types are the nine the posting code records (PURCHASE_BILL, PURCHASE_BILL_UPDATE, SUPPLIER_CREDIT_NOTE, STOCK_RECEIPT, LANDED_COST_RECLASS, LANDED_COST_CONSUMED_OFFSET, PURCHASE_ORDER_CANCEL, SUPPLIER_RETURN, CUSTOMER_RETURN_IN_TRANSIT: `lib/domain/accounting/transit-subledger-movement.ts` and its callers); one it does not know is unreadable. A row belongs to an order by its recorded source: the order id for a bill, bill update, receipt, cancellation and landed-cost leg, the order of the return for a supplier return, and the order of the credit note for a supplier credit note; the refund-in-transit leg belongs to no order. **Completeness:** the sub-ledger records postings only after its recorded coverage watermark (`transit_ledger_coverage_start_date`) and has no opening balance, so the schedule is proven complete only if the watermark is recorded, a real date on or before D, and NOTHING that can hold unrecorded transit history predates it: every DURABLE source document of every source type was created after it - purchase orders of any type and status (cancelled and closed included), purchase invoices (bills), purchase receipts, purchase (supplier) returns, supplier credit notes, landed-cost links and revaluation runs, customer refunds (every one, whether or not it went to transit: the first load runs on an empty database, so nothing legitimately predates the watermark) and return expectations - and no sub-ledger row is dated before it (a row before the watermark contradicts the recorded boundary itself). Nothing rests on a log: the retention job (`purgeExpiredData`) prunes only the shopping and accounting sync logs, the warehouse-system sync jobs, cost-of-sales entries and stock movements (the activity log has its own sweep), and none of those tables; only the operator's reset action deletes a source document, and it wipes the ledger with it. The accounting sync-log count of refund reversals marked as debiting transit is an additional signal only. otherwise NO_POPULATION_RECORD, never a short schedule - offsetting amounts could otherwise make the balance equal a partial ledger. All three are counted inside the same read-only snapshot. A row of a source type the pack does not know, or one naming an order IMS does not hold, makes the schedule unreadable. **The named residue list:** the purchase orders that are NOT open (not in a committed-incoming status) but still hold a non-zero transit balance are LISTED by identity with that residue under outOfPopulation (reported, never judged, so the list does not change the outcome by itself); their value is IN the total, as is the refund-in-transit leg (which is not listed). **The accounts:** the transit account must be its own. Transit configured on the Allocated Inventory code leaves no basis at all (inventory_accounts_shared), and transit on the COGS or Unearned Revenue code is SOURCE_UNREADABLE; nothing is compared. A transit balance that is the zero the pull synthesised for an account the trial balance omitted is GL_LEG_ABSENT, never a zero compared with an empty schedule.

Any leg that cannot be read withholds the whole of R10, naming every cause once: GL_LEG_ABSENT (an account the trial balance omitted without the completeness proof, at either end of the transit window), NO_POPULATION_RECORD (the sub-ledger coverage is not recorded, or the first load is not), SOURCE_UNREADABLE (any other basis or read problem). The report builder judges the result again, and a result it refuses is INTERNAL_ERROR.
<!-- /reconciliation-pack:ledger -->

### Vendor items R1, R9, R12 and R13

<!-- reconciliation-pack:vendor -->
R1, R9, R12, R13 and R16 are the items that read a vendor (R1 Mintsoft; R9 and R13 WooCommerce; R12 WooCommerce and Xero; R16 Xero). They are read only when the run is started with `--vendor-reads-only`; without it each is inconclusive with VENDOR_READS_OFF as its only reason, NO vendor credential is read, NO request is made and nothing is listed. The readiness gate reads that single reason as not available (the state the slot had before the pack could read vendors), so a run without the flag is never a pass and never a block that was not already there. The flag never enables a write: the transport has no method parameter, and the connector fetch seam is given a gate that refuses, before anything is sent, every request that is not a GET to `/wp-json/wc/v3/orders`, `/products` or `/taxes` on the store's own origin with only the parameters status, page, per_page, orderby, order, _fields, after and before, and refuses a redirect without requesting its target. The Mintsoft transport is given the same kind of gate: it refuses, before anything is sent, every request that is not a GET to exactly `/api/Product/StockLevels?WarehouseId=<n>` or `/api/Product/List?PageNo=<n>&Limit=<n up to 100>` on the connection's own origin and that the connector's read allow-list (MINTSOFT_READ_ALLOWLIST) does not list as a read, and refuses a redirect without requesting its target (Mintsoft mutates through GET). The Mintsoft key is the stored FIXED API key and nothing else: before any request the pack reads `mintsoft_auth_mode`, which must be exactly `api_key` (absent means the default, `credentials`, which logs in), the key `mintsoft_static_api_key`, `mintsoft_client_id` (a positive whole number; every row read must carry it) and the one Mintsoft connection's address, in a read-only transaction; anything else is VENDOR_AUTH_REFUSED or SOURCE_UNREADABLE and NO request is made. `POST /api/Auth` mints a new tenant key and would knock the order sweep and the label service offline; the pack has no code path that can reach it, and a 401 is reported, never refreshed. The environment fallbacks of the application (MINTSOFT_AUTH_MODE, MINTSOFT_STATIC_API_KEY) are not read, because the pack's environment is a short whitelist: an installation configured through the environment alone is refused, never guessed. The Xero transport of R12 and R16 is the same kind of thing: a gate that refuses everything but a GET to `https://api.xero.com/api.xro/2.0/Organisation` (no parameter), `/Invoices` or `/CreditNotes` (exactly the parameters where, Statuses and page, the `where` of one fixed shape) or `/Payments` (exactly where and page, no status), and a refused redirect. The storefront credentials are three settings rows read on the first request in a read-only transaction; nothing a response says, no URL and no message reaches output, and identities are the sanitised tokens of the tokens section.

**How a walk proves a list.** Orders are walked one status at a time (never one request for all: a multi-status request is unverified on the live store, U4), as a DOUBLE SWEEP: sweep A walks every admitted open status in order, and sweep B walks them all again, starting only after A finished. Products and tax rates are walked in full, each twice. A list is used only if every response is HTTP 200 with a JSON array and carries X-WP-Total and X-WP-TotalPages as plain whole numbers; the total is within the cap of the walk (CAP_EXCEEDED otherwise) and the page count is exactly the total over the page size, rounded up; every page reports the same total and page count; each page but the last is full and the last holds the remainder; rows arrive in strictly ascending id order, none twice; the rows read are as many as the total reported; every field is validated (an order in another status than the one asked for, a currency outside the known list, a total that is not a plain decimal is SOURCE_UNREADABLE); and the whole walk (for orders, the whole sweep) is then read a second time and must equal the first row for row. For orders the comparison is of the COMBINED population of the two sweeps: every order id with its status, currency, total and date, and every status total, must be identical, and an order in one sweep only is VENDOR_READ_UNSTABLE. A per-status double read would miss an order that moves from a later open status to an earlier one between two status walks. The empty proof needs a total of zero for every status in BOTH sweeps. NOT PROVEN: an order that moves between open statuses twice within one run (out and back) could be missed by both sweeps. A missing or malformed header, a non-200 answer, a malformed body, a transport error and an exhausted request budget are SOURCE_UNREADABLE or CAP_EXCEEDED; a repeated row, a short page, a changed total or a second read that differs is VENDOR_READ_UNSTABLE. In every such case there is no list at all, never a partial one. Requests are sequential, at most four a second, and at most 400 in a run. NOT PROVEN (U4, open): that the store's per-status totals equal what wp-admin shows; a store that does not honour the headers is unreadable. Variations of variable products are a separate collection and are not walked.

**How the Mintsoft reads prove a list.** The stock list of a warehouse (`GET /api/Product/StockLevels?WarehouseId=<n>`) ignores paging and carries no total, so one request per warehouse is the whole list and its completeness is claimed by AGREEMENT: every in-population warehouse is read once (sweep A) and then every warehouse is read again (sweep B, starting only after A finished), and the COMBINED populations of the two sweeps (warehouse, SKU, Mintsoft product id, on-hand figure and bundle flag of every row) must be identical, else VENDOR_READ_UNSTABLE and no list. Each response is read by the connector's strict stock reader (exact field names; the on-hand figure is `TotalStockLevel`, owner decision U1, and `Level` is the available figure and is never compared; a body that is not an array, a row with no SKU or no on-hand figure, a figure that is not a non-negative whole number, an available figure above on-hand, or a SKU twice in one response makes the whole response unreadable) and every row must also name the warehouse asked about, the configured Mintsoft client and a boolean bundle flag, with a positive whole product id that no other row repeats. One SKU under two product ids, one id under two SKUs, or one id flagged a bundle in one warehouse and plain in another, across the warehouses is IDENTITY_CONFLICT. The PRODUCT CENSUS (`GET /api/Product/List`) pages from 1 at a limit that is CLAMPED to 100 and never configured (Mintsoft answers 400 at 101), gives no total and no ordering, and is proven by: every page before the last holding exactly the limit and none more; the last page SHORT (an empty one included) and the page AFTER it requested and required to be empty (a short page is a claim, and a truncation that repeats looks exactly like an end until the next page is asked for); no id and no SKU twice in a scan; the scan read a second time, after the stock sweeps, and equal as a set of (id, SKU) pairs (no ordering is assumed); and finally CONTAINMENT, independent of how Mintsoft pages: every product any stock list shows must be in the census under the same SKU (absent is READ_INCOMPLETE, another SKU is IDENTITY_CONFLICT). The census is how a SKU Mintsoft does not have is told from one its stock list omitted. NOT PROVEN, stated: that the pages are a window over one stable permutation of the whole set and not a keyset walk that skips the same row every time; containment covers every product that has a stock row, so only a product with no stock row anywhere that the paging also skips could be missed. The live product-list row shape was read on 2026-10-23 (ID, SKU, ClientId, Bundle, DisCont and others): the pack reads one of ID, Id or id, SKU, a boolean Bundle (required) and ClientId when present; a row it cannot read makes the census, and so the item, unreadable, never a smaller list. The bundle flag is part of a product's identity: it must be the same in every warehouse's stock list and in the census, else IDENTITY_CONFLICT. DisCont (discontinued) is read by nothing: a discontinued product is still compared (509 of the 2386 live rows are DisCont, and they still have stock rows), which is stated here rather than decided. Requests are sequential, at most about three a second, and at most 500 in a run; the budget being exhausted is CAP_EXCEEDED.

**R1.** Mintsoft stock against IMS, per (warehouse, SKU), EXACT (the catalogue's 0.0001; an IMS quantity that is not a whole number cannot equal Mintsoft's whole number and makes the item BAD_VALUE rather than being absorbed by the tolerance). IMS side: `stock_levels.quantity`, which is ON HAND (reservations are `reservedQty`, apart), read with the product links, the products and the warehouse bindings in ONE REPEATABLE READ snapshot; a product with no stock row in a warehouse holds 0 there, as the sync reads it. Mintsoft side: `TotalStockLevel`. POPULATION (assertion F5, made in the same snapshot as the stock): a binding of Mintsoft is in the population only when it is active, its stock sync is not DISABLED and its alignment is UNCONFIRMED (NOTIFICATION_ONLY always, ALIGN_TO_WMS while it has no confirmation stamp); an inactive or DISABLED binding (BINDING_NOT_ACTIVE) and a confirmed alignment (ALIGNMENT_CONFIRMED, where the sync keeps IMS equal by construction) are out, their IMS stock listed under the out-of-population bucket and never compared; a warehouse with no Mintsoft binding is not part of the claim and is not listed; a binding whose stored mode or flags cannot be read exactly makes the whole item SOURCE_UNREADABLE; the bindings are read again in a second snapshot after the Mintsoft reads and must be unchanged (BASIS_MOVED), so a warehouse confirmed or re-pointed while Mintsoft was being read is not judged. PRODUCTS are matched by SKU, the identity the stock sync itself uses. An IMS product of type SIMPLE, VARIANT or BOM is compared; it is in the population when it is LINKED to Mintsoft (a product link row) or, unlinked, when the census lists its SKU (so a missing link cannot hide stock Mintsoft holds); an unlinked product the census does not list is out (NO_WMS_LINK), listed with its IMS figure and never compared. A KIT is out (KIT_DERIVED_STOCK) and so is a Mintsoft row flagged as a bundle: the stock is derived from components on both sides; a KIT that Mintsoft lists as a plain product, or a plain IMS product it lists as a bundle, is IDENTITY_CONFLICT for the whole item. NON_INVENTORY and VARIABLE products are not stock-tracked and take no part. A linked product's recorded Mintsoft product id must be the id the stock row and the census hold for that SKU, else IDENTITY_CONFLICT (a swap is never read as two quantities). A Mintsoft row with no comparable IMS counterpart is onlyVendor when its on-hand figure is positive and out (WMS_ZERO_NO_IMS_PRODUCT) when it is zero. A product IMS links that Mintsoft does not list at all (no stock row, not in the census) is onlyIms; a product the census lists but whose warehouse stock list has no row for it cannot be told from a zero and is READ_INCOMPLETE for the whole item, never a zero. R1 SETTLES (owner decision D7): stock moves between the IMS snapshot and the Mintsoft read exactly as an order is created between two reads, so a difference first seen is UNSETTLED (inconclusive UNSETTLED_PENDING) and fails only when it is still there after two LATER successful runs of mintsoft-stock-sync. Nothing is compared as empty without proof: the proof `alignment-confirmed` (every binding of Mintsoft, inactive and DISABLED ones included, is a confirmed alignment and at least one exists: the claim is retired by construction, Mintsoft is not asked, and the pass names only the IMS source) or `vendor-total-zero` (every stock list and the census empty in both reads); no Mintsoft binding at all, or only inactive or disabled ones, is NO_POPULATION_RECORD, and a confirmed binding beside an unconfirmed one that is inactive or disabled (so not compared) is BINDING_UNCONFIRMED_NOT_COMPARED. Mintsoft being configured to log in (anything but the fixed-key mode) is VENDOR_AUTH_REFUSED with no request made.

**R9.** Open sales orders against WooCommerce, by WooCommerce order id. IMS side: every sales order in PENDING_PAYMENT, ON_HOLD, PROCESSING, ALLOCATED, PICKING or PACKING that has a recorded WooCommerce order id; an open order without one is listed as out of the population (NO_STOREFRONT_LINK) and never compared. Vendor side: the statuses the importer admits, by every route that admits by status (the `wc_sync_order_statuses` selection; absent means its default, processing; a value that is not a list of non-empty strings is unreadable, not defaulted; plus, whenever the selection is not empty, the two customer-withdrawal statuses from the `wc_withdrawal_submitted_status` and `wc_withdrawal_approved_status` settings (a default when absent or empty, unreadable when not a status), `completed` (the reconcile sweeps) and `delivered` (the manual historical import); an empty selection admits nothing on the sweeps, the webhook or the initial import), each walked if its effective reading is an open IMS status, the withdrawal-submitted status always (an IMS hold must find its storefront order), read through the status mapping rows and then the connector's built-in table (pending and failed are PENDING_PAYMENT, on-hold is ON_HOLD, processing and refunded are PROCESSING). The mapping rule is the importer's own (the connector's status lookup): a row matches a status only if its key equals the status or `wc-` and the status, ignoring case and with no trimming, and the row equal to the status itself wins. A SELECTED status with no reading at all, or any admitted status whose matching rows disagree, is UNKNOWN_STATUS (a route-added status with no reading is closed, as the importer closes it); a store order in a withdrawal-submitted status that IMS lacks is reported even though the importer skips an unlinked withdrawal on purpose; a stored row whose key only normalises to an admitted status (padded, or an odd prefix), which the importer would never match, is AMBIGUOUS_STATUS_MAPPING; either makes the whole item inconclusive and no request is made. The set must be exact; the value is the order total in the order's own currency, and it must agree within one minor unit of that currency (owner decision D1: 0.01 for GBP, 1 for JPY); a different currency is a difference. Every identity is judged and NO order is set aside by its age. The importer admits an order by its CURRENT status alone, whatever its age: the initial import asks the store for the selected statuses with no date bound (initial-import.ts:270-276), the ongoing sweep asks for the selected statuses modified after a cursor (order-import.ts:3160-3166), and a webhook admits on the current status (order-status-filter.ts:166). So an order created before the initial import that entered an open status later is one IMS should hold, and one it lacks is a finding. Retention archives only terminal orders (data-retention.ts:689-706), so it never removes an open order. The pack does not compare a storefront timestamp with an IMS one to exclude an order (cross-system clock ordering); R9 reads no population boundary and cannot be NO_POPULATION_RECORD. The only identities set aside are open IMS orders with no storefront order id, listed. Nothing is compared as empty without proof: both sides empty passes only on the named proof per-status-total-zero (every enumerated status reported a total of zero in both sweeps, and at least one status was enumerated). R9 SETTLES (owner decision D7, the settling section): a difference is first UNSETTLED (the item is inconclusive, UNSETTLED_PENDING) and fails only when it is still there after two later successful runs of the order sweep stream, so a storefront order created moments before the read does not fail the item; the next report carries the state.

**R13.** Tax-rate mappings and VAT set identity, by presence. WooCommerce leg: every tax rate the store has (the full list, walked twice) must have an IMS mapping of the storefront connector, and every such mapping must name a rate the store still has; a rate with no mapping, or a mapping with no rate, is a finding. Xero leg: only the types IMS uses. Every Xero tax type that IMS names (the accounting tax type of an active IMS tax rate, of an active component of an active rate, and the two reverse-charge tax-type settings) must resolve to an ACTIVE type in the stored Xero list; a named type that is missing from the list, or present but not ACTIVE (deleted, archived or pending), is a finding that lists the type code. An ACTIVE Xero type that nothing in IMS names is not a finding of this leg: it is listed as out of the population with the reason NOT_REFERENCED_BY_IMS (an in-scope custom sales type is judged by the set identity below and is a finding there). The Xero list is IMS's stored copy of it (Xero is the tax-rate master): the xero-tax-rate-drift sweep reads every Xero tax rate and replaces, in one transaction, the connected organisation's list, its header row (read time, row count, digest of the rows) and the read-sync last-success stamp, and refuses a response that is empty, partial or malformed, keeping the previous list. The pack reads that list in the same REPEATABLE READ snapshot as the IMS rates, for the organisation connected NOW, and makes no request to Xero. The list is proven only if the header row exists for that organisation, its count equals the rows read, every row carries the header's read time, every row re-validates and the digest recomputed from the rows equals the header's; otherwise the Xero leg is VENDOR_LIST_UNPROVEN. A WooCommerce leg with a finding is still a fail (DIFFERENCES, with VENDOR_LIST_UNPROVEN beside it when the Xero leg is unproven), and a clean WooCommerce leg with an unproven Xero leg is inconclusive, never a pass; with both legs proven, the item names the Xero source as well and can pass. **VAT set identity (owner ruling: WooCommerce, IMS and Xero use the same set of VAT rates).** On top of the two legs above, the item judges one identity per in-scope rate and lists it under the key `vat-set|<system>|<state>|<id>`: the rates of the UK, OSS, IOSS and VOEC alike, because the rule does not depend on the scheme. **In scope:** every WooCommerce tax rate (every class and every region, the Canary Islands and PT-30 among them); every ACTIVE IMS tax rate used for sales or both that is not a reverse-charge rate; every ACTIVE, organisation-specific (custom) Xero tax type that can be applied to revenue. **Out of scope** (not listed): Xero's built-in types (a built-in type is still a valid TARGET of an IMS rate), Xero types that are not ACTIVE or cannot be applied to revenue, and IMS rates that are inactive, purchase-only or reverse-charge. **Counterparts:** a WooCommerce rate finds its IMS rate only through the storefront connector's stored mapping of the store's rate id; its country, state, postcode, city and class never choose an IMS rate (a regional rate needs its own mapping to its own IMS rate and is WOO_UNMAPPED until it has one); the country must agree with the IMS rate's, and a second WooCommerce rate on the same IMS rate is a duplicate whatever its scope (one identical set: one WooCommerce rate, one IMS rate, one Xero type). An IMS rate finds its Xero type by the accounting tax type CODE it carries, which must be an ACTIVE type of the proven stored list. **The rules are the re-key's:** the percentage is Xero's EffectiveRate, else its DisplayTaxRate, compared as an exact decimal with the percentage IMS computes tax at (the active components' effective rate when it has any, else the rate column) and with the WooCommerce rate; the country is the WooCommerce country, the IMS country code, the IMS name prefix and the Xero name prefix, which must all agree (UK is GB, EL is GR, any case); the report type is the one the Xero rate generator gives the IMS rate against the live ReportTaxType, trimmed and in upper case. A reporting category of IOSS or VOEC is recognised where that generator files the rate under MOSSSALES (a sales rate named for an EU member state or Norway); on any other name it is REPORT_TYPE_UNKNOWN. Two further rules close the gaps an equal percentage leaves open: the tax class of the WooCommerce rate must equal the class its IMS mapping recorded (empty and "standard" are one class; case and surrounding spaces do not count), and the IMS tax category the Woo class means must equal the tax category of the mapped IMS rate (CATEGORY_DIFFERS; the class-to-category table is the order import's own, standard or empty STANDARD, zero-rate ZERO, reduced-rate REDUCED, second-reduced-rate SECOND_REDUCED, exempt EXEMPT; a class outside it is CATEGORY_UNVERIFIED, a finding and never a pass), and the WooCommerce compound flag must equal the IMS isCompound flag; and the IMS rate and the Xero type must have the same ordered components (count, each rate, compounding, and no non-recoverable Xero component), which is the re-key's componentMeaningDifference. Shipping always carries the goods' VAT rate (owner ruling): a WooCommerce rate with a positive percentage (the live Xero type's, else the IMS rate's) must have "apply to shipping" on, the rule of the VAT difference report's WOO_SHIPPING_NOT_TAXED; a zero rate is exempt, because shipping at 0% carries the goods' 0%. **Region:** IMS has no region field; it records a region only as the suffix of the rate name ("PT-30 VAT" is region 30). A WooCommerce rate's state must equal that region (REGION_DIFFERS, which includes a country-wide WooCommerce rate on a regional IMS rate); where IMS records none, a WooCommerce rate that has a state, a postcode or a city, or that shares country and class with an in-scope WooCommerce rate of another region, is REGION_UNVERIFIED, a finding and never a pass (a postcode or city IMS cannot record is always unverified). A single country-wide rate is unaffected. The IMS rate name and its Xero type name are read by the same parser and must state the same region (XERO_REGION_DIFFERS, including one regional and one country-wide); a name with a word after the country prefix that is not a hyphenated region ("PT Madeira VAT") cannot be read and is XERO_REGION_UNVERIFIED, a finding and never a pass. A WooCommerce rate must have the name of the IMS rate it maps to (WOO_NAME_DIFFERS; trimmed, whitespace runs collapsed, case ignored; the row carries both names), so a generic WooCommerce label such as "VAT" is a finding until it is renamed to match IMS and Xero. An IMS rate and the Xero type its accounting tax type code names must have the same name, trimmed, whitespace runs collapsed and case ignored, the name the re-key matches and copies from (XERO_NAME_DIFFERS; the row carries both names), so two same-rate types cannot have their codes swapped. **Reasons** (closed; a row can carry several, each listed as its own finding on the IMS side with the reason in the key; an identical row is listed on both sides): WOO_UNMAPPED, DUPLICATE_MAPPING, IMS_RATE_NOT_ACTIVE_SALES, IMS_NOT_IN_XERO, XERO_NOT_SALES_TYPE, PERCENT_DIFFERS, COUNTRY_DIFFERS, REPORT_TYPE_DIFFERS, REPORT_TYPE_UNKNOWN, CLASS_DIFFERS, CATEGORY_DIFFERS, CATEGORY_UNVERIFIED, COMPOUND_DIFFERS, COMPONENTS_DIFFER, SHIPPING_NOT_TAXED, REGION_DIFFERS, REGION_UNVERIFIED, WOO_NAME_DIFFERS, XERO_NAME_DIFFERS, XERO_REGION_DIFFERS, XERO_REGION_UNVERIFIED, MISSING_IN_WOO, XERO_NOT_IN_IMS. DUPLICATE_MAPPING is two or more WooCommerce rates on one IMS rate (listed on every one of those WooCommerce rows, whether their scopes are equal or different), or two active IMS sales rates on one Xero type. The summary (rows and identical rows by system, rows by reason) is the count of the listed keys; nothing is written anywhere and the only requests are GETs of the store's tax-rate collection. A stale xero-tax-rates stream is STALE_BASIS before anything is read.

**R12.** VAT per (country, reporting category, period) across IMS, Xero and WooCommerce; set exact, each value within GBP 0.05 inclusive (owner decision D1); it does not settle (owner decision D7 applies to R9 only). **Period:** one calendar month, UTC. The window is the latest 2 CLOSED months for the cycle date: a month is closed once the cycle date is the 8th of the following month or later (a lag after the month ended, so late postings and status changes have settled), so an unclosed month is never read. A month that began before the recorded VERIFIED first load, before the recorded storefront import or beyond the sales retention horizon is outside the population; an unrecorded boundary is NO_POPULATION_RECORD, and no month left is EMPTY_UNPROVEN. The cycle date is part of the evidence: the item's source ims-ledger is cycle-dated, so the gate requires the report's cycle date to be current (see the gate section). **Key:** (period, country, reporting category) from the IMS tax rate (its country code and its reporting category, lower case): IMS sums the line tax of its sales by rate; a WooCommerce tax line is placed by the IMS mapping of its rate id; a Xero invoice line by the Xero tax type that exactly one IMS rate carries. **Figures:** sales VAT in GBP with SHIPPING VAT LEFT OUT of every system (IMS holds it at order level with no rate, so the other two are cut to match): IMS is the base tax of the lines of orders by invoice instant, not cancelled, not archived (the IMS VAT report's own population); Xero is the line tax of AUTHORISED and PAID sales invoices by invoice date, lines on the configured shipping account left out, a foreign invoice multiplied by Xero's own CurrencyRate (Xero defines it as base currency per one unit of the document currency, as the connector's fx helper does, so EUR 50 at 0.8 is GBP 40); WooCommerce is the line tax of orders in processing, completed and refunded by GMT creation date, a non-GBP order divided by the fxRateToBase IMS recorded on the linked order (IMS stores 1 base = X foreign; the storefront records none; an order with no such rate is CURRENCY_UNKNOWN). A mapping is judged on every CONSTITUENT non-zero line (an IMS sales line, a Xero invoice line, a WooCommerce tax line) before anything is summed, so lines that cancel on an unverified rate still make the item VAT_MAPPING_UNVERIFIED (lines on the Xero shipping account are cut first, on purpose: shipping VAT is out of scope everywhere). SHIPPING VAT must be reliably cut out: the configured Xero shipping account must exist, be exactly one active account of the stored chart and differ from the sales and discount accounts, otherwise VAT_MAPPING_UNVERIFIED before any request (a shared account cannot tell shipping from goods). IMS never makes shipping a sales line (it is order level) and the storefront's shipping tax is never read. FEE lines are in IMS (a fee line becomes a sales line) but not proven to be in the storefront's tax_total, so a WooCommerce order with a non-zero fee-line tax in the window makes the item VAT_MAPPING_UNVERIFIED. A taxable Xero line counts only with a proven classification: IMS posts every goods and fee line to the sales account and the order discount to the discount account, shipping to the shipping account (cut); a taxable line with no account code, or on any other account, is VAT_MAPPING_UNVERIFIED whatever it nets to, and is never counted (a zero-tax line is harmless). Each verified key is then summed and rounded to the penny, half up; a key that nets to zero is not a key of that system, the same rule on all three sides, so a key on one side only with a non-zero value is a finding. The comparison is three legs (ims-xero, ims-woo, xero-woo) on the one comparator, each leg an identity of its own. A base currency other than GBP, in IMS or in the Xero organisation, is BASE_CURRENCY_NOT_GBP and nothing is compared. **U8 is unverified:** how Xero codes OSS, EC sales and reverse-charge sales is not known, so only the domestic category has a Xero side the pack believes, and only for a rate whose Xero tax type is its own (no other IMS rate carries it), is in the proven stored Xero list and has the verified report tax type OUTPUT there. Any non-zero VAT, in any of the three systems, on a rate that fails that (every OSS, EC sales and reverse-charge key, any key with no category, a shipping account that is not configured, not in the chart or shared with sales or discount, a non-zero WooCommerce fee-line tax, and a domestic rate with no country, no Xero tax type, a shared one, or one the proven list does not hold as OUTPUT) is VAT_MAPPING_UNVERIFIED for the whole item and nothing is compared; the IMS side is checked before any request is made. **How the Xero read proves a list:** the pack never refreshes a token (that writes the database and rotates the refresh token at Xero): the stored access token is used only while it has at least 10 minutes to live, otherwise XERO_CONNECTION_UNUSABLE until the read-sync has renewed it; the connection is judged by the connector's own tenant guard with the same inputs, must be the organisation of the proven tax-rate list, and is read at the start and end of the Xero walk and must be unchanged. The organisation is read for its base currency. The invoices are asked for with Xero's own pagination and no page size is assumed (U7): the response must carry the pagination object (page, page size, page count, item count), the item count must be within 3000 (CAP_EXCEEDED otherwise), the page count must be the item count over the page size rounded up, each page must report the page asked for and the same size, count and total as the first, every page but the last must be full and the last the remainder, no invoice may repeat, the invoices read must be as many as the item count, every invoice must ADD UP (TotalTax, SubTotal and Total present as plain numbers, LineAmountTypes one of Exclusive, Inclusive or NoTax - TaxAmount is the tax inside the line in all three - the sum of the TaxAmount of ALL its returned lines, before any cut, equal to TotalTax exactly, Total equal to SubTotal plus TotalTax, a NoTax invoice carrying no tax, and the LINE AMOUNTS adding up too, exactly as Xero stores them (2dp): Exclusive means SubTotal is the sum of LineAmount, Inclusive means Total is the sum of LineAmount, NoTax means SubTotal and Total are the sum; LineAmount against quantity times unit amount less discount is NOT checked, because Xero's rounding of those is not pinned to the penny by its documentation; an invoice with tax and no lines, or a truncated line list, is SOURCE_UNREADABLE and no figure at all), every invoice must be a sales invoice in an accepted status dated inside the window asked for (widened by a margin of whole days each side and then cut by invoice date), and the whole walk is then read a second time and must be equal invoice for invoice (VENDOR_READ_UNSTABLE otherwise). The WooCommerce read is the proven double sweep, and every order must reconcile (its total_tax equals the sum of every tax line's tax_total and shipping_tax_total exactly; otherwise SOURCE_UNREADABLE and no figure) (every status twice, widened by a margin of whole days each side and cut by GMT creation date). Xero is read with at most 40 requests in a run, at most one every 2 seconds (Xero allows 950 a day and 55 a minute, shared with the read-sync); a walk that would need more is CAP_EXCEEDED and no figure at all. TRUST BOUNDARY: R12 trusts that Xero's API returns an invoice's own line items; omitted lines are caught when the tax or the amounts stop adding up to the invoice totals, but a response that omits lines whose tax and amounts both net to zero is undetectable from one invoice response (the API gives no independent line count). NOT PROVEN: Xero's item count has no second source; the where and Statuses filters are unverified on the live service (rows outside them are refused, but invoices wrongly left out of a consistent count cannot be seen); the Xero side is every sales invoice of the organisation, not only those IMS posted; credit notes and refunds are not compared; the period of an order is each system's own date (invoice instant, invoice date, creation date), so an order near a month end can differ across systems; the storefront statuses counted are a choice (processing, completed, refunded); the daily Xero allowance is not read from the read-sync, only this run's spend is capped.

**R16.** The Xero rate check. For every foreign-currency Xero invoice, bill, credit note and payment dated in the same period as R12 (the latest 2 calendar months, UTC, closed for the cycle date), Xero's CurrencyRate must equal the IMS central rate at the document date. **The rate rule:** the date is mapped to the END of that day, UTC (the one date rule of the exchange-rate lookup); the IMS rate is the latest fx_rates row on or before that instant (1 base = rate foreign; a tie is accepted only when the rows agree), converted to Xero's convention (1 foreign = x base, x = 1 / rate, by the function that produced the rate IMS sent); both rates are rounded half up to 6 decimal places and must be EQUAL (absolute tolerance 0). **Scope:** invoices, bills and credit notes in every status (draft, submitted, authorised and paid are checked; voided and deleted ones are read, counted in the summary and set aside as out of scope because a reversed or removed document books nothing; a status of any other value makes the read unreadable) and payments (not deleted), read as proven complete lists (two equal full scans, Xero's own pagination object, the request budget); a document in the base currency is out of scope and is counted, never listed; Xero's base currency and IMS's must both be GBP. A payment has no currency of its own: it is the currency of the document it settles. **Two checks, by who posted the record.** A Xero record that IMS POSTED (a connector-confirmed sync record names its Xero id; read from the stored sync payload, which is what the poster sent, in the same read-only snapshot) is held to the rate that posting CARRIED (documents `currencyRateToBase`, payments `settlementRateToBase`), converted by the poster's own function (1 / rate, six decimals), never to a table row looked up now: a rate the table gained later the same day is not what IMS sent (check 1: Xero against the IMS posting; the entry lists the posted rate in Xero's convention against Xero's, and its identity names the sync record). Then the stored rate is held to the central table (check 2: IMS posting against fx_rates), only where the code states a date rule: a storefront-imported invoice carries the central rate at the order's creation instant (SalesOrder.externalCreatedAt, as the importer prices it), so it must be exactly the rate in force at that instant, and only when that instant is unknown a central rate in force at some instant of the order's UTC day; a storefront-imported receipt (told by its provenance: an INVOICE_PAYMENT of a storefront order whose payments row, named by the sync payload's `paymentId`, carries the importer's notes, or the importer's rate marker; so a payload from before the marker is judged too, and a storefront order's payment whose provenance cannot be proved is IMS_POSTING_UNREADABLE, never a skip) follows the importer's own same-day test (one shared function), against the order's stored rate: the order's own rate when the payment's UTC day is the order's day and ONLY then, otherwise (another day, or an unknown order instant, which is never the same day) the central rate at the end of the payment's UTC day, and a missing table rate on such a day is IMS_RATE_MISSING, never a pass through the order's rate; any other posted record (manual orders, bills, credit notes, manual payments) has no verified date rule here, is checked against Xero only and is counted in the summary (never silently). A Xero record IMS did not post (manual entries, bank feed, another tool) keeps the reconstruction against fx_rates at the document date. **Findings, each with a closed reason:** XERO_RATE_DIFFERS (both rates exist and differ; the entry lists the IMS rate in Xero's convention against Xero's), IMS_POSTED_RATE_NOT_TABLE_RATE (check 2: the stored rate and the table rate are listed as a pair), XERO_DATE_DIFFERS (for every posted record, the document or payment date Xero holds must be the date the posting carried, the same UTC day; the posted date and Xero's date are listed as a pair, as YYYYMMDD; a posting with no readable date is IMS_POSTING_UNREADABLE), IMS_POSTING_UNREADABLE (the sync record that names the Xero id cannot give a usable rate: its payload is gone, the rate or currency is missing, not positive or disagrees with Xero, the kind disagrees, a storefront record has no date, a storefront order's payment has unproven provenance, or two records name one id; listed under Xero's own rate, never a pass), IMS_RATE_MISSING (no usable IMS rate at the document date: no row, a rate that is not positive, or an ambiguous tie; the entry is listed under Xero's rate and its identity ends with the refusal reason of the lookup), DOCUMENT_UNREADABLE (a document of the proven list whose own date, currency or CurrencyRate cannot be used, a foreign one with no CurrencyRate included; listed with the value 0, which Xero never records as a rate). **Identities:** `xero-rate|<kind>|<Xero id>` with the kind sales-invoice, purchase-bill, sales-cn, purchase-cn or payment, in a fixed order. **Inconclusive, never a pass:** a Xero list that cannot be proven complete and stable (VENDOR_READ_UNSTABLE, CAP_EXCEEDED, SOURCE_UNREADABLE), a connection that is unusable or changed during the walk, a base currency that is not GBP. Nothing to compare passes only on the named proof that every list was proven and none holds a foreign-currency document. R16 does not settle: a difference is a finding at once. It is advisory at the readiness gate (listed at every phase, never blocking): documents booked before the one-rate ruling carry Xero's own rate. NOT PROVEN: that the sync record's payload is exactly what the poster sent on the wire (it is the poster's input; the poster converts it with no lookup); the live service's `where` filter on Date and the payment list's paging (unverified; a service that ignores the filter is unreadable, one that wrongly excludes documents with a consistent count is not detectable); a payment's own date field (read from DateString).
<!-- /reconciliation-pack:vendor -->

### Qoblex export items R2, R5 and R14

<!-- reconciliation-pack:qoblex -->
R2, R5, R7, R8 and R14 stand on an export of the incumbent system, Qoblex, which the pack never calls: the owner supplies it as files (owner decision D9). The run names the export directory with `--qoblex-export`; without it each of the five is inconclusive with QOBLEX_EXPORT_OFF as its only reason, no file is touched, and the readiness gate reads that as not available (like VENDOR_READS_OFF). R14 also needs `--vendor-reads-only`, and without it reports VENDOR_READS_OFF first.

**The export directory.** It holds `manifest.json` and the files the manifest names (plain file names in the same directory). The directory and every ancestor must be modifiable only by root or the running account; each file must be a regular file (a symlink is never followed) owned by root or the running account and not writable by group or others. Every file is read ONCE and its sha256 is taken on the bytes that are parsed; the manifest declares each file's sha256 and a file that hashes to anything else (a copy in progress, an edited file) is unreadable. The digests are not published (the report format has no field for them).

The manifest is a closed JSON object in which no member is named twice at any depth (a repeated member is MANIFEST_INCONSISTENT, since JSON.parse would silently keep the last): `formatVersion` (1), `exportedAt` (an ISO time in UTC), `asOf` (the cycle date the export shows), `baseCurrency` (`GBP` only), `locations` (a list of `{code, company, threePl}`: the IMS warehouse code, the company it is grouped under, and whether it is a 3PL's; codes and companies are upper-case tokens), `stock` and `products`, each `{file, sha256, columnMap?: {file, sha256}}`, and `purchaseOrders` (R7 and R8 only): `{file, sha256, columnMap: {file, sha256}, keyPrefix}`, the Incoming (open purchase order) report with its REQUIRED column map and the prefix the first load put in front of a Qoblex order number to make the IMS reference (the first-load manifest's `purchaseOrderKeyPrefix`: an upper-case token of at most 16 characters). The incoming report is its own file (naming the stock or products file again is MANIFEST_INCONSISTENT), is the first-load `purchase-order-lines` dataset parsed by the same ingest, and accepts ONLY the repository's native incoming-stock map (`QOBLEX_NATIVE_PO_COLUMN_MAP`, pinned byte for byte to the first-load tool's tested map like the stock map; anything else, or none, is COLUMN_MAP_NOT_NATIVE or an unreadable manifest). THE REPORT HAS NO CURRENCY OR RATE and the pinned map carries no supplier, currency or rate table and no currency column (it is byte for byte the first-load tool's tested map, which takes an order's currency from its supplier and its rate from fx_rates): the currency of an order is the one IMS recorded on the matched purchase order, and its rate is the central `fx_rates` row (see R7 below). An empty report (header only) is legal and is the only part that may be empty. `stock` is the first-load `stock-lots` dataset and `products` its `products` dataset, parsed by the first-load ingest with the column map (the native Qoblex layouts, `docs/first-load-input-spec.md`); a column map is operator input and can rename, replace, fix or skip any value, so the ONLY map accepted is the repository's own native Qoblex map (`lib/reconciliation-pack/qoblex-native-map.ts`, pinned byte for byte to the first-load tool's tested map, which lists every transform in it): a manifest's column map whose bytes are anything else is COLUMN_MAP_NOT_NATIVE, and with no column map the file must be in the canonical layout, which has no transform. The native map's fixed location labels map to the codes MIL1, CAMBRIDGE, RESTOCK, QUARANTINE-CAMBRIDGE and RXT2; its currency is a constant GBP (a declaration, not read from the file). Any unknown or missing key, a repeated location (rejected whole), or a manifest that contradicts itself about a file (MANIFEST_INCONSISTENT, rejecting the whole manifest: every reference to a file, compared case-insensitively, must spell it alike and declare one sha256, a file is never both data and column map, and a data file shared by both parts needs the same column map), a repeated file, a malformed header or row, a location the manifest does not declare, a SKU that is not valid, a quantity that is not a plain decimal (a negative one is data and is compared as it is), a repeated (SKU, location) not told apart by distinct lot references, an empty file, or a part the manifest does not list makes that part SOURCE_UNREADABLE (or NO_POPULATION_RECORD for a location or declaration problem); every SKU (and, in the canonical layout, warehouse code) cell must be already canonical text, else IDENTITY_NOT_CANONICAL: the file is re-read raw because the ingest trims and normalises, and a padded or non-NFC SKU would otherwise match a system holding the plain one (the other legs compare SKUs exactly as read: the IMS and storefront reads and the warehouse-system list do no trimming, only a refusal of control characters); a padded quantity is accepted, since once trimmed it must be a plain decimal; every data row of every file is accounted for (the native map skips nothing, so only blank lines, which carry no cell, are not counted): no partial list is ever compared. In the Incoming report the one status the map sets aside is `Closed` (mapped to CLOSED): R7 and R8 compare open orders only, so those lines are dropped before the duplicate check; a duplicate among open lines is still DUPLICATE_KEY, and any other status that is not open is still BAD_VALUE.

The export must be for the run: `asOf` equal to `--as-of`, `exportedAt` after that day ended, not in the future, and not older than the weekly cadence allows (PACK_CADENCE_MAX_AGE_MS); otherwise QOBLEX_EXPORT_STALE. UNVERIFIED (U10): nothing in a Qoblex file proves when it was exported, so `exportedAt` and `asOf` are the operator's declaration, checked for consistency with the run and not for truth.

**R2.** IMS stock against the export's quantity per (SKU, warehouse code) for the declared NON-3PL locations, EXACT (0.0001). The IMS side is the inventory snapshot of the cycle date, not the live stock levels. The population is established from IMS, not from the manifest: the eligible set is every ACTIVE IMS warehouse with no WMS binding of any connector, of every warehouse type (the native map reports standard, quarantine and restock locations), and the manifest's non-3PL codes must EQUAL it exactly, else NO_POPULATION_RECORD (an eligible warehouse the manifest leaves out would hide its stock; an unknown, inactive or bound code is not compared). A snapshot row in a warehouse outside the set is out only because it is bound (a 3PL's); an inactive warehouse holding stock or value on the cycle date makes R2 and R5 inconclusive (NO_POPULATION_RECORD). A zero position and no position are the same: zero rows leave both sides. A missing snapshot run row, or a snapshot naming a product or warehouse IMS does not hold, is SNAPSHOT_UNAVAILABLE. Phase P1 lists the result only (owner decision D3: until operators mirror Qoblex-only non-3PL movements into IMS, IMS has no feed for them); the pack compares it exactly regardless.

**R5.** Valuation in GBP per non-3PL warehouse and per company (the manifest's grouping; IMS has no company concept, so both sides use the declaration). IMS = the sum of the snapshot's `valueBase`; Qoblex = the sum of quantity x unit cost over the stock file (each product rounded half-up to six decimals). Pass rule: the two totals differ by at most max(GBP 1, 0.05% of the larger total), inclusive, for every warehouse and every company (owner decision D2: the P1 pass rule for the inventory value). Every (SKU, warehouse) whose own valuation differs by more than 0.5% of the larger is also listed under outOfPopulation (REPORTED_NOT_JUDGED) and never decides the outcome. A currency other than GBP, a foreign exchange rate on a GBP row, a cost missing on a row with stock, or a snapshot row that is not point-in-time reliable is inconclusive. UNVERIFIED (U14): Qoblex's own valuation formula is not known; quantity x unit cost of the stock export is the stated reading.

**R7 and R8** (phase P2 only; at P0 and P1 they are not applicable and NOTHING is read, no file and no database). **The identity is a recorded one:** the first load put the Qoblex order number into IMS as the purchase-order REFERENCE behind a prefix, so the IMS reference IS the manifest's `keyPrefix` followed by the Qoblex number (a plain token: letters, digits, dot, underscore, hyphen). An IMS order is matched to a Qoblex one only when its reference is exactly that; no other formatting is ever tried (no case folding, trimming or digit extraction). An IMS order whose reference the prefix does not explain is an IMS-only identity, keyed by its own id, and a finding. **The population is IMS's, not the file's, and is what the first load CREATED (recorded provenance):** an order is in scope only if IMS recorded the VERIFIED first load creating it: the activity-log row that `createPurchaseOrder` writes for it with the system actor and the run's `runId` (the run record's `run_id`), read in the same snapshot; it is never inferred from the reference's prefix and never from the export. The provenance must be of a VERIFIED run, and COMPLETE AGAINST ORDERS: the number of DISTINCT orders it attributes must equal the number of orders the run record's purchase-orders step emitted (a unit of that step is one order; `emitted` covers every attempt of a resumed run, where `created` alone counts only the last attempt; every unit is present when the run is VERIFIED, and none failed), and every attributed order must still exist (the activity log has a retention sweep, so a pruned row would otherwise make a first-load order look native, and a deleted order would otherwise vanish): otherwise NO_POPULATION_RECORD. Lines are not counted, so editing a line after the load changes nothing (there is no need to loosen the guard at P2). The in-scope IMS set is every such goods purchase order in a committed-incoming status (PO_SENT, SHIPPED, PARTIALLY_RECEIVED: the one definition the product page's Incoming figure uses; a draft or quote is not incoming supply), read whole; the Qoblex set is every order of the report with a quantity still outstanding. An incoming order WITHOUT first-load provenance (one IMS made itself) is listed out of the population and never judged or matched, whatever its reference looks like. The manifest, the prefix and the file cannot take an in-scope order out of the comparison: an order the export omits is onlyIms, an export order with no in-scope IMS match is onlyVendor, one the prefix fails to explain is both. **Freight purchase orders are excluded** (the read is of goods orders). **Order-level discount:** an IMS order carries one (`PurchaseOrder.discountAmount`, applied on top of line discounts), and neither the Incoming report nor the pinned native map expresses an order-level discount (the per-line Discount (%) column is read, see Line discount below), so an in-scope order with a non-zero order-level discount makes R7 inconclusive with VALUE_SHAPE_MISMATCH (the closed code for a value one side carries and the other cannot): it could otherwise pass with the discount on one side only. R8 compares quantities and is unaffected. **Line discount:** the Incoming report's Price is the GROSS price and its per-line Discount (%) is read by the pinned native map but never applied (the first-load tool refuses an open line that carries a non-zero one, PO_LINE_DISCOUNT_NOT_SUPPORTED). A line of the report with a quantity outstanding and a non-zero Discount (%) therefore makes R7 inconclusive with VALUE_SHAPE_MISMATCH, so a gross price is never compared against a gross price; a blank discount is 0, a malformed one (not a plain decimal from 0 to 100) on a line with a quantity outstanding is BAD_VALUE, and a fully received line is not compared so its discount is ignored. R8 is unaffected. **R7** compares each order, set EXACT and value in GBP: the OUTSTANDING value, IMS = the sum over its lines of (qty - qtyReceived) x the stored `unitCostBase` (the rate was fixed when the order was created: IMS's foreign exchange source), Qoblex = the sum over its lines of (ordered - received) x (price / rate), the unit rounded half-up to six decimals. THE EXCHANGE RATE HAS ONE SOURCE, the central `fx_rates` table (fed by the currency refresh; 1 GBP = rate units of the currency, so GBP = foreign / rate): the LATEST row from GBP to the order's currency with `fetchedAt` on or before the instant the IMS order was CREATED, read in the same snapshot. That instant is used because it is when IMS booked its own figures; the rate stored on the order is not used because an order stored before the table-rate rule (every PO rate is now the table rate) may carry a typed rate within 2% of the table's, so a stored rate is not provably a table row. The order's currency is the one IMS recorded on the purchase order (the report has none, so the foreign price is read as being in that currency: a stated limit). The row must also be FRESH: its `fetchedAt` no more than 7 calendar days (24-hour periods, INCLUSIVE: exactly 7 is accepted) before that instant (the central feed is daily, so this tolerates weekends, holidays and a short outage, and a feed that stopped earlier cannot give a stale rate that happens to agree with the stored base cost). The one exemption is an admin-pinned manual override (`manualOverride`), which stays in force until a newer non-override row replaces it: it is accepted at any age while it is still the LATEST row for the currency at the order's creation, and once a newer non-override row exists that row is the one judged. No row on or before that instant, a stale row, a rate that is not a positive plain decimal, or two rows at the latest instant that disagree is CURRENCY_UNKNOWN, never a pass. An order in GBP needs no rate. An order that no IMS order explains has no recorded currency: it is already onlyVendor and carries its unconverted price sum. The catalogue's rule: an order in GBP must agree EXACTLY, so any nonzero difference at the stored precision (one millionth of a pound) is a finding; it is carried as a second identity `<order>|value-exact-gbp` whose two values are 0 and twice the difference in millionths of a pound, so the catalogue's GBP 1 limit is exceeded by any nonzero difference. Any other order is within GBP 1 inclusive. An IMS incoming order with nothing outstanding is a finding (Qoblex lists no such order). **R8** compares each open LINE, identified by (Qoblex order number, SKU) (the report has no line number, so a repeated pair on either side is DUPLICATE_KEY and is never summed): the outstanding quantity (ordered - received) EXACT (0.0001). Every open line is compared, which includes every part-received line; a line with nothing outstanding is no line on either side. Every ORDER on either side also has an order-level identity `<order>|order-lines-outstanding` (the number of its open lines, possibly 0), so an IMS incoming order whose lines are all received and which the export omits is onlyIms and R8 cannot pass. Received above ordered is BAD_VALUE. For both, nothing outstanding on either side passes only on the named proof `qoblex-incoming-report-empty`, which also needs IMS to hold NO incoming goods order at all (an incoming order without first-load provenance is out of the judged population but still means that nothing incoming is not what IMS shows: with one present and nothing judged the result is EMPTY_UNPROVEN); every malformed, missing, duplicate or unstable input is inconclusive with a closed reason, and nothing is converted or guessed. UNVERIFIED: whether a Qoblex purchase order's PO number is what the first load used as its order key for every order (the first-load tool takes the report's Purchase Order column).

**R14.** Every SKU of the union of the systems read must be in every one of them: Qoblex (the export's products), WooCommerce (the full proven double walk of top-level products), Mintsoft and IMS (every product). The comparison is over (SKU, system) pairs against the expectation, so equal counts with a SKU swapped are two findings, and the evidence key is `SKU|system`. A SKU is compared exactly as each system holds it. The export must agree with itself: R14 needs its stock part readable (the only cross-check on the product list; nothing in the export proves the list complete) and every SKU the stock part holds, in any location and at any quantity, must be in the product list, else EXPORT_INCONSISTENT (R2 and R5 do not read the product list, so they are not affected). The Mintsoft leg is the SKU list of the product census R1 reads (the double scan with its page limit clamped, the short last page proven by the empty page after it, no repeated id or SKU, and containment against the stock lists), through the same GET-only reader with the stored fixed key behind `--vendor-reads-only`, and it is read at most once per run: R14 is handed the result R1 got, so it adds no Mintsoft request to R1's (with no bound warehouse in the comparison no stock is read, and the census alone is read once, without the containment check). A Mintsoft bundle is kept in the list like every kit on the other legs: its SKU counts as present and its absence is a finding unless excluded. When the source cannot be read (an auth mode it refuses, an unstable list, a cap), that leg is LEG_UNAVAILABLE with the source's own reason: the other legs are still compared and a finding among them still fails the item, but it never passes. Set aside and listed, never a finding: a product variation (the storefront walk lists top-level products only, so a variation missing from the storefront is NOT detected: stated limit) and a storefront product with an empty SKU.

**Exclusions (owner decision D8).** `--sku-exclusions <file>` (default `ops/reconciliation-sku-exclusions.json`; absent means none; a named file that cannot be read is a refusal) is a JSON object `{schemaVersion: 1, exclusions: [{sku, system, acceptedBy, acceptedAt, reason, expiresAt}]}`, `system` one of qoblex, woocommerce, mintsoft, ims. One entry excludes ONE SKU in ONE system and nothing else; it is in force from `acceptedAt` until `expiresAt`, which must be after it and at most 90 days after it, with a reason of at least 15 characters. The file is read under the acceptance file's trust rule, and a member named twice at any depth (two expiresAt, say) rejects the whole file; an untrusted file, invalid JSON, an unknown field, another version, a repeated (SKU, system) pair or more than 20000 entries rejects the WHOLE file and it accepts nothing; an incomplete entry accepts nothing and the others stand. An excluded pair is listed in the excluded bucket and not judged.
<!-- /reconciliation-pack:qoblex -->

### The readiness gate reads the pack

<!-- reconciliation-pack:gate -->
The readiness gate does not re-run any comparison. It reads the NEWEST pack report (the highest `sequence`, never the latest time, through the same chain reader as the trend: so a gap, a fork, a broken link or any pair that does not verify refuses the whole location) and turns each item's outcome into the gate's result for the slot: pass is pass, fail is fail, inconclusive is unreadable (which always blocks, whatever the phase), and not-applicable is not available. Two readings are made on the catalogue's word rather than the report's: an item the catalogue does not apply in the phase asked about is not available whatever report there is, and an item the report lists as inconclusive for NO_RUNNER alone (the build that made the report has no runner for it yet) is not available, the state the slot had before the pack fed the gate; it blocks only where not-available blocks (P2). The same reading is made for an item the report lists as inconclusive for VENDOR_READS_OFF alone (the run was not started with `--vendor-reads-only`, so no vendor was contacted and nothing was claimed): not available, so merging the vendor items changes no live verdict until a run opts in. NOT_SELECTED is different and stays unreadable: it is an operator's partial run, not the absence of a capability. Every other inconclusive item is unreadable, an item still settling (UNSETTLED_PENDING, with or without SETTLING_STATE_UNUSABLE) included: a difference that has not yet persisted is not a pass, and it is not a block that was already there either, so it blocks as unreadable until it settles or fails.

The report counts only if ALL hold, and otherwise every item it would have covered is unreadable (never a pass, never skipped): the report directory and every ancestor, every run directory and every file are real (never symlinks), owned by root or the account running the gate, and not writable by group or others (the rehearsal reports' rules; the Markdown, the evidence and the JSON are each read once and the digests are taken on those bytes); its cluster system identifier equals the database the gate runs against; it was made for the phase the gate is asked about; and it finished no later than now and no longer ago than the item's cadence allows (daily 36 hours, weekly 192 hours, monthly 840 hours, from the catalogue; the limit itself is inside). For an item that reads the stored trial balance or the ledger as of the cycle date (R6, R10, R11, R12), the cycle date must also be current: a real calendar date whose day had ended when the run finished, and whose end is no longer ago than the same cadence limit, since a fresh report about an old date says nothing about today. The directory is `--pack-report-dir` of the gate (default the pack's own default directory).

R3, R4 and R15 are also derived by the gate itself from its own run of the invariant report. The two readings must AGREE: two passes are a pass, two fails are a fail (the gate's own result), and every other pair - one passes and the other does not, either is unreadable, or the pack has no usable report - is unreadable. A disagreement is never a pass, and neither reading can overrule the other's failure. NOT DEFENDED: an account that can write as the report owner or as root, and deleting the newest reports (the shorter chain still verifies), exactly as for the trend.
<!-- /reconciliation-pack:gate -->

Operator notes for the basis (the pack reads stored snapshots and calls no vendor):

- Switch on the `inventory-snapshot` job (it is off by default) and the `account-balance-snapshot` job (on by default; it pulls the previous day's Xero trial balance). On an installation that already has a managed crontab block, use Settings > System > Scheduler > Save & Apply so the entries exist; the liveness bracket withholds every item that depends on a job that is not in the crontab.
- The balance pull now also stores Unearned Revenue (`xero_unearned_revenue_account`) from the same trial-balance request. If that account is configured but is not in the synced chart, the pull stores only four of five accounts and its last-success stamp does not advance, so the stream goes stale. Sync the chart of accounts first.
- A balance stored by an older build has no provenance label and makes the basis unavailable (`gl_snapshot_unlabelled`) until the date is pulled again. Pull the load date once with the Xero settings action that refreshes account balances for a date.
- To backfill the inventory snapshot for the load date only (replace D with the date, the day before the load): `npm run inventory:snapshots:backfill -- --from D --to D` (run `--dry-run` first). Backfill writes rows and a run row for D; do not backfill a wider range for the pack.
- Unearned Revenue is a credit-balance liability: its stored amount is debit minus credit, so a normal balance is negative.
### The report chain and the run lock

<!-- reconciliation-pack:chain -->
Reports are ordered by `sequence` (1, 2, 3, ...) and linked by `previousReportSha256` (null for sequence 1), never by timestamp. A run takes the run lock (`.run.lock` in the report directory, created exclusively with its pid, host and a random token) before it reads the chain and holds it until the report is committed; the lock is checked again immediately before the JSON is put into place. A lock is reclaimed only when its holder is provably dead: on this host the holder's process entry is gone, or its start time or the boot id differs from the ones the lock recorded (the pid was reused or the machine rebooted). A live holder is never displaced, however old its lock, and a lock from another host is never taken; where death cannot be proven (no process table, a lock without an identity, an unreadable lock) the run is refused and an operator decides. Reclaiming goes through a second exclusive file so two reclaimers cannot both win. At the commit the run also claims the sequence number with an exclusive file (`.seq-<n>`) and the JSON is linked into place without overwriting, so even a displaced holder cannot place a second commit record for a sequence that is taken.

The trend reader verifies every pair (trusted files only, sha256 of the Markdown and the evidence, derived counts, derived outcome and exit code), then the chain: a missing sequence number is a gap and is refused, two reports with the same sequence or the same predecessor are a fork and are refused, and a link whose digest does not match is refused. It reads at most 5000 reports and refuses more. NOT defended: deleting the newest report or reports (the shorter chain is still a valid chain), and an account that can write as the report owner or as root.
<!-- /reconciliation-pack:chain -->
### Exit codes

<!-- reconciliation-pack:exit-codes -->
| Exit code | Name | Meaning |
|---|---|---|
| 0 | all-pass | every applicable item passed, at least one item passed, and the report was published |
| 1 | fail | at least one item failed; the report was published and names each |
| 2 | refused | the pack refused to run or to publish (bad arguments, an account that may not run it, an unsafe report directory, a held run lock, a broken report chain); nothing was published. Items only read, so a refusal after they ran leaves nothing behind |
| 3 | report-not-published | a verdict per item was reached but the report could not be durably published; the outcomes are not evidence and must not be relied on |
| 4 | internal | the pack itself failed unexpectedly before it could reach an outcome; treat as inconclusive |
| 5 | inconclusive | no item failed, but at least one item could not be proven (or nothing at all was proven); the report was published. Never a pass |
<!-- /reconciliation-pack:exit-codes -->
### Failure classes audited up front

<!-- reconciliation-pack:audit -->
The failure classes earlier reviews kept finding, and the guard for each. Every guard has a test that fails when the guard is removed.

| Failure class (found in earlier reviews) | Guard |
|---|---|
| TOCTOU between check and use | every report file is opened once with O_NOFOLLOW and its digest taken on the same bytes; the run lock is verified (inode and token) immediately before the JSON commit; lock reclaim is serialised by a second exclusive file |
| starvation of bounded oldest-first scans | a read that hits its cap is CAP_EXCEEDED and never passes; there is no oldest-first window, and carried unsettled identities are re-checked first |
| false findings for pre-cutoff items | identities outside the RECORDED population go to outOfPopulation with a closed reason, listed and never counted as findings; an identity whose boundary has no record, or no creation instant, is unknown and makes the item inconclusive (never in, never out); the first-load record counts only when VERIFIED |
| a write, or a mixed-instant read, on the IMS side | every IMS section is read in one REPEATABLE READ, READ ONLY transaction whose mode is read back and whose snapshot must be equal at the start and the end; only SELECTs and three fixed SET LOCALs can be sent, one statement per text, and it is always rolled back. A no-write proof diffs every table's rows and statistics across a real run |
| a bounded or oldest-first IMS read standing in for the population | every section is read in full; over the row cap is CAP_EXCEEDED and a statement timeout is READ_INCOMPLETE; a row that cannot be read exactly makes its whole section unreadable instead of being dropped; stored snapshot rows must match the run row's count |
| a name, flag or location taken as proof (who runs it, what it reads) | the account is checked by uid against root and the checkout's owner, not by name; the environment is replaced by a whitelist before the database client loads; a credential-shaped argument is refused; the report directory and the acceptance file are trusted only after the ancestor and owner checks; a warning is accepted only by an exact id in a file that passed them |
| an outcome staying OK after a recorded failure | a runner that throws, returns something the report refuses, or reads a stream that was stale or moved is INTERNAL_ERROR, STALE_BASIS or BASIS_MOVED, never a pass; an invariant finding that the pack's own comparison would call equal is inconclusive, never a pass; the exit code is derived from the published items by one function and a publication failure is exit 3, not the item verdict |
| secrets or data in text | text carries closed codes, counts and sanitised identity tokens only; every other field has an anchored allowlist grammar (the system identifier is digits only); a token is a cuid, a numeric id, or a SKU or warehouse code that passes the character pattern and a credential screen (else a kind#digest), and a raw string cannot be typed as one. Tokens are trusted data keys and the screen is defence in depth, with its residual listed in the docs |
| an aggregate or count standing in for identity | comparison is keyed; equal counts with one identity swapped fail (onlyIms plus onlyVendor); counts are derived from the lists and the reader recomputes them |
| "looks empty so skipped" | empty on both sides is EMPTY_UNPROVEN unless positive evidence is supplied; a run in which nothing passed exits 5, never 0 |
| a vendor lag reported as a failure, or a failure that never matures | R1 and R9 settle: a difference fails only after two LATER distinct last-success stamps of its stream, counted from the pack's own trusted reports (same installation and phase, compared to the end, not capped, stable bracket); a repeated stamp makes no progress, a stamp is never ordered, a changed value or kind restarts the count, and carried state that cannot be used leaves every difference first seen with SETTLING_STATE_UNUSABLE (inconclusive, never a pass, never settled) |
| ordering inferred from timestamps | the chain is ordered by sequence and linked by digest; settling uses equality of distinct last-success stamps and never compares two stamps for order |
| a pass resting on nothing (empty, unbracketed or unattributed) | in the builder AND the reader a pass must carry a proof (at least one identity compared, or a named empty-population proof), exactly its catalogue sources, an equal start and end stamp for every dependent stream, no reason, finding or unsettled identity; every other outcome has its own invariants; the exit code is derived from the items by one function |
| a value-mode pass resting on entries with no values | an entry is judged against its item and bucket in the builder and again for every evidence line: a value-mode pair needs both values, the true delta and the tolerance verdict of the catalogue measure, a presence item carries none; every equal identity is an evidence line and the reader recomputes the counts and the digest from them |
| a bucket label believed instead of derived (a one-sided identity published as equal) | every entry records which sides had the identity; the bucket of a pair entry is derived from those fields in the builder and the reader, in both modes, and a label that disagrees is refused |
| identities that were never compared counted as compared (excluded, out of population, unsettled) | the comparator issues the "compared" proof only for equal in-population, non-excluded identities, and a named empty proof only when nothing was judged; a table test over every bucket combination in both modes runs comparator, report and reader and asserts nothing else can pass |
| caller-owned data serialised or written before it is validated | input is copied field by field into plain objects through a whitelist (no unknown field, accessor, symbol key, Proxy, class instance, hole or oversized list), the report is built from the copies only, and the finished text passes the reader's validation before any file is created |
| fail-open on unreadable state | an unreadable, untrusted, oversized, malformed or inconsistent file, directory or chain refuses (trend) or is inconclusive (item); there is no default that passes |
| liveness unreadable, or a stale or off stream, treated as fine | the status report is read at the start and again at the end of the run; a read that fails or is malformed makes EVERY item inconclusive; an item with a dependent stream that is not fresh at both reads, missing, ambiguous, whose stamp differs between the reads, or whose job is unscheduled or disabled, or a scheduler that was not examined, could not be read or has an untrusted block, cannot pass (STALE_BASIS or BASIS_MOVED); the published bracket of such a stream has no end stamp; no item without liveness is assumed healthy |
| the latest snapshot on or before now standing in for the cycle date | the basis reads each ledger balance for EXACTLY the cycle date and never the latest earlier or later one: a missing exact date is not_for_date, never a substitute |
| another organisation's ledger balance read after a rebind (the snapshot table was shared across organisations) | each stored trial-balance balance records the organisation it was fetched under; the basis reads the connected organisation in the same transaction and uses only balances whose recorded organisation equals it; a balance with another or no recorded organisation is gl_snapshot_other_tenant and the basis is unavailable |
| an account missing from the trial balance read as an explicit zero | a zero synthesised for a configured account that a non-empty trial balance omitted is stored with the absent-from-complete-tb reference only when the report proved itself complete (the pull refuses it otherwise), and is read back as a real zero only for that reference, at parser version 2, with an amount of exactly zero; the older absent-from-tb reference (no proof) is read back as absent-from-tb, a non-zero amount under either is basis_unreadable, and when the Inventory or Allocated Inventory balance is one, the inventory comparison is withheld (no result at all, never `balanced` on an inferred zero); a stored balance with no recognised reference is gl_snapshot_unlabelled and the basis is unavailable |
| a subledger read in several snapshots, or a snapshot whose row count is not what its run recorded | every IMS read of the basis is made in one READ ONLY REPEATABLE READ transaction with a statement timeout, verified before the first read; the snapshot rows must be reliable and be exactly the number the run row recorded |
| an untrusted-file field reaching text | every field read back from a file is validated against a closed set or a strict pattern before use, and the Markdown is rendered from validated values only |
| the liveness reader or the as-of basis taking the application's database client, so the invariant run loses its one snapshot (or reads on a spent transaction) | the status report is read by a child process and the basis through a client of its own, one per transaction and always disconnected; the date helpers and the transit coverage rule live in modules that import no database client; a test loads the command and every pack module in a fresh process and fails if the application's client exists afterwards |
| a ledger item passing on a basis that was not settled, or on an account Xero did not report | R6, R10 and R11 run only after the end liveness read, on the basis settleAsOfBasis returned (a read that moved, or a stream that was not fresh and unmoved, is the item's inconclusive result); a balance that is the zero the pull synthesised withholds its leg (GL_LEG_ABSENT) even where it would balance, the evaluator and the pack's comparison must agree on every leg, and every basis field is validated before use |
| an IMS-originated write to Xero missed because of its status, type, source or instant | the postings leg takes every sync-log row of the Xero connector that is SYNCED, PROCESSING or carries a document id, of ANY type and whatever the settlement basis; the instant is the latest of the sync time, the processing start and the creation time (so a host clock behind the database never moves a row created after the boundary out of it); the population boundary is the recorded VERIFIED first-load start (at that instant is inside); a missing boundary or unreadable instant is inconclusive, never in or out |
| a vendor read that writes (a token refreshed or a counter stored on the way to a GET) | R12 and R16 do not use the connector's Xero client: their transport reads the stored access token in a read-only transaction and never refreshes it (an expiring token is XERO_CONNECTION_UNUSABLE), has no method parameter, and its hop gate refuses everything but a GET to the organisation, the invoice, credit-note or payment list with the fixed parameters; the no-write test runs the whole command against loopback doubles and finds only SELECTs and GETs |
| an unverified mapping assumed (how Xero codes OSS, EC sales and reverse charge; a shared or missing tax type) | R12 places a figure only by a rate whose category is on the verified list, whose Xero tax type is its own, in the proven stored Xero list with the verified report tax type; any non-zero VAT elsewhere, in any system, is VAT_MAPPING_UNVERIFIED for the whole item before a pass is possible |
| a Xero list that is partial because its page size was assumed, or its count was taken on trust | R12 and R16 send no page size, require Xero's own pagination object, checks every page against the size it reports, the count and the unique invoices read against the item count, enforces the request budget (CAP_EXCEEDED, never a shorter list) and reads the whole walk twice |
| lines omitted from a vendor invoice or order so that their tax is missing from a figure | R12 reconciles each Xero invoice (TotalTax, SubTotal, Total and the line amounts per LineAmountTypes, exactly) and each store order (total_tax against its tax lines and shipping tax), so omitted lines must offset in tax and in amounts to stay hidden; the residual (omitted lines netting to zero in both) is a stated trust boundary: the API gives no independent line count |
| a period that is not complete, or a fresh report about an old cycle date | R12 reads only months that ended at least the stated lag before the cycle date, drops months before the recorded first load and storefront import, and its cycle-dated source makes the gate require a current cycle date |
| a foreign-currency Xero document judged on a guessed, defaulted or rounded-away rate (a missing CurrencyRate read as 1, a missing IMS rate read as equal, a rate compared at a looser precision, a partial Xero list read as the whole) | R16 never defaults: a foreign document with no CurrencyRate is DOCUMENT_UNREADABLE, a date with no usable IMS rate is IMS_RATE_MISSING (the lookup's own refusal reason in the identity), both rates are rounded to the same six places and must be equal (absolute tolerance 0, re-judged by the report reader), and every Xero list is read as a proven double scan; an unproven list is the item's inconclusive result, and nothing compared passes only on the named proof that no foreign-currency document exists |
| a vendor called without the operator asking, or called with anything but a read | without --vendor-reads-only the vendor items are inconclusive VENDOR_READS_OFF before any port or credential is touched and the whole run makes no request; each vendor transport has no method parameter and gives the connector fetch seam a gate that refuses any request that is not a GET to one of three collections on the store's own origin (WooCommerce), or to exactly the Mintsoft stock list of one warehouse or one page of its product list on its own origin, or to the Xero organisation, invoice, credit-note or payment list on api.xero.com with the fixed parameters (R12, R16), with the listed parameters, and refuses redirects; the gate reads the flag-off report as not available only when VENDOR_READS_OFF is the single reason |
| an admitted order status left out of a comparison because one route or setting was read and another was not | the walked statuses are the union of every route that admits by status, from the connector's own shared rule (the selection, the withdrawal pair from their settings, completed, delivered; an empty selection admits nothing on the sweeps), each read by the importer's own mapping lookup; a setting that cannot be read or interpreted is inconclusive, never defaulted |
| an order excluded from a comparison by an instant that does not prove the importer would not admit it | R9 sets aside no order by age: the importer admits by current status whatever the creation date (the rules are cited by file and line in the vendor items section), retention archives only terminal orders, and comparing a storefront timestamp with an IMS one is cross-system clock ordering the pack never does; every store order in an admitted open status is judged, so one IMS lacks fails the item |
| a partial vendor list standing in for the whole (a page lost, a total ignored, a store that repeats a page or changes under the walk, an order that moves between statuses between two status walks) | orders are read as two full sweeps of every status and their combined populations must be identical (an order in one sweep only is unstable; limit: an order that moves between open statuses twice within one run could be missed by both); a walk is used only if every response is a 200 JSON array with both pagination headers as plain whole numbers, every page agrees on the total and page count, the lengths are exactly the page size and the remainder, ids ascend strictly and never repeat, the rows read equal the total, and a second full read equals the first; any other state is a closed reason and no list at all |
| a login (a key rotation) at a shared fulfilment tenant made by a read | the Mintsoft reader has no code path that can reach /api/Auth: before any request it reads the stored configuration in a read-only transaction and refuses (VENDOR_AUTH_REFUSED, no request) unless the auth mode is exactly the fixed-key mode with a key present; it never refreshes on a 401, and its hop gate refuses every method but GET and every path but the two reads the connector's allow-list lists |
| a stock list or product list believed complete because it was one response or ended on a short page | the stock lists are read in two full sweeps and their combined populations must be identical; the product census is read in two proven scans (pages exactly the clamped limit, a short last page proven to be the end by the empty page after it, no repeated id or SKU, equal as sets) and every product the stock lists show must be in it; a missing, extra or changed row is unstable or incomplete and there is no list at all |
| a derived or foreign stock figure compared as a stored one (bundles, kits, another client's rows, another warehouse's rows) | KIT products and bundle rows are set aside on both sides and a kind mismatch is IDENTITY_CONFLICT; every row must name the warehouse asked about and the configured client; the on-hand figure is read by exact name and the available figure is never compared |
| the gate believing a pack report it should not (untrusted, another installation, another phase, stale, or contradicted by its own reading of the invariant report) | the gate reads the newest report by sequence through the chain reader (trust, digests on the same bytes, derived values), requires this installation's system identifier, the phase asked about and an age inside the item's cadence, maps inconclusive to unreadable, and requires R3, R4 and R15 to agree with its own derivation; every other state is unreadable |
| a repeated JSON member read as its last value (two expiresAt on one acceptance or exclusion, two threePl on one location) | every operator-written JSON file a decision rests on (the warning-acceptance file, as read by the pack and by the readiness gate, the SKU exclusion file and the Qoblex manifest) is parsed by lib/ops/strict-json.ts, which refuses a member named twice in any object at any depth, compared by decoded name under Unicode NFC; the file then accepts nothing (acceptances, exclusions) or is MANIFEST_INCONSISTENT. The pack's own hash-chained reports, its lock file and database settings are not operator files and keep JSON.parse |
| a Qoblex export file taken on trust (an untrusted, swapped, truncated, partly copied or edited file; a symlink; a manifest that guesses) | the export directory and every ancestor must be modifiable only by root or the running account, each file is opened without following a symlink, is a regular file owned by root or the running account and not writable by group or others, is read ONCE with its sha256 taken on the same bytes and must equal the digest the manifest declares; the manifest is closed (an unknown, missing or repeated key, name or location, or a version other than 1, is SOURCE_UNREADABLE) |
| a partial or guessed Qoblex list (a malformed row, header or location; a repeated SKU; an unknown location read as a known one) | the export is parsed by the first-load ingest through ONLY the repository's native column map (any other map, which could rename, replace, fix or skip a value, is COLUMN_MAP_NOT_NATIVE) and a rejected row and a SKU or warehouse code cell the ingest would trim or normalise (IDENTITY_NOT_CANONICAL), a malformed header, an empty file, a location the manifest does not declare, a SKU that is not valid, a quantity that is not a plain decimal or a repeated (SKU, location) not told apart by distinct lot references makes that part unreadable with no row at all; R14 also needs the stock part readable and every stocked SKU in the product list, else EXPORT_INCONSISTENT |
| a stale, other-day or undated Qoblex export passing as current | the manifest declares asOf and exportedAt; the export must be for the run's own cycle date, exported after that day ended, not in the future and within the weekly cadence, else QOBLEX_EXPORT_STALE (the declaration is the operator's, U10, and is only checked for consistency) |
| the Qoblex items read without being asked, or an absent input read as a failure | without --qoblex-export R2, R5, R7, R8 and R14 are inconclusive QOBLEX_EXPORT_OFF before any file is touched, the report builder accepts that reason only as the single reason of an item that reads nothing, and the readiness gate reads it as not available, like VENDOR_READS_OFF |
| a location taken for another (a swapped warehouse, an unmapped location, a declared non-3PL warehouse that is a 3PL's) | R2 and R5 establish the population from IMS (every active warehouse with no WMS binding) and require the manifest's non-3PL codes to equal it exactly, else NO_POPULATION_RECORD; stock in an inactive warehouse is never skipped; the identity is (SKU, warehouse code), so a swap of two warehouses' quantities is two differences |
| a valuation passing on a wrong basis (another day, an unreliable snapshot row, another currency, a missing cost) | R5 uses the inventory snapshot of the cycle date only; no run row or a row that is not point-in-time reliable is SNAPSHOT_UNAVAILABLE; a currency other than GBP, a foreign exchange rate on a GBP row or a cost missing on stock is inconclusive; the tolerance is the catalogue's max(GBP 1, 0.05% of the larger total), inclusive, and a total decides, never the per-SKU list |
| a SKU missing from one system hidden by a total, a union or an exclusion that is too wide, expired or untrusted | R14 compares (SKU, system) pairs against the expectation that every SKU of the union is in every system read; an exclusion covers one SKU in one system only, must be accepted and not expired (at most 90 days), and comes from a trusted, closed-format file, otherwise the WHOLE file accepts nothing; a leg that was not read is LEG_UNAVAILABLE and the item never passes |
| an IMS purchase order narrowed out of the open-order comparison (by the file, the manifest, the declared prefix, a status or a missing line) | R7 and R8 take the IMS set from IMS: every goods purchase order the VERIFIED first load created (recorded provenance, complete against the run record, never the prefix or the export) in a committed-incoming status (the one shared definition), read whole; an order without provenance is listed out of the population; the file can only add identities (onlyVendor), an order it omits is onlyIms, and a reference the declared prefix does not explain is an IMS-only identity keyed by its own id, never dropped; a missing line, a repeated (order, SKU) on either side and received above ordered are findings or closed reasons, never summed or skipped |
| a purchase order matched to the wrong Qoblex order, or by guessed formatting (case, padding, digits) | the identity is the recorded one: the IMS reference is exactly the manifest's declared prefix followed by the Qoblex order number, and the order number is a plain token already in its canonical text (IDENTITY_NOT_CANONICAL otherwise); no other relation is tried, and equal figures under a swapped order or SKU are two findings |
| an open-order value passing on a wider tolerance than the catalogue states, or across a currency disagreement | R7 judges an order in GBP on both sides exactly (a second identity per such order that only an exact match to the stored precision can satisfy), any other order within GBP 1 inclusive, and an order whose currency differs between the two sides is CURRENCY_UNKNOWN; the export side converts only with the central fx_rates row at the IMS order's creation (none, non-positive or a disagreeing tie is CURRENCY_UNKNOWN), the pack carries no rate or currency table, and the native map's bytes are checked by digest |
| a transit schedule that is short because the sub-ledger does not cover an order, a refund or a posting, or an account that is not the transit account's own | R11 requires the recorded coverage watermark (a real date on or before the cycle date) and that every durable source document (orders, bills, receipts, supplier returns, credit notes, landed-cost records, customer refunds, return expectations; never a prunable log) and every sub-ledger row postdates it (a closed or cancelled pre-watermark order with offsetting history cannot pass), else NO_POPULATION_RECORD; a source type it does not know or an order IMS does not hold makes the schedule unreadable; transit on the Allocated Inventory code leaves no basis, transit on any other control account's code is SOURCE_UNREADABLE, and a synthesised zero is GL_LEG_ABSENT; the compared schedule is the whole sub-ledger to the cycle date (open orders, non-open orders still holding transit, the refund leg), and a non-open order with a residue is also listed by identity, not judged |
| a stale exchange rate (a feed that stopped months ago) agreeing with a stored base cost | R7 accepts a central fx_rates row only if it is at most R7_FX_MAX_RATE_AGE_DAYS (7, inclusive) older than the IMS order's creation, except an admin-pinned manual override that is still the latest row for the currency; otherwise CURRENCY_UNKNOWN |
| an order-level discount present on one side only (IMS carries one, the Qoblex report cannot) | an in-scope order with a non-zero order discount makes R7 inconclusive (VALUE_SHAPE_MISMATCH); a native order's discount is out of scope; R8 compares quantities and is unaffected |
| an order dropped from the comparison because its first-load provenance is gone (a pruned activity-log row) | the provenance must be of the VERIFIED run and the number of distinct orders it attributes must equal the orders the run record emitted (no unit failed, every attributed order still exists), else NO_POPULATION_RECORD; orders without provenance are listed, never silently dropped |
| an item read at a phase it does not apply in, or a purchase-order item reading before the phase and the export are known | R7, R8 and R11 consult the catalogue first: at P0 and P1 they are not applicable and neither the export, the database nor the basis is read; R7 and R8 without --qoblex-export are QOBLEX_EXPORT_OFF before any IMS statement |
<!-- /reconciliation-pack:audit -->

### Scheduling the pack

The pack can be run on a schedule. **It is off by default**: a fresh install has no crontab line for it, and nothing about it changes until an operator turns it on. It is the scheduled job `reconciliation-pack` (Settings, System, Scheduler, group System, "Reconciliation Pack"), built on the same cron framework as every other job: the switch is `cron_reconciliation_pack_enabled` (default `false`), the schedule is `cron_reconciliation_pack_schedule` (default daily at 03:00, any schedule the Scheduler offers), and Save & Apply writes or removes its line in the managed crontab block like any other job. The line calls `/api/cron/reconciliation-pack` with the cron secret; the route also re-reads the switch, so a stale crontab entry cannot run a job that has been switched off (the start is refused and recorded, see below).

The job starts `npm run reconcile:pack -- --phase <phase>` as a child process of the application, in the checkout the application runs from, with the short environment the other gate commands get (`PATH`, `HOME`, `LANG`, `LC_ALL`, `TZ`, `TMPDIR`, `npm_config_cache`, `DATABASE_URL`, `PRISMA_DEV_DB_CONFIRM`). So the command's own hardening applies unchanged, and the job bypasses none of it: the environment whitelist, the account check (the application runs as the checkout's owner, or the command refuses with `ACCOUNT_NOT_ALLOWED`), the credential-argument screen, the report-directory trust check and the run lock. It passes no path, date, item list or acceptance file: the command's defaults apply, so reports go to the default report directory and the run covers the whole pack (each item's cadence is applied by the readiness gate, as for a manual run). A run that has not finished in 45 minutes is killed with its process group and recorded as `CHILD_TIMED_OUT`.

Two options of the job's own are read when it fires (saved on the same screen, under "Reconciliation Pack: scheduled run options"; they need no crontab write):

| Option | Setting | Default | Meaning |
|---|---|---|---|
| Phase | `reconciliation_pack_schedule_phase` | not set | P0, P1 or P2. **There is no default phase**: with none set, or a value that is not one of the three, the job refuses to run and records `PHASE_NOT_SET` or `PHASE_INVALID`. |
| Read WooCommerce in scheduled runs | `reconciliation_pack_schedule_vendor_reads` | off | Adds `--vendor-reads-only` (GET requests to WooCommerce and Mintsoft, and to Xero for R12 and R16, within the pack's own request budgets and pace; the pack never refreshes the Xero token) and passes the child the key names it needs to read the stored storefront credentials and the stored Xero connection (`SETTINGS_ENCRYPTION_KEY`, `ENCRYPTION_KEY`) and the variables the Xero tenant guard judges that connection by (`XERO_ALLOWED_TENANT_IDS`, `XERO_ALLOWED_TENANT_NAMES`, `XERO_BLOCKED_TENANT_IDS`, `XERO_TENANT_ID`, `XERO_REQUIRE_DEMO_ORG`, `NODE_ENV`). **Off even when the schedule is on.** Only the exact stored word `true` turns it on. At most one scheduled run that reads a vendor is started in any 20 hours; a start inside that window is refused and recorded as `VENDOR_READS_TOO_SOON`. |

Neither option can be written by the generic settings writers; only the validated action behind the screen writes them. The framework also limits every cron route to one start per hour, whatever the schedule says.

**Settings are re-read at the last moment, and the fence is held until the child exists.** The job reads its switch, phase and vendor option once to decide cheaply, then again, from the database, in a transaction holding a second advisory lock (the settings fence), taken after the run lock and the vendor spacing check. The child is started inside that transaction with exactly the re-read values, and the transaction ends (releasing the fence) as soon as the child has spawned, within 10 seconds; if the spawn fails or times out the child is killed, the fence is released and the start is recorded as `CHILD_NOT_STARTED`. Every writer of the job's rows takes the same fence first in its own save transaction: the Scheduler save when the job is among the changes, the options save, and the factory reset. A disable that committed before the final read is therefore never followed by a start (it is recorded as `SCHEDULE_DISABLED`), a save that arrives between the read and the spawn waits for the spawn and is ordered after the start, and a save never waits for a running child (the child's life is outside the transaction). If vendor reads were turned off meanwhile, the pack runs without `--vendor-reads-only` and without the key names (recorded as `vendorReads` false); if they were turned on meanwhile, that start does not use them. A disable saved after the spawn cannot stop the child that already started; it applies to the next start. A database restore replaces the rows without the fence.

**Overlap.** A second scheduled start while one is running does not run: the job holds a session advisory lock on its own connection from before the child starts until its record is written, and a start that cannot take it is recorded as `ALREADY_RUNNING`. If the application process dies while a child runs, the lock goes with its connection and the orphaned child may finish; a later scheduled run and that child are then held apart at publication by the pack's own run lock, which refuses the later one with `LOCK_HELD` (recorded). An operator's own `npm run reconcile:pack` is held apart from a scheduled run by that same file lock, not by the advisory lock.

**The record.** Every scheduled start leaves exactly one activity-log entry, action `reconciliation_pack_scheduled_run`, entity type SYSTEM: a published report, a refusal (the job's or the command's) or a failure. The level is INFO for an all-pass report and for a refusal that is not a fault (`SCHEDULE_DISABLED`, `ALREADY_RUNNING`, `LOCK_HELD`, `LOCK_STALE_CONTENDED`, `VENDOR_READS_TOO_SOON`), WARNING for a published report whose exit code is 1 (an item failed) or 5 (inconclusive), and ERROR for everything else. The metadata carries these keys and no others, each with a closed value: `schemaVersion` (1), `scheduleRunId` (the scheduled-job run id, which is also in the cron run log), `outcome` (`published`, `refused` or `failed`), `code` (the pack's exit name `all-pass`, `fail` or `inconclusive` for a published report, otherwise a code from the tables below or from "Codes printed when the command stops without a report" and the chain codes), `codeMeaning` (the fixed sentence for that code), `exitCode` and `exitMeaning` (the command's exit code and the sentence of the exit-code table, or null when the command never produced one), `phase`, `vendorReads`, `runId` and `sequence` (of the published report, or null), `reportJson` and `reportMarkdown` (the report paths under the default report directory, or null) and `durationMs`. It never carries file contents, URLs, credentials, vendor data or anything the command printed beyond a code from its own tables and the two report paths: a code the pack does not define, or a path outside the default report directory, is dropped. Exit 0, 1 and 5 are read as "a report was published" only when the command also named that report AND the pack's own reader verifies it (the JSON parses under the report grammar and names the printed run id, the Markdown and the evidence have the digests the JSON records, the sequence is a positive integer, and the exit code the JSON derived is the command's own; a failure is `REPORT_UNVERIFIED`, outcome failed, level ERROR); otherwise (a crash of the runner before the pack starts also exits 1) the run is recorded as `EXIT_WITHOUT_REPORT`, never as the pack's `fail`.

| Code | Meaning |
|---|---|
| SCHEDULE_DISABLED | the scheduled job is switched off (the route was called anyway, for example by a crontab line that is out of date); nothing was run |
| PHASE_NOT_SET | no phase is set for the scheduled pack, and there is no default phase because an item applies in some phases and not others; nothing was run |
| PHASE_INVALID | the stored phase is not P0, P1 or P2; nothing was run |
| SETTINGS_UNREADABLE | the job's settings could not be read; nothing was run |
| ALREADY_RUNNING | another scheduled run of the pack is in progress; this start did not run |
| LOCK_UNAVAILABLE | the exclusion that keeps scheduled runs apart could not be taken; nothing was run |
| VENDOR_READS_TOO_SOON | a scheduled run that reads WooCommerce was already started inside the spacing window; this start did not run |
| CHILD_NOT_STARTED | the command could not be started, or was ended by a signal |
| CHILD_TIMED_OUT | the command did not finish in time and was killed |
| EXIT_WITHOUT_REPORT | the command exited with a code that means a report was published, but it named no report in the report directory (it may have failed before the pack ran) |
| EXIT_CODE_UNKNOWN | the command exited with a code the pack does not define |
| REPORT_UNVERIFIED | the command exited with a code that means a report was published and named one, but the pack's own reader does not verify it (it is missing or unreadable, is not valid, its digests do not match, it names another run, its sequence is not a positive integer, or its exit code is not the command's) |
| NO_CODE_PRINTED | the command refused or stopped, but printed no code the pack defines |

**A record that cannot be written does not hide the run.** The result of the run is still returned: the route answers red (HTTP 500) with the closed code and exit code, the scheduled-job run log (`cron_run`, a separate writer) holds the same code with the reason `RECORD_NOT_WRITTEN:<code>`, and one line of closed words and integers goes to the application log (`[reconciliation-pack-schedule] record not written: outcome=... code=... exit=...`). For a published report the report itself, on disk and in the chain, is the durable outcome; the record is its index. If the database is down so that neither writer can write, only the application log line and the report remain.

**Limits, stated.** The route runs the child inside the web request, so a run holds a request open for as long as the pack takes (at most 45 minutes). Scheduled runs are not a substitute for reading the report: the job records that a report was published and its exit code, and the readiness gate remains the only reader that turns reports into a verdict. While the job is switched on, the first-load runner's pre-load check treats its crontab line as a writer (it is not one of the read-only jobs the runner allows), so a load will refuse until the job is switched off.

## First load (phase P0)

Loading the owner's exports into an empty, installed instance is a separate command from the installer: `npm run first-load:prepare` turns the exports into importer files and a validation report (see [first-load-input-spec.md](first-load-input-spec.md)), and `npm run first-load:apply` loads them through the application's own importers, verifies the result and publishes a report. The sequence on the host:

1. `first-load:prepare`, then write the **apply manifest** (the operator's assertions: steps, warehouse profiles, accepted zero-cost stock, exchange rates).
2. `npm run first-load:apply -- --rehearse ...`: the whole load on a copy of the target in a throwaway cluster. The target is only read. Fix whatever it reports and repeat until the rehearsal record says `OK`.
3. **Stop the application** (web, workers, cron jobs that connect to the database; the checklist is in [first-load-apply.md](first-load-apply.md)). Remove every outbound write grant from the installation env file, switch the storefront, warehouse and accounting connectors off, and take the managed cron block out of the crontab: `--apply` refuses (exit 3, before the restore point) while any of them is armed, and `install.sh`, `update.sh` and `deploy.sh` put the cron lines back, so run none of them until the load is done.
4. `npm run first-load:apply -- --apply --rehearsal-record <record> ...`: takes a restore point, loads, verifies, and ends `VERIFIED` (exit 0). Any other exit is not a success; the report and the printed restore procedure say what to do.

The target is named by an env file (mode 600), never by an argument, and is confirmed by database name and cluster system identifier. The load is for the P0 phase only: it never writes to WooCommerce, Mintsoft or Xero, and the verification proves no outbound queue grew. The readiness gate reads the published apply report: its `first-load-apply` check is **required at P0** (the database's run record must be `VERIFIED` and an intact report for that run, made on this cluster, must be in `--apply-report-dir`; see "The readiness gate" in [first-load-apply.md](first-load-apply.md)). Run `npm run readiness:gate -- --phase P0 --apply-report-dir <the --report-dir you gave the apply>` after the load.

## WooCommerce initial-import rehearsal

`npm run rehearse:woo-import` runs the **real WooCommerce initial order import** (the code behind **Import Active Orders**: `lib/connectors/woocommerce/sync/initial-import.ts`, `importWcOrder` and the allocation service) end to end against a **local fake WooCommerce REST server** serving synthetic orders, into a PostgreSQL cluster created for the occasion and thrown away afterwards, and writes a report. It is the rehearsal behind the first load's order import (o3d-zjsb5.16): it shows, before anything touches the live store, what the import does with open orders, which of them it cannot allocate, and whether the numbers agree.

```bash
# As the account that owns the checkout (NOT root), with PostgreSQL server binaries installed
# and `npx prisma generate` already run:
npm run rehearse:woo-import
# Optional: --root <dir> (parent of the throwaway cluster, default /var/tmp),
#           --report-dir <dir> (default /var/tmp/ims-rehearsal-reports) and
#           --check-deployment-statuses <env file> (read-only check of a deployment's actual status selection).
```

A measured run takes well under a minute. It uses the same cluster helper, environment whitelist, secret handling and teardown as the [fresh-install rehearsal](#fresh-install-rehearsal) (see there for what it builds and refuses to touch), and the same report publication discipline; on a memory-constrained shared host take the same lock the test tiers take.

### What it never does

- **It never contacts a real host.** The fake binds `127.0.0.1` on an ephemeral port. The connector reaches it through the ordinary settings in the throwaway database (`wc_url` and the two credential rows), and the connector's read path accepts a loopback `http` URL only when `E2E_TEST_MODE=1` and `NODE_ENV` is not `production`; the rehearsal sets the first and leaves the second unset in the processes it starts. The write calls (`wcPost`, `wcPut`) do not carry that allowance, so a write to the fake would be refused by the transport as well as by the hold.
- **It never writes.** The import is read-only. No outbound-write grant (`WC_WRITEBACK_ALLOWED_ORIGIN`, `MINTSOFT_WRITE_ALLOWED`, `XERO_WRITE_ALLOWED_TENANT`) exists in any environment it builds. The report proves that `npm run outbound:status` reports every connector held before and after, that **no request other than GET reached the fake**, that no request was for a route the fake does not model, and that the outbound-write hold refused nothing (a refusal would mean the import tried to write). No webhook is registered: that would be a POST, and the fake records any.
- **It never sets the one-shot stamp on a rehearsal pass.** A rehearsal pass never writes the one-shot completion stamp (wc_initial_import_completed) or the order-sync cursor (last_wc_order_sync_at). Only a real pass does, and a real pass cannot be undone. The seam is `runInitialImport(progress, { stampCompletion })`: the button's own path leaves it at its default (stamp), the rehearsal passes `false`. The report shows the two stamp keys absent after the rehearsal passes and present only after the one real pass that closes the run, and shows the button declining to run again after it.

### What it builds

A store of synthetic orders in every status the first load cares about (see `tests/fixtures/woo-import/orders.ts`): processing, pending and on-hold orders to import; completed, cancelled, refunded and failed orders the owner decision abandons; registered and guest customers; coupons spread across lines; fees; two tax rates plus one WooCommerce rate id IMS has no mapping for; a tax-inclusive store; shipping with tax; a partial refund; a euro order and a US-dollar order (both with a GBP rate seeded; a dedicated test leaves the USD rate out); lines for SKUs IMS holds with and without stock, a SKU IMS does not hold, and a line with no SKU; and enough ordinary orders that the walk must read three pages. Every order's total is exactly the sum of its parts.

### The report

Two files per run, `woo-import-report.json` and `woo-import-report.md`, under `<report-dir>/<run id>/`, published with the same discipline as the fresh-install report (exclusive directory, temporary names, Markdown first and the JSON last as the commit record naming its companion by sha256).

| Step | What a PASS means |
| --- | --- |
| Every migration applied by migrate deploy | `prisma migrate deploy` exited 0 and migrations are recorded as applied. |
| npm run db:seed | The seed exited 0. |
| IMS-side fixtures: products, opening stock, tax mappings, FX rate, store settings | The IMS side exists (three SKUs, opening stock for two, WooCommerce tax rates 1 and 2 mapped, a GBP-to-EUR rate, the store connection settings, the status selection) and nothing is reserved, allocated or imported yet. |
| No outbound-write grant exists: outbound:status reports every connector held | `npm run outbound:status -- --json --expect-held` exits 0 with WooCommerce, Mintsoft and Xero each `held`. |
| The real initial-import pass runs as a rehearsal (no stamp) | `runInitialImport` ran with `stampCompletion: false`; the report records what it fetched, imported, skipped and failed. |
| SIMULATED configuration check: the status list the rehearsal itself configured resolves to the owner decision | **A simulated check, and only that.** The harness itself puts the `wc_sync_order_statuses` selection into its throwaway database, so this step shows that the list `getWcPullStatuses('initial')` resolves from the decided selection is exactly `on-hold`, `pending`, `processing` and none of `cancelled`, `completed`, `failed`, `refunded`. It says nothing about any real installation. |
| Deployment: the target installation's wc_sync_order_statuses resolves to the owner decision (NOT CHECKED unless --check-deployment-statuses is given) | The only step that looks at a real installation, and it is **NOT CHECKED** unless `--check-deployment-statuses <env file>` is given (a mode-600 file holding `DATABASE_URL=` of the deployment). Then its actual `wc_sync_order_statuses` is read in one read-only transaction and judged against the decision: a missing row is the default, `processing` alone, and FAILS. A fresh install defaults to `processing` only, so the intended deployment's setting must be checked before D7 is considered satisfied. Not checked is reported as NOT CHECKED, never as a pass. |
| The pass judges itself COMPLETE on its own terms (no unread page, no truncated read, no unrecorded refusal) | The pass ended `complete`, with no unrecorded refusal and no per-order error (an error is an order that did not import). |
| A rehearsal wrote neither the completion stamp nor the sync cursor | Both keys were absent before and after the rehearsal pass. |
| R9: exact order count in the selected statuses; value within tolerance per order | Every order the store holds in a selected status is in IMS: the count is exact and nothing is excused. An order that is missing fails R9 and the verdict whether or not a durable retry row (the pending-FX queue) exists for it; the retry row is reported beside it as a recovery fact, because the stamp moves the cursor past the order regardless. No order outside the selected statuses is in IMS. For each imported order the stored total equals the total WooCommerce stated, in the order currency and in GBP at the seeded rate, and the order's own parts (line nets, tax, shipping, less any order-level discount) add up to its total, each within GBP 0.01 (`R9_VALUE_TOLERANCE`). |
| R4: reserved quantity equals the sum of allocations, per stock row | For every stock row, `reservedQty` equals the sum of `OrderAllocation.qty` within 0.0001 (`R4_QUANTITY_TOLERANCE`), and some row holds a reservation, so it examined something. |
| Every allocation row was derived by the allocation service (none seeded by hand) | Nothing was reserved or allocated before the import; every allocation row now carries its product's current fulfilment-graph version and belongs to an imported order. |
| Orders and lines that imported but could not be allocated are listed | The list is in the report: lines with no product link (a SKU IMS does not hold, a line with no SKU, a fee) are never allocatable; lines with a product that are short of stock wait for it. |
| A second pass imports nothing new | A second rehearsal pass imports none, creates no order or line, skips every order the first imported, and reports no error. |
| OD-4 (PROCESSING and ALLOCATED orders only): every such order that was waiting before stock landed is allocated after the backorder allocator and the sweep | Stock added after the import allocates nothing by itself; the backorder allocator (the call the stock-adjustment, purchase-receipt and transfer-receipt actions make) and then the reallocation sweep allocate every PROCESSING or ALLOCATED order that was waiting; R4 still holds afterwards. This step claims nothing about other statuses. |
| Every order still short after stock landed is listed by status; none of a status expected to allocate remains short; ON_HOLD and PENDING_PAYMENT are named as not expected to allocate | After the landing, every imported order that still has a product line short of stock is listed by status. It fails if one of a status expected to allocate (PROCESSING, ALLOCATED) remains short, or if a short order has a status nobody classified. ON_HOLD and PENDING_PAYMENT orders are printed as their own group, **not expected to allocate (o3d-zjsb5.36)**, and are named as such in the report, so the report never implies they allocated. |
| A real pass stamps completion and the sync cursor (once) | The one real pass ends `complete`, imports nothing on top of the imported set, and leaves `wc_initial_import_completed` = `true` and a `last_wc_order_sync_at` timestamp. |
| After the stamp the import button declines to run again | `startInitialImport` returns without scheduling a pass and the progress row is unchanged. |
| Read-only: no request other than GET reached the store, none was unmodelled, the hold refused nothing | See "What it never does". The email outbox also stays empty. |
| npm run invariant-check:preflight exits 0 on the imported data | No critical invariant finding (including `stock_reserved_source_mismatch`) on the imported, allocated data. |

### Findings that do not turn the run RED

The report has a **Findings** section for things the owner must read that the application does today and that a rehearsal cannot call wrong:

- **A pass can end COMPLETE with orders that did not import.** An order the import cannot convert (no GBP rate for its currency) is queued for retry after the next FX-rate refresh and the pass still completes; a real pass then stamps and moves the cursor. In a normal run every currency has a rate and this does not occur; with the rate left out R9 fails for the missing order and the report lists the retry row as a recovery fact.
- **Orders short of stock in a status other than PROCESSING or ALLOCATED are not allocated when stock lands (not expected to allocate, o3d-zjsb5.36).** The backorder allocator and the reallocation sweep act on those two statuses only, so an on-hold or pending-payment order that imports short of stock stays unallocated until something moves it.
- **Lines with no product link are never allocatable**, whatever stock lands.

### What this does not prove

This rehearsal runs the real import against a SYNTHETIC store. It does not prove how your real store answers (payload quirks, plugin meta keys, a page past the last one), which customers the import creates, whether a real product link resolves by SKU, or how your tax-rate mappings copy. Run it on recorded orders before relying on it. The rehearsal also configures no accounting connector, so nothing is queued for it; a real store with one will queue sales invoices for PROCESSING orders, held from sending by the outbound-write hold.

### Exit codes

This table is the only place the codes are documented; `WOO_IMPORT_EXIT` in `lib/ops/woo-import-rehearsal.ts` is its source and `tests/woo-import-rehearsal-assessors.test.ts` fails if the two disagree.

| Code | Meaning |
| --- | --- |
| 0 | GREEN: every required step passed and the teardown left nothing behind. |
| 1 | RED: a required step failed, was skipped, or threw. The report says which. |
| 2 | Refused to start: bad arguments, no PostgreSQL server binaries, run as root, or the work directory is on a RAM-backed file system. Nothing was created. |
| 3 | The teardown could not remove everything it created (cluster, env file, directory or a process). The report names what is left. Takes precedence over RED. |

## Updating

To update to a newer version:

```bash
# The root-owned copy of the driver, published by install.sh. An update refreshes it
# only when something outside imsapp's control vouched for the release, so it can be
# many releases older than the code it is deploying — see below. This is the
# documented command (o3d-z5be).
sudo bash /etc/ims-cutover-driver/driver/update.sh
```

**Run it from there, not from `/opt/one-two-inventory`.** The command used to be
`cd /opt/one-two-inventory && bash scripts/update.sh`, and that made `root` execute a script — and
the four shell libraries and two node helpers beside it — out of a directory `imsapp` owns:
`install.sh` and `update.sh` both `chown -R imsapp /opt/one-two-inventory`. An account that can
rewrite that checkout rewrote the program `root` was about to run, and could do so *after* the
operator had started a run they had reason to believe was clean. See
*The bytes a privileged run executes* below for what is published where, who owns it and what is
verified before anything is executed.

`/etc/ims-cutover-driver/driver/` holds the release that was **last vouched for**, which is *at least*
one release behind the one an update is installing — and the lag is **not bounded at one**. An update
uses the standing driver to deploy the new code and refreshes the copy at the end only when something
outside `imsapp`'s control vouched for that release (next paragraph). On the documented deployment that
means the operator supplied `IMS_DRIVER_SHA256`; **an update run without it completes normally and
refreshes nothing**, so ten such updates leave the driver ten releases behind and the eleventh is run
by deployment logic from before any of them. That is a supported state, but it is a state to know you
are in: each run that declines to refresh prints how old the standing copy is and what it hashes to.
The one-release minimum is deliberate — a driver that re-executed code it had fetched itself minutes
earlier would be exactly the defect this arrangement closes. The unbounded part is a consequence of
refusing to promote bytes nothing vouched for, and the remedy is the digest below, not a shorter lag.

### First rollout of the release that takes the cron bearer off the command line

Earlier releases scheduled their cron jobs as `curl -H "Authorization: Bearer $CRON_SECRET"`, which shows
`CRON_SECRET` to every local account in `ps` each time a job runs. This release rewrites those lines
(`update.sh`, `deploy.sh` and `install.sh` all run the same locked rewrite, and `update.sh`/`deploy.sh`
refuse to report completion while any such line remains). **But the documented command runs the standing
root-owned driver, and on the first rollout the standing driver is the PREDECESSOR: it deploys the new code
and restores the old crontab untouched, because the rewrite exists only in this release's scripts.** An
update run that way completes, reports success, and the old lines are still scheduled.

For this release, run the release's own scripts instead of the standing driver. Fetch the release as root
into a newly created directory (*[The supported bootstrap](#supported-bootstrap)*) and either run
`install.sh` from there, or run its `update.sh` (root-owned trees are accepted; only trees another account
can write are refused):

```bash
sudo bash /root/ims-release-NEW/scripts/update.sh        # add IMS_DRIVER_SHA256=<64 hex> to refresh the driver as well
```

Either way the rewrite runs before the run can report completion. If you did update through the standing
driver, nothing flagged it: check, and then run one of the two commands above. The check prints only crontab
line NUMBERS (never the lines, which may carry the secret), and nothing when the crontab is clean:

```bash
sudo crontab -u imsapp -l | grep -nE 'curl.*[[:space:]](-H|--header).*([Bb]earer|[Aa]uthorization)' | cut -d: -f1
```

Once the standing driver is this release or later (it is refreshed by `install.sh`, or by an update run
with `IMS_DRIVER_SHA256`), the documented command carries the rewrite and no special step is needed.

To see what is standing before deciding, read its record — which lives beside the tree the pointer
names, so this always reports the copy that is actually in use:

```bash
cat /etc/ims-cutover-driver/driver/../driver.sha256
```

**And the end-of-update refresh only happens when something outside `imsapp`'s control vouched for the
release.** `update.sh` deploys into `/opt/one-two-inventory`, which it chowns to `imsapp` itself, so by
the time the refresh is reached the tree it would copy is one that account could have rewritten
*after* every check the run performed — and what lands in `driver/` is what the **next** `sudo bash
/etc/ims-cutover-driver/driver/update.sh` executes as root. Copying it unvouched would postpone a
privilege escalation by one release rather than close it, so the run **refuses** and says so:

```bash
# Refresh the root-owned driver as part of the update, with the release's own digest.
# The digest comes from the RELEASE (published with its checksums, or computed from a
# clean checkout on another host) — never from the box being updated, where it is only
# what the tree under question says about itself.
IMS_DRIVER_SHA256=<64 hex> sudo -E bash /etc/ims-cutover-driver/driver/update.sh
```

`sudo -E` carries the whole environment. `update.sh` does not read `IMS_CHOWN_TREE_HELPER`, but
`install.sh` does, and that variable SELECTS A PROGRAM RUN AS ROOT to re-own the state directory: it
exists for the test suite, and must never be set — or passed through with `-E` — from an environment
you do not control.

The digest is taken over the tree that would be published — the three entrypoints and `lib/` — with:

```bash
d="$(mktemp -d)" && mkdir "${d}/lib" \
  && cp scripts/install.sh scripts/update.sh scripts/deploy.sh "${d}/" \
  && cp scripts/lib/* "${d}/lib/" \
  && ( cd "${d}" && find . -type f -printf '%P\0' | LC_ALL=C sort -z | xargs -0 -r sha256sum -- | sha256sum ) \
  ; rm -rf "${d}"
```

Without it the deployment still completes and the driver that last vouched for itself goes on standing —
the previous release only if that release was vouched for, and otherwise something older. That is a
supported state: the warning at the end of the run names it, says how old the standing copy is, and
names this remedy. The other way to
refresh it needs no digest at all — fetch the release as root into a newly created directory and run
`install.sh` from there, exactly as in *[The supported bootstrap](#supported-bootstrap)*; then nobody
else has ever had those files open and nothing has to vouch for them. Relabelling an existing tree with
`chown`/`chmod` does **not** qualify.

**Running `update.sh` or `deploy.sh` as root out of `/opt/one-two-inventory` is not supported, and is
refused** (o3d-z5be r5). That tree belongs to `imsapp`, and nothing inside a tree another account can
write can make root's execution of it safe — see *Which invocations are supported* below. On a host
that has no driver yet (one last installed by a release older than this change), run `install.sh` from a
release fetched as root into a newly created directory — *[The supported bootstrap](#supported-bootstrap)*;
it publishes the driver, and every update after that is the command above.

**There is no manual equivalent, and this document deliberately no longer offers one.**

Until o3d-2sm1.5 it did: a copy-pasteable block that fetched, built, wrote a `DEPLOY-FENCED`
marker, stopped the service and invoked Prisma. It read like the scripts and it was not the
scripts, and the three things it could not carry are each exactly the failure the cutover
exists to prevent.

* **It published `schema_touched=false` and then migrated.** The marker was written once,
  complete, *before* `prisma migrate deploy` — so a Prisma failure, an OOM kill or a power cut
  mid-migration left a **complete** marker on disk asserting the schema had not moved. The
  next entrypoint adopts that marker, believes it, and **releases the connection fence over a
  half-migrated schema**. `mark_schema_touched()` exists to publish `schema_touched=true`
  *before* Prisma is invoked, and to refuse the migration if that cannot be made durable.
  No hand-typed sequence did either.
* **Its cron fence was a comment.** `# then comment the jobs out` is not a command. An
  operator following the block literally left every cron writer running across the migration,
  which is the second half of "stop and drain every writer".
* **Nothing it wrote was durable.** `printf > file` is neither atomic nor flushed. The scripts
  publish through `publish_durable_file()`: a temporary in a root-owned staging directory on the
  same filesystem, an `fsync` of the data, a `renameat` through a descriptor held on the
  destination, an `fsync` of that same descriptor, and a `marker_complete=1`
  sentinel written last so a reader can tell a whole marker from a torn one. A shell
  redirection has none of that, and a reboot can find an empty marker, the previous one, or no
  marker at all.

The three entrypoints — `scripts/install.sh`, `scripts/update.sh`, `scripts/deploy.sh` — share
one cutover namespace, one lock and one state machine, so a fence left standing by any of them
is adopted by any other. **If an update fails, re-run one of those scripts; do not hand-roll
the sequence.** The failure banner names the marker, the fences that are standing and the
command that releases each, and the next run adopts what the failed one left behind.

To see what a run would do without doing it, `bash /etc/ims-cutover-driver/driver/update.sh --dry-run`
prints the whole plan and changes nothing, and `bash /etc/ims-cutover-driver/driver/deploy.sh --dry-run`
does the same for a deploy. **Changes nothing includes `/etc/ims-cutover-driver`** (o3d-z5be r5): until
r5 a root `--dry-run` — and a root `update.sh --print-fence-digest` — published and flipped the
`helpers` snapshot and swept older publications at startup; both modes now publish nothing, as root or
not. Both work unprivileged, and unprivileged they may also be run out of a checkout, because an
unprivileged run executes nothing as root; as root, the tree rule above applies to them like any other
run. Unprivileged, `update.sh --dry-run` runs its git probes as the account that typed it (it does not
try `runuser`, which only root may use), so it needs no `--no-git`; it still reports that the fence
preflight was not run, because the admin credential is root-only. **A dry run writes nothing, including on an
installation that has no `.git` directory** (the clone / `rsync --delete` / `chown -R` replacement of the
application directory is printed as a plan, not performed; `update.sh --dry-run` was measured in a
disposable container to leave every file, the crontab and the unit state untouched). **A dry run that fails says so and
says nothing else**: it prints `DRY RUN FAILED — NOTHING WAS CHANGED` with the step it reached and exits
non-zero. It never prints the post-stop banner (`FAILED AFTER THE STOP`, service stopped, cron fenced),
because nothing was stopped or fenced. The check that the loaded unit configuration binds the service
to this run's database snapshot is not run in a dry run (a dry run publishes no snapshot, so the check
could only fail); it is listed as a step the real run performs.

### Deploy order, and what happens on a rollback

The order is:

```
build -> validate -> STOP AND DRAIN EVERY WRITER -> migrate -> verify -> start -> health
```

`scripts/update.sh`, `scripts/deploy.sh` **and `scripts/install.sh`'s upgrade cutover** implement
exactly that, and `tests/scripts/deploy-order.test.ts` fails if the steps are reordered.

### One cutover namespace

All three entrypoints read and write the same four paths, so a fence left standing by any one
of them is adopted by any other — which is what the failure banners have always told operators
to do:

| what | path | owner, mode |
| --- | --- | --- |
| cutover marker | `/etc/ims-cutover/DEPLOY-FENCED` | `root:root` 0600, in a `root:root` **0700** directory |
| cutover lock | `/etc/ims-cutover-state/cutover.lock` | `root:root` **0600**, in a `root:root` **0711** directory |
| connection-fence authority | `/etc/ims-cutover-state/db-fence/db-connect-fence.json` | `root:root` **0644**, in a `root:root` **0755** directory. Carries `fence_mode` (`initial` or `recovery`) since o3d-secops r24 and `fence_applied` (`0`, raised to `1` by root after the revoke) since r25. A record carrying **no** `fence_applied` key is refused by every automatic path since r26 — see *Two kinds of fence* |
| crontab backup | `/var/lib/one-two-inventory/crontab-<service user>.bak` | `root:root` 0600 |

Set `IMS_CUTOVER_STATE_DIR` **in the environment of the root invocation** to move the crontab
backup and the crontab lock directory; `IMS_DEPLOY_STATE_DIR` and `IMS_DATA_DIR` are still honoured.
**No variable moves the first three.**

**The lock and the connection-fence directory left the state directory in o3d-secops r22, for the
reason the marker left it in r20.** `/var/lib/one-two-inventory` is handed to `imsapp` on every run,
so every name directly beneath it is that account's to create, replace and unlink — and two of the
things that lived there were opened or created **by root**:

* the lock was `exec 9>"$LOCK_FILE"`, which is `open(O_WRONLY|O_CREAT|O_TRUNC)`. A symlink at that
  name **truncated the target to zero** before `flock` was reached — any file root can write, a unit
  file or the fence marker included — and the `flock` that followed proved only that *a* lock had
  been taken, never that it had been taken on *this* file;
* the connection-fence directory was `mkdir -p`, which **accepts a symlink-to-directory** at the
  final component and returns success, followed by a `chown` and a `chmod` that both dereference. A
  link there pointing at `/etc`, at `/root`, or at any directory on the box handed that directory to
  `imsapp` at mode 0700.

They now live under **`/etc/ims-cutover-state`**, root-owned and **0711**: nobody else can create,
replace or unlink a name inside it, so there is no symlink left to plant at either. It is a
**literal** in all three scripts, for the same reason the marker's directory and the
database-identity snapshot's are. `/etc/ims-cutover` was not reused and was not touched: it is 0700
because it holds the database password and the boot authority, the connection-fence record has to be
**readable by the service user** (the helper that executes a fence and a release runs as that
account), and relaxing the one directory that exists to be private, so that a readable child could
be traversed to, is not a trade worth making.

**0711 and not 0755, and the lock is 0600** (o3d-secops r23). r22 justified only the `x` bit on the
parent and the `r` bit came with it; nothing in there needs to be *listed* by the service account,
which reaches `db-fence/` by a name compiled into the scripts. And the lock's mode is load-bearing
after all: `flock(2)` needs nothing but an open descriptor, so **read permission on the lock file is
permission to hold the cutover exclusion** — at 0644 the service account could open it, take it, and
freeze every deploy, update and install on the box for as long as it liked. r22 dropped the mode
*assertion* because an ambient umask would then refuse a cutover for a property nothing repaired; it
is now **set** instead — created under a stated `umask 077`, and narrowed on the descriptor
`verify_held_lock()` has just identified (`chmod` of `/proc/self/fd/N`, which is an `fchmod`) with
the result read back off that same descriptor before `flock` is taken.

**And a lock that was ever wide is replaced, not repaired** (o3d-secops r24). Narrowing closes the
door to new opens and does nothing whatever to a descriptor somebody already holds: **permission is
checked at `open(2)` and never again**. On a host upgraded from a checkout that left this file at
`0644`, the service account can have opened it *before* the cutover started, **without locking it**
— an open is invisible where a lock is not, and `fuser` shows nothing — and then `flock` it the
moment the cutover exits, freezing every deploy, update and install afterwards with nothing to point
at. So where the lock is **inherited** at anything other than `0600`, the run creates a fresh `0600`
inode in the same root-owned directory, opens it read-only, verifies it, narrows it, **locks it**,
and only then renames it over `cutover.lock`. A descriptor opened while the old file was wide now
refers to an inode with no name. It happens **once**: the gate is the mode the lock was inherited
at, so the next cutover finds `0600` and replaces nothing.

The trade, stated. Replacing an inode means giving up exclusion against anything still holding the
old one — which is the point, and would be a disaster if a genuine concurrent cutover were the
holder. It cannot be: the replacement is reached **only after this run holds `flock` on the
inherited inode**, so at the instant of the rename nothing else holds that lock, and `fd 9` is then
kept open on the retired inode for the rest of the run. A real predecessor therefore never loses —
if it got there first, this run dies at `Refusing to run two cutovers at once` and **nothing is
rotated**, so its inode is never swapped out from under it; a cutover arriving while `fd 9` is held
is refused on the old inode, and one arriving after the rename is refused on the new one. The only
process that can ever take the orphaned inode's lock is one that opened it and did not immediately
try to lock it — and no cutover here is ever in that state, because `flock -n` is non-blocking,
follows the open in the same function, and every failure ends the run. That state belongs to the
holdout this exists to defeat and to nothing else.

**And nothing in that namespace is aimed at a pathname.** The directory is created one component at
a time by the same symlink-proof walk `install.sh` has always used for `${DATA_DIR}` — plain `mkdir`
(EEXIST on a planted symlink, where `mkdir -p` silently works *inside* its target), `lstat`, `cd -P`,
and the inode it landed on proved against the entry — and its owner and mode are then applied to
`.`, the directory the shell is standing in, which is `fchown(2)`/`fchmod(2)` in the only spelling a
shell has. The lock is opened **read-only** (`flock(2)` locks the open file description whatever its
access mode, which is what `lib/crontab-lock.sh` already relies on), so there is no `O_CREAT` and no
`O_TRUNC` left to aim; the descriptor is then `fstat`ed through `/proc/self/fd/N` and required to be
a regular file owned by the account running the cutover **and** to be that name's own inode by
`lstat` — which is `O_NOFOLLOW` proven rather than assumed — and `flock` is taken on **that same
descriptor**, which is never reopened. The walk, the lock and the directory now have exactly one
definition each, in `scripts/lib/cutover-namespace.sh`, sourced by all three entrypoints: the walk
used to exist in `install.sh` alone while the two paths that most needed it were in the other two.

### Before a cutover: no other cutover

**One lock excludes one population, and it is not everything that can run a cutover on this host.**
`/etc/ims-cutover-state/cutover.lock` excludes every `deploy.sh`, `update.sh` and `install.sh` that
takes *that* lock. A cutover launched from a **checkout that predates o3d-secops r22** takes a lock
under `/var/lib/one-two-inventory`, which the service account may rename between that run's `open`
and this one's — so **nothing in the code can exclude it**, and since r23 nothing pretends to. Every
non-dry run says so out loud at the moment it takes its own lock.

r22 shipped a bridge that also locked the old name. It could not do what it claimed: a predecessor
holds an **inode**, the bridge opened a **name**, and the account that owns that directory can move
the name out from under the inode and leave a fresh regular file at it — on which every check the
bridge made passes. The two honest ways out are a **transitional predecessor** that also takes the
protected lock, and **operator-controlled quiescence**. The first is not available: a transitional
release would have to reach a host *before* the checkout that moved the lock, and every host with a
pre-r22 checkout has it already. So it is the second, and this is where the requirement lives:

> **Before starting a cutover, establish that no other one is running.** `fuser -v
> /etc/ims-cutover-state/cutover.lock` names anything holding the shared lock. For a checkout that
> predates it, look for a running `deploy.sh`, `update.sh` or `install.sh` from **any** directory
> (`pgrep -af 'install\.sh|deploy\.sh|update\.sh'`), and prefer removing or upgrading stale
> checkouts to remembering this step. Two concurrent cutovers migrate one schema twice.

One claim survives in code, with its precondition **proved rather than assumed**: the lock at
`/var/lib/ims-deploy/deploy.lock` is still taken, but **only** where `stat` says that directory is
owned by the account running the cutover and is writable by nobody else. Where it is not — including
where it does not exist — nothing is opened, created or locked there, and what is not excluded is
named.

**Connection-fence records at the old paths are named and not imported.** Both
`/var/lib/one-two-inventory/deploy/db-connect-fence.json` (pre-r22) and
`/var/lib/ims-deploy/db-connect-fence.json` (the namespace `deploy.sh` used before the shared one)
list the grantees a fence revoked `CONNECT` from, and both were written by the fence helper running
as the service account. Earlier checkouts **republished** the second one into the shared namespace;
that made root act on the application's own choice of who gets database access, which is the
r23 CRITICAL with an older file in it. A fence that really is standing is still found — from the
database, which is where the release path already asks, and which already refuses with the grantees
named when the record is gone.

**The cutover marker is NOT one of them, and no variable moves it** (o3d-secops r20). It used to
live at `/var/lib/one-two-inventory/DEPLOY-FENCED`, root-owned and `0600` — and that protects its
*bytes* and nothing else. `unlink(2)` and `rename(2)` ask for write permission **on the parent
directory** and ask nothing whatever about the file, and `/var/lib/one-two-inventory` is handed to
`imsapp` on every run. So the service account could delete the marker — which lifts the
`AssertPathExists=!` and lets the unit start on the next boot, over a schema in whatever state the
interrupted cutover left it — or move it aside and leave one of its own at the name, which the next
run reads as an account of what the interrupted *privileged* run did and acts on line by line. The
marker now lives under `/etc/ims-cutover`, created root-owned and `0700`, which is the same
directory the database-identity snapshot already uses and one of the publication trust roots.
Its path is a **literal** in all three scripts for the reason the snapshot's is: an override only a
root-owned source may set is indistinguishable from no override, and a privileged path resolved
from a variable the application can set is not a privileged path. A deployment that must move it
edits that line, which is a root-owned change to a root-owned file.

**Adoption checks provenance, not existence.** Before a single line of a marker is read, all three
scripts require it to be a *regular file* (`lstat`, so a symlink is refused) owned by the account
running the cutover with no group or other write bit, **inside a directory** owned by that account
with no group or other write bit. Anything else — a symlink, a directory, a marker in a parent
somebody else can write — is refused with a message naming what is wrong, and nothing is stopped
and nothing is migrated.

**Upgrading a host that is currently fenced.** If a marker is sitting at the old path when a
post-r20 entrypoint runs, it is **republished at the new one before anything is adopted** and the
old file is deliberately **left where it is**: the drop-in already on disk still asserts on it, so
the host stays fenced across the move. Only once a drop-in naming `/etc/ims-cutover/DEPLOY-FENCED`
has been written, `daemon-reload`ed and *verified* is the old marker removed. A crash anywhere in
between leaves both, which is the safe direction — whichever drop-in is loaded, the file it asserts
on is there — and the next run says so and adopts the one under `/etc`. Lifting the fence removes
both. **Nothing is silently released:** there is no state in which the marker stops being seen.

**And the marker at the old path is NOT READ AT ALL** (o3d-secops r22). Relocating it meant reaching
back into the directory the relocation exists to escape, and r20 did that with `[[ -f ]]` — which
*follows a symlink* and says nothing about who wrote what it found — followed by a redirection that
resolved the same name a second time, as root, straight into the publisher. r21 replaced that pair
with a descriptor helper: one `open(2)` with `O_NOFOLLOW`, then every fact taken from the `fstat` of
that descriptor — a regular file, owned by the uid running the cutover, no group or other write bit,
and exactly **one link** — the descriptor proved to be that name's own inode, and the bytes copied
from the descriptor rather than from the name.

Every one of those checks is sound. Together they still do not establish what the relocation needed,
and the link count is where that becomes visible. **`st_nlink` is a fact about the present, not about
the past.** It says no second name exists *at the moment of the `fstat`*; it cannot say none ever
did. The service account can hard-link a root-owned 0600 inode **whose content it influenced** into a
directory it controls, drop the other name, and leave exactly one link at a path of its choosing —
and these scripts create root-owned 0600 files out of that account's own content on every run: the
crontab backup *is* its crontab, written by root, in its own directory. r21 named
`fs.protected_hardlinks` as what normally forbids the link, and then rested on it — which is resting
a privilege boundary on a sysctl these scripts neither set nor read back.

There is no seventh check that fixes that. When the adversary owns the directory a file is named in,
no sequence of questions about the file establishes provenance: whatever the check, the account can
arrange for a file that passes it. So the answer stopped being a better inspection and became a
different use of the answer.

**The PRESENCE is the signal; the content is not evidence of anything.** While *anything* exists at
`/var/lib/one-two-inventory/DEPLOY-FENCED`, an `AssertPathExists=!` installed by an earlier checkout
is satisfied by it, so the host **is** fenced — whoever put it there, and whatever is inside it. That
is a fact about the **name**, which is the one thing that cannot be forged away: the account can
create that name, and cannot make the running system ignore it. It is also everything the relocation
needs.

So nothing is opened and nothing is read. `scripts/lib/pin-source-file.mjs` is **gone**, with its
regressions: it existed to authenticate those bytes, and an unused apparatus whose premise has been
rejected is an invitation to wire it back up. The marker published at `/etc/ims-cutover/DEPLOY-FENCED`
is composed by the run itself, out of its own facts, and records **the most conservative fence state
there is**:

| line | what it means |
| --- | --- |
| `phase=stopping` | assume the predecessor had begun stopping |
| `migration_attempted=true` | assume the reboot fence was meant |
| `schema_touched=true` | assume the schema may be half migrated |
| `legacy_marker_unauthenticated=1` | and say that those three are a **policy**, not a reading |
| `legacy_marker_path=…` | the old path it came from, so an operator can go and look at it |

Those are the same three values adoption already derives for a marker that fails its completeness
sentinel — *missing is not false, it is unknown, and unknown is read the expensive way* — reached
here by a different route for the same reason. **Not one line of the old file is carried forward**,
including its own `marker_complete=`: a truncated predecessor cannot be told from a forged one, and
neither may be republished as this host's record of what a privileged run did. In practice the run
therefore re-migrates, re-checks drift and re-verifies before anything gets `CONNECT` back, and it
does not resume an "interrupted arming" over a service it would otherwise have left running.

**The old entry is still left exactly where it is**, and the run still does not delete it: the
drop-in on disk asserts on that name, so removing it is a release. Adoption prints the marker
verbatim, so an operator sees `legacy_marker_unauthenticated=1`, and the run names the two things
that **can** be established without trusting that file — ask systemd what is actually asserted
(`systemctl show -p DropInPaths` on the unit, then read the drop-in it names), and ask the database
whether the application role still has `CONNECT`. Settle those, clear the entry by hand, and a later
run has nothing to adopt.

**This gives `imsapp` nothing it did not already have.** It can now make every subsequent cutover
adopt a conservative fence by touching one name — and it could already do strictly more with that
same name, because a drop-in asserting on it stops the unit from booting. The outcome is fail-closed
either way.

**An override has to be ANCHORED, and an unanchored one stops the run rather than being trusted.**
Every path above is published by a walk that starts at a directory the scripts take on trust, so
that directory's own name must be one the service user cannot replace. That is decided by walking
to it from `/`: **every directory from `/` down to the override's parent** must belong to root (or
to whoever is running the script), must carry no group or other write bit, and must be a real
directory rather than a symlink. `/opt`, `/var/lib` and `/etc` all satisfy that, which is why the
shipped defaults work; `/tmp` does not, and neither does anything under a directory the application
account owns.

It is the **whole ancestry** and not just the parent, because a parent nobody can write into is
worth nothing if somebody can rename the parent. `IMS_CUTOVER_STATE_DIR=/home/app/guard/state` with
`guard` root-owned and `0755` is refused, because `/home/app` belongs to the application account and
`guard` is theirs to move aside. A **sticky** ancestor — `/tmp`'s `1777` — is accepted as an
ancestor, since sticky stops anyone but an entry's owner from renaming it; it is **not** accepted as
the override's own parent, because on a first install the directory does not exist yet and sticky
says nothing about who may create it. So a root directly under `/tmp` is refused either way.

* An override **nested inside another root** — `IMS_CUTOVER_STATE_DIR=/var/lib/one-two-inventory/cutover`
  — is supported and needs no anchor of its own. The walk simply starts at the data directory and
  resolves `cutover` like any other component: created with a plain `mkdir`, checked with `lstat`,
  and **refused if it is a symlink**. So do not point a nested state directory at another disk with
  a symlink — and since o3d-rn10 r5 do not point the **root** at one either; see the last bullet.
* An override **outside every other root** whose parent is writable by anyone but root — say
  `IMS_CUTOVER_STATE_DIR=/home/deploy/state` — is refused. The run fails, loudly, at the first
  publication, rather than writing root-owned state into a directory somebody else can redirect.
* A root that **is itself a symlink** — `/var/lib/one-two-inventory -> /srv/disk2/ims`, which is how
  a second disk used to be wired in — is refused too. `install.sh` refuses it **at pre-flight**,
  before it creates, enters or writes anything at all; the publisher refuses it at the first
  publication. Both print the same lines:

  ```text
  ERROR: /var/lib/one-two-inventory is a symbolic link, and a root this run writes into may not be one: nothing here proves the path its target resolves through.
  ERROR: WHY: every later run of these scripts rsyncs into this root with --delete and chowns it RECURSIVELY. A root that is an ALIAS for another directory hands both of those to whatever the alias resolves to at that moment, and any account that can rename a directory on the way to the target chooses what that is. Stopping the service does not remove that account.
  ERROR: To keep /var/lib/one-two-inventory on another disk, replace the link with a real directory and bind-mount the disk onto it — no data has to move, because the bind exposes the same filesystem at the same path.
  ERROR: This run resolved that link to: /srv/disk2/ims
  ERROR: THE BIND-MOUNT PROCEDURE IS IN THE DOCUMENTATION, NOT ON THIS SCREEN: docs/installation.md, "Putting a state root on another disk". It is not printed here because it cannot be pasted safely without checks only you can make: the target must hold NOTHING BUT this application's data, every directory from / down to it must be one only root can replace, and the parent of this root may not be. The documentation names all of those, the order to stop the writers in, the identity check to make after the mount, how to put the link back if the mount does not take, and the fstab line that makes the bind survive a reboot.
  ```

  **The commands themselves are no longer printed** (o3d-secops r8). They used to be: a five-step
  `rm && mkdir -p && mount --bind` procedure, with an apparatus in front of it deciding whether the
  procedure was safe to print — an ancestry walk over the target, a device/inode capture, a
  system-directory exclusion, and containment checks in both directions against every root the run
  writes into. **That apparatus produced a finding in every review it survived**: a fail-open
  descriptor acquisition, an ancestry gate that proved an adjacent property, a fail-open identity
  capture, an identity that was not globally unique, and finally the procedure itself. `rm ROOT &&
  mkdir -p ROOT && mount --bind TARGET ROOT` is raceable for `LOG_DIR`, whose `/var/log` parent the
  installer *itself* recognises as group-writable and non-sticky: between the `rm` and the `mount`
  the `syslog` account can create the name, and the bind lands on their directory entry. Five
  findings from one operator convenience. The refusal, the reason and the resolved target stayed;
  the recipe moved here, where a human reads it, checks their own parent directory, and is not
  handed a paste. The **only** thing the scripts still do about a symlinked root is refuse it.

  **Why they refuse it at all:** the root's own *name* is safe, because its parent is root-owned;
  the *path its target resolves through* is not walked by anything, so any directory on that path
  the application account can write is a place to redirect a root-side publication of `.env`. A bind
  mount is the same indirection with the resolution done **once**, at mount time, out of a mount
  table only root can write.

#### Putting a state root on another disk

This is the procedure the installer used to print. Read it, decide each point for your own host,
and then run it **with the writers stopped**. It applies to `APP_DIR`, `DATA_DIR`, `LOG_DIR` and to
any anchored override — anywhere you would otherwise have reached for a symlink.

**Before anything else — the precondition no program can check for you.** The target directory must
hold **nothing but this application's data**. After the bind, every later run of `install.sh`,
`deploy.sh` and `update.sh` treats that directory *as the root*: it `rsync --delete`s into it and
`chown -R`s it to the service account. Anything else living there is deleted or taken over. "A
directory that holds nothing but this application's data" is not a question a filesystem can be
asked, and no denylist converges on it. If you are not certain, move the application's data into a
directory of its own first and bind **that**.

**Then check the target, by hand, against all five of these.** Each was a gate the installer used
to apply before it would print anything; they are the operator's now.

1. **The target must resolve to a directory.** If the link is dangling there is nothing to bind, and
   nothing here will guess what it was meant to point at.
2. **Every directory from `/` down to the target must be one only root can replace** — owned by root
   and carrying no group or other write bit. This is the same ancestry question that decides whether
   a directory may be a publication root at all, and it is the whole reason a bind is safer than a
   symlink: a bind resolves the path **once**, at mount time, but only if nobody can change what
   that path means before you type the command. `/srv`, `/var/lib` and `/mnt` normally satisfy it;
   a directory under `/home` or under anything the application account owns does not. Check it with
   `namei -l /srv/disk2/ims`.
3. **The target may not be part of the operating system.** `/`, `/bin`, `/boot`, `/dev`, `/etc`,
   `/lib*`, `/proc`, `/root`, `/run`, `/sbin`, `/sys`, `/usr` and `/var/www` are not bind sources: a
   bind source is where data lives. `/opt/one-two-inventory -> /etc/systemd/system` satisfies every
   other question on this list and would put the host's unit tree where the next run rsyncs,
   deletes and chowns. `/srv`, `/mnt`, `/media`, `/opt`, `/var` and `/home` stay available.
4. **The target may not be the root, an ancestor of it, anything under it, or any other root these
   scripts write into.** Those are `APP_DIR`, `DATA_DIR`, `LOG_DIR`, the cutover state directory,
   `/etc/ims-cutover`, `/etc/ims-cutover-state`, `/etc/ims-db-ca` and `/etc/ims-cutover-recovery`.
   `/opt/one-two-inventory -> /opt` passes every other question — `/opt`'s name cannot be rebound by
   anybody but root — and binding `/opt` onto `/opt/one-two-inventory` hands the next run the whole
   of `/opt` to `rsync --delete` into and `chown -R`. The same shape gives `/var/lib` for `DATA_DIR`
   and `/var/log` for `LOG_DIR`. Compare **device and inode**, not spellings: two paths can be the
   same directory, or nested, without sharing a prefix, because a bind mount already in place gives
   one directory two names. `stat -c %d:%i` on each, in both directions.
5. **The root's own parent may be writable by somebody other than root, and `/var/log` is.** On
   Ubuntu `/var/log` is `drwxrwxr-x root:syslog` and not sticky, so the `syslog` account may create
   and rename entries in it. The `rm` in step 3 below removes a name in that directory and the
   `mkdir` on the line after it creates the name again: in that gap, that account can take it, and
   the `mount --bind` then lands on **their** directory entry. This is exactly why the installer no
   longer prints these commands. For `LOG_DIR` — or for any root whose parent is group-writable and
   not sticky (`ls -ld` the parent) — do not run `rm` + `mkdir` blind. Stop the accounts that can
   write the parent first, or make the parent sticky (`chmod +t`) for the duration, and let step 5
   tell you whether what you mounted onto is the directory you created.

**Then do it, in this order, and not as a one-liner.** The sequence matters: the refusal appears
while the service and its cron are still running, and step 3 removes a live pathname.

```bash
# 1. Stop the writers. Nothing may be writing under the root while its name is being replaced.
systemctl stop one-two-inventory.service
crontab -l                       # note and pause anything writing under the root

# 2. Confirm the target is where the data actually is, and record its identity.
readlink -f /var/lib/one-two-inventory     # -> /srv/disk2/ims
stat -c %d:%i /srv/disk2/ims               # -> e.g. 2049:262145   (keep this)

# 3. Replace the link with a real directory. See check 5 above before doing this on LOG_DIR.
rm /var/lib/one-two-inventory
mkdir /var/lib/one-two-inventory

# 4. Bind the disk onto it. Nothing moves: the bind exposes the same filesystem at the same path,
#    so the data, the ownership and the free space are the ones that were already there.
mount --bind /srv/disk2/ims /var/lib/one-two-inventory

# 5. Verify BOTH, and put the link back at once if either is wrong.
findmnt -no TARGET,SOURCE /var/lib/one-two-inventory   # must name the root
stat -c %d:%i /var/lib/one-two-inventory               # must print the identity from step 2

# If the mount did not take, or either check differs:
umount /var/lib/one-two-inventory 2>/dev/null
rmdir /var/lib/one-two-inventory && ln -s /srv/disk2/ims /var/lib/one-two-inventory

# 6. Make it survive a reboot, then start the service again.
printf '%s\n' '/srv/disk2/ims /var/lib/one-two-inventory none bind 0 0' >> /etc/fstab
systemctl start one-two-inventory.service
```

**Step 5 is not optional.** Without it, a wrong or unavailable target leaves an **empty real
directory** at the live path with the data detached behind it, and the application either fails or
quietly populates a shadow tree — with nothing on screen to say how to get back.

**`/etc/fstab` has its own escaping, and it is not the shell's.** Fields are split on whitespace,
and a space, a tab or a backslash is written as an octal escape — `\040`, `\011`, `\134`. A
newline or a `#` has no escape in that format at all: a path containing either cannot be written
into `/etc/fstab`, and needs a systemd `.mount` unit instead.

### `install.sh` proves its three roots before it touches them

`APP_DIR` (`/opt/one-two-inventory`), `DATA_DIR` (`/var/lib/one-two-inventory`) and `LOG_DIR`
(`/var/log/one-two-inventory`) are checked in **section 1**, immediately after the "must be run as
root" check and before any other statement in the run. Each is resolved by a walk that starts at
`/` and takes one component at a time: every component is `lstat`ed, so a **symlinked ancestor** is
refused rather than followed, and after each step the directory the walk landed in is checked
against both the inode the entry named and its own `..`. The root's own entry is then read by a
single `lstat` inside that pinned parent — never as a pathname — and **a symlink at it ends the
run**.

This is an **ordering** rule, and the order is the point. Before it, `install.sh` created and
entered those same roots with a bare `mkdir -p` plus `cd -P`, so on a host where one of them was a
link, `useradd --create-home`, the upload migration, the crontab-lock preparation, the cron backup,
`rsync`, `git clone` and every `chown -R` acted **through** the link, and the refusal above arrived
afterwards. The gate now precedes all of them.

`LOG_DIR` is in the list even though nothing is published under it, because the ownership change
that follows **dereferences its operand**: a link at `/var/log/one-two-inventory` would hand the
whole of whatever it points at to the service account, recursively.

**The gate is a snapshot, and for `LOG_DIR` a snapshot is not enough.** It proves what is at the
name when it runs and then releases the directory it walked to. For `APP_DIR` and `DATA_DIR` that
settles it: `/opt` and `/var/lib` are root-owned and `0755`, so from that moment only root can put
anything else at those names. `/var/log` on Ubuntu is `drwxrwxr-x root:syslog` and **not sticky**,
so the `syslog` account may *rename* any entry in it — root-owned ones included — with **no symlink
involved at all**. Between pre-flight and section 8 it could move the real log root aside and
rename another `/var/log` subtree into its name.

So section 8 does not act on the name, and it is held to **what pre-flight approved**. The gate
records the root's `dev:ino` (or the word `absent`, when the name was free). `enter_service_root()`
then walks from `/` again, creates the root with a plain `mkdir` — which fails on a planted link
rather than working inside it — or accepts an existing one, steps **into** it, checks its inode and
its `..`, and finally requires the directory it is standing in to be **the very entry the gate
approved**. A root the gate found absent must be one this run's own `mkdir` created; a root that
appeared in between belongs to whoever made it and is refused. The process is left inside, and the
ownership change is made of `.`, so a rename of the name afterwards cannot move a descriptor.

Identity, not ownership: the recursive chowns hand `DATA_DIR` and `LOG_DIR` **themselves** to the
service account, so from the second run onward the roots are not root-owned and a "must be owned by
root" rule would refuse every upgrade — while still accepting a *different* root-owned subtree
renamed into the name. Continuity from the gate answers both.

The gate also **opens a descriptor** on an approved root and holds it for the run, and section 8
enters through `/proc/self/fd/N` — which the kernel resolves to the open file rather than to a
pathname. A `dev:ino` alone would not be enough: inode numbers are reused, so an account that can
write the parent could remove an empty approved root, create its own at the name, and win if the
filesystem handed back the inode it had just freed. Acquiring that descriptor is **mandatory**: a failed
walk, a failed open or a verification that does not match ends the run, and a missing descriptor at
section 8 is a refusal rather than permission to enter by name. Fail-open here would be worse than
not trying: an account that can write `/var/log` could rename the entry aside for the instant of the
open and switch the weaker mode on at will.

**`/proc` must be mounted, and a host without it is refused** (o3d-secops r8). This used to be the
one remaining way of not getting a descriptor: a missing `/proc/self/fd` was a `warn` and the run
carried on on the `dev:ino` comparison, with a by-name entry branch in `enter_service_root()` to
fall into. That was a fail-open in the middle of the hardening that exists to remove exactly it —
and the code's own comment explains why identifying a root by name is unsafe. There is no way to
name an open directory without `/proc`, so there is no weaker mode worth keeping: the gate now
`die`s, at pre-flight, before anything has been created, migrated or started, and the by-name branch
is gone with it. A hardened container without `/proc` is not a supported install for these scripts;
mount it and run again.

The ownership change itself is never `find … -exec chown`. For `LOG_DIR` it is `chown -Rh … .`
inside the entered root — coreutils walks with `fchownat(AT_SYMLINK_NOFOLLOW)` relative to
descriptors it holds. For `DATA_DIR`, which has two things to withhold and so cannot use `chown -R`
at all, it is `scripts/lib/chown-tree.mjs`, which descends by descriptor and does the same thing
(o3d-n8xx; see the publication bullet above for how it prunes — `locks/` by identity, staging
directories by shape rather than by name). `find -exec` enumerates pathnames
that are resolved again afterwards, and `-h` protects only the final component, so a descendant
directory swapped for a symlink in between would redirect the change — and on an upgrade the account
that can do that owns the tree and is still running, because section 8 precedes the `systemctl stop`
in section 10c.

Every `stat -c %F` in these scripts runs under `LC_ALL=C`, because coreutils **translates** those
file-type descriptions and every walk compares them against the English words.

**What this still does not cover**, stated rather than glossed: `logrotate` resolves
`/var/log/one-two-inventory/*.log` by pathname, as root, on its own schedule, and on a
group-writable `/var/log` that name is rebindable by the same account. That is a property of putting
logs in `/var/log` on Ubuntu and is shared with every package that ships a logrotate fragment; an
installer cannot pin it from here. `chmod +t /var/log` closes it host-wide — sticky means only an
entry's owner may rename or remove it — and is the recommended hardening if that account is in your
threat model.

**Upgrading an installation whose root IS a symlink.** The run stops at pre-flight, prints the
refusal above naming that root, and adds:

```text
ERROR: /var/lib/one-two-inventory — the state directory — is a symbolic link, so this run stops here rather than creating, entering, migrating into, rsyncing into or chowning whatever it resolves to. […] NOTHING has been created, nothing has been migrated and nothing has been started — this is the FIRST statement in the run that looks at /var/lib/one-two-inventory, so an existing installation is exactly as it was.
```

Nothing has changed on the host at that point — no user, no directory, no crontab, no migration —
so the installation you had is the installation you still have. Replace the link with a bind mount
by following “Putting a state root on another disk” above, then re-run `install.sh`. Your data does
not move: the bind exposes the same filesystem at the same path.

The **anchor** rule in the previous section (every directory from `/` down to the root owned by
root and carrying no group or other write bit) is *additional*, and applies only to the roots that
are **publication** roots — `APP_DIR`, `DATA_DIR` and the cutover/snapshot/CA directories. It is not
applied to `LOG_DIR`, and deliberately so: on Ubuntu `/var/log` is `drwxrwxr-x root:syslog`, which
the anchor refuses, and nothing is published under `/var/log`. The **symlink** rule is one rule for
all three, stated in one wording by one function.

Setting any of them in `APP_DIR/.env` does nothing: the application user owns that file, and since o3d-2sm1.5 r25 none of
the three entrypoints puts it into a shell's environment at all — each reads the handful of keys it
needs out of it by name, so an `IMS_*` line in it never becomes a variable anywhere. Until o3d-2sm1.5 `deploy.sh` kept its own set under
`/var/lib/ims-deploy` while the other two used the paths above, so following the banner after a
failed install ran `deploy.sh` against a namespace holding none of it: no marker to adopt, no
cron backup to reuse, and a fresh backup taken of an already-fenced crontab. Anything still at
the old paths is **imported** into the table above by the next run of any of the three, before
it adopts anything and before it touches a unit or a crontab. If both namespaces hold the same
artefact the run refuses rather than guesses — read both, keep the one that describes the
interrupted run, delete the other, and re-run.

**The marker is published, never rewritten in place.** It is written to a temporary file in the
same directory, `fsync`ed, renamed, and the directory `fsync`ed after the rename — so a power
cut leaves either the previous complete marker or the new one, never a truncated file. The last
line of a complete marker is `marker_complete=1`. A marker without it (a bare `touch`, or one
left by a version of these scripts that predates the sentinel) is read the conservative way:
the schema **may** have moved, so the connection fence is held and the run re-migrates, checks
drift and re-verifies before anything gets `CONNECT` back.

**The reboot-fence drop-in is published the same way** (o3d-2sm1.5). The marker is only the
condition; the `zz-deploy-fence.conf` drop-in carrying `AssertPathExists=!<marker>` is what makes
systemd honour it, so both have to be equally durable. It used to be written with a plain
redirection into a `mkdir -p`'d `<unit>.d`, then `daemon-reload`ed and verified — which proves
systemd can read it *now* and flushes nothing. Nothing between that write and the first
`systemctl stop` is a write barrier, so a power cut after `schema_touched` became durable and
before the drop-in reached the medium rebooted **without** the fence, and the old enabled unit
started against a partially migrated schema. It now goes through the same discipline as the
marker, plus one barrier the marker does not need: where the run creates the `<unit>.d`
directory, that directory's own entry is flushed before anything is written into it. A
publication that cannot be proven **fails the install**, which is before the phase becomes
`stopping` and before anything is stopped.

**The stop is recorded before it is asked for.** The marker says `phase=stopping` on disk
before the first `systemctl stop`, so a run killed across the stop is adopted as a run that
stopped something. Without that, adoption falls back to asking whether anything is still
serving — where an unrelated listener on the port counts as the predecessor, and the fences get
unwound over a service that had already been asked to stop.

`install.sh` did not, until o3d-2sm1.5: its order was stop → drain → migrate → verify → seed →
bootstrap → **build** → start, which inverts the founding premise of this whole order — everything
that can reject a release must reject it while the predecessor is still up — on the entrypoint this
page says follows the same sequence. A TypeScript error costs nothing on `deploy.sh`; there it left
the service stopped, cron fenced, the schema migrated and the connection fence held. The build now
runs before the stop. The **seed and the bootstrap deliberately did not move with it**: they are
not validations that can reject a release, they are writes, and they need the schema the migration
has just applied — running them before the stop would be new code writing to the old schema, the
exact overlap this order exists to prevent.

**Why the migration comes after the stop and not before it.** These scripts used to migrate
first and build second, which left the OLD version serving the MIGRATED schema for the whole
length of a build — minutes. Every safety argument of the form "the new code is what writes to
the new column" is false for that window. Two migrations measured what it costs:

- a refund-reversal witness column: the old binary keeps inserting rows without it, and its own
  retry then clears `accounting_retry_required`, which is the accounting invariant's only bound.
  Once that is cleared the row leaves every query that could find it again — unrecoverable.
- a shopping-sync discriminator column: the old binary still selects held sales invoices by an
  operator-typed payload field, so it can overwrite an already-stamped row. That case is neither
  repairable nor detectable — the migration's own verification queries return zero while the
  damage stands.

The second case is why quiescence cannot be a post-hoc check. Verification catches an old binary
that *created* rows; nothing catches one that *overwrote* them. Stopping the writer first is the
only defence. (o3d-2sm1.1)

**"Drained" means stopped, not idle.** The scripts stop, in order:

1. the application service (`systemctl stop`, so a `Restart=` policy cannot undo it);
2. any remaining process whose working directory is the app directory — matched by
   `/proc/<pid>/cwd`, so a second instance serving a different tree and a different database is
   never touched;
3. the cron entries in the service user's crontab. These are the easy ones to forget: nothing
   runs between ticks, so the box looks quiet, but each tick drives a queue worker (accounting
   sync, the WooCommerce webhook inbox, the WMS sweeper, refund reservation release). They are
   commented out for the window and restored **verbatim** from a backup once the new version has
   answered its health check;
4. anything else still connected — `scripts/check-db-writers.mjs` asks `pg_stat_activity`
   directly and refuses to migrate while any other client backend holds a connection. That is the
   check that catches the writer nobody enumerated.

**A snapshot is not a fence** (o3d-2sm1.2). Step 4 on its own closes its connection, and the dump
and the migration then open theirs; nothing stops a client connecting in the gap. So the scripts
first revoke `CONNECT` on the database from **every grantee that holds it directly** — the
application role, PUBLIC (the default database ACL grants it to PUBLIC, so revoking from the role
alone changes nothing) and any other role with a direct grant — for the length of the window
(`scripts/fence-db-connections.mjs --fence`), drain what is already attached, and only then take
the snapshot.

**The fence record is published before the `REVOKE`, and durably** (o3d-2sm1.5). The revoke is a
committed PostgreSQL transaction: it survives a power cut. `db-connect-fence.json` — the only
account of what was revoked and from whom — used to be a plain write whose return permitted that
transaction, so a power cut in between preserved the lock-out and lost the key. It is now written
to a temporary in the same directory, `fsync`ed, renamed and the directory `fsync`ed, all before
`BEGIN`; if any of that cannot be proven, **nothing is revoked** and the run aborts with exit 3.
The last field of a complete record is `"state_complete": 1`.

**The fence is TOLD which connection it is closing; it does not work it out** (o3d-2sm1.5 r19).

Seven rounds went into deciding *where the application connects* by reconstructing what its
runtime resolves. Each answer was locally correct and uncovered another layer beneath it:

| round | what it resolved through | what was wrong with it |
| --- | --- | --- |
| r13-r15 | this repo's own reading of `DATABASE_URL` | authority-versus-query precedence, `?user=` overriding the authority, repeated parameters |
| r16 | `pg`'s own **string parser** | a string parser is not a connection: `pg` fills `PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE` in for everything the URL omits |
| r17 | the driver's real client, in the **deploy shell's** environment | the application does not inherit the deploy shell — so the service's environment file was read instead |
| r18 | `systemctl show <unit>` | systemd answers for `Environment=` and **not** for the `EnvironmentFile=` layer, which then had to be refused on a mention of a name |
| r19 | — | and five more layers appeared: `PassEnvironment=`, `UnsetEnvironment=`, wildcard `EnvironmentFile=` globs, the `.env.development*` / `.env.test*` overlays Next loads in other modes, a unit with no `WorkingDirectory=`, and `DATABASE_URL`'s own precedence chain |

The count of blockers went 1 → 4 → 5. That is not an implementation problem: **the question has no
bounded answer**, because the composition rules belong to systemd, Next and libpq at once and any
of the three is free to add a layer.

So it is no longer asked. `scripts/fence-db-connections.mjs` **requires** four options —
`--app-host=`, `--app-port=`, `--app-user=` and `--app-database=` — on every mode, and **refuses**
without them (exit 3 for `--preflight`/`--fence`, which every entrypoint reads as "nothing was
revoked"; exit 1 otherwise). It is not run by hand: the entrypoints below pass them.

There is no environment reconstruction, no systemd interrogation, no dotenv scanning and no
precedence emulation left in the helper. **The operator types nothing new** — the calling scripts
supply the values:

* **`scripts/install.sh` owns them.** It prompts for `DB_HOST`, `DB_PORT`, `DB_NAME` and `DB_USER`,
  creates the role and the database with them, and composes `DATABASE_URL` out of them. It passes
  those same variables; nothing is parsed anywhere. Reached before the database exists (an exit
  trap on an early failure), the values are still empty and the fence is **refused**;
* **`scripts/update.sh` and `scripts/deploy.sh` split them out of `DATABASE_URL`** — the file they
  already read it from — with a strict reader (`resolve_db_identity`,
  the same twenty lines in both) that **accepts only a URL stating all four**. No port, no path,
  more than one path segment, a `?host=`/`?port=`/`?user=`/`?dbname=`/`?database=` query
  parameter, a percent-escape **anywhere in the query string**, whitespace: each one is a
  **refusal** that stops the run before anything is stopped or migrated. Never a default.
  The query-string rule is deliberately blunt because the driver decodes query **keys**:
  measured against the installed `pg-connection-string`, `?ho%73t=other-cluster` arrives as
  `host=other-cluster`, `?po%72t=6543` as `port=6543` and `?u%73er=other` as `user=other`, none of
  which a scan for the literal names catches. Decoding it here to compare properly is the
  reimplementation this reader exists to avoid, so an escape in a *harmless* parameter is refused
  too — telling the two apart is the thing that cannot be done without decoding. Write the query
  plainly. In particular the libpq unix-socket spelling
  `postgres://role@/db?host=/var/run/postgresql` is **refused** here — it states neither host nor
  port in its authority and puts the host in the query string, which is the one shape this reader
  will not accept. Nothing this repo ships composes that form (`install.sh` and `.env.example`
  both write `host:port`); an installation that uses it must give `DATABASE_URL` an explicit
  `host:port`, or run `deploy.sh --skip-migrate`.

**And the strictness is what closes the question rather than narrowing it.** `PGHOST`, `PGPORT`,
`PGUSER` and `PGDATABASE` are consulted by libpq and by `pg` *only* for values the connection
string leaves out. A URL that states all four cannot be moved by any of them, in any process,
under any of the three composition systems above — so for exactly the URLs the callers accept, the
whole environment question has no bearing on the answer, and for every other URL there is a
refusal in place of a guess.

If your `DATABASE_URL` does not state all four, write it as
`postgresql://ROLE:PASSWORD@HOST:PORT/DATABASE`. A `deploy.sh` run that only needs no schema
change can also use `--skip-migrate`, which moves nothing and needs no fence.

**And the file it is read from must be the file the service uses.** Supplying the identity out of
`APP_DIR/.env` is only worth anything if that file is what gives the *service* its `DATABASE_URL`,
and systemd can put a different one there: `Environment=DATABASE_URL=`, a drop-in that adds one,
`PassEnvironment=`, `UnsetEnvironment=`, or a second `EnvironmentFile=`. dotenv does not overwrite
a variable that is already set, so the fence, the migration and the release would all agree with
each other about the `.env` database while the restarted application connects somewhere else — a
migration on a database nothing fenced, and a new build on a database nothing migrated.

So `deploy.sh` and `update.sh` ask systemd **one existence question about one variable** before
they fence, preflight or re-fence — *can anything other than the file we read define
`DATABASE_URL` for this unit?* — reading `LoadState`, `Environment`, `EnvironmentFiles`,
`PassEnvironment`, `UnsetEnvironment` and `PAMName` **over systemd's own bus** (`busctl
get-property`, which ships beside `systemctl`), all of them reported **composed**, with every
drop-in already folded in. This is not the environment reconstruction the helper lost: no value is
computed and no precedence is resolved. Which of several definitions would *win* is the unbounded
question and is never asked. Any answer but "only that file" is a **refusal** naming what else
defines it:

* an element of the unit's `Environment=`, `PassEnvironment=` or `UnsetEnvironment=` whose **name**
  — everything before its first `=` — is `DATABASE_URL`. `UnsetEnvironment=` takes *"a
  space-separated list of variable names or variable assignments"* and is applied as the **final**
  step of composing the environment, so `UnsetEnvironment=DATABASE_URL=<the value in the .env>` is
  the same refusal as the bare name: it removes what the file supplied and leaves the application's
  own dotenv loader to replace it;
* **any second `EnvironmentFile=`** — refused *without being read*, because that it may define the
  variable is enough, and reading it to find out puts the precedence question straight back. The
  one exception is the run's **own environment snapshot**, described below: refused unless *this*
  run published it, unless it is the snapshot's exact path, unless it is **last**, and unless it is
  loaded without a leading `-`. A **third** file is refused by count, as before;
* a non-empty **`PAMName=`**. `systemd.exec` lists the variables PAM modules set *after* the
  `EnvironmentFile=` layer and says the later source wins, so a unit naming a PAM profile whose
  stack runs `pam_env` can be handed a different `DATABASE_URL` while every other property still
  says "only that file". What a PAM stack supplies is not knowable without reading PAM
  configuration, so any value at all is refused rather than read;
* a unit that loads **no** environment file, because the variable would then reach the application
  through its own dotenv loader, by Next's rules (`.env.local`, the per-mode overlays) rather than
  systemd's. Add `EnvironmentFile=` for the app's `.env`, which is what `install.sh` writes;
* a unit systemd reports as anything but `loaded`, a host with no `busctl`, or no unit at all.

**It is read from the bus and not from `systemctl show`'s text** (o3d-2sm1.5 r21). `systemctl show`
renders a property as one `Name=` line of space-joined values, so where one element of an array
ends and the next begins has to be guessed at — and `EnvironmentFiles` is an array of *(path,
ignore_errors)* pairs. `busctl` states the property's signature and the array's **own element
count** before the elements — `a(sb) 1 "/opt/app/.env" true`, `as 0`, `s ""` — so "is there more
than one environment file?" is answered by systemd's data structure rather than by counting
separators. The stated count is checked against the elements found, a disagreement is a refusal,
and a string systemd had to escape (`busctl` prints through `cescape()`) is refused rather than
decoded.

`install.sh` **was exempt and is not any more** (o3d-2sm1.5 r23). It still owns the four values and
still parses nothing — its identity is the shell value it composed, and it re-checks that value
against the file by string comparison rather than by re-parsing it. But the reasoning that it "has
no file to be wrong about" stopped being true at the line where it **writes** `APP_DIR/.env`, long
before the build, the migration and the start of a unit that loads that file at exec. It now asks
systemd the same bus question about the unit it has just written, after its own `daemon-reload` and
before `systemctl start` (r24 split the old `enable --now`: the enable happens before the reload,
because it reloads implicitly).

### The environment snapshot: binding, not checking (o3d-2sm1.5 r23)

Rounds 13-22 asked *which database will the running service use* eleven ways, and every answer was
correct and incomplete for the same reason: it was a **read** of a file systemd reads later, at
exec, and that something else can replace in between. Round 22 moved the last read to the last line
before `systemctl start`; that shortens the window and does not close it. The timestamp, the
`unmask`, the logging and the earlier units in the start loop all execute after the check and
before the exec — and the `unmask` among them reloads systemd, so it did not merely lengthen the
window, it invalidated the check (see r24 below).

So the last round stops checking and **binds**. Immediately before the connection fence comes down,
and with it still held, each entrypoint:

1. writes the `DATABASE_URL` it fenced and migrated with to
   `/etc/ims-cutover/db-identity-snapshot.env` — a **root-owned, 0700** directory and a 0600 file,
   deliberately **not** under the cutover state directory, which the application user owns and
   could therefore rewrite. systemd reads `EnvironmentFile=` as PID 1, before it drops to `User=`,
   so the service never needs to read it. The value is written **single-quoted**, the one form
   `systemd.exec` documents as verbatim, so the deploy's reader and systemd's reader cannot
   disagree about a password containing a backslash or a `#`. A value carrying a single quote has
   no verbatim spelling and is **refused**;
2. gives every unit a `zz-deploy-db-identity.conf` drop-in that loads that file. `systemd.exec`:
   *"If the same variable is set twice from these files, the files will be read in the order they
   are specified and the later setting will override the earlier setting"*, and *"Settings from
   these files override settings made with `Environment=`"*. The `zz-` prefix puts it last. So
   whatever `APP_DIR/.env` has come to say by exec time, `DATABASE_URL` is the snapshot's;
3. loads it with **no leading `-`**. A missing snapshot is then a **start failure**, not a silent
   fall-through to the application's own dotenv overlays — the difference that made a *deleted*
   `.env` dangerous, since the shipped units load that one with a `-`;
4. asks the bus, after this run's final `daemon-reload`, that the loaded configuration really does
   name the snapshot, last and mandatory, and that nothing else defines the variable.

**Why that closes a race a re-read could not.** Two systemd reads are involved and they have
different timing. The **set** of environment files is unit *configuration*, fixed at
`daemon-reload` and **not** re-read by `systemctl start`; the **contents** are read at exec. The
run issues the final reload itself, verifies the loaded list after it, and nothing between that
verification and the start runs a unit-file command at all — so the list cannot move under it. The
contents can be changed only by root.

**And that sentence only became true in r24.** `systemctl unmask` and `systemctl enable` reload
the daemon *implicitly* unless they are given `--no-reload` (`systemctl(1)`: *"When used with
enable, disable, preset, mask, or unmask, do not implicitly reload daemon configuration after
executing the changes"*). `deploy.sh` unmasked inside its start loop, `update.sh` on the line above
its start, and `install.sh` started the service with `enable --now` — so all three re-read every
unit file and drop-in on disk **after** the verification above, once per unit, with the remaining
units still to start. The argument was sound about *explicit* reloads and blind to the implicit
one. Every unmask and enable now happens **before** the final `daemon-reload`, and the only
`systemctl` verb left after the proof is `start`, which acts on the loaded configuration and does
not re-read unit files. Reordered rather than flagged `--no-reload`, so the invariant does not
depend on every future caller remembering a flag.

**The snapshot directory is a literal, not a setting.** It was
`${IMS_CUTOVER_ENV_DIR:-/etc/ims-cutover}` until r24, and `update.sh` loaded `APP_DIR/.env` as
root — with `source`, until r25 — *before* it resolved that — so the variable choosing where the root-protected snapshot went
was one the **application user writes**, which is the whole boundary the location exists to draw.
There is no configurable spelling of it that is safe: an override only a root-owned source may set
is indistinguishable from no override. Move it by editing `DB_ENV_SNAPSHOT_DIR` at the top of all
three entrypoints. r24 followed that reasoning to a capture-and-restore: `update.sh` snapshotted
every `IMS_*` deploy-control variable from the **root invocation's** environment before it sourced
`.env` and put them back verbatim afterwards.

**r25 removed the reason there was anything to restore.** `update.sh` `source`d two
application-owned files as root — `APP_DIR/.env` and `APP_DIR/.deploy-meta` — and `source`
*executes* a file. A `$(…)` in an ordinary-looking assignment, a bare command on a line of its
own, a redefinition of one of the script's own functions, or an assignment to `SERVICE_UNIT`,
`APP_DIR` or `DEPLOY_META_FILE` (none of which the restore covered) all ran **as root, before the
restore**, so an application-account compromise reached root on the next update and the restore
was no boundary at all.

Both `source` calls are gone. `update.sh` now reads the six names it needs out of the two files
by name, with the same non-evaluating dotenv reader `install.sh` and `deploy.sh` have always used
— `DATABASE_URL` and `APP_PORT` from `.env` (the admin credential is **not** read from it: see [Database identities](#database-identities)); `GIT_REPO_URL`,
`GIT_BRANCH` and `GIT_DEPLOY_KEY_ENABLED` from `.deploy-meta`. A line the reader is not asked for is never looked
at, and a line it is asked for becomes a string and nothing else. The `set -a` that exported the
whole of `.env` into the update shell and every child process went with it: every child that
touches the database is handed its connection explicitly, and the build reads `APP_DIR/.env`
itself through Next's own loader. The r24 capture-and-restore was **removed** rather than kept
alongside — with nothing sourced, `IMS_*` can only come from the root invocation, and two
mechanisms for one property are two things to keep true.

**r26: `APP_PORT` was the reader that was still there.** r25 claimed one reader and shipped two.
The health check kept its own `grep "^APP_PORT=" .env | cut -d= -f2`, which is wrong on values
dotenv accepts and the service resolves correctly — `APP_PORT="3000"` keeps its quotes,
`APP_PORT=3000  # internal` keeps the comment and then word-splits the `curl` arguments,
`export APP_PORT=3000` is not matched at all, a key defined twice takes the *first* line where
dotenv takes the last, and an absent key produced an **empty** value rather than the `3000` the
`|| echo "3000"` implies (a pipeline's status is `cut`'s, and `cut` succeeds on empty input). Any
of those makes the poll target a URL nothing serves: the service is up and healthy, the poll times
out after 60s, and `update.sh` then stops the service it has just started and re-establishes the
post-migration fences. A supported `.env` value turned a successful update into an outage.

`APP_PORT` is now read through the same reader, in the **preflight**. r26 also *validated* it
there and made the value the port the health check polls; **r27 changed both of those** — see
below — but `valid_tcp_port()` remains a function all three entrypoints carry identically and all
three apply to every port they would build a health URL out of (`install.sh` to the value it
prompts for and writes into the unit, the nginx upstream and the cron base URL; `deploy.sh` to
`IMS_PORT`; `update.sh` to `IMS_APP_PORT` and to each candidate it reads out of the unit).

The guard behind the single-reader claim changed shape too. r25's recognised a read only when it
was written `NAME="$(…)"`, which is why one unquoted assignment survived five rounds of review.
It now **enumerates every non-comment line in all three entrypoints that names an
application-owned file** and requires each to match one declared shape — the reader, a file-shape
test, a path assignment, `install.sh`'s own writes, `install.sh`'s raw round-trip snapshot of the
previous `.env` for re-run prompt defaults (the one other declared reader, kept raw on purpose so
the bytes it writes back are the bytes it read), or operator-facing text. Anything else fails the
build, printing the line.

**r27: a well-formed `APP_PORT` still pointed wherever the application wanted.** r26 made the
value *well-formed*. It did not make it *trustworthy*, and those are different properties.
`APP_DIR/.env` is **application-writable**, and nothing in it starts the service: `install.sh`
embeds the port **literally** in the unit it generates (`ExecStart=… next start -p <port>`), and
the units on a stage box pin `Environment=PORT=` as well. Editing `.env` moves neither. So a
perfectly valid `APP_PORT` could aim the listener probe, the 60s health poll *and* the build-id
proof at a port the service never binds — where they find nothing (a healthy new deployment
stopped and re-fenced over a port that was never the service's), or, worse, find **something
else**: any other responder serves the application-controlled `/_next/static/<BUILD_ID>/` assets
just as well, so the build-id proof would confirm an unrelated process and carry the run past its
point of no return. On this host that is not hypothetical — the full-chain e2e rig answers on
`:3002` from a tree built out of the same repository.

So `.env` no longer decides it. The port the health check polls now comes from, in order:

* `IMS_APP_PORT` on the **root invocation** — the one input to `update.sh` the application cannot
  write, the same standing `IMS_APP_DIR` and `IMS_SERVICE_UNIT` already have; then
* the service unit's **own loaded configuration**, asked of systemd's bus through the same three
  rendering helpers the `DATABASE_URL` question uses. Both directives that can pin a port are
  read — `Environment=PORT=<n>` and an `ExecStart=` carrying `-p`/`--port` — and when the two
  **disagree** the run refuses rather than working out which one wins, for the same reason a
  second `EnvironmentFile=` is refused without being read.

There is no third source and no default. A guessed `3000` for a service listening on `8080` polls
a URL nothing serves just as surely as a malformed value does, and does it silently.

`.env`'s `APP_PORT` is still **read**, through the one reader, and it is now a **claim that is
checked**: `install.sh` writes it beside the unit it generates from the same value, so a value
disagreeing with the unit means the two records of one fact have drifted and the next person to
read the file will be misled. That is a refusal, not a silent choice of winner. A malformed value
is refused for the same reason. Deleting the line is always allowed — it decides nothing.

**And the socket is tied to the service.** Knowing the right port is half the question; a health
check that proves only that *something* answered is not a check. Once `/api/health` responds,
`update.sh` asks who is holding the socket, by both of the routes `deploy.sh`'s dev path uses:
every pid `ss -ltnp` attributes the listening socket to must be inside `SERVICE_UNIT`'s **control
group** (systemd tears that down on stop, so a process that survived the stop cannot be in the one
the new start created) **or** a descendant of the unit's current **MainPID**. Any pid on the port
that answers to neither fails the whole proof — "one of them is ours" is not an answer to "which
process did the health check reach" — and it fails while the teardown window is still open, so the
run is stopped and re-fenced rather than reported as a success. Verified read-only against this
host's real units: with `SERVICE_UNIT=ims-stage-dev.service` the proof accepts `:3000` (the
listener is the `next-server` grandchild of the unit's `MainPID`) and refuses `:3002`.

**r27: and the refusal moved to a point where refusing is safe.** r26 put the fatal port check on
the line that read the value — during **top-level initialisation**, which is before the `EXIT`
trap is installed, before the cutover lock is acquired and before an existing fence marker is
adopted. Its message said "nothing has been stopped and nothing has been migrated", and on a
**recovery** run that was false: a predecessor may already have stopped the service or begun
migrating, and re-stopping it, re-establishing and verifying the reboot fence, confirming the cron
fence and adopting or releasing the connection fence is precisely what the re-run exists to do. A
malformed value in an application-owned file could make the run walk away from all of it —
prolonging an outage, or leaving a failed re-fence unrepaired.

The value is still read early, because this script has one reader and that is where its reads
live. The **refusal** is now immediately after the fence adoption: the cutover lock is held, an
existing marker has been adopted in full (the service re-stopped and both fences re-established
and verified, or an interrupted arming completely unwound), and nothing new has been pulled,
built, stopped, fenced or migrated. Everything that costs something is still ahead, and the exit
trap is installed and knows which phase this is. Refusing safely means refusing at a point where
the refusal leaves the system **consistent**, and that is the point.

**r27: the declared-shape guard was matching fragments.** r26's enumeration was right and its
matching was not: it classified a line if a shape appeared **anywhere** on it, so
`[[ -f "${APP_DIR}/.env" ]] && bash "${APP_DIR}/.env"` passed as "a file-shape test",
`echo "$(bash "${APP_DIR}/.env")"` passed as "operator-facing text", a `grep` reader passed by
appending `# env_file_value` as an inline comment, and `$APP_DIR/.env` without braces was not
seen at all. Matching is now two stages and a line must survive both: a **hazard** scan
(substitutions, backticks, interpreters, process substitutions, input redirects — the ones that
act inside double quotes are matched against the whole line, the rest against the line with its
quoted strings removed, so prose containing the word "exec" is not condemned) and a **shape** scan
anchored `^…$` to the entire trimmed line, so a shape can no longer be a fragment of a compound
command and an inline comment is part of the line rather than something read past. Every bypass
listed above is a test case that must come back rejected.

That hazard scan found a real one on its first run: two `die` messages contained an unescaped
`` `systemctl start` ``, inside double quotes, which bash **executes** while composing the text.
Both are now escaped.

**r28: `Environment=PORT=` is a directive, and a directive is not the composed environment.** r27
read the unit's `Environment=PORT=` and called it authoritative. In the same file, four hundred
lines above, `DATABASE_URL` had already established why that is not enough: systemd applies
`EnvironmentFile=` **after** `Environment=`, a `zz-` drop-in's `EnvironmentFile=` lands last of
all, `UnsetEnvironment=` is applied as the final composition step, and a PAM stack under
`PAMName=` runs later still. A unit with `Environment=PORT=3000`, an `EnvironmentFile=-` naming
the application's own dotenv file and no CLI flag binds whatever `PORT` **the application writes
into that file** — and the `APP_PORT` cross-check cannot see it, because the name in the file
would be `PORT` and not `APP_PORT`. The doctrine had been written for one variable and applied to
one variable.

So there is now **one mechanism, told which variable to ask about**. The sole-source scan takes
the variable name and the **layer** that is allowed to answer for it:

* `file` — the environment file named is the only permitted definition, and an `Environment=`
  directive competes with it. This is how the connection identity asks, unchanged;
* `directive` — the unit's own `Environment=` is the permitted definition and **no environment
  file may be loaded at all**, because every one of them is composed later and none of them is
  read (reading one would put the precedence question straight back). This is how the port asks.

On the installed unit that means a port pinned **only** in `Environment=` is refused outright,
naming the file that could move it: the unit loads `APP_DIR/.env`. `install.sh` writes the port
literally into `ExecStart=` (`next start -p <port>`), which is the one pin nothing composed later
can reach, so a supported installation is unaffected. Verified read-only against this host's real
units: `ims-stage-dev.service` and `ims-e2e-dev.service` both pin `Environment=PORT=` **and** load
an `EnvironmentFile=-` with `ignore_errors=yes`, and both still resolve — to 3000 and 3002 — from
their `ExecStart=` flags. With the flag removed, both would now be refused, which is the correct
answer for them. Nothing else in the three entrypoints reads `Environment=`: `deploy.sh` takes its
port from `IMS_PORT` on the root invocation and `install.sh` writes the unit rather than reading
one, so `PORT` was the only value read from a directive with the old assumption.

**r28: deleting `.env` bypassed fence adoption too.** The `APP_DIR`/`.env` existence-and-shape
refusal was the same misplaced-refusal shape r27 had just moved for the port, two lines above it:
`[[ -f "${APP_DIR}/.env" ]] || die` ran during top-level initialisation — before the `EXIT` trap,
before the cutover lock and before marker adoption — and refused on a path the **application user
owns**. After an interrupted migration that account could delete the file, or replace it with a
directory or a dangling symlink, and the recovery run walked out: service left stopped, reboot
fence left standing, crontab left commented out, connection fence left un-adopted, and no trap
installed to say any of it.

The shape is now **read** where it always was, deciding nothing, and refused at a **layout gate**
beside the port gate — after adoption has re-stopped the service, re-established and verified both
fences and held or released the connection fence on the marker's own record. Every other fatal
exit ahead of the adoption was re-read for the same shape and none of the rest is misplaced: the
`Run as root` refusal is about the invocation rather than about anything the application can
write (and a non-root run could not adopt a fence in any case), and the refusals inside the
cutover lock and the state-directory creation are the lock itself and the directory the fence
state lives in — without either, adoption is not possible at all, so refusing there is not
abandoning. Everything else already sat after the adoption.

**r28: a listening socket with no PID attribution is an unknown, not an absence.** The reader
behind the socket proof was one pipeline: select the rows `ss -ltnp` prints for the port, then
`grep -oE 'pid=[0-9]+'` them — which **silently drops** a row it cannot attribute. With
`SO_REUSEPORT` several sockets can be bound to the same port and the kernel hands an incoming
connection to one of them, so a box holding two — one the unit's, one a process whose owner the
root shell cannot see — produced a pid list containing **only the trusted holder**. Every pid in
it then verified against the unit, the proof passed, and the health request that decides the point
of no return could have been answered by the other socket. The existing empty-list refusal never
fired, because the list was not empty: it covered only the case where *every* row was
unattributable. The rows are now counted, the unattributable ones counted separately, and the
proof refuses on that count **before** it verifies any pid.

**r28: the operator-message shape admitted a compound command.** The declared shape for
operator-facing text ended in `.*`, and `.*` is not a grammar — it consumes a command separator
and everything after it. `echo safe; dash "${APP_DIR}/.env"` classified as operator-facing text
while executing an application-owned file **as root**, and so did
`warn "checked" && tclsh "${APP_DIR}/.deploy-meta"`. Neither carries a hazard, because no finite
list of interpreter names can be complete. The shape now describes **exactly one simple command**
whose arguments are quoted strings, short options or bare variable expansions; a separator is none
of those, and the `^…$` anchoring does the rest. All three compound cases are in the bypass list
that must come back rejected.

**r29: the adoption still depended on the file whose loss it recovers from.** r28 moved the `.env`
refusal below the fence adoption, which was necessary and not sufficient. With the file deleted,
initialisation leaves `DATABASE_URL` empty, so the four identity values are empty — and
`adopt_db_connections()` reached `fence_db_connections()` only to die on *"the application's
connection identity could not be read"*. The refusal was in the right place; the adoption itself
still needed the missing file. The service and reboot fences were restored and the standing
**database** fence was neither re-applied nor re-drained, contradicting the message telling the
operator it had been adopted.

A recovery path may not depend on the thing whose loss it recovers from. Three inputs, and who
owns each:

* **the four identity values** — read out of `DATABASE_URL` in `APP_DIR/.env`, application-owned;
* **the fence script** — `APP_DIR/scripts/fence-db-connections.mjs`, application-owned. Deleting
  that one file turned every fence, every release, every adoption *and the exit trap's re-fence*
  into a refusal;
* **`DEPLOY_ADMIN_DATABASE_URL`** — a password, so no record may hold it.

The first two are now recorded when a fence is **raised**, in `/etc/ims-cutover-recovery`: a
`db-fence-identity.env` stating `db_app_host`, `db_app_port`, `db_app_user`, `db_app_database` and
`fence_script_sha256`, ending in a `fence_identity_complete=1` sentinel, and the fence script
published beside it. The record is written **before the revoke**, for the same reason
`schema_touched` is written before Prisma is invoked: a record written after the durable act does
not exist on the one run that matters, the one killed in between. A record short of the values it
can vouch for is a **refusal**, never a default: a half-read identity is a different database.

**r30: a trusted source consulted only when the untrusted one fails is not a trust boundary.** r29
published both artefacts and then used each of them only as a *fallback*, when the
application-owned version could not be read. That defends against **deletion** and not against
**substitution** — the account this recovers from does not need to remove its file, it needs to
supply one that works. A legitimate touched-schema fence on database A could be "recovered" by an
`APP_DIR/.env` replaced with a valid, internally consistent identity for database B: A stayed
fenced and abandoned while B was re-fenced and migrated, and the sole-source and drift checks did
not help, because all they prove is that the replacement agrees with itself. The same for the
script: `APP_DIR/scripts/fence-db-connections.mjs` could be **replaced** rather than deleted, and
attacker-controlled code would then be handed `DEPLOY_ADMIN_DATABASE_URL` — including inside the
exit trap's re-fence, the path that runs when everything else has already gone wrong.

So the precedence is inverted, and it is one rule for every privileged artefact:

| artefact | which source decides | `APP_DIR/.env` / the checkout |
| --- | --- | --- |
| the four identity values | `db-fence-identity.env` whenever it exists | read only to be **compared**; a mismatch is a refusal at **both** adoption call sites |
| the fence script **and its imports** | `/etc/ims-cutover-recovery/app/`, a root-owned, wholly digested tree, and the only thing **executed** — since o3d-xi3w that name is a symbolic link into the versioned directory one publication commits | published into the protected path **once**, never run in place, and its dependency closure copied rather than linked — see r31 and r32 below |
| `DEPLOY_ADMIN_DATABASE_URL` | the **root invocation**, then the **root credential file** `/etc/ims-db-admin/deploy-admin.env` | **never consulted**: a copy left in it is refused before anything is stopped (owner decision C3, see [Database identities](#database-identities)) |
| the environment snapshot | the root-owned `zz-` drop-in, which systemd loads **last** | overridden by it for the length of one cutover |
| the fence state file | the database itself, cross-checked against the record | app-writable by necessity — `--fence` refuses to re-apply a state whose `database` is not the one the connection is attached to |

The record's digest **binds** the protected copy to the fence it recorded, which is also why the
initial fence publishes the script and then runs *that published copy*: r29 copied the script and
then executed the original, so the protected copy was not guaranteed to be the code that wrote the
state file. An **adoption never rewrites the record** — the record describes the fence on the
database, not this run's opinion of it, and only the run that *raises* a fence may write one.

The one case where the checkout still decides is the one the application account cannot
manufacture: `/etc/ims-cutover-recovery` is root-owned, so "no record and no protected copy" means
no fence these scripts ever recorded. There is nothing to be substituted *for*, and the checkout's
script is published into the protected path and run from there — never in place.

The directory is root-owned and **0755**, not the snapshot directory's 0700, because the object-access
check (an application-account step) reads the application role out of the state record and
neither file holds a secret. The fence itself runs **as root** since owner decision C3, so nothing
needs the application account to be able to release or write the record, and it can do neither. It is a **literal**, for the same reason `DB_ENV_SNAPSHOT_DIR` is. It is
deliberately **not** the fence marker: `CUTOVER_STATE_DIR` is the application's own data directory
and therefore writable by the application user, so putting the identity there would hand the
account this recovers *from* the ability to aim the recovery re-fence at a database of its
choosing.

### r31: substitution at *write*, and the three entrypoints that never resolved at all

r29 closed **deletion**. r30 closed **substitution at read** — the protected copy wins whenever it
exists. Neither closed **substitution at write**. The publication step went on taking whatever was
in `APP_DIR/scripts/fence-db-connections.mjs` and promoting it into the protected path on *every*
fence, so the account being defended against supplied the trusted artefact: replace the checkout's
helper between the preflight and the fence, root publishes the replacement, and the
`fence_script_sha256` recorded beside it is computed from those same bytes. A digest taken from the
thing it is meant to authenticate proves self-consistency and nothing else.

And r30 only ever changed `update.sh`. `deploy.sh` and `install.sh` passed
`DEPLOY_ADMIN_DATABASE_URL` straight to the checkout's helper — preflight, fence,
`--print-migration-url`, release and the exit trap's re-fence — which is not merely an unprotected
path but one that hands an **administrative database credential** to code the application account
controls.

**The rule.** An existing protected copy is **never overwritten from the checkout**. Three states,
and nothing else:

| state | what happens |
| --- | --- |
| no protected copy yet | the checkout's helper **and its resolved dependency closure** are staged into the root-owned directory and published there — **only when something authenticated them**. From an application-writable checkout that means `IMS_FENCE_ARTEFACT_SHA256`, which ships with the release; without it the bootstrap is **refused**, and the refusal prints every route to the value it wants. `IMS_FENCE_SCRIPT_SHA256` **on its own is refused here** too: see below. r33 published here with a `TRUST ON FIRST USE` warning and r34 removed that — a warning nobody has to acknowledge is not a control over bytes that get handed an administrative credential. |
| a protected copy, no expected digest | the protected copy is used unchanged. A checkout that **differs** is reported — both digests, and the invocation that would adopt it, which since r33 names **both** pins because a rotation republishes the closure too — and **not** promoted. |
| a protected copy and an expected digest | an authenticated rotation (below). |

**And a fourth case that is not a state of the artefact at all: a FIRST INSTALL.** `install.sh` on
a box with no service, no crontab, no PM2 instance and no process in the application directory
**and a database this run created itself** fences nothing — there is no writer to stop — so it
never reaches the table above by needing to *execute* the helper. `resolve_fence_script()` refuses
outright on that path. A run that cannot prove it created the database is **not** in this case: it
takes the ordinary cutover path and everything in the table applies to it. It reaches the first row
only when the operator supplies `IMS_FENCE_ARTEFACT_SHA256`, in which case it **publishes** the
artefact before the migration (a read and a copy by root; nothing is executed) so the first upgrade
has one standing. `IMS_FENCE_SCRIPT_SHA256` alone is refused at the entrypoint, before anything is
staged — see [the first-install pin contract](#first-install-pin-contract). With no pin it
publishes nothing and says so, and the pin is required at the first upgrade instead. See
[The Install Script](#the-install-script).

Divergence **warns rather than refuses** deliberately. Refusing would hand the application account
a denial of service on every future cutover — write one byte into a file it owns and no deploy runs
again — which trades a credential-theft path for an availability path the same account controls.
The protected copy is root-owned and was itself shipped by this repository, so running it is safe;
running it *stale* is the risk, and a helper whose argument contract has moved fails **closed** at
the fence rather than silently.

**What a legitimate upgrade looks like.** The expected digest is an input to the *privileged
invocation*:

```bash
# as root, from the release being deployed — fetched as root into a new directory (o3d-z5be r5/r6)
IMS_FENCE_SCRIPT_SHA256=<digest of the release's entry file> \
IMS_FENCE_ARTEFACT_SHA256=<digest of the whole artefact tree> \
  bash /path/to/release/scripts/update.sh
```

**Both, from an application-writable checkout — and that is what the script-only pin now means.**
`IMS_FENCE_SCRIPT_SHA256` authenticates the **entry file**, which is roughly a tenth of what runs:
the artefact also vendors the helper's dependency closure out of `APP_DIR/node_modules`, and the
account that owns that directory can leave the legitimate helper untouched, replace one file inside
`pg`, and have those bytes sealed, digested and recorded as the trusted artefact. `pg` is imported
*before* `main()`, so it can report a fence that was never raised. So the entry-file pin is
sufficient **by itself only when the source the closure is assembled from is already one nobody
else can write** — every path the vendoring reads owned by the publishing account (root) and
writable by no one else. From an application-writable checkout — which is every ordinary
deployment — it is **refused as insufficient**, naming `IMS_FENCE_ARTEFACT_SHA256` and three ways
to obtain it, rather than publishing an unauthenticated closure under a pin that reads like
authorisation. It is *not* refused where nothing would be published: a pin that already matches the
standing copy is still "nothing to rotate".

<a id="artefact-digest-first-install"></a>
**Where the whole-tree digest comes from, including on a first-ever install.** Since r34 this is a
**required input**, not a hardening, so it needs an answer that does not assume a previous
deployment. There are three sources and they are not interchangeable:

1. **The release publishes it.** The release is built on a host that is not the target: a clean
   checkout of the tag, `npm ci`, then

   ```bash
   bash scripts/update.sh --print-fence-digest
   ```

   which assembles exactly the tree a publication would record, hashes it, and prints

   ```text
   THE FENCE ARTEFACT THIS CHECKOUT WOULD PUBLISH HASHES TO <64 hex>
   ```

   It **writes nothing outside its own throwaway and executes no part of the tree** — the digest
   is computed by reading bytes, not by running them.

   **That mode exists because a release build host is not a deployment.** It resolves the tree
   from the checkout the command was typed out of, and it runs immediately after the fence
   library is sourced — **before** the installation gate, the `.env` reads, the service-port
   gate, the database checks and every fence gate. So it needs no application directory, no
   `.env`, no service unit, no port, no `DEPLOY_ADMIN_DATABASE_URL`, no database, no standing
   artefact and **no root**. `--dry-run` cannot stand in for it: `APP_DIR` defaults to the
   installation directory, which a clean release checkout does not have, and the dry run refuses
   at the layout gate before it reaches its own digest print. That value is published with the
   release checksums, and it is what the operator passes as `IMS_FENCE_ARTEFACT_SHA256` on every
   target that needs one.
2. **A host that has already published this release.**
   `grep '^fence_artefact_sha256=' /etc/ims-cutover-recovery/app/../db-fence-artefact.sha256` there.
3. **`--print-fence-digest` or `--dry-run` on the target itself — for comparison only.** Either
   prints the same line, assembled
   from the checkout under question, so it can **confirm** the release's value and can never stand
   in for one. Every refusal that reports a digest labels it **reported and not authenticated** for
   the same reason.

**And the route that needs no digest at all:** bootstrap from a source nobody but root has ever
written — every path the vendoring reads, and every directory from the application directory up to `/`,
created by root rather than relabelled (see *[The supported bootstrap](#supported-bootstrap)* for why a
`chown`/`chmod` of an existing tree does not qualify, and why no check can tell the difference) — and the
provenance question answers itself, so an unpinned publication is accepted. This is the "root-owned authenticated release
source" option; it is the right shape for an image-built or configuration-managed box, and the
wrong one for a checkout the application account deploys into.

The digest comes **from the release and not from the box** — `git show <tag>:scripts/fence-db-connections.mjs | sha256sum`
run somewhere that is *not* the machine being deployed, or the checksum published with the release.
Deriving it on the target would authenticate the checkout against itself, and nothing computed from
`APP_DIR` can authenticate `APP_DIR`. (That command is given inline rather than as a copy-pasteable
block on purpose: it is a step for a workstation, not for the machine mid-cutover.)
The **whole artefact** — the entry file and the vendored dependency closure — is then assembled in a
directory of that publication's own, `/etc/ims-cutover-recovery/.publish-fence.<pid>.<rand>`, which only
root can write; it is sealed (ownership and modes), checked (nothing but regular files and directories),
digested **from that staged tree**, given its digest record and manifest *inside* that directory, made
durable, renamed to `.version-fence.<pid>.<rand>`, and committed by flipping one symbolic link —
`/etc/ims-cutover-recovery/app` — onto it with a single `rename(2)`. The tree that was verified is the
tree that is published, and the checkout is never read again after the copy. **One name per run and one
rename to commit** is what closed o3d-xi3w: the staging and retirement names used to be one per *kind*, so
a second privileged run could empty and refill the first run's staging tree between the instant it
assembled it and the instant it hashed it (measured: a run that had matched `IMS_FENCE_SCRIPT_SHA256`
against its own entry file published the other run's, and recorded the digest of the one it had checked);
and the previous sequence moved the standing tree aside *before* renaming the new one in, so the
documented name did not exist in between — and `mv src dst` with `dst` an existing **directory** moves
src *inside* it and returns **success**, which left one publication's whole tree nested one level down
inside the other's with both runs reporting that they had published. Neither is reachable now: the
documented name is a symbolic link that is replaced in one operation, and every rename this library makes
passes `-T`, which refuses a directory destination outright. The full argument is above
`_fence_publish_unwind()` in `scripts/lib/db-fence-protected.sh`, and so is the rule that **a rollback
never destroys the only usable artefact** (o3d-xi3w r4): the one migration moves a legacy directory to
`/etc/ims-cutover-recovery/.retired-fence.<pid>.<rand>`, and if the pointer creation or the commit rename
then fails, that name is deleted **only** when the artefact is back where it was — proved by the rename's
own status — or when the documented name holds a committed replacement that is sealed and hashes to its
own record. Otherwise it is **kept**, and the refusal names its path with the command that puts it back.
It used to be deleted unconditionally, one line after a restore whose status was discarded, so a restore
that failed left the documented name absent and the legacy artefact gone. A
rotation also moves `fence_script_sha256` in the recovery record with the file it names; leaving it
behind would make every subsequent run refuse, and a rotation that bricks the mechanism is not a
rotation.

**And that record is bound to whatever is standing, by compare-and-swap** (o3d-xi3w r3). The flip commits
a whole versioned tree in one `rename(2)`, but `fence_script_sha256` lives in
`/etc/ims-cutover-recovery/db-fence-identity.env`, outside it — so it used to be written *after* the flip
from a digest read *before* it, and two publishers interleaved: A commits A, B commits B and records B's
digest, A then records the digest it was still holding. The pointer names one publication and the record
names another, and `db_fence_script_in_use()` then refuses to execute the artefact that is standing — an
outage of the fence itself, on a box where nothing is wrong with either tree. A publisher **killed**
between its flip and that write leaves exactly the same state, with no concurrency at all. Both were
measured before the fix, and two consecutive later runs repaired neither.

What the record says now is *what is standing*, never *what this run published*: each attempt reads the
pointer, takes the entry digest out of the **versioned directory** it names (an immutable path), writes
it, and reads the pointer again — if it has moved, the write was stale and the attempt is made once more
against the publication that is standing now. A run whose own publication was superseded therefore binds
the **winner's** digest and reports a lost race instead of a rotation. Nothing is adopted that does not
authenticate itself: the digest is taken only from a tree that is sealed and hashes to what its own
record beside it binds. And a run that **publishes nothing** repairs a record it finds stale before it
decides anything else, which is what makes the killed-publisher state recoverable without an operator —
except while a fence is standing, where the repair is refused for the same reason a rotation is.

**And while a fence stands, the record names the publication that RAISED it — and the release resolves
through that, not through the pointer** (o3d-xi3w r4). This is the invariant the whole mechanism is held
to, stated once above `_fence_bind_record_to_standing()`:

* **while a fence stands**, `/etc/ims-cutover-recovery/db-fence-identity.env` names the raising
  publication by `fence_script_version` as well as by `fence_script_sha256`, and every run that resolves
  the fence helper is bound to **that** publication;
* **while no fence stands**, it names what the pointer names, and a run that finds otherwise rebinds it
  itself.

Three properties make the first clause true. The record carries the **version**, so a publication that
commits after the raise cannot change which tree the release runs — before this it could, and did:
measured, a publication landing between the raise's resolution and its authority made the release execute
*another release's* entry file with this fence's grantee list, and when the two digests disagreed instead,
the fence could not be released at all, because the repair is refused while a fence stands. The raise
**binds that record and publishes the authority inside one critical section**, held on
`/etc/ims-cutover-recovery/db-fence-record.lock`, and every other writer of those two lines takes the same
lock and refuses under it while an authority is present — so a stale write either lands before the raise
binds, and is overwritten by it, or does not land at all. And the **sweep keeps** the version a standing
fence's record names, because the pointer has moved on, that publisher is long gone and nothing in the
tree is open, so every other question the sweep asks says "take it".

The lock is `flock(2)`, opened read-only on a root-owned `0600` file in the recovery root. It is
admissible where r3 refused a lock because the **kernel** releases it when the holder's last descriptor
closes, including on `SIGKILL` and on a power cut: there is no file for an operator to remove and no
liveness test to get wrong, and a bounded wait makes a wedged peer a refusal rather than a hang. Stated
plainly: a record written by a release older than this one carries no version, and the resolution then
falls back to the pointer **and the digest check**, which is exactly what those installations did before.
A **pre-pointer installation** is no longer one of those cases: since r5 its fence operations execute out
of an adopted versioned directory (below), so a fence raised there records a version like any other.

And the record a **raise** writes carries the digest of the artefact **that operation is pinned to**, not
of whatever `/etc/ims-cutover-recovery/app/scripts/fence-db-connections.mjs` resolves to at the instant it
is hashed: a cutover is bound to one publication at its first resolution and raises the fence with that
one, so a record naming any other would mean a later run releasing that fence with a different release's
helper.

A rotation republishes **both halves together** — a new entry file and a freshly resolved closure —
which is the only way the vendored packages ever move. The consequence, stated because it is a real
one: upgrading `pg` in `APP_DIR/node_modules` does **not** change what the fence imports, and
nothing warns about it (the divergence notice compares entry files, not trees). The mirror is
self-contained, so it keeps working; it is simply the version that was current when the artefact was
last published, and `IMS_FENCE_SCRIPT_SHA256` on the next update is what moves it.

Two more properties of the rotation:

* it is **refused while a fence may be standing** (`db-connect-fence.json` exists). The helper that
  raised a fence is the helper that must release it, from a record the raise wrote; swapping
  versions across that pair is how a release stops meaning what the fence meant.
* the **second rotation path is root itself**: remove `/etc/ims-cutover-recovery/app` (since r32 the
  whole artefact, not just the entry file — removing only the entry file leaves a vendored closure the
  next publication would have to reconcile; since o3d-xi3w that name is a symbolic link, so this removes
  the pointer and the versioned directory it named is reaped by the next publication's sweep). Only root
  can, and the next run bootstraps. It is the escape hatch for a box whose expected digest has been lost, and it is
  deliberately an act at the console rather than a flag. Do it only with no fence standing — with a
  record present and the copy gone, every run refuses by design.

**What is executed is the versioned directory, and one fence operation executes exactly one of them.**
Making the *publication* atomic left the *resolution* naming a mutable object: `db_fence_script_in_use()`
authenticated the standing artefact and handed back a path **through** the pointer, and the caller then
gave that string to `node` with `DEPLOY_ADMIN_DATABASE_URL` beside it. A concurrent publisher's flip lands
between the two (measured: an invocation that pinned `IMS_FENCE_ARTEFACT_SHA256`, matched it and returned
0 then executed a *different release's* entry file), and raising a fence is not one invocation — each
entrypoint resolves the helper seven times across a cutover, and two of those ran different releases. So
the resolution now seals, digests and authenticates the **versioned directory** and hands back
`/etc/ims-cutover-recovery/.version-fence.<pid>.<rand>/app/scripts/fence-db-connections.mjs`, which nothing
writes into after its publication renamed it there; and it records which publication this operation is
bound to in `/etc/ims-cutover-recovery/.inuse-fence.<pid>.<start time>`, so every later invocation of the
same operation resolves to that one and not to a newer one. The pin is a file rather than a shell variable
because it has to be: every caller resolves the helper inside a command substitution, and a value assigned
there dies with the subshell. Its name carries the operation's pid **and** the start time `/proc` reports
for that pid, so a marker left by a dead run whose pid has been reused is not mistaken for this one's; the
sweep reaps it when its holder is gone, and never reclaims a version a live holder names. The deploy driver's own
snapshot answers the same question a different way, by resolving its pointer once at entry and holding the
descriptor it is already reading from. A pin cannot skip a check: it selects a candidate, and the seal, the record
beside the tree, the tree's own digest, `IMS_FENCE_ARTEFACT_SHA256` and the entry digest the recovery
record binds are then all checked against **that** tree.

**And a pre-pointer installation is *adopted*, not followed** (o3d-xi3w r5). On a box no pointer-era
release has published to, `/etc/ims-cutover-recovery/app` is not a pointer — it is the tree, a real
directory at a well-known name, and a well-known name is a mutable object. Measured: a run authenticated
that tree completely (seal, record beside the tree, tree digest, entry digest), returned the path, and
then executed a *concurrent publisher's* helper with `DEPLOY_ADMIN_DATABASE_URL` beside it, because that
publisher had performed the one migration in between and the same string now resolved through its pointer.
The re-read after the pin cannot help; a replacement that lands after it is exactly the case.

So the resolution never hands that name back. Before it pins anything it gives the operation its own
`/etc/ims-cutover-recovery/.version-fence.<pid>.<rand>/` directory whose files are **hard links to the
standing tree's own inodes**, with the legacy `db-fence-artefact.sha256` and `.manifest` copied in beside
them, and everything after that is about a name no other run can hold. Three things this is *not*, each
deliberate:

* it is **not a migration**. `rename(2)` will not put a symbolic link over a non-empty directory, so
  publishing a legacy tree into a version must *move* the only artefact on the box — and a power cut in
  the interval where the documented name does not exist leaves a standing fence with no helper to release
  it by, which is the worst state this mechanism has. The adoption moves nothing and deletes nothing
  outside its own staging name, so it has no unwind and a kill at any instant leaves only residue the
  sweep reaps. The one migration stays where it belongs: in the next **authenticated** publication.
* it is **not a publication**. Nothing is written at the documented name, the legacy record beside it is
  left alone, and the box stays pre-pointer until a real publication migrates it. Nothing therefore has to
  be *authenticated* that this path cannot authenticate — a migration would put bytes at the documented
  name that no invocation pinned, which the publication refuses to do by design.
* it is **not a copy**. `--link` means the adopted tree is a second *name* for the same inodes, so there
  are no second bytes to prove equal to the first. Only root can write the recovery root and no path in
  the library ever writes *into* a standing tree — a publication renames it aside and then deletes it, and
  a delete unlinks — so the concurrent publisher that used to substitute these bytes cannot reach them at
  all. `db_fence_script_in_use()` still asks every question it asked before, of the adopted directory.

It is **made durable before it takes its version name**, and that ordering is the point (found by the
review of this round). The first draft took no barrier at all, on the argument that nothing outside the
operation ever names the directory — which is wrong by one step: the **raise** writes the version into
`db-fence-identity.env`, durably, so a power cut could leave a standing fence naming a version that exists
with files missing, and every later resolution would find it, fail its digest check and refuse. A version
that does not exist at all degrades to the pointer and is harmless; one that half exists is not. So the
whole tree is flushed (`sync --file-system`, because `sync <dir>` flushes one directory entry and the tree
has nested ones) *before* the rename that gives it a name a record could hold, a barrier that cannot be
taken is a refusal with the staging tree removed, and the flush of the name *after* the rename is not a
refusal — the directory is complete by then and declining to fence over it would be the worse trade. The
publication's own tree barrier was widened the same way in the same change.

The adopted directory is an ordinary `.version-fence.<pid>.<rand>`: the sweep keeps it while its pid is
alive, while a pin names it and while a standing fence's record binds it, and reaps it afterwards. One
consequence is the point — a fence **raised** on such a box now records a `fence_script_version`, so
clause (A) of the invariant above holds there instead of falling back. `--dry-run` and
`--print-fence-digest` are unaffected: they resolve without a pin, they never adopt, and they still write
nothing.

The operator wrappers are the deliberate exception and check the **documented** name against the digest
this operation was pinned to. They are run by hand after the cutover process has exited, so a versioned
path baked into one could name a publication the sweep has since reclaimed — a recovery route that
evaporates — while the digest is what stops one release raising a fence and another releasing it: if
anything published in between, the wrapper refuses and says the artefact has changed since the fence was
raised.

**One mechanism, three entrypoints.** The rule now lives in `scripts/lib/db-fence-protected.sh`,
sourced by `install.sh`, `update.sh` and `deploy.sh`, and no entrypoint has fence-helper resolution
of its own: `db_fence_script_in_use()` decides, and it never returns the checkout's path. Every
invocation goes through it — preflight, fence, migration-URL composition, release and the exit
trap's re-fence — in all three. The library is sourced from **the entrypoint's own directory**
(`${BASH_SOURCE[0]}`), not from `APP_DIR`: it is read at startup, out of the same tree and in the
same instant as the body of the script, so it adds no window the entrypoint does not already have
(in a tree only root can write — out of any other, root is refused at startup and the invocation is not
supported, o3d-z5be r5; that refusal is **best-effort and cannot detect a tree that was merely relabelled**
— see *[The supported bootstrap](#supported-bootstrap)*) — unlike the helper, which is executed several phases later, after the
application account has had a cutover's worth of time to replace it.

**The library's own paths are `readonly`, and it may be sourced only once.** Every constant the
privileged mechanism acts on without re-deriving — the recovery root, the identity record, the
protected application tree, the fence helper inside it, the staging and retired trees, the artefact
digest record and its manifest, the two operator wrappers, the two expected digests, and the
vendoring policy — is declared `readonly` at its one declaration in
`scripts/lib/db-fence-protected.sh`. A scanner can only see `NAME=` words, and `printf -v`, `read`,
a nameref and `(( ))` each change a variable without writing one; `readonly` makes bash refuse all
of them, including forms nobody has listed. Two consequences for anyone editing these scripts:
**source the library exactly once per entrypoint** — a second `source` in the same shell fails on
the first `readonly` and `set -e` aborts the run — and **do not reassign these names anywhere**;
move the value by editing the declaration itself. A path added to that file later is refused by the
census in `tests/scripts/install-root-safe-writes.test.ts` until it is either declared `readonly`
and listed as protected or recorded as deliberately mutable with a reason.

`--dry-run` is the one invocation that cannot use the publishing path, because a dry run writes
nothing and least of all under `/etc`. It may not run the checkout's file in place either
(`--preflight` opens the admin connection with `DEPLOY_ADMIN_DATABASE_URL`, so "it only reads" is a
property of the *shipped* script). So it uses the protected artefact when there is one, and otherwise
snapshots the checkout's bytes **and their resolved dependency closure** into a **throwaway
root-owned directory** laid out the same way, seals and probes that, and removes it.

**Where the protected copy lives, and why it is not a bare file under `/etc`.**
`fence-db-connections.mjs` imports `pg` and node builtins, and node resolves bare specifiers by
walking up from the importing module's directory, not from the working directory, and `NODE_PATH`
does not apply to ESM at all — so the copy r30 published at
`/etc/ims-cutover-recovery/fence-db-connections.mjs` resolved `node_modules` from `/etc` and `/`,
found neither, and would have died with `ERR_MODULE_NOT_FOUND` before it could fence anything.
Every caller stubs the process boundary, so no test saw it. The copy is published into a root-owned
**mirror of the shipped layout** — see r32 below for what is inside it.

### r32: the protected copy imported application-controlled code

r29 closed **deletion**, r30 **substitution at read**, r31 **substitution at write** — and all three
protected exactly *one file*. `/etc/ims-cutover-recovery/app/node_modules` was a **symlink back into
`APP_DIR/node_modules`**, and `fence-db-connections.mjs` imported `dotenv` and `pg` at module
scope, before `main()` had a statement to run. So the account this whole mechanism defends against
still chose executable bytes in every supposedly protected process. A substituted `pg` can read
`argv`, exit 0 for `--preflight` and `--fence`, print a migration URL of its own, and never revoke
anything — the exact lie the protection claims to close — and hashing the entry file authenticated
a tenth of what ran.

**`dotenv` was removed rather than vendored.** It existed for a single call, loading `<app dir>/.env`
so that a pasted `--release` command would pick up `DEPLOY_ADMIN_DATABASE_URL`. Under the mirror
that call resolved `/etc/ims-cutover-recovery/app/.env`, which does not exist: it supplied nothing
while holding a whole package open in the import graph. The shell side already reads that file
(`env_file_value()`, in all three entrypoints) and passes the value through `env`, and the recovery
wrappers below do the same. **The helper now reads no file out of the application directory at
all** — the credential arrives in the environment or the run refuses.

**`pg` is vendored, with its whole closure.** The transitive closure is resolved with node's own
resolver from `APP_DIR/scripts/`, so nesting (`pg-types/node_modules/postgres-array`) is preserved
exactly, and it is **copied**, root-owned, into the mirror:

| path | what it is |
| --- | --- |
| `/etc/ims-cutover-recovery/app` | a **symbolic link** to `.version-fence.<pid>.<rand>/app`, and the single mutable object of a publication (o3d-xi3w) |
| `/etc/ims-cutover-recovery/.version-fence.<pid>.<rand>/` | one publication, complete and immutable: the tree, its record and its manifest together. **This is what is executed**; the pointer is only how the first invocation of an operation finds it |
| `/etc/ims-cutover-recovery/.inuse-fence.<pid>.<start time>` | one **fence operation's pin**: a symbolic link naming the publication that operation resolved. Every later invocation of that operation is bound to it, and the sweep will not reclaim a version a live holder names (o3d-xi3w) |
| `/etc/ims-cutover-recovery/app/scripts/fence-db-connections.mjs` | the only file executed |
| `/etc/ims-cutover-recovery/app/node_modules/pg/…` | a real root-owned directory, not a link |
| `/etc/ims-cutover-recovery/app/node_modules/pg-protocol/…` etc. | …and the rest of the resolved closure (13 packages, ~140 files) |
| `/etc/ims-cutover-recovery/app/../db-fence-artefact.sha256` | what the tree hashes to, and what the entry file hashes to. Named **through the pointer**, so it is always the record of the artefact that is standing: the kernel resolves `..` from the directory the link landed in, and one rename therefore commits the tree and its record together |
| `/etc/ims-cutover-recovery/app/../db-fence-artefact.manifest` | per-file digests, so a mismatch can name the file |
| `/etc/ims-cutover-recovery/release-db-fence` | the root-owned recovery wrapper (below) |
| `/etc/ims-cutover-recovery/refence-db` | the same, for raising the fence again |
| `/etc/ims-cutover-recovery/resolve-legacy-db-fence` | the one-time operator resolution for an authority that carries no applied stamp (o3d-secops r26). No banner prints it and no cutover runs it — the validator's refusal is the only thing that names it |

Three refusals make that a boundary rather than a copy:

* **a package that resolves outside `APP_DIR`** (a `node_modules` entry that is a symlink
  elsewhere) is refused, not followed;
* **anything in the staged tree that is not a regular file or a directory** — a symlink, device,
  fifo or socket — is refused *by name*. A symlink is followed by node and is **not hashed** by the
  manifest, so a tree containing one has executable surface its digest does not cover;
* **a closure over `DB_FENCE_VENDOR_MAX_FILES` (2000) files** is refused. A `package.json` in the
  checkout can declare anything as a dependency, and this bounds what the application account can
  talk root into copying under `/etc`.

The module walk **cannot reach `APP_DIR`**, and that is a property of the path rather than of a
check: from `/etc/ims-cutover-recovery/app/scripts/` node tries `…/app/scripts/node_modules`,
`…/app/node_modules` (hit), and stops; even for a specifier that was *not* vendored the walk
continues `/etc/ims-cutover-recovery/node_modules`, `/etc/node_modules`, `/node_modules` and ends
at the root. `APP_DIR` is not an ancestor of the mirror, so no walk from inside it can arrive
there. A missing package is `ERR_MODULE_NOT_FOUND` — a fence that refuses — never a package the
application account chose.

#### The artefact digest, and how to reproduce it

The recorded digest covers **every regular file in the tree**, content and relative path only —
no timestamps, no inode numbers, no absolute paths — so the value is the same on the box that
published it, on the box that verifies it, and in a clean reproduction from the release:

```bash
cd /etc/ims-cutover-recovery/app && find . -type f -printf '%P\0' | LC_ALL=C sort -z | xargs -0 -r sha256sum -- | sha256sum
```

That is the literal command the library computes with; a test asserts that the library, this page
and the recorded value all agree, because a documented check that does not reproduce is a check an
operator concludes is broken and stops running. Compare its output with `fence_artefact_sha256` in
`/etc/ims-cutover-recovery/app/../db-fence-artefact.sha256` — the record of whatever is standing, reached
through the pointer. When they differ,
`cd /etc/ims-cutover-recovery/app && sha256sum -c ../db-fence-artefact.manifest`
names **which** file moved, which "the digest changed" does not.

The digest is **verified before every execution**, along with the seal (every file owned by root,
nothing group- or other-writable, nothing that is not a regular file or a directory). A mismatch is
a refusal, not a warning.

**Reproducing it from a release.** The entry file comes from git, so
`git show <tag>:scripts/fence-db-connections.mjs | sha256sum` is exact. The vendored packages come
from the registry through `package-lock.json`, so `npm ci` at that tag in a clean tree produces the
same package contents, and the same command over a tree assembled the same way reproduces the
artefact digest. What it does not survive is a package manager that rewrites package contents on
install; if that is ever true here, the entry-file digest is still exact and the artefact digest
degrades to "identical to what this box published", which is what the standing record is for.

**`IMS_FENCE_ARTEFACT_SHA256` pins the whole tree**, the way `IMS_FENCE_SCRIPT_SHA256` pins the
entry file — and it is the stronger of the two, so much so that since r33 it is the **required**
one for any publication out of an application-writable checkout. Supplied, it is enforced **at
publication** (the staged tree must hash to it, or nothing is published) *and* **at every
execution** (the standing record must say it, or nothing is run). It is what an operator who has
already published a release on one host uses to require byte-identity on the next.

**What the application account still controls — stated rather than implied.**

* **Nothing, at bootstrap, since r34.** The first publication takes the entry file *and the
  packages* from the checkout, because there is nothing else on the box to take them from — and it
  is therefore **refused** unless `IMS_FENCE_ARTEFACT_SHA256` authenticates the whole tree, or the
  source is one only the publishing account can write. `IMS_FENCE_SCRIPT_SHA256` alone is **not**
  sufficient and is refused rather than accepted for less than it appears to cover. r33 let the
  unpinned case through with a `TRUST ON FIRST USE` warning on the grounds that refusing would
  leave a mechanism that cannot start; the premise was that the digest can only come from a prior
  publication, and it can also
  [ship with the release](#artefact-digest-first-install), which is where it comes from now.
* **The process it runs as.** The helper is executed **as root** on every path (owner decision C3),
  through one library function, `db_fence_exec_root()`: a subshell that un-exports every variable
  but `PATH`, `LANG` and `LC_ALL` (so `NODE_OPTIONS`, `NODE_PATH` and `PG*` from the invoking shell
  never reach it), exports the credential **by name** into that clean process (with the
  application's own `DATABASE_URL`, which the record-less `--release` connects with to prove the application
  can get in), runs from `/` and
  `exec`s `node` with nothing secret on any command line. Until then it ran as the application
  user with `DEPLOY_ADMIN_DATABASE_URL` in its environment, which handed the account the fence
  defends against the credential it defends with. `HOME` is unset in that process, so `pg` resolves
  `~` from root's passwd entry: a `.pgpass` it consults is **root's own**.
* **The interpreter.** `node` is taken from root's `PATH`. A root `PATH` containing an
  application-writable directory defeats this and every other protection here; that is a
  host-hardening property, not one these scripts can assert.
* **`APP_DIR/.env`.** It still holds the credential, and the recovery wrapper still reads it from
  there — with a one-key reader and never `source`. That is a *credential* the account already
  has, not code.

#### r34: what the dry run may run, and what was under the copy

Three findings of one shape: **something authenticated the wrong thing, or authenticated it at the
wrong moment.**

**The dry run stopped executing the checkout.** r31 made `--dry-run` snapshot the fence helper into
a root-owned throwaway rather than run it in place, and r33 extended that snapshot to the whole
resolved dependency closure. Root ownership freezes the copied bytes; it says nothing about where
they came from. So the dry run's `--preflight` — which opens the admin connection with
`DEPLOY_ADMIN_DATABASE_URL` — was executing a graph the application account had chosen, on the
exact command this page recommends for **obtaining the digest that would authenticate it**. It is
now split in two:

* **the candidate digest is computed by reading.** The helper and its closure are assembled into a
  root-owned throwaway, hashed, and destroyed. Computing a digest needs the bytes read, not run, so
  the answer the dry run exists to give survives the restriction intact.
* **nothing is executed with the admin credential unless it is already authenticated.** Two sources
  qualify: the **standing protected artefact**, when it is sealed and hashes to what its own record
  binds (this is the preferred one — it went through the publication gate), and the **candidate**,
  only when `IMS_FENCE_ARTEFACT_SHA256` was supplied and the assembled tree hashes to it. With
  neither, **preflight is unavailable**: the dry run says so, says why, and still prints the
  candidate digest, because that is the value the first real run needs.

**The dry run also reports the right digest.** It used to return the *standing* artefact's digest
the moment one existed and never assemble the checkout at all — so during an upgrade it printed the
**old** tree's value, which cannot authorise the new candidate. It now reports both, separately and
labelled, and pins are taken against the candidate.

**And the provenance question grew an ancestor walk and moved after the copy.** r33 asked "could
anyone but the publisher have chosen these bytes?" about the application directory and everything
under it, before copying:

* it never looked **above** the application directory. Rename permission in Unix belongs to the
  *containing* directory, so an account that can write the parent can move a root-owned, mode-clean
  tree aside and put its own in its place — every check below then passes over bytes it wrote. The
  walk now runs from the application directory to `/`. Two relaxations are deliberate and stated:
  **uid 0** is accepted (root can replace anything regardless, and refusing `/usr` for being
  root-owned would be a rule nobody could satisfy), and a group- or world-writable directory
  carrying the **sticky bit** is accepted (`/tmp` is `1777`, and sticky is the kernel already
  forbidding exactly the rename in question).
* a check followed by a copy is a check with a window after it. The order is inverted — **copy
  first, then verify what was copied** — and the device/inode identity of every path involved is
  compared across the copy, because ownership and modes survive a rename and an inode does not.
  Either answer coming back wrong is a refusal with nothing published.


#### The two commands an operator is ever given (and the third nobody is)

r31 fixed which bytes the scripts execute and left every printed instruction describing the world
before it. Two separate defects of one kind:

* the printed `--release` line named the protected copy but had **no way to obtain**
  `DEPLOY_ADMIN_DATABASE_URL`. The helper's `.env` load resolved against its own mirrored location,
  and the mirror holds no `.env`; the deploy's copy of the variable lives in *its* shell, not the
  operator's. Pasted, it failed while the database stayed fenced — the primary recovery guidance
  was an outage-extending dead end.
* the re-fence banner — printed at the single highest-pressure moment in the script, schema moved
  and fence down — still said `node ${DB_FENCE_SCRIPT} --fence`, the **application-owned** path.

So nothing prints a command line any more. Root writes two wrappers at fence time, and both of
them are printed:

```bash
sudo /etc/ims-cutover-recovery/release-db-fence      # release the standing fence
sudo /etc/ims-cutover-recovery/refence-db            # raise it again
```

A third is written beside them and is **not** one of these: `resolve-legacy-db-fence` is run by an
operator, once, only when an automatic path has refused an authority carrying no applied stamp, and
by no banner and no cutover — see *An unstamped record is ambiguous* below.

Each one is root-owned and `0700`, **never sources anything from the checkout**, carries this run's
state file and four identity values baked in, **takes the cutover lock, resolves the documented
pointer once and hashes that directory against the digest baked at publication before it executes
the helper by the resolved path** (o3d-bpbv: it used to hash the name, then lock, then execute
through the name, so a publication landing in between made it run a different release's helper),
takes `DEPLOY_ADMIN_DATABASE_URL` from its own environment or from the root credential file (never
from `APP_DIR/.env`) through the same provenance-checking reader the entrypoints use, and runs the
helper **as root** with the scrubbed environment above. There is nothing to fill in. Since **o3d-secops r23** they must be run **as root** and no longer accept being run by
the application account: they publish and remove the connection-fence authority, which lives in a
root-owned directory — see below.

#### Who decides what a release grants (o3d-secops r23)

`/etc/ims-cutover-state/db-fence/db-connect-fence.json` names the roles a `--release` hands
`GRANT CONNECT` back to. It used to be **published by the helper**, which runs as the service
account, into a directory owned by that account for exactly that reason — so the account being
defended against could pre-create or replace the file that decides who gets database access, at any
time, and the reader authenticated its **shape**. A well-formed JSON object proves the file is
well-formed JSON; it says nothing about who wrote it. That is the same defect as the legacy fence
marker one round earlier, with another file in it.

Raising a fence is now **three steps**, and the privileged one is in the middle:

| step | who | what |
| --- | --- | --- |
| `--plan` | service account | opens the admin connection, reads the ACL, computes the grantee list, **prints** it as one line of JSON. Revokes nothing and writes nothing. |
| authorise | **root** | validates that request field by field against the database and role **root itself supplied**, rebuilds the record from its own template (anything the request carried that is not in the template is dropped), and publishes it durably — temporary in the destination directory, `fsync`, atomic rename, directory `fsync`. |
| `--fence` | service account | **executes** the authority. It cannot write it; an absent or unauthenticated record is a refusal, not a fresh fence. |

#### Two kinds of fence, with two different rules (o3d-secops r24)

`--fence` used to compare the published authority with the live ACL **in one direction only**: had a
grantee *appeared* since the plan? A role that **loses** `CONNECT` between `--plan` and `--fence` —
an administrator revoking it by hand, a role dropped, any other ACL edit — leaves that comparison
empty, so the stale list was accepted whole, its `REVOKE` was a no-op nobody noticed, and
`--release` afterwards issued `GRANT CONNECT` to **every** role the record named, handing database
access back to one somebody had deliberately removed. Checking for additions is not checking for
equality.

Both differences are compared now, and which of them is fatal depends on a `fence_mode` field
**root** stamps into the record:

| `fence_mode` | when root stamps it | what `--fence` accepts |
| --- | --- | --- |
| `initial` | nothing was at `db-connect-fence.json` when root looked | the live grantee list must match the record **exactly**. Any difference either way aborts, and a re-run re-plans and re-publishes. |
| `recovery` | an authority was already there — a previous cutover revoked and did not release, so its fence is still standing | recorded grantees that no longer hold `CONNECT` are **expected** (that fence is what took it from them). A grantee that has *appeared* is still fatal. |

The stamp is the difference between the two rules, so it is the field worth forging — and it is
computed by root, in the process that does the rename, in a directory the service account cannot
write. That account can neither create a record to obtain the tolerance nor unlink one to escape it,
and a `fence_mode` carried **in** the plan is dropped by the template like every other field root
does not compute for itself. A record with **no** `fence_mode` is read as **`initial`**, the strict
rule — see *An unstamped record is ambiguous* below, which reversed r24's reading of that case.

##### Do not infer a standing fence solely from record presence (o3d-secops r25)

Until r25 root stamped `recovery` whenever **anything** was at `db-connect-fence.json`, and presence
conflates two different states: *root published an authority* and *the fence was actually applied*.
Only the second is a standing fence, and only the second may buy the recovery tolerance. Several
things produce the first without the second, and all of them leave the same file at the same name:

* the publication itself failing **after** the rename — the directory `fsync` is the validator's
  last barrier, and when it fails it says so and deliberately leaves the record visible;
* `--fence` failing with a status the orchestration does not enumerate, or the cutover being killed,
  between the rename and `BEGIN`;
* `SIGKILL` or power loss at the same point, where no cleanup runs because no process is left.

So the record carries **`fence_applied`**, written `0` by the validator and raised to `1` **by
root**, after `--fence` reports the revokes are (or may be) on the medium. `fence_mode` is computed
from that stamp and not from the pathname, which makes a record left behind by *any* publication
failure inert by construction: it can only ever produce another `initial` fence, held to the strict
rule.

| what is at the path | how it is read | why |
| --- | --- | --- |
| nothing | `initial` | no fence, no record |
| `fence_applied: 1` | `recovery` | root saw `--fence` succeed, so a fence stands |
| `fence_applied: 0` | `initial` | published, never applied — what a failed publication or a pre-`BEGIN` refusal leaves |
| **no `fence_applied` key at all** | **REFUSED** | ambiguous — see *An unstamped record is ambiguous* below |
| not a regular file, or not usable JSON | `initial` | nothing there can show a fence was applied |

The two stamped rows hold for the same reason `fence_mode` itself does — the directory is
`root:root` and unwritable by anything else, so the service account can neither raise the key to buy
the lax rule nor strip it.

**Where this fails, said plainly.** If a run dies between a successful `REVOKE` and root raising the
stamp, the record says `0` while a fence *is* standing. The next cutover reads `initial`, the strict
rule sees the recorded grantees missing from the ACL, and it **refuses**. That is the deliberate
direction: a refusal that names the record is recoverable with the release wrapper, which reads the
record and grants back regardless of the stamp, while the other direction would hand drift tolerance
to a fence nobody can show exists. The run announces it at the moment it happens.

Root stamps the record for exit `0` and exit `5` (`EXIT_FENCE_STANDING`, where the `COMMIT` was
issued and its acknowledgement may have been lost — the only safe reading of unknown is that
`CONNECT` may be revoked) and for **no other status**. Exit `1` in particular is the helper's
catch-all: it covers a connection that never opened as well as a teardown that threw after a
successful fence, and a status that cannot tell those apart may not declare a fence applied.

##### An unstamped record is ambiguous, and only the ACL can settle it (o3d-secops r26)

r25 read a record carrying **no `fence_applied` key** as a fence raised before the stamp existed,
and therefore standing. The premise is right — that key is absent only in records an older validator
wrote — and the conclusion does not follow from it. **That older validator published its record
before invoking `--fence`**, so its own `SIGKILL`/power-loss window between the rename and `BEGIN`
leaves exactly this record with no fence behind it. An absent stamp dates the *writer*; it says
nothing about which phase the writer reached, and reading it as standing hands the lax rule to a
fence nobody can show exists.

So **every automatic path refuses it**:

* the **validator** refuses to publish over it. Nothing is published, nothing is revoked, and the
  refusal names the record, says why the two cases cannot be told apart from the filesystem, and
  names the wrapper below;
* the **executor** resolves an unrecognised `fence_mode` to `initial` as well, as defence in depth.

**Nothing on the filesystem can settle it — the ACL settles half of it.** The fence's whole effect
is that the recorded grantees lose `CONNECT`, so a grantee that **still holds** it proves no revoke
took it away, and that half is conclusive whoever was at the keyboard. The other half is not: the
ACL is a statement of the grants **as they are** and carries no history, so the absence of a grant
is evidence of a revoke and never evidence of *whose*. The question is asked by a read-only mode,
`--audit-authority` (no `BEGIN`, no `GRANT`, no `REVOKE`, no write), and acted on by a third
root-owned wrapper an operator runs **once**, deliberately, and no cutover ever runs:

```
sudo /etc/ims-cutover-recovery/resolve-legacy-db-fence
```

| what the ACL says about the recorded grantees | what it means | what the wrapper does |
| --- | --- | --- |
| every one of them still holds `CONNECT` | the `REVOKE` names exactly those roles, so it cannot have run | **clears** the record, automatically; the next cutover plans an `initial` fence as on any other host |
| not one of them holds `CONNECT` | **two histories, and the ACL cannot tell them apart**: this fence revoked them, or an administrator revoked the same roles independently | **reports** it — the recorded grantees, that none holds `CONNECT`, and both histories — and **changes nothing** until the operator confirms (below) |
| some do and some do not, or the record names nobody | a half-applied fence and an administrator's own revoke read identically | **refuses**, changes nothing, and prints both lists |

##### Why the clear is automatic and the stamp is not (o3d-secops r27)

**The two outcomes are not symmetric, so they do not share an evidential bar.** Clearing a record
nothing stands behind restores nobody's privilege — it is inert whichever history produced the
reading. **Stamping is what later restores privilege:** a stamped record is one the release wrapper,
and a `recovery` re-fence, will `GRANT CONNECT` back from, *to every role it names*. If those roles
lost `CONNECT` because an administrator deliberately took it from them, stamping is the first step
of handing it back — on evidence that cannot rule that history out.

So the stamp requires the operator to say, in as many words, that the fence is theirs:

```
sudo /etc/ims-cutover-recovery/resolve-legacy-db-fence --this-fence-revoked-them
```

Run **without** it, the resolution still does its whole read — the record is inspected, the ACL is
audited, the grantee list and both possible histories are printed — and then changes nothing. That
is the two-step on purpose: the first run is what shows you the roles you are about to authorise a
later `GRANT` for. **The argument authorises nothing by itself.** It is read after the audit, never
before, and it is consulted on one reading only; a mixed ACL, an audit that could not bind its
identity, and a record that is not the ambiguous one are refused with it exactly as without it.

If any of those roles was revoked deliberately and must stay revoked, **do not stamp**. Either leave
the record alone — every automatic path goes on refusing it, which is the safe state — or take the
fence down with the release wrapper, which restores from the record without needing the stamp and
will grant those roles back too, so re-revoke them by hand afterwards.

**Is there better evidence anywhere?** No, and it was looked for rather than assumed. Postgres event
triggers do not fire for DDL targeting **shared objects**, which is what a database is, so
`REVOKE ... ON DATABASE` cannot be captured by one. `track_commit_timestamp` is `off` by default and
"can only be set at server start", so it is never retroactive for a record already on disk — and at
best it would date the last change to the `pg_database` row, not attribute it. `pgaudit` or
`log_statement = 'ddl'` would record the statement and its session role, but they are opt-in, equally
non-retroactive, and write to the server's own log, which the audit — deliberately unprivileged —
cannot read. For fences raised **from this round onward** the question does not arise: `fence_applied`
is written by root the moment the fence goes up, and this whole procedure exists only for records
that predate it.

##### The audit binds the cluster, not just the database name (o3d-secops r27)

`--audit-authority` is held to the same identity gate as `--preflight`, `--fence` and `--release`:
`DEPLOY_ADMIN_DATABASE_URL` must name the same host, port and database as `--app-host/--app-port/
--app-database`, the connection must have landed on that database, and the role it logged in as
(`session_user`) must be the role the URL names and the role it is running as (`current_user`).

It bound only the **database name** when it shipped, and a name is not a cluster. An admin URL
pointing at a different server whose database happens to be called the same thing reaches an
**unfenced** host: every recorded grantee holds `CONNECT` there, the verdict is `absent`, and the
wrapper deletes the sole authority for a fence still standing on the real cluster — after which
nothing can release it automatically. A refusal here prints **no verdict line at all**, so neither of
the wrapper's two channels can be acted on and the record is left byte for byte as it was found.

One thing the gate cannot do here, said plainly: `--release` additionally opens the application's own
`DATABASE_URL` and compares `pg_postmaster_start_time()` across both connections, which catches a URL
that *names* the right host and *resolves* elsewhere. That cross-check is unavailable to the audit and
cannot be made available — the audit is asked precisely when a fence may be standing, and a standing
fence is exactly what closes the application's connection, so its failure would report "no answer" for
the very reason the answer is "a fence is standing".

**Partial results fail toward refusing, at every step.** An audit that cannot connect, cannot read
the record, is pointed at another database, exits with a status the wrapper does not enumerate, or
prints a verdict line that does not agree with that status leaves the record exactly as it was
found — which keeps every automatic path refusing, the state this procedure exists to leave when it
cannot do better. The wrapper also refuses any record that is *not* the ambiguous one: one already
stamped applied, one carrying `fence_applied: 0` (which is this round's own "published, never
applied" and is already handled by the strict rule), a truncated one, and one nobody published.

**The release wrapper works throughout, stamp or no stamp.** It restores from the record's own
grantee list and consults neither `fence_applied` nor `fence_mode`, so an operator holding a record
no automatic path will touch can still take a standing fence down — that is what makes refusing the
safe direction rather than a dead end.

What `recovery` accepts that `initial` does not, said plainly: on a re-fence a grantee an
administrator removed by hand is indistinguishable from one the standing fence removed — both are
simply absent from the ACL — so that role is re-granted on release. That residue is bounded to hosts
with an **interrupted cutover**, it is announced on stderr when it happens, and the alternative is a
standing fence that can be neither re-applied nor released. On an `initial` fence — every ordinary
deploy, update and install — there is no residue.

**And this run's own authority is cleaned up on every pre-`REVOKE` failure**, as defence in depth on
top of the stamp. Exit `3` (`EXIT_NOT_FENCEABLE`) is returned only *before* `BEGIN`, so nothing was
revoked and the record is this run's own: it is removed. A **failed publication** is removed for the
same reason and was the route r24 missed — its cleanup hung off the execution's exit code, and a
publication that fails after the rename never reaches an execution at all. Whether the record **is**
this run's own is read *before* the publication: where a fence was already standing, that record is
the only account of what an earlier run revoked and it is left exactly where it is. If a removal
cannot be completed the run says so and names the file; the leftover is inert either way, because it
carries no applied stamp.

`--release` reads that record through the same provenance gate — the **directory** first, because
`unlink(2)` and `rename(2)` ask for write permission on the parent and nothing about the file — and
**root** removes it afterwards, once the release is verified and never before. The validator is an
inline program held in one constant in `scripts/lib/db-fence-protected.sh`; the operator wrappers
bake in that same text at publication, so there is one program and two callers. It runs as root, so
it may not be a file out of the checkout, and `node -e` resolves no module and reads no path.

**What is left on the application side: nothing.** There is no request file and no app-writable
directory in the cutover namespace any more — the plan travels on a pipe. The record stays
world-**readable** because the executor is unprivileged and must obey it; readable is not writable,
and it holds role names, not secrets.

**Upgrading a host to r23.** `/etc/ims-cutover-state/db-fence` was owned by the service account at
`0700`; the namespace walk re-owns it to root at `0755` on the next cutover. A record the *previous*
checkout's helper left inside it is that account's, so the provenance gate refuses it — loudly, with
nothing revoked or granted. That is the safe direction and it is not a dead end: the file is still
there and still readable by root. If a fence really was standing, read it, run the `GRANT CONNECT`
statements for every role in its `revoked` list by hand as a superuser, remove it, and re-run.

**What this closes now, and what it does not (owner decision C3).** Until C3 this paragraph said the
helper ran with `DEPLOY_ADMIN_DATABASE_URL` in its environment for the length of a cutover, so that
the application account could issue any SQL the admin could, and described only the *persistent*
half (a planted file causing a later privileged grant) as closed. It was worse than that sentence:
the credential also sat in the application's own `.env` all the time, was readable in `ps` on every
`runuser ... env VAR=secret` line, was inherited by every command started as the application user
whenever it was typed on `sudo env ...`, and the **migration connection was the admin login with
`options=-c role=<app>`**, which is a session default and not a boundary (`SET ROLE NONE` on that
connection is the admin). All of that is closed: see [Database identities](#database-identities).
What is **not** closed: a `.pgpass` or `PG*` setting in **root's** own environment is root's to
control; `hidepid` on `/proc` is not required by this design (nothing secret is on an argv any more)
but is still worth having; and an operator who runs the helper by hand with the credential on a
command line has put it there.

**r33: the banners print the `sudo`, and that is not decoration.** r32 asked of every printed line
"would it run if pasted?" and answered yes for these — correctly for root, and wrongly for the
person most likely to be reading them. The wrappers are `0700` and root-owned, so the operator who
launched the cutover with `sudo bash /etc/ims-cutover-driver/driver/update.sh` is back in a **non-root shell** when the
banner appears and a bare path gives them `Permission denied` at the one moment there is no time to
debug it. The question is therefore asked as *would this run when pasted by the account that reads
it*. The mode stays `0700` rather than being opened to the application account: the point of the
artefact is that the account being defended against does not choose what runs beside
`DEPLOY_ADMIN_DATABASE_URL`, and a wrapper it can execute is one it can invoke at a moment of its
own choosing. Where `sudo` is not installed the banners print the bare path, and that is right
rather than a fallback — the entrypoints refuse to run as anything but root, so a box without
`sudo` is one whose banner can only be being read by root.

If no credential can be found the wrapper says exactly what to set, in the same form, with its own
absolute path:

```bash
sudo env DEPLOY_ADMIN_DATABASE_URL='postgresql://ADMIN:PASSWORD@HOST:PORT/DATABASE' \
  /etc/ims-cutover-recovery/release-db-fence
```

`sudo env VAR=…`, not `VAR=… /path`: `sudo` does not accept assignments before the command, and the
bare assignment form is the one that has just been shown to be `Permission denied`.

Two printed instructions whose answer does **not** differ by account, for completeness: the
artefact-mismatch message's `cd /etc/ims-cutover-recovery/app && sha256sum -c …` runs for either
reader — the recovery directory is `0755` and the artefact tree world-readable, so the check needs
no privilege — and the recovery invocation that re-runs an entrypoint now
carries the same transition (`sudo env DEPLOY_ADMIN_DATABASE_URL=… bash …`), since those scripts
refuse to run as anything but root.

**The credential is the part no record may hold.** `DEPLOY_ADMIN_DATABASE_URL` carries a password
and is written nowhere by these scripts' records. It comes from the **root invocation** or from the
**root credential file** (see [Database identities](#database-identities)), the invocation first, and
**never** from `APP_DIR/.env`: that file is owned by the application account, so a value in it is a
value that account chose. A copy left in it is **refused** before anything is stopped, with the
path to move it to, and is never used or moved by the scripts (adopting an application-owned value
as a root credential is the trust inversion r30 removed). A recovery with no credential anywhere
refuses, naming the file and the invocation that supply it.

**r29: the shape guard classified physical lines while bash reads logical ones.** This was its
fourth escape and the first three had disguised the cause. The operator-message shape explicitly
accepted a **trailing backslash**, and mentions were classified one physical line at a time — so

```
printf '. %s\n' "${APP_DIR}/.env" \
  | dash
```

passed as "operator-facing text, one simple command" on its first line, and its second line was
never examined at all, because it names no application-owned path and the scan therefore never
looks at it. Together they are one pipeline that sources the application-owned file as root: the
exact compound-execution class the r28 grammar claims to exclude. Each earlier escape had been
closed by making the *shape* stricter; a fifth special case would have been the same move again.
Backslash continuations (an **odd** number of trailing backslashes — an even number is an escaped
backslash, and a comment does not continue) are now joined into logical lines **before** anything
is classified, the shape's trailing-backslash tail is gone because a logical line no longer has
one, and the bypass corpus runs through the whole pipeline — scan included — rather than through
the classifier alone, so a bypass the scan never sees counts as accepted.

**The privileged driver and its metadata are now root-owned (o3d-z5be).** This paragraph used to
record the opposite as a known limitation: `scripts/update.sh` was run by root from wherever the
operator kept it — which the documented command made `APP_DIR` — and `APP_DIR/.deploy-meta` supplied
the re-clone URL. Neither was a privilege *crossing* (the clone runs as the application user, with
`--` before the URL so a value starting with `-` cannot become a git option), and neither was a
root-owned configuration input either. Both are now published into `/etc/ims-cutover-driver`; see
*The bytes a privileged run executes* immediately below.

### The bytes a privileged run executes (o3d-kyqa, o3d-z5be)

The rule, stated as a property:

> **No privileged run may execute bytes that an unprivileged account could have changed after the
> run began.**

That is narrower than "root must only run trusted code", and the narrowing is the point. `install.sh`
is run by an operator out of a tree they chose, and that choice has always been this repository's
trust root — nothing on the box can authenticate a checkout, and
`scripts/lib/pin-source-file.mjs` was deleted in o3d-secops r22 precisely because it claimed to.
What the rule forbids is the *second* window: bytes read minutes into a run, after a build, a stop
and a drain, out of a directory the run has itself handed to the service account.

**What is published where.**

```
/etc/ims-cutover-driver/              root:root 0755   created and owned by root only
├── helpers -> .version-helpers.<pid>.<rand>/helpers    THIS RUN's copy of scripts/lib
├── driver  -> .version-driver.<pid>.<rand>/driver      install.sh, update.sh, deploy.sh, lib/
├── .version-helpers.<pid>.<rand>/    root:root 0755   one publication, complete and immutable
│   ├── helpers/                      root:root 0755     the tree the pointer names
│   ├── helper-set.sha256             root:root 0644     its whole-tree digest, recipe, date, sentinel
│   └── helper-set.manifest           root:root 0644     per-file digests, for naming what moved
├── .version-driver.<pid>.<rand>/     root:root 0755   likewise, with driver.sha256 / driver.manifest
└── deploy-meta                       root:root 0600   GIT_REPO_URL, GIT_BRANCH, deploy-key flag
```

**`helpers` and `driver` are symbolic links, and that is what makes a publication atomic.** Each is the
single mutable object of its publication: a run assembles a whole new `.version-…` directory — the tree,
its digest record and its manifest together — and then replaces one link with a single `rename(2)`.
Every **resolution** of the documented name, at every instant and from every process, yields exactly one
**complete**, sealed, digested, vouched-for publication; there is no instant at which it resolves to
nothing, to half a tree, or to two trees at once, and no lock is involved.

**An atomic publication is not an atomic consumption, and the reader is pinned separately** (o3d-z5be
r4). The sentence above is about the commit. A reader that resolves the pointer *many times* is not
pinned by it: `sudo bash /etc/ims-cutover-driver/driver/update.sh` resolves the name once for the
entrypoint and again for each of the five libraries it sources, so a publication that landed in between
would have root execute one release's script with another release's libraries. Each entrypoint therefore
resolves the pointer **once, at entry**, off the descriptor bash is already reading it from
(`readlink /proc/$$/fd/255`, which is the physical path of the inode being executed), and every
`source` below that reads the versioned directory the script itself came out of. The same text stands
in all three entrypoints, and a test asserts it byte for byte.

**And if that descriptor cannot be validated, the run refuses — there is no fallback** (o3d-z5be r5).
r4 fell back to `cd -P … && pwd -P` "where `/proc` cannot answer", which resolves the *pointer* again,
and the case that reached it was not only a host without `/proc`: a sweep that unlinks the running
release just after bash opened it makes the descriptor read `… (deleted)`, the check fails, and the
fallback landed on whatever release the pointer named by then — one release's entrypoint with another's
libraries, and no message. The run now stops on a missing descriptor, a deleted one, one that is not
the script, and a path that no longer names the open file, and tells the operator to re-run the
documented command.

The record lives *beside* the tree rather than
inside it (a record inside the tree would be part of its own digest) and *inside* the versioned directory
rather than at a fixed path (a record at a fixed path would be a second mutable object, and two objects
cannot be updated together without a lock). `/etc/ims-cutover-driver/driver/../driver.sha256` is
therefore always the record of the driver that is standing: the kernel resolves `..` from the directory
the link landed in.

Superseded `.version-…` directories are left standing and removed by a later run's sweep, once **three**
questions all answer "reapable": no pointer names it, the shell that published it is gone, and **no
process on the box holds an open file, a current directory or an executable under it** (o3d-z5be r4).
The third is what the pin above makes necessary: a run reads its libraries out of one versioned
directory for its whole life, and the shell that *published* that directory exited releases ago, so the
first two questions both say "reapable" for a directory a running update is still sourcing out of. It is
asked of `/proc` rather than of a marker this scheme writes, because the reader to protect may be an
`update.sh` from an **older release** that would never write the marker — the same reason a publication
lock would not help. A sweep that cannot ask the question deletes nothing. What remains is a
check-then-delete window that no sweep can close without a protocol every publisher implements.

r4 described that window's worst case as "a `source` or a `node` that fails loudly". **That was false
in r4**: a sweep whose `/proc` snapshot predated a reader's `open()` could unlink the release the reader
had just opened, and r4's pin then fell back to resolving the pointer — to the next release — which is a
silent mixture, not a failure. With the fallback removed the statement holds, and it holds because the
*reader refuses*, not because of anything the sweep does: a release unlinked before the startup block
runs is a `(deleted)` descriptor and a refusal before any `source`; one unlinked afterwards makes a later
`source` or `node` fail on a path that no longer exists, and nothing can put other bytes at that path —
only root can write here, and a swept name (pid and `mktemp` suffix) is never reused. A loud failure
minutes into a cutover is still a failed cutover, which the next run adopts. The same sweep collects `.publish-…` staging trees abandoned by a killed run, and **restores**
rather than reaps a `.retired-…` object left by a migration that was killed before it committed its
pointer: the documented name is absent in exactly that case, so it is the only copy there is.

What this replaced, and why: until o3d-z5be r3 a publication moved the standing tree aside and then
renamed its own into place. Between those two steps the documented name did not exist, so a second
privileged run could take it — and `mv src dst` where `dst` is an existing **directory** moves `src`
*inside* `dst` and reports success, so the loser left its tree nested at `driver/staged`, recorded its
own digest, and announced a publication while `sudo bash /etc/ims-cutover-driver/driver/update.sh` ran
the winner's files. A rename over a symbolic link cannot nest and cannot half-happen.

**The one legacy migration checks what it moved** (o3d-z5be r4). An installation whose `helpers` or
`driver` is still a **real directory**, from a release older than the pointer scheme, has that
directory moved aside once — `rename(2)` will not put a symbolic link over a non-empty directory. The
type test and the move are two operations, so a second publisher can commit *its* pointer at that name
in between and the move would carry that fresh link off, reopening the absent-name interval the scheme
exists to remove. The object is therefore identified by `lstat` before the move and the object at the
retirement name is compared with it after: anything but the directory it found is **put straight back**
and the run publishes nothing. And a `.retired-…` object whose run never came back is **restored** by a
later sweep rather than reaped, because the documented name is absent in exactly that case.

**A publication that cannot be made durable is reported as a refusal, not as a success** (o3d-z5be r4).
The directory sync after the pointer flip used to be discarded (`|| true`), so a failed flush still
returned a digest and the caller announced a publication that a crash could undo. The flip is **not**
rolled back — it names a complete, sealed tree, and undoing it over a disk fault would replace a good
publication with an older one — but no digest is reported, the run stops or warns, and the message says
plainly that the tree **is standing** and that the commit is not durable.

Inside `helpers/` and `driver/` every file is mode `0644` and every directory `0755`, and everything
in the whole root is owned by `root` — `imsapp` can read it and change none of it. `deploy-meta` is
the one exception to the mode, at `0600`: the directory has to be traversable so an operator can
reach the driver copy, and the metadata is the one thing in there that is nobody else's business.

The root directory's whole ancestry is checked from its parent up to `/` before anything is written.
Each component must be a real directory, owned by **root or by the account doing the publishing**
(in production those are the same account — every entrypoint refuses to run as anything but root;
the disjunction is what lets the test suite exercise the shipped function under a scratch root), and
not writable by group or other. The **sticky** bit is credited on an *ancestor* and never on the
immediate parent — sticky means an entry can be renamed only by its owner, so a sticky ancestor
cannot be used to move our root, while a sticky parent would still let anybody create that name
first. A host that fails is told **which** component and what to do about it rather than published
into.

`/etc` is used rather than `/usr/local/lib`, which o3d-z5be proposed, because Debian and Ubuntu ship
`/usr/local/lib` as `root:staff 2775` — group-writable, which would fail that check on a stock host
and turn a security fix into an installer that does not run — and because this repository already
keeps its root-owned executable artefacts under `/etc` (`/etc/ims-cutover-recovery` holds the
protected fence artefact and the operator wrappers).

**`helpers/` — the run snapshot, and what verifies it.** Each of the three entrypoints copies its own
`scripts/lib` into `helpers/` **at startup**, in the same instant it reads its own body and sources
the five shell libraries — the instant the operator accepted when they typed the command. The copy is
sealed (root-owned, no group or other write, regular files and directories only — a symlink is
refused, because the manifest hashes regular files and `node` follows links), digested with the same
recipe the fence artefact uses, and the digest is recorded twice: on disk beside the tree, and **in
the running shell as a `readonly` variable**.

<a id="supported-invocations"></a>
**Which invocations are supported** (o3d-z5be r5). One rule decides it: **root does not run code out of a
tree any other account can write.** No check inside such a tree can make that safe. Bash reads the
entrypoint *incrementally* and reads each library later still, so an account that can write the tree
can change a library after `sudo bash …` has started and before the `source` that reads it — immediate
root execution — or replace a helper *once*, before anything digests it, and then leave it alone so
that every later read agrees on its bytes. That is a write *after* the run began, not a checkout chosen
before it, and nothing that lives in the tree runs early enough to see it.

| how the run is launched | supported? | why |
| --- | --- | --- |
| `sudo bash /etc/ims-cutover-driver/driver/update.sh` (and `deploy.sh`) — the documented commands | **yes** | the startup pin lands in a root-owned, never-rewritten versioned directory under `/etc`; nothing unprivileged can write those bytes at all |
| `sudo bash <release>/scripts/install.sh` from a release root fetched **into a newly created directory** (*The supported bootstrap*), outside `/opt/one-two-inventory` | **yes** | every inode was created by root and no other account has ever had one open; the startup block confirms ownership and modes |
| any tree made root-owned by **relabelling** it (`chown -R root:root`, `chmod -R go-w`) after another account could write it | **NOT SUPPORTED — and NOT detected** | a relabel revokes no descriptor already open for writing, and the startup block reads only ownership and modes, which the relabel set; see *The supported bootstrap* |
| `install.sh` run from inside `/opt/one-two-inventory` (or with `LOCAL_SOURCE_DIR` equal to, inside, or containing it) | **NOT SUPPORTED — refused before any copy or ownership change** | the installer would hand the tree it is executing from to `imsapp` while bash is still reading it (o3d-z5be r6) |
| `sudo bash /opt/one-two-inventory/scripts/update.sh` or `deploy.sh` — any tree `imsapp` (or anyone but root) can write | **NOT SUPPORTED — refused at startup** | the tree's own account can change what root executes after the run starts; see above |
| any of these, with the operator's tree already tampered with before they typed the command | **not defended here** | choosing what the operator launches is outside what any script can check; `IMS_HELPER_SET_SHA256` and a release digest are how an operator adds provenance |

**The refusal in row three is best-effort, and it is not the security boundary.** It lives at the top
of each entrypoint, before any `source` — but it lives *inside the tree it distrusts*. An account that
can write that tree can delete the refusal before bash reaches it, just as it can rewrite anything else
there. What the refusal catches is the honest mistake: an operator typing the old command on a box
nobody has tampered with. **The boundary is not running root code out of a user-writable tree at all**,
which is what the root-owned driver and a root-owned release tree are for; do not read a clean run of
row three's check as evidence that the tree was safe.

**The r4 content-stability check is withdrawn.** r4 digested the helper source before and after the
snapshot's copy and refused unless both agreed with the staged tree, to stop `imsapp` rewriting a helper
under the copy from row three. It could not do that — a helper replaced once, before the first digest,
passes all three reads — and on the supported rows it protects nothing, because the only account that
can write those sources is root, and the `source`s at the top of the entrypoint are exactly as exposed to
root as the copy is. So it was removed rather than kept as a belt that would read like a boundary.

`privileged_helper_path <name>` is the only way anything names a helper it is about to execute. It
resolves the `helpers` pointer — validating the link text rather than merely following it, so it can
only ever name one versioned publication directory beneath the root whose ownership has been
established — re-checks the seal, re-takes the whole-tree digest, and compares it against the value
*this run* published before it hands back a path. What it hands back is the resolved path, so the bytes
`node` opens are the bytes that were just sealed and digested even if another privileged run flips the
pointer in the interval. The in-memory copy is what a second on-disk record could not
do: two privileged runs can overlap (the shared cutover lock is taken later than this), so without
it a run could verify a tree another run had just published and execute its bytes. With it, a
republication by anybody is a refusal in every run that did not perform it, and `readonly` means
nothing later in the run can restate the expected value.

Two call sites resolve through it today, and they are the two `o3d-kyqa` named:

| what | when | as whom | resolved from |
| --- | --- | --- | --- |
| `chown-tree.mjs` | `install.sh` section 9, after the tree has been `chown -R`'d to `imsapp` | root | `helpers/` |
| `pg-auth-request.mjs` | `install.sh`, inside the credential-rotation gates | root | `helpers/` |

`IMS_CHOWN_TREE_HELPER` and `IMS_AUTH_REQUEST_PROBE` still override each one. They come from the
**root invocation** — `sudo` does not carry them unless an operator deliberately arranges it — which
is the same source of trust as `IMS_FENCE_SCRIPT_SHA256`: pointing one somewhere else is a
deliberate operator statement producing a different program, not an exemption.

**Everything else the three entrypoints run, and why it is not in that table.** Every other node
helper they invoke — `check-db-writers.mjs`, `check-prisma-drift.mjs`,
`check-app-db-object-access.mjs`, `run-migration-verifications.mjs`, `check-wms-push-state-enum.mjs`,
`provision-instance.mjs` — runs **as the application user** (`run_as_user "$APP_USER"` in
`install.sh` and `update.sh`, `as_app_user` / `as_app_user_db` in `deploy.sh`, and `run_as_user_db`
for the steps that need the migration connection), so no privilege is crossed however those bytes
got there — and since owner decision C3 none of them is given the admin credential: they read
`DATABASE_URL` (the **migration URL** inside a window) and nothing else, handed over in the
environment and never on a command line. `fence-db-connections.mjs` runs **as root**, out of the
protected root-owned artefact at `/etc/ims-cutover-recovery/app`. `npm`, `npx prisma` and
`next` likewise run as the application user. The five `source`s at the top of each entrypoint are
read at startup, in the same instant as the entrypoint's own body, so they add no window the operator
did not already accept — **in a tree only root can write**. Out of a tree another account can write that is false, because bash reads the entrypoint incrementally and each library later still, and root running out of such a tree is refused and not supported (o3d-z5be r5; see *Which invocations are supported*). That refusal reads ownership and modes, so it is **best-effort**: it cannot tell a tree that was relabelled with `chown`/`chmod` from one root created — see *[The supported bootstrap](#supported-bootstrap)*.

**An optional pin.** `IMS_HELPER_SET_SHA256=<64 hex>` on the privileged invocation makes the
publication *authenticate* as well as freeze: the assembled tree must hash to that value or nothing
is published and nothing is executed. The digest is taken exactly as the fence artefact's is:

```bash
cd scripts/lib && find . -type f -printf '%P\0' | LC_ALL=C sort -z | xargs -0 -r sha256sum -- | sha256sum
```

It is optional because the snapshot's job is immutability-after-start, which needs no operator input;
the pin is how an operator who wants provenance as well gets it, from outside the checkout.

**`driver/` — the deployment driver.** `install.sh` publishes it at startup from the release it is
installing; a successful `update.sh` refreshes it at the end from the release it has just deployed
(only once `NEW_BUILD_SERVING` proves the build on disk is the process answering the port). A failure
to refresh is a **warning**, not a refusal: everything is up, the schema has moved, and there is
nothing left for a refusal to protect — but the run names the copy that is standing, so it cannot
pass in silence.

**Only bytes something outside `imsapp`'s control vouched for may enter it** (o3d-z5be r2). This is
the finding that produced the rule, and it is worth stating as the escalation it was: the refresh
copied `APP_DIR/scripts` — an `imsapp`-owned tree — into `driver/` *after* the fetch, the build, the
migration and the health check, with no external digest, and the next documented update executed those
bytes as root. Root ownership of the destination and the one-release lag did not remove that; they
postponed it by one release, and the publication was itself a late read of application-owned bytes,
which is the one thing this whole arrangement forbids.

So the publication asks what vouches, and the rule is the one this repository already reached for the
fence artefact (o3d-2sm1.5 r33/r34) applied to the tree it had never been applied to:

| the source | what vouches for the bytes | what happens |
| --- | --- | --- |
| owned by the publishing account (root), not writable by group or other, under a parent chain only root can rename — and the same objects after the copy as before it | the kernel: no unprivileged account could have written them | published |
| anything else, with `IMS_DRIVER_SHA256=<64 hex>` on the privileged invocation | the operator, out of band: the assembled tree must hash to that value | published if it matches, refused if it does not |
| anything else, with no digest | **nothing** | **nothing is published**; the copy standing there is untouched, the run warns and names both remedies |

The ownership half is asked of the scripts directory, of `lib`, of the three entrypoints and of every
file in `lib` — write permission on an existing file belongs to the file, not to its directory, so a
mode `0664` file owned by `imsapp` inside a root-owned directory is one `imsapp` can rewrite — and of
every directory from the source's parent up to `/`, because rename permission belongs to the
containing directory. The source is then re-examined **after** the copy, device and inode included: a
rename changes no path, no owner and no mode, only which object a path names, so asking "who can write
this?" twice cannot see it.

**What that means on the documented deployment, said plainly.** `APP_DIR` belongs to `imsapp`, so the
end-of-update refresh publishes only when the operator supplies `IMS_DRIVER_SHA256`. There is no
in-band mechanism that could close this and none is implied: every byte in that tree arrived through an
account that owns it, and no digest computed *on this box* is evidence about it — that value can
**confirm** a digest that came from the release and must never stand in for one. The out-of-band digest
is the path, and the *Updating* section above documents it as the path, with the recipe an operator
runs against the release to get it.

**Why the run snapshot is not held to the same rule.** `helpers/` is executed by **this** run, whose
bytes the operator accepted when they typed the command, which is why an optional
`IMS_HELPER_SET_SHA256` is enough there: the snapshot's job is immutability-after-start. `driver/` is
executed by runs whose operator has accepted nothing yet, so publishing unvouched bytes into it turns
one operator's one-time decision into a standing arrangement in which root executes bytes `imsapp`
chose. That asymmetry is the whole reason the two publications no longer take the same permission.

**Every publication assembles in its own directory** (o3d-z5be r2). Each one used to stage at a single
fixed name beside its target — `helpers.staged` — and remove whatever was there first. Two privileged
runs can overlap (the shared cutover lock is taken later than the startup publication), so a second run
could empty and refill the first run's staging tree in the window between the first run assembling it
and the first run *hashing* it; the first then hashed, renamed and recorded the second run's bytes **as
its own**, its in-memory digest matched them, and `privileged_helper_path` handed them out. Staging now
happens inside a `mktemp -d` directory per publication, named for the kind and the publishing shell, so
two overlapping runs share no object but the final name — where the rename is atomic and the run that
did not perform the last publication is refused by the digest it holds, which is the behaviour this
section claims. A directory left behind by a run that was killed mid-publication is swept by the next
publication, and only when the pid in its name is no longer alive. The publication is deliberately
**not** moved under the cutover lock: it exists so that nothing root executes after startup comes out of
the checkout, and acquiring that lock is itself work a run does before it holds any lock — and
`--dry-run`, `--print-fence-digest` and a fresh `install.sh` take it at different points or not at all,
so a publication that were only safe while it was held would be unsafe in exactly the runs that do not
hold it. Per-run staging makes the isolation structural instead; a lock would make it a property of
scheduling.

`deploy.sh` deliberately does **not** refresh it. It publishes the run snapshot like the other two,
so its own late executions are covered, but it deploys whatever is already in `APP_DIR` rather than
fetching a release — so it has no "release just deployed" to publish, and taking the driver from
`APP_DIR/scripts` on a deploy would promote bytes nothing had fetched into the copy the next
privileged run is launched from. The driver moves when a release lands, which is `install.sh` or
`update.sh`.

On the documented path the refresh **replaces the tree the running `update.sh` was read from**. That
is safe for three stated reasons rather than by luck: `IMS_SCRIPT_LIB_DIR` is pinned at the top of the
script to the versioned directory bash is reading it out of, so the flip changes nothing that any
`source` below it resolves to; the sweep that eventually removes that directory will not remove one a process is still
reading out of; and nothing below that line reads `IMS_SCRIPT_LIB_DIR` again in any case — the five
libraries were read in full at startup, and bash holds an open descriptor on the script itself.

**`deploy-meta` — who reads it, when, and as whom.** `update.sh` reads `GIT_REPO_URL`, `GIT_BRANCH`
and `GIT_DEPLOY_KEY_ENABLED` out of it **as root, at startup**, key by key through
`env_file_value()` — as data, never by sourcing it. The `git clone` those values steer runs **as
`imsapp`**, with `--` before the URL. `install.sh` is the only writer; nothing else on the box reads
it. `update.sh` prefers the root-owned file and falls back to `APP_DIR/.deploy-meta` only when there
is no root-owned one — which is the case for an installation whose last `install.sh` run predates
this release — and it **announces** the fall back, naming the remedy. An unnoticed fall back to the
file this change exists to stop reading would be the same finding with a longer code path.

**What this still does not protect against, stated rather than papered over.** It does not
authenticate the release tree an operator chooses to run `install.sh` from, and it does not make it
safe for root to run out of a tree another account can write — that invocation is refused at startup,
best-effort, and is **not supported** (see *Which invocations are supported* above). On the supported
paths what is gone is the late window: the bytes root executes at minute twenty are the bytes that were
on disk at minute zero, and only root can have touched them in between.

**And it no longer lets that account choose what a future update runs.** Until o3d-z5be r2 this
paragraph conceded exactly that: the end-of-update refresh promoted the `imsapp`-owned tree into
`driver/`, so rewriting the checkout chose the program the next privileged run executed as root. That
is refused now — see the table above — and the residual that replaces it is a narrower and different
statement: an operator who supplies `IMS_DRIVER_SHA256` is trusting the release they took the digest
from, and an operator who publishes from a root-owned tree is trusting the tree they installed. Both
are choices made outside this box by the person invoking `sudo`, which is where this repository has
always put its trust root, and neither is a window `imsapp` can reach.

### An absent `.env` is not permission to mint (o3d-xf9m)

`load_existing_env()` refuses every hostile shape at `APP_DIR/.env` — a directory, a dangling
symlink, an unreadable file, a file that could not be read to the end. It used to accept exactly one
shape as benign: plain **absence**, which is what `rm` produces, on a file `imsapp` owns in a
directory `imsapp` owns. Absence set `ENV_FILE_STATE=absent`, the preservation gate returned without
checking anything, and the run minted a fresh `SETTINGS_ENCRYPTION_KEY` over a live database. Every
encrypted Setting in it is then permanently undecryptable — not a wrong value, a destroyed one.

Absence is nevertheless *legitimate* on a first install, so the fix cannot be a refusal. Minting over
an absent `.env` is now **earned**, and it takes two positive answers, neither of which the
application account authors:

1. **Is there an installation on this host?** The same `upgrade_in_place()` this run asks later to
   decide whether to fence. Its decisive evidence is `/etc/systemd/system/one-two-inventory.service`,
   a file in a root-owned directory that `imsapp` can neither create nor remove. That account *can*
   clear its own crontab, delete `APP_DIR/.pm2` and exit its processes — and all that buys is an
   answer of "nothing here", which is not enough on its own.
2. **Did this run bring the database into being?** `create_database_and_record_newness()` issues
   `CREATE DATABASE` unconditionally and lets **the server** answer, reading the server's own identity
   back on the same connection. `SQLSTATE 42P04` means it was already there.

Why the second answer cannot be spoofed by the same account: it is not a file anywhere, it is what
PostgreSQL said about whether the database existed an instant before this run. The application role
cannot make the server answer "created" for a database that is there. The one way to change that
answer is to **drop the database** — which destroys the encrypted settings this gate exists to
protect, so the evidence can only be falsified by performing the harm. That is the strongest form
this evidence can take on a host where one account owns the application's data.

Anything else — including an install against an **external** database, which creates nothing and so
cannot earn the exemption — is a refusal naming what it found, with the override that already exists
for the same irreversible act: `IMS_INSTALL_REMINT_SECRETS=yes`. On the supported from-scratch path
nothing is asked of the operator: `INSTALL_POSTGRES=y` creates the database, there is no unit and no
crontab, and the run mints.

The binding is **removed on every exit path**: on the success path once the health check is behind
it, and in the failure trap. A drop-in left standing would override `APP_DIR/.env` for every
restart, reboot and `Restart=` that followed, silently, from a file in `/etc/systemd/system` that
no document mentions. A snapshot a `SIGKILL`ed run left behind is refused by the bus question
above — this run did not publish it — and cleared at the validate phase, before anything asks.

One thing this question cannot see, stated rather than papered over: an `ExecStart=` running a
**wrapper that exports `DATABASE_URL` itself** is invisible to systemd's own properties, because
that definition lives inside a program. Closing that would mean reading programs, which is unbounded
again. It is the standing argument for eventually making the four values a **deployment-owned
configuration input** these scripts read outright, rather than deriving them from a URL that is
only probably the one the service uses.

**Being told an identity is not the same as being on it**, so what can be proven still is:

* the admin URL this run opens must reach the **same database and the same server** as the four
  supplied values, or every mode refuses. A loopback address, `localhost` and a unix-socket
  directory are treated as the same machine; anything else that differs is a refusal, not a guess;
* the connection actually opened must report that database as `current_database()`, and must be
  running as the role it **logged in** as (`session_user` = `current_user`), or it refuses. A
  connection string with no database in its path connects to `PGDATABASE`, or failing that to the
  login role's own name, which is how the two come apart without the admin URL looking wrong;
* in `--release`, the application probe must reach **the same postmaster** as this run —
  `pg_postmaster_start_time()`, asked of both — before "the application can connect" is allowed to
  mean anything. A database name is not an identity: `imsdb` exists on the staging server too.

**`DATABASE_URL` is a credential to this helper and nothing else.** It is no longer read for the
role, the host, the port or the database name. The only thing the helper does with it is *open*
it, in `--release`, to see whether the application gets in — and where that lands is then
cross-checked as above. `.env.local` is no longer loaded either: systemd hands the service `.env`,
and reading a file the service never sees was divergence bought for nothing.

**The admin URL is still resolved through the driver, and that is still worth stating**
(o3d-2sm1.5). It is the connection *this process* opens, so `pg`'s own resolution of it is the
right one, and the identity gate reads the effective host, port, user and database off the
`pg.Client({ connectionString })` that `pg` would open rather than off the URL's obvious parts.
For that URL:

* a **repeated** `?host=`, `?port=`, `?user=`, `?dbname=` or `?database=` is **refused** outright.
  The driver copies every query entry into one config object, so the **last** one is the one it
  connects with, while anything reading the URL a parameter at a time — `URLSearchParams.get()`,
  an operator's eye, a log line — sees the **first**;
* a URL whose authority and query string **disagree** about the host, port or user is **refused**
  rather than resolved;
* a `?dbname=` / `?database=` parameter is **refused** when it names anything but the URL path,
  because the driver overwrites the database from the path unconditionally;
* a port `pg` cannot read as a number reaches `ConnectionParameters` as `NaN`, and is **refused**
  rather than quietly defaulted to 5432;
* the **OS account** is subtracted: `pg`'s last fallback for the login role is `process.env.USER`,
  the account running this script and not the application's, so an admin URL that rests on it is
  **unidentified** — and `session_user`, read from the open connection, is what binds the role;
* `postgres://role@/db?host=/var/run/postgresql` — a login role with no host in the authority — is
  read the way the driver reads it, not rejected as unparseable.

**And the role is asked of the connection, not derived from the URL** (o3d-2sm1.5). `PGUSER`, a
`.pgpass` entry, an ident or peer map and `options=-c role=` are all outside any URL. Every mode
now reads `session_user` and `current_user` from the connection it opened, alongside
`current_database()`, and refuses when the connection will not say what it logged in as, when it
is **running as** a different role than it **logged in as** (`CONNECT` belongs to the login role,
while every ACL answer would be given as the assumed one), or when `DEPLOY_ADMIN_DATABASE_URL`
names a role other than the one that actually logged in — that role is the one grantee the fence
deliberately does not revoke, and the one `--release` restores against.

**And `--release` never reads a missing record as "no fence".** A record that was never written
and one a power cut ate are indistinguishable from the file system, so absence is not an answer:
`--release` asks the database instead. **Neither answer it can get is a success**, because
`has_database_privilege(<app role>, …, 'CONNECT')` speaks for exactly one role while the fence
revokes `CONNECT` from every grantee that held it:

| what the database says | exit | what it means |
| --- | --- | --- |
| the application role has **no** `CONNECT` | `1` | a fence is standing and its record is gone. It prints the `GRANT` to run by hand and tells you to check `pg_database.datacl` for the other grantees it cannot name. |
| the privilege read and `DATABASE_URL` **disagree** | `1` | the connection this run opened says the role holds `CONNECT`, and `DATABASE_URL` itself cannot connect. A privilege read answers about the database the *reading* connection is attached to; the application uses `DATABASE_URL`. Fatal (o3d-2sm1.5). |
| the application role **has** `CONNECT`, **proven by connecting as it** | `4` | that, and only that. The application can be back inside through `PUBLIC`, through role membership or through a manual grant while monitoring, backup, BI or a second application is still revoked by the same fence — the shape `--fence` itself leaves standing when it rejects an ineffective fence. Audit `SELECT datacl FROM pg_database WHERE datname = current_database();` before treating the database as open. |

Only a usable record licenses "released" (exit 0), because only a record says who held `CONNECT`
beforehand. A record that exists but cannot be parsed is left in place for inspection, and
`--fence` refuses to overwrite one rather than starting a fresh record over the only account of an
earlier fence.

**The entrypoints always ask.** `deploy.sh`, `update.sh` and `install.sh` used to open their
release with `[[ -f <state file> ]] || return 0`, which is the same defect one layer up — an
absence treated as an answer — and it meant the check above was never reached on the exact failure
it exists for. They now run `--release` unconditionally, on the start path and on both adoption
paths, and act on the exit code: exit 1 is fatal everywhere (the application has no `CONNECT`, so
nothing may start or adopt past it); exit 4 is fatal when *that* run had raised a fence of its own
and the record has since vanished, and otherwise a loud warning carrying the ACL audit, so a
`--skip-migrate` run or a resume over an untouched schema is not blocked by a state nothing can
distinguish from health.

**An exit code is not evidence about what was committed** (o3d-2sm1.5). `--fence` commits its
`REVOKE`s and *deliberately leaves them standing* when it then finds the fence ineffective (the
application keeps `CONNECT` through role membership) or the room will not go quiet — the same
shape the exit-4 text above describes. It used to report that with the same exit 1 a failure that
revoked **nothing** returns, and the entrypoints raise their sticky "this run raised a fence" flag
only on exit 0, so a run that had locked PUBLIC, monitoring and BI out was recorded as one with no
fence to its name; a record lost during cleanup then took the exit-4 *warning* branch and let the
run claim a release nobody performed. So:

* **exit 3** — nothing was revoked. **exit 5** (`EXIT_FENCE_STANDING`) — the `REVOKE`s may be in
  force, and this run still cannot call the database fenced. Every outcome from the moment `COMMIT`
  is **issued** returns 5, a thrown error included.
* **A lost `COMMIT` acknowledgement is one of those outcomes** (o3d-2sm1.5). PostgreSQL can commit
  the `REVOKE`s and then lose the connection before the acknowledgement arrives — a dropped
  connection, a timeout, a server restart an instant after the WAL flush. The client's promise
  rejects, and that used to be read as "the transaction did not commit": it rolled back into thin
  air, exited 1, and all three entrypoints recorded a run with no fence to its name over a database
  whose `CONNECT` may have been revoked from PUBLIC, monitoring, backup, BI and a second
  application. **An absent answer is not a negative one.** The post-commit boundary is now the
  moment `COMMIT` is issued, not the moment it is acknowledged; an unacknowledged commit reports
  exit 5, raises the same sticky flag, prints the `GRANT`s and a `SELECT datacl …` to check with,
  issues **no** `ROLLBACK` (a transaction told to commit is not one the run can take back) and
  leaves `db-connect-fence.json` exactly where it was published.
* `deploy.sh`, `update.sh` and `install.sh` **raise the sticky flag on every post-commit result**,
  exit 5 as well as exit 0, in `fence_db_connections()` and in the exit trap's re-fence, and abort
  saying the fence is standing rather than "the fence failed".
* After such a result the unproven verdict (exit 4) is **fatal in all three**.

**Every grantee, not two of them** (o3d-2sm1.5). It used to revoke from PUBLIC and the application
role and call the database held closed. A third role with a direct `CONNECT` grant — monitoring,
BI, a backup job, a second application — was terminated by the drain and **reconnected
immediately**, for the whole length of the migration, while every header and this page said the
database was fenced. The set of grantees is derived from the ACL itself now; the only exclusion is
the admin role the deploy is connected as, because revoking from that would lock the deploy out of
its own recovery. The drain's terminate and its confirming read are both unconditional: an empty
first sample, taken microseconds after the revoke committed, is not proof that a backend which was
mid-authentication has gone.

`--release` restores exactly the grantees that were revoked. It cannot restore the **grantor**: a
grant originally made by `postgres` comes back recorded as made by the deploy admin. The privilege
is identical and every `has_database_privilege()` answer is the same; what changes is who may
revoke it later.

**The fence proves it took, rather than assuming the revoke worked** (o3d-2sm1.3). A grant can reach
the application role through **role membership**, which no examination of the ACL entries the script
itself removed can see. So after the revokes it asks the database directly —
`has_database_privilege(<app role>, current_database(), 'CONNECT')` must be false — and fails with
the granting roles named if it is not. A deploy must not revoke from a shared role, so this is
reported rather than worked around: make the application role's `CONNECT` a direct grant, or run the
cutover with the writers stopped and no connection fence.

**When the fence is released, and when it is deliberately held** (o3d-2sm1.3). Releasing it from the
failure path unconditionally — which is what the previous revision did — lets the application
reconnect to a database whose schema is in an unknown state, which is the exact window this order
exists to close. The distinction is whether the schema was **touched**, meaning
`prisma migrate deploy` had been invoked:

| Where the run failed | The connection fence |
| --- | --- |
| Before the migration was invoked (build, validation, a writer that would not stop, an unarmable fence) | **Released.** Nothing has moved, and a revoke nobody undoes is an application that cannot reach its database at all. |
| At or after the migration was invoked, including a failed drift check or a failed verification | **Held**, with the command to release it by hand printed. The schema may be half-applied; nothing may connect until a re-run has migrated, checked drift and verified. |
| At the start or the health check, *after* the fence had been released for the start | **Re-established**, then held. See below. |
| Everything passed | Released in the start phase, immediately before the new build starts — the only place a release follows a migration. |

**`schema_touched` is written to disk and flushed *before* Prisma is invoked** (o3d-2sm1.4). It used
to be set in shell memory next to the migration command, with the durable marker written by the exit
trap. A `SIGKILL`, an OOM kill or a power cut during `prisma migrate deploy` never reaches a trap, so
the marker on disk still said `schema_touched=false` — and the next run's adoption, which reads that
file and nothing else, **released** the connection fence over a half-migrated schema. Each script now
records and flushes the flag first and refuses to migrate if it cannot: a hard kill at any point from
that moment on leaves a marker that adoption reads as *hold*.

**A failed start does not get to claim the fence is up** (o3d-2sm1.4). The start phase releases the
connection fence and removes the reboot marker *before* `systemctl start` and the health check,
because the new build cannot serve a database it may not connect to. If either then fails, the
failure path re-stops the service, withdraws the environment snapshot it published,
**re-establishes the connection fence**, and prints — and records
in the marker as `db_connect_fence=held|released` — which of the two is actually true.

**What the marker may claim about the connection fence** (`db_connect_fence=`, one shared definition, `db_connect_fence_claim` in `scripts/lib/db-fence-protected.sh`, used by all three writers). The marker is a claim about the moment it was written by a process that can be killed, so it only says what that process had *seen*: `held` (this run's fence is standing), `released` (this run raised or adopted a fence and **the database confirmed its release** -- the helper's exit 0; a release that lost its record (exit 4), one that failed with the ACL not showing the fence, and a re-fence that failed part-way are *not* confirmed releases and read `unknown`, because none of them proves the revoked grants came back), `not-raised` (nothing has been stopped yet, or this is a first install, which takes no fence by policy), and `unknown` (a fence was raised and its release was never confirmed, or the stop has been requested but no fence has been seen raised: a fence may be raised at any instant after the line is written). It used to print `released` for everything that was not `held`, so a `SIGKILL` between the stop and the first rewrite left a marker saying `released` over a database with `CONNECT` revoked and the migration login open. Treat the word as a hint to a person: the database (`datacl`), `db-connect-fence.json` and `release-db-fence` decide, and every recovery path already reads those, never this field. If it cannot
put the fence back it says `THE CONNECTION FENCE IS NOT IN PLACE` rather than describing one that
does not exist.

A re-run **adopts** a held fence rather than releasing it: it re-applies the revoke (which re-drains
anything that attached in between, while keeping the *original* recorded grants so the eventual
release restores the truth) and runs every database-touching recovery step — the rebuild included —
through the root-held admin credential. Adopting a held fence without one is fatal: the application
role has no `CONNECT` and the run would have no connection to recover through.

#### Database identities

*(owner decision C3, o3d-1bgr.)* A cutover uses three database identities and keeps them apart:

| identity | power | who holds it | where |
| --- | --- | --- | --- |
| **application role** (`DATABASE_URL`) | the database owner (unchanged) | the application account | `APP_DIR/.env`, unchanged |
| **migration role** (`<application role>_migrator`, unless the credential file names another) | `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`; a member of the application role (`INHERIT`, `SET`) and of nothing the application role is not; `CONNECT` of its own, which the fence never revokes | nobody persistently: it is `NOLOGIN` until a cutover window opens it with a **fresh random password** | in the **environment** of the application-account steps for the length of one window, never on a command line; closed again by `--release` |
| **deploy admin** (`DEPLOY_ADMIN_DATABASE_URL`) | a superuser, or the database owner with `CREATEROLE` (and, from PostgreSQL 16, `ADMIN OPTION` on the migration role), as a **different role** from the application's | **root only** | `/etc/ims-db-admin/deploy-admin.env` (`root:root`, mode `0600`, in a `root:root` `0700` directory), or `sudo env DEPLOY_ADMIN_DATABASE_URL=… <command>` on the root invocation |

**Why three.** The migration runs application-owned bytes — `prisma` out of the application's
`node_modules`, the migration SQL in the checkout, package scripts — over a connection. That
connection used to log in as the deploy admin with `options=-c role=<app>`, which is a session
default and **not a boundary**: `SET ROLE NONE` on it is the admin (and for a superuser admin,
`SET SESSION AUTHORIZATION` too; plain `RESET ROLE` only returns to the `role=` default, which is
why the escape is `SET ROLE NONE`). Anything running inside the window therefore held superuser.
The migration now logs in as a role worth nothing: after `SET ROLE NONE` it is the migration
role, which can do what the application can do and no more, and the objects it creates are owned
by the application role exactly as an unfenced migration's would be.

**What the operator does.**

* **Fresh install.** Supply the admin URL on the invocation (`sudo env DEPLOY_ADMIN_DATABASE_URL=… bash install.sh`) or
  put it in the credential file first. `install.sh` records it in the root file (`root:root` `0600`;
  an existing directory with another owner or mode is refused, not repaired), creates the migration
  role when it manages the PostgreSQL server, and never writes the admin URL into `APP_DIR/.env`.
  On an **external** database it neither creates nor checks the role: it prints the three
  statements below, and `--preflight` refuses a cutover until the role exists and holds nothing of
  its own. A **first install** performs no fenced cutover and needs no admin connection at all.
* **Upgrade.** `sudo bash scripts/update.sh` (or `deploy.sh`) reads the root file. There is no `.env` editing.
  An admin URL **left in the application's `.env`** is **refused before anything is stopped**: the
  message names the root file; the scripts never use or move that value, because adopting an
  application-owned value as a root credential is the inversion this closes. Remove the line from
  `.env` and put it in the root file.
* **Recovery.** `sudo /etc/ims-cutover-recovery/release-db-fence` (or `refence-db`) reads the root
  file; or `sudo env DEPLOY_ADMIN_DATABASE_URL=… <wrapper|entrypoint>`. **Prefer the file.** A value
  typed after `sudo env` is on the command line of the `sudo` that wraps the command for the length
  of the run, readable by every local account unless `/proc` is mounted with `hidepid`; the file is
  not on any command line. In both cases the entrypoint un-exports the variable at once, so
  nothing it starts as the application account inherits it.

**The credential file.** Two keys, read as data (never sourced): `DEPLOY_ADMIN_DATABASE_URL` and
`IMS_MIGRATION_ROLE` (a name, not a secret). The reader refuses, naming the file and the fault, a
file that is a symbolic link, is not owned by root, is readable by anyone but root, or sits under a
directory root does not own or another account can write; and it judges the file **again off the
open descriptor**, so a name swapped between the check and the read cannot supply the value.

**The migration role, by hand** (what `install.sh` runs for a local server, and what an external
database needs once, as a superuser of that server):

```sql
CREATE ROLE "imsuser_migrator" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT "imsuser" TO "imsuser_migrator" WITH INHERIT TRUE, SET TRUE;   -- PostgreSQL 16+; before it: GRANT "imsuser" TO "imsuser_migrator";
GRANT CONNECT ON DATABASE "onetwoinventory" TO "imsuser_migrator";
COMMENT ON ROLE "imsuser_migrator" IS 'ims migration login: created by the IMS installer, holds nothing of its own';
```

**A role that already exists is never adopted.** The comment above is the marker: `install.sh`,
`provision-ims-tenant.sh` and `--ensure-migration-role` refuse (before granting or altering anything,
in one transaction) a role under that name that does not carry it, because such a role may be a login
with a known password and the grants would hand it the application's privileges. `--preflight`
additionally refuses a marked role that owns or is granted anything of its own anywhere in the
cluster (owned objects, direct grants, default privileges), that carries `ALTER ROLE ... SET`
settings, or that reaches a role the application cannot (for example `pg_read_server_files`).

or, as root with the admin credential in the file or on the invocation,
`node /etc/ims-cutover-recovery/app/scripts/fence-db-connections.mjs --ensure-migration-role --app-host=… --app-port=… --app-user=… --app-database=… --migration-role=…`,
which creates the role only if it is absent and **refuses**, by name, one that exists with a
privilege it must not have (it never demotes a role somebody else made). The path through the `app`
symlink works, **and an entry path the helper cannot vouch for fails instead of passing**: `fence-db-connections.mjs`,
`check-app-db-object-access.mjs` and `run-migration-verifications.mjs` exit **70** (with a message naming the problem) when
their own start path cannot be resolved or resolves to some other file while being named like themselves; they used to
treat that as "imported", run nothing and exit 0, which every shell caller reads as a passed check. The shell
entrypoints start the verification and object-access helpers with `--require-entry`, so for them any case where the
helper is not the entry point is exit 70 too.
The symlink resolution itself: the helper compares its own resolved location with the resolved `argv[1]`, where it used
to compare it with the path as typed, which made `main()` skip and the command exit `0` having done
nothing (the same guard was fixed in `check-app-db-object-access.mjs` and `run-migration-verifications.mjs`).

**A record-less `release-db-fence` closes the migration login and still exits `1`, by design.** With no
connection-fence record there is no baseline of who held `CONNECT`, so a release cannot certify the
database is open to the application; the root wrapper holds only the admin credential and has no
application `DATABASE_URL` to prove it with. It says so (`the second question was not asked`) instead of
reporting that two answers disagree: the line above it reports whether the migration login was closed,
and that stands on its own. If a refusal told you to run the wrapper only to close that login, it did that;
to certify the application can connect, re-run `update.sh`/`install.sh` or audit `datacl`.

**How the window's login is opened and closed.** `--print-migration-url` connects as the admin
once, reads **from the server** (not from configuration) that the migration role is not a
superuser, holds none of `CREATEROLE`, `CREATEDB`, `REPLICATION`, `BYPASSRLS`, is a member of
nothing the application role is not, can `SET ROLE` to the application role, has `CONNECT` of its
own, and can be altered by the admin; then sets `ALTER ROLE … LOGIN PASSWORD '<verifier>'` with 256
random bits sent as a client-computed **SCRAM-SHA-256 verifier**, so the plaintext is in no server
log (a `log_statement = 'all'` log carries the verifier, which is not the password), and prints a URL
for the migration role with the same host, port and database as the admin URL, only its transport-trust
query parameters (`sslmode`, `sslrootcert`, `sslcrl`, `sslsni`, `uselibpqcompat`, `connect_timeout`), plus
`options=-c role=<app>` and the window's binding stamp. The admin login and password are never in
that URL. `--release` ends with `ALTER ROLE … NOLOGIN PASSWORD NULL` and then **asks the server** (`rolcanlogin`
false and, where the admin may read it, a null password). A login that cannot be confirmed closed
(retried once) makes the **release fail** *before any `CONNECT` is restored*: the login is closed and
confirmed first, so on failure the application role still has no `CONNECT`, the fence stands and the record
is untouched. The message gives the one statement that closes the login by hand; re-running the release is
idempotent and retries it. After **any** release that did not succeed, the helper reads the ACL again on a **fresh
connection** and prints one machine line, `FENCE_STATE=held|restored|unknown`; the entrypoints and the recovery
wrapper treat only `held` as a fence that is still standing (a failed release can have committed its grants: the
verification read failed, or the `COMMIT` acknowledgement was lost), so on `restored` or `unknown` the entrypoint
clears its own "fence is up" flag, says so, and re-fences on the way out. `--preflight` and `--fence` also refuse a
migration login that is **already open** (`LOGIN`, or a stored password) with the statement that closes it, and
`--fence` asks again at the end of the drain. The stored password is read only where the admin may read
`pg_authid` (a database-owner admin with `CREATEROLE` may not: then only `LOGIN` decides). The fresh
`FENCE_STATE` read is **bound to the server the release ran on** (postmaster start time, database OID and, where
readable, the system identifier, compared with the ones the release connection reported before it granted
anything); a connection that lands anywhere else prints `FENCE_STATE=unknown`. An unreadable system identifier
never matches: where it cannot be read on both connections the state is `unknown` after a failed release, and the
entrypoint re-fences, which is the safe direction.

**One cutover host per database.** The cutover lock that serialises fence, migration and release is a file on the
host running the entrypoint. It does not exclude a cutover started from a second host against the same database:
both can pass the ACL check, both fence (the second revoke is a no-op) and both enter a window, and the first
release then restores `CONNECT` under the other's migration. IMS is a single-application-host install, so this is
an operator-error case, but it is not detected. Never run two cutovers against one database. If a second cutover is
suspected, stop both, run `SELECT datacl FROM pg_database WHERE datname = current_database();` and
`SELECT pid, usename, application_name, backend_start FROM pg_stat_activity WHERE datname = current_database();` to
see what is attached, re-run a single `update.sh` from one host (it re-fences from the record), and check the
migration with `prisma migrate status`. A database-wide lease is tracked as a follow-up. The URL is also **opened once when it is minted** and must authenticate as the migration role and run
as the application role, or it is not printed and the login is closed again. A window that is
**interrupted** leaves a password nobody holds; the next window mints another.

**What is not done here.** A password-less admin through local peer authentication for a
`postgres` OS user (no stored admin password at all) is a separate change. `pg_dump`, which takes a
connection only as an argument, is given the migration URL through a mode-`0600` libpq service
file that exists for the length of the dump, so the URL is never on its command line. Production's
PostgreSQL topology and major version were not available when this was written: the `WITH SET`
syntax needs 16+, and the plain `GRANT` is used below that.

**Who the migration runs as, which is not who it connects as** (o3d-2sm1.5). This table used to
end with *"objects a migration creates are owned by this role — point it at the role that owns the
schema today"*, and that is advice nobody can follow: `install.sh` makes the **application** role
the database owner, and the fence **refuses outright** when the admin role *is* the application
role. The only fenceable configuration is therefore a separate **superuser** admin — and every
`CREATE TABLE`, `INDEX` and `SEQUENCE` a migration made through it was owned by that superuser
with no grant to the application role.

Nothing in the pipeline could see it. `prisma migrate deploy`, the drift check, the verification
hook and `pg_dump` all use **the same admin connection**, which owns the new objects and reads
them perfectly; the health check hits a route that touches no database. The deploy reported
success and every request touching the new table failed with `permission denied`.

So the migration **connects as the migration role and runs as the application role** (until owner
decision C3 it connected as the admin, which is a session default away from being the admin: see
[Database identities](#database-identities)): the deploy composes the migration URL with
`options=-c role=<app role>`, which Postgres applies at connection start. Authentication — and
therefore the `CONNECT` check the fence revokes — is the migration role's own, which the fence
exempts, so the fence still holds; ownership is the application's, so the fenced path leaves the
database in exactly the state an unfenced migration would.

It is not taken on trust:

* `scripts/fence-db-connections.mjs --preflight` **refuses before anything is stopped** if the
  migration role is missing, holds a privilege, cannot `SET ROLE` to the application role or lacks a
  `CONNECT` of its own, or if the admin cannot alter it, naming the statement that fixes it;
* `scripts/check-app-db-object-access.mjs` runs after **every** migration, before the new build
  starts, and asks the database — about the **application** role, which is the one question none
  of the other steps ask — whether it can `SELECT`, `INSERT`, `UPDATE` and `DELETE` every table,
  `SELECT` every view, `USAGE`/`SELECT`/`UPDATE` every sequence, `EXECUTE` every function (this
  repo's migrations create trigger functions that **gate writes**), and `USAGE` every enum, domain
  and range type. Schemas are asked about directly, so a schema that is **empty** and unusable
  fails rather than contributing no rows and therefore no failure. Anything it cannot use fails
  the deploy and is reported with its owner and the exact privileges missing.

  **Every privilege is asked for separately, and that matters.**
  `has_table_privilege(role, oid, 'SELECT, INSERT, UPDATE, DELETE')` is **ANY, not ALL** — a role
  holding `SELECT` and nothing else answers `true` — and `has_sequence_privilege(role, oid,
  'USAGE, SELECT, UPDATE')` answers `true` for a role holding `SELECT` and no `USAGE`, which is
  exactly the "serial column fails `INSERT`" case this check exists to catch. A comma-separated
  list would therefore turn a read-only grant into a green check over a database the application
  cannot write. `tests/scripts/app-db-object-access.test.ts` proves it against a real Postgres in
  CI's `fresh-db-drift` job.

  It also **refuses to answer about the wrong role**. During the fenced window `DATABASE_URL` is
  the *admin* URL, and asking whether the admin can use the objects the admin just created answers
  yes for every one of them. So the role comes from `--app-role`, then from the fence state file;
  a state file that exists but cannot be read or names no role is **fatal** rather than a silent
  fall-through, the `-c role=` option on `DATABASE_URL` outranks its username, and a fall-through
  that lands on the deploy admin is refused outright.

**The point of no return needs proof, not an open port** (o3d-2sm1.5). Past the health check the
exit trap deliberately stops tearing the deploy down: the new build is serving, and a failed cron
restore must not become an outage plus a database lockout. That is only defensible if the new build
really *is* the one serving. A health poll proves a socket accepted a request — `deploy.sh`'s
`HEALTH_PATH` defaults to `/login` and `update.sh`/`install.sh` poll `/api/health`, all of which a
**stale predecessor still holding the port** answers just as happily. So the flag is armed only on
positive proof that the process on the port is the one this run started — and the three scripts do
not all have the same evidence available, so this is what each of them actually does:

* **The production channel, all three scripts.** An asset under `/_next/static/<BUILD_ID>/` answers
  `200`. Next matches that prefix against a directory snapshot taken at start-up, so only a process
  whose own build id is that one can serve it — a `200` is the new code identifying itself. If it
  does not answer, `update.sh` and `install.sh` fail outright, and so does `deploy.sh` on every
  launcher except the one below.
* **The build id scraped from the health page is evidence, not a verdict** — `deploy.sh` only, and
  it is **not** fatal. It is a regex over whatever HTML that path returns, so a page that embeds no
  build id, a different one, or one behind a CDN is not proof of a stale predecessor. A mismatch
  **warns**, arms nothing and fails nothing. Making it fatal was a deterministic post-migration
  outage on this host: a `next dev` unit answers with the literal build id `development` — eleven
  characters, so it cleared the scrape's length filter — and the mismatch branch fired on every
  single run, leaving a migrated schema with nothing serving and the app role locked out
  (o3d-2sm1.5 r6). If you are reading this expecting "mismatch is fatal", that sentence was wrong
  about the code for two rounds; this is what the code does.
* **The development-server channel, `deploy.sh` only.** `detect_service_units` selects any unit
  whose `WorkingDirectory` resolves to the app directory, and on a stage box that is a `next dev`
  unit. It is still stopped and drained — it is a live writer into the same database — but it
  compiles from source and has no production build id to serve, so the asset channel can never arm
  for it. That is not an exemption: `DEV_SERVER_UNIT` describes the launcher the run *intended*,
  not the process that answered, and a bare warning there used to complete the deploy with nothing
  having identified the responder at all. So `deploy.sh` proves the responder's identity directly,
  and needs **all three** of: the pid listening on the port belongs to a unit this run restarted
  (its cgroup matches `systemctl show -p ControlGroup`, or it descends from the unit's `MainPID`);
  its `/proc/<pid>/cwd` is the app directory, which is the tree a dev server compiles from; and it
  started **after** this run issued `systemctl start`, so it did not survive the stop.

If nothing identifies the responder the deploy **fails while the trap can still stop the
predecessor**, rather than reporting success over an old build serving a migrated schema. The one
deliberate way past that is `IMS_ALLOW_UNIDENTIFIED_DEV_RESPONDER=1`, for the case where the
identity check itself is what is broken on a host: it finishes the run, but it does **not** arm the
point of no return — so a later failure can still be torn down — and it says so on every line it
prints.

**The fence is mandatory for an existing database** (o3d-2sm1.4). Earlier revisions treated exit 3
from `scripts/fence-db-connections.mjs` — "CONNECT was **not** revoked" — as a warning and carried on
with the point-in-time probe. That repeats the mistake the probe itself was: a sibling server, a cron
tick the crontab fence missed, an operator's `psql` or a `next dev` in another worktree can attach at
any moment *after* the snapshot and write across the migration. A fence you know is absent is not a
degraded fence, it is no fence. So:

* `scripts/deploy.sh`, `scripts/update.sh` and `scripts/install.sh` **abort on exit 3**, with the
  fence script's own reason printed above the refusal, and nothing is migrated;
* the fence is checked **before anything is stopped** by *running* it — `--preflight` opens the same
  admin connection and asks the same questions as `--fence`, and revokes, terminates and writes
  nothing. It used to be a `[[ -f scripts/fence-db-connections.mjs ]]`, which proves a file exists
  and nothing about whether it works: `dotenv` was a **devDependency** while the documented manual
  upgrade runs `npm ci --omit=dev`, so the fence died with a missing module at `drain-verify`,
  **after the stop** — an outage for an import (o3d-2sm1.5). `dotenv` is a runtime dependency now,
  and the preflight is what would catch the next one;
* the reasons only the database can give — a superuser application role, a `CONNECT` arriving
  through role membership, an admin that cannot `SET ROLE` to the application role — are answered by
  that same preflight, so they too cost a refusal rather than the stop;
* a **first install** has no existing database to hold closed, so it never asks;
* `--dry-run` **reports** the refusal (`A REAL RUN WOULD BE REFUSED HERE`) and exits 0, because a dry
  run stops nothing and migrates nothing, and its whole job is to tell you what a real run would do.

**The reboot fence is installed before the migration, verified, and rolled back if it cannot be.**
Each unit gets a drop-in at `/etc/systemd/system/<unit>.d/zz-deploy-fence.conf` carrying
`AssertPathExists=!<state-dir>/FENCED`, written *before* anything is stopped — a fence installed
only from the exit trap does not exist for a run that is SIGKILLed or loses power mid-migration,
which is exactly when it is needed. It is a drop-in and not `systemctl mask` because a mask is a
symlink at `/etc/systemd/system/<unit>`, which is where a locally-installed unit file already
lives (the mask fails outright), and `mask --runtime` lives in `/run`, which the reboot erases.
The scripts check the install against `systemctl show -p DropInPaths` and refuse to stop the
predecessor if they cannot confirm it.

**A failed install leaves nothing behind** (o3d-2sm1.5). The marker went down first, then the
drop-in, then the reload, then the verify — and any failure after that first line returned into a
`die` while the fence was not yet armed, so the exit trap did nothing and neither the marker nor
the drop-in was removed. The operator read a clean abort: *refusing to stop the predecessor,
nothing changed*. Nothing had, except an `AssertPathExists=!` now pointing at a marker that
existed — invisible until the next reboot, when the unit failed its assertion with nothing on the
box connecting that to a deploy that had "changed nothing". The install now removes exactly what
**that call** created, and never a fence that was already standing (an adoption, or the exit
trap's own re-install).

**A failure before the stop is not an outage, and is no longer treated as one** (o3d-2sm1.5). The
cutover is a four-phase state machine in all three scripts, and the exit trap does something
different in each:

| Phase | Flag | What the exit trap does |
| --- | --- | --- |
| `none` | — | Nothing this run created needs undoing; it just exits. |
| `arming` | `CUTOVER_ARMING` | Reversible state exists — the reboot-fence drop-in and marker — and **nothing has been asked to stop**. The trap **undoes it**: the drop-in and marker this run wrote are removed and the service is **not touched**. It also restores the crontab verbatim from the backup this run took, which since o3d-p9dq can only exist if the run adopted one an *older* script left behind: the cron fence now happens after the stop, so an interrupted arming no longer leaves a fenced crontab of its own. |
| `stopping` | `FENCE_ARMED` | A stop has been **attempted** (or a previous run's fence was adopted, which means its stop already happened). The trap re-stops, re-fences, holds the connection fence if the schema moved, and refuses to restart anything. |
| `serving` | `PAST_POINT_OF_NO_RETURN` | The new build was proven to be the process on the port. Nothing may stop it; a failed cleanup is a note for a human. |

`FENCE_ARMED` used to be raised *before* `fence_cron` and before any stop, so every way cron
management can fail — an unwritable backup, a failed `chmod`, a broken pipeline, a `crontab` that
returns non-zero — arrived at the trap looking exactly like a failed migration. The trap then
**stopped a service nobody had touched**, kept the reboot fence and demanded a recovery, over a
schema that had not moved and a predecessor that was still healthy: a failure in the cheapest,
most reversible step running the expensive, outage-causing machinery. The flag is now raised on the
line before the first `systemctl stop`, and the arming phase is what covers everything earlier.

**And `fence_cron` itself has since moved to the other side of that line** (o3d-p9dq). Keeping it
in the reversible phase did make a failed backup a pre-stop failure — but it also made the fence a
read-modify-write of a crontab a browser could still be reconciling, which is the lost-update the
crontab lock exists to prevent and which the lock cannot close on its own first rollout. So the
cron fence now runs after the stop and after the port is proved free, a failed backup is an honest
post-stop failure, and `fence_cron`'s own refusal says so. What stays in the reversible phase is
the **reboot** fence, which must be installed before anything is stopped because a fence installed
on the way out does not exist for a run that is killed.

**A migration needs a unit to fence** (o3d-2sm1.5). With no systemd unit serving the tree the
install used to warn and return success, so the `|| die` at every call site never fired: the
predecessor was stopped and the schema migrated with no reboot fence at all, and the failure
banner then described one. That is the exit-3 reasoning again, so `deploy.sh` refuses a migration
on a unit-less host in the `validate` phase, before anything is stopped, and names
`IMS_SERVICE_UNIT`. The `nohup npm start` fallback is unaffected for `--skip-migrate` and
`--restart-only`, which move no schema. The state file records
`reboot_fence=installed|absent` and the failure banner prints whichever is true.

**There is a point of no return** (o3d-2sm1.5). Once the new build has answered its health check
the deploy has succeeded, and what is left is cleanup. The success flag used to be set only after
the cron restore and the marker removal, so under `set -e` a failing `crontab` reached the exit
trap with the fence still armed — and the trap **stopped the service that had just passed its
health check**, re-fenced it and re-revoked `CONNECT`. A cron-restore failure became a full outage
plus a database lockout on a deploy that had already succeeded. Past the health check nothing
tears the deploy down: the failure is printed with the commands to finish the cleanup by hand.
`install.sh`'s upgrade cutover, which previously had **no health check at all**, now polls
`/api/health` before it restores cron and calls the upgrade complete.

**On a failure after the stop, the old version stays down.** A "rollback" that restarts the
predecessor against a migrated schema puts you back in the window the order exists to close. The
scripts leave the service stopped and fenced against a reboot, write a state file recording the
failed step and the command that releases the connection fence, and print what to do. Fix the
cause and re-run — every step is idempotent, and **a re-run adopts all three fences before it
rebuilds**: it re-stops the service, re-establishes and verifies the reboot fence, confirms cron is
still fenced and adopts or releases any standing connection fence (per the table above), all before
it pulls or builds. Do not start the service by hand to "restore service" while a migration has been
applied and the new build has not started.

**A re-run over a migration attempt may not skip the migration** (o3d-2sm1.3). While adopting a
marker whose `migration_attempted=true`, `scripts/deploy.sh` **refuses** `--skip-migrate` and
`--restart-only`: the schema may be half-applied, and starting the service without re-running
`migrate -> drift -> verify` would start it against exactly that. `--skip-build` is still allowed,
and is usually what you want — the build ran before the stop, so the artefact on disk is already the
new one.

**The pre-migration dump is recorded as a restore point only once `pg_dump` succeeds.** It is
written to a `.part` file and renamed on completion; if it fails, the partial file is deleted and
the failure banner says there is no restore point for this run rather than naming a truncated
file as one.

<a id="where-the-pre-update-dump-may-go"></a>
### Where the pre-update dump may go

**`IMS_BACKUP_DIR` is validated, and a path that fails the rule is a refusal rather than a dump**
(o3d-noka, closing o3d-ov60 site 5). The dump, the rename that publishes it and the `rm --` that
prunes beside it are all done **by root**, so `scripts/update.sh` now walks the path this variable
names from `/` downwards and requires **every component, the backup directory included**, to be:

* a **real directory** — never a symbolic link, and never anything else;
* owned by **root** (or by the account the run executes as, which on a host is root);
* **writable by nobody else** — `mode & 0022 == 0`. For a directory that **already exists** this
  really does bound any POSIX ACL as well, because when an ACL carries a mask entry the group bits
  reported for the inode *are* that mask, and every named-user, named-group and group entry is
  effective only through it. It does **not** bound what a **default** ACL does to a file or directory
  **created inside** — see *The dump's own permissions* below, which is where that is handled.

The sticky bit is credited for a component **above** the backup directory's parent and for no other:
a sticky directory can have an existing entry renamed or removed only by that entry's owner, which
settles the question for an ancestor that already exists, and settles nothing for a directory in
which anybody may still **create** a name. `/var/backups/<app>` passes. `/tmp/backups` does not.

The walk is a `chdir` per component with each landing checked against the inode its directory entry
named, so an ancestor is never re-resolved by name, and the directory it ends on is handed to the
dump as an **open descriptor**: the redirection, the publishing rename and the prune are all
`openat`/`renameat`/`unlinkat` against that descriptor, not three fresh resolutions of a pathname.
A component that cannot be stat'ed, or cannot be entered, is a **refusal** — not an absence of
evidence. The refusal **names the component that failed** and says what to do about it.

<a id="the-dumps-own-permissions"></a>
#### The dump's own permissions, and why a POSIX default ACL does not decide them

**The dump file is created at mode `0600`, with the mode given as an argument, and the mode it
actually got is read back before a single byte is written.** A directory this run creates is set to
`0700` and its achieved mode is read back too. Neither rests on the process umask, and that is a
correction rather than a flourish: the first version of this check wrote the dump under `umask 077`
and said that was enough.

**It was not, if the backup directory (or any directory above one this run creates) carries a POSIX
*default* ACL.** A default ACL is invisible in the permission bits, is inherited by everything
created inside the directory, and its inheritance **ignores the umask completely** — the new file's
bits are the mode the creating call *asked for* intersected with the inherited entries, and a shell
redirection asks for `0666`. Measured on a root-owned `0755` directory carrying
`default:user:imsapp:r-x`, which passes every question the ancestry rule asks: the dump came out
`0644` and the service account read it. With the default ACL one level up instead, the two
directories the walk itself created came out `0755`, not the `0700` that was claimed.

**A default ACL on the backup directory is therefore tolerated rather than refused.** Reading ACLs
in the walk would have meant requiring `getfacl` (the `acl` package) at the migration step, with the
service already stopped, and refusing an operator's legitimate arrangement — a default ACL is how you
give an off-host backup agent access to the directory — for a risk the explicit creation mode already
removes. What is *not* tolerated is a destination this run cannot verify private: if the mode it
reads back off the write descriptor has any group or other bit, the run **refuses**, names the mode
it saw, names the default ACL as the mechanism, deletes the partial it had created and migrates
nothing. Take the default ACL off with `setfacl -k <dir>` if you see that refusal.

**What this does not buy.** A pre-existing root-owned `0755` backup directory is still listable and
readable by every account, so the **names and timestamps** of the dumps in it are visible; their
**contents** are not. A backup directory an *earlier* release already created `0755` is **accepted as
it stands and not corrected** — its mode satisfies the rule — so tighten it by hand if you want even
the listing private. A directory *this* run creates is `0700`, so on the default path there is
nothing to tighten. And a default ACL inherited onto a directory this run created is **left in
place**: it can no longer affect anything this code writes, because every file it creates is given an
explicit mode.

**What this costs, because it is an operator-visible narrowing of a documented "anywhere"
override.** An `IMS_BACKUP_DIR` under `/var/lib/<app>`, under `/opt/<app>`, or anywhere else the
**service account** owns is now refused. That was the point: `mkdir -p` accepts a
symlink-to-directory at its final component and returns 0, and `pre-update-<stamp>.sql.gz.part` is a
predictable name in a directory that account can watch — so before this change that account could
redirect root's dump and root's prune into a directory of its choosing (measured: a dump written and
published inside a root-owned `0700` directory the account could not even list, and two pre-existing
root-owned files there deleted by the prune), or plant a named pipe at the partial's name and make
root's `gzip >` block for ever with the service stopped, cron stopped and the database connections
already fenced. **And the dump is now created by `install -m 0600 /dev/null` rather than by the
redirection alone**, which replaces a named pipe or a symbolic link standing at the partial's name
with a regular file instead of blocking on it or writing through it — a second, independent reason
that class of plant is dead. If coreutils' `install` is not on the host's `PATH`, the run **refuses**
rather than falling back to a creation whose mode a default ACL could decide.

**To keep backups on another volume, bind-mount it under a root-owned path; do not symlink one.** A
symbolic link at any component is refused, because nothing proves the path its target resolves
through — the same rule, and the same reason, as the state roots in *Putting a state root on another disk*, above.

**The refusal happens at the migration step, with the service already stopped.** Nothing is
migrated, the schema is untouched and the previous release is still the one on disk, so a re-run
after fixing `IMS_BACKUP_DIR` is clean — but the site is down while you fix it. Validate the value
before you start a cutover; moving the check into pre-flight is filed as a follow-up to `o3d-noka`.

Note that `APP_DIR/.env` carries a *different* variable also spelled `BACKUP_DIR` — that one is the
application's own upload/backup area under the state directory, it is owned by the service account
by design, and it is **not** a valid value for `IMS_BACKUP_DIR`.

**`scripts/backup.sh` is NOT covered by any of this.** It is an unwired legacy helper: its
`APP_NAME` is `onetwoinventory` where every installed path is `one-two-inventory`, so on a real host
it exits at its own `.env` check before it writes anything, and nothing in `install.sh` schedules
it. It still carries the old shape — `mkdir -p "$1"`, `gzip > "$1/backup-<stamp>.sql.gz"`, an
`ln -sf` at a predictable `latest.sql.gz`, and a `find … -delete` prune — so **do not wire it into
cron against an app-owned directory**. Making it reachable means giving it this rule first; that is
filed as a follow-up to `o3d-noka`, and a regression fails if its paths are repaired without it.

What was tried and withdrawn, so that nobody re-attempts it: a symlink-proof walk anchored at the
override's own parent directory (it validates only the final component, because the walk treats its
first argument as a *trusted root* — that is its documented contract); and a `node` helper that
opened the partial with `O_CREAT|O_EXCL|O_NOFOLLOW|O_NONBLOCK` to turn the planted-pipe hang into a
refusal. The helper closed the hang and **opened arbitrary code execution as root**: the documented
update then ran `scripts/update.sh` out of `/opt/one-two-inventory`, which is `chown -R`ed to the
service account, so a file resolved from that checkout *in the middle of the cutover* is bytes that
account can replace after the operator started the run. The three libraries this script `source`s
at startup are not the same case — they are read in the same instant as the entrypoint's own body,
so they add no window the entrypoint does not already have (true only of a tree only root can write,
which is why r5 refuses root out of any other — best-effort, and blind to a relabelled tree: see
*[The supported bootstrap](#supported-bootstrap)*) — and pinning the helper would only move
the boundary to a script read from the same checkout. `scripts/lib/pin-source-file.mjs` was built
for exactly that and deleted for exactly that reason. **Constraining the override is what made all
three rounds unnecessary**: nothing but root can now plant a symbolic link, a named pipe or a stale
`.part` at any name involved, so a plain redirection has no TOCTOU left to lose and no helper has to
be executed at the least recoverable moment of the cutover. The same late-read shape still ships
twice, in `install.sh`'s `chown_state_tree()` and its auth probe; that is `o3d-kyqa`.

Never run two versions of IMS against the same database at once — no rolling restart, no
blue/green overlap, no second instance left running on another port.

### The connection witness, and what binds the migration to the fenced server

A fence, a migration and a release are **four or more separate connections**, opened minutes apart
from the same connection string. A DNS change, a proxy, a failover or a pooler can re-point that
string between any two of them, and every check the fence makes — host, port, database name, role,
the cluster fingerprint, even the fenced ACL itself on a physical copy — is satisfied on both
servers at once. So since o3d-secops r31 the cutover holds a **connection witness**: a session
opened before the first `REVOKE`, on *another database of the same cluster* (`postgres`, else
`template1`, so the drain cannot reach it), holding a session-scoped advisory lock on a nonce
generated seconds earlier. An advisory lock lives in one instance's shared memory: no snapshot,
base backup or restored image carries it, and no other server can answer for it.

Three questions are asked of it, each **on the asking process's own connection**:

| when | what is asked | what a "no" costs |
| --- | --- | --- |
| `--fence` | can this backend, one statement from issuing the `REVOKE`s, see the lock? | nothing. The fence goes up; the run loses only the **automatic removal** of its own fence record. |
| `--bind-migration`, before any DDL | can a connection opened with the **migration's own URL** see it, and did that URL's stamp survive? | the cutover **refuses**. Nothing has been migrated and the schema is untouched. |
| `--bind-migration`, after **each** consumer (a *pin*) | can a connection opened with that step's own URL still see it? | the cutover **refuses**, naming the step. The schema may have moved, so the fence is held and nothing starts. |
| `--bind-migration --hold-stamp`, after the last consumer | the same, plus: can the witness's sampler **see** this connection? | the cutover **refuses** before the new build starts. The fence is held and its record kept. |
| `--release` | can the backend that just granted see a lock taken *at release time*? | the fence is still released; the **record is kept** for a person to end with the release wrapper. |

**How the migration's own connections are stamped.** `--print-migration-url` composes
`application_name=ims-migration-<nonce>` into the migration URL beside the existing
`options=-c role=<app role>`, so every consumer of `MIGRATION_DATABASE_URL` carries it — `prisma
migrate deploy`, `scripts/check-prisma-drift.mjs`, `pg_dump`, `scripts/check-app-db-object-access.mjs`
and `scripts/run-migration-verifications.mjs`, plus `npm run db:seed` and
`scripts/provision-instance.mjs` on `install.sh`. It is a **connection parameter and not a third `-c`**:
measured on PostgreSQL 17.11, libpq applies the GUCs in `options` *before* the startup packet's
`application_name` (or the client's own `fallback_application_name`), so `options=-c
application_name=…` is silently overridden and would have shipped a binding that never binds.
PostgreSQL truncates `application_name` at 63 bytes; the composer **refuses** to emit a stamp that
would be truncated, because a truncated stamp reads as *absent* and absent reads as a redirect.

**Every consumer is placed, not just the window (o3d-secops r33).** Each of the steps above is
followed by a **pin** — a `--bind-migration` opened on that step's own connection string,
immediately after it — so the window reads

```
opening bind -> consumer -> pin -> consumer -> pin -> … -> consumer -> closing gate
```

and every consumer runs *between two connections that were proved to reach the fenced instance*.
Before r33 the closing gate was the only question asked after the migration, and it asked whether
the sampler had seen **any** backend wearing the shared stamp — so one correctly routed connection
certified all the others, and `pg_dump` could take `update.sh`'s restore point from a different
cluster with every gate green. A per-consumer *sighting* cannot replace the pin: polling is
measured not to promise the observation of a 40 ms connection, so requiring one sighting per
consumer would refuse ordinary cutovers. The pins cost one short-lived connection per step and are
a no-op on any run with no fence standing.

**A step's pin runs whether the step succeeded or not, and a placement refusal outranks its exit
status (o3d-secops r34).** As r33 shipped it, every consumer left the script on a non-zero exit
*before* its pin — `set -e` for the bare steps, an explicit `|| die` for the rest — so the chain
was complete only for steps that succeeded, and the step whose placement is worth having is the
other one: a stable redirect sends `prisma migrate deploy` to another cluster, it applies three
statements and fails on the fourth, and nothing asks where that DDL landed. Every consumer now
captures its own exit status, runs its placement, and propagates the failure afterwards. If the
step both failed **and** cannot be placed, what an operator is told is the **placement** —
`… DID NOT RUN AGAINST THE SERVER THIS RUN FENCED … WHATEVER IT WROTE OR READ MAY BE ON ANOTHER
SERVER` — because "prisma exited 7" would send them to the wrong server.

The residual, stated plainly: a redirect that begins **and** reverts inside a single consumer's own
execution is still caught only by the sampler, so only probabilistically. Closing that completely
needs the server to record every login — a login event trigger, a superuser DDL change to the
customer's database, and a lockout risk if it ever fails.

**What the witness's sampler is, and is not.** While the window is open the witness polls
`pg_stat_activity` (cluster-wide, so it sees the fenced database from outside it) for that exact
stamp and accumulates the distinct backends it saw. That is *evidence about the migration's own
connections* — but it is **not** what the refusal rests on, and deliberately: measured, a warm
`prisma migrate status` connects, reads and disconnects inside about 40 ms, and polling cannot
promise to observe a connection somebody else opens and closes. A gate that refused on a missed
sample would refuse ordinary cutovers. So the refusal rests on the `--hold-stamp` probe and on the
pins, whose lifetimes the cutover controls; the sampler's count is reported, and when it is zero
the run says so and **keeps the fence record** for a person, without failing. A pin is deliberately
*not countable* — it renames its own backend to `ims-deploy-fence-bind` the instant it connects —
because otherwise the sixteen probes a run now opens would satisfy that evidence by observing
themselves.

**"The record is kept" never means "the run failed" (o3d-secops r33).** Both degraded readings —
the sampler saw nothing, and there was no witness to ask — cost the **automatic removal of the
fence record and nothing else**. The run finishes, the fence is released, the application starts,
and the record is left for a person with the release wrapper; the next run adopts it. Until r33
neither of them did that: the sampler-miss path lowered the same flag that means *there is no
witness*, so the release issued no challenge and returned failure two steps later, and the
no-witness path — every host behind a transaction-mode pooler — hit the same wall on all three
entrypoints. The one reading that is still fatal is the one the witness exists for: a challenge
**was** put to a live witness and the release's own connection could **not** see it, which is a
release that may have landed on a copy while the real server is still fenced.

That fatal reading is evaluated **before** the kept record is acted on (o3d-secops r34). r33 placed
the "keep the record" shortcut between the line that reads the release's verdict and the line that
acts on it, so a run that had been told `RELEASE_WITNESS <nonce> absent` reported success whenever
the sampler had also missed — and a sampling miss is precisely the run whose routing is in
question. The two degraded readings still cost nothing but the automatic removal; a challenge that
was issued and not answered `colocated` still refuses, kept record or not, and the application is
not started.

**What an operator sees when the nonce cannot be seen.** A redirect and a lost witness are not
distinguishable, and the message says so. Before any DDL the run stops with `THE MIGRATION WOULD
NOT HAVE LANDED ON THE SERVER THIS RUN FENCED … NOTHING HAS BEEN MIGRATED`. After the migration it
stops with `THE MIGRATION WINDOW DID NOT CLOSE ON THE SERVER THIS RUN FENCED … THE SCHEMA MAY HAVE
MOVED`, the new build is not started, the fence stays up and its record is kept: find out which
server `/etc/ims-cutover-state/db-fence/db-connect-fence.json` names and which one the migration
reached before releasing anything.

**A host that can hold no witness is not refused.** A transaction-mode pooler that gives out no
stable backend, a cluster with neither `postgres` nor `template1`, an idle-session timeout: all of
these read as *no witness*, the fence still goes up, the migration still runs, and the only cost is
that the fence record is kept at the end of the run for you to end. Refusing every such deploy
would trade one finding for an outage.

**The verdicts are machine lines, and they are read as machine lines.** Everything an operator
reads from `scripts/fence-db-connections.mjs` is on **stderr**; stdout carries only the structured
lines root parses, and the script replaces `console.log` at start-up so a newly added line cannot
reach that channel. Each verdict is a whole line carrying the run's own nonce
(`RELEASE_WITNESS <nonce> colocated`), the shell matches the whole line rather than a substring, a
stream that answers the same nonce twice is refused, and a verdict is consulted **only where the
challenge was actually issued** — so the absence of the exchange can never read as success. Before
r32 the verdict was a substring of a stream that also carried `Connection fence released: CONNECT
restored to <roles> on <database>.`, and a database or role name containing the token forged it.

### Post-migration verification: `verify.sql`

A migration can declare checks that must pass **after the schema has moved and before the new
build is allowed to serve**. Put them in

```
prisma/migrations/<migration_name>/verify.sql
```

Prisma reads only `migration.sql` from a migration directory, so this file is invisible to
`prisma migrate deploy` and carries no checksum risk. `scripts/run-migration-verifications.mjs`
runs every such file whose migration is recorded as applied — from the deploy scripts during a
cutover, and from the `Schema Guardrails` CI job against a freshly migrated database on every PR.

The contract:

- every statement returns **exactly one row** with **exactly** the columns `check_name` (text)
  and `violations` (an integer count);
- every `violations` must be `0` — anything else fails the deploy and the new build is not
  started. "Anything else" includes a count that is **NULL** or is not an integer, which is an
  **error**, not a pass: `Number(null)` and `Number('')` are both `0`, and the counts most likely to
  come back null are exactly those from a check that found nothing to aggregate over (`SUM` or `MAX`
  over an empty input, a scalar subquery that matched no row). A check that cannot fail is not a
  check (o3d-2sm1.3);
- the checks are read-only, and they must stay true afterwards, because they run on every later
  deploy too.

```sql
-- rows the predecessor created without the new discriminator
SELECT 'shopping_sync_logs missing recordKind' AS check_name,
       count(*)                                AS violations
  FROM shopping_sync_logs
 WHERE "recordKind" IS NULL
   AND connector = 'woocommerce';
```

A check that is only meaningful for one cutover is exactly the right shape: it returns zero for
ever after, and the day it does not, something restarted a predecessor.

**Coverage is declared, and an absent declaration is visible** (o3d-2sm1.2). The hook used to exit
0 the moment no `verify.sql` existed anywhere — which is the state this repository was in — so CI
and the deploy both reported success having executed nothing. Now:

- every run prints what ran and what did not: migrations on disk, how many declare checks, which
  declarations were skipped because their migration is not applied, and how many checks executed;
- a run that executed **no** checks prints `NOTHING WAS VERIFIED` and says that a zero exit means
  nothing was checked, not that nothing is wrong;
- `prisma/migrations/verification-required.txt` names the migrations that **must** declare a
  `verify.sql` — the ones whose safety argument depends on which binary was serving while they ran.

This repository's required migration, `20260822090000_refund_reversal_staging_state`, now declares
its checks (o3d-2sm1.3 — the coverage gate was previously red by design, which is the fastest way to
teach everyone to ignore a mandatory gate). They are derived from what that migration's own prose
says is dangerous:

1. **no refund written after the cutover began without a staging witness.** Legacy rows are
   legitimately `NULL` — the column is deliberately not backfilled — so the check needs a bound.
   That bound is **a discriminator the migration itself draws, not a clock** (o3d-2sm1.4): the
   first revision compared `createdAt` against `_prisma_migrations.started_at`, and
   `CURRENT_TIMESTAMP` is fixed at *transaction start*, so a predecessor transaction that began
   before the migration and committed after it stamps a pre-migration timestamp and looks legacy
   while being exactly the row the check exists to find. `migration.sql` instead adds
   `reversal_staging_state_predates_column NOT NULL DEFAULT true` under its own `ALTER TABLE`'s
   `ACCESS EXCLUSIVE` lock — marking precisely the rows that exist at that instant, with none
   insertable in the middle of it — and then flips the default to `false`. A `NULL` state on a row
   marked `false` was minted by a predecessor still serving, and no clock is consulted.
2. **none of those already outside the accounting invariant's only bound**, i.e. with
   `accounting_retry_required` cleared and no recorded sync list. That is the subset the migration
   calls unrecoverable — no sweep will look at such a row again. It is deliberately a subset of the
   first check; separating them is about what the failure report tells the person reading it.
3. **no value in the column that neither application writer mints.** The migration ships no trigger,
   no default and no backfill, and a third value would make `reversalRecordVerdict` fall through to
   `undecidable` — silencing itself rather than failing.

**And there is a way out when check 1 is red** (o3d-2sm1.5). These checks run on every subsequent
deploy, so a non-zero count does not clear itself: once a predecessor has minted such a row — or a
**partial restore** has put pre-migration rows back into a migrated database, where they arrive
with the post-migration default `predates = false` — every deploy from then on is refused by a
count nobody can act on, and a gate that can only be red is a gate everyone learns to ignore. The
route out is a **repair**, documented in the migration's own `verify.sql`: decide a
predecessor-minted row's state from the accounting ledger and write it, or, for rows a restore
brought back, set `reversal_staging_state_predates_column = true` **scoped to the ids the restore
actually returned** — never to "everything currently red", which would relabel a predecessor's
rows as legacy and destroy the evidence. Neither is something a deploy script runs.

A named migration that declares nothing is a coverage gap. It **fails** under `--strict`, which is
how the `Schema Guardrails` CI job runs the hook, because a missing file is a defect for the pull
request to fix. The deploy scripts run it **without** `--strict` and report the gap instead:
refusing to start a built and migrated application over a file absent from the repository would
turn a documentation gap into an outage. What stops a cutover is a check that ran and failed.

**You do not have to get this right for accounting money posts to stay safe**, and it is worth
knowing why, because a rollback is a deploy nobody plans. Money posts (customer receipts, supplier
payments, credit-note allocations) record `accounting_sync_logs.remoteAttemptedAt` immediately
**before** the remote call, and the retry and revival logic treats an unstamped row as proof that no
call was ever made from it. A version that does not write that stamp would break the proof — so
whether the proof holds is recorded on each row, in `attemptStampingCustodyAt`:

- a version that does not know the column leaves it NULL when it **creates** a row;
- a database trigger nulls it when such a version **claims** one;
- rows outside custody are never recycled, and the next sync run marks them as attempted, so the
  ledger is read before anything is posted for them again.

The cost of that repair is one extra ledger read per affected row. There is nothing to run and no
setting to clear — an overlap, a deploy window or a rollback is discovered from the rows themselves.
See `lib/domain/accounting/money-attempt-provenance.ts`.

## Environment Variables Reference

Key variables in the `.env` file:

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_APP_URL` | Public URL of the application (e.g. `https://ims.yourdomain.com`) |
| `NODE_ENV` | Set to `production` for deployment |
| `AUTH_SECRET` | Secret key for signing session tokens (auto-generated) |
| `INVOICE_PDF_TOKEN_TTL_SECONDS` | Lifetime for IMS-session signed invoice PDF download links. Default `600` (10 minutes). Links are bound to the current IMS session and client IP, so customer-facing shopping downloads use `/api/shopping/{connector}/invoice-pdf` via the shopping platform instead. |
| `INVOICE_PDF_TOKEN_MAX_TTL_SECONDS` | Maximum accepted IMS-session invoice PDF token lifetime. Default and hard cap `2592000` (30 days). Lower this for stricter tenants; raise `INVOICE_PDF_TOKEN_TTL_SECONDS` only up to this cap. |
| `RATE_LIMIT_BACKEND` | Backend for rate-limit counters (cron quotas, login throttle, etc.). `memory` (default) keeps counters per-process. For multi-replica deployments, set `redis` and configure `REDIS_URL` so the limits are shared across replicas. |
| `DATABASE_RESTORE_MAX_FILE_BYTES` | Maximum size of database restore upload in bytes. Default `52428800` (50MB). Raise for tenants with larger backups; the server also performs a disk-space preflight before accepting the upload. |
| `XERO_DAILY_BATCH_LIMIT` | Maximum entities per group per daily batch run. Default `1000`, hard cap `5000`. Larger tenants whose daily volume exceeds the cap get multiple deterministic-reference journals per date. |
| `WC_PENDING_FX_ORDER_NOTIFY_THRESHOLD` | When the WooCommerce pending-FX retry queue reaches this depth, notify active admins. Default `5`. The queue accumulates when WC orders arrive in a currency without a stored FX rate; it drains automatically after the next FX-rate refresh. |
| `BD_GIT_HOOK` / `BEADS_HOOK_TIMEOUT` | Beads (bd) integration hook settings, used only when bd issue tracking is enabled in the working tree. Not required for runtime. |
| `IMS_INSTANCE_ROLE` | What this deployment **is**: `production`, `stage`, `development` or `e2e`. `NODE_ENV` cannot answer this — it is set by the build, so `next start` reports `production` on a stage server, a second production-shaped copy and the end-to-end rig alike, and controls that exempt production therefore exempt all of them (o3d-l89a). Set it on **every** instance. Production preflight warns while it is absent and fails when it is present and says anything other than `production` (or when `E2E_TEST_MODE=1` contradicts it). Absence currently falls back to the old `NODE_ENV`/`E2E_TEST_MODE` reading; once production carries the line, absence becomes non-production everywhere. |
| `IMS_BUILD_MAX_OLD_SPACE_MB` | Installer/updater input (not read by the application): heap ceiling in megabytes handed to `next build` as `--max-old-space-size` by `install.sh`, `update.sh` and `deploy.sh`. Default `6144`; see *Memory for the build* under Prerequisites |
| `INVOICE_PDF_STORAGE_DIR` | Persistent storage directory for connector-downloaded invoice PDFs served through signed links. `install.sh` writes `/var/lib/one-two-inventory/invoice-pdfs` and creates it owned by the application account with mode 750. Defaults locally to `./data/invoices`; required by production preflight (which refuses the default and requires the directory to exist and be writable). Relative paths resolve against the process working directory, so production values should be absolute |
| `SETTINGS_ENCRYPTION_KEY` | 32-byte raw key, or base64 value that decodes to 32 bytes, used to encrypt sensitive Setting values stored in the database (auto-generated) |
| `ENCRYPTION_KEY` | Legacy fallback for older installs; if needed during migration, it must also be a 32-byte raw key or base64 value that decodes to 32 bytes |
| `AUTH_URL` | Authentication callback URL (same as app URL) |
| `DATABASE_URL` | PostgreSQL connection string. **A transaction-pooling proxy in front of this URL is not supported, and is not planned** — point it at PostgreSQL itself; see *Connection pooling in front of `DATABASE_URL` is not supported* below for what is refused, where, and what is not detected. **The schema may be named in either spelling, but only one of them** (o3d-1izw): Prisma's `?schema=` or libpq's `options=-c search_path=`. Whichever is present decides the schema for *both* halves of the application — the schema Prisma qualifies generated queries with, and the `search_path` every raw statement and all three release gates resolve through — and a URL naming no schema is pinned explicitly to `public` rather than left on the server default. A URL that names **two different** schemas, or a `search_path` that is a list rather than one schema, is **refused**: the runtime does not start, the deploy check exits non-zero and `preflight:production` fails, each naming both values. Any *other* startup setting inside `options` (`application_name`, `statement_timeout`, …) is preserved. **Quoting matters in `search_path`, exactly as it does to the server**: `search_path=TenantA` is the schema `tenanta` (PostgreSQL folds an unquoted identifier) while `search_path="TenantA"` is `TenantA`, so the two are pinned differently and `?schema=TenantA` beside an unquoted `search_path=TenantA` is a **conflict**, not agreement. **A vertical tab (0x0B) outside double quotes in a `search_path` is refused** (o3d-ik1j): PostgreSQL 17 and later trim it off a `search_path` element while 16 and earlier keep it as part of the name, so which schema such a URL names depends on the server's major version — remove it, or double-quote the name if the character really is part of it (inside quotes it is literal on every version and is carried); a non-ASCII schema name is **conditional on this deployment**, and quoting no longer settles it (o3d-2k5r r19). PostgreSQL splits a startup `options` by asking `isspace()` **one byte at a time**, so whether the UTF-8 bytes of a name end a token is a property of the server's `server_encoding` and `LC_CTYPE` and not of the string, and a backslash does not help — `pg_split_opts()` consumes the escape and exactly one byte. So the server is **asked**: a sanitised probe connection (no `options`, no `?schema=`) reads the encoding and ctype and then round-trips those exact characters through a custom GUC. Where they come back unchanged the name is **carried**; where the probe has not run, could not reach the server, or measured a change, the URL is **refused** with the measurement and with the alternative — `ALTER SCHEMA "<name>" RENAME TO <ascii_name>;` and the matching `DATABASE_URL`. The probe runs from `instrumentation.ts` at startup, from `preflight:production`, and from `scripts/check-wms-push-state-enum.mjs`, which `deploy.sh` runs **before it stops the old server** — so an unsupported schema is a pre-deploy rejection, not a failed restart. The verdict is held **once per process** and shared by every bundled copy of the module (a versioned `globalThis` slot), which is what makes the runtime honour a probe `instrumentation.ts` ran: the production build emits that module into several chunks and a per-module verdict never reached the one that builds the database adapter (o3d-2k5r r20). A positive verdict is bound to the **physical backend** that gave it, not to the `host:port/database` in the URL (o3d-2k5r r21): that is a *logical* endpoint, and a pooler, a load balancer, a multi-A-record name or a failover pair can serve the probe from one PostgreSQL and the application's pool from another. The probe therefore opens **three** connections and records who served each — `inet_server_addr()`, `inet_server_port()`, the server version, the encoding and the ctype — and will only settle a positive verdict when all three agree; when they do not it settles **not established**, naming both backends, and the refusal stands. A **refusal** needs no such agreement: an unsafe answer from any backend behind the endpoint is safe to apply to all of them, so only the permission is bound to a server. **Three agreeing samples are evidence, not a census** — a round-robin over two backends puts all three on one about an eighth of the time, and sticky or weighted routing makes that likelier — so the samples are not what enforces the rule (o3d-2k5r r22). The probe decides whether the bytes survive and **names the backend that said so**; whether a given connection may carry them is then decided **per physical connection**. Every new connection the application's pool opens asks the backend that answered it for its identity and its effective `search_path`, and is **refused before it can run a query** unless both match what the verdict recorded — so a failover, a re-pointed pooler or an unsampled member gets a refused connection with a reason rather than the permission. The same check wraps the raw `pg` clients the three out-of-process gates and the provisioning seeder use. It costs **nothing** for an ASCII schema name (no check is attached at all) and one round trip per new physical connection for a non-ASCII one — none per query. That per-connection check also **refuses any connection that does not reach the backend directly** (o3d-2k5r r23). A client socket is not a server backend: a transaction- or statement-pooling proxy re-assigns the *server* side between units of work, so a check run when the socket came up says nothing about the backend that runs the next statement. The connection therefore asks `pg_stat_activity` what peer the backend accepted and compares it with this process's own socket; anything that terminated the connection and opened its own — which every pooler must, to multiplex it — is named and refused. **This restricts nothing that worked**, and that is measured rather than assumed: against **PgBouncer 1.24.1** in front of PostgreSQL 17.11, with the default configuration and in **both** `pool_mode = transaction` and `pool_mode = session`, a startup `options=-c search_path=…` is rejected by the pooler outright (`FATAL: unsupported startup parameter in options: search_path`); and where an operator has named the parameter in `ignore_startup_parameters` or `track_extra_parameters` the connection is accepted and the option is **silently discarded** — `current_setting('search_path')` came back `"$user", public` and the query resolved `public`, and a `-c statement_timeout=1234` sent the same way returned `1234ms` direct and `0` through the pooler, so no startup `options` content reaches the backend at all. A non-ASCII schema behind a pooler was therefore **already broken, silently**; this reports it. Two consequences are stated rather than hidden. A plain **TCP NAT or port-forward** also rewrites the peer and is refused too, even though it cannot multiplex — connect the application to the backend directly, or rename the schema to ASCII. And over a **Unix-domain socket** the backend reports no peer at all (`client_addr` NULL, `client_port` -1), so directness cannot be shown there either — and that is **refused, not skipped** (o3d-2k5r r24). It was skipped until r24, on the cover that the `search_path` comparison would catch any real pooler; it does not, because that comparison is a single reading taken when the connection came up and says nothing about the backend that runs the next statement. **Odyssey 1.5.3-rc1, measured rather than cited**: it pools transactions over Unix sockets, and through it the backend reported `client_addr` NULL and `client_port` -1 exactly as a direct connection does, so the two are indistinguishable on that path. What it costs is exactly this: a deployment that connects over a Unix-domain socket **and** names a schema whose characters need a non-ASCII startup option is refused at boot. There are two cheap ways out — point `DATABASE_URL` at `127.0.0.1` over TCP, where the peer comparison can be made and a direct connection passes it, or rename the schema to ASCII. A **pooler's `pool_mode` is not readable from an ordinary SQL connection**, so this detects *interposition*, not the pooling mode. The probe also re-runs at every boot, in `preflight:production`, and before a deploy stops the old server, so a replaced server is re-measured rather than assumed. What is left is the loud case only: a backend that *splits* on the byte refuses the startup packet outright, which is a connection error rather than a silent write to the wrong schema. Every pool in the process is built from this same configuration — the Prisma pool, the three session-advisory-lock pools (`lib/db/pinned-advisory-lock.ts`, the Xero payment-write lock and the WMS dispatch-sweep lock) and the backup-restore selection-lock client — so none of them is a second, unguarded route into the database; a repository check fails the build if a new one appears (o3d-2k5r r23). **A connection that will take a SESSION advisory lock is held to a stricter rule than the data path, and to it on every schema** (o3d-2k5r r25). The per-connection check above is attached only where a non-ASCII startup option is being carried, because that is the permission it exists to spend — so on an **ASCII** schema, which is every ordinary deployment, nothing checked that the lock's connection reached the backend directly. A session advisory lock lives on ONE backend session, and pooling destroys the affinity between the IMS client and that session — what then happens to the lock is per pooler: it may be reset/released with the server connection, or left attached to a backend handed to another client. Measured against **Odyssey 1.5.3-rc1** in transaction-pooling mode, *that* pooler released it: two clients each acquired the same key and each were told they held it while `pg_locks` showed neither did. The money-post lock fences a ledger read and an external payment, so that is a document paid twice. The four holders — `lib/db/pinned-advisory-lock.ts` (which the money-post lock and the daily accounting batches run on), the Xero payment-write lock, the WMS dispatch-sweep lock and the backup-restore selection lock — therefore build their connections through `lib/db/session-lock-pool.ts`, which attaches the directness proof unconditionally; a repository check fails if a fifth holder opens its own connection instead. It costs **one round trip per new physical connection on those pools only** (`max` 2-4, a handful of low-frequency jobs) and **nothing at all on the data path**, which is unchanged. Behind a pooler the refusal names `DATABASE_SESSION_LOCK_URL` — see its own row below. Taking such a connection is **bounded on every deployment, override or not** (o3d-2k5r r28): the directness proof is one statement on the lock's own socket, and a server that accepts the connection and then stops answering used to hang the acquisition — and with it whatever was taking the lock, a money post, accounting batch, WMS sweep or restore among them — indefinitely. It now has a 5 s client-side bound, with a 30 s backstop over the whole acquisition (pg-pool's connect, the proof, and the wait for a free connection on a full lock pool, which carried no timer of its own); on expiry the connection's socket is destroyed and the caller is told the lock was **not** taken. This makes the session that took the lock the session that keeps it; it does **not** make the lock durable, which still ends with its connection, and it does **not** make a session advisory lock a sufficient exclusion for money movement — see `DATABASE_SESSION_LOCK_URL` below and **o3d-ic9a (P1)**. The one deliberate exception is `preflight:production`'s connectivity probe, whose only statement is `SELECT 1` and so resolves no object. **Known gap:** `next build` evaluates `lib/db` in worker processes that never run `instrumentation.ts`, so a build on a deployment with such a schema is refused; build with the schema renamed, or with `DATABASE_URL` unset. And **`?options=` or `?schema=` written twice is refused**: `URLSearchParams.get()` reads the first while the driver connects with the last, so the reader and the connection would be looking at different schemas. |
| `DATABASE_SESSION_LOCK_URL` | **This does not make a pooled `DATABASE_URL` supported** — a transaction-pooling proxy in front of `DATABASE_URL` is unsupported (see *Connection pooling in front of `DATABASE_URL` is not supported* below); this override only keeps the four session locks correct where something is nonetheless interposed, and says nothing about the data path. Set it **only when the lock connections cannot be shown to reach PostgreSQL directly** — `DATABASE_URL` points at a connection pooler (PgBouncer, Odyssey, pgcat, RDS Proxy, a provider's pooled port), or at a **Unix-domain socket**, where the backend reports no peer at all and directness is unprovable. A **direct, non-pooled** URL for the **same database and the same schema**, used only by the connections that hold a PostgreSQL **session advisory lock** — the money-post lock, the Xero payment-write lock, the WMS dispatch-sweep lock and the backup-restore selection lock. Ordinary query traffic keeps using `DATABASE_URL`. Leave it unset when `DATABASE_URL` is already direct: unset and blank both mean "use `DATABASE_URL`". **It must be TCP** — over a Unix-domain socket the backend names no peer, so directness cannot be shown and the connection is refused anyway; use `host=127.0.0.1`. A URL naming a **different database**, or resolving to a **different schema**, is **refused rather than used**: an exclusion taken somewhere other than where the work happens is not an exclusion. Host and port are deliberately not compared — differing is the point of it, which is exactly why matching names cannot be the check. **The override is therefore MEASURED at runtime, not trusted because it agrees on names** (o3d-2k5r r26): on every lock acquisition, a session advisory lock is taken on a connection made from this URL and a connection made from `DATABASE_URL` is asked for the same key; it must be **blocked**, or the override is refused. Shared advisory-lock space is the property a lock needs, and it is the one thing an identifier cannot establish — a `pg_basebackup` clone or a restored dump carries the **same** database name, the **same** schema, the **same** database OID and the **same** `pg_control_system()` system identifier as production, all of which was measured against a real clone rather than assumed. The check runs **per lock acquisition** — every checkout from a session-lock pool and every connect of a session-lock client re-measures (o3d-2k5r r27) — after the directness proof, so a deployment refused for interposition never pays for it: two throwaway connections and four statements, **3–13 ms** measured, and nothing per query, nothing on the data path and nothing at all where no override is set. It was measured **once per process** until r27, and that was wrong for a reason worth stating: the URL *strings* do not change when a pooler is restarted onto another primary, a DNS record is re-pointed or a managed failover promotes a replica, but **what they reach does** — so a process that measured at boot went on treating a boot-time sample as authorisation for an external money post for as long as it lived, while a process started after the change locked the other server, and both were told they held the lock. Re-measuring per acquisition takes that exposure from the life of the process to the milliseconds between the probe and the lock it licenses. The probe is also **bounded end to end**: 5 s to open each connection, 5 s per statement (client-side, because a pooler silently discards a startup `statement_timeout`), and a 20 s deadline over the whole of it that destroys both connections at the socket and refuses — a server or pooler that accepts a socket and then stops answering must not leave whatever was acquiring the lock — a money post, an accounting batch, a WMS sweep or a restore among them — waiting for it forever. **The acquisition the probe licenses is bounded too, and that is a separate fix** (o3d-2k5r r28): until r28 the deadline covered only the probe's two throwaway connections, while the first statement on the *actual* lock socket — the directness proof — had no bound at all, so a server that completed the handshake and then went quiet left the acquisition pending forever with the probe never reached and no probe connection ever opened. That statement now has a **5 s** client-side bound and the whole acquisition a **30 s** backstop, and on expiry the **lock connection's own socket is destroyed** rather than politely closed — `end()` waits for a server reply, which is precisely what a wedged server will not give. The witness takes a **transaction-level** lock inside an explicit `begin`/`rollback`, so nothing is left behind on a pooled server connection, and the probe key is **random**, so two instances booting at once cannot refuse each other. It does not falsely refuse the deployment it exists for: measured against **PgBouncer 1.24.1** in `pool_mode = transaction`, with and without the pinned `-c search_path` startup option, the witness was blocked and the override admitted. Every unclear answer — an unreachable side, a holder that could not take its own key, an answer that is not literally "blocked" — is a **refusal**, and the refusal says what it costs: every session lock in the process taken where the work never happens, every holder told it holds it, and the money-post lock letting two workers **pay the same document twice** with no other symptom. Do not route around it by unsetting the check; point the override at the PostgreSQL that actually serves `DATABASE_URL`. **What this does and does not claim, stated plainly because narrowing a window reads too easily as closing one:** it **detects** configurations in which a session advisory lock demonstrably does not exclude — an override that reaches a different PostgreSQL from the data path — and refuses them. It does **not** make a session advisory lock a sufficient exclusion for money movement, and nothing in this release does. A check is a *sample* taken before the thing it licenses; there is always a window between the two, and no number of samples becomes the property. The session lock also remains non-durable (it ends with its connection), remains dependent on the deployment's connection topology, and the `lost` flag remains a best-effort notification. What would settle the money path is durable, fenced lease state written through the authoritative `DATABASE_URL` transaction, paired with connector idempotency — tracked as **o3d-ic9a (P1 since the 2026-08-28 rescope, which makes connector-side idempotency the first step rather than the lease)** and deliberately not attempted here. **Without an override the question does not arise** — the lock connections and the data path are built from one string by one derivation — so no probe is attached and nothing is paid; the remaining case there, one hostname resolving to two PostgreSQL servers, is filed as `o3d-2vko`. Read in one place (`lib/db/session-lock-pool.ts`), so it reaches every lock or none (o3d-2k5r r25). |
| `PREFLIGHT_DB_CONNECT` | Optional production preflight database connectivity probe. Set `true` during rollout when the preflight process can reach Postgres; default `false` for build-only CI jobs |
| `REDIS_URL` | Redis connection URL, and the canonical place a Redis credential lives: `redis://:PASSWORD@host:port/db` (percent-encode the password). It is what the client connects with, and it is the only form that can express a Redis 6 ACL username. `scripts/install.sh` writes it this way for BOTH a locally provisioned Redis and one you already run, and leaves `REDIS_PASSWORD` empty when it does |
| `REDIS_PASSWORD` | Compatibility fallback, used only when `REDIS_URL` carries no credential of its own — for hosts whose URL predates the rule above. Set one or the other, not both: two different values are a configuration error and are refused rather than resolved by precedence. A Redis that answers `NOAUTH` does not look like a Redis fault, because the login rate-limit buckets fail closed — it looks like nobody can sign in |
| `REDIS_KEY_PREFIX` | Optional Redis namespace prefix for tenant- or instance-scoped keys. Rate-limit keys become `<prefix>:rate-limit:<key>` |
| `WC_STORE_URL` | WooCommerce store URL. Install-time seed only: `scripts/provision-instance.mjs` writes it into the `wc_url` setting on a fresh install (insert-only) and it never overrides the value saved in **Settings > Sync > Connection** |
| `WC_CONSUMER_KEY` | WooCommerce API consumer key. Install-time seed only — the live value is the `wc_consumer_key` setting |
| `WC_CONSUMER_SECRET` | WooCommerce API consumer secret. Install-time seed only — the live value is the `wc_consumer_secret` setting |
| `WC_WEBHOOK_SECRET` | Secret for verifying WooCommerce webhooks and WooCommerce helper-plugin FX pushes |
| `WC_INVOICE_PDF_SECRET` | Separate secret used only by the WooCommerce helper plugin to sign customer-visible invoice PDF proxy requests to IMS |
| `MINTSOFT_USE_BULK_ASN_LOOKUP` | Temporary rollback flag for Mintsoft ASN booked-in processing. Default `false` uses direct ASN lookup; set `true` only if the Mintsoft direct ASN endpoint fails in staging/production. |
| `MINTSOFT_WEBHOOK_SWEEPER_PAGE_SIZE` | Maximum pending Mintsoft ASN booked-in webhook events processed by one sweeper run. Default `250`. |
| `CONNECTOR_FETCH_TIMEOUT_MS` | Default whole-request timeout for validated connector HTTP requests, including redirects and composed with any caller-supplied `AbortSignal`. Invalid values fall back to `30000`. |
| `CONNECTOR_FETCH_MAX_RESPONSE_BYTES` | Maximum response body bytes buffered by the validated connector HTTP client. This does not limit request bodies. Invalid values fall back to `10485760` (10 MiB). |
| `OUTBOX_RETRY_BASE_MS` | Base delay for retryable IntegrationOutbox failures. Default `300000` (5 minutes). |
| `OUTBOX_RETRY_MAX_MS` | Maximum delay cap for retryable IntegrationOutbox failures. Default `3600000` (1 hour). |
| `OUTBOX_RETRY_JITTER_MS` | Maximum tail jitter added to retryable IntegrationOutbox failures. Default `30000` (30 seconds); a 5% base-delay floor applies even when set to `0`. |
| `XERO_TENANT_ID` | **Deprecated** single-organisation form of `XERO_ALLOWED_TENANT_IDS`, kept because it was documented for years while nothing read it — an operator who set it believed the tenant was pinned and was not protected. It is now enforced identically. Prefer `XERO_ALLOWED_TENANT_IDS`; setting both to different values refuses every Xero connection rather than preferring one. It is **not** auto-populated after OAuth. |
| `XERO_ALLOWED_TENANT_IDS` | Comma-separated allow-list of Xero tenant ids (organisation ids) this instance may connect to — the only key that can **allow** an organisation. Blank/absent means unrestricted. When set, a consent offering no allowed organisation is refused at the callback with nothing stored, and a stored token for a disallowed organisation halts every Xero sync. Requires a restart. |
| `XERO_BLOCKED_TENANT_IDS` | Comma-separated tenant ids this instance may **never** use, applied before every other check, at the callback and on every use of the stored token. The maintenance-free control for a test rig: block the live organisation's id (which never changes) instead of allow-listing a test organisation whose id is re-issued when it is re-created. Listing the same id here and on the allow-list is refused as a contradiction rather than resolved silently. |
| `XERO_REQUIRE_DEMO_ORG` | `true`/`false` (default false). When true, this instance may only connect to — and only keep a stored token for — a Xero **demo** organisation, proven from Xero's own `IsDemoCompany` flag on `GET /Organisation`. It costs no extra API call (the callback already reads that endpoint) and is the right control for a test rig: a deny-list refuses only the organisations someone remembered to list, so a third organisation still passes, while an id allow-list has to be re-edited every time the Demo company is re-created with a new tenantId. Enforced at the callback and on every use of the stored token, so a production database restored onto a rig is halted; a stored token whose demo status was never recorded counts as **unverified** and is refused until the connection is re-consented. A value that is neither yes nor no refuses every Xero connection rather than silently meaning off. Requires a restart. |
| `XERO_ALLOWED_TENANT_IDS` / `XERO_BLOCKED_TENANT_IDS` / `XERO_REQUIRE_DEMO_ORG` (any one) | **Required on a non-production instance.** An instance where `NODE_ENV` is not `production` (including absent) or `E2E_TEST_MODE=1` refuses to connect to Xero, and refuses to use a stored Xero token, until one of these three is set — "nothing is configured" is the state that let the e2e rig invoice into the live organisation, so it may not read as "any ledger is allowed". `XERO_ALLOWED_TENANT_NAMES` does **not** satisfy it (a rename defeats a name check). Production is exempt; a production server that hits this refusal should set `NODE_ENV=production` rather than a weaker guard. There is deliberately no key that disables it. |
| `XERO_ALLOWED_TENANT_NAMES` | Organisation names that **narrow** `XERO_ALLOWED_TENANT_IDS`, matched case-insensitively. It is *not* a union and *not* an identity: a Xero organisation name is neither unique nor fixed, so a name can never admit an organisation the id list excludes, a name matching two organisations on one consent is refused rather than used to pick one, and a configuration whose only tenant control is a name is recorded in the activity log as weaker than it looks. An organisation whose name contains a comma cannot be expressed here at all. Set an **id-based** control on every non-production instance — env is the only tenant control that survives a database reset. |
| `BACKUP_DIR` | Local backup storage directory |
| `STATE_DIRECTORY` | Set by systemd from the unit's `StateDirectory=`, not by you. Since o3d-txoe the crontab reconciliation lock is **not** here — it is `/etc/ims-cutover-state/locks/.crontab-reconcile.lock`, a literal both writers derive, because a `StateDirectory` is owned by the service account and that account can rename a root-owned subdirectory aside within it. `$STATE_DIRECTORY` is still where the application's backups live, what the installer's listener proof compares against, and where a **predecessor** build takes the pre-relocation lock the rollout bridge reaches for. On a host where `/etc/ims-cutover-state/locks` does not exist yet the lock falls back to `$STATE_DIRECTORY/locks/…`, and outside systemd to `./locks/` under the working directory |
| `ALLOW_DATABASE_RESTORE` | Production restore kill switch; leave `false` except during a supervised restore window |
| `ALLOW_DATABASE_RESTORE_UPLOAD` | Additional kill switch for uploaded SQL restore files; leave `false` except during a supervised restore window |
| `DATABASE_RESTORE_MAX_FILE_BYTES` | Maximum uploaded SQL restore file size in bytes. Defaults to `52428800` (50 MiB); uploaded restores also require the matching `.manifest.json` sidecar. |
| `UPLOAD_STORAGE_DIR` | Persistent private upload root. Defaults locally to `./uploads` when unset |
| `PUBLIC_UPLOAD_STORAGE_DIR` | Persistent branding/avatar upload root. Defaults locally to `./public/uploads` when unset |
| `FILE_SCAN_MODE` | Invoice PDF scan mode: `disabled` or `command` |
| `FILE_SCAN_COMMAND_ARGV` | Preferred JSON argv scanner command when `FILE_SCAN_MODE=command`; include `{file}` or IMS appends the quarantined PDF path |
| `FILE_SCAN_COMMAND` | Shell-like scanner command fallback when `FILE_SCAN_MODE=command`; run without a shell |
| `FILE_SCAN_NAME` | Optional stable scanner identifier stored in audit metadata; defaults to a short hash of the configured command |
| `FILE_SCAN_ENV_ALLOWLIST` | Comma-separated environment variables inherited by the scanner process |
| `FILE_SCAN_TIMEOUT_MS` | Scan command timeout in milliseconds (default: `30000`; raise for large PDFs or busy scanners) |
| `CRON_SECRET` | Shared secret for authenticating cron endpoint requests; production requires at least 32 characters |
| `XERO_DAILY_BATCH_LIMIT` | Maximum candidate rows processed by each Xero daily-batch group per run; defaults to 1000 and clamps above 5000 |
| `RATE_LIMIT_BACKEND` | Rate-limit backend for login/TOTP and cron throttles; use `memory` only for single-process installs and `redis` for cluster-wide limits |
| `REDIS_URL` | Redis connection string required when `RATE_LIMIT_BACKEND=redis` |
| `REQUIRE_TRUSTED_PROXY_CONFIG` | Set to `true` on proxied production deployments so preflight fails when `TRUSTED_PROXY_IPS` / `TRUSTED_PROXY_CIDRS` are empty |
| `INVARIANT_CHECK_PAGE_SIZE` | Optional page size for the scheduled invariant check inventory SQL collector. Default `500`; raise temporarily only for production triage. |
| `INVARIANT_CHECK_MAX_FINDINGS` | Optional maximum inventory invariant findings collected by the scheduled invariant check. Default `5000`; when the cap is hit, the report adds a critical truncation finding. |
| `SMTP_HOST` | SMTP server hostname. Install-time seed only - see below |
| `SMTP_PORT` | SMTP server port |
| `SMTP_USER` | SMTP authentication username |
| `SMTP_PASS` | SMTP authentication password |
| `SMTP_FROM_EMAIL` | From address on outgoing mail |
| `SMTP_FROM_NAME` | From name on outgoing mail |
| `SMTP_SECURE` | Encryption: `tls`, `ssl` or `none` |
| `SMTP_REPLY_TO` | Reply-to address on outgoing mail |

The `SMTP_*` variables are an **install-time seed only**. `scripts/provision-instance.mjs` reads
them once and writes them into the `settings` table (`email_smtp_*`); at runtime `lib/mailer.ts`
reads those settings and never the environment. Mail cannot be managed by env - change it in
**Settings > Email**. Xero OAuth client credentials, the base currency, PDF/upload temp
directories and the upload size cap are likewise not environment variables; see `CLAUDE.md` for
where each of those actually lives (o3d-esha).

IMS-session invoice PDF links intentionally bind to the current session and client IP. This limits copied-link replay, but users who switch networks, reconnect a VPN, or resume a tab after their IP changes may need to return to the invoice page and request a fresh link. Customer-facing shopping invoice downloads avoid this IMS session/IP binding by using the shopping platform ownership check plus the short-lived `/api/shopping/{connector}/invoice-pdf` server-to-server handoff.

### Outbound-write hold: which destinations IMS may write to

<!-- outbound-write-hold:overview -->
IMS refuses every request that could change something in WooCommerce, Mintsoft or Xero unless the environment of this installation names the one destination it may write to. The refusal is made at the HTTP boundary that every connector request goes through, on every request and on every redirect hop, and the default is to refuse. The permission is read from environment variables only and never from the database, so a restored backup, a cloned installation or a new checkout does not inherit a permission that was granted to a different installation. A value that cannot be read is not a permission. Reading is never held: only requests that could change something are.
<!-- /outbound-write-hold:overview -->

<!-- outbound-write-hold:grants -->
| Variable | Connector | Value |
|---|---|---|
| `WC_WRITEBACK_ALLOWED_ORIGIN` | WooCommerce | exactly one store origin, for example https://shop.example.com |
| `MINTSOFT_WRITE_ALLOWED` | Mintsoft | the Mintsoft base URL and the ClientId separated by one vertical bar, for example https://api.mintsoft.co.uk|89; to also allow key-minting logins append a third part naming the one username, for example https://api.mintsoft.co.uk|89|login=ims-service |
| `XERO_WRITE_ALLOWED_TENANT` | Xero | exactly one Xero tenant id (a UUID) |

Each variable names exactly one destination. A list, a wildcard, a boolean or a value in any other shape is unreadable and grants nothing. Changing the store URL, the Mintsoft base URL or the Xero organisation in Settings revokes the permission instead of inheriting it, because the comparison is against the destination of the request that is actually being made. Setting a variable changes what the installation may do; it does not start any writer.
<!-- /outbound-write-hold:grants -->

<!-- outbound-write-hold:held-meaning -->
A held write is a hold on this installation and not a rejection by the destination. The request is refused before it leaves IMS, so nothing is sent to the destination, and the work that wanted to write is reported as failed with text that begins "Outbound write HELD". A held write is never recorded as sent, accepted or rejected by the destination. Every such message ends with a short reference in square brackets (`[hold-ref ...]`) that is derived from the settings encryption key of the installation, so every process agrees on it and it survives restarts; it is bound to the exact text it ends, so it cannot be copied onto another message, and IMS does not write hold or error text into anything it sends to a destination: a census test scans every source file for the common shapes of such a write (comment and note writers and free-text payload fields built from a caught error), so a destination should never be sent a text it could echo back. That census is syntactic; it does not follow text through helper functions, closures, object spreads or computed keys. The residual is stated plainly: a person who copies a complete hold text into a free-text field by hand, or a code path of a shape the census does not cover, could put one in front of a destination; the reference prevents only forgery and moving a reference onto other text. It is how IMS tells its own hold text from text a destination sent, within the limits just stated. Without that key no failure is recognised as a hold, and the log says so once. Queues that bound their retries (the WooCommerce and Xero outboxes, the Xero sync log, the Mintsoft order push and the WMS dispatch reconcile) do not spend an attempt on a held write and never dead-letter it, however long the hold lasts: the work stays queued and is offered again every 15 minutes. Pushes that have no queue (the WooCommerce product metadata and WMS status pushes, tracking pushes made outside order completion, and exchange-rate pushes) are not retried by the hold; they are reported in the log and run again at their next trigger. The exception to "nothing was sent" is a redirect: when the destination redirects a request that was granted and the next hop is refused, the first request had already been sent and may have taken effect. That refusal begins "Outbound write REFUSED AFTER A REDIRECT", is not a hold, and is treated like any other failure of unknown outcome: it spends an attempt and can be dead-lettered for an operator to check.

A refused login after an HTTP 401 is a pure hold only when that 401 came straight back from the original request with no redirect followed (Mintsoft rejects an unauthenticated request before it processes it); a 401 after a followed redirect, or whose redirect count is unknown, may follow a request that took effect, so it is handled as an uncertain outcome, not as a hold. A gateway or proxy in front of Mintsoft that answers 401 after Mintsoft processed the request cannot be excluded; that is an accepted inter-system limit. Mintsoft's key-minting login (`POST /api/Auth`, which issues a new tenant API key and invalidates the old one) is a write and is held. While the producer-side hold is enforced for Mintsoft and the installation is not in its live phase, IMS refuses it before sending it, whatever grant is present (reads continue on a stored or fixed key; an expired stored key is not renewed). Otherwise it is granted only by a third part of the Mintsoft variable, `|login=<username>`, and only for requests that carry exactly that username (and the granted ClientId). An installation that authenticates to Mintsoft with a username and password and has no such grant cannot renew its token while held, so its reads stop once the stored token expires; use the fixed API key mode on any installation that is held. Xero's token exchange (`POST https://identity.xero.com/connect/token`, https only, exactly that path, on every redirect hop) is allowed as a deliberate exception: it rotates IMS's own Xero credentials but changes no accounting data, and every Xero read depends on it. Every Xero write must reach `api.xero.com` on every hop; a redirect to any other origin is refused before the body is sent.
<!-- /outbound-write-hold:held-meaning -->

<!-- outbound-write-hold:status-command -->
`npm run outbound:status` answers "is this installation writing to anything?". It reads the environment and the activity log and, only for a destination the producer-side hold is enforced for, the shadow records and the queues (read-only queries); it makes no network call and writes nothing. It prints, for each connector, whether writes are held or granted (and to which destination), whether the grant variable is unreadable, and how many refused writes were logged in the last 24 hours (a lower bound: refusals the rate limit suppressed are added only when the next entry is written). For each destination the producer-side hold is enforced for it also prints the grant and the live-from instant and the phase they establish (P1 held, P2 live), whether the two agree, what every operation of the ownership map decides if work were produced now (LIVE or SHADOW, with the reason and the owner), how many shadows IMS kept (last 24 hours, total, by reason), what is queued (accounting sync rows, outbox jobs, warehouse order links) and what was sent in the last 24 hours, and how much of the queue was created before the live-from instant: work IMS refuses to deliver and that must be retired with `npm run retire:held-backlog` (a dry run unless told otherwise; `--apply` is for a scratch or development database and is never run against a live installation). With the producer-side hold not enforced, none of this is read or printed and the exit codes below are the ones they were before it existed. Pass `--json` for a machine-readable report and `--expect-held` to fail when any connector may write or any operation decides LIVE.

| Exit code | Name | Meaning |
|---|---|---|
| 0 | ok | the report was produced, every grant variable is absent or readable, and the counts were read; a fully held installation is a success |
| 1 | unreadable-grant | a grant variable is set but unreadable, or (for a destination the producer-side hold is enforced for) its live-from variable or the enforcement variable is set but unreadable; it is treated as no grant (held) but it is an operator error to fix |
| 2 | counts-unavailable | the grant states were printed but the recent refusal counts (or, for an enforced destination, the shadow and queue counts) could not be read from the database |
| 3 | usage | an unknown argument was given; nothing was evaluated |
| 4 | expected-held-violated | `--expect-held` was given and at least one connector has a readable grant (IMS may write to something), or at least one operation of an enforced destination decides LIVE |
| 5 | failed | the report could not be produced because of an unexpected error |
| 6 | pre-cutoff-queued | an enforced destination is in its live phase and work queued before its live-from instant is still in a queue (accounting sync rows, outbox jobs or warehouse order links); IMS refuses to deliver all of it, so it must be retired with `npm run retire:held-backlog` |
| 7 | inconsistent | an enforced destination has a grant without a live-from instant, or a live-from instant without a grant; every producer shadows, but the transport and the producers disagree about whether the destination is live |
| 8 | shadow-unrecorded | in the last 24 hours IMS shadowed work and could not keep the record of it (`outbound_shadow_unrecorded` in the activity log); the work was not queued, but evidence of it was lost |
<!-- /outbound-write-hold:status-command -->

### Keeping IMS current during a parallel run: read-sync liveness

<!-- read-sync-liveness:overview -->
During a parallel run IMS only reads from WooCommerce, Mintsoft and Xero, and a feed that has stopped looks exactly like a feed that has nothing new to say. So every read feed records the time of its last SUCCESSFUL run, separately from the time of its last attempt (an attempt that failed does not move it, and a run that legitimately found nothing new does), and a feed whose last success is older than its limit is reported as stale. A stale feed means the data IMS holds from that source may be old; it does not show that any record is wrong.

The `read-sync-liveness` scheduled job (hourly, on by default) raises an admin notification and a WARNING activity entry once per breach for every feed except the Mintsoft stock sync, whose alert is raised by the existing `wms-watchdog` job. A feed that has never recorded a success is only alarmed once its limit has passed since the job first ran, so a fresh deployment does not alarm for a feed that has not yet had its first scheduled run.
<!-- /read-sync-liveness:overview -->

The feeds, when each is expected to complete, what counts as a success and when it is stale:

<!-- read-sync-liveness:streams -->
| Feed | Expected cadence | Counts as a success when | Stale after | Alarm raised by |
|---|---|---|---|---|
| WooCommerce order sweep | daily (the wc-reconcile job; while webhooks are primary the reconcile only runs when 24 hours have passed since the last one, so a daily job completes it every one to two days) | the sweep read WooCommerce to an empty page, imported or skipped every order it returned without an error, and advanced its cursor; a sweep that found no new orders counts | 3 days (two days is the longest healthy gap (a daily job whose 24 hour check lands just short of a day skips one run), and a third day is the first one that is not explained by that) | read-sync-liveness job |
| Mintsoft stock sync | each binding's own sync frequency (default hourly) | the sync read the warehouse stock for the binding and finished its checks (a run with some per-line errors counts as completed, a run that could not read the warehouse does not) | 3 sync intervals, at least 60 minutes (3 of the binding's own intervals and never less than 1 hour, the rule the WMS watchdog has always applied) | WMS watchdog |
| Mintsoft despatch poll | every 15 minutes (the mintsoft-dispatch-sync job; on by default). With a fixed API key it always runs; in username and password mode it declines to run once the stored key has expired, because logging in would replace the tenant key for every integration that shares it | the poll finished with job status SUCCEEDED, which excludes a poll that degraded (a failed delta read, unresolved orders, an unreadable withdrawal screen); a poll with nothing to check counts | 2 hours (eight missed 15 minute polls, long enough to ride out a short Mintsoft outage and short enough to matter on a day of trading) | read-sync-liveness job |
| Mintsoft order-status refresh | every 15 minutes (the wms-order-status job; off by default) | the refresh resolved a connector and a lookup source and read every order it selected without an error; a refresh with no stale orders to read counts, a refresh that was skipped does not | 2 hours (eight missed 15 minute runs, the same reasoning as the despatch poll) | read-sync-liveness job |
| Xero balance-snapshot pull | daily at 01:00 (the account-balance-snapshot job) | the scheduled pull read the Xero trial balance and stored a snapshot for every configured account without an error; an on-demand refresh for one date or one account does not count | 36 hours (a day and a half: one missed daily run is the first thing that is not explained by the schedule) | read-sync-liveness job |
| Xero tax-rate read | hourly (the xero-tax-rate-drift job) | the sweep read the full Xero tax-rate list, validated every row and stored the list with its header row (and its drift result) in one transaction; a sweep that found no drift counts, and a response that was empty, partial or malformed does not | 6 hours (six missed hourly runs, long enough to ride out a Xero outage or rate-limit window) | read-sync-liveness job |
<!-- /read-sync-liveness:streams -->

To check them:

<!-- read-sync-liveness:status-command -->
`npm run read-sync:status` prints every feed with its state (fresh, stale, never succeeded, or off), the time of its last recorded success, its age and its limit. It reads the database only, makes no network call and writes nothing. It also checks that the scheduled jobs it depends on are switched on and have an active entry, exactly as the scheduler would write it, in a complete managed crontab block of the user it runs as (run it as the application user). That covers the alarm job, the job behind each feed that is switched on, and the WMS watchdog while the Mintsoft stock sync is in play. A newly registered job, including the alarm job itself on an upgraded installation, is only scheduled once Settings > System > Scheduler > Save & Apply has been used, and an alarm job that is not scheduled can never alarm. Pass `--json` for a machine-readable report: a JSON object whose `schemaVersion` is 1 and whose `generatedAt` is the ISO time the report was made, followed by the entries (each with `ageMs`, `lastSuccessAt`, `futureTimestamp`), the `counts`, the `scheduler` check and the `exitCode`. A feed is "off" when its plugin or scheduled job is disabled, the connector is not connected, or there is no active binding; an off feed is not keeping IMS current, so it is reported rather than hidden.

| Exit code | Name | Meaning |
|---|---|---|
| 0 | ok | every stream is switched on and last succeeded within its limit |
| 1 | stale | at least one stream that is switched on last succeeded longer ago than its limit (or has a last-success time in the future, which is not believed) |
| 2 | never | at least one stream that is switched on has no successful run recorded; no stream is stale |
| 3 | usage | an unknown argument was given; nothing was evaluated |
| 4 | off | at least one stream is switched off or cannot run (plugin disabled, scheduled job disabled, not connected, no active binding), so it is not keeping IMS current; no stream that is switched on is stale, without a success or unscheduled |
| 5 | failed | the report could not be produced because of an unexpected error; no stream was evaluated |
| 6 | unscheduled | a job this report depends on is switched off, or enabled but without an active entry the scheduler would write in a complete managed crontab block (the alarm job, the job behind a stream that is switched on, and the wms-watchdog job while the stock sync is in play), or the crontab could not be read; a newly registered job is only scheduled by Settings > System > Scheduler > Save & Apply; no stream is stale |
<!-- /read-sync-liveness:status-command -->

Runbook. If a feed is reported stale, first find out which side stopped: look at the scheduled job's last run under Settings > System > Scheduler (or in `cron_runs`), then at the connector's connection and credentials. A feed that is "off" or has "never" succeeded after its limit has passed is not keeping IMS current until that is fixed; any reconciliation or comparison taken meanwhile may be measuring old data, so note the gap alongside its result. The status command and the alarm only read IMS's own database and never contact WooCommerce, Mintsoft or Xero. The `read-sync-liveness` job is a registered scheduled job, so it reaches the crontab through the in-app scheduler sync, not through the installer's bootstrap list or `update.sh`, which leave an existing managed block untouched. **Upgrade step: after deploying this release, open Settings > System > Scheduler and use Save & Apply once** (that is the existing mechanism that writes every enabled registered job into the crontab), then run `npm run read-sync:status` as the application user: it exits 6 while the alarm job, a job behind a feed that is switched on, or (with the Mintsoft stock sync in play) the `wms-watchdog` job is switched off or lacks an active entry, exactly as the scheduler writes it, in a complete managed block. As a backstop that needs no one to remember, the `delivery-status` job (in the installer's bootstrap crontab, so scheduled on every installation) runs the same check every 15 minutes and raises one admin notification, once per distinct problem, when it finds one. It runs in the background and is never waited for, so it cannot delay the delivery-status answer. If the crontab cannot be read by that process it raises a distinct "Scheduler coverage could not be verified" reminder, at most once per UTC day per observer (host and OS user), asking you to run `npm run read-sync:status` as the application user; a process that can read it never clears another observer's reminder. If a process structurally cannot read the crontab, set the setting `read_sync_scheduler_guard_expect_unreadable` to `true` to silence that reminder (real scheduling problems on a readable crontab are still raised). Every database read of the guard runs in a short transaction with a 5 second server-side statement timeout, and at most two guard runs may be unfinished at once; if earlier runs are not completing it raises one "Scheduler coverage check is not completing" notification per stall. The `mintsoft-dispatch-sync` job is registered like the other feeds' jobs, so it reaches the crontab the same way and needs the same one-time Save & Apply on an installation that already has a managed block; until it is in the crontab the despatch poll appears as stale or never-succeeded, and as off if the job is switched off. This feature adds no environment variables.

### Producer-side hold: LIVE or SHADOW for each unit of work

<!-- producer-disposition:overview -->
THE PRODUCER-SIDE HOLD IS ENFORCED ONLY FOR THE DESTINATIONS NAMED IN `PRODUCER_HOLD_ENFORCED_DESTINATIONS`, WHICH IS UNSET BY DEFAULT. Unset, every producer queues work exactly as it did before the decision existed, and the only barrier is the outbound-write hold above, which reads a grant on its own: a destination whose grant is set permits the outbound writes through the transport whether or not the live-from variable below is set. Today the Xero producers, the WooCommerce producers and the Mintsoft producers consult the decision, and `npm run outbound:status` reports on it for every destination it is enforced for. The Xero producers are every place IMS creates an accounting sync log row and the direct tax-rate creation from Settings; the one sync log type whose destination is WooCommerce, the invoice note, follows the WooCommerce setting. The WooCommerce producers are every stock push (the queue, the daily reconcile, the manual push and a webhook correction), the order completion, cancel and hold jobs, tracking, partial shipments, the WMS-status meta, product metadata, FX rates and the FX helper probe, and the registration of webhooks. The Mintsoft producers are every place IMS creates, amends, holds or cancels a warehouse order (the order-push sweep, and the two operator buttons that re-arm a create), posts a note on a warehouse order (the sweep's notes and the refund note), upserts a product or sends its descriptions and picture, creates a bundle, or creates an ASN.

For each destination and operation the decision is LIVE or SHADOW. It is LIVE only when every one of these holds, and SHADOW otherwise: the outbound-write grant for the destination is readable; the live-from variable for the destination is set and readable; the current time is at or after it; the ownership map says IMS owns that operation in the installation phase that follows from the two; and the time of the business event is at or after the live-from instant (an operation whose ownership-map row requires that time is SHADOW when the producer does not supply it). A value that is absent, unreadable or inconsistent is never LIVE. There is no phase setting: an installation is in its live phase for a destination exactly when the grant and the live-from instant are both in force, so a restored backup, a clone or a new checkout never inherits it. The decision itself reads the environment only: no database and no network call.

A SHADOW is the record of what IMS would have written, kept instead of queuing the work; it is never delivered later. For Xero a shadow is a row in the accounting sync log that is CANCELLED with the settlement basis `HELD_SHADOW`, plus a row in `outbound_shadow_writes` (one per distinct piece of work, counting repeats). A shadow has no outbox job, is never given an accounting event, and has its own ledger standing (shadow, not sent by IMS) that is NOT proof the document is absent from Xero: it says nothing about whether the owner of the operation wrote it, so deleting, reversing or refunding over it is refused as unproven. A destination whose enforcement is on and whose grant and live-from instant are both unset therefore queues nothing new: every Xero write IMS would have produced becomes a shadow. For WooCommerce a shadow is the `outbound_shadow_writes` row alone (there is no sync log row): nothing is queued, no outbox job exists, nothing is sent, and the result the caller gets is its own `shadowed` outcome, which is not queued, not sent and not a failure to retry. A push the hold shadowed is never stamped as pushed (the stock echo-suppression record, the WMS-status record and the daily stock reconcile stamp are left alone), and an order that ships, cancels or goes on hold commits exactly as it would without the storefront job. The queue drains for WooCommerce stock, order completion and order cancel and hold stand down while the hold stands: they claim nothing and spend no attempt, so a job queued before enforcement was switched on stays as it is and is never sent. The transport helpers (the REST POST and PUT, the FX push and probe, the partial-shipment push) refuse as a last barrier. For Mintsoft a shadow is likewise the `outbound_shadow_writes` row alone: no order link is created, claimed, stamped or moved (the order is simply offered again on the next sweep), no ASN reservation or sync job is made, no product or bundle is marked as synced or claimed, and the result the caller gets is its own `shadowed` outcome, which is not created, not queued and not a failure to retry. The sweep passes that only re-open a create (releasing a held order, revalidating a failed one, re-queuing an unknown create) stand down while the warehouse is held, and a link that is waiting for its ownership to be proved, or is parked as an unknown create, is never turned into a shadow. Every Mintsoft write method needs a clearance that only the producer decision can give, and the Mintsoft transport refuses any write as a last barrier in the wording of the outbound-write hold, so a queue that recognises a hold spends no attempt on it and a held write cannot even renew a key.

A grant without a live-from instant, or a live-from instant without a grant, is inconsistent: the decision is SHADOW, while the transport still allows the writes of a granted destination, and `npm run outbound:status` reports it (exit code `inconsistent`). Never move a live-from instant earlier once work has been produced after it: that is the only change that lets work from before the move reach the destination.

THE WRITER-SIDE CUT-OFF. Work that already exists when a destination goes live belongs to the writer that owned the destination until then, so once enforcement is on for a destination and it is in its live phase (the grant and the live-from instant both in force, the instant reached) IMS never delivers a queued row created before the live-from instant, whatever its status and however it is re-queued. For Xero, the claim of an accounting sync row carries the instant in its own statement (a row created earlier is not claimed), the queue processor does not even select such rows, no delivery job is created for them, a job that reaches the processor for one is dead-lettered with the operator text, the processor asks again immediately before it sends, and the manual re-queue of a failed row, the daily-batch reset and the revival of a failed follow-up each decline to make such a row claimable again (a declined follow-up revival creates a new row, which the decision judges on its own business-event time). For the outbox, the claim of a job of a destination (WooCommerce and Xero; Mintsoft has none today) excludes a job created before the instant, in the selection and in the claim statement, so a bounded oldest-first batch of them can never starve the jobs behind it; a job whose effect is local is never excluded; an operator replay of such a job is refused; and the one job a product keeps for ever (its stock push) is re-dated when a live producer re-arms it, because that is a new push of the current stock and not the old job. For Mintsoft, the create, amend, recovery and not-pushed detection already stop at the order's paid time. It is asked again immediately before every write a claimed job makes, not only when the job is claimed: each WooCommerce drain parks a job older than the instant without sending (in one statement keyed on its own claim), asks again before its tracking, status and stock writes, and the Xero claim proof taken before every remote write carries the floor of that moment. The instant is read from the environment at each of these decisions and cached nowhere, and with the switch off none of it applies.

Queued work that predates the instant is not left in the queues looking like work that is owed: `npm run retire:held-backlog` takes it out. It is a dry run unless given `--apply --confirm-database <identity>` (the server identity the dry run prints) and is for a scratch or development database, never a live installation. It retires a row as a SHADOW (an accounting sync row becomes CANCELLED with the settlement basis `HELD_SHADOW`; an outbox job becomes `SHADOWED`; a queued Mintsoft order link is removed, with a shadow record) only when the row itself proves that no attempt to send it was ever made: a sync row that was never claimed or retried and was queued in attempt-stamping custody (or a money row in custody with no remote attempt), with no document id and no create-dispatch marker; an outbox job that was never claimed or changed, or whose only recorded outcome is a refusal by the outbound-write hold; a Mintsoft link with no attempt, attempt time or error. For outbox jobs and Mintsoft links that proof also needs a durable history that a replay, a re-arm or a release cannot erase (the job's first-attempt stamp, the link's first-claim stamp, each written when the unit is first claimed, before any request can leave): a unit created before that history existed, or whose stamp is set, is parked, because its visible attempt counters may have been reset. A claim refused by the outbound-write hold withdraws its own stamp only when a count of the writes the transport dispatched in that claim (a completion sends tracking before its status) proves it sent nothing; a claim that sent anything, or ran outside the count, keeps the stamp and is parked. The database enforces that history for every writer, including an older binary during a rollback or a mixed-version deploy: a claim that does not stamp itself makes the row unknown (parked), and the tracked flag can never be switched back on by an update. The mirrored accounting event of a retired sync row is left untouched whenever another attempt at the same document is live or has an unverified outcome, whatever its status, and the retirement says so. Every other row is PARKED, not shadowed, with the text `outcome unknown: check <destination> before acting` (a sync row becomes FAILED, an outbox job PERMANENT_FAILED, a Mintsoft link AMBIGUOUS_CREATE), because the record cannot say it was never sent and IMS does not claim it. A row a worker holds right now is skipped and left for the next run. The command, its arguments and its exit codes are described in the section on retiring the held backlog.
<!-- /producer-disposition:overview -->

Retention and the shadow record: a shadow's sync-log row expires with the sync-log retention window (it holds no ledger claim), but the `outbound_shadow_writes` record does not, and the readers that would destroy the local record of a document (the sales-order hard delete, an edit of a posted stock movement, a stored invoice-number correction) go on refusing from that record after the row is gone; the payment-receipt retract is the one known reader that cannot yet do so (tracked). With enforcement OFF the daily-batch re-queue runs its original statement unchanged.

<!-- producer-disposition:cutoffs -->
| Variable | Destination | Value |
|---|---|---|
| `WC_WRITES_LIVE_FROM` | WooCommerce | one UTC instant in ISO-8601 with an explicit Z, for example 2026-12-01T00:00:00Z |
| `MINTSOFT_WRITES_LIVE_FROM` | Mintsoft | one UTC instant in ISO-8601 with an explicit Z, for example 2026-12-01T00:00:00Z |
| `XERO_WRITES_LIVE_FROM` | Xero | one UTC instant in ISO-8601 with an explicit Z, for example 2026-12-01T00:00:00Z |

Each variable names one instant. A date without a time, a time without the Z, an offset such as +01:00, precision finer than a millisecond, surrounding whitespace, a list or any other shape is unreadable, and the decision for that destination is SHADOW. A destination needs its outbound-write grant as well as its live-from instant before the decision can be LIVE, and the ownership map decides which operations IMS may produce. A variable has an effect only for a destination named in `PRODUCER_HOLD_ENFORCED_DESTINATIONS`.
<!-- /producer-disposition:cutoffs -->

<!-- producer-disposition:enforcement -->
| Variable | Value |
|---|---|
| `PRODUCER_HOLD_ENFORCED_DESTINATIONS` | a comma-separated list of destinations from xero, mintsoft and woocommerce, or all; unset or empty enforces nothing |

Names the destinations whose producers obey the decision. A destination that is named obeys it for every operation; one that is not named is untouched. A value that is not a list of known destinations or `all` (a misspelling, a destination that does not exist) enforces EVERY destination, because a typo must not leave a hold off. Switching it on for Xero on an installation with no grant and no live-from instant makes every new Xero write a shadow and stops the Xero queue from receiving new work; switching it off again does not recover shadows, which are records and not queued work. Switching it on for Mintsoft on an installation with no grant and no live-from instant makes every Mintsoft write IMS would have produced a shadow (orders, amendments, holds, cancellations, notes, products, bundles, ASNs and product content), stops the order-push sweep from creating or re-opening anything, and refuses the buttons that re-arm a create; reads, the despatch poll and the stock alignment are not affected; key minting (POST /api/Auth, which replaces the tenant API key every other integration uses) is refused with a hold text, before anything is sent, until the installation is in its live phase (an installation on a fixed API key is unaffected). Switching it on for WooCommerce on an installation with no grant and no live-from instant makes every WooCommerce write IMS would have produced a shadow, queues nothing new for the store, and stops the WooCommerce queue drains; the forced stock push stays behind the stock-sync setting as before.
<!-- /producer-disposition:enforcement -->

#### Retiring the held backlog

<!-- producer-disposition:retirement -->
`npm run retire:held-backlog [-- --destination xero|mintsoft|woocommerce|all] [-- --cutoff <UTC instant with Z>] [-- --all-queued] [-- --limit N] [-- --json]` reads the queues and prints what each queued row would become. It prints the identity of the server it is connected to (`<database>@<cluster system identifier>`; a database name alone does not identify a server, since a live and a scratch cluster can share one). It changes nothing unless it is also given `--apply --confirm-database <identity>` with exactly that token; the identity is checked again on the connection of every row's transaction, and an identity that cannot be read refuses the apply. The identity names the cluster's lineage, not the environment: a physical clone or a promoted replica of another server shares it, so a stage clone of a live server prints the same token. The dry run therefore also prints the host and port (or socket) it is connected to, and the operator must check that they are the server they mean to change before applying; the token cannot prove that. The apply is for a scratch or development database, run deliberately, and is never run against a live installation. Which rows: those queued before a destination's live-from instant (`--cutoff` for every selected destination, otherwise the destination's own live-from variable when it is readable), or every queued row with `--all-queued`, which IGNORES any cut-off in the plan and the apply and says so in its report; a destination with neither selects nothing. Each row is retired in its own transaction after being read again and classified again, and is changed only if it is still exactly what was classified, so a row a worker claimed or settled in between, or that a live producer re-dated or re-armed (a product's stock job), is left alone and reported as changed since planning. Each row is locked, its destination, operation and creation time (or the order's paid time) are checked against the effective cut-off again, and the final write repeats them. A row is SHADOWED only when its own record proves no attempt to send it was made; every other row is PARKED with `outcome unknown: check <destination> before acting`; a row a worker holds right now is skipped. The accounting event that mirrors a retired sync row is voided (not revivable) only when no other attempt at the same document is live, and marked failed when the row is parked.

| Exit code | Name | Meaning |
|---|---|---|
| 0 | ok | the plan was produced (dry run), or every selected row was retired or parked; a dry run changes nothing |
| 1 | incomplete | the run finished but left work: a list was truncated by `--limit`, a row changed while it was being retired, or a row was skipped because a worker held it; run it again |
| 2 | nothing-in-scope | no destination had a cut-off (`--cutoff`, or a readable live-from variable) and `--all-queued` was not given, so nothing was selected |
| 3 | usage | an unknown or malformed argument, or `--apply` without `--confirm-database`; nothing was read or changed |
| 4 | apply-refused | `--confirm-database` does not equal the server identity of the connection (or the identity cannot be read); nothing was changed |
| 5 | failed | an unexpected error; some rows may have been retired (each row is its own transaction) and the next dry run says which |
<!-- /producer-disposition:retirement -->

#### Checking that two writers do not share a destination

<!-- producer-disposition:writers-check -->
`npm run writers:check [-- --window-days N] [-- --json]` is the coexistence interlock: it fails (non-zero) when two writers claim one destination operation in the current phase. It is read-only: it reads the environment and IMS's own database, makes no call to Xero, Mintsoft or WooCommerce, and writes nothing. For every operation in the ownership map it works out whether IMS could write it right now (the operation's settings, the plugin switch and the destination's grant all on, and, for a destination named in the enforcement variable, a producer decision that is not SHADOW), and compares that with the owner the map gives for the installation's current phase and with the incumbent evidence IMS holds. It fails when IMS can write an operation that another writer owns (an operation reached only by an operator button is a warning, stated in the report, while the map gives it to the operator, and fails like any other once the map gives it to another writer) (or that nobody has decided: an `unknown` owner), when the ownership map gives IMS an operation it must never own (the Xero sales documents), and when IMS can create a Mintsoft order while orders paid since the live-from instant still carry the bridge plugin's warehouse-order id. Evidence older than the live-from instant, or (with no instant) older than the window (default 14 days, `--window-days`), is not counted, nor is anything dated after the moment the report is taken, and an order with no readable paid time is reported but never counted, because IMS cannot create an unpaid order.

| Exit code | Name | Meaning |
|---|---|---|
| 0 | ok | no double claim was found in the evidence IMS holds; this is not proof that none exists (see what the check cannot see) |
| 1 | double-claim | two writers claim one destination operation in the current phase (IMS can write it while another writer owns it or is seen writing it), or the ownership map gives IMS a row it must never own |
| 2 | unreadable | a grant, a live-from instant or the enforcement variable is set but cannot be read, a destination has a grant without a live-from instant or a live-from instant without a grant, the evidence table holds a row of a kind this version does not know, or the settings or the evidence could not be read; no verdict can be given |
| 3 | usage | an unknown or malformed argument; nothing was read |
| 4 | evidence-gap | the storefront import could not keep some incumbent evidence in the window (its own log entries say how many); the check is blind to those orders |
| 5 | failed | an unexpected error; no verdict was reached, so treat it as a failure |

WHAT IT CAN SEE: the ownership map and the phase each destination is in, from the grant and the live-from instant; whether IMS itself could write each mapped operation right now: the settings, the plugin switches, the grant and the producer decision (a schedule being off is not counted as a barrier: the scheduled route does not check it and stays callable by an authenticated request); the bridge plugin's warehouse-order metas and the invoicing plugin's markers on storefront orders that IMS imported (kept at import, with the paid time, values never stored); invoice numbers Xero reported as held by a document IMS does not own, at the moment IMS tried to post under them.

WHAT IT CANNOT SEE: an incumbent's activity that leaves no trace IMS reads: a write an incumbent makes without a mark on an imported order or a refusal IMS provoked is invisible, and a green result says nothing about it; any order IMS has not imported (its metas are unseen until the order is imported), and any change to an order's metas after its last import; what Qoblex, Aelia, an operator working by hand or a Mintsoft channel writes: they leave no evidence IMS reads, so for their operations only the ownership map and IMS's own switches are checked; an order whose evidence write did not finish: the import does not wait for it, so a write that timed out and could not log that it did, or that was still running when the process stopped, leaves no trace; anything that changes after the report was taken: the check is a snapshot that detects a shared destination, it does not stop either writer, so only the periodic record narrows the gap; Xero documents that IMS never tried to post under (no new Xero call is made: the check reads only IMS's own database and environment). Every report prints both lists.

The `writers-check` scheduled job (off by default) records the same report as JSON in the activity log (action `writers_check_recorded`) each time it runs, and the run is red when the verdict is not ok. Counts only appear in the report: it carries no order id, invoice number or other data key.
<!-- /producer-disposition:writers-check -->

### Readers of sync rows under a shadow

A shadow is not a queued, a sent or a failed outcome, and for two of the three destinations it is not a row at all (WooCommerce and Mintsoft keep only the `outbound_shadow_writes` record). Every place that decides from the PRESENCE or ABSENCE of a sync row, an outbox job, a warehouse link, a storefront sync log or a daily-batch stamp can therefore misread one: as "pending" or "stale" (a false alarm), as "sent" or "done" (a stamp read as success), as a failure to retry (a control offered for work that is only a record), or as "missing" (a finding about a row the hold deliberately never makes). The audit of those readers is enforced, not written once:

`npm run check:shadow-readers` (part of `npm run check:all`, and `tests/scripts/shadow-reader-census.test.ts`) finds every such reader by syntax tree and fails when one is not declared in `scripts/shadow-reader-declarations.ts`, when a declaration matches no site, or when the number of readers in a function moves. A reader is a read of the accounting sync log, the integration outbox, the warehouse order push link, the warehouse product, bundle and ASN tables, the stock-sync state and job tables, the storefront sync log, the durable shadow table, or an order's daily-batch stamp columns (a write is not a reader). Each declaration has a class and a reason: `SHADOW_AWARE` (it reads a shadow as its own state, or leaves it out of a question it cannot answer), `SHADOW_NEUTRAL` (a shadow cannot reach it or changes nothing it decides; the reason is one of a closed set of forms: the status filter excludes a shadow, a claim or drain of queued work, a read by id, inbound state, an existence check where a shadow occupying the slot is the intended answer, an absence that decides nothing, a write fenced on a value it observed, or test support), `FIXED` (this audit made it shadow-aware) or `OPEN_FINDING` (it still misreports and is listed below). Adding a reader means adding its declaration with the reason, and the reason is where the questions below are asked.

| Question asked of every reader | Where it was found wrong, and what the reader does now |
|---|---|
| Does a bounded, oldest-first or rotating queue keep a shadow (or a row that can never be delivered) selectable for ever, crowding out real work? | The held warehouse create pass re-shadowed the same oldest batch every tick, so later orders never got a shadow record: it now walks the candidates by a rotating id cursor (a setting) while the hold stands. A withdrawn order whose hold or cancel was shadowed stayed at the head of the verify queue: only its rotation stamp moves. A held storefront sales invoice whose release was shadowed was retried forever and consumed the sweep limit: it is closed. The Xero payment and update ordering reads waited behind a pending row created before the live-from instant, which can never be claimed: such a row is no longer earlier work (a row in flight still is). |
| Is a decision re-derived under the lock or in the write, not carried from an earlier read? | The cut-off for the locked payment claim is read inside the order lock, at the decision. The warehouse reconcile reads the hold at each pass and again where it closes findings. The delete guard asks for the warehouse shadow inside the same transaction that holds the order lock. |
| Does an item from before the live-from instant produce a false finding or display state? | Rows queued before the instant sit pending for ever until `npm run retire:held-backlog` runs: the admin outbox list now marks them (`beforeCutoff`) and leaves them out of the oldest-pending view; the Xero ordering reads ignore them. |
| Does unreadable or missing state read as fine? | The refund relief arithmetic counted relief "from its own record" once retention deleted a shadowed reversal journal; the durable shadow record that names the expired row (or the refund) now keeps it unresolved, and a client that cannot ask throws. The delete guard's warehouse check also throws rather than reading "could not ask" as "none". |
| Does an aggregate stand in for a per-record identity? | The settlement verdict took the latest payment row per document; a shadowed row is now its own answer and no longer reads as a payment the ledger names or an attempt IMS made. The latest daily batch on the health page is labelled as a shadow. |

What was changed, by reader (switch off is byte-identical for every one: the new behaviour needs a shadow, a pre-cutoff row, or the enforced hold):

| Reader | Misreport under a shadow | Now |
|---|---|---|
| warehouse reconcile, "not pushed" drift | every paid order reported as not pushed while the hold stands (no link is ever written) | no drift is detected while held; open findings are closed with an explicit held disposition |
| exception inbox and order chip, warehouse Replay / Retry | offered for a dead letter the action always refuses (held, or paid before the live-from instant) | the affordance takes the same producer facts as the action |
| sales order hard delete | "no push link" read as nothing was called, though the bridge may have created the warehouse order | a durable warehouse shadow record blocks the delete, whatever the enforcement switch says |
| held storefront sales invoice release | a shadowed release read as "queued nothing", left the hold pending, and recorded a posting refusal telling the operator to raise the invoice by hand | the hold is closed with its own sentence; no refusal |
| daily-batch rebuild sweep | every shadowed batch reported each run as a refused rebuild with a re-post instruction | a shadow blocks the rebuild quietly |
| reconciliation | every order in a shadowed batch reported as missing its mirrored event | a posting recorded as a shadow is not reported as missing an event |
| payment and bill settlement verdict | a shadowed registration reported as a ledger discrepancy | its own non-discrepancy verdict that says IMS did not send it |
| health page, latest accounting batch | a bare `CANCELLED` | `SHADOWED (not sent by IMS ...)` |
| refund relief | an expired shadowed reversal journal counted as relief from the record | stays unresolved while the durable record exists |
| refund transit sub-ledger row (`recordRefundTransitFromSync`) | a shadowed COGS reversal for an in-transit refund would add a Stock in Transit movement the ledger never makes, and the daily transit reconciliation would flag it for ever | no row is written for a shadowed journal (it reads the enqueue's whole answer, not a bare boolean) |
| Group A2 debit reason, delete guard batch sentence | a shadow described as an abandoned or operator-settled row | its own wording |
| bundle sync, ASN state readers | a durable conflict about component links that the held product writes never made; a Create control offered then refused | skipped with a held reason; the control is blocked with the shadow sentence |
| outbox re-arm of a Xero job | a job the retirement SHADOWED was re-armed to pending | the retirement record is kept |

Which of these reads depend on the enforcement switch, and which must not. Evidence that has to outlive a change of the switch is read from the durable record (or the row it names) whatever the environment says; a read that only decides what to DISPLAY or whether to PRODUCE follows the environment.

| Reader | Reads | Follows the switch? | Why |
|---|---|---|---|
| order hard delete (accounting and warehouse shadows) | durable `outbound_shadow_writes`, under the order lock | no | a recorded shadow still refuses after enforcement is turned off: the owner of the operation may have created the document or the warehouse order; an order with no record deletes as before |
| order hard delete, a held create whose shadow could not be recorded | the order itself (paid), no push link, no record | follows the hold, fail-closed | the record is best-effort and a held create writes no link, so a transient failure leaves a paid order with neither; while the warehouse is held the delete is refused for such an order (it cannot be told from one the bridge created); unpaid orders, the switch off and the live phase keep the legacy answer |
| held create pass, a create whose shadow could not be recorded | the seam's `recorded` answer | follows the hold | a create is handled only once its record exists: an unrecorded one is counted apart (`shadowUnrecorded`), logged as `shadow_create_unrecorded`, left without a link and offered again next pass, while the rest of the batch and the rotating cursor carry on; the delete guard's refusal for a paid order with neither link nor record stays as defence in depth while the hold stands |
| order hard delete, switch turned off while a held create is being recorded | the durable record, read under the order lock | accepted limit | the held create writes its record outside the order lock, so an operator turning the hold OFF between one sweep's decision and its record write, with a delete of the same order in that same instant, can delete the order and have a record written for a deleted order; operator rule below |
| refund relief, expired shadowed journal | durable record naming the row or the refund | no | retention deleted the row, the record did not |
| settlement verdict, health label, daily-batch rebuild verdict, reconciliation, A2 debit reason | the sync row's own standing | no | a shadow row is read as a shadow whatever the switch says (the row expires with retention; the rebuild window is retention-bounded) |
| warehouse replay affordance, warehouse reconcile, ASN state, bundle sync | the environment | yes | they decide whether IMS would produce the write now; with the hold off the legacy behaviour is correct |
| held create pass, verify queue | the environment (cursor only while held) | yes | production behaviour of the sweep |
| held storefront invoice release | the facade's answer at release time | n/a | the hold is closed once, with its own sentence, and stays closed |

The same best-effort recording applies to every shadow (hold, cancel and amend of an already-linked order, products, bundles, ASNs, notes): a failed write loses the evidence record only. None of those can be destroyed by an IMS action that reads the missing record as clean: a linked order is protected by its link, and the product, bundle and ASN readers do not decide from the record. The one reader that did, the order hard delete, now refuses when the record is missing under the hold.

Accepted residual: the held create writes its record without taking the order lock, while the delete guard reads the record under it. If an operator turns `PRODUCER_HOLD_ENFORCED_DESTINATIONS` off in the milliseconds between a sweep deciding to shadow an order and committing that record, and the same order is deleted in that window, the order can be deleted and a record then exists for an order that is gone. This needs a deliberate rollback and a coincident delete; the create pass itself re-derives its decision under the order lock. Operator rule: after turning the hold OFF, run `npm run outbound:status` (its shadow-unrecorded count surfaces any leftovers) and do not delete orders until a full order-push sweep has completed.

Open findings (misreports not fixed here, all only while a hold is enforced; the census pins their number): `queueAccountingSyncTx` classifies a shadow as no prior attempt, so after the hold is switched off the same posting is created live beside the shadow (a design decision about what a shadow occupies); `computePreview` and `runDailyBatchSync` report a shadowed unearned-revenue reversal as "cancelled but may have posted" while the true-up is itself shadowed; `applyWcCouponCorrection`, `wcCouponCorrectionNeedsLedgerAdjustment`, `buildWcCouponLedgerHandoff` and the `report` of the coupon back-fill CLI treat a shadowed revenue-deferral batch as a posted journal in their hand-off text and, for a pre-cutoff pending batch row, decline for ever; `evaluateAccountingInvariantRows` can report a standing critical for an order stamped by a shadowed batch whose chargeback credit note was shadowed; `reverseOrphanedAllocationPosting` tells the operator to post a reversal by hand for a shadowed Group A2 journal (the proof refuses correctly, and no shadow of the reversal is recorded); `getOpenAsnPendingQty` and `processBookedInEvent` do not know of warehouse ASNs made by hand while ASN creation is shadowed, so a downward stock alignment is not held for receipt timing and a booked-in callback for such an ASN ends as a dead receipt event. Also noted, not shadow defects: the daily-batch history page shows the oldest row of a date and type, and the credit-note allocation sweep examines the oldest 200 credit notes only.



### Connection pooling in front of `DATABASE_URL` is not supported

**IMS does not support a transaction-pooling proxy — PgBouncer `pool_mode = transaction`, Odyssey
`pool "transaction"`, pgcat, RDS Proxy, a provider's "pooled" port — in front of `DATABASE_URL`, and
supporting one is not planned.** Point `DATABASE_URL` at PostgreSQL itself. `DATABASE_SESSION_LOCK_URL`
is **not** a way to make a pooled `DATABASE_URL` supported: it is the route past a pooler (or past a
Unix-domain socket, where directness is unprovable) for the lock connections **only**, and it says
nothing about the data path.

**Why.** The application takes PostgreSQL **session** advisory locks around work that must not happen
twice: the money post (a ledger read and the external payment that follows it), the Xero payment write,
the WMS dispatch sweep and the backup-restore selection lock. A session advisory lock belongs to one
PostgreSQL **backend session**, and **pooling destroys the affinity** between the IMS client that took
the lock and the session that holds it. That much is true of every pooler. What becomes of the lock
itself is **per implementation, not a property of pooling**: returning a backend to a transaction pool
does not by itself end its PostgreSQL session, so a pooler may reset or discard the server connection
and thereby **release** the lock, or it may **leave the lock attached** to a backend it then hands to
another client — where it silently suppresses that client's work, or makes it the accidental owner of
an exclusion it never asked for. This repository's own code says the second half out loud:
`lib/db/database-url-schema.mjs` explains that through a transaction pooler a *session* lock would be
left on a server connection that is then handed to somebody else, which is exactly why the override
probe takes a **transaction-level** lock instead. Measured rather than assumed, and **attributed rather
than generalised**: **PgBouncer 1.24.1** in `pool_mode = transaction` multiplexed **one** client
connection across **two** backends (pids `…721` and `…722`) within a single client connection, and
**Odyssey 1.5.3-rc1** in transaction-pooling mode answered two clients' `pg_try_advisory_lock()` on the
same key with `true` for **both** while `pg_locks` showed neither held it — that immediate release is
what **Odyssey 1.5.3-rc1 did on this configuration**, and is not what every pooler does. Either outcome
breaks the lock; for the released case, and for the money-post lock, it is the same document paid
twice, with no other symptom. Separately, the schema pin travels as a libpq startup
`options=-c search_path=…`, which PgBouncer either rejects outright (`FATAL: unsupported startup
parameter in options: search_path`) or — where an operator has listed it in `ignore_startup_parameters`
or `track_extra_parameters` — accepts and then **silently discards**, also measured: behind such a
pooler the schema the application believes it pinned is not the schema the backend resolves.

**What is enforced today, and where a pooled deployment hits it.** Every connection that will take a
session advisory lock is built through `lib/db/session-lock-pool.ts`, which proves —
**unconditionally, on every schema** — that the backend answering it sits on the other end of this
process's own socket. Anything that terminated the client connection and opened its own, which is what
every pooler must do in order to multiplex, is named and **refused**. So a transaction-pooled
deployment is refused at the **first session-lock acquisition** — whichever acquisition reaches one
first, in any of the **four lock domains** this repository takes a session advisory lock in:

| Lock domain | Held by | Reached from |
| --- | --- | --- |
| Money post | `lib/db/pinned-advisory-lock.ts` | The money post itself — reached from the accounting sync processor and from operator-triggered settlement actions — and the daily accounting batch, which runs on the same holder |
| Xero payment write | `lib/connectors/xero/payment-write-lock.ts` | The Xero payment poller and apply-mode payment reconciliation |
| WMS dispatch sweep | `lib/domain/wms/dispatch-sweep-lock.ts` | The dispatch sweep, and the operator actions that mutate dispatch state under it |
| Restore selection | `app/api/backup/restore/route.ts` | A restore |

This is deliberately a map of the **domains**, not a roll-call of jobs. Most of these domains have
**several callers** — scheduled cron jobs, operator actions in the UI and API routes all reach them —
and callers are added over time, so *any* acquisition in *any* domain produces the refusal and no
list of jobs here would stay complete. The four domains are what is maintained instead:
`tests/db/guarded-pool-routing.test.ts` fails the build on a fifth holder, so a new lock cannot appear
without appearing here. It fails
**closed and loud**, naming `DATABASE_SESSION_LOCK_URL` as the thing an operator can change, rather
than quietly paying a document twice.

**What is not detected.** The ordinary data path attaches no such hook on an ASCII schema, by design —
the check costs a round trip per new physical connection, and ordinary traffic is not slowed by it. A
pooled deployment that the pooler itself admits therefore **boots and serves** normally, and reaches
the refusal only at the first session-lock acquisition — and **scheduled** work acquires these locks
in three of the four domains (the daily accounting batches, the Xero payment poller and reconciler,
the WMS dispatch sweep all run on cron), so the first refusal may well be a cron run nobody was
watching rather than an operator's money post. What the check detects is **interposition**,
not the pooling **mode**: a `pool_mode` cannot be read from an ordinary SQL connection, so a
*session*-mode pooler is refused on the same evidence, and a plain TCP NAT or port-forward is refused
too. **A worked example of that last case, because this repository's own CI ran into it:** GitHub
Actions publishes a PostgreSQL *service container's* port on the runner, and `docker-proxy` carries
the connection — it terminates the client socket and opens its own, so the backend names
`172.18.0.1:<proxy port>` as its client while the process's own socket is `127.0.0.1:<our port>`, and
every session lock is refused. The way out is the one below rather than a weaker check: the
container's **own bridge address** is a direct route, because host-to-container traffic leaves via
the bridge interface and Docker's `MASQUERADE` rule excludes it, so the backend sees this process's
socket byte for byte. `DATABASE_SESSION_LOCK_URL` pointed there — same server, same database, same
schema — passes both the peer comparison and the shared-lock-space measurement; see the
`fresh-db-drift` job in `.github/workflows/schema-guardrails.yml` for the shape. The same applies to
any published container port, Docker Desktop's VM port forward included.
Setting `DATABASE_SESSION_LOCK_URL` to a direct URL takes the lock connections past the pooler and
with them the refusal — the data path stays pooled, stays unsupported, and nothing reports it. Over a
**Unix-domain socket** the backend names no peer at all (`client_addr` NULL, `client_port` -1), which
was measured indistinguishable from Odyssey pooling over the same transport, so directness cannot be
shown there and the lock connection is refused rather than skipped.

None of this makes a session advisory lock a sufficient exclusion for money movement on a **direct**
connection either: the lock still ends with its connection, so a dropped socket, a server restart or a
`pg_terminate_backend` between the last check and the remote system accepting the request frees it
**mid-post** — no pooler required — and a second worker can then take the same lock and post the same
document. **That window is open in this release.** No lock can close it, because a lock ends before the
remote system has answered; what would close it is **connector-side idempotency on the post itself**,
and that is **not implemented here** — it is the lever, not a protection already in place. It is
tracked as **o3d-ic9a (P1)**, which is **accepted and unresolved**: a known gap this release carries
deliberately rather than one it has fixed.

### Settings Encryption Key Rotation

Sensitive connector settings are stored as AES-256-GCM ciphertext when `SETTINGS_ENCRYPTION_KEY` is configured. The key must be exactly 32 raw bytes, or a base64 value that decodes to 32 bytes; ad-hoc strings are rejected rather than hashed into fallback keys. Current Setting-table ciphertexts use the `enc:setting:v1:` prefix and are authenticated against the setting key, so a ciphertext copied from one setting cannot be replayed into another setting. Existing plaintext settings remain readable and are lazily rewritten in encrypted form when read or saved. Older `enc:v1` values encrypted with `ENCRYPTION_KEY` also remain readable while that legacy fallback is set, but `ENCRYPTION_KEY` must follow the same 32-byte key-shape rule. If an existing install ever used an ad-hoc legacy key, follow `docs/encryption-key-migration.md` before deploying a strict key-shape build.

Run a one-shot migration after deploying the key to avoid waiting for low-traffic settings to be read:

```bash
npm run cli -- migrate-encrypted-settings
```

Environment variables for connector secrets take precedence over database settings — for the connectors that still have an environment fallback (`WC_WEBHOOK_SECRET`, `WC_INVOICE_PDF_SECRET`, the Mintsoft credentials). When such a variable is non-empty, the connector uses that value even if an operator saves a different value in the UI. Clear the environment variable and restart the app to use the database value. The connector settings UI shows a warning banner when an environment override is active.

`WC_CONSUMER_KEY` and `WC_CONSUMER_SECRET` are **not** in that group. They are install-time **seeds**: `scripts/provision-instance.mjs` writes them into the settings table only if no value is there yet, and Settings → Sync → WooCommerce → Connection owns them from then on. Editing them in `.env` after installation changes nothing — rotate the credential in the UI. (Environment precedence was removed because it was only half applied: the order import followed the environment while the stock and product syncs followed the database, so a stale `.env` secret made one installation talk to WooCommerce under two different credentials.)

`WC_STORE_URL` is never read at runtime either. The live store URL is always the `wc_url` setting, entered in Settings → Sync → WooCommerce → Connection; `WC_STORE_URL` seeds that row once on a fresh install and nothing reads it afterwards. If the credentials are stored but no store URL is, the installer says so and the connector cannot reach the store until the URL is entered.
`WC_STORE_URL` is not one of them either, and for the same reason with more force: the installer writes it into every `.env`, so making it an override would repoint an installation that had since been moved to a different store back to the old one on its next upgrade — and only part of the code resolves `wc_url` through the settings store, so order import and stock push would end up targeting different shops. It seeds the setting once at install time instead (`scripts/provision-instance.mjs`, insert-only).

To rotate from the legacy global key to the settings key, first deploy with both the old key as `ENCRYPTION_KEY` and the new key as `SETTINGS_ENCRYPTION_KEY`, then run `npm run cli -- migrate-encrypted-settings` or save each connector settings page so sensitive values are rewritten as `enc:setting:v1:` with the new key. After confirming no `enc:v1` values remain in the `settings` table, remove the legacy `ENCRYPTION_KEY`.

This release supports one active `SETTINGS_ENCRYPTION_KEY` plus the legacy `ENCRYPTION_KEY` fallback. It does not yet support a multi-key map for zero-downtime rotations between two settings keys; that is tracked in the follow-up plan.

Rollback note: application versions before this feature cannot read `enc:setting:v1:` values. Rolling back past this change requires either keeping this code deployed until the old version is no longer needed, or manually decrypting and rewriting affected rows to plaintext or legacy `enc:v1` before rollback.

## Base Currency

One Two Inventory stores foreign-currency transaction values alongside converted values in the organisation's base currency.

- Set the base currency once in **Settings > Company** during initial setup
- After transactional data exists, changing the base currency is blocked in the UI
- To use a different base currency later, reset the database and configure the system again from a clean state
- Base-currency amounts throughout the UI use the configured currency's symbol and symbol position, so currencies that render as prefixes or suffixes display correctly

If you use external connectors:

- **WooCommerce** may accept orders in many transaction currencies, but the store's configured currency must match the IMS base currency before the shopping connector can be enabled
- **Xero** must use the same organisation base currency as the IMS before the accounting connector can be authorised or enabled


## Reverse Proxy

The installer generates an nginx configuration at `/etc/nginx/sites-available/one-two-inventory` with:

- Upstream connection to the Next.js process on the configured port
- WebSocket support for hot-reload (development) and real-time features
- Security headers (X-Frame-Options, X-Content-Type-Options, X-XSS-Protection, Referrer-Policy)
- Additional hardening headers (Permissions-Policy, COOP, CORP) and `server_tokens off`
- Client upload limit of 20 MB
- Extended timeouts for long-running requests (PDF generation, imports)
- Dedicated location block for webhook endpoints

## Host Security

The installer also applies low-risk host hardening:

- **fail2ban** enabled for `sshd` and, when nginx is configured, nginx auth/bad-bot jails
- **unattended-upgrades** enabled for security and updates repositories
- Existing active **ufw** setups are updated to allow ports `80` and `443`


## SSL

When SSL is enabled during installation, the script:

1. Installs **certbot** with the nginx plugin
2. Obtains a Let's Encrypt certificate for your domain
3. Configures automatic HTTPS redirect
4. Certbot handles automatic certificate renewal

To enable SSL after installation:

```bash
certbot --nginx -d ims.yourdomain.com
```
