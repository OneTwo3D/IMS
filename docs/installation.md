# Installation & Deployment

## Prerequisites

- **Operating system**: Debian 11/12 or Ubuntu 22.04/24.04 (tested in LXC containers)
- **Node.js**: Version 22 (installed automatically by the install script)
- **PostgreSQL**: Version 14 or later (installed automatically, or provide an external connection)
- **nginx**: Used as the reverse proxy (installed automatically)
- **Internet access**: Required during installation for downloading packages


## The Install Script

Run the installer as root:

```bash
bash scripts/install.sh
```

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
  `pg_basebackup` clone inherits its origin's, and it is superuser-only besides.

The endpoint connection is made as a throwaway role this run creates with a random name and
password and drops immediately. That is what lets the check run **before** anything has been done
to the application role — see the next section.

`IMS_PG_SOCKET_DIR` overrides the socket directory the local superuser connection uses (default
`/var/run/postgresql`). It exists so the regression suite can bring up clusters of its own, and it
cannot weaken the proof: pointing it at another cluster does not produce an exemption, it produces
the refusal above — which is what that suite asserts.

**Everything unproven is fenced**, which is every case below. Each requires
`DEPLOY_ADMIN_DATABASE_URL` and a protected fence artefact, exactly as an upgrade does:

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
`DEPLOY_ADMIN_DATABASE_URL` or a missing fence artefact then aborted the run with *"nothing has
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

**A `.env` the installer cannot read is not a `.env` with no secrets.** Only a path with *nothing* at
all on it is a first install. If `${APP_DIR}/.env` exists but is a directory, a dangling symlink, or
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

Prompts NOT preserved across a re-run: the WooCommerce, Xero, Turnstile and SMTP values, and the
database host, port, name and user. Supply them again (or as environment variables) on an upgrade
run, or the re-written `.env` will blank them.

### Application
- **Domain name** — the hostname for your installation (e.g. `ims.yourdomain.com`)
- **Internal port** — the port the app listens on (default: `3000`)
- **Default admin name/email/password** — optional bootstrap admin user for unattended installs
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
re-fetchable from Xero or QuickBooks, so they do not need the same backup policy
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

Scheduled tasks are configured automatically:

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
| Every 15 min | `/api/cron/mintsoft-dispatch-sync` | Poll pushed Mintsoft orders for despatch and progress the IMS shipment + tracking |
| 06:00 | `/api/cron/fx-rates` | Fetch latest exchange rates from frankfurter.dev |

**One writer at a time.** The managed crontab block has two writers — the application (Settings → System → Scheduler, and every settings save that affects a schedule) and this installer — and both take the same host-local `flock` on `${DATA_DIR}/locks/.crontab-reconcile.lock` before touching it. The application holds it across the whole read-modify-write (read the `cron_*` settings → read the crontab → write it) and hands the lock descriptor to the `crontab -` child, so the exclusion covers the write even if the app process dies mid-rewrite; the shell side takes it through `with_crontab_lock` in `scripts/lib/crontab-lock.sh`, which opens the lock file read-only on a descriptor scoped to one command group and holds it across the whole read-modify-write.

**All three entrypoints are in it, not just the installer** (o3d-p9dq). `scripts/deploy.sh` and `scripts/update.sh` fence, adopt, unfence and unwind the same crontab around their own cutovers, and until this round none of those read-modify-writes took the lock. They now source the same library, compose the same path from their own state directory, and prepare the same root-owned lock file — which matters on a host installed by an older release, where the lock file does not exist yet. Every `crontab` invocation in all three scripts sits in a `*_locked` function whose only caller is `with_crontab_lock`; `tests/settings/crontab-reconcile-serialization.test.ts` walks the repository and fails on the first one that does not.

**The fence is taken after the stop, and that ordering is doing work the lock cannot do.** Commenting the crontab out is itself a read-modify-write: read the crontab, back the reading up verbatim, write a commented-out copy, restore the backup later. Run while the application is still serving, a schedule an operator saves between the snapshot and the replacement lands in a crontab the cutover is about to overwrite and is absent from the backup it will restore — the settings rows and the UI go on reporting the job enabled and nothing runs it. The flock does not close that on its own the first time it ships: the predecessor was built before the flock existed and excludes itself some other way, so an flock taken there would serialise the script against nobody. The only exclusion that reaches that process is that it is not running, so all three entrypoints now fence the crontab **after** `systemctl stop` and after the port is proved free (`update.sh` gained that port proof for this reason), and still before the database drain probe. The `unfence` at the other end is the opposite case — the application is up, and it is up on **this** build, so it does participate in the flock and the lock alone is sufficient there. `--dry-run` is the one documented path that does not take the lock: it is unprivileged by design and every crontab body it reaches returns after printing what it would do and before any write.

**That path is the service's systemd `StateDirectory`, and neither writer has one of its own.** The unit the installer writes declares `StateDirectory=one-two-inventory`, systemd creates `/var/lib/one-two-inventory` owned by `imsapp` and exports its absolute path to the service as `$STATE_DIRECTORY`, and the application joins `locks/.crontab-reconcile.lock` onto that. The installer locks `${DATA_DIR}/locks/…`, which is the same `/var/lib/one-two-inventory`. Do not put the lock beside the application: a hardened unit (`deploy/systemd/ims-stage.service`, `ProtectSystem=strict`) makes the app directory read-only, so a lock file there cannot even be created — a `StateDirectory` is implicitly read-write, which is why it is the one path that works under every supported unit. If you relocate the state directory, change `StateDirectory=` in the unit and re-run the installer; both writers follow it. `OTI_CRONTAB_LOCK_PATH` is a **test-only** override — `$STATE_DIRECTORY` outranks it and production refuses it outright (with a warning on stderr), because a path the application honours and the installer does not is two locks pretending to be one. The queue wait (default 20s) is tunable with `OTI_CRONTAB_LOCK_WAIT_MS`.

**The lock is root's, and the service only reads it.** `${DATA_DIR}/locks` is created by the installer as `root:root` 0755 and the lock file inside it as `root:root` 0644 — the state directory around them stays owned by `imsapp`, as systemd requires, but nothing inside `locks/` can be created, replaced or removed by that user. That is deliberate: the installer runs as root, and a root-side `touch`/`chown`/`chmod` on a path the service account can turn into a symlink is a privilege-escalation primitive (it was one until r24). `flock(2)` ignores a descriptor's access mode, so the application opens the lock **read-only** and takes exactly the same exclusive lock; it never needs to write it. Do not `chown` the lock to `imsapp` "to fix permissions" — that re-opens the hole, and nothing needs it. On a host that was never installed by `scripts/install.sh` (a hand-deployed unit, `next dev`) the application creates `locks/` and the lock file itself, as the service user; there is no root writer there to be protected from.

Never delete and recreate the lock file — the lock lives on the inode, so a replaced file silently gives two writers two different locks. To see who holds it: `fuser -v ${DATA_DIR}/locks/.crontab-reconcile.lock`. A save that cannot get the lock within the wait reports "the scheduler may be behind" and changes nothing; re-apply from Settings → System → Scheduler. **If the lock file cannot be opened at all** — no `StateDirectory=` in the unit, a missing or unreadable `locks/` directory, a read-only mount — the reconciliation *refuses*: it does not read or write the crontab, and the error names the path it tried and the `StateDirectory` directive to fix. It never falls back to reconciling without the lock, because an unserialised reconciliation is exactly the defect the lock exists to prevent.

**An upgrade proves the application is running *this* build before it touches the crontab.** That flock only excludes a process locking the *same* file, which is true only of a process running the build the installer just deployed, under the unit it just wrote. The installer establishes that in three steps, not one: the cutover **stops** the service before the migration and refuses to go on while anything is still bound to the app port; section 12 then `enable`s the unit and `start`s it — deliberately two statements, because `enable --now` reloads systemd implicitly and would re-read every unit file *after* the check that the loaded configuration binds the service to this run's database; and section 12b then asks the port *which build answered*, by fetching `/_next/static/<BUILD_ID>/`, a route only the process whose own build id is that one serves. `/api/health` alone is not enough — a predecessor still holding the port answers it just as well. **And the asset fetch alone is not enough either** (o3d-p9dq): it proves which *tree* is being served, not whose *process* is serving it. A same-build process started by hand out of `${APP_DIR}` after the port was drained can win the bind while `systemctl start` returns for a unit that then fails to bind — and, not being the unit's child, it has no `$STATE_DIRECTORY`, so it resolves the crontab lock under its own working directory and the installer's flock would exclude nothing. So section 12b also verifies that the unit is active, resolves its `MainPID` and `ControlGroup`, checks that every pid holding a listening socket on the app port is inside that control group (a cgroup rather than a pid equality, because a Next.js unit's listener is routinely a child of the `ExecStart` process), and reads each listener's **own** effective `STATE_DIRECTORY` out of `/proc/<pid>/environ` to confirm its first colon-separated entry is `${DATA_DIR}` — the value the application joins `locks/.crontab-reconcile.lock` onto. An `environ` that cannot be read (the process exited, or `/proc` is mounted with `hidepid=` for this reader) is *proof not established* and aborts; it is not treated as an absent variable. **If either proof fails the install aborts** and the crontab section never runs, because taking a lock that excludes nothing is worse than not writing the crontab at all. The result is carried to the crontab section as `APP_SERVICE_ON_NEW_BUILD`, which section 16 refuses to open the lock without, so reordering the two sections fails loudly rather than silently reopening the race. A **hand-deployed** upgrade has none of this: nothing stopped the service, so it must rebuild, then `systemctl restart` (a `start` on a running unit is a no-op and leaves the old process on the old lock path), and only then touch the crontab — see `deploy/README.md`.

**The installer bootstraps, it does not reconcile.** Its schedules are defaults, not your committed settings, so on a re-run or upgrade it writes its bootstrap block only when no managed `# --- OTI CRON START ---` block exists. If one is already there the application owns it and the installer leaves it alone — which means a job newly registered by an upgrade is not scheduled until you open Settings → System → Scheduler and press Save & Apply. The scheduler page's warning banner flags a missing or malformed managed block.

All cron jobs run under the `imsapp` user and call the application's API endpoints via `curl`. Cron endpoints require the `CRON_SECRET` bearer header in production, and production startup fails fast if `CRON_SECRET` is unset, blank, or shorter than 32 characters. Installer-generated crontab entries read only the `CRON_SECRET=` line from the protected `${APP_DIR}/.env` file at runtime so the cron secret is not embedded directly in the crontab and unrelated environment values are not shell-sourced. The in-app scheduler sync (Settings → System → Scheduler) prefers the runtime-read pattern too, but only selects it when a byte-for-byte emulation of the exact `grep | cut | tr` pipeline proves the app's `.env` yields the *active* process secret; every other case (no readable `.env`, a value that shell-parses differently, binary/`NUL` content, or an env supplied by the service manager and not the file) falls back to embedding the current literal, which is always correct at sync time. In runtime mode a secret rotation needs only the `.env` edit and a service restart — no crontab re-sync — and each job line carries a `[ -n "$CRON_SECRET" ]` guard so a missing file or empty extraction skips the request rather than sending an empty bearer. The generated cron log defaults to `/var/log/one-two-inventory/cron.log` (the installer-owned `LOG_DIR`, already covered by logrotate); override with `OTI_CRON_LOG_PATH`. The installer writes its bootstrap jobs inside the same OTI-marked managed block in this exact format, and on upgrade it removes every previous managed block (including whitespace- or CRLF-suffixed markers) and any legacy bootstrap lines that call `localhost:<app-port>/api/cron/`, while preserving the operator's own crontab entries — including unrelated `/api/cron/` calls to other hosts, a line that coincidentally matches the managed-job format but sits outside any managed block, and any operator lines after a malformed unclosed marker (never deleted to end-of-file; only the block's own remnants within that region are removed). So no duplicate or drifting One Two Inventory cron entries survive an upgrade. The first in-app scheduler save then replaces that block IN PLACE — at its original position among the operator's lines, so it never moves past an operator `PATH`, `SHELL`, or `CRON_TZ` assignment (which apply only to the jobs below them). `OTI_CRON_LOG_PATH` and the `.env` path are rejected if they contain a quote, `%`, or control character, and the embedded-literal fallback is rejected for a secret containing a quote, backslash, backtick, `$`, or newline (rotate to a hex/base64 secret) — so the crontab can never be corrupted by a crafted value. The scheduler page shows a warning banner when the managed block is missing, malformed, carries a stale embedded secret, has a runtime `.env` that no longer matches the running service, or when unmanaged `/api/cron/` lines exist outside the managed block. Rejected cron auth is also recorded (best-effort) as a WARNING activity (`cron_auth_rejected`), deferred off the 401 path and throttled to at most one per route per process per hour, so a stale secret surfaces instead of failing silently. Localhost bypass is available outside production only when no `CRON_SECRET` is configured; production never accepts localhost cron requests without the bearer header. After a valid cron secret, each cron endpoint is rate-limited per job and source IP when a client IP is available: daily/hourly jobs default to one accepted run per hour, 5-minute jobs allow 15 accepted runs per hour, and 15-minute jobs allow 6 accepted runs per hour. The sub-hourly quotas intentionally include scheduling-jitter headroom and should not be tightened to the exact cadence. Rate-limited calls return `429` with `Retry-After`. Single-process installs can use the default in-memory rate-limit backend. Multi-replica or load-balanced installs must set `RATE_LIMIT_BACKEND=redis` and `REDIS_URL` so cron throttles are cluster-wide. Rotating `CRON_SECRET` requires updating both `.env` and any external cron scheduler invocations in the same maintenance window because the application reads the environment value on restart; if an old or leaked secret consumed cron quota, restart the memory backend or clear the Redis rate-limit keys rather than waiting for the one-hour window to expire.

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
- [ ] `/api/cron/accounting-sync` — every 5 min (if accounting connected)
- [ ] `/api/cron/accounting-payment-poll` — every 15 min (if accounting connected)
- [ ] `/api/cron/accounting-fx-revaluation` — daily (if accounting connected)
- [ ] `/api/cron/account-balance-snapshot` — daily (if accounting connected)
- [ ] `/api/cron/delivery-status` — every 15 min (if delivery tracking enabled)
- [ ] `/api/cron/backup` — daily, off-peak window
- [ ] `/api/cron/invariant-check` — daily
- [ ] `/api/cron/product-lifecycle-archive` — daily

Each cron endpoint requires `Authorization: Bearer ${CRON_SECRET}` in the request. The system's per-route rate-limit quotas have headroom for jitter but not double-frequency abuse — verify your cron daemon doesn't retry aggressively.

### Backup & restore

- [ ] Backup cron schedule confirmed (`/api/cron/backup` daily).
- [ ] Remote upload (S3 or SFTP) configured under Settings > Backup. Local-only backups are vulnerable to the same incident that takes down the application server.
- [ ] Restore round-trip tested on a staging environment — confirm the manifest validation passes and the database is functional after restore.
- [ ] `DATABASE_RESTORE_MAX_FILE_BYTES` raised if your typical backup exceeds 50MB.

### Integrations

For each connected integration (WooCommerce, Xero, Shopify, QuickBooks, Mintsoft):

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


## Updating

To update to a newer version:

```bash
cd /opt/one-two-inventory

# Preferred: run the bundled update script
bash scripts/update.sh
```

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
  publish through `publish_durable_file()`: a temporary in the same directory, an `fsync` of
  the data, the `rename`, an `fsync` of the parent directory, and a `marker_complete=1`
  sentinel written last so a reader can tell a whole marker from a torn one. A shell
  redirection has none of that, and a reboot can find an empty marker, the previous one, or no
  marker at all.

The three entrypoints — `scripts/install.sh`, `scripts/update.sh`, `scripts/deploy.sh` — share
one cutover namespace, one lock and one state machine, so a fence left standing by any of them
is adopted by any other. **If an update fails, re-run one of those scripts; do not hand-roll
the sequence.** The failure banner names the marker, the fences that are standing and the
command that releases each, and the next run adopts what the failed one left behind.

To see what a run would do without doing it, `bash scripts/update.sh --dry-run` prints the
whole plan and changes nothing (and works unprivileged); `bash scripts/deploy.sh --dry-run`
does the same for a deploy.

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

| what | path |
| --- | --- |
| cutover marker | `/var/lib/one-two-inventory/DEPLOY-FENCED` |
| crontab backup | `/var/lib/one-two-inventory/crontab-<service user>.bak` |
| connection-fence state | `/var/lib/one-two-inventory/deploy/db-connect-fence.json` |
| cutover lock | `/var/lib/one-two-inventory/cutover.lock` |

Set `IMS_CUTOVER_STATE_DIR` **in the environment of the root invocation** to move all four
together; `IMS_DEPLOY_STATE_DIR` and `IMS_DATA_DIR` are still honoured. Setting any of them in
`APP_DIR/.env` does nothing: the application user owns that file, and since o3d-2sm1.5 r25 none of
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
  already read `DEPLOY_ADMIN_DATABASE_URL` from — with a strict reader (`resolve_db_identity`,
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
— `DATABASE_URL`, `DEPLOY_ADMIN_DATABASE_URL` and `APP_PORT` from `.env`; `GIT_REPO_URL`,
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
| the fence script **and its imports** | `/etc/ims-cutover-recovery/app/`, a root-owned, wholly digested tree, and the only thing **executed** | published into the protected path **once**, never run in place, and its dependency closure copied rather than linked — see r31 and r32 below |
| `DEPLOY_ADMIN_DATABASE_URL` | the **root invocation** | fills in only when the invocation is silent; a disagreement is announced |
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

The directory is root-owned and **0755**, not the snapshot directory's 0700, because the fence runs
**as the application user** — a root-owned state file is one it cannot release — and neither file
holds a secret. It is a **literal**, for the same reason `DB_ENV_SNAPSHOT_DIR` is. It is
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
# as root, from the release tree being deployed
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
   `grep '^fence_artefact_sha256=' /etc/ims-cutover-recovery/db-fence-artefact.sha256` there.
3. **`--print-fence-digest` or `--dry-run` on the target itself — for comparison only.** Either
   prints the same line, assembled
   from the checkout under question, so it can **confirm** the release's value and can never stand
   in for one. Every refusal that reports a digest labels it **reported and not authenticated** for
   the same reason.

**And the route that needs no digest at all:** bootstrap from a source only root can write. Install
the release tree as root and take group and other write off it — every path the vendoring reads,
and every directory from the application directory up to `/` — and the provenance question answers
itself, so an unpinned publication is accepted. This is the "root-owned authenticated release
source" option; it is the right shape for an image-built or configuration-managed box, and the
wrong one for a checkout the application account deploys into.

The digest comes **from the release and not from the box** — `git show <tag>:scripts/fence-db-connections.mjs | sha256sum`
run somewhere that is *not* the machine being deployed, or the checksum published with the release.
Deriving it on the target would authenticate the checkout against itself, and nothing computed from
`APP_DIR` can authenticate `APP_DIR`. (That command is given inline rather than as a copy-pasteable
block on purpose: it is a step for a workstation, not for the machine mid-cutover.)
The **whole artefact** — the entry file and the vendored dependency closure — is then assembled at
`/etc/ims-cutover-recovery/.app.staged`, which only root can write; it is sealed (ownership and
modes), checked (nothing but regular files and directories), digested **from that staged tree**,
and only then renamed into place, with the previous tree moved aside rather than deleted so a
failure between the two renames leaves the *old* artefact standing rather than none. The tree that
was verified is the tree that is published, and the checkout is never read again after the copy. A
rotation also moves `fence_script_sha256` in the recovery record with the file it names; leaving it
behind would make every subsequent run refuse, and a rotation that bricks the mechanism is not a
rotation.

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
* the **second rotation path is root itself**: remove `/etc/ims-cutover-recovery/app` (the whole
  tree, since r32 — removing only the entry file leaves a vendored closure the next publication
  would have to reconcile). Only root can, and the next run bootstraps. It is the escape hatch for a box whose expected digest has been lost, and it is
  deliberately an act at the console rather than a flag. Do it only with no fence standing — with a
  record present and the copy gone, every run refuses by design.

**One mechanism, three entrypoints.** The rule now lives in `scripts/lib/db-fence-protected.sh`,
sourced by `install.sh`, `update.sh` and `deploy.sh`, and no entrypoint has fence-helper resolution
of its own: `db_fence_script_in_use()` decides, and it never returns the checkout's path. Every
invocation goes through it — preflight, fence, migration-URL composition, release and the exit
trap's re-fence — in all three. The library is sourced from **the entrypoint's own directory**
(`${BASH_SOURCE[0]}`), not from `APP_DIR`: it is read at startup, out of the same tree and in the
same instant as the body of the script, so it adds no window the entrypoint does not already have —
unlike the helper, which is executed several phases later, after the application account has had a
cutover's worth of time to replace it.

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
| `/etc/ims-cutover-recovery/app/scripts/fence-db-connections.mjs` | the only file executed |
| `/etc/ims-cutover-recovery/app/node_modules/pg/…` | a real root-owned directory, not a link |
| `/etc/ims-cutover-recovery/app/node_modules/pg-protocol/…` etc. | …and the rest of the resolved closure (13 packages, ~140 files) |
| `/etc/ims-cutover-recovery/db-fence-artefact.sha256` | what the tree hashes to, and what the entry file hashes to |
| `/etc/ims-cutover-recovery/db-fence-artefact.manifest` | per-file digests, so a mismatch can name the file |
| `/etc/ims-cutover-recovery/release-db-fence` | the root-owned recovery wrapper (below) |
| `/etc/ims-cutover-recovery/refence-db` | the same, for raising the fence again |

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
`/etc/ims-cutover-recovery/db-fence-artefact.sha256`. When they differ,
`cd /etc/ims-cutover-recovery/app && sha256sum -c /etc/ims-cutover-recovery/db-fence-artefact.manifest`
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
* **The process it runs as.** The helper is executed **as the application user** on every in-script
  path, by design — the fence state file has to be releasable by that account — so
  `DEPLOY_ADMIN_DATABASE_URL` is reachable from that account through `/proc` and `ptrace` whatever
  bytes run. Vendoring does not change that and does not claim to. What it closes is the ability to
  **lie**: to report a raised fence over an open database, or to hand back a migration URL that
  points somewhere else.
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


#### The two commands an operator is ever given

r31 fixed which bytes the scripts execute and left every printed instruction describing the world
before it. Two separate defects of one kind:

* the printed `--release` line named the protected copy but had **no way to obtain**
  `DEPLOY_ADMIN_DATABASE_URL`. The helper's `.env` load resolved against its own mirrored location,
  and the mirror holds no `.env`; the deploy's copy of the variable lives in *its* shell, not the
  operator's. Pasted, it failed while the database stayed fenced — the primary recovery guidance
  was an outage-extending dead end.
* the re-fence banner — printed at the single highest-pressure moment in the script, schema moved
  and fence down — still said `node ${DB_FENCE_SCRIPT} --fence`, the **application-owned** path.

So nothing prints a command line any more. Root writes two wrappers at fence time:

```bash
sudo /etc/ims-cutover-recovery/release-db-fence      # release the standing fence
sudo /etc/ims-cutover-recovery/refence-db            # raise it again
```

Each one is root-owned and `0700`, **never sources anything from the checkout**, carries this run's
state file and four identity values baked in, re-verifies the artefact digest before `exec`, takes
`DEPLOY_ADMIN_DATABASE_URL` from its own environment or from `APP_DIR/.env` with the same one-key
reader the entrypoints use, and runs the helper **as the application user**. There is nothing to
fill in.

**r33: the banners print the `sudo`, and that is not decoration.** r32 asked of every printed line
"would it run if pasted?" and answered yes for these — correctly for root, and wrongly for the
person most likely to be reading them. The wrappers are `0700` and root-owned, so the operator who
launched the cutover as `sudo bash scripts/update.sh` is back in a **non-root shell** when the
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
reader — the recovery directory is `0755` and the artefact tree world-readable, because the fence
itself runs as the application user — and the recovery invocation that re-runs an entrypoint now
carries the same transition (`sudo env DEPLOY_ADMIN_DATABASE_URL=… bash …`), since those scripts
refuse to run as anything but root.

**The credential is the part no record may hold.** `DEPLOY_ADMIN_DATABASE_URL` carries a password
and is written nowhere by these scripts. On a recovery where `APP_DIR/.env` is gone it can only
come from the **root invocation**, and a recovery without it refuses, naming the variable and
giving the invocation that supplies it. For the same reason the **invocation's value wins** over
the file's since r30: the refusal tells an operator to type the variable on the command line
precisely because that file cannot be relied on at that moment, so a file that could silently
substitute a different privileged connection would make the instruction meaningless. Nothing
changes on an ordinary run — `sudo scripts/update.sh` carries no such variable, so `.env` answers,
exactly as before — and when both are set and differ, the disagreement is printed.

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

**What this does not protect against.** The privileged driver is still `scripts/update.sh` itself,
run by root from wherever the operator keeps it, and `APP_DIR/.deploy-meta` still supplies the
re-clone URL — which is data the application account already controls, used only as an argument to
a `git clone` that runs **as the application user** (passed after `--`, so a value starting with
`-` cannot become a git option). Neither is a privilege crossing, but neither is a root-owned
configuration input either. Moving the deployment metadata into a root-owned, non-writable
location is filed as follow-up work, not done here.

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
in the marker as `db_connect_fence=held|released` — which of the two is actually true. If it cannot
put the fence back it says `THE CONNECTION FENCE IS NOT IN PLACE` rather than describing one that
does not exist.

A re-run **adopts** a held fence rather than releasing it: it re-applies the revoke (which re-drains
anything that attached in between, while keeping the *original* recorded grants so the eventual
release restores the truth) and runs every database-touching recovery step — the rebuild included —
through `DEPLOY_ADMIN_DATABASE_URL`. Adopting a held fence without that variable set is fatal: the
application role has no `CONNECT` and the run would have no connection to recover through.

That fence needs a privileged connection of its own, `DEPLOY_ADMIN_DATABASE_URL`:

| Variable | Purpose |
| --- | --- |
| `DEPLOY_ADMIN_DATABASE_URL` | A superuser or database-owner connection, as a **different role** from `DATABASE_URL`. Used only by the deploy scripts, and only for the migration window. No ACL can tell "the migration" apart from "the application" when both log in as one role, so without a separate role there is no fence to install. |

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

So the migration **connects as the admin and runs as the application role**: the deploy composes
the migration URL with `options=-c role=<app role>`, which Postgres applies at connection start.
Authentication — and therefore the `CONNECT` check the fence revokes — is still the admin's, so
the fence still holds; ownership is the application's, so the fenced path leaves the database in
exactly the state an unfenced migration would.

It is not taken on trust:

* `scripts/fence-db-connections.mjs --preflight` **refuses before anything is stopped** if the
  admin cannot `SET ROLE` to the application role, naming the `GRANT` that fixes it;
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

Never run two versions of IMS against the same database at once — no rolling restart, no
blue/green overlap, no second instance left running on another port.

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
| `INVOICE_PDF_STORAGE_DIR` | Persistent storage directory for connector-downloaded invoice PDFs served through signed links. Defaults locally to `./data/invoices`; required by production preflight. Relative paths resolve against the process working directory, so production values should be absolute |
| `SETTINGS_ENCRYPTION_KEY` | 32-byte raw key, or base64 value that decodes to 32 bytes, used to encrypt sensitive Setting values stored in the database (auto-generated) |
| `ENCRYPTION_KEY` | Legacy fallback for older installs; if needed during migration, it must also be a 32-byte raw key or base64 value that decodes to 32 bytes |
| `AUTH_URL` | Authentication callback URL (same as app URL) |
| `DATABASE_URL` | PostgreSQL connection string. **A transaction-pooling proxy in front of this URL is not supported, and is not planned** — point it at PostgreSQL itself; see *Connection pooling in front of `DATABASE_URL` is not supported* below for what is refused, where, and what is not detected. **The schema may be named in either spelling, but only one of them** (o3d-1izw): Prisma's `?schema=` or libpq's `options=-c search_path=`. Whichever is present decides the schema for *both* halves of the application — the schema Prisma qualifies generated queries with, and the `search_path` every raw statement and all three release gates resolve through — and a URL naming no schema is pinned explicitly to `public` rather than left on the server default. A URL that names **two different** schemas, or a `search_path` that is a list rather than one schema, is **refused**: the runtime does not start, the deploy check exits non-zero and `preflight:production` fails, each naming both values. Any *other* startup setting inside `options` (`application_name`, `statement_timeout`, …) is preserved. **Quoting matters in `search_path`, exactly as it does to the server**: `search_path=TenantA` is the schema `tenanta` (PostgreSQL folds an unquoted identifier) while `search_path="TenantA"` is `TenantA`, so the two are pinned differently and `?schema=TenantA` beside an unquoted `search_path=TenantA` is a **conflict**, not agreement; a non-ASCII schema name is **conditional on this deployment**, and quoting no longer settles it (o3d-2k5r r19). PostgreSQL splits a startup `options` by asking `isspace()` **one byte at a time**, so whether the UTF-8 bytes of a name end a token is a property of the server's `server_encoding` and `LC_CTYPE` and not of the string, and a backslash does not help — `pg_split_opts()` consumes the escape and exactly one byte. So the server is **asked**: a sanitised probe connection (no `options`, no `?schema=`) reads the encoding and ctype and then round-trips those exact characters through a custom GUC. Where they come back unchanged the name is **carried**; where the probe has not run, could not reach the server, or measured a change, the URL is **refused** with the measurement and with the alternative — `ALTER SCHEMA "<name>" RENAME TO <ascii_name>;` and the matching `DATABASE_URL`. The probe runs from `instrumentation.ts` at startup, from `preflight:production`, and from `scripts/check-wms-push-state-enum.mjs`, which `deploy.sh` runs **before it stops the old server** — so an unsupported schema is a pre-deploy rejection, not a failed restart. The verdict is held **once per process** and shared by every bundled copy of the module (a versioned `globalThis` slot), which is what makes the runtime honour a probe `instrumentation.ts` ran: the production build emits that module into several chunks and a per-module verdict never reached the one that builds the database adapter (o3d-2k5r r20). A positive verdict is bound to the **physical backend** that gave it, not to the `host:port/database` in the URL (o3d-2k5r r21): that is a *logical* endpoint, and a pooler, a load balancer, a multi-A-record name or a failover pair can serve the probe from one PostgreSQL and the application's pool from another. The probe therefore opens **three** connections and records who served each — `inet_server_addr()`, `inet_server_port()`, the server version, the encoding and the ctype — and will only settle a positive verdict when all three agree; when they do not it settles **not established**, naming both backends, and the refusal stands. A **refusal** needs no such agreement: an unsafe answer from any backend behind the endpoint is safe to apply to all of them, so only the permission is bound to a server. **Three agreeing samples are evidence, not a census** — a round-robin over two backends puts all three on one about an eighth of the time, and sticky or weighted routing makes that likelier — so the samples are not what enforces the rule (o3d-2k5r r22). The probe decides whether the bytes survive and **names the backend that said so**; whether a given connection may carry them is then decided **per physical connection**. Every new connection the application's pool opens asks the backend that answered it for its identity and its effective `search_path`, and is **refused before it can run a query** unless both match what the verdict recorded — so a failover, a re-pointed pooler or an unsampled member gets a refused connection with a reason rather than the permission. The same check wraps the raw `pg` clients the three out-of-process gates and the provisioning seeder use. It costs **nothing** for an ASCII schema name (no check is attached at all) and one round trip per new physical connection for a non-ASCII one — none per query. That per-connection check also **refuses any connection that does not reach the backend directly** (o3d-2k5r r23). A client socket is not a server backend: a transaction- or statement-pooling proxy re-assigns the *server* side between units of work, so a check run when the socket came up says nothing about the backend that runs the next statement. The connection therefore asks `pg_stat_activity` what peer the backend accepted and compares it with this process's own socket; anything that terminated the connection and opened its own — which every pooler must, to multiplex it — is named and refused. **This restricts nothing that worked**, and that is measured rather than assumed: against **PgBouncer 1.24.1** in front of PostgreSQL 17.11, with the default configuration and in **both** `pool_mode = transaction` and `pool_mode = session`, a startup `options=-c search_path=…` is rejected by the pooler outright (`FATAL: unsupported startup parameter in options: search_path`); and where an operator has named the parameter in `ignore_startup_parameters` or `track_extra_parameters` the connection is accepted and the option is **silently discarded** — `current_setting('search_path')` came back `"$user", public` and the query resolved `public`, and a `-c statement_timeout=1234` sent the same way returned `1234ms` direct and `0` through the pooler, so no startup `options` content reaches the backend at all. A non-ASCII schema behind a pooler was therefore **already broken, silently**; this reports it. Two consequences are stated rather than hidden. A plain **TCP NAT or port-forward** also rewrites the peer and is refused too, even though it cannot multiplex — connect the application to the backend directly, or rename the schema to ASCII. And over a **Unix-domain socket** the backend reports no peer at all (`client_addr` NULL, `client_port` -1), so directness cannot be shown there either — and that is **refused, not skipped** (o3d-2k5r r24). It was skipped until r24, on the cover that the `search_path` comparison would catch any real pooler; it does not, because that comparison is a single reading taken when the connection came up and says nothing about the backend that runs the next statement. **Odyssey 1.5.3-rc1, measured rather than cited**: it pools transactions over Unix sockets, and through it the backend reported `client_addr` NULL and `client_port` -1 exactly as a direct connection does, so the two are indistinguishable on that path. What it costs is exactly this: a deployment that connects over a Unix-domain socket **and** names a schema whose characters need a non-ASCII startup option is refused at boot. There are two cheap ways out — point `DATABASE_URL` at `127.0.0.1` over TCP, where the peer comparison can be made and a direct connection passes it, or rename the schema to ASCII. A **pooler's `pool_mode` is not readable from an ordinary SQL connection**, so this detects *interposition*, not the pooling mode. The probe also re-runs at every boot, in `preflight:production`, and before a deploy stops the old server, so a replaced server is re-measured rather than assumed. What is left is the loud case only: a backend that *splits* on the byte refuses the startup packet outright, which is a connection error rather than a silent write to the wrong schema. Every pool in the process is built from this same configuration — the Prisma pool, the three session-advisory-lock pools (`lib/db/pinned-advisory-lock.ts`, the Xero payment-write lock and the WMS dispatch-sweep lock) and the backup-restore selection-lock client — so none of them is a second, unguarded route into the database; a repository check fails the build if a new one appears (o3d-2k5r r23). **A connection that will take a SESSION advisory lock is held to a stricter rule than the data path, and to it on every schema** (o3d-2k5r r25). The per-connection check above is attached only where a non-ASCII startup option is being carried, because that is the permission it exists to spend — so on an **ASCII** schema, which is every ordinary deployment, nothing checked that the lock's connection reached the backend directly. A session advisory lock lives on ONE backend session, and pooling destroys the affinity between the IMS client and that session — what then happens to the lock is per pooler: it may be reset/released with the server connection, or left attached to a backend handed to another client. Measured against **Odyssey 1.5.3-rc1** in transaction-pooling mode, *that* pooler released it: two clients each acquired the same key and each were told they held it while `pg_locks` showed neither did. The money-post lock fences a ledger read and an external payment, so that is a document paid twice. The four holders — `lib/db/pinned-advisory-lock.ts` (which the money-post lock and the daily accounting batches run on), the Xero payment-write lock, the WMS dispatch-sweep lock and the backup-restore selection lock — therefore build their connections through `lib/db/session-lock-pool.ts`, which attaches the directness proof unconditionally; a repository check fails if a fifth holder opens its own connection instead. It costs **one round trip per new physical connection on those pools only** (`max` 2-4, a handful of low-frequency jobs) and **nothing at all on the data path**, which is unchanged. Behind a pooler the refusal names `DATABASE_SESSION_LOCK_URL` — see its own row below. Taking such a connection is **bounded on every deployment, override or not** (o3d-2k5r r28): the directness proof is one statement on the lock's own socket, and a server that accepts the connection and then stops answering used to hang the acquisition — and with it whatever was taking the lock, a money post, accounting batch, WMS sweep or restore among them — indefinitely. It now has a 5 s client-side bound, with a 30 s backstop over the whole acquisition (pg-pool's connect, the proof, and the wait for a free connection on a full lock pool, which carried no timer of its own); on expiry the connection's socket is destroyed and the caller is told the lock was **not** taken. This makes the session that took the lock the session that keeps it; it does **not** make the lock durable, which still ends with its connection, and it does **not** make a session advisory lock a sufficient exclusion for money movement — see `DATABASE_SESSION_LOCK_URL` below and **o3d-ic9a (P1)**. The one deliberate exception is `preflight:production`'s connectivity probe, whose only statement is `SELECT 1` and so resolves no object. **Known gap:** `next build` evaluates `lib/db` in worker processes that never run `instrumentation.ts`, so a build on a deployment with such a schema is refused; build with the schema renamed, or with `DATABASE_URL` unset. And **`?options=` or `?schema=` written twice is refused**: `URLSearchParams.get()` reads the first while the driver connects with the last, so the reader and the connection would be looking at different schemas. |
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
| `SHOPIFY_INVOICE_PDF_SECRET` | Separate secret used only for Shopify customer-visible invoice PDF proxy requests to IMS |
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
| `STATE_DIRECTORY` | Set by systemd from the unit's `StateDirectory=`, not by you. The crontab reconciliation lock is `$STATE_DIRECTORY/locks/.crontab-reconcile.lock`, which is how the application and `scripts/install.sh` land on one file. Absent (running outside systemd) the lock falls back to `./locks/` under the working directory |
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
| Money post | `lib/db/pinned-advisory-lock.ts` | The money post itself — reached from the Xero and QuickBooks sync processors and from operator-triggered settlement actions — and the daily Xero and QuickBooks accounting batches, which run on the same holder |
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
