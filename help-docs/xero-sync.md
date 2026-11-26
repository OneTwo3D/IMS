# Xero Accounting Sync

One Two Inventory integrates with Xero to keep your accounting records in sync. The system acts as a **sub-ledger** — Xero handles invoicing, payments, and bank reconciliation, while the IMS creates daily correction journals to control when revenue is recognised and how inventory flows through your accounts.

## Connection Setup

1. Enable the Xero plugin under **Settings > System > Plugins** if it is not already enabled
2. Go to **Integrations → Xero** and enter your Xero app **Client ID** and **Client Secret**
3. Click **Connect to Xero** — you'll be redirected to Xero to authorise the connection
4. Once connected, click **Sync Chart of Accounts** to pull your Xero account list
5. Map each IMS transaction type to the correct Xero account (see Account Mapping below)
6. **Click "Test Connection"** — sync remains disabled until you successfully run the test. The system stores a fingerprint of the saved credentials at test time; if you later change them, you must re-test.
7. Enable **Xero Sync** and save settings

Before connection or sync can be enabled, the Xero organisation base currency must match the IMS base currency configured in **Settings > Company**.

If Xero does not return the organisation's base currency at the moment you click Connect (a temporary Xero error, or a response IMS cannot read), the connection is **refused** and nothing is stored — an unreadable currency is never treated as a matching one. Try Connect again; the message distinguishes this from a genuine mismatch. (IMS does not yet remember the verified currency after connecting; that check happens at connect time only.)

### Which organisation this instance may connect to

**IMS will not guess which Xero organisation to invoice into.** If the person authorising the
connection has access to more than one organisation — very common for an accountant, a bookkeeper, or
anyone who also has the Xero Demo company — the consent hands IMS a *list*, and picking one silently is
how test data ends up in a real ledger. It has happened: a test instance connected to the live
organisation and posted 150 invoices, 111 contacts, 217 items and 14 payments into it before anyone
noticed.

So:

- **One organisation on the consent** — the ordinary case — connects exactly as before. Nothing changes.
- **More than one, and this instance has never been connected** — the connection is **refused**, nothing
  is stored, and the message names every organisation offered with its tenant id, e.g.

  > Refused: this instance has no pinned Xero organisation and the consent returned 2 organisations, so
  > IMS will not guess which ledger to invoice into. Offered: Demo Company (UK) [tenantId 5c949ed5-…],
  > OneTwo3D Ltd [tenantId e7fb4378-…]. Nothing was stored. Choose explicitly: set
  > `XERO_ALLOWED_TENANT_IDS` to exactly one of the tenantIds above in the server `.env`, restart IMS and
  > connect again — or remove IMS's access to the other organisations in Xero (My Xero → Connected apps)
  > so that a single organisation is offered.

  Either route works. The allow-list is the durable one; removing the app's access to the other
  organisations in Xero is the quicker one if you only ever want the single organisation.
- **Once connected**, IMS pins that organisation and every later reconnect must match it, exactly as
  before. Disconnecting clears the pin.
- **Connecting to a different organisation does not carry the old organisation's mapping with it.** The account
  codes (all fifteen roles under *Account Mapping*), the Payment Account Mapping, the reverse-charge tax types and
  each IMS tax rate's Xero tax type describe one organisation's chart. IMS remembers which organisation the mapping
  belongs to (`xero_account_mapping_tenant_id`, written by every connect and by every mapping save made while
  ownership is not in doubt; it survives **Disconnect**). Three cases:
  - **Known different organisation** (the remembered organisation, or the stored token's, is not the one you
    connected): in the same transaction as the new binding IMS clears the account roles, the payment map, the
    reverse-charge types, the IMS tax-rate Xero tax types, the cached chart of accounts and the tax-drift snapshot,
    and switches **Xero sync off**. It is not an automatic re-map (matching old codes to a new chart would be a guess)
    and nothing already stored is rewritten. Open Sync settings, run **Sync accounts**, choose each account and each
    tax type, then switch sync back on; the readiness check names whatever is still missing.
  - **Same organisation**, including after **Disconnect**: everything is kept.
  - **Unknown** (an instance bound before IMS recorded this, then disconnected): IMS **cannot tell** whether the
    mapping is this organisation's, so it does **not delete it**. The mapping is kept, **sync is switched off** and
    Sync settings shows *Confirm the account mapping belongs to <organisation>*. Review the mapping and press the
    confirm button (an admin step-up action, recorded in the activity log with who and when). This hold is
    **persisted** (`xero_account_mapping_unconfirmed`): reconnecting again, to the same organisation or a different
    one, keeps the mapping, keeps sync off and stamps nothing, because the token row a reconnect creates proves which
    organisation the token is for, not which one the mapping was made for. Only the confirm button ends the hold
    (saving the form does not: you may keep codes the new chart happens to share, and saving is not checking each
    one). The callback message says "could not confirm which organisation this
    mapping was set up for"; it never claims the mapping belonged to another organisation.
  A mapping save or payment-map save made from a page rendered against a different organisation than the one now
  connected is refused (reload and review), and both saves serialise with the connect on the same lock, so a stale tab
  cannot put the previous organisation's mapping back. Anything that reads data from Xero and stores it afterwards
  (**Sync accounts**, the tax-type auto-link / generate / single-rate mapping, the tax-rate drift snapshot, the GL
  balance snapshots) remembers which connection it fetched under and discards the result, with a clear message, if
  the organisation was changed in between; run it again against the organisation now connected. `LEAVE`d on purpose: the app credentials, the sync-mode and
  batch/polling switches, the payment-poll time cursor, the invoice/bill URL templates, per-document contact/item ids
  (their provenance already ignores another organisation's) and every posted document's ids and sync rows (the tenant
  stamp on each refuses them at egress).
- **Two connections at once bind one organisation, not two.** The pin and the stored token are written
  in a single database transaction, and the pin's key is a primary key, so if two OAuth callbacks are in
  flight at the same time — two browser tabs, two operators, a replayed redirect — exactly one of them
  establishes the binding. The other is refused with nothing stored: no token, no pin, no Xero data read
  or written. Its message names the organisation that won and tells you to disconnect on `/sync` if the
  one you chose is the one this instance should use. (Two consents to the **same** organisation both
  report success; there is nothing wrong with a double-clicked *Connect*, and the duplicate is simply
  discarded.)
- **An instance that is already bound to two organisations at once stops syncing.** The two halves of a
  binding are the *pin* (`xero_expected_tenant_id` in the database) and the *stored token*. They are
  written together now, but an instance connected under an older build, or one handed a database from
  another environment, can already hold a pin naming one organisation and a token belonging to another.
  IMS refuses to sync in that state rather than guessing — the pin is what reconnects are checked
  against, the **token** is what every Xero call actually presents, and while they disagree the binding
  is simply unknown. `/sync` shows the connection as not connected with the reason, and the Activity log
  records `xero_stored_tenant_refused`:

  > Xero sync is halted: this instance is bound to two different Xero organisations at once. Its pin
  > (the `xero_expected_tenant_id` setting, which every reconnect is checked against) names tenantId
  > 5c949ed5-…, while the stored token — which is what every sync actually presents to Xero, and so what
  > decides which ledger is written to — belongs to OneTwo3D Ltd [tenantId e7fb4378-…]. … To fix it: on
  > `/sync` press **Disconnect** — that clears the token and the pin together — then connect again and
  > choose the organisation this instance is meant to use.

  If you are auditing what such an instance posted, look in the **token's** organisation: that is where
  everything went.
- **Deleting the pin is not a way out of that refusal.** A token with **no pin beside it** used to be
  exempt, which made the refusal above one `DELETE FROM settings` away from being switched off — and a
  `settings` table restored from a different backup than `accounting_tokens` arrives in the same state
  without anybody deleting anything. IMS now asks what the *token row* says about its own history:

  | State of the token row | Meaning | Result |
  | --- | --- | --- |
  | No token row at all | A first connection | Connects normally |
  | No connection marker | Connected before this shipped | Keeps working, as before |
  | Released by `--clear-tenant-pin` | Deliberately unpinned, awaiting a re-consent | Keeps working |
  | Carries a connection marker, pin gone | The pin was deleted or lost | **Sync halted** |
  | Carries a release for a *different* connection | Paperwork that came apart from its row | **Sync halted** |
  | Carries a release that says only *when* | Recorded before IMS logged what a release was for | **Sync halted** |
  | Carries a release this instance never wrote | A token row that arrived from somewhere else | **Sync halted** |

  The marker is minted by the connect that wrote the pin, in the same transaction, and **Disconnect**
  removes the token and the pin together — so a token that has outlived its pin can only mean the pin
  went away on its own. The halt says so and tells you to press **Disconnect** on `/sync` and connect
  again; nothing in the `.env` needs editing, and writing the setting back by hand is deliberately *not*
  offered as a remedy (a pin typed in beside a token that came from somewhere else only makes the two
  agree, which is not the same as the binding being right).

  To be unpinned **on purpose** — the ~28-day Demo reset — use
  `provision-xero-demo.ts --clear-tenant-pin`, which deletes the pin and records the release on the
  token row in one transaction, or simply press **Disconnect**. A release ends by itself at the next
  connect, and while it is outstanding the consent is free to land on the rebuilt organisation's new
  tenantId — but it still will not guess between two organisations.

  **A release describes one connection, and stops applying when that connection changes.** The receipt
  records which connection it released and which pin it deleted, so it cannot be inherited by a
  different binding: an `accounting_tokens` table restored from a backup taken while a release was
  outstanding lands on a connection the release knows nothing about, and IMS halts rather than honouring
  it. Two consequences worth knowing:

  - Run `--clear-tenant-pin` **before** the pin goes. It records a release only when it is the statement
    that deletes the pin, so running it on an instance whose pin has already vanished changes nothing
    and does not lift the halt — that is **Disconnect**'s job.
  - Releasing one half of an instance that is *already* bound to two organisations does not end that
    refusal. The receipt names the pin it deleted, which is not the token's organisation, so the
    contradiction stays visible instead of being deleted away.

  **A release is recorded in two places, and both are checked.** Everything the receipt is compared
  against is a column on the same token row, so a row restored *wholesale* from a dump would arrive
  carrying its own corroboration and agree with itself. `--clear-tenant-pin` therefore writes the
  release twice in one transaction — on the token row, and as a `xero_pin_release_witness` setting
  beside the pin it deletes — and IMS honours a release only when both halves describe the same one. A
  token row copied from another environment cannot bring the second half with it. **Disconnect** and the
  next connect both clear the pair together.

  What this does *not* catch, said plainly: a restore or copy of the **whole database** brings both
  halves and every other fact with them, and nothing stored in that database can tell a faithful copy of
  an instance from the instance. The controls that survive a restore are the ones in the server's
  `.env` — `XERO_ALLOWED_TENANT_IDS`, `XERO_BLOCKED_TENANT_IDS`, `XERO_REQUIRE_DEMO_ORG` — which is why
  they are checked against the *stored* token on every use and not only at the consent.

  **Upgrading with a release outstanding.** Releases recorded before IMS logged what they were for
  carry only a timestamp. Those are **not** filled in on upgrade and they do not exempt anything: the
  older `--clear-tenant-pin` also stamped a release when it deleted no pin at all, so a receipt in that
  shape cannot be told apart from a pin that went missing, and qualifying one would qualify both. If a
  rig was mid-recovery over the upgrade it is halted with that reason, and the fix is the step it was
  already waiting for — press **Disconnect** on `/sync`, then connect and choose the organisation.
  Nothing is lost by doing so: the token was unusable until that consent anyway.
- **A full database reset removes both halves together.** Settings → *Reset database* at the *full*
  level deletes the token and the pin in one transaction, so it can never leave a token whose pin has
  gone — the state above, which would otherwise be reported as tampering to somebody who had merely
  reset an instance. If a reset fails part-way, the connection is left whole rather than half-deleted.
- **A token refresh belongs to one connection, not just one organisation.** Each binding stamps the
  token row with a connection generation, and a refresh only writes back if that generation is still
  there. So a refresh that was in flight while somebody disconnected and reconnected — even to the
  *same* organisation, which is what happens at every ~28-day Demo reset — is discarded instead of
  overwriting the new connection's tokens, its granted scopes or its recorded demo status. It is
  recorded as `xero_refresh_discarded` and does not raise a notification, because nothing is wrong.

### The organisation allow-list (`XERO_ALLOWED_TENANT_IDS`)

The pin above lives in the **database**. A fresh database has none — a new instance, a reset, a restored
dump — which is precisely the state the incident happened in. Three environment variables give the same
protection at a level a database reset cannot erase:

```
XERO_ALLOWED_TENANT_IDS=5c949ed5-…,e7fb4378-…
XERO_BLOCKED_TENANT_IDS=e7fb4378-…
XERO_ALLOWED_TENANT_NAMES=Demo Company (UK)
```

- **Blank or absent means no restriction.** The control is opt-in, so an empty line in `.env` cannot
  accidentally disable every Xero connection.
- Changing any of them needs an **IMS restart**.

#### A tenant id is an identity. An organisation name is not.

The three keys are deliberately **not** equivalent, and this is the most important thing on this page.

A Xero **tenantId** is issued by Xero, is unique, and nobody in your organisation can change it. A Xero
**organisation name** is a label: it is not unique — `Demo Company (UK)` is what Xero calls *every*
demo company there is — and anyone administering an organisation can rename it from Xero's own settings
screen at any time. A check that a rename can satisfy is not an identity check, and the whole point of
this page is that a test rig once wrote 150 invoices into a live ledger.

So the keys compose as a chain of **filters** over the organisations on the consent. Every key that is
set can *remove* candidates; none of them can *add* one:

| Key | What it is | What it does |
|-----|-----------|--------------|
| `XERO_BLOCKED_TENANT_IDS` | identity | Refused everywhere, checked first. |
| `XERO_ALLOWED_TENANT_IDS` (and the deprecated `XERO_TENANT_ID`) | identity | The only key that **allows** an organisation. |
| `XERO_ALLOWED_TENANT_NAMES` | **not** an identity | Only **narrows** what the ids already chose. |
| `XERO_REQUIRE_DEMO_ORG` | identity, but **not an id** | Narrows to Xero **demo** organisations, using Xero's own flag. |

Consequences worth knowing before you configure this:

- Ids and names are **not a union**. `XERO_ALLOWED_TENANT_IDS=5c949ed5-…` together with
  `XERO_ALLOWED_TENANT_NAMES=Demo Company (UK)` allows one organisation — the one that is *both*. An
  organisation renamed to `Demo Company (UK)` does not get in on the strength of its new name.
- A name that matches **two** organisations on one consent is **refused**, not used to choose between
  them. It has just demonstrated, on that very consent, that it identifies neither.
- Naming the same organisation two ways is **not** a contradiction. `XERO_TENANT_ID=5c949ed5-…` plus
  that organisation's own name is one instruction spelled twice, and connects. Only an *empty
  intersection* — each key selecting a different organisation out of the same consent — is refused as a
  contradiction, and the message names what each key selected.
- Names ignore extra spacing and case. An organisation whose name contains a comma cannot be expressed
  in `XERO_ALLOWED_TENANT_NAMES` at all — use its id.
- **Do not use a name as your only tenant control.** IMS records
  `xero_tenant_guard_name_only` in the activity log when you do, because that configuration has no
  anchor a rename cannot move. `XERO_REQUIRE_DEMO_ORG=true` counts as an anchor and clears the warning:
  Xero asserts it, and the organisation's own administrators cannot.

- `XERO_REQUIRE_DEMO_ORG` **narrows like a name and anchors like an id**. It can never admit an
  organisation the ids exclude; it can only remove non-demo organisations from what the other keys
  already allowed.

#### When the connected organisation's id keeps changing (`XERO_REQUIRE_DEMO_ORG`)

Xero re-creates its **Demo company with a new tenantId** at every ~28-day reset, and any test
organisation you rebuild behaves the same way. An id *allow*-list then has to be re-edited every cycle,
which is exactly how a safety control ends up switched off.

**Require a demo organisation instead.** Xero's own `GET /Organisation` reports `IsDemoCompany` for the
organisation behind a token, and that is a fact about how the organisation was *created*: unlike a name
it cannot be adopted by renaming, and unlike an id it does not change when the Demo company is rebuilt.

```
XERO_REQUIRE_DEMO_ORG=true              # a Xero demo organisation, whatever its id this cycle
XERO_BLOCKED_TENANT_IDS=e7fb4378-…      # belt and braces: the live organisation, forever
```

This costs no extra Xero call — the connection callback already reads `GET /Organisation` to check base
currencies — and it covers **both** paths: a consent that offers a non-demo organisation cannot bind it,
and a production database restored onto the rig is refused at every sync, because the demo status is
recorded on the stored connection and re-checked on every use of it.

> **A deny-list alone does not restrict you to a demo organisation.** `XERO_BLOCKED_TENANT_IDS` refuses
> the organisations you thought to list. A **third** organisation — a bookkeeper's sandbox, a second
> company, anything else the person authorising the connection can reach — is neither blocked nor
> allow-listed, so it connects. `XERO_ALLOWED_TENANT_NAMES` cannot close that gap either, because any
> organisation can be renamed to `Demo Company (UK)`. Only `XERO_REQUIRE_DEMO_ORG` constrains the
> *kind* of organisation rather than enumerating ids.

**Unverified is refused, not allowed.** A stored connection whose demo status was never read — a token
from a restored dump, or one established before you switched this key on — has no proof attached, and
under this key an unproven demo organisation is not treated as a demo organisation. The fix is to
disconnect on `/sync` and connect again, which re-reads the flag from Xero. Connections made *after*
this key existed record the flag whether or not the key is switched on, so turning it on later does not
by itself force a reconnect.

A value that is neither yes nor no (`XERO_REQUIRE_DEMO_ORG=Demo Company (UK)`, say) refuses **every**
Xero connection rather than quietly meaning "off" — a line that reads like a guard and is not one is the
mistake `XERO_TENANT_ID` made, and it is not repeated here.

After a reset the database pin still names the *retired* tenantId, so the first reconnect is refused
with `this instance is pinned to Xero tenantId …, which this consent did not include`. **Disconnect Xero
on `/sync` first** — that clears the pin — then connect again.

Listing the same id on both `XERO_ALLOWED_TENANT_IDS` and `XERO_BLOCKED_TENANT_IDS` is refused as a
contradiction rather than silently resolved: it is two deliberate instructions that cannot both be
obeyed, and IMS will not pick one for you.

What it does when set:

1. **At connection time** — a consent offering no allowed organisation is refused, nothing is stored,
   and no Xero data is read or written. If the allow-list names exactly one of the organisations
   offered, that one is used even without a pin, so a rig can be connected safely without anyone having
   to pick from a list.
2. **Every time the stored token is used** — a stored connection to a disallowed organisation stops
   every Xero sync with a notification naming the organisation. This is what catches a **production
   database restored onto a test instance**: the token comes with the dump, no consent screen is ever
   shown, and without this check the instance would carry on syncing into the live ledger.
3. **Over the database pin** — the environment wins. A pin restored from another environment cannot
   smuggle its organisation past the allow-list.

**Set a control that does not depend on a name on every non-production instance** (e2e, staging, any
restored copy): `XERO_REQUIRE_DEMO_ORG=true` when the instance uses a Xero demo organisation,
`XERO_ALLOWED_TENANT_IDS` when it uses a specific non-demo test organisation, and
`XERO_BLOCKED_TENANT_IDS` naming the live organisation alongside either. Production may set
`XERO_ALLOWED_TENANT_IDS` to the live organisation or leave it unset — and must **not** set
`XERO_REQUIRE_DEMO_ORG`, which would refuse its own ledger.

### A non-production instance with no control at all is refused

That instruction used to be advice. It is now enforced: an instance that has **not declared itself
production** and has **no identity-strength tenant control** refuses to connect to Xero, and refuses to
use a Xero token it already has. This is the state the e2e rig was in when it invoiced into the live
organisation — 553 objects, 150 invoices, 14 payments, over eleven days — and "nothing is configured"
must not read as "any ledger is allowed".

- **"Not production" means** `NODE_ENV` is anything other than `production` (including absent), **or**
  `E2E_TEST_MODE=1`. Both signals are needed: the full-chain rig serves a production build, so `NODE_ENV`
  reads `production` there and only the e2e flag distinguishes it.
- **What clears it:** any one of `XERO_ALLOWED_TENANT_IDS`, `XERO_BLOCKED_TENANT_IDS`,
  `XERO_REQUIRE_DEMO_ORG=true` (or the deprecated `XERO_TENANT_ID`).
- **What does not:** `XERO_ALLOWED_TENANT_NAMES`. A Xero organisation name can be changed at any time by
  whoever administers it, so a name check is satisfied by a rename — the same reason a name can never
  widen an id list.
- **Production is exempt**, because production is the organisation every other instance is being kept
  away from. If a real production server hits this refusal, the fix is `NODE_ENV=production` in its
  `.env` (with `E2E_TEST_MODE` unset), not a weaker guard.
- **There is no switch that turns it off.** Every way out names an organisation or a kind of
  organisation, so performing the remedy leaves a record of which ledger the instance was pointed at.

The refusal is answered at both enforcement points — the OAuth callback (nothing is stored, no Xero data
is read) and every use of the stored token — so it catches a restored production dump, where no consent
screen is ever shown.

Refusals are recorded in the **Activity log** (`xero_connect_refused`, `xero_stored_tenant_refused`), so
a refusal that happened while nobody was watching the browser is still discoverable. A name-only
configuration is recorded there too, as `xero_tenant_guard_name_only` — once per connected organisation
rather than once per sync — because it is permitted but weaker than it looks.

#### Reconnecting to a different organisation

Only one organisation can be bound at a time, and IMS refuses a consent to a second one while the first
is still connected — so moving to a different organisation means **Disconnect on /sync, then Connect**.
That is also what the Demo company needs roughly every 28 days, because Xero re-creates it with a new
organisation id.

A reconnect is safe to do at any moment, including while a sync is running. IMS refreshes its Xero
access token about every half hour, and a refresh that was already in flight when you rebound the
connection is **discarded rather than stored**: the organisation is part of the database write, so a
token belonging to the organisation you just left cannot land on the connection you just made. It is
recorded as `xero_refresh_discarded` in the Activity log and deliberately does *not* raise a
notification — the connection is healthy, and one sync may simply have to be retried. If you see a
single Xero failure at the exact moment somebody reconnected, that is what it was.

##### Work that was already queued for the previous organisation

Anything sitting in the sync queue when you reconnect to a **different** organisation was built against
the one you left. An invoice payment names that organisation's invoice and that organisation's bank
account; an invoice names its contacts, items, account codes and tax rates. Every one of those is
meaningless — or, far worse, accidentally meaningful — in the new ledger.

Each queued row therefore records the connection it was composed for, and the sync **refuses to post a
row whose organisation is no longer the one connected**. Nothing is sent, and the row's error on
**/sync** names both organisations. Those rows belong to the previous ledger: settle them there, or
cancel them and re-drive the work from the source document so the payload is rebuilt against the
organisation that is connected now.

Two limits worth knowing:

- Rows queued **before this shipped** carry no such record and are still posted. Refusing them would
  have failed every payment already in the queue on the day of the upgrade; the unstamped population
  only shrinks from there.
- The check is made immediately **before** the row is posted, not held across the whole operation. A
  reconnect that lands in the split second between the check and the request is not caught by it — the
  env allow-list above is what constrains that case.

#### If you already set `XERO_TENANT_ID`

`XERO_TENANT_ID` is **deprecated**. It appeared in `.env.example`, in the installer and in the
environment-variable reference for a long time, describing itself as the Xero organisation id and
saying the app would fill it in after connecting — and no part of IMS ever read it. If you set it to
your live organisation and assumed the tenant was pinned, it was not: you had no protection at all,
which is worse than having no setting, because the name alone was enough to stop people looking harder.

It is now read, as a single-organisation form of `XERO_ALLOWED_TENANT_IDS`, and enforced on exactly the
same paths — the callback, the stored token, and over the database pin. **An instance whose only tenant
setting is `XERO_TENANT_ID` is genuinely restricted to that organisation from this release on.** If
that is not what you wanted, remove the line before upgrading.

Rename it when convenient:

```
# before
XERO_TENANT_ID=5c949ed5-…
# after
XERO_ALLOWED_TENANT_IDS=5c949ed5-…
```

Do not leave both `XERO_TENANT_ID` and `XERO_ALLOWED_TENANT_IDS` in place with different values. Two
*identity* settings that disagree are refused outright — every Xero connection and every sync stops with
a message naming both values — rather than IMS silently preferring one of two instructions you gave on
purpose. Setting both to the *same* single organisation is fine, so you can migrate without a gap, and
`XERO_TENANT_ID` alongside `XERO_ALLOWED_TENANT_NAMES` is fine too: a name narrows what the id chose
rather than competing with it.

### How to get your Xero Client ID and Secret

The Client ID and Client Secret come from a **Xero app** you create in the Xero Developer portal:

1. Sign in at <https://developer.xero.com/app/manage> with your Xero account.
2. Click **New app**.
3. Choose the **Web app** (OAuth 2.0 / Auth code) integration type.
4. Enter a **Company or application name** (e.g. "One Two Inventory") and your company URL.
5. Set the **OAuth 2.0 redirect URI** to your IMS callback — `https://<your-ims-domain>/api/accounting/callback` (it must match exactly, including https). On this install that is shown next to the field in the connection form.
6. Create the app, then open its **Configuration** page.
7. Copy the **Client id**.
8. Click **Generate a secret** and copy the **Client secret** — it is shown **only once**, so copy it before leaving the page.
9. Paste both into the IMS connection form, then click **Connect to Xero** to authorise.

Official guide: <https://developer.xero.com/documentation/getting-started-guide/>

Like other integrations, Xero sync is gated behind a successful connection test. The fingerprint includes the Client ID, expected tenant ID, and authenticated tenant ID/name. If you rotate the Client Secret or re-authorise to a different Xero tenant, re-test before activating sync.

### Permissions (scopes), and why a reconnect is sometimes required

When you authorise IMS, Xero grants a fixed set of **permissions** — invoices, contacts, payments,
manual journals, attachments, settings, and the trial balance report (`accounting.reports.trialbalance.read`,
used by the account-balance snapshot behind the reconciliation pack's as-of basis). **That grant is frozen at the moment you connect.** Refreshing
the access token does not widen it: a refreshed token carries exactly the permissions the original
consent screen granted.

So when a new IMS release needs a permission an older connection never granted, the syncs that need it
fail — and *only* those. Everything else keeps working, which is what makes it hard to spot. This is
not hypothetical: the `accounting.payments` permission was added for payment registration, and on
connections made before it, every invoice and bill was posted and marked paid in IMS while Xero never
recorded the payment at all.

IMS now records what Xero actually granted and checks it before running a sync that needs a particular
permission:

- The **Sync** tab shows a **"Reconnect required"** warning naming the missing permission(s).
- Affected rows fail with `REQUIRES RECONNECT: …`, naming the permission and stating that **nothing was
  sent** — instead of a bare `401 AuthorizationUnsuccessful` that could be any of a dozen causes.
- The account-balance snapshot refuses with the same `REQUIRES RECONNECT: …` message, without calling Xero,
  when the recorded grant lacks the trial-balance permission. **Installations connected before this
  permission was added must reconnect once** to grant it; until then no balance snapshot is stored.
- The fix is always the same: **Reconnect** on the Connection tab and approve the consent screen. Then
  retry the failed rows from the **Logs** tab.

A connection made before IMS started recording grants has no record of its permissions. Those are
treated as *unknown*, not as *missing* — nothing is blocked, and the record fills in on the next
reconnect.

### Disconnecting

Disconnecting removes the stored token **and forgets every Xero ID the IMS had cached** — the Xero
contact ID on each customer/supplier and the Xero item ID on each product. This is deliberate: those
IDs only mean anything to the organisation that issued them, so keeping them would hand stale IDs to
the next connection. After reconnecting (to the same org or a different one) the IDs are simply resolved again on first use. Nothing needs to be re-entered.

A cached ID also records **which organisation issued it**, taken from the request that produced it — so
even an ID that survived some other route (a restored database, a connector switch that bypassed
Disconnect) is ignored and re-resolved rather than used against a ledger that never issued it.

## Account Mapping

| IMS Account | Xero Account Type | Purpose |
|---|---|---|
| Sales Revenue | Revenue | Income from sales invoices |
| Shipping Income | Revenue | Shipping charges on sales |
| Discounts Given | Revenue / Expense | Order-level discounts |
| Stock in Transit | Asset | Every supplier bill line (product and cost lines alike) posts here; it also holds goods ordered but not yet received, and (when refund returns are held in transit) refunded goods not yet back. IMS has no separate Purchases account for bills |
| GR/IR (goods received, not invoiced) | Liability / Current liability | Clearing account the daily batch moves goods received but not yet billed into, out of Stock in Transit. Used only while **GR/IR accrual posting** is switched on; must differ from Stock in Transit |
| Purchase Price Variance | Profit and loss (cost of sales) | Reserved for the difference between a supplier bill and the order price on its own bill line under **per-event FX rates for purchasing** (off by default). **Nothing posts to it yet**: that bill line is step 3, not built. Today it is only a prerequisite: the switch cannot be turned on, and receipts are refused while it is on, with Xero sync on and this account blank. Leave blank while the switch is off; must differ from Stock in Transit, GR/IR and Inventory Asset |
| Inventory Asset | Asset | Stock on hand (available) |
| Allocated Inventory | Asset | Stock reserved for paid orders awaiting dispatch (stock on an order that ships before it is paid goes straight from Inventory to COGS and never passes through here) |
| Cost of Goods Sold | Direct Cost | COGS booked when goods ship |
| Unearned Revenue | Liability | Revenue deferred until goods ship |
| Manufacturing Overhead | Profit and loss | Overhead absorbed into manufactured stock cost (optional) |
| Inventory Revaluation | Profit and loss | Offset for retrospective cost corrections on goods already sold (optional) |
| Rounding Difference | Profit and loss | Absorbs sub-penny rounding so the inventory sub-ledger ties to the ledger. Also receives the one untaxed "Rounding adjustment" line that makes an invoice, bill or credit note total exactly what IMS holds, when a unit price IMS keeps to six decimal places is kept to four by Xero (see below). Needed only for such documents |
| Accounts Receivable / Accounts Payable | Your control accounts | Shown on the FX Gain/Loss report for reference only. IMS posts no foreign-exchange journal to them (Xero refuses manual-journal lines to its AR/AP system accounts). **Optional:** leaving them blank does not stop Xero sync being enabled (see below) |
| Realised and Unrealised FX Gain/Loss | Profit and loss | Not used for postings. Xero books realised currency gains (at the settlement rate IMS sends on each payment) and unrealised currency gains (its own revaluation of open foreign balances) to its own system accounts. The realised account is shown on the FX Gain/Loss report; the unrealised account is not read at all. **Optional:** neither stops Xero sync being enabled. The one exception is the realised account while **per-event FX rates for purchasing** is on: with Xero sync on it must be mapped (nothing posts to it yet; the check is for the step that will) |
| EU IOSS/VOEC VAT collected, EU DDP charges collected, EU landed-cost fees | See the EU sections below | Three roles for the EU VAT treatment. Configuration only and **not yet switched on**: leave them blank until told otherwise (see the EU sections below) |

**Which mappings Xero sync needs before it can be enabled.** The **Xero sync cannot be enabled yet** panel on the Accounts tab lists the missing mappings among Sales Revenue, Shipping Income, Discounts Given, Stock in Transit, Inventory Asset, Allocated Inventory, Cost of Goods Sold and Unearned Revenue; sync cannot be switched on until each is set. Accounts Receivable, Accounts Payable and Realised FX Gain/Loss are **report only**: when one is blank the tab shows *Not mapped (report only, does not block sync)* and the FX Gain/Loss report shows "not configured" for it, but sync can still be enabled, because IMS posts nothing to them. **While the per-event purchase FX switch (`purchase_event_fx_rates_enabled`) is on, Realised FX Gain/Loss and Purchase Price Variance are required**, and are listed among the missing mappings like the others (see Per-event FX rates for purchasing). The Unrealised FX Gain/Loss account is not checked at all. (Before this change all four were required, so a fresh install had to map accounts that nothing posts to.)

**Rounding adjustment on documents (invoices, bills, credit notes, supplier credits).** IMS keeps unit prices to six decimal places and Xero keeps four, so for a line such as 1,000 x 0.333333 Xero's own total, with its per-line tax, can differ from IMS's by a few pence, and a full payment would not settle the document. IMS predicts the whole total Xero will hold (each line rounded to the penny, tax worked out per line and rounded, for tax-exclusive and tax-inclusive documents), and when it differs adds one "Rounding adjustment" line (quantity 1, tax type No VAT) on the Rounding Difference account for exactly the difference. The document is then predicted again and must equal the IMS total. If it cannot be, nothing is sent and the sync row says why: no Rounding account is mapped, the tax rate of a line is not in the stored Xero tax-rate list (or the list is stale or the type has several components), or the difference is more than rounding can explain.

**Rounding to the order total (setting `xero_round_to_order_total_enabled`, off by default).** Xero works tax out per line while IMS's order total is worked out for the whole order, so even with no four-decimal loss a sales invoice can total a penny or two differently from the order (two lines of 0.025 at 20%: the order is 0.06, Xero's document 0.08), and a full payment cannot settle it. With the setting on (`true`), a sales invoice raised from an order carries the order total and the same single "Rounding adjustment" line is sized so the document totals exactly the order total. The adjustment is limited to the sum of two allowances: the rounding allowance of the document (0.02 a line, plus a tiny extra for four-decimal prices) and the order reconciliation tolerance (0.005 a line plus 0.03, with that tolerance alone capped at 1.00). The two are added and the sum is not clamped, so on a large order the limit can be a little over 1.00; anything bigger is refused with nothing sent. A credit note takes the order total only when it is the order's single full refund or a chargeback, and only from the invoice version Xero holds (if a newer invoice update is queued, failed or of unknown outcome, the credit note is posted per line). An order reversed through two or more refunds, for example a partial refund followed by a final one, is not rounded: each credit note posts at its per-line total, so against an invoice that was rounded the last pennies (the rounding amount) stay open and are settled by hand. With the setting off nothing changes: the document is built exactly as before, and the setting never changes the posting key of a document that is already queued.

## How Sync Works — Flowchart

The flowchart below shows every path an order can take through the Xero sub-ledger, from payment through to shipment. The daily batch runs Groups A1 → A2 → B in sequence each night.

```
┌─────────────────────────────────────────────────────────────────────┐
│                        ORDER RECEIVED                              │
│                  (WooCommerce or Manual)                            │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ▼
              ┌────────────────────────┐
              │  Invoice Created in    │
              │  Xero (AUTHORISED or   │
              │  DRAFT)                │
              └────────────┬───────────┘
                           │
              ┌────────────┴───────────┐
              │                        │
              ▼                        ▼
    ┌──────────────────┐     ┌──────────────────┐
    │  WooCommerce     │     │  Manual Order    │
    │  (pre-paid)      │     │  (invoice: see   │
    │                  │     │  posting mode)   │
    │  • AUTHORISED    │     │  • Payment       │
    │    invoice       │     │    polling every  │
    │  • Payment auto- │     │    15 min detects │
    │    registered    │     │    Xero bank feed │
    │  • paidAt set    │     │    match          │
    │    immediately   │     │  • paidAt set     │
    └────────┬─────────┘     └────────┬─────────┘
             │                        │
             └──────────┬─────────────┘
                        │
                        ▼
           ┌─────────────────────────┐
           │  ORDER IS PAID          │
           │  (paidAt is set)        │
           └────────────┬────────────┘
                        │
          ┌─────────────┴─────────────┐
          │                           │
          ▼                           ▼
┌───────────────────┐      ┌───────────────────┐
│  Stock Available  │      │  Backorder        │
│  (can allocate)   │      │  (no stock)       │
└────────┬──────────┘      └────────┬──────────┘
         │                          │
         ▼                          │
  ══════════════════                │
  ║ DAILY BATCH A1 ║◄──────────────┘
  ║ Revenue        ║   (applies to ALL paid orders)
  ║ Deferral       ║
  ══════════════════
  DR Sales Revenue
  CR Unearned Revenue
  (pull back auto-recognised revenue)
         │
         │                          │
         ▼                          │
  ┌──────────────┐                  │
  │  Stock        │                  │
  │  allocated?   │                  │
  └──────┬───────┘                  │
    Yes  │                          │ No (backorder waits)
         │                          │
         ▼                          │
  ══════════════════                │
  ║ DAILY BATCH A2 ║                │
  ║ Inventory      ║                │
  ║ Reclassify     ║                │
  ══════════════════                │
  DR Allocated Inventory            │
  CR Inventory Asset                │
  (reserve stock for this order)    │
         │                          │
         │        ┌─────────────────┘
         │        │
         │        ▼
         │  ┌───────────────────┐
         │  │  PO Received →    │
         │  │  Auto-allocate    │
         │  │  → Next batch     │
         │  │    picks up A2    │
         │  └───────────────────┘
         │
         ▼
  ┌──────────────┐
  │  Order ships │
  │  (one or     │
  │  more        │
  │  shipments)  │
  └──────┬───────┘
         │
         ▼
  ══════════════════
  ║ DAILY BATCH B  ║
  ║ Shipment       ║
  ║ Recognition    ║
  ══════════════════
  DR Unearned Revenue    (recognise revenue)
  CR Sales Revenue
  +
  DR COGS                (book cost of goods)
  CR Allocated Inventory
  (FIFO cost layers consumed)
         │
         ▼
  ┌──────────────────┐
  │  ORDER COMPLETE  │
  │                  │
  │  Revenue = Sales │
  │  COGS = Cost     │
  │  Inventory = 0   │
  │  Unearned = 0    │
  └──────────────────┘
```

## Sync Cases in Detail

> These cases are verified end-to-end (Woo stage → IMS → Xero Demo, read back from the Xero
> API) by the full-chain E2E tier, `e2e/full-chain/order-to-cash.spec.ts`: **Case 1** ≈ OC-01
> (paid order → ship → ACCREC invoice), **Case 2 / Case 4** ≈ OC-02 (under-stocked order ships
> the available units yet invoices the full order), and the shipping/fee line breakdown ≈ OC-11.
> See [`docs/ops/full-chain-e2e-runbook.md`](ops/full-chain-e2e-runbook.md).

### Case 1: WooCommerce Order (stock available, same-day ship)

This is the most common case. The customer pays via WooCommerce, stock is available and allocated, and the order ships quickly.

| Step | What Happens | Xero Journal |
|---|---|---|
| WC order syncs | AUTHORISED invoice created, payment registered | Invoice + Payment |
| Daily batch A1 | Revenue deferred (money received, goods not yet shipped) | DR Sales / CR Unearned Revenue |
| Daily batch A2 | Stock reclassified (reserved for this order) | DR Allocated / CR Inventory |
| Order ships | Stock dispatched, cost layers consumed | — |
| Daily batch B | Revenue recognised, COGS booked | DR Unearned / CR Sales + DR COGS / CR Allocated |

### Case 2: WooCommerce Order (backorder — no stock)

The customer pays but the item is out of stock. Revenue is deferred immediately, but inventory reclassification waits until stock arrives.

| Step | What Happens | Xero Journal |
|---|---|---|
| WC order syncs | AUTHORISED invoice, payment registered, no stock to allocate | Invoice + Payment |
| Daily batch A1 | Revenue deferred immediately | DR Sales / CR Unearned Revenue |
| *Time passes...* | Waiting for stock | — |
| PO received | Stock arrives, IMS auto-allocates the order | — |
| Daily batch A2 | Stock now allocated, reclassified | DR Allocated / CR Inventory |
| Order ships | Stock dispatched | — |
| Daily batch B | Revenue recognised, COGS booked | DR Unearned / CR Sales + DR COGS / CR Allocated |

### Case 3: Manual Order (invoice-first)

A manual order is created in the IMS. An invoice is pushed to Xero: **AUTHORISED by default** (the *Sales invoices* posting mode `xero_sync_sales_invoice` defaults to `submitted`), or **DRAFT** only while that mode is set to `draft`. Payment is detected when the customer pays via bank transfer and the bank feed matches.

| Step | What Happens | Xero Journal |
|---|---|---|
| Order created | Invoice in Xero (AUTHORISED by default; DRAFT only when `xero_sync_sales_invoice` is `draft`) | Invoice (AUTHORISED, or DRAFT) |
| Customer pays | Bank feed matches in Xero | — |
| Payment poll | IMS detects paid invoice, sets paidAt, advances status | — |
| Daily batch A1 | Revenue deferred | DR Sales / CR Unearned Revenue |
| Allocate + ship | Normal flow from here | A2 then B |

### Case 4: Partial Shipment (multi-warehouse)

An order is split across two warehouses. Each shipment is processed independently in Group B, with revenue proportioned by line value.

| Step | What Happens | Xero Journal |
|---|---|---|
| Order paid + allocated | Split across Warehouse A and Warehouse B | A1 + A2 |
| Shipment 1 ships | Warehouse A portion | — |
| Daily batch B | Revenue + COGS for Shipment 1's proportion | Partial DR Unearned / CR Sales + DR COGS / CR Allocated |
| Shipment 2 ships | Warehouse B portion | — |
| Daily batch B | Remaining revenue + COGS | Remaining DR Unearned / CR Sales + DR COGS / CR Allocated |

### Bundle / Kit note

For Kit / Bundle sales, the accounting flow still follows the shipment rows. COGS is derived from the underlying component cost layers consumed by the shipment lines, and refunds reverse those component-level COGS entries when stock is returned.

## Refund Handling

Refunds create a Xero credit note in all cases. Additional reversal journals depend on how far the order progressed through the sub-ledger:

| Order State | What Gets Reversed |
|---|---|
| Paid but not yet batched (A1 not run) | Credit note only — no journals to reverse |
| Revenue deferred, not allocated (backorder) | Credit note + DR Unearned Revenue / CR Sales |
| Allocated but not shipped | Credit note + DR Unearned / CR Sales + DR Inventory / CR Allocated |
| Partially or fully shipped | Credit note + DR Inventory / CR COGS (shipped portion) + unearned reversal (unshipped portion) |

### Settling a credit note: allocate it, or refund it (switch off by default)

A credit note IMS posts to Xero is, on its own, left open: it is not applied to the invoice it credits and, when the customer was paid back, no refund leaves the bank in Xero. With the system switch `xero_credit_note_allocation_enabled` on (off by default; set it with `npm run settings:set`, see the installation guide), IMS settles each posted sales credit note once **both the credit note and its invoice are posted**. The settlement is its own sync row, type `CREDIT_NOTE_ALLOCATION`, with its own claim and its own outbox job; it shows on **Sync** like any other row and is processed whichever runner is configured.

IMS decides what the settlement is when the row is claimed, from what it holds at that moment, in one step under the order lock:

- **The invoice has no receipt behind it** (no payment recorded, no registered payment, the order is not marked paid): the credit note reduces what the customer still owes, so IMS **allocates** it to the invoice in Xero.
- **The invoice was paid or part-paid:** the credit note is **not** allocated to the invoice. IMS posts a **refund payment against the credit note** from the bank or clearing account the original receipt's payment method maps to in the payment account map (Payment Method Mapping), but only when IMS holds evidence that cash left: a refund payment recorded on the order against the refund (Payments), or a WooCommerce refund that WooCommerce says went back **through the payment gateway** (`refunded_payment`, stored on the refund when it is imported).
- **Never a bank refund without that evidence.** A WooCommerce refund made manually (a store-credit coupon, a payment outside the gateway) moved no money out of the bank, and one imported before IMS kept the flag is unknown; neither posts a bank refund and neither is allocated to the paid invoice. The credit note stays open in Xero as the customer's credit and IMS raises one warning ("needs the operator") per refund: apply the credit to the invoice or refund it in Xero if it is owed. A manual refund of a paid invoice with no recorded refund payment waits the same way, and queues by itself once you record the refund payment.
- **Every refund payment is capped** at the smallest of: the credit left on the credit note in Xero; the receipts recorded on the order; and **what Xero shows as paid on the invoice** (its Amount Paid: cash receipts only; credit applied to the invoice is Xero's Amount Credited and does not count), less the refund payments already made, **in flight, or possibly made** against the order's other refunds, in IMS **or in Xero** (below). A 10 receipt with a 50 refund pays out at most 10. A receipt IMS recorded but Xero never booked (still queued, failed, or held back by the producer hold) therefore cannot be refunded. If Xero shows nothing paid, or Amount Paid cannot be read, no bank refund is sent and the sync row says why; the row **waits** without using up its retries: it is offered again after 15 minutes, then 30, 1 hour, 2 hours and so on, doubling up to 12 hours between tries. After 3 days of waiting, or 10 waits (about 2.7 days), IMS stops waiting: the row is **failed** with the reason and a warning in the order's activity, so a person looks at it (a receipt that never posted, or an invoice Xero shows as paid by an allocated overpayment, whose Amount Paid stays 0). **Retry** on /sync starts it again. The invoice is read before anything else, so a waiting row costs two Xero reads per try and no search.
- **Credit notes IMS did not raise are read from Xero first.** Before it settles a credit note, IMS searches Xero (read only) for the order's other sales credit notes: by the WooCommerce order id, by **every** refund id of the order (hand-raised credit notes often carry the refund id as their reference, for example CN-11453 "161212"), and by the number SC-<refund id>. Cash paid out on those credit notes (Xeroom-era refunds, or refunds made by hand in Xero) counts against the cap, so 40 refunded by Xeroom and 40 more by IMS cannot both go out against 50 received. A credit note **allocated** to another invoice moved no cash and is not counted: credit moved to a replacement order's invoice (CN-11394 to 157026) is correct, not a double credit. Voided ones are ignored. If Xero holds a credit note IMS did not raise that names **this** refund, nothing is settled. The same applies to one that names only the order and credits exactly this credit note's total, unless it is dated before the refund was made or another refund of the order (one IMS holds no credit note for, of the same amount) could own it. Such a refund is listed under **Credit notes held as possible duplicates** on Sync exceptions. Decide with the accountant which credit note stands. If the listed one belongs to another refund, use **Not a duplicate** with the reason (recorded with your name), and IMS retries the refund. If it is this refund's, use **It is this refund's**: a held credit-note create is then settled as posted with that credit note (IMS raises no second one), and a held settlement is settled as not posted (IMS does not allocate or pay out its own on top). The hold also clears itself once its sync row is settled or cancelled, or the refund gets its credit note. Only a refund that is not deleted and that IMS will never raise a credit note for (a Xeroom-era refund, or one with no live credit-note row) counts as a possible owner of an order-only credit note. IMS never asks you to void a credit note on its own reading. If the search cannot be read, nothing is sent and the row retries. **Which limit applies:** Xero's allowance is the organisation's, shared by every app including Xeroom: 1,000 calls per rolling 24 hours on this organisation's plan (larger Xero plans allow 5,000). To stay well clear of it, IMS spends at most 200 calls per day (UTC) on these settlement and duplicate-check reads, counted in the database across every sync run, the 5-minute cron and **Sync now** alike. Past that, rows wait 30 minutes without using a retry; those waits still age the row's episode, so a row starved by the budget is still failed for a person after 3 days.
- **A voided invoice is never settled against.** When the invoice is voided in Xero (orders that were combined: 158672's invoice is voided and 158671's carries both orders' goods and one shipping charge, so a refund of 158672's shipping is already netted there), nothing is settled and the row says so; settle the credit note in Xero with the accountant.
- **Two refunds of one order cannot both pay out the same cash.** A refund payment is sent under a lock on the order as well as on its credit note, and the cap is read again under that lock (with Amount Paid read again from Xero), counting what the order's other refunds have paid out or may have (a payment whose call has started, or whose response was lost). A refund that cannot take the order lock because another refund of the order is posting, or that finds under the lock that the cash has gone, **waits** and is offered again after a minute (doubling, as above) without using up a retry. While an older refund of the order has claimed cash but not yet made its call, a younger one waits too rather than being settled short for good. A settlement that waited or failed before anything was sent is decided again from the current figures, never replayed at its old amount; only a row that may already have reached Xero replays its saved request exactly (and is refused, not replayed, if that would now pay out more than was received).
- **A capped or part-paid refund leaves credit open, and IMS does not split a credit note.** When the refund payment is less than the credit left, the rest stays on the credit note in Xero and IMS logs a warning with both figures (credit left, amount due on the invoice). Apply that credit to the invoice in Xero if it is owed.
- **Foreign-currency refunds:** the refund payment carries IMS's settlement rate for its date as its rate, so Xero books the realised currency gain or loss at IMS's rate, exactly as for a receipt. If no rate exists for that date the row is refused with the usual "add the rate" message and nothing is sent.
- **The refund payment's date** (system switch `xero_refund_payment_cash_out_date_enabled`, off by default; set it with `npm run settings:set`). Off, the refund payment is dated, and rated, on the credit note's date. On, a refund whose cash evidence is a **refund payment you recorded** on the order (Payments, against the refund) is dated on the day that payment says the money went out (its Paid date; with several, the latest), and its exchange rate is the rate for that day, so a refund paid a week after the credit note is in the bank on the right day and the realised gain or loss is measured at that day's rate. A refund the payment gateway paid back keeps the credit note's date (the storefront refund is that day). A recorded payment dated before the credit note keeps the credit note's date, because Xero never dates a payment before the document it settles. The date and rate are saved on the row before anything is sent, so a retry sends the same payment; a payment that may already have reached Xero is never re-dated. Turned off again, a row not yet sent goes back to the credit note's date.
- **A settlement that finds nothing to apply** (Xero shows nothing due on the invoice, or no credit left) is retired, not posted, so a later change in what IMS holds can raise it again (at most once a day).

**Before IMS creates a sales credit note** (system switch `xero_credit_note_duplicate_check_enabled`, off by default; turn it on at the cut-over, before IMS posts sales credit notes), IMS runs the same read-only search of Xero with the same rules. The total compared is the refund's own gross (or the credit note's tax-inclusive lines, or the order total of a full refund). A credit note already under the very number IMS gave this one is treated as IMS's own (posted again, and Xero updates it in place) only when this row was tried before (an earlier try whose answer was lost) or the document carries exactly IMS's total and reference. Otherwise it is held: an SC-<refund id> credit note raised by Xeroom's store-credit plugin before the cut-over carries the same number. If a credit note IMS did not raise already credits the refund, nothing is created and the refund is listed under **Credit notes held as possible duplicates**, as above. An unreadable search sends nothing. Off, the credit note is created as before.

A retry never allocates or refunds twice: the decision is saved on the row before anything is sent, the ledger is checked first on a retry, and a retry that would now decide the other kind of settlement refuses and tells you to look at the credit note in Xero. The decision is saved on the row, including the bank account, the payment method and the exchange rate, so a retry sends the same payment. Xeroom owns sales credit notes in P1 and P2, so these rows are recorded but not sent, like the credit note itself, **but only while the producer hold is enforced for xero** (`PRODUCER_HOLD_ENFORCED_DESTINATIONS` names xero); without the hold the rows are live like the credit note.

### Storefront refunds the EAS and store-credit plugins changed (switch off by default)

WooCommerce refunds on EU orders are re-priced by the EAS compliance plugin, and refunds issued as store credit are written by the store-credit plugin. With the system switch `wc_refund_credit_note_parity_enabled` on (off by default; set it with `npm run settings:set`), IMS records these refunds the way the storefront's own Xero plugins do since November 2026. Off, every refund is handled exactly as before.

- **The fee left out of the refund amount.** EAS sometimes leaves a landed-cost fee (EU import duty, handling fee) out of the refund **amount** while the fee **items** stay on the refund (items 20.86, amount 17.86). A fee item on a refund means the fee is refunded, so IMS records the refund at the **item** total: the credit note credits the goods, the fee and all of their VAT (the VAT comes off the order's VAT account, 821, or 232 for DDP). This happens only when the shape is exact: the items less the fees equal the amount to the cent, goods are refunded too, every item is a credit, every fee has an amount of its own and names the order fee it refunds, and shipping is what the order charged. The order's activity log then shows a warning: the fee's money is repaid separately, so **apply that repayment to this credit note in Xero**. If the gateway refunded the customer, the refund payment IMS posts against the credit note is held to what the gateway actually paid back; the fee stays as credit on the note until its repayment is applied.
- **The fee's repayment.** The fee money then comes back as a second WooCommerce refund that refunds no goods and no fee (for example 3.00 with only VAT on it). If an earlier refund on the order carried a landed-cost fee (judged from the order's refunds in WooCommerce, so it holds even when IMS has not recorded the fee refund yet or it is parked), IMS does **not** raise a second credit note: the refund is held on the **Sync exceptions** page with the instruction (apply the payment to the earlier credit note in Xero, or check it by hand when the amounts differ).
- **Fees folded into the shipping line.** EAS can also put the fees on the refund's shipping line while the fee items stay (shipping 19.06 against 14.06 charged). Each refunded shipping line is compared with its own original line on the WooCommerce order. When the shipping excess equals the fees exactly, in net and in VAT, IMS sets the shipping back to what was charged and the credit note totals the amount paid back. A refund that is close to this but not exact, or whose shipping line cannot be matched to its original, is held on the **Sync exceptions** page with both readings; IMS never credits the inflated total. Any refund that carries a landed-cost fee and whose lines and amount disagree in some other way is held the same way, with an instruction, rather than retried for ever. Payment-gateway fee lines ("Stripe fee") are left out of the comparison, as the storefront's plugin leaves them off its credit notes; a refund that has one beside a landed-cost fee gap is held.
- **Refunds with no product lines** (shipping only, a fee only, or an amount only) are recorded and get a credit note like any other refund.
- **Store-credit refunds.** A refund the store-credit plugin issued as store credit gets a credit note only once IMS can see the credit is **live**: a **published** coupon in WooCommerce carrying the refund's store-credit attempt id. IMS reads the store's coupons for this (read only); the absence of the plugin's own "unfinished" markers is not enough, because discarding a waiting coupon, or a coupon that no longer exists, clears them while the refund stays. While the attempt is still in progress the refund waits on the **Sync exceptions** page (pending, retried on every sweep, one warning in the order's activity). If no live coupon can be found, or it is still not live 24 hours after the refund, the refund is **quarantined** with a message and nothing is raised: check the order's notes and coupons in WooCommerce. If the customer does hold the credit, use **Retry** on the row. If not, the refund stands with nothing given back: agree with the accountant how to put it right before changing anything in WooCommerce (do not discard or re-issue credit just to clear the row). Once live, the credit note is numbered **SC-** followed by the WooCommerce refund id, and it is never allocated to the invoice or paid out: the liability true-up nets these open credit notes off 813 by order.

- **VAT-only refunds are held.** A refund whose lines carry no net amount but which pays money back, with no earlier landed-cost fee on the order for it to repay, refunds VAT only. What its credit note must do depends on how Xero holds the invoice: on an invoice that is already ex-VAT (zero-rated: 159049, a 29.67 "refund VAT" against a 141.30 invoice) there is nothing to reverse and the right credit note is zero; on an IOSS order whose VAT was taken twice (162199, 39.71) it reverses that VAT out of 821 on No VAT. IMS cannot tell which from the refund, so it holds it on **Sync exceptions**.
- **The fee of an older order.** An order imported before IMS marked landed-cost fee lines has no mark on its fee line in IMS. IMS then reads the mark from the original fee item on the WooCommerce order (`_wclc_fee`), as the storefront's plugin does, so the fee gap and the fold are recognised there too.
- **Earlier means earlier.** When IMS judges whether a refund repays an earlier fee, only refunds made before it count (by their creation time, then their id); on a catch-up the store's list also holds later refunds, and a later fee refund is never one this refund repays.
- **Store-credit coupons** are looked up by the coupons created since an hour before the refund, oldest first, so a coupon edited many times since is still found. A refund WooCommerce reports with no creation time is held with that reason.
- **Woo double-recorded refunds** (157021: a manual 49.10 "full" refund plus a 5.95 gateway refund on a 49.11 order, where Xero is right with 5.95 paid back and 43.16 moved to the replacement order 157026): only the gateway refund is cash, and the manual one posts no bank refund. Compare such refunds with the money and the replacement order, not the refund totals. If IMS's refund ceiling refuses the second one, it is parked on **Sync exceptions** as before.

Rows these checks hold on **Sync exceptions** do not offer **Record manually**: the credit note it raises would be wrong for them (a second credit of the fee, an inflated total, or an ordinary credit note for store credit). Settle them in Xero with the accountant, as the row says, then use **Settled outside IMS** on the row: give the number of the Xero credit note it was settled with (IMS checks, read only, that Xero holds it as a live sales credit note whose number or reference names this order or refund) and a short reason. A VAT-only refund against an invoice Xero already holds ex-VAT needs no credit note: tick **No credit note is needed** and give the reason instead. It closes the row, records your name, the credit note and the reason (and the hold it closed) in the row and in the order's activity, and **creates nothing**: no refund, no credit note, no stock movement, nothing sent to Xero or WooCommerce. The refund is not synced again. Returned stock, if any, is not restocked by it: adjust stock by hand if items came back. It needs the same permissions as Record manually and a fresh sign-in.

**Fee repayments to apply** are a list of their own on **Sync exceptions** ("Fee repayments not yet applied in Xero"), as the storefront's plugin keeps them: every recorded refund whose credit note credits a landed-cost fee EAS left out of the refund amount, until someone applies the fee's repayment to that credit note in Xero and clicks **Repayment applied** (with a note of what was applied; your name is recorded; a credit note number given there is checked in Xero too). Closing the repayment's own held row as settled outside IMS does **not** clear it, and nothing else does: an outstanding repayment never disappears because a later refund was dealt with. Each open one counts in the exceptions total.

These rules change what IMS records, not who posts it. Credit notes go through the ordinary queue and the producer hold, so while Xeroom owns sales credit notes (P1 and P2, with `PRODUCER_HOLD_ENFORCED_DESTINATIONS` naming xero) they are recorded and not sent.

### Order discount posted per VAT rate (switch off by default)

For a manual order priced with `sales_order_discount_tax_apportion_enabled` on, the invoice posts the order-level discount as several negative "Order discount" lines, one for each VAT rate among the order's lines, all to the Discount account, so Xero's VAT per rate equals the order's. The invoice is refused (nothing sent) if those lines do not add up to the discount. A credit note for a refund of such an order reverses each rate's share on that rate's tax code. An automatic chargeback on such an order is not raised; it is logged as `chargeback_requires_manual_handling` and the credit note is raised by hand. IMS's own record of the invoice (the accounting event) lists the same per-rate discount parts, and the reconciliation pack's VAT check (R12) takes each rate's share of the discount VAT off that rate, so it compares like for like with Xero. Orders priced without the switch are unchanged in both.

### Chargebacks and the order-level discount

When the payment poller sees a payment reversed, IMS raises a **chargeback** credit note that
unwinds the whole remaining order. Whether that credit note carries an order-level discount line is
decided by **what the sales invoice actually posted**, not by the current Account Mapping:

| What the posted invoice carried | What the chargeback does |
|---|---|
| A discount line, to an account that is still the configured Discount account | Mirrors the discount line |
| A discount line, but the Discount account has since been removed or changed | Refuses — raise the credit note manually (logged as `chargeback_requires_manual_handling`) |
| No discount line (the invoice charged the full goods value) | Credits the full goods value, no discount line (logged as `chargeback_discount_line_omitted`) |
| Unreadable | Refuses — raise the credit note manually |

Orders with no recorded accounting document for the invoice fall back to the older rule: the
Discount account being configured is taken as the signal that a discount line was posted.

This is why it matters: if the Discount account was configured *after* an invoice posted, that
invoice charged the full goods value. Reversing it with a discount line would credit less than was
charged and silently leave the difference on the customer's account.

**Credit note void (a refund deleted in IMS).** When a refund recorded in error is deleted in IMS (see the Refunds help page), a credit note that was already posted is voided in Xero through the normal outbox. The delete is two-phase: IMS changes nothing about the refund until this entry succeeds, and then unwinds the refund as part of the same entry. Before the void is sent, IMS locks the order, the returned stock and the cost layers that return created, checks the delete again and carries out the whole unwind; only then, as the last step, is the void sent to Xero, and the unwind is saved together with it. Each lock wait is limited to a few seconds, and the void call itself does not wait out Xero rate limits (a rate-limited void is simply retried later). If anything refuses first (for example another order has used the returned stock meanwhile, a journal the unwind needs is switched off, or refund delete was switched off), nothing is sent to Xero, the refund and its credit note both stay, and the entry fails with the reason. If an earlier attempt may already have reached Xero, IMS reads the credit note in Xero before it reports anything: when Xero shows it voided and the refund can still be unwound, the retry finishes the delete; when Xero shows it voided but the unwind is refused, the order gets the operator task **Credit note voided in Xero for a refund being deleted, but the IMS refund still stands**, saying what to clear before retrying the entry. Once the unwind is done the order is re-reserved, as when the delete happens in one step; if that fails, the order's activity log shows a warning to allocate it from the order page. The Xero connection is refreshed before the locks are taken, and the void is never sent once too little of the locked step's time is left (it then waits and tries again). An attempt that sent nothing (a lock held by other work, too little time, a rate limit, outbound writes held) waits 15 minutes without using up a retry, and without reading Xero; after 96 such waits (a day), counted from the entry's last failure or retry, it fails like any other entry. A refusal is always checked against Xero first: only when Xero shows the credit note still standing, and no attempt of the entry can have reached Xero, is the entry closed (cancelled, with a warning on the order), and the delete can simply be asked for again. When Xero shows it voided (for example an older IMS version, after a rollback, voided it without recording the attempt), the voided-but-standing task above is raised instead; when Xero cannot be read, nothing is closed and the entry waits and reads again. The entry that uses up its retries raises the operator task **Credit note void in Xero gave up after repeated failures for a refund being deleted**, once per time it gives up (a new one after a retry, once the earlier task is marked done). Both refund-delete tasks are listed under **Sync > Exceptions** in their own section, *Refund deletes that need you*, not with the warehouse queries. The sync page shows it as **Credit note void** against the deleted refund. It is **off unless** the credit note sync type is on, it follows the same posting hold as every other write (nothing is sent while outbound writes are held), and it is queued by the delete itself, never sent from the delete.

How it behaves when it runs: it **reads the credit note first** and decides from what is there, so a retry after a lost response, or after a partial failure, converges. A credit note already **Voided** (or deleted) is a success and nothing is sent. An *Authorised* one is set to **Voided**; a draft one is deleted. One that has been **allocated to an invoice or paid out in Xero** is refused with that reason and is never changed: reverse the allocation or payment in Xero, then retry the entry. The credit note keeps its number as its audit trail; numbers are never reused because they come from a counter that does not go back. IMS refuses to start the delete when the credit note's date is on or before the lock date it last read from Xero, because Xero does not accept a change in a locked period. A posted COGS reversal journal is countered the same way, by a new journal with its lines swapped, queued as a COGS reversal against the deleted refund; an unsent one is simply cancelled.

## Transaction Types

Configure which documents are synced to Xero under **Integrations → Xero → Transaction Types**. Each type can be set to **Off**, **Draft**, or **Submitted** (AUTHORISED in Xero):

| Type | Description |
|---|---|
| Sales Invoices | Push invoices to Xero when an order is created |
| Credit Notes | Push credit notes on refund |
| Credit note settlement | With `xero_credit_note_allocation_enabled` on, apply a posted credit note to its invoice, or refund it against the credit note (see Settling a credit note). Follows the Credit Notes setting; no setting of its own. |
| Purchase Bills | Push supplier bills when a PO is invoiced |
| Stock Receipts | Journal: DR Inventory / CR Stock in Transit on goods received — raised by a receipt entered in IMS, by a WMS booked-in webhook against a purchase order (o3d-8f0p6), **and** by a WMS stock-sync *align-up* correction that absorbs the units into an open purchase-order ASN line (o3d-6nd55). Each raises it for the value it actually brought into stock — the goods cost plus that line's share of the order's additional costs, counting only freight orders that have not been cancelled — and each excludes units another of the three has already accounted for, so one delivery is never posted twice. A warehouse-to-warehouse stock transfer raises none: its value never left inventory, and neither does a free-of-charge line, which has no value to move. **Late landed cost on units still in transit between warehouses (o3d-nrl4):** because a transfer posts nothing, those units are still in Inventory, so when a freight order is added, edited or cancelled after the goods were bought, the landed-cost reclass journal (`STOCK_IN_TRANSIT`) includes their share in the same entry the on-hand units get — DR Inventory / CR Stock in Transit for an increase, the reverse for a decrease — at the moment the landed cost changes. Only the part of a transfer line that has not landed counts (a manual receipt or a WMS book-in **and** a WMS stock-sync alignment credit all count as landed). The later receipt, or the cancellation of the dispatch, posts nothing: the units arrive at the revalued cost. A second change, a reversal or a cancelled freight order posts its own difference. A landed-cost change made before this behaviour existed, while units were in transit, is not repaired retrospectively. |
| COGS Reversals | Reverse COGS on stock returns. DR Inventory / CR COGS; for a refund whose returned goods are held in transit (`refund_returns_in_transit_enabled`, off by default) DR **Stock in Transit** / CR COGS, with a matching `CUSTOMER_RETURN_IN_TRANSIT` row in the transit sub-ledger that the daily transit reconciliation sums (not written when the journal is only a shadow). See `docs/refund-in-transit.md`. |
| Inventory Adjustments | Journal for manual stock adjustments |
| Manufacturing Journal | Capitalise per-run overhead (labour, machine, etc.) on assembly/disassembly: DR Inventory / CR Manufacturing Overhead. Includes the retro-recalc reclass (`MANUFACTURING_RECLASS`) when cost lines are edited after completion. |

## Invoice Numbers

**IMS supplies the invoice number; Xero does not allocate it.** The number sent as `InvoiceNumber`
is the one already recorded on the sales order:

| Order origin | Number sent to Xero |
|---|---|
| WooCommerce | `_wcpdf_invoice_number` from the WooCommerce order, verbatim — the same number printed on the customer's PDF |
| Manual / IMS-created | The order's own invoice number if one has been generated, otherwise the Invoice Prefix from Settings → Company → Document Numbering plus the order reference |

Two things follow from this, and both matter.

A number is minted only when none is queued: if the order's invoice is already queued or posted, **Generate invoice number** (and the on-paid and on-shipped triggers) record the number that invoice was queued under instead of minting a second one, so the number on the PDF is the number in Xero.

**One order, one number.** The create is an *update-or-create on `InvoiceNumber`*, so re-posting the
same order replaces its own document instead of adding a second one. That property only holds while
every route posts the *same* number for an order — which is why the number recorded on the sales
order always wins over one derived at push time.

**A missing number stops the post.** If a WooCommerce order has no `_wcpdf_invoice_number`, nothing
is queued and a warning is logged; IMS never substitutes a number of its own. See
`docs/woocommerce.md` § When WooCommerce has not numbered the invoice yet.

### The ownership check before every sales-invoice create

Because the create upserts on `InvoiceNumber`, posting under a number Xero already holds does not
produce a duplicate — it **replaces** the document that holds it. IMS therefore asks Xero who holds
the number immediately before every sales-invoice create, and posts only when the answer is
*nobody*, or *a document this order is already linked to*.

Anything else is refused. Nothing is sent, the sales order stays un-invoiced, and the reason is on
the sync row and in the activity log as `sales_invoice_number_not_ours`:

| What the check found | What IMS does | What you do |
|---|---|---|
| Nobody holds the number | Posts, after recording on the sync row which number it is about to post under | — |
| The document this order is linked to holds it | Posts (this is a re-post of our own invoice) | — |
| **Another document holds it, and IMS does not own that document** | Refuses | This is the cutover case: xeroom almost certainly already invoiced this order. If the existing Xero invoice is the right one, leave it and cancel the IMS sync row. If this order genuinely has no Xero document, link the correct one to the order (or void the wrong one in Xero) and re-queue |
| The order is linked to one document but a *different* one holds the number | Refuses | Either the link or the number is wrong. Establish which document belongs to this order before anything is posted |
| A **voided or deleted** document holds it | Refuses | Xero will not accept a modification of a voided document. Resolve it in Xero, then re-queue |
| **More than one live document** holds it | Refuses | Which one an update-or-create would replace cannot be established from outside Xero — not even when one of them is yours. Void or renumber all but one, then re-queue |
| **Xero could not be asked** (disconnected, rate-limited, network) | Refuses, and retries by itself | Nothing — the row re-runs once the connection is healthy. If it persists, fix the connection |
| **Xero's answer could not be shown to be complete** (a full page of documents came back) | Refuses, and retries by itself | Nothing automatic. If it persists, look for the pile of documents sharing that number in Xero — the check will not guess past a result it cannot see the end of |
| **The number contains a comma** | Refuses, permanently | Xero's number filter reads a comma as the separator between two numbers, so IMS cannot ask who holds *this* one — and "no documents" is exactly the answer that would let it overwrite. Change the number in WooCommerce (it is taken verbatim from `_wcpdf_invoice_number`, so this is usually a prefix or suffix in the PDF plugin's number format) and re-queue, or post the invoice in Xero by hand and link it to the order |
| **Another IMS sync row is already posting under the same number** | Refuses, and retries by itself | Nothing — the other row settles within seconds and this one retries. If it keeps happening, two queued invoices genuinely carry one number: cancel the duplicate. Logged as `sales_invoice_number_in_flight_elsewhere`. Numbers are compared the way Xero compares them, so `INV-1` and `inv-1` count as the same number here |
| **Building the invoice took longer than 15 minutes** | Refuses, and retries by itself | Nothing — the next run asks Xero again from scratch. Preparing an invoice makes one Xero call for the contact and one per distinct product, so a very large or heavily rate-limited invoice can outlast the answer that authorised it, and IMS will not post on an answer that old. Logged as `sales_invoice_number_answer_stale` |

The refusals other than the last are verdicts about what is in Xero, not transient errors. The row
still retries a handful of times before it settles as FAILED with the reason on it — and those
retries are how a resolved refusal picks itself up: once you have linked the correct Xero document
to the order (or voided the wrong one), the next retry sees the number as ours and posts. If it
runs out of retries first, re-queue the invoice from the sales order. Either way, **a refused post
is recoverable and an overwritten live invoice is not.**

**What this protects, and what it cannot do.** The documents at risk are not a rival system's
future posts — xeroom is *removed* at cutover, not run alongside. They are the **~14,415 invoices
xeroom already posted**, which stay in Xero under exactly the numbers IMS now takes from
`_wcpdf_invoice_number`. They are always there when the check asks, so the check sees them — and
after cutover there is no second system left to notice if it ever failed to. That is why the check
refuses whenever it cannot show that it read Xero's answer in full.

What it cannot do is see a document that appears between the check and the post. With xeroom gone,
only two things can land there. **A second IMS worker is now fenced off:** immediately before the
create leaves — not before IMS starts building it — the sync row takes an exclusive slot on the
number, and a row that finds another row already in flight under the same number stands down rather
than posting. So two queued invoices carrying one number produce one document and one retry, not one
document and a silent overwrite.

Three details of that fence matter if you are reading a refusal:

* **The slot is taken at the last possible moment — and re-taken for every send attempt.** Preparing
  an invoice calls Xero once for the customer contact and once per distinct product, and those calls
  are rate-limited, so preparation can take minutes. A slot taken before all of that could have
  expired by the time the invoice was sent, which is why it is now taken after it. Sending is not
  instant either: if Xero rate-limits the create, IMS waits and tries again, and a wait can outlast
  the slot. So the slot is checked and renewed inside each attempt, immediately before the request
  goes out. A retry that finds the number taken in the meantime stands down instead of sending.
* **Numbers are matched the way Xero matches them.** Case and surrounding spaces are ignored, because
  Xero treats `INV-1` and `inv-1` as one document; if IMS treated them as two, both workers would
  think they were alone.
* **Nothing depends on the servers' clocks agreeing.** Which worker gets the slot is decided by a
  database lock, and the fifteen-minute expiry on an abandoned slot is measured by the database, not
  by the machine running the sync.

What remains is somebody typing an invoice into Xero by hand in the same second, which no check
inside IMS can see.

IMS deliberately does **not** treat "I was about to post under this number" as proof that the
document now holding it is mine: that reasoning would only ever be used when the number *is* held,
which after cutover means the check missed one of the historical documents — so it would repeat an
overwrite instead of reporting it. See o3d-k26m.8.

One consequence worth knowing in advance: if a post reaches Xero and the *response* is lost, the
order's invoice is not re-posted automatically any more. The next attempt sees the number held by a
document IMS cannot recognise and refuses. Open the invoice in Xero, confirm it is the one for this
order, link it to the order, and the next retry updates it instead of replacing it.

And the check costs one extra Xero API call per sales-invoice create, which counts against the
1,000-call rolling daily limit.

> **Cutover note.** Xeroom posts the *same* numbers to the *same* Xero organisation, and it is being
> removed rather than run alongside IMS — so the check above is not there to referee two live
> systems. It is there for what xeroom leaves behind: every order it has already invoiced keeps a
> real document under the number IMS would post. Expect a refusal for each of those if it is
> re-imported, backfilled or re-queued, and treat a refusal as the system working. Switch xeroom off
> for the orders IMS will handle before enabling Sales Invoices against the live organisation.

## Order attachments are not sent to Xero

Files attached to purchase and sales orders (the **Attachments** card on the order page) are **never** pushed to Xero in this version. They stay in IMS. The existing bill-attachment follow-up (`BILL_ATTACHMENT`, which attaches a supplier invoice PDF to the bill) is unchanged and does not read order attachments. Whether supplier documents should follow the bill into Xero is an open decision for the owner; until it is made, attach the document in Xero by hand if the accountant needs it there.

## Multi-Currency FX Rates

Every sales invoice, purchase bill, credit note and **payment** pushed to Xero is stamped with a `CurrencyRate` derived from IMS's own rate: a document's stored `fxRateToBase` (SalesOrder, PurchaseOrder, SalesOrderRefund), a payment's settlement rate. This stops Xero from substituting its own daily XE.com rate, which previously caused 1–3 % drift between IMS base totals and Xero base totals on the same multi-currency document. **A foreign-currency document or payment without a usable IMS rate is never sent**: it is refused (see the table below), because leaving `CurrencyRate` out is exactly what makes Xero apply its own rate.

**Rate flow:**

```
rate source chosen by fx_rate_source → /api/cron/fx-rates → fx_rates table (FxRate)
  (Aelia, the store's currency switcher, is the master: owner ruling 2026-10-26;
   ECB via frankfurter.dev is the default until the source is switched)
       ↓
fxRateToBase stamped on SalesOrder / PurchaseOrder / SalesOrderRefund at creation
(a PurchaseOrder: ALWAYS the fx_rates table rate, never a typed one)
       ↓
queueAccountingSync() includes currencyRateToBase in the payload
       ↓
Xero adapter sends it as is (Xero's convention is the same: 1 base = X doc-ccy), rounded to 6dp
       ↓
CurrencyRate sent on Invoice / Bill / CreditNote API call
```

`fx_rates` is the one table every IMS rate read uses. Which source fills it is the **Exchange-rate source** setting (`fx_rate_source`, Settings → Accounting → FX Rates): Aelia is the exchange-rate master by owner ruling, and ECB (frankfurter.dev) is the default until that setting is switched to Aelia. See [Aelia as the FX master](woocommerce.md#aelia-as-the-fx-master-flag-default-off).

**Direction conventions:**

- **IMS** stores `fxRateToBase` as: 1 base = X doc-currency (e.g. base GBP, doc EUR ⇒ 1 GBP = 1.18 EUR).
- **Xero** `CurrencyRate` is the SAME: 1 base = X doc-currency (units of the foreign currency per one unit of the base currency). The connector sends `fxRateToBase` as is, **never inverted**, rounded to 6dp to match Xero's `Decimal(18,6)` schema. A foreign amount is put in base by dividing by the rate: a USD 1,000 bill at 1.3125 is GBP 761.90 in Xero.
- *How this was confirmed (2026-11-22, read-only, live organisation, base GBP):* bills PI260907OTD (USD) at `CurrencyRate` 1.352650993, POQ468 (EUR) at 1.1835295458 and INV20261102001 (CNY) at 8.937375334 are each the number of foreign units per GBP. IMS previously sent the reciprocal (`1 / fxRateToBase`); that was corrected before any foreign document or payment had been sent from IMS.

**One lookup for every rate read.** Every IMS read of an exchange rate goes through `lib/currencies/fx-lookup.ts` (`getFxRateToBase`, with `getFxRatesToBase` / `resolveFxRatesToBase` for many currencies at one instant), against the `fx_rates` table:

- `FxRate.rate` means 1 base = `rate` foreign, so `base = foreign / rate`. The base currency is the organisation's (Settings → Company), never a literal.
- A foreign currency equal to the base is 1. Nothing else is ever defaulted to 1.
- The row used is the latest one for that base and currency with `fetchedAt` on or before the caller's `asOf`. `asOf` is always supplied by the caller; the lookup has no implicit "now" (a caller that means now passes `new Date()`).
- **Date rule.** A business date (document date, payment date, valuation date) maps to the END of that day, UTC: 23:59:59.999 (`endOfBusinessDateUtc`). A rate fetched at any time that day is therefore that day's rate; a rate fetched at 00:00 the next day is not. A caller holding an instant (an order's creation time) passes the instant itself.
- Two rows at the same latest `fetchedAt` are accepted only if they carry the same rate; different rates refuse (`ambiguous_rate`). A zero, negative or non-numeric latest rate refuses too; an older good row is not substituted.
- A missing rate refuses with `MissingFxRateError` and a closed reason (`no_rate`, `non_positive_rate`, `non_finite_rate`, `ambiguous_rate`, `invalid_currency`, `invalid_base_currency`, `invalid_as_of`). The owner ruling (2026-10-24) is that a missing rate never falls back to 1, to a document's booked rate or to a vendor's own rate; callers that still carry such a fallback are being moved to refuse (epic `[one-fx]`). The settlement, revaluation and refund/credit-note paths below have been moved; **what to do when one refuses: add the missing rate in Settings → Currencies (or correct the document's own exchange rate where the message says so), then repeat the action.**

**What's covered:**

| Path | FX rate stamped? |
|---|---|
| WooCommerce order import | Yes — `currencyRateToBase` set from the FX rate looked up at import time |
| Manual sales invoice (DRAFT → finalised) | Yes — read from `SalesOrder.fxRateToBase` |
| Sales credit note (refund) | Yes — read from the txn-level FX rate computed for the refund |
| Purchase invoice (PO → bill) | Yes — read from the PO's `fxRateToBase` at invoice time |
| Payment against a foreign invoice or bill | Yes — the settlement rate IMS resolved for that payment when it was recorded, **stored with the receipt** (`payments.settlement_rate_to_base`; a bill payment carries it on its queued work from the same transaction) and carried on every enqueue of it (first, deferred re-drive, operator re-drive, ledger-check action) — never recalculated, so a rate that lands later the same day cannot change an existing receipt; a foreign receipt recorded before the column existed has none and is refused (`foreign_payment_missing_rate`), no fresh lookup. Carried on the queued payment and sent as the payment's `CurrencyRate` (the rate as is, 6 dp); Xero books the realised FX at that rate (see *Realised FX* below). Never looked up at send time |
| Same-currency invoices and bills (base currency) | Unchanged: `CurrencyRate = 1` is sent when the document carries a rate of 1, and the field is omitted when it carries none (Xero books a base-currency document at 1) |
| Same-currency payments | Unchanged: no `CurrencyRate` |
| Payment registered for a WooCommerce-imported foreign order | Yes — an imported order is paid in its own currency at the time it was booked, so the settlement rate carried on the payment is the order's own stored booked rate (Xero therefore books no realised FX for it) |
| **Foreign** invoice, bill, credit note (any of the six document types) with a missing, zero, negative, non-finite or unparseable rate | **Refused, not queued.** The enqueue returns `refused` (the posting stays owed), writes no sync row and records an exception-inbox row named `foreign_document_missing_rate`; the connector builders refuse again (they throw before any payload, contact or item request exists), so a row that reaches them some other way is also not sent. **Operator action: correct the document's exchange rate, then raise the posting again** |
| **Foreign** payment with no stored settlement rate | **Refused, not queued** (inbox reason `foreign_payment_missing_rate`); the payment poster refuses again before any claim or request (`... not sent: ... carries no usable IMS rate ...`). A payment payload that names no currency is refused too. **Operator action: add the rate in Settings → Currencies for the payment date, then record the payment again** |

**Refunds and credit notes use the booked rate, and refuse without one.** A refund, a chargeback's discount line, a supplier credit note and a hand-recorded WooCommerce refund are all converted at the exchange rate stored on the order or bill they reverse (never a fresh table rate). A document in the base currency is 1 because its currency is the base currency. A foreign document whose stored rate is missing, zero or negative is **refused by name before anything is written** (`<document> is in USD but has no usable stored FX rate to GBP`): the refund or credit note is not created and nothing is converted at 1. A WooCommerce refund that hits this is not lost: it is parked as a quarantined refund (the sync-exceptions inbox, with the message above and an `refund_sync_missing_order_fx_rate` activity entry). **Operator action: correct the document's exchange rate, then record or retry the refund from the inbox.**

**Connector-agnostic design:** the optional `currencyRateToBase` field is on the generic `InvoiceData` / `BillData` / `CreditNoteData` types (`lib/connectors/types.ts`). The Xero connector sends the same number as `CurrencyRate` (Xero's convention is IMS's), rounded to 6 dp.

**Downstream push to WooCommerce.** Aelia, the store's currency switcher, owns the storefront rates. While the source is `ecb` the rate refresh still attempts the IMS-to-store push (`pushFxRatesToConnectors`), but the onetwoInventory Helper plugin 1.3.0 refuses every rate push and no longer overrides Aelia's rate, and a refused push is recorded as a skipped row in the push log. While the source is `aelia` IMS never pushes (the push is disabled in code). The daily rate refresh fills `fx_rates` from the source the `fx_rate_source` setting selects: `ecb` (the default; frankfurter.dev) or `aelia` (IMS reads Aelia's pre-markup rates through the helper plugin; the exchange-rate master by owner ruling, but it only applies once the setting is switched to `aelia`, `lib/currencies/fx-source.ts`, `lib/currencies/aelia-ingest.ts`). See `docs/woocommerce.md` for the plugin.

**A purchase order's rate is the table rate, never a typed one** (owner ruling 2026-10-25). `createPurchaseOrder`, the draft edit, the replenishment PO generator, the purchase-order CSV importer and the form all take the rate from the one lookup (`resolvePurchaseOrderFxRateToBase`, which calls `getFxRateToBase`); the former 2% override band (`PURCHASE_ORDER_FX_OVERRIDE_TOLERANCE`) is gone. A PO is priced at the moment it is saved (the first load prices its orders at the end of their created day). A bill pushed to Xero therefore carries a `CurrencyRate` that IS an `fx_rates` row. An admin who needs another rate pins a manual override row (below); a stored PO rate is never rewritten.

**A stored receipt is never left unregistered.** A receipt (a payment recorded by hand with Add payment, a WooCommerce paid transition, an imported paid order) is committed before its INVOICE_PAYMENT is queued. If the invoice had not posted yet, the invoice post registers it. If the invoice had already posted and the queueing failed, nothing used to retry it; now the scheduled FX-rates cron run sweeps every non-refund receipt on a posted invoice that has no INVOICE_PAYMENT row and no refusal notice (receipts older than 5 minutes, up to 50 per run, oldest first, recently failed ones behind) and registers it. Registration is keyed per receipt and document, so the inline call and the sweep never register it twice. Nothing is swept when no accounting connector posts payments.

### Payment matching (Sync > Payment matching)

A customer receipt IMS holds but Xero does not (a manual payment recorded after the invoice posted, a receipt of a payment method that had no bank account mapped at the time, a foreign-currency receipt refused for a missing rate) used to stay unregistered until someone noticed the unsettled badge. The **payment matching pass** looks for these on every FX-rates cron run (up to 50 per run) and matches each one to the open Xero invoice of its order, **by payment method and currency**, using the same *Payment Account Mapping* as every other payment. It is a sweep, not an event, and it adds no second way of posting: a live registration goes through the same path as Add payment and the receipt sweep above.

**The mode** is set on the Sync > Payment matching page (administrators only) and is **off by default**:

| Mode | What happens |
|---|---|
| **Off** | The matching pass does nothing. It does not stop the scheduled receipt sweep described above, which registers receipts with no payment row and no refusal notice in every mode. |
| **Shadow** | Every candidate receipt is evaluated and listed on the page: the payment, the invoice, the bank account, the amount, the amount still open on the invoice, and the reason when it cannot be matched. **The matching pass sends nothing to Xero** and queues no sync row. Only receipts the scheduled receipt sweep leaves alone (those that carry a refusal notice) are listed, because the sweep registers every other eligible receipt in every mode, so listing it as "would post" would report work already done. Use it to review what live would do. |
| **Live** | A receipt the evaluation says would post is claimed (one durable row per receipt, so a rerun or two sweeps at once cannot register it twice) and registered through the existing path. |

**What the pass never does.** It never guesses a bank account: no mapping for the payment method and currency means *Not matched*, and the page says which method and currency to map. A receipt in a different currency from its invoice is *Not matched*. It never pays more than the amount still open on the invoice, in the invoice's currency (a part payment within what is open is allowed, as for any receipt). It never moves a payment out of a locked period: a receipt dated on or before the books lock date IMS imported from Xero is *Held back* and keeps its own date. A foreign-currency receipt without its stored settlement rate is *Held back*. While the outbound write hold is on, every match is *Held back* and nothing is posted.

**Reading the page.** *Would post* (shadow only) is what live would register. *Not matched* means there is no safe match until the mapping or the currency is fixed. *Held back* names the rule that stops it (locked period, outbound write hold, over the amount due, an earlier payment attempt on the invoice that must be checked in Xero first). *Failed, will retry* is a live registration that did not reach the record; it is retried each run up to five times, then left for a person. *Registered* rows leave the list; the registration then posts like any other and shows in the sync log.

A receipt that already has a payment row in the sync log is never a candidate: its registration, in whatever state, belongs to the retry paths described below.

**Manual overrides and push log.** Settings → Accounting → **FX Rates** shows the current rate per currency, with a source badge (`ECB (frankfurter)`, `Aelia (before markup)` or `Manual override`). Pin a manual rate via the pencil icon — the daily fetch will then skip that currency until the override is cleared (the undo icon re-fetches from the configured source: frankfurter under ECB, the store under Aelia). The same panel includes a recent-pushes table (one row per fan-out attempt to a shopping connector) so you can see whether the latest push to WooCommerce succeeded.

The full unified-FX rollout plan is tracked in `docs/todo/unified-fx-rates-plan.md`.

## Sub-Ledger Settings

### Daily Batch Sync

When enabled, the nightly cron job runs three groups in sequence:

- **Group A1 — Revenue Deferral**: Any paid order that hasn't been deferred yet. Prevents Xero from showing inflated revenue before goods ship.
- **Group A2 — Inventory Reclassification**: Allocated orders only. Moves stock value from Available to Allocated on the balance sheet.
- **Group B — Shipment Recognition**: Per-shipment. Recognises revenue and books COGS using FIFO cost layer consumption.

**COGS is booked when the goods ship, whether or not the order is paid.** A shipment made BEFORE its order was paid (the order is unpaid, or the shipment's ship time is earlier than the payment time) and not yet deferred by Group A1 is costed on its own journal, dated the day it shipped: **DR COGS / CR Inventory**, at the same FIFO cost the ordinary path uses. Allocated Inventory is not involved, because Group A2 has not reclassified that stock. The invoice already put the revenue in Sales, so the shipment posts **no** revenue leg; it only records its revenue share. The shipment is marked (`cogsRelievedFromInventoryAt`, with the amount and the journal that carried it) in the same step. When the order is later paid: Group A1 defers only the part that has **not** shipped yet (the order still stores the full deferral, so the shipping true-up and the refund balances stay consistent); Group A2 reclassifies only the units still to ship and skips the ones already costed; and Group B never costs those units a second time. An order that is never paid and is written off keeps its cost, because the cost was booked when the goods left. A refund entered before the order's first batch run takes value out of the Unearned Revenue deferral only for the part that was deferred (the not-yet-shipped goods are refunded first); the part for goods that already shipped is reversed by the credit note alone, because that revenue never left Sales. A refund that returns stock from such a shipment reverses its cost as **DR Inventory / CR COGS** (never into Allocated Inventory), whether or not the order has been paid since. The shipment is costed in a first pass of the batch that runs before revenue deferral and the inventory reclassification, so paying the order before the next run does not move the cost off the day it shipped. If staging that reversal fails, the refund's accounting retry stages it again. A shipment made at or after the payment time is never costed this way, even if the order's first batch run comes later: it goes through deferral, reclassification and the ordinary shipment pass (a shipment at exactly the payment time counts as after payment). An order with shipments on both sides of payment gets each one on its own path. An unpaid order is only costed once IMS has posted its invoice (the invoice is what books the revenue).

**Journal dates.** Each journal carries the date of the event it records, not the day the batch ran: revenue deferral is dated the day the order was **paid**; the inventory reclassification the later of the day it was paid and the day its stock was allocated; shipment revenue and COGS the later of the day the goods **shipped** and the day the order was paid (Group B never recognises revenue before the payment that created the deferral); COGS for a shipment costed before payment is dated the day the goods **shipped**. Rows with different dates in one run become one journal per date, so the nightly batch can raise several journals, and a late run no longer pushes March activity into April. Dates are UTC days.

**Locked periods.** Xero rejects a journal dated inside a locked period. IMS **imports** the lock date from Xero (a read-only call to the Organisation endpoint, which returns the period lock date and the year-end lock date; the later of the two is used, with the `accounting.settings` permission IMS already holds). It is read at the start of every daily batch run and whenever the chart of accounts is synced (the scheduled refresh or **Sync Chart of Accounts**), and shown, read-only, under the chart of accounts on the Xero settings screen as "Books locked up to <date> (read from Xero <when>)". It cannot be edited in IMS: change it in Xero. The batch will not back-date into it: an event on or before that day is journalled on the first open day instead (the day after the lock), the journal's narration says which event dates were moved, and a warning `daily_batch_locked_period_event_moved` is logged. If the day after the lock is still in the future (the lock reaches today), there is no open day: nothing is staged for those events, a warning `daily_batch_blocked_by_lock_date` says "Xero books are locked up to <date>, after today; ... wait until the lock is moved or the period opens", and they are picked up on a later run. The same rule covers every other way the batch queues a journal: a failed journal dated on or before the lock is not requeued, a missing batch dated on or before it is not rebuilt, and the rounding sweeps do not post on a locked as-of date; each is skipped with a warning `daily_batch_journal_skipped_locked_period` naming what was skipped. If the read fails, the last stored date is used and a warning `xero_books_lock_date_read_failed` is logged; the batch never waits on it. If a date has never been read, journals are dated by event and a journal Xero refuses appears as a failed row on the Sync page.

**Refunds entered before the first run.** A refund recorded before an order's first batch run (a net refund, from this release's refund writer) is netted out of that order's revenue deferral, so a partial refund no longer leaves Unearned Revenue holding the refunded value. The deferral journal itself stays at the full amount on the day the order was paid, and each such refund is posted as its own adjustment (DR Unearned Revenue / CR Sales) dated the day of the refund (never before the payment), so a refund entered in a later period never changes an earlier period's journal. Each refund records the adjustment journal that netted it, so a lost adjustment is rebuilt exactly once by the missing-batch sweep and reported by the accounting checks (`refund_deferral_adjustment_without_sync_evidence`) until it is. Refunds recorded after the deferral keep using the refund reversal journals described above. A refund from before refunds were stored net is not netted (its tax-inclusive total cannot be subtracted from a tax-exclusive deferral) and is left for the lifecycle tie-out to report.

Group A1 reads each order's subtotal, shipping and discount to work out how much revenue to defer, and it reads them before it opens the transaction that writes the journal. If any of those orders changes in that window — in practice only the one-off WooCommerce coupon backfill does this — the whole group is **refused rather than posted**, because the journal it had prepared would no longer match the orders it names. Nothing is staged and no order is marked as deferred, so the next night's run simply recalculates from the corrected figures. The refusal appears in the run's errors and as an `accounting_daily_batch_stale_order_discount` entry in the activity log, naming each affected order and both amounts.

### Per-event FX rates for purchasing (off, being built)

A switch, **`purchase_event_fx_rates_enabled`**, is being built in three steps to value foreign-currency purchases at the rate of each accounting event instead of the rate the order was raised at. **It is off by default, and while it is off nothing changes**: receipts, bills, stock layers, journals and everything sent to Xero are exactly as before. It is set by an admin from the command line (`npm run settings:set`), and it refuses to turn on while Xero sync is on and either the **Realised FX Gain/Loss** or the **Purchase Price Variance** account is unmapped. **It also refuses to turn on at all until step 3 is installed** (a built-in interlock, `PURCHASE_EVENT_FX_STEPS_COMPLETE`, which step 3 flips): until then the command answers "cannot be turned on yet", however well the accounts are mapped.

**What step 2 (this release) does while it is on: goods received at the prepayment rate.**

- Record each supplier payment in Xero as **Spend Money > Prepayment**, at the exact rate your bank used, with the **purchase order number as the Reference**, paid to the supplier's Xero contact.
- IMS **reads** that prepayment from Xero (it never changes it): from the order page (**Xero prepayment exchange rate > Read from Xero**), or by itself just before a receipt that needs it. A rate IMS has already stored and a receipt has used is never read again. A rate stored but **not yet used by any receipt** is read again once before the first receipt (unless it was read in the last five minutes), so a prepayment you voided and re-entered in Xero is picked up; the stored rate is replaced, or removed if Xero now holds none. Each of these reads counts against the Xero request budget shared with the other integrations. A **receipt you make by hand, and a bill, always ask Xero**. A warehouse book-in or alignment relies on a "no prepayment" answer only while it is **at most 15 minutes old** (older, it asks again first, so a prepayment you have just recorded is not missed); the hourly alignment asks about each order **at most once per run**, however many products it carries, and an order whose prepayment could not be established is not asked about again by the warehouse for 15 minutes (Xero unreadable) or an hour (ambiguous prepayments). **Read from Xero** on the order always asks and refreshes the answer at once.
- **The supplier must be matched to its Xero contact.** If the supplier is not yet linked to a Xero contact, IMS looks (read-only, never creating anything) for the Xero contact with the supplier's email, then its exact name, and if that is the contact the prepayment was paid to it stores the link. There is no screen to set the link by hand: if the receipt is refused for this, make the Xero contact's name (or email) exactly the supplier's name (or email) in IMS, then receive again.
- The goods of the receipt are valued at the prepayment's rate: the stock layer, the receipt, the GR/IR accrual and the stock receipt journal all use it, and the journal's description names the rate. Freight and duty are added on top as before.
- **No prepayment in Xero:** the goods use the exchange-rate table rate on the day of the receipt. If the table has no rate for that currency, the receipt is refused and nothing is booked; add the rate (Settings > Accounting > FX Rates) and try again. **While Xero sync is on this is reported**: the receipt screen shows a warning that the receipt used the table rate because Xero holds no prepayment with the PO number as its Reference, (saying when Xero was asked) and an entry (action `purchase_receipt_fx_table_rate`, WARNING) is written to the activity log, also for receipts made by the warehouse book-in and the alignment. Most often the Reference typed in Xero is not exactly the PO number.
- **A prepayment recorded after earlier receipts applies to LATER receipts only.** Receipts already made keep the table rate they were valued at (each receipt stores its own rate and source, and nothing is revalued afterwards); the prepayment found later is locked for the receipts that follow. The order page lists every receipt (and every Mintsoft alignment) with the rate it used (**Xero prepayment rate** or **Exchange-rate table rate**) and says how many receipts were valued at the table rate. Step 3 works out the exchange differences per receipt.
- **IMS will not guess.** The receipt is refused, with the reason, if Xero holds more than one live prepayment with that reference, if the prepayment is in another currency, if it was paid to a different contact, if the supplier cannot be matched to its Xero contact (see above), or if Xero could not be read. Fix it in Xero and receive again. A warehouse (Mintsoft) booking-in refused only because **Xero could not be read or its request budget is spent, or the table has no rate for that moment yet** waits and is retried every 30 minutes without using up its retry attempts, **up to 10 waits or 3 days**; after that it counts as a failed attempt and a WARNING (`mintsoft_booked_in_fx_wait_capped`) says the goods are not in stock. A **blank account mapping**, or a currency the exchange-rate table has **never** held, does not resolve by waiting and counts as a failure straight away. A refusal for real ambiguity (several prepayments, another currency or contact) counts like any other failure. An alignment refuses only if the order with the problem is one it would actually absorb units into, and a book-in only the orders it actually receives.
- Once a receipt has used the rate it is fixed for that order; reading again later reports a difference instead of changing it.
- While it is on and Xero sync is on, receipts are refused if the **Realised FX Gain/Loss** or **Purchase Price Variance** account is blanked, and the Xero readiness panel (Accounts tab) lists both as **required** mappings (not merely reported) for as long as the switch is on.

**What step 3, part 1 (this release) does while it is on: the supplier bill.**

- A foreign bill is sent to Xero at the order's **prepayment rate** (so the prepayment allocation closes with no exchange difference), or, with no prepayment in Xero, at the exchange-rate table rate **on the bill date**; with no table rate the bill is refused and nothing is saved. The rate is worked out for each bill and kept on it; editing the bill keeps its rate.
- Each goods line's stock part stays at the **order's cost**. **Any** difference between the bill's price and the order goes on a separate bill line, coded to **Purchase Price Variance**, in the supplier's currency, with the same VAT treatment. Quantity differences are not expensed: billing is limited to what was received (or ordered, for a prepaid supplier) as before.
- When the goods were received at a different rate than the bill (a receipt at the table rate before the prepayment was recorded, or table rates on different days), IMS posts a **GBP journal per bill**: Realised FX gains/losses against Stock in Transit, for exactly the difference, worked out receipt by receipt. Editing the bill, or goods arriving after the bill, posts only the change; deleting or voiding the bill reverses it. The GR/IR report's **FX difference** column shows it, and GR/IR and Stock in Transit both net to zero for the order.

**Not yet (step 3, part 2):** supplier returns and supplier credit notes at the bill's rate. Until it is released the switch cannot be turned on.

### GR/IR accrual posting (goods received, not invoiced)

IMS keeps a **GR/IR sub-ledger** (see Purchasing) that accrues with every receipt, bill, bill edit, supplier return and return credit note. **Posting it to Xero is off by default.** The setting is **GR/IR accrual posting** (`grir_xero_posting_enabled`, Settings > Accounting > Xero > Sub-Ledger), and the account is **GR/IR** (`xero_grir_account`). While the switch is off the daily batch reads nothing, stages nothing and consumes nothing, and the sub-ledger and the GR/IR report keep accruing; nothing reaches Xero.

IMS already posts a receipt as **DR Inventory / CR Stock in Transit** and a bill as **DR Stock in Transit / CR Accounts Payable**, and Stock in Transit already nets the two to zero. What was missing is the separation: goods received before the bill leave a **credit** hidden in Stock in Transit. Posting Inventory DR / GR/IR CR on receipt and GR/IR DR / AP CR on the bill **on top** would count the stock and the liability twice, so the switch adds a **reclass** instead. When it is on and the Daily Batch is on, each run takes every GR/IR movement not yet consumed, groups it by journal date (a date in a locked period is moved to the first open day, and the run waits while the lock reaches today, exactly like the other groups), and stages one **GR/IR reclass** journal per date for the net:

- net **received not billed** rose: **DR Stock in Transit / CR GR/IR**
- net fell (a bill, a return): **DR GR/IR / CR Stock in Transit**

Together with the receipt and bill journals that is exactly Inventory DR / GR/IR CR on receipt and GR/IR DR / AP CR on the bill, and Stock in Transit is left holding only what is genuinely in transit (billed, not received) and freight. Each journal is also recorded in the transit sub-ledger (source `GRIR_RECLASS`), so the Stock in Transit reconciliation keeps tying out; the reconciliation pack's transit schedule counts it as its own leg. The movements a journal was built from are stamped with its reference in the same step, so no movement is ever posted twice, and a day that nets to nothing posts no journal.

- **Freight and landed cost** are not in GR/IR; they follow the Stock in Transit path as before. **A price difference** between a bill and the order is not in GR/IR either (see Purchasing); it stays on Stock in Transit.
- **It goes through the same write seam and hold as every Xero posting.** With the producer hold enforced, the journal is recorded as a shadow (status Cancelled, never posted by IMS), nothing is queued, and the transit sub-ledger records nothing, because the ledger did not move. The movements behind a shadowed journal are **not consumed** (unlike the sales batches), so they post on the first run after the hold is lifted.
- If the switch is on but Stock in Transit or the GR/IR account is not mapped, the run says so in its errors and consumes nothing; the movements wait.
- Switching it on later posts the movements accrued since the sub-ledger began (their net is the open balance), dated by the day each happened.
- A journal Xero rejects is retried like any other daily batch journal. A journal an operator cancels is not rebuilt, as for the other batches.

### Payment Polling

When enabled, the IMS polls Xero every 15 minutes for:

- **Paid sales invoices** (manual orders only — WC orders arrive pre-paid)
- **Paid purchase bills** (all POs — detects when a bill is paid via bank feed)
- **Reversed payments** on either (payment removed or invoice voided — clears `paidAt`)

**A part payment is not a reversal.** Xero moves an invoice back to *AUTHORISED* whenever it is no
longer *fully* paid — which includes a bill that carries a real **part** payment, the ordinary cause
being an IMS bill total lower than Xero's (a line or freight added in Xero after IMS posted it). The
poll therefore reads what the ledger actually **holds** (`AmountPaid`), not just the status: `paidAt`
is cleared only when nothing is paid against the document any more *and* the IMS has no payment
registration of its own that this Xero read cannot speak for (see below), or the invoice was voided.
A **voided** invoice is the one unconditional reversal — Xero requires every payment to be removed
before a void and refuses a payment against a voided invoice, so re-arming there cannot move money
twice.

When the document is no longer fully paid but the ledger still holds a payment — or Xero's answer did
not say how much is paid — the reversal is **withheld** and a WARNING is logged against the order or
purchase order instead (*"…is AUTHORISED in Xero (not fully paid), but the ledger still holds a
payment of …"*). Nothing is cleared and, on the sales side, no chargeback credit note is raised. This
matters most on bills: clearing `paidAt` re-arms **Mark Paid** in the UI, and pressing it registers a
**second** supplier payment on top of the part payment. Settle the balance in Xero, or correct the
bill total in IMS.

**A sales invoice that loses PART of its payment is recorded, not reversed.** When a payment Xero used to hold against a
sales invoice is deleted or reduced, the invoice reads *AUTHORISED* with less paid than the IMS recorded (the IMS holds the
order as paid in full). If the order was marked paid **from Xero**, the shortfall is a removal, and the IMS measures it from
Xero's own figures: the amount the IMS recorded as paid (the order total, less any shortfall already recorded) minus what Xero
reports as paid against the invoice. The IMS then:

- **Records the amount on the order** as *not received* (`Payment removed from Xero`). **Paid** stays set, because revenue was
  recognised on the payment, but the order is no longer **fully** paid: the order list shows **Part paid**, the order page shows the
  reduced paid figure and the balance due, the receivables reports and customer balances include the missing amount, the invoice PDF
  drops its **PAID** stamp, and the order is not sent to the warehouse until the shortfall clears. **Mark Paid** is not re-armed, so
  nothing can be paid twice.
- **Names the payment**, when it can. If a payment the IMS registered is no longer among the payments Xero lists, and the missing
  payments add up to the measured amount exactly, the warning names the Xero payment id. Otherwise the amount is the only
  identification, and the warning says so.
- **Warns once.** An order warning *Part of a payment is no longer in Xero* and an admin notification carry the exact figures (Xero
  paid, IMS recorded, amount removed, order total). Because the removal is now on the order, later polls and rechecks of the same
  Xero state measure nothing and write nothing: the withheld warning for this document closes on its next recheck and does not
  repeat. A further removal adds to the recorded amount; a payment that comes back subtracts; an invoice that reads **paid** again clears it **only when Xero's payments cover it** (no allocated credit). An invoice that reads paid because a credit settled it keeps the recorded amount and warns once, because a credit settling a removed payment is the credit-versus-write-off decision, not the payment coming back. Receivables reports for an earlier date use the amount that stood on that date, from the recorded history. **Limit:** receivables reports read the order's *current* paid flag, as they always have. An order whose paid state was later cleared outright (a full payment reversal, a deleted payment, or Mark Paid turned off) therefore shows as unpaid in a report dated before that clear, and its earlier shortfall is not subtracted; only the order's payment rows stand for it there.
- **Does not touch revenue and does not post to Xero.** No credit note is raised and no deferred or recognised revenue is unwound.
  Whether the removed amount should be **credited** (a credit note against the sale) or **written off as a bad debt** is an accounting
  decision for the order owner, so the IMS leaves it to them and the warning says so. Credit notes you raise in Xero or in the IMS
  follow the usual refund path.

Not measured, and left withheld exactly as before: an order paid in a shopping channel or marked paid by hand (the ledger's figure is
then the IMS's own silence, not a removal), an order that already has a credit note or refund, an invoice that also carries allocated
credit in Xero, an invoice in a different currency from the order, a payment registration that had not finished when Xero was asked,
and any figure Xero did not state. A **full** removal (nothing paid any more) is unchanged: the zero-paid proof above decides it.

**But a payment that is present need not be *ours*.** If somebody in Xero deletes the payment the IMS
registered and applies a different one in its place, the ledger still holds *a* payment — and reading
only the amount would keep the bill marked paid for ever, with the supplier never actually paid. So
every withheld document is asked the narrower question as well: is the payment **the IMS registered**
still listed on the invoice? The IMS records the Xero payment id when its registration posts, and
compares it against the payments Xero lists. Only when every payment the IMS registered is provably
absent is the reversal acted on — `paidAt` is cleared, and the log names the payment id that vanished
and the residual amount that is somebody else's.

Everything else stays withheld, and the warning now says why: the registered payment is still there
(a genuine part payment), the IMS never registered one, Xero did not list the payments, or a
registration had not finished when Xero was asked — the last being the few seconds between **Mark
Paid** setting the flag and the payment actually posting, where "not listed yet" must never be read as
"removed".

On the sales side a reversal established this way clears `paidAt` but raises **no** chargeback credit
note: a chargeback unwinds the whole recognised revenue, and the invoice still carries a payment. The
alert says so — unwind revenue by hand if that is what the removal means.

**A payment removed to be re-applied does not raise a chargeback.** Removing a payment in Xero in order to re-match it (remove it, then apply it again against the right invoice or bank line) leaves the invoice unpaid for a few minutes. An invoice whose Xero revision is less than **30 minutes** old and that shows nothing paid is **withheld** (*"…was changed in the last 30 minutes. That is what removing a payment in order to re-apply it looks like…"*): `paidAt` stays set and no chargeback credit note is raised. IMS asks Xero again within the hour. If the payment is back, the warning closes by itself and nothing was raised. If the invoice is still unpaid, it is then treated as a genuine reversal, exactly as before. A **voided** invoice is not delayed.

**And a ledger holding *nothing* is not proof either.** "Nothing paid against this bill" is what a
removed payment looks like — and it is equally what a payment the IMS registered *seconds ago* looks
like, because **Mark Paid** sets `paidAt` at once and the worker posts the payment to Xero afterwards.
A poll landing in that gap used to clear `paidAt`, re-arm **Mark Paid** over the IMS's own in-flight
payment, and invite a second supplier payment: nothing downstream would refuse it, since Xero's
idempotency key expires after six minutes.

So a zero-paid document is put to the *same* registration question as a part-paid one before anything
is cleared. It is treated as reversed only when the IMS can account for every payment registration it
holds against the document — the registration posted before Xero was asked (so the empty ledger covers
it), or there is no registration at all, or every one of them is cancelled. If any registration is
still queued, on the wire, **failed**, or finished after this Xero read was taken, the reversal is
**withheld** exactly as a part payment would be, and the warning names the sync entry in question.
A *failed* attempt counts as unresolved deliberately: the connector posts before it records the
outcome, so a lost response is written down identically to a rejection.

**"No registration at all" now depends on where the paid flag came from.** That arm is right for the
document it was written for — one the IMS marked paid *because Xero said so*, through the payment poll
or the backlog reconcile. If Xero later holds nothing, the payment really has been taken away and
clearing `paidAt` is the point of the pass.

It is wrong for a sale the IMS holds as paid on evidence Xero was never given. A **WooCommerce** order
is marked paid from the channel's own payment date, and an order marked paid **by hand** in the IMS is
marked paid because somebody said so; neither of those puts anything into Xero by itself. An empty
Xero invoice against one of them is not a removal — it is the IMS's own silence — and acting on it
cleared `paidAt` and raised a **chargeback credit note against a customer who really had paid**.

So each sale records *where* its paid flag came from, in the same write that sets it. A sale paid by a
channel or by an operator, with no payment registration that has demonstrably reached Xero, is
**withheld** and reported: check the payment in the sales channel, then reverse the order by hand if it
is genuinely gone, or register the receipt so the two agree. The moment a payment registration *has*
posted, the recorded origin stops mattering and Xero's own list decides again — so a genuine
**WooCommerce chargeback is still detected and still unwinds revenue**, exactly as before.

**Recording a receipt replaces that origin only when the receipts settle the order.** Adding a payment
to an order that was already marked paid by hand is the ordinary way to put the money on the ledger,
and the recorded origin is dropped when it happens — the flag now has a real receipt behind it, and
that receipt is registered with Xero like any other. But IMS accepts **part** payments, and the origin
is a statement about the *whole* paid balance: a £1 receipt against a £100 order marked paid by hand
does not make the other £99 any less off-ledger. So the origin is dropped only once the payments
recorded against the order **cover its total**. Until then the order behaves exactly as it did before
the part payment: the receipt is registered, the reversal decision waits for that registration in the
usual way, and an empty Xero invoice with nothing left to speak for it is still **withheld** rather
than charged back.

**A part-paid document is reported, not reconciled.** IMS does not unwind the difference: there is no
partial credit note and no partial reversal of recognised revenue. A part-paid **Xero** invoice is
warned about on every poll and reconciled by nobody, so the order goes on reading as fully paid until
somebody acts. If a payment really was taken back, raise the credit note for it by hand and correct the
order. If the *rest* of the payment goes later, the document reaches a zero paid amount and IMS
reverses it in full on its own.

**A withheld verdict is asked again on a timer.** It cannot be left to resolve itself: the delta
returns an invoice only when it *changes*, and what usually settles a withheld verdict is not a change
in Xero at all — it is the IMS's own registration finishing, or somebody cancelling a failed one.
Neither touches the invoice. So every hour the poll takes the withheld documents that have rested
longest, reads those invoices **by id** (bypassing the delta entirely) and re-runs exactly the same
decision. When the disagreement is settled — the reversal is finally acted on, the ledger catches up,
or the IMS no longer holds the document as paid — the record is **closed** and the document leaves the
queue for good. While it is still withheld the warning is simply rewritten, which restarts its timer
and sends it to the back of the queue, so one stuck document can never crowd out the others — the
queue is built one entry per **document**, from each document's most recent warning, so a document
that has been withheld for weeks cannot fill the page with its own history and hide the ones behind
it. Documents that have already been **closed** are dropped before the queue is cut to size, for the
same reason: a settled document keeps its old warning for the rest of the thirty-day window and that
warning never moves again, so counting it would let weeks of finished work occupy every place in the
round and leave the documents that still need an answer permanently unasked. The operator alert is
raised once, when the verdict is first withheld, not on every recheck.

A recheck that could not be completed **closes nothing**. If Xero does not answer, or does not return
one of the invoices, or a database read fails while the answer is being turned into a verdict, the
document is deferred — asked again on the next round — rather than treated as settled. "We could not
decide" and "there is nothing left to decide" look the same from outside, and only one of them is
safe to act on.

A registration that genuinely never posted stays undecided for ever on its own, and that is what the
recheck keeps visible: reconcile the bill in Xero and **cancel** the named sync entry, which takes it
out of the question without destroying the evidence that an attempt was made. The next recheck then
lets the verdict through.

**A withheld verdict is an alert, not just a log line.** Withholding writes nothing to the
database, so the warning is its only record — and the poll then moves its cursor past the invoice,
which the delta returns only when it changes again. Each withheld verdict therefore raises a
notification to every active admin as well as the activity warning, and if either write fails the poll
**holds its cursor** so the disagreement is re-derived on the next poll rather than lost.

**"Had this payment posted yet?" is answered by the database's clock, not by any server's.** Deciding
that a payment was *removed* rests on knowing whether the IMS's own registration had already reached
Xero when the snapshot was taken. The IMS runs on more than one instance, and comparing the clock of
the instance that posted the payment against the clock of the instance running the poll is not an
ordering at all: if the polling instance ran even a little ahead, a payment posted *after* the snapshot
looked as though it had posted *before* it, and its (perfectly correct) absence read as proof of
removal — clearing `paidAt` and re-arming **Mark Paid** over money that had already left the bank.
Both ends are now timestamps taken from the database itself: the registration is stamped by the
database when it completes, and the poll asks the database for the time immediately before asking
Xero. If the database cannot answer, the poll orders nothing and withholds every reversal that would
have depended on it.

**And a stamp whose clock cannot be identified is not used at all.** During a deploy both builds run
side by side, so a worker still on the previous release goes on stamping registrations from its own
server's clock — and once stored, that value is indistinguishable from one the database produced. The
completion time is therefore now written together with a marker that only the database can produce, by
a single statement, and the reversal fence accepts a registration only while the two still agree. A
registration written by an older build — or one an older build rewrote afterwards — reads as
**undecidable**: its document's reversal is withheld and reported for somebody to reconcile by hand,
rather than decided from a clock nobody can identify. Nothing has to be drained or sequenced around a
release for this to hold: an older instance keeps writing exactly as it did, and its rows simply never
qualify. The cost is deliberate — registrations that predate this change never become decidable on
their own, because filling the marker in for them would be the database vouching for a stamp it did
not make.

**The database is what keeps that marker honest.** Two matching timestamps are not by themselves proof
of who wrote them: the column is stored to the millisecond, so any writer that lands on the same
millisecond matches — and an older build's completion write reads the row, posts to Xero and writes it
back, so it can carry the database's own stamp forward onto a registration that finished later. There
is nothing left in such a row for the poll to notice. The rule therefore lives in the database itself,
as a trigger on the sync log: any statement that changes what a registration says it did — its status,
its completion time, the payment id it created, or a re-claim — **clears the marker** unless that same
statement mints a new one, and a marker supplied when a row is first inserted is refused outright. An
older build cannot avoid this, because it must claim the row before it can re-post, and the claim
alone is enough. The rule can only ever take provenance away, so the worst it can do is withhold a
reversal for a human to check. Restoring a database backup clears the markers on the restored rows for
the same reason, and their reversals are withheld until a fresh registration is stamped.

All four checks are answered by a **single** request that asks Xero only for invoices changed since
the last successful poll, using the `If-Modified-Since` header. The poll advances its cursor only
when it succeeds, and deliberately re-reads the last couple of minutes each time, so a payment can
be seen twice but never skipped — acting on one twice is a no-op.

**Very large windows drain in pieces.** If more than 2,000 invoices changed since the last poll —
usually a bulk operation in Xero, or a cursor left far in the past — the window is too big to read in
one go. Rather than give up, the poll splits it into bounded time slices, processes them oldest-first
and saves its position after each one, up to four slices per run. The activity log records
*"processed N bounded chunk(s) of an oversized delta"* and the remainder is picked up by the next
poll, so a backlog clears itself over the following runs with nothing skipped.

The one case it cannot split is more than 2,000 invoices carrying the **same second** of
`UpdatedDateUTC`, because Xero's date filters only go down to whole seconds. Everything before that
second is processed and saved; the poll then stops with an error naming the timestamp, so no invoice
is ever stepped over unread. That needs a look at what happened in Xero at that moment.

### Payment Reconciliation (backlog sweep)

Payment polling only ever looks at invoices Xero reports as **changed since the last poll**. That
leaves two things it structurally cannot catch: an invoice paid long ago and never touched since, and
an invoice Xero marked paid *before* the IMS had recorded its link. A separate **daily** job closes
both gaps by working from the other direction — it starts from every IMS document that carries a Xero
invoice id and asks Xero each one's current status directly.

By default it is **report-only**: it records what it found in the activity log without changing
anything. Two things surface:

- **Missed payments** — the invoice is PAID in Xero but the order/bill is still unpaid in the IMS.
- **Suspect advances** — the IMS treats a document as paid (or has moved an order on as if it were),
  but Xero says its invoice is not actually paid. These are flagged for a person to review and are
  **never** changed automatically, because a genuine later reversal looks the same and only a human
  can tell them apart.

To have the sweep also **collect** the missed payments (mark them paid, advance and allocate the
order exactly as the poll would), set **`xero_payment_reconcile_apply`** to `true`. Leave it off
until you have reviewed a report or two. You can also run it on demand:

```bash
npx tsx --env-file=.env scripts/reconcile-xero-payments.ts           # report only
npx tsx --env-file=.env scripts/reconcile-xero-payments.ts --apply   # collect missed payments too
```

### Purchase Bill Edits

Unpaid purchase bills can be edited from the purchase order detail page. IMS updates the local
`PurchaseInvoice` and `PurchaseInvoiceLine` rows transactionally, revalidates billed quantities
and cost-line amounts against the underlying PO, and recalculates bill totals on the original PO FX
rate. If the bill has already synced to Xero, saving a content change queues a
`PURCHASE_INVOICE_UPDATE` entry with a payload-derived idempotency key. Saving without changing the
bill is treated as a no-op and does not queue a duplicate update.

Xero can reject bill updates once an external bill is paid, locked, voided, or otherwise no longer
editable. Rejected bill-update sync rows are surfaced on the purchase order detail page with the
connector, timestamp, retry count, and safe error text; the raw sync payload is not displayed.

### Sales Invoice Edits

Editing a sales order that has already been pushed to Xero (i.e. `accountingInvoiceId` is set)
queues a `SALES_INVOICE_UPDATE` entry instead of silently skipping the change. The payload reuses
the same document builder as the create path, so the update reflects exactly what a fresh push
would have sent. An idempotency key derived from the payload prevents duplicate updates if the
order is re-saved without changes.

### Deleting a synced invoice or bill (off by default)

An invoice or supplier bill that IMS itself pushed to Xero can be deleted in IMS and Xero together, with its reference number freed for a replacement. The setting **Allow deleting synced invoices and bills** (**Integrations → Xero → Deleting synced documents**) is **off by default**; while it is off no Delete button is shown and nothing described here happens.

When it is on, the **Delete invoice** button (sales order page) and **Delete bill** button (purchase order page) appear for people who can already edit that document (`sales.process` for an invoice, `purchasing.invoice` for a bill). Confirming queues one `SALES_INVOICE_DELETE` or `PURCHASE_INVOICE_DELETE` entry in the normal Xero queue, so every write goes through the same outbound queue and the same outbound-write hold as every other Xero write. While writes to Xero are held, IMS tells the operator so, queues nothing, and changes nothing in IMS or Xero.

**What Xero is sent, in this order:**

1. The document's number (and Reference, when it has one) is changed to `<number>-DEL-<6 random characters>` (for example `INV-1001-DEL-K7M2QX`), which frees `INV-1001` for a replacement. Xero keeps the number of a voided or deleted document reserved, which is why the number is changed first.
2. The document's status is set to **DELETED** (a draft or submitted document) or **VOIDED** (an authorised document with no payments or credit applied).

The suffix is chosen once, when the delete is queued. IMS reads the document in Xero before each attempt, so a retry after the second write failed sees the number already changed and makes only the status write; it never adds a second suffix. A document already voided or deleted is treated as done.

**What IMS does, when Xero has confirmed:** an invoice's order loses its invoice number, date and Xero link (so the order reads as not invoiced and no longer holds the number), the invoice's accounting events are voided, and its stored PDF copies are withdrawn (they are kept, as statutory records are). A bill and its lines are removed (a snapshot is kept on the deletion record), the purchase order's invoiced marker is cleared when no other bill remains, and the Stock in Transit sub-ledger movement the bill recorded is reversed by an equal and opposite movement. An activity-log entry is written when the delete is requested and when it completes. Until Xero confirms, IMS is unchanged, and an edit sent to the document in the meantime is refused. While the delete is pending, IMS also refuses anything that would record new activity against the document: a receipt, marking the order paid or a refund on the invoice; a payment, an edit, a supplier credit note or a supplier return that would credit the bill. Each of these checks under the same lock the delete request takes, so one made at the same moment as the request either goes first (and the request is then refused because of it) or waits and is refused. The same check, under the same lock, also covers an order edit or exchange that would queue an update of the posted invoice, a bill edit's queued update, posting a drafted supplier credit note against the bill, registering a receipt in Xero (including a receipt matched by the payment-matching pass), a WooCommerce delivery that marks the order paid (the payment is recorded on a later delivery once the delete has finished; activity `wc_paid_while_invoice_delete_pending`), and the allocation of a refund's credit note to the invoice (it waits and is not sent; the activity log notes the first wait only, and after 3 days of waiting the allocation fails on the sync page instead, so a delete left under review does not hold it for ever). A receipt held this way is recorded as `invoice_payment_held_document_delete` (not as a refusal): the scheduled receipt sweep registers it once the delete has finished or been cancelled. An invoice or bill update queued after the request counts as activity recorded against the document, like a payment: the delete then waits for review instead of unwinding.

**When the delete is refused** (the page shows the reason in place of the button; every one of these tells the operator to remove the blocking items in the accounting system first, where that is the remedy):

Payments (a receipt on the invoice, an order held as paid, a payment on the bill); credit notes (a refund or credit note on the invoice, a supplier credit note on the bill); a document dated on or before the imported Xero books lock date; a document IMS did not create (raised by another system during the parallel run, or linked by hand; for an invoice the invoice-number ownership check must also show Xero holds the number under that very document); another posting or a delete still queued for it. At the moment of the delete IMS also reads Xero: a payment, credit note or allocation IMS did not know about, a different document type or a different number changes nothing and reports why.

Refund and credit-note deletion is not part of this. After a delete, a replacement invoice that is identical in content to the deleted one can still be treated as already posted by the posting dedupe; raise the replacement with a changed line or reference.

### Cancelling an order while its invoice is posting

Cancelling a sales order retires any invoice work still queued for it, so the ledger never receives
an ACCREC invoice for a sale that did not happen. There is one moment where that is not enough: the
worker has already decided to post and its request is on its way to Xero. Nothing local can recall
a request that has left, so **the cancellation is refused instead**:

> Cannot cancel this order while its xero SALES_INVOICE is being posted (sync log …). The invoice
> request may already be on the wire, and cancelling now would leave a receivable in the ledger for
> a sale that never happened. Wait for the post to settle — at most 15 minutes — then cancel: if it
> posted, the cancellation will need an explicit credit note.

**This refusal is temporary and needs no action.** The claim it names clears as soon as the post
settles, and in any case within fifteen minutes. Try the cancel again then. A WooCommerce
cancellation arriving over the webhook is retried automatically — it is not dropped.

Once the post has settled, which outcome you get is visible on the sync row:

| Row after the post | What cancelling now means |
| --- | --- |
| Failed or Pending, no external ID | Nothing reached Xero. Cancel normally; the queued row is retired with it. |
| Synced, with an external ID | The invoice IS in Xero. Cancelling the IMS order does **not** reverse it — raise a credit note in Xero. |

The opposite order is handled too: if the cancellation commits first, the worker re-reads the order
immediately before posting, finds it cancelled, and retires its own row instead of posting. The two
paths take the same lock on the order, so exactly one of them wins and neither can act on a stale
view.

### Follow-ups of an invoice for a cancelled order

The invoice's follow-ups are not all treated alike once the order is cancelled:

| Follow-up | For a cancelled order |
| --- | --- |
| Invoice email | Not queued when the invoice posts. A row queued before the cancellation is retired as **Cancelled** with the reason when it comes to run (Activity log: `invoice_followup_refused_cancelled_order`). Nothing is sent to the customer. |
| WooCommerce invoice note | The same: not queued, or retired with the reason. |
| Invoice PDF | Still saved: it is a copy of a document Xero holds and sends nothing anywhere. |
| Payment | Decided by when the money arrived, not by the order status. A receipt dated **after** the cancellation is held (Xero books that as an overpayment, which IMS does not create yet); a receipt that predates the cancellation registers as it always did. |

The check runs under the same order lock cancellation takes, so a cancellation and a send cannot
both win. If the invoice email or note is genuinely wanted, reinstate the order and queue it again.

### Rejected Update Sync Alerts

When Xero rejects a `SALES_INVOICE_UPDATE` or `PURCHASE_INVOICE_UPDATE` (e.g. the external invoice
is locked, paid, voided, or a downstream validation failed), the sync row stays in the failed state
and IMS surfaces an amber alert at the top of the related sales order or purchase order detail
page. The alert lists the connector, when the failure happened, the retry count, and a safely
truncated error message. The full sync payload is never displayed on the UI because it may contain
sensitive document data.

Operators correct the underlying issue (in IMS or in the accounting system) and retry the failed
sync from the Sync Dashboard. Once the row transitions out of `FAILED`, the alert disappears
automatically.

### When a Retry Is Refused

A retry of a **payment** — a customer receipt, a supplier payment, or a credit-note allocation — is
not the same kind of action as a retry of a PDF or an email. `FAILED` does **not** mean the ledger
never saw it: a call that Xero committed and then failed to acknowledge lands here too. Re-sending
it would settle the invoice twice, and only a human can reverse that in Xero.

So before re-queueing a money row IMS **reads the target document in the accounting system** and
looks for the settlement that attempt would have created — the same amount, on the same date. Four
things can happen, and the last three leave the row `FAILED` with a message saying which:

| Outcome | What IMS does |
| --- | --- |
| The ledger holds no such settlement | The row is re-queued normally |
| The ledger already holds it | Refused. The payment is very likely already there — check the invoice in Xero, and if the row is genuinely owed, register it by hand |
| The ledger could not be asked (connector down, document not found) | Refused. An unanswered question about money that may already be posted is not permission to send it again. Retry once the connector responds |
| Several earlier attempts were sent under different idempotency keys | Refused. Any one of them may be the one that committed, and no single key can be re-sent safely. Reconcile the document in Xero |

Two more refusals are about ordering rather than evidence:

- **Another entry for this document is already queued or has posted.** Only one live entry per
  document is allowed. Wait for it to finish, then retry this one if it is still needed.
- **Only one entry can be queued at a time**, so a "Retry All" over several failed rows for the
  *same* document re-queues the oldest usable one and leaves the rest failed. Retry them afterwards
  if they are still needed — they are not lost, and nothing about them is wrong.

Every refusal is written to the activity log as a warning naming the rows involved, and the count
appears beside the retry result as *refused*. **A refusal is not a failure of the retry** — it is
IMS declining to move money twice on your behalf.

**The same check runs at the moment of sending, not only when you click.** A failed payment does not
go straight to a permanent failure — it is re-attempted automatically several times first. Every one
of those attempts, and every automatic re-queue, reads the ledger the same way: IMS records when a
row first sent a payment, and from then on it will not send that row again until the ledger says the
payment is not already there. The refusal appears as the row's error message.

The practical consequence: a payment IMS cannot prove is absent ends up FAILED with an explanation,
rather than being sent again in the background. That is the intended outcome — reversing a duplicate
payment in Xero is manual work, and nobody is told it happened.

Recording a **second receipt** against an order with an unresolved failed attempt is refused on the
same grounds, with a warning on the order: the receipt stays recorded in IMS, and nothing is sent
to Xero until the earlier attempt is resolved. When the reason is a settlement in Xero that IMS
**cannot read**, the warning says so and names the one thing that lifts it — see
[When Xero holds a payment IMS cannot read](#when-xero-holds-a-payment-ims-cannot-read-checked-the-ledger).

### Closing a Payment That Is Already in the Ledger

Those refusals leave one state with no way out on its own: a payment that **did** reach Xero but
whose response was lost. It can never be retried (the ledger holds it), it will never post, and it
goes on blocking the next receipt for that order as an unresolved attempt.

Failed **payment** rows on the Sync Dashboard therefore carry an extra action — *Already paid in the
accounting system? Check and close this entry*. It is not a "mark as done": IMS re-reads the
document in Xero and closes the row **only if it can see the matching settlement itself**. Three
outcomes:

| What the ledger says | What happens |
| --- | --- |
| It holds the payment | The row is closed as synced, and the remote payment's id is recorded against it, so the row afterwards says *which* payment settled it |
| It does **not** hold the payment | Refused — closing it would leave the invoice unpaid in Xero with nothing in IMS still asking anyone to look at it. Retry the row instead, or record the payment in Xero by hand first |
| It could not be read | Refused. Try again when the connector responds |

Only a `FAILED` payment row can be closed this way, and every use is written to the activity log.

### When Xero holds a payment IMS cannot read ("Checked the ledger")

Sometimes Xero reports a payment on an invoice with a figure or a date IMS will not read — for example
an amount with more decimal places than the currency has. IMS cannot tell whether that payment is the
one an earlier, unresolved attempt made, so it refuses every later receipt on the order (*an earlier
payment attempt on this order did not resolve and could not be ruled out*). Nothing that happens later
makes Xero's figure readable, so without a person the hold would never lift.

The warning on the order names exactly what lifts it: the Xero payment id(s), the document, the
earlier entry (with the amount, date and `IMS-…` reference it sent), and the receipt. On the
**Sync Dashboard**, a `FAILED` or `CANCELLED` customer-receipt entry carries a **Checked the ledger**
action. It reads Xero again, lists the unreadable payments, and asks you to choose the receipt and
confirm:

> I opened every settlement listed above in Xero. None of them is the payment that earlier attempt
> made, and none is a payment for the chosen receipt that was already entered by hand.

Only record it if that is true. If one of them **is** the earlier attempt's payment, do not record a
check — settle that entry as posted instead. A recorded check is **your assertion**, not something IMS
verified, and it is logged against your account. IMS then registers the receipt again through the same
checks, and checks the ledger once more immediately before the payment is sent.

The same hold can meet a receipt's **first** post, when no earlier IMS attempt exists: the receipt is refused
before anything is sent (*IMS could not establish what the accounting connector already holds*), and the entry
becomes `FAILED`. That refusal now names the same remedy. Open the listed payment in Xero and, if it is not a
payment for this receipt, record **Checked the ledger** on that entry (choose the receipt it belongs to); the
entry's next automatic attempt reads the check.

What a check does **not** do, by design:

| Situation | What happens |
| --- | --- |
| Xero shows a payment IMS **can** match to the earlier attempt | The receipt stays refused. A check never overrides a payment IMS can see is that attempt's |
| A new unreadable payment appears after the check | The receipt is held again until that payment is checked too |
| Xero is **reconnected** (to any organisation, including the same one) | Every earlier check lapses; record it again under the new connection |
| The list Xero returned changed between opening the dialog and recording | Nothing is recorded; reopen the dialog and look again |
| An unreadable payment carries **no id**, or IMS cannot tell which Xero connection answered | No check can be recorded; the warning says which |
| The unreadable payment belongs to **a repeat of the same receipt** (an earlier entry for the same receipt that already posted) | No check can help, and the warning says so: a payment IMS has already sent for this receipt is never sent twice. A *different* receipt on the same invoice (the balance after a deposit) is not affected by it |

Checks are kept permanently and cannot be edited, deleted or truncated. Each one records the entry, the receipt,
the Xero payment ids, the Xero organisation and connection it was made under, who made it and when.
#### Retrying is not protected by idempotency — check Xero first

IMS derives every `Idempotency-Key` deterministically from the sync entry id (or, for a payment, a bill
payment and a purchase credit-note allocation, from the settlement itself: see below), so a re-post sends
the same key it sent the first time. That only prevents a duplicate while **Xero still remembers the
key**, and Xero keeps one for **6 minutes** from the first call
([Xero: Idempotent requests](https://developer.xero.com/documentation/guides/idempotent-requests/idempotency/)):

> Idempotency keys are intended to help resolve transient issues only and so keys are stored for 6
> minutes from the time of the first call, after which they expire.

A row only becomes `FAILED` after its automatic retries are exhausted, so by the time the manual
Retry control appears the key has already expired. **A manual retry is therefore a new request to
Xero.** If the original attempt actually reached Xero — a timeout or a dropped response looks
identical to a rejection from here — re-queueing creates a SECOND invoice, bill or payment.

**Money posts are keyed on the settlement, not the row.** A payment's `Idempotency-Key` is derived from the
document it settles (the invoice or bill id, plus the credit note for an allocation), the amount, and, for
an invoice payment, the local receipt, never from the sync row. The per-document money-post lock is a
PostgreSQL session lock and is freed the instant its connection dies (a dropped socket, a failover), so a
second row for the same payment can take it while the first request is still in flight; both then carry
the same key and, inside Xero's 6 minutes, Xero answers the second with the first's result instead of
creating a second payment. A deposit and a balance (different receipts) carry different keys and both
post. A row that records no receipt (an imported or older row) or no usable amount keeps its own
token. Reference marks and the ledger fence are unchanged.

"Retry all failed" (the red banner at the top of the Sync page and the button in the Sync Log) opens a confirmation dialog first. It shows how many failed rows will be re-queued, repeats the duplicate-document caution, and enables **Retry** only after you tick that you have checked Xero and none of the documents already exist there. The confirmation names the exact rows you reviewed: the retry code itself (so every route to it, not just the button) refuses the bulk retry unless the call carries that list, and refuses if the set of failed rows has changed in any way since, even with the same count. A blank row id is refused rather than treated as "all". The per-row retry is unchanged.

The retry controls (the failed-sync banner, "Retry All Failed", and the per-row retry in the sync
log) all state this. Before re-queueing an aged row, search Xero for the document. IMS deliberately
does not block the retry: it is the only remedy for a row whose cause has since been fixed, and
refusing everything older than six minutes would refuse every retry there is.

#### The same is true of the AUTOMATIC retries

The six minutes are not a fact about operators, and the automatic retry path does not clear them
either:

| Retry | When it happens | Inside the 6-minute window? |
| --- | --- | --- |
| In-request `429` retry (inside one API call) | up to 3 waits of at most 90s, **plus** up to 60s of minute-rate-limit waiting before each attempt | **Yes, and enforced strictly** — the loop refuses any wait that would put the next attempt **at or past** six minutes, and re-reads the clock immediately before each attempt is actually sent so that an over-running timer is refused too. Past the line the work is handed back to the queue instead. (A `429` was refused before Xero processed it, so there was nothing to deduplicate either way.) |
| First queued retry of a failed row | 5-minute backoff floor + tail jitter, then the next 5-minute `accounting-sync` tick | **Undetermined** — the floor alone (5 min) is inside the window; jitter, the tick, and however long the failed call itself took push it out. You cannot tell which happened |
| Second and later retries | 10, 20, 40 minutes (capped at 60) | **No** |

An earlier version of this table said the in-request retry was inside the window because 3 × 90s is
4m30s. That was the arithmetic of the Retry-After sleeps only and ignored the minute-limit wait taken
before each attempt (worst case 7m30s), and it said the first queued retry was "at or past the line"
when its floor is in fact inside it. Both are corrected above: the first is now a bound the code
enforces, the second is honestly undetermined. **A protection you cannot tell is present is not one
you may rely on** — which is why the local record below, not the key, is what the design depends on.

So an automatic retry gets no more duplicate protection from the key than a manual one. Be exact
about which retry, because the row above already is: the **first** queued retry may land on either
side of the six minutes and you cannot tell which from outside, and the **second and later** retries
are outside it unconditionally. An earlier version of this paragraph said such retries were "never
retried inside the window at all", which contradicted the table two lines above it and overstated the
case in the one direction that matters — it made a retry sound safely outside the window when its
position is exactly what is unknown. **Nothing about "the key is deterministic" makes a queued retry
safe**, whichever side of the line it lands on. What does the work instead:

- **Sales invoices** are safe by Xero's own semantics, not by the key: `POST /Invoices` is
  update-or-create on `InvoiceNumber`, and IMS sends the order number, so a re-post replaces the
  invoice it already created rather than adding a second one.
- **Everything else** — purchase bills, payments, credit-note allocations, manual journals — relies
  on the **local record**: once the external id is written on the sync log, the next attempt
  short-circuits and posts nothing. That write is treated as unlosable precisely because it is the
  protection: when the database connection pool is exhausted it is re-driven rather than abandoned,
  for as long as this worker's 15-minute claim on the row allows (minus a minute held back for the
  give-up path, so it can never still be running when another worker may reclaim the row and post the
  document a second time). **No attempt is ever started on a deadline that has already passed** — not
  the first one and not a later one. If the claim has lapsed by the time the record is reached, the
  ordinary write is not attempted at all; and if the window runs out between attempts — including when
  a machine under enough pressure to exhaust the pool stalls for far longer than the short pause IMS
  asked for — the next attempt is not made either. The deadline is re-read from the clock immediately
  before every attempt rather than inferred from the last one, because every millisecond spent past it
  is taken out of the minute reserved for the give-up path. The give-up path below is used instead,
  because its write *is* claim-checked, whereas the ordinary one updates the row by id.
- **The claim is re-taken at the moment the document is sent — every time, not once.** Posting is not
  the first thing the worker does after claiming a row: it reads the connection's granted permissions,
  looks the customer or supplier up in Xero, resolves item codes — and any of those can sit out a Xero
  rate limit for minutes. Nor is a sync entry a single call: preparing an invoice loops over every
  distinct item, and a credit-note allocation performs two reads before its write. So IMS re-takes its
  own claim on the row immediately before **each** remote mutation, not once per entry. If it is still
  ours, the fifteen minutes restart from there, giving that write and the record that follows it the
  whole window. If another worker has taken it, **nothing is sent** and the row is left to whoever
  holds it, with a warning in the activity log (`xero_sync_claim_lost_before_post`). Not sending is
  the cheapest possible outcome for a lost claim. On the queued path the **outbox job's own lock is
  renewed by the same fence**, because the queue has its own fifteen-minute staleness and would
  otherwise hand the job to a second worker while the first is still legitimately working.
- **One entry gets one lease, and renewals do not extend it.** The fence above stops another worker
  taking the row; on its own it would also let one entry hold the row for ever, renewing every time it
  crawled forward behind a rate limit. So the lease has an absolute deadline, fixed when the entry
  starts — preparation calls included — and unmoved by any renewal. Past it no further remote write is
  **started**: nothing has been sent, so the row is handed back untouched (it does not spend a retry)
  and the next run gets a fresh lease, logged as `xero_sync_lease_expired_before_post`.
- **The record of the post is claim-checked in the database, not just scheduled inside a live claim.**
  The write that marks the row `SYNCED` and stores the external id carries this worker's claim in its
  `WHERE`, so it lands on the row this worker still owns or lands nowhere at all. It used to be keyed
  on the row id alone, which meant that if the claim was taken in the gap between checking it and
  writing — a gap no amount of pre-checking can close — the write would flip a row another worker was
  posting under to `SYNCED`, carrying this worker's id: two documents in Xero, one recorded, and the
  row reading finished. When that fence now matches no row, the transaction is rolled back and the
  event is reported as `xero_sync_claim_lost_during_persist` (activity log, `ERROR`) as well as on the
  `[UNRECORDED-REMOTE-WRITE]` service-log line — **this is the case where a duplicate is most likely
  and IMS cannot prevent it**, so check Xero for the id named in the message.
- **If the re-drive still cannot record it**, the id is written to the service log as a single line
  beginning `[UNRECORDED-REMOTE-WRITE]`, containing the external id, the sync log id and the
  reference — because at that moment that id exists nowhere else. IMS then makes one more attempt
  with a single statement (which waits on the pool rather than being cut short by the transaction
  bound); if it lands, the row goes back to `PENDING` **with the external id recorded** and an error
  message saying so, and the next run completes it without posting anything. **Do not re-queue such a
  row by hand** — it does not need re-posting. If even that write fails, the log line says
  `"recorded": false` and names itself as the only record; grep the service log for the marker and
  reconcile the document in Xero manually.
- **If that record is lost anyway** (the post landed, the process died before recording it), nothing
  prevents a duplicate — IMS does not query Xero before re-posting a payment. It is then *detected*,
  not prevented, by the settlement status on the order/PO (`over-settled`, `awaiting ledger`), the
  payment poll and the daily payment reconcile sweep, and the accounting reconciliation report's
  `duplicate_external_reference` finding. All of those need a person to unwind the duplicate in Xero.

### Reading the accounting reconciliation report

The accounting reconciliation run (`/api/admin/accounting/reconciliation`, with past runs at
`/api/admin/accounting/reconciliation/runs`) lists **findings** — sync rows, events and documents
that disagree — and records on each run whether its lists were **complete**. A run whose
`truncations` is `[]` listed everything it found; a run whose `truncations` names a check listed only
part of that check, and the entry says exactly how many it found in total.

**`old_sync_log_without_mirrored_event`** is a sync row of a mirrored type (a sales or purchase
invoice, a credit note, or a daily-batch, COGS or revenue-reversal journal) for which no accounting event exists. It is
worked out over the whole database, not a sample of it, and listed **oldest first**, up to 500 rows.
Past 500, the `old_sync_log_without_mirrored_event_truncated` finding and the run's `truncations`
entry carry the exact total. **Read the count, not only the list:** because the oldest are listed
first, a row that broke *today* will not appear in the list while 500 older ones remain unresolved —
it shows up only as the total going up by one.

### Tax Rate Sync (Multi-Component Profiles)

When an IMS VAT rate has one or more active components (e.g. Canada `GST 5% + PST 7%`), saving the
rate queues an `AccountingSyncType.TAX_RATE_SYNC` entry. The sync processor calls Xero's
`POST /TaxRates` endpoint with the matching `TaxComponents` payload so the VAT return picks up the
component-level breakdown on the Xero side. The push is idempotent: Xero matches the rate by
`Name`, and unchanged re-saves dedupe at the IMS queue layer via a payload-derived idempotency key.

A per-connector toggle (`xero_sync_tax_rate`, defaulting to `submitted`) gates the queueing.

Until the sync settles (or for connectors that don't support it), every IMS invoice or bill that
uses a multi-component rate also emits a one-shot WARNING activity log
(`sales_invoice_tax_components_not_pushed` or `purchase_invoice_tax_components_not_pushed`) naming
the affected rate, so the operator knows the per-component breakdown depends on the accounting-side
configuration.

### The Xero tax-rate master store

Xero is the tax-rate master: an operator maintains tax rates by hand in Xero and IMS reads them. IMS keeps a stored copy of the
**full** list of Xero tax rates for the connected organisation (every rate, every status), so a report can compare it with the IMS
rates without calling Xero. It is read-only to operators and is filled by one job, the hourly `xero-tax-rate-drift` cron (the same
run that records tax-rate drift).

- **What is stored.** One row per Xero `TaxType` (unique per organisation): name, status (`ACTIVE`, `DELETED`, `ARCHIVED` or
  `PENDING`), report tax type, effective and display rate (exact decimals), the components (name, rate, compound, non-recoverable)
  and the five *can apply to* flags Xero returns. Beside the rows sits one header row per organisation: when the list was read, how
  many rows it held, and a digest of the rows. The header is what lets a reader prove the rows are **one complete read**.
- **How it is refreshed.** Each run does one `GET /TaxRates` (also when IMS has no tax rate to compare: the stored list does not
  depend on the comparison), validates every row strictly, and then, in a single transaction behind the connection fence, replaces
  the organisation's rows and header, writes the drift snapshot and advances the read-sync last-success stamp (`xero_tax_rate_drift_last_checked_at`).
  The stamp therefore means "the list was stored", never "a request was made".
- **What is refused.** An empty list, a response that is not the `TaxRates` list (not OK, no list, more rows than any real list), a
  known field of the wrong type or missing (`TaxType`, `Name`, `Status`, `TaxComponents`, a component's `Name` and `Rate`), a rate that
  cannot be held exactly (more than six decimal places, negative, above 1000), a tax type listed twice, or a key that is only a case or
  punctuation variant of a known one (`taxtype`, `Tax_Type`: it could shadow the real field) refuses the **whole** response: nothing is
  stored, the previous list and the stamp stay exactly as they were, the run errors in the cron log (`XeroTaxRateListRefusedError`,
  with the reason) and the *Xero tax-rate read* feed goes stale after six hours.
- **What is ignored.** A key IMS does not know, at the response, row or component level, is dropped: it is not stored and is not part of
  the digest. Each run that meets one writes a single WARNING (`xero_tax_rate_unknown_fields` in the activity log, and the cron log)
  naming the keys, never their values. If a new Xero field should be kept, `lib/connectors/xero/tax-rate-list.ts` has to learn it.
- **Organisations.** The list belongs to the organisation it was read from. A reader asks for the organisation connected now; after a
  rebind to another organisation there is no list for it until its first run, and the first run removes the previous organisation's
  rows. If the connection changes while a run is in flight, the run is discarded (see the connection fence above).
- **Nothing is written to Xero and nothing else changes.** Mapping Xero's rates into IMS tax codes, pushing rates to WooCommerce and
  the tax-rate write path (*Generate missing Xero tax rates*, the multi-component sync) are not part of this store and behave as before.
- **Importing IMS tax rates from the stored list.** The IMS rates documents use (`tax_rates`) are created from this list by one explicit,
  operator-run action: **Settings > Accounting > Tax > Import purchase tax rates from Xero** (the first load calls the same function, see
  `docs/first-load-apply.md`). It reads the **stored** list, never calls Xero and never writes to it. It requires a list that is proven
  intact (header, row count, digest), has its last-success stamp, was read within 26 hours, and belongs to the organisation connected now;
  otherwise it refuses by name (`XERO_NOT_CONNECTED`, `XERO_LIST_MISSING`, `XERO_LIST_NOT_STAMPED`, `XERO_LIST_STALE`, `XERO_LIST_WRONG_ORGANISATION`,
  `XERO_LIST_UNREADABLE`).
  - **Purchase rows.** For each of `INPUT2`, `ZERORATEDINPUT` and `NONE` that has no active IMS rate usable for purchases, it creates one active
    **Purchases** rate with Xero's name, rate (the effective rate, converted exactly to a four-decimal fraction), components and tax type. A type
    Xero does not list (`TYPE_NOT_IN_XERO`), does not mark `ACTIVE` (`TYPE_NOT_ACTIVE_IN_XERO`) or does not allow on expenses
    (`TYPE_NOT_USABLE_ON_EXPENSES`), a rate that four decimals cannot hold (`RATE_NOT_REPRESENTABLE`), components that disagree with the rate
    (`RATE_INCONSISTENT`), a non-recoverable component, a name already used by an active rate (`NAME_COLLISION`) or several existing rates for
    the type (`AMBIGUOUS_EXISTING_RATES`) gets a named refusal and **no row**. A rate is never invented.
  - **One set of rates (Xero master).** Each IMS tax rate corresponds to exactly one **active** Xero tax type with the **same percentage**: Xero's
    `EffectiveRate` (stored as `effective_rate`), else `DisplayTaxRate` (`display_tax_rate`). The action mirrors the **sales** side under the same
    rules: it creates the missing **Sales** rate for `OUTPUT2`, `ZERORATEDOUTPUT` and every other active Xero type that applies to revenue and not to
    expenses (reduced-rate, EC and OSS types included). A type that applies to **both** revenue and expenses and that no active IMS rate carries gets ONE row usable for both sides (`usedFor` BOTH, rate-set side `BOTH`); one that only a purchase-side rate carries gets a Sales target of its own (refused by name, for example `NAME_COLLISION`, when it cannot be represented), so no active type is left out of the set. A dual-side type named among the requested purchase types is planned the same way: with no active IMS rate it gets ONE row usable for both sides, with a purchase-only rate it keeps a separate Sales target, and with ONE active **Both** rate whose percentage differs (with *replace* ticked) it gets ONE replacement usable for both sides (not a purchase and a sales replacement from the same old row, whose second half would be refused by name after the first had already deactivated the old row). A type Xero does not allow on revenue is refused (`TYPE_NOT_USABLE_ON_REVENUE`). A rate whose
    percentage differs from Xero's is **reported** and is corrected only with *replace* ticked, by creating a **new** rate and deactivating the old one
    (never by editing a referenced rate; the default rate is never replaced). The supplier defaults and storefront rate mappings that pointed at the old rate move to the new one in the same write (the result counts them), and a rate that a live document still depends on (see *deactivate* below) is **not** replaced (reported with `LIVE_DOCUMENTS`). The result carries a machine-readable **rate set**
    (type, name, Xero percentage, side, country, IMS id, status) for a later storefront sync (no WooCommerce write happens here) and lists the
    active rates that have **no Xero tax type** (for example per-country storefront rates): no single set can contain them.
  - **Sales-side rates on purchases (opt-in).** With *narrow* ticked, an active **Both** rate whose Xero tax type is sales-only (can apply to
    revenue, not to expenses) becomes **Sales** only, so it can no longer be picked on a purchase; each change is reported with the number of
    suppliers and purchase lines that reference it. Refused (`NARROW_REQUIRES_PURCHASE_ROWS`) unless every purchase type is satisfied.
  - **Types not in the live list (opt-in).** An active rate whose tax type Xero does not list as active (for example leftover demo-organisation
    rates `TAX001`...) is **reported**; it is deactivated only with *deactivate* ticked, and never when it is the default rate or when a not-cancelled document still resolves its tax identity through it (a sales or purchase order line on it, or a sales order naming it: sales posting and the refund paths look the identity up by the ACTIVE rate with that name), which is reported as `LIVE_DOCUMENTS`. The documents are re-counted under a row lock at the write; one that appeared since the plan stops the whole write. Every writer of the order-level rate name (`SalesOrder.taxRateName`: the sales-order form and CSV import through `createSalesOrder`, the order clone, the WooCommerce order import) takes `FOR SHARE` on the active rate it names, together with the order's line rates, in ONE statement in ascending rate id in the transaction that writes the order (`lockOrderNamedTaxRate`), and the deactivation holds `FOR UPDATE` on the rates it touches, taken the same way up front: an order that locked first is committed and counted, one that arrives later waits and finds the rate inactive. Zero active rows for a name that had one is an error, never ignored: the manual form and the clone refuse the order with a clear message, and the WooCommerce import saves nothing and fails like any import error, to be retried. The lock order for every tax-rate row locker is written in `lib/tax/writable-tax-rate.ts` and pinned by `tests/tax/tax-rate-lock-order-census.test.ts`, so an order spanning two rates cannot deadlock against a multi-rate deactivation. So *deactivate* needs no intake pause. The census `tests/tax/sales-order-tax-rate-name-writers-census.test.ts` fails on a writer of that column it has not classified; the only writers outside the lock are the rate editor's own header refresh (it holds the edited rate's row lock) and two e2e fixture scripts that run against throwaway databases. The default is report-only.
  - **The first load checks existing rates against this list.** A supplier's existing default rate that differs from Xero's stored row is refused by the first load (`SUPPLIER_TAX_RATE_DISAGREES_WITH_XERO`); run this action with *replace differing* to correct it.
  - **Never.** Nothing is deleted; an existing row's rate, type, name and components are never changed (documents reference rows: a different rate is a new row);
    a re-run changes nothing. The `accounting_reverse_charge_purchase_tax_type` setting is checked against the list and reported; no row is created for it.
- **Used by** reconciliation-pack item R13 (the Xero leg and the VAT set identity: WooCommerce, IMS and Xero must use the same set of VAT rates, judged row by row with closed reason codes), which reads the stored list in its own read-only snapshot. See
  *Reconciliation pack* in the installation guide.
- **Custom tax codes differ per organisation: the re-key (a pre-go-live operation: refused unless Xero writes are held).** Xero numbers its custom tax types (`TAX001`...`TAXnnn`) per organisation, in creation order, so
  the codes on IMS's per-country VAT rates (created against a Demo organisation) can mean other rates in the live one (live `TAX005` = *BG VAT*, IMS's `TAX005` =
  *CY VAT*), and IMS posts a line's code. **Settings > Accounting > Tax > Re-key VAT rates** and `npm run tax:rekey` tie each active rate with a custom code
  to the live type of the **same name** (never by code), `ACTIVE`, with exactly the same percentage (EffectiveRate, else DisplayTaxRate) and a consistent
  country, from this stored list (proven as above). The plan is the preview and has a digest; the apply must quote it, runs in one transaction inside the
  connection fence, creates a new rate with the live code, deactivates the old one (never edits it) and moves supplier defaults and WooCommerce mappings. The live type must also be allowed on the rate's sides (`canApply` revenue / expenses) and have the same component breakdown (`SIDE_NOT_ALLOWED`, `MEANING_DIFFERS`).
  Every document line reads the rate's code whenever a Xero document is built from it (`queueSalesInvoiceForOrder` for the invoice and each update, the refund / credit-note paths,
  `createInvoice` / `updateInvoice` / `postSupplierCreditNote` for bills), and the queued payload carries `lines[].taxType` as a snapshot, so not-cancelled orders and purchase orders (posted or not) refuse the apply unless re-pointed on request (a correction: the new code is the same tax meaning), and
  pending refund-line tax snapshots (`SalesOrderRefundLine.accountingTaxType`, preferred over the order line's rate when a credit note is built or retried; migrated on request only when the old code means the old rate alone) refuse it too, and
  queued payloads carrying the old code in any tax field - line, shipping or discount (FAILED sync rows included, until retried or cancelled) always refuse it. A component's own stale custom code is cleared on the new rate and shown in the plan. After an apply, an accounting payload built earlier from a retired code is refused when it is enqueued (reason `retired_tax_code` when the code was read from a rate that no longer carries it, or `retired_tax_code_unbound` when no source rate is named; listed in the exception inbox); repeating the action rebuilds it. After it, the VAT difference report shows no `PERCENTAGE_MISMATCH_IMS_XERO` for the re-keyed rates.
- **One VAT set: the difference report.** Owner ruling 2026-10-25: WooCommerce, IMS and Xero use the same set of VAT rates and Xero is the master.
  WooCommerce tax-rate writes are **operator-manual at P1** (the ownership map row `woocommerce` / `tax-rate`: P1 `operator-manual`, P2 `IMS`; IMS
  has no producer for it yet). To make the manual correction easy, **Settings > Accounting > Tax > VAT rate differences** and `npm run vat:diff`
  compare this stored list, the IMS rates (with the WooCommerce mappings of reconciliation-pack item R13) and WooCommerce's `GET /taxes`, read only,
  and list each difference by reason code (the reconciliation pack's R13 proves the same identity of the three sets as a gate item, from the same stored list), as four reports (UK, IOSS, VOEC, other foreign) plus an unclassified section (see *VAT difference report* in the installation guide). The owner fixes WooCommerce by hand in its tax
  screens and runs the report again until it is empty. The report requires the same proven, fresh stored list as the import above and refuses
  (never "no differences") when it is not.

### Reverse Charge

Lines whose `TaxRate.reverseCharge` is true post to Xero with the connector-side tax
type swapped to a configurable reverse-charge code:

- `accounting_reverse_charge_sales_tax_type` (typical Xero: `ECOUTPUTSERVICES`)
- `accounting_reverse_charge_purchase_tax_type` (typical Xero: `REVERSECHARGES`)

This ensures the VAT return classifies the line under reverse-charge (box 1 / box 8 in the UK)
instead of as a normal output / input VAT entry. The IMS-side tax math is unaffected — the rate
stays as configured (usually `0` for B2B services), and only the connector-side tag changes. When
the reverse-charge settings are empty, IMS falls back to the parent `TaxRate.accountingTaxType` so
the bill or invoice still posts, just without the reverse-charge classification.

The swap applies symmetrically to **credit notes**: refunding a reverse-charged sale posts each
product line's credit under the same reverse-charge code the original invoice used, so the VAT
return's debit and credit lines reconcile. Sales invoices and credit notes resolve product-line
tax types through one shared resolver, so the two can never drift. The swap is decided **per line**
from that line's own tax rate; shipping and discount lines follow the order-level tax rate without
the swap on both the invoice and the credit note (kept identical so the two sides match).

### No tax type, no document ("No VAT" is never a default)

A sales invoice or credit note line is posted on the tax type IMS decided for it. If it has none, **the document is refused** and nothing
is sent to Xero (no contact or item is created either). The row fails on **/sync** with an error that begins *NOTHING WAS SENT* and names each
part that has no type (a product line, shipping, the order discount, a credit-note line). IMS no longer falls back to Xero's `NONE`
("No VAT"), because a missing code that quietly becomes "No VAT" books VAT-bearing sales outside the VAT return.

An **explicit** `NONE` is refused too, unless the line says why it carries no tax. Today there is one such kind: a WooCommerce **fee** the
shop charged no tax on and named no rate for (for example the over-threshold import duty). A tax rate whose own Xero tax type is `NONE`
(WooCommerce rate 182, *Taxes & Duties*, is mapped that way) therefore refuses any ordinary line it lands on; map it to a real,
active tax type. Shipping and the order discount can never be on `NONE`. The check runs at the head of the sales invoice, sales invoice
update and credit note cases of the poster, and again in the connector as the last word. Supplier bills and supplier credit notes follow
the same rule (next section).

### Supplier bills and supplier credit notes: no tax type, no document

A supplier **bill** (create and update) or **supplier credit note** line with no tax type is **refused**: nothing is sent to Xero (no
contact is created either) and the row fails on **/sync** with an error that begins *NOTHING WAS SENT* and names the line. IMS used to send
Xero's `NONE` ("No VAT") for such a line, so input VAT recorded in IMS was silently not claimed in Xero. A line is left without a type when
a vatable cost line (freight, duty) has no **supplier default VAT rate**, when a goods line's own rate has no Xero tax type, or when a
goods line has neither a rate nor a supplier default; a supplier credit note is left without one when the bill it offsets carried VAT but
the supplier has no mapped tax type.

`NONE` is still posted where IMS **decided** it: a cost line the order marks **not vatable**, a goods line whose own (or the supplier's
default) rate is itself `No VAT`, and a supplier credit note against a bill that carried no VAT. An explicit `NONE` on any other line is
refused too. **To fix a refused bill:** give the supplier a default VAT rate (or the purchase order line its own rate) that is mapped to a
real Xero tax type, then edit and save the bill again so it is queued with the corrected type. A refused supplier credit note is fixed the
same way, then raised again from the credit note. Bills already queued before this change with a non-vatable cost line carry no type and will
be refused once: edit and save the bill to rebuild it.

### Bill VAT: each line's own rate

The VAT IMS records on a supplier bill is the sum of each billed line's **own** rate on its own net: a goods line at its rate, a vatable cost
line (freight, duty, handling) at the order's VAT rate, a non-vatable cost line at none. It used to be the order's total VAT divided by the order's goods
subtotal, which counts freight VAT in the rate without counting freight in the base (goods 100 at 20% plus vatable freight 50 made a "30%" rate
and recorded 45 of VAT instead of 30) and is wrong for any order mixing rates that is billed in part. A goods line posts on its own rate's Xero tax type, and its VAT uses that rate's effective rate (for a compound rate, worked out from its components, the same way the sales side does it). A **vatable cost line**
(and a goods line with no rate of its own) posts on the Xero tax type of the rate **the order was charged at**, not on the supplier's *current* default:
IMS finds the active purchase rate whose percentage equals the order's recorded VAT rate (narrowed by the recorded rate name, the supplier's own default
winning a tie). An order overridden to 5% under a 20% supplier default therefore posts its freight on the 5% type and records 5% VAT. If no rate at that
percentage has a mapped Xero tax type, or two different types share it, the line is **left without a type and the bill is refused** (*NOTHING WAS SENT*, naming
the line) rather than guessed: map the rate, then edit and save the bill again. An order with **no** recorded VAT bills no VAT and needs exactly one 0%
purchase type; the supplier's taxable default is never borrowed for it. Before a bill is saved, every line's tax type is also checked against the Xero tax-rate list IMS already holds: a line whose type charges a different rate in Xero than IMS taxed it at (beyond rounding) refuses the bill (*The bill was not saved: ...*) instead of recording VAT Xero will not charge; a type whose rate is not in the stored list is not checked. The supplier's default rate is only used when it is active, usable for purchases, not compound and not reverse charge. With that, the VAT IMS records on the bill (and so its total and base figures) agrees
with what Xero computes from the types sent.

For **WooCommerce orders** the import also refuses, at import time, an order that moved money on a tax rate IMS cannot post under: a
WooCommerce rate id with **no mapping** (IMS used to substitute the default rate with a warning), or one mapped to an **inactive** IMS
rate. "Moved money" means a line (item, shipping or fee) naming the rate has a non-zero net or tax, or the order's `tax_lines` carries
tax under it. The order is imported, but its invoice is marked and **refused at the poster** (and no payment is registered against it) with
the rates named in the message and on the activity log (*wc_invoice_tax_does_not_reconcile*). Map the rate to an active IMS rate with a
real accounting tax type, then re-import the order.

**What to expect while mappings are incomplete.** Until every WooCommerce rate in use is mapped to an active IMS rate that carries a real
Xero tax type, affected invoices and credit notes will sit as failed rows on /sync instead of posting. That is the intended behaviour; keep the
Sales Invoices sync type switched off until the mappings are in place, then enable it.

**Rounding.** Xero works tax out per line and rounds each line's tax to the currency's minor unit, so IMS does the same: each billed line's VAT is rounded to the
bill currency's minor unit (two decimals for GBP, none for JPY, three for KWD) and the bill's VAT is the sum of those rounded amounts, with the total and the base-currency
figures recomputed from them. Three lines of 0.03 at 20% record 0.03 of VAT (0.01 each), as Xero does, not 0.018.

**A new bill bills a goods line at the rate its order line was recorded at.** The tax rate editor refreshes the order lines of **draft** orders only, so on an order that has moved on a line can be
recorded at 20% while its linked rate now says 5%. A new bill therefore compares the linked rate's current value with the rate the line recorded (its stored tax over its stored net). Where they differ
the line is billed at the **recorded** rate, on the Xero tax type of an active purchase rate at that percentage; if there is none (or the line is reverse charge or compound), the bill is
refused (*The VAT rate on the purchase order line for ... has changed since the order was raised*) and the order line's tax rate needs correcting. For a line whose net is under 1 the ratio cannot
state a rate, so the current rate is accepted only if its tax reproduces the recorded tax within a minor unit.

**A bill line keeps the tax treatment it was booked with.** When a bill is created or edited, each line stores the tax type it was sent on, its effective rate, the IMS rate it
was read from and whether it was reverse charge. Changing the purchase order's VAT rate afterwards does **not** re-price the bill: editing the bill (quantities, amounts,
dates, notes) and raising a supplier credit note both reproduce what was booked. A bill booked before this was recorded has no stored treatment: it is worked out from the order's
**current** rates, and that is accepted only where it reproduces the VAT the bill recorded **to within one minor unit in total** (not a unit per line, so a long bill cannot accept a different rate) **and**, for each goods line, the rate its order line recorded when it was priced. If it does not (the order's rate has changed since), a supplier credit is refused
(*This bill was booked before its tax treatment was recorded ... Re-save the bill*), and **re-saving the bill** (Edit bill, then Save) re-prices it at the order's current rates and records
its treatment, after which the credit can be raised. (There is no separate tax-choice control yet: the re-save is the explicit step.)

**A supplier credit is checked against the ledger's rate for its code.** Before a credit that is going to Xero is posted, the booked code's rate in the stored Xero tax-rate list is compared with the rate the bill line was booked at (as a bill is); a difference beyond rounding refuses the credit (*The credit note was not posted (it is still a draft) ...*). A code whose rate is not in the stored list is not checked.

**Supplier credits against reverse-charge bills are not posted from IMS yet.** A supplier credit note that would be sent to Xero against a bill with **any reverse-charge line** is refused before anything is
claimed (*Supplier credits against reverse-charge bills are not posted from IMS yet: raise this credit in Xero directly*); the credit note stays a draft. IMS records a reverse-charge bill gross (net plus the
self-accounted VAT) while Xero holds its net, so a credit from IMS could not agree with the Xero bill. A credit with sync off (nothing goes to Xero) is not affected, nor is a credit against a bill without
reverse-charge lines. A proper reverse-charge credit is separate work.

**A bill with an undecided tax type is not saved.** When bills are being sent to Xero, a new bill or a bill edit in which any line has no tax type (an unmapped rate, or no rate and no matching default) is refused with
*The bill was not saved: no tax type on line N*, and nothing is written or queued. Map the rate (or give the supplier a default VAT rate) and save again: the same save then goes through and books the code. A bill that
froze a blank type before this check existed is treated as **not booked**: editing and saving it (even without changing anything) re-derives its tax from the corrected mapping, records it and carries the
corrected type on the queued first posting. (A first posting that has already been attempted or failed cannot be rewritten in place; see the first-posting rule for bill edits.)

**Inactive rates are refused.** A new bill, an edit of a bill, and a supplier credit note that would be sent to Xero are refused (nothing saved or posted) when a line is priced on a
VAT rate that is **inactive**: the line's own rate, the rate the order was charged at, or the rate a booked line was booked on. Re-activate the rate, or move the order's lines to an active
rate. A rate a tax **re-key** retired (it names its replacement) is not counted as inactive; the retired-code guard decides whether its type may still be sent.

**Supplier credit notes copy the bill they credit.** (A credit whose tax type cannot be decided, for example a bill line booked before the tax treatment was recorded that reproduces the right VAT but has no mapped tax type, is refused **before it is claimed**: it stays a draft, nothing is queued, and once the rate is mapped it can be posted again.) The tax type of a supplier credit note comes from the **selected bill's booked lines** (the type, rate and reverse-charge status each line
was booked with; a bill is credited as reverse charge only when **every** one of its lines is reverse charge, and a reverse-charge line together with any other treatment, such as a non-vatable cost line, is a mixed bill), never from the supplier's current default. One credit amount can only mirror a bill whose lines all carry **one** tax treatment, and then it is credited
on that type (a bill that carried VAT on its one VAT type; a bill with no VAT, such as one made only of non-vatable cost lines, on "No VAT"; a zero-rated bill on its zero-rated type).
A bill that **mixes treatments** (taxable plus exempt, or two VAT types) is **refused**, before anything is posted, with *this bill mixes VAT treatments ... raise the credit in
Xero by line, or credit each line separately*; the credit note stays a draft. Per-line credits are a follow-up. If no type can be found for a bill that carried VAT,
the credit is refused by the poster (*NOTHING WAS SENT*) rather than posted on "No VAT"

### Paid invoices whose payment date Xero does not give

If Xero reports an invoice or bill **PAID** but its payment date is missing or unreadable, the payment poll does **not** mark it paid with a guessed date: it logs a
WARNING (*payment_date_unreadable* / *bill_payment_date_unreadable*) and **remembers the document** in its own table (one row per document and Xero organisation, never evicted, no limit).
Remembering is part of the poll step: if it cannot be saved the poll **holds its position** for that batch (the poll shows an error) so the document comes back, rather
than being forgotten. Every poll then re-reads up to 200 remembered documents by id (the least recently checked first, so one that stays unreadable cannot starve the rest)
and applies each whose date has become readable, even though Xero has not modified it since; a row is forgotten only when Xero's answer shows the retry is unnecessary (the document is applied, or is no longer PAID): a document Xero's answer simply leaves out, or that is still unreadable, stays and is asked again. Only the connected organisation's rows are read or changed.

### EU IOSS / VOEC rate configuration (declaration, preflight and seed)

An IOSS or VOEC sale (an EU member state, Monaco or Norway, VAT collected at the till under the scheme) is posted to Xero on the destination's **zero-rated** Xero type
(for example `DE IOSS VAT`, `TAX131`) with one extra line carrying the collected VAT, not on the rate the customer was charged. IMS therefore keeps **two** Xero types for such a rate:
its own `accountingTaxType` stays the charged rate (DE VAT 19%), and the new rate field **`schemePostingTaxType`** holds the zero-rated type its goods, shipping and discount lines
will post on. The existing reporting category carries the marker: `IOSS` for the EU states and Monaco, `VOEC` for Norway (this moves the rate from the "other foreign VAT" bucket of the
VAT difference report to the IOSS or VOEC one). The invoice treatment (below, *EU IOSS / VOEC / DDP invoice treatment*) reads `schemePostingTaxType` to build the document, behind the Sales Invoices switch; the credit-note treatment (below, *EU IOSS / VOEC / DDP credit-note treatment*) reads the same stamp and the posting type snapshotted on the refund line.

**The declaration** is `lib/tax/eu-vat-seed.json`, versioned and reviewed in the repository, with no secret in it: for each of the 65 live WooCommerce tax rates, the IMS rate that stands
for it (one IMS rate per Xero rate: WooCommerce rates that post on the same Xero type share one IMS rate, so the 33 rates on `ZERORATEDOUTPUT`, 182 included, are one rate named *Zero Rated Income*), the Xero type it posts on and the byte-exact Xero names (`AT IOSS  VAT` has two spaces, `No VAT` and `NO VAT`
are different types). The charged rate's Xero code is left open (`null`) where Xero numbers it per organisation: it is found by name from the stored Xero list, by `npm run tax:rekey`,
never declared. The declaration is **only a declaration**: nothing writes a tax rate to Xero from it, and nothing applies it by itself. The measured table it was made from is pinned in
`tests/fixtures/eu-vat-parity.json`, and `tests/tax/eu-vat-parity.test.ts` fails if either file disagrees with Xeroom's resolution of any of the 65 rows, or if a rate is added to one file and not the other.

```
npm run eu-vat:preflight               # read only: what is missing or mismatched (add --json for the machine-readable form)
npm run eu-vat:seed                    # DRY RUN: the rates it would set, and the plan's digest
npm run eu-vat:seed -- --apply --confirm <digest>    # write exactly the plan the dry run printed
```

- **Order at setup** (before Sales Invoices is enabled): connect the Xero organisation and let the tax-rate list be stored; import the WooCommerce rates and adopt them; run `npm run tax:rekey`;
  run `npm run eu-vat:seed` and, after reading it, apply it; then `npm run eu-vat:preflight` must report no error.
- **The preflight** reads the database and the **stored** copy of Xero's list (the proven one; a missing, stale or other-organisation list refuses with exit 2 and nothing is judged). It
  never calls Xero or WooCommerce and never writes. Per declared WooCommerce rate: mapped (and the mapping's record of the store rate equals the declaration's, or it was made against another store);
  the IMS rate active, for sales, not shared with another WooCommerce rate, at the declared percentage and country; the charged code an ACTIVE Xero type of the declared name and percentage, never
  `NONE`; the scheme posting type and category set; the posting type an ACTIVE Xero type, effective rate exactly 0, named byte-exactly. Then: every EU-27 state, Monaco and Norway has a complete scheme
  rate; accounts 821, 232, 813, 816, 860 exist in the cached chart (821 *Non-UK VAT* and 860 *Rounding* by name too); the three EU account settings and the rounding setting hold the declared codes;
  the refund-hold settings are sane. An **error** blocks readiness (exit 1); an **advisory** (a differing IMS name) is listed and does not (exit 0). Per rate, the mapping must be stamped for the store configured NOW (an unstamped or other-store mapping is refused, as the adoption step does).
  the preflight errors `SHARED_IMS_ROW` (an IMS rate that stands for WooCommerce rates the declaration does not declare to be the same Xero rate) and `XERO_TYPE_ON_TWO_IMS_RATES`
  (two IMS rates on one Xero type) enforce one IMS rate per Xero rate. The set-identity report (R13) accepts the declared sharing (it reads the declaration, and skips the per-rate country and tax-category comparison on it) and still
  reports `DUPLICATE_MAPPING` for any other sharing and for two IMS rates on one type.
- **The seed** sets `schemePostingTaxType` and `reportingCategory` and nothing else. It creates no rate, edits no mapping or account setting, and never calls Xero or WooCommerce. A rate is
  reached only through the WooCommerce mappings that name it, stamped for the configured store and recording the declared store rate, and only if the preflight finds nothing wrong with it but the two fields (country, percentage, name, charged code and the scheme type against the proven stored Xero list); anything else is skipped and listed. A shared rate is one change. It is a
  dry run unless `--apply --confirm <digest>` (the digest the dry run printed) is given; the apply opens by taking the Xero mapping-selection lock and asserting the captured Xero connection unchanged (a rebind waits for it, a changed connection refuses with `XERO_CONNECTION_CHANGED`), rebuilds the plan inside the transaction (a different digest writes nothing), takes the row lock
  every rate editor takes (a rate a re-key replaced is refused), row-locks the mappings the plan rests on and compares every declared mapping field (external id, country, percentage, class, store, rate), and writes each rate as a compare-and-set on the facts it was judged on. Exit codes: 0 nothing to do or applied, 1 a dry run that lists work, 2 refused, 3 internal.
  Run as root or the checkout's owner; the environment is replaced by the `vat:diff` whitelist.
- **An organisation change clears it.** Both Xero codes of a rate (the charged type and the scheme posting type) are the organisation's, so a bind to a different organisation clears `schemePostingTaxType` with the other tax types, and a rate holding only a scheme posting type counts as a mapping.
- **A re-key keeps it.** `npm run tax:rekey` copies `schemePostingTaxType` to the replacement rate with the other posting fields (and it is part of the digest).
- **Drift.** The hourly tax-rate sweep also checks, from the declared mappings, every rate's `schemePostingTaxType` and category against the declaration, and the type **by code** against the stored list: cleared or swapped for another type, IOSS turned into VOEC, no longer in the list, no longer ACTIVE, no longer at exactly 0%,
  named differently from the declaration, carried without an IOSS or VOEC marker, or equal to the rate's own charged code, shows as drift on the rate (the same /sync alert and activity-log entry as a rate that drifted by name).
- **Settings.** Three account roles join the Xero account mappings: *EU IOSS/VOEC VAT collected* (`xero_eu_vat_ioss_account`, 821 *Non-UK VAT*), *EU DDP charges collected* (`xero_eu_vat_ddp_account`, 232) and
  *EU landed-cost fees* (`xero_eu_fee_account`, 232). They are owned by the connected organisation like every account mapping (cleared and re-confirmed on a change of organisation). Rounding posts to 860 *Rounding*
  (`xero_rounding_difference_account`), not 821. Two further settings are read by the credit-note treatment: `eu_vat_refund182_hold_threshold` (default 10) and `eu_vat_refund182_held_count`
  (a persisted counter): refund VAT booked on WooCommerce rate 182 is posted to the order's VAT account, with the first N such credit notes held for a person to check (see the credit-note section).

### EU VAT regime: how an order is classified, and the stamp (decision only)

For an order destined to an EU member state, Monaco or Norway, IMS decides which consumer VAT regime its VAT was collected under, from facts on the order, and records the answer **once** on the sales order.
The stamp is written by `stampEuVatRegime`, which the invoice treatment calls (below) while the Sales Invoices switch is on; with the switch off no order is stamped. Credit notes do not read the stamp yet.

- **Who decides: the setting `eu_vat_regime_mode`.** `adopt_plugin` (the default, and what an unset value means) is the parallel phase while the storefront plugin still posts: IMS **adopts the plugin's decision** instead of re-making
  it. The account the plugin recorded on the order (`_o3d_ioss_vat_account`) determines the regime: the *EU IOSS/VOEC VAT collected* account is IOSS (VOEC for Norway), the *EU DDP charges collected* account is DDP; any other value
  refuses. An order **with scheme VAT and no such meta refuses**; IMS does not guess (an order with no scheme VAT, such as a UK sale, needs none). The plugin's conversion is recorded in the stamp's basis from three order metas it
  will write: `_o3d_ioss_fx_rate` (threshold-currency units per one order-currency unit), `_o3d_ioss_fx_pair` (for example `GBP>EUR`) and `_o3d_ioss_threshold_value`. IMS's own value test still runs as a cross-check and a disagreement
  is the warning `adopted_regime_differs` (never a refusal). With the account present, a conversion record that is **incomplete or unreadable** (the rate, pair and threshold value are written together; the rate must be a positive
  decimal, the pair like `GBP>EUR`), or an `_o3d_ioss_reason` carrying the plugin's "FX meta already present and different from this decision; left unchanged" marker, **refuses** (`plugin_fx_incomplete`, `plugin_fx_conflict`).
  With a complete conversion record the plugin's evidence must also agree with itself and with the order, or the order refuses (`plugin_evidence_contradicts`): the recorded goods value selects the recorded account as the plugin compares
  (at the minor unit, strictly above EUR 150 / NOK 3000 is the DDP account, otherwise the IOSS/VOEC account), and the plugin's rate applied to the goods IMS sees must give the recorded value within 0.02 in the threshold currency (unflagged goods lines may be
  gift cards the plugin left out, so the recorded value may lie anywhere between the known goods alone and all the goods). A conversion field that is present but unreadable is an unreadable figure of the order and refuses first in both modes.
  An order with the account and **no** conversion record at all (from before the plugin wrote it) is a deliberate exception: it is stamped from the account and the basis records `pluginFx` as "not recorded by the plugin", so historic orders still work; a pair other than the order's refuses; the 5% band is not raised in this mode. `decide` is the state after the switchover: IMS decides by value with
  its own order-date rates, as below. A stored value that is neither mode is not coerced; it reads as invalid and the caller refuses.
- **The regimes (decide mode).** **IOSS**: an EU member state or Monaco, goods at or under EUR 150. **VOEC**: Norway, goods at or under NOK 3000. **DDP**: over the threshold, VAT collected by the seller as delivered-duty-paid.
  The thresholds are constants, not settings. Over means **strictly** over, compared at the minor unit: exactly 150.00 is IOSS, 150.01 is DDP, and 150.004 rounds to 150.00.
- **The value tested** is the sum of the goods lines after coupons, excluding VAT, shipping and fees, with gift cards left out. A gift card is a line carrying the order-line flag `_o3d_is_voucher` (yes). The product-level marker
  (`_coupon_title`) is not on the order and IMS imports no product meta (that would need a product column, a product-sync change and a lookup), so a line with no readable flag is **unknown**, not goods and not a gift card. In decide
  mode an order **refuses** (`voucher_status_unknown`) when taking its unknown lines out would change the regime; unknown lines that cannot change it do not matter. Note what this means in practice: until the storefront writes the
  flag (yes or no) on every goods line, a decide-mode order over the threshold refuses. Adopt mode does not use it. The value is converted to EUR (NOK for Norway) at the **order date** with IMS's own rates (the Aelia-fed `fx_rates`), through
  the base currency. In decide mode no rate for the day refuses the order; nothing is defaulted. Because the plugin converts with its live rate at send time, a boundary order can decide differently from the plugin (owner ruling): in
  decide mode any value within 5% of the threshold, either side, carries the warning `threshold_band`, and the stamp records the rate used.
- **The gift-card flag cut-in: `eu_vat_gift_card_flag_cut_in` (default unset).** The storefront plugin (`o3d-xeroom-voucher-no-vat`) writes the yes/no flag `_o3d_is_voucher` on every WooCommerce order line item when the line is created. Once it is deployed, set this
  setting to its go-live as a date (`YYYY-MM-DD`, the start of that day UTC) or an instant with a zone (`2026-12-01T00:00:00Z`). An order created **at or after** it must carry a readable `yes` or `no` on **every** goods line, otherwise the resolver refuses it in either mode
  and for any destination (`gift_card_flag_missing`, naming the lines): IMS does not guess gift cards from coupon titles or product flags. Orders created before the cut-in, and every order while the setting is unset, keep the reading above. A stored value that is not a date
  refuses every order (`gift_card_cut_in_unreadable`) rather than being guessed. Set it only after the plugin change is live on the store, or every new order refuses.
- **What `unknown` means, and how to resolve it.** The plugin writes `yes` or `no` on every line it can see a product for, but writes `unknown` on a custom line and on a line whose product has been deleted, and IMS holds no product-level gift-card marker to settle it. IMS reads `unknown` (and a missing, blank or
  conflicting flag) as **not settled**, and after the cut-in an order with such a line is refused (`gift_card_flag_missing`) and its invoice is held. **Re-importing does not change it**, because the store still says `unknown`. There is no default: the line stays unsettled until an operator answers for it.
  - **Where.** **Sync > Exceptions**, the section "Gift card or not? Order lines the store could not settle". It lists each held order with the lines the refusal named (50 orders a page, with the total in the heading; the count is also part of the Exceptions badge). For each line press **Gift card** or **Not a gift card**. It needs the sync permission and a fresh sign-in.
  - **What is recorded.** The answer, who gave it and when, keyed by the store (its normalised URL, as the tax-rate mappings carry it), the WooCommerce order and the line item, so it survives a re-import but is never applied to another store's order with the same ids. Changing the store connection to a different store, and the operator reset, delete the answers. The answer is checked again under the order lock when the regime is stamped: if it changed after the decision was read, nothing is stamped and the order is imported again with the current answer. Changing an answer overwrites it; every answer, with its author, stays in the activity log (`eu_vat_gift_card_line_answered`).
  - **What it does and does not do.** It settles only a line the store left unsettled. A line the store flagged `yes` or `no` keeps the store's answer. It is refused for an order whose EU VAT regime is already decided (the decision is final), and for a line nothing is waiting on.
  - **After answering, re-import the order from WooCommerce.** The re-import reads the answer, decides the regime, and releases the held invoice (a refused hold is rebuilt only by a re-import, not by the release sweep, which has no WooCommerce order to read). The release checks the answer again under the order lock.
  - **When to answer "gift card".** Only for a line that sells a gift card or voucher. A gift card is left out of the goods value the threshold is tested on, so a wrong answer can move an order between IOSS/VOEC and DDP.
- **How a rate is recognised.** By WooCommerce rate id through the mapping, never by label. A scheme rate is an IMS rate with a `reportingCategory` of IOSS (Norway: VOEC) **and** a `schemePostingTaxType`; one without the other is
  misconfigured and refuses. The destination is the shipping country, else the billing country; only EU-27, Monaco and Norway can be on the scheme.
- **What refuses** (nothing is posted for it and nothing is stamped; it is decided afresh once fixed): a rate that charged money and is unmapped or mapped to an inactive IMS rate; a rate of an EU country, Monaco or Norway that
  charged money and is **not** on the scheme (no goods ship from EU stock, so it is never treated as OSS); UK or Isle of Man VAT charged outside its own territory; a scheme rate on a destination outside the allowlist or of another
  country (or the wrong scheme for Norway); more than one scheme posting type on an order; tax charged to a covered destination with no scheme rate identified; scheme VAT on an order flagged VAT-exempt; an EU VAT Compliance
  record that is present and non-empty but disagrees with the tax lines by more than 0.02 or is in another currency (an absent or empty record never refuses); tax that moved on a rate other than the scheme rates, or a WooCommerce order tax that is not the scheme total by more than 0.02; no usable exchange rate (decide mode); no account configured for the VAT line; in adopt mode, no plugin account on an order with scheme VAT, or one that is neither configured account.
- **Unreadable is named, never zero.** A goods total, a tax line amount or rate id, the order tax, the order currency, the over-threshold duty fee total, or the plugin's account or reason that is present but cannot be read refuses the whole order
  before anything is decided (`order_figure_unreadable`, the reason lists each). A non-empty EU VAT record whose total, currency or shape cannot be read refuses a scheme order (`vat_record_unreadable`); an empty one (no rates) is absent and
  never refuses. An unreadable EAS payload only warns (`eas_unreadable`). In adopt mode the plugin's conversion pair must be the order's own (order currency > EUR, or > NOK for Norway); any other pair refuses as `plugin_fx_conflict`.
- **What is skipped.** An order with no scheme VAT is left alone. An EU-27 business sale flagged `is_vat_exempt` with no tax is recorded as a skip that says so, for the zero-rating that follows; Norway and Monaco are not treated that way. A zero-tax EU-27 order whose `is_vat_exempt` is missing or unreadable is **not** skipped: it refuses (`vat_exempt_status_unknown`) until its B2B status is known.
- **Warnings, never refusals.** `threshold_band` (decide mode), `adopted_regime_differs` (adopt mode), `eas_unreadable`, `eas_disagrees` (the EAS merchandise figure, same currency, differs from the goods value by more than 0.02; EAS never decides, and Norway has none), `plugin_account_differs` (decide mode: the plugin recorded another VAT account on the order than IMS resolves) and `label_regime_disagrees` (accounting resolves by value, the customs label by the presence of the over-threshold duty fee;
  accounting follows value, and a label that disagrees is a separate fix in the label service. Norway is not compared).
- **The stamp** is four columns on the sales order. `euVatRegime` (IOSS, VOEC or DDP; NULL on an order decided to be outside the scheme), `euVatLineAccount` (the account code the one VAT line will post to, 821 or 232 in the live chart;
  the same form as the plugin's `_o3d_ioss_vat_account`, so a credit note on an order the plugin handled before cut-over can use either), `euVatRegimeStampedAt` (set by every successful decision; NULL means never decided) and
  `euVatRegimeBasis` (threshold, goods value, converted value, the exchange rate and its date, the rates and the warnings; no personal data). It is written by a compare-and-set that matches only an unstamped order, under
  the order's row lock, so two builders agree on whichever wrote first, and a stamped order is **never re-derived**: a later exchange rate cannot move it between regimes. The database refuses a regime without an account and a
  marker. The VAT accounts come from the *EU IOSS/VOEC VAT collected* and *EU DDP charges collected* account roles.
- **Orders that predate the stamp** carry none. A credit note on a scheme order with no stamp must come from the plugin's recorded account or go to the exceptions queue (the credit-note change).

### EU IOSS / VOEC / DDP invoice treatment

For a WooCommerce order, IMS builds the sales invoice the way the storefront plugin (o3d-ioss-xero) posts it today. **Everything here happens only while the Sales Invoices switch is on** (the Xero master switch and the *Sales invoices* sync type not off, the same
verdict the queue gives). While it is off the importer does not read a fact, write a stamp or touch the payload: the invoice it builds is exactly what it was before this change. It applies to invoices built from a WooCommerce order; a manual (native) sales order has none of the facts it needs
and is not treated.

- **The same regime input everywhere.** The treatment at import and the check of a held invoice before its release both read the regime facts through one settings-derived builder, the gift-card flag cut-in included. A gift-card line with no flag on an order created after the cut-in is refused by name (`gift_card_flag_missing`) at import, and a held invoice parked before the cut-in passed is refused as *order changed* with the same reason when the cut-in passes before it is released.
- **Order of work.** The importer builds the invoice payload, then, before it is queued or parked for a missing invoice number, decides and stamps the order's regime once under the order lock (`stampEuVatRegime`), then applies the treatment. A refusal of the regime
  (nothing stamped) or a refusal by the treatment itself (for example a rounding difference above the allowance, a marked fee carrying VAT off the scheme, or a zero-rated type the stored Xero list does not prove) is **not queued, whether or not the invoice has its number yet**. The importer parks the original invoice as a **held invoice**: a PENDING row for the order with the treatment recorded as refused (`applied: false`, reason *treatment_refused*) and the refusal's wording, and the activity log has an ERROR entry *wc_invoice_eu_vat_treatment_refused* naming the cause. Nothing is sent to Xero, no payment is registered, and the sweep never releases it. Fix what the reason names, then **re-import the order from WooCommerce**: the re-import checks the held invoice against the order, retries the treatment and releases it only if that succeeds; if it still refuses, the hold stays PENDING and its row shows the reason.
- **Scheme orders (IOSS, VOEC, DDP).** Goods, shipping and the order discount are sent on the scheme's **zero-rated** type (`schemePostingTaxType`, for example `DE IOSS VAT`), never on the charged rate; the accounts are unchanged. A landed-cost fee (marked `_wclc_fee`) is posted **net on the EU landed-cost fees account (232) on No VAT**. **One extra line** carries all the VAT the customer paid
  (items, shipping and fees), on the stamped account (821 *Non-UK VAT* for IOSS and VOEC, 232 for DDP) on No VAT, described as, for example, "IOSS VAT collected — DE 19%". VAT collected is not turnover, so it stays out of the VAT return. No line carries a tax amount: Xero derives tax from the type, and every line is on a zero-rated type or No VAT.
  For DDP the VAT line and the fees both sit on 232; for IOSS and VOEC the VAT line is the only line on 821.
- **The total equals the order total, exactly.** Before the invoice is queued its total (the sum of its lines, to the currency's minor unit) is compared with WooCommerce's order total. A difference of at most a few minor units (one per priced component, at most ten) is rounding and is posted as one line, **"Rounding adjustment", on the rounding account (860 *Rounding*, the setting `xero_rounding_difference_account`) on No VAT**,
  so the invoice then totals the order exactly; nothing goes to 821. A positive shipping or order-discount amount with no shipping or discount account set is refused before the rounding allowance applies (the connector would drop it). Any larger difference, a rounding difference with no rounding account configured, an unreadable figure, a landed-cost fee with no fee account, or a second line already on the VAT account refuses the invoice.
- **Every order (not only scheme orders).** A landed-cost fee marked `_wclc_fee` is re-coded to the fee account on No VAT. A marked fee that carries VAT on an order that is not on the scheme cannot be (the VAT would leave the document), so it refuses.
- **EU business sales (B2B).** An EU-27 order WooCommerce charged no VAT on, flagged `is_vat_exempt`, has goods, shipping and the order discount sent on `ZERORATEDOUTPUT` (as the storefront mu-plugin does). Norway and Monaco are not treated this way.
- **Named No VAT lines.** The Sales Invoices check accepts No VAT only on a line that names why: `fee-no-tax` (a fee), `eu-vat-recovery` (the one VAT line) and `rounding-difference` (the rounding line). Shipping and the discount can never be No VAT.
- **Store credit.** An order carrying store credit is neither stamped nor treated; its invoice stays refused whole until the store-credit lines exist.
- **Gift cards.** A gift-card line is not given its own treatment yet: on a scheme order it is sent with the goods on the zero-rated type (it counts in the invoice total like any line); the sold-credit account for gift cards arrives with the store-credit work.
- **A stamped order is never re-derived.** The regime and VAT account come from the stamp; only the VAT amount and the zero-rated type are read from the order's own rates again. A stamp and facts that now contradict each other refuse: stamped outside the scheme but a scheme rate is now charged, or the reverse, **or stamped IOSS (or VOEC, or DDP) while the facts now decide another regime or another VAT account** (for example the goods value crossed the threshold since); the stamp is written once, so a change needs a person.
- **The zero-rated type is proven, not assumed.** The total check assumes the scheme posting type adds no tax, so a scheme order is only treated when the **stored Xero tax-rate list** (the one the hourly drift job stores for the connected organisation) shows that type known, ACTIVE, applicable to revenue and **exactly 0%**. An unknown, archived, taxable or unstated type, or a list that cannot be relied on (not connected, missing, stale, unreadable), refuses the invoice with the reason. **The regime settings are checked again at the point of no return.** A treated invoice (one carrying the treatment marker) records the regime settings its decision was made under: the regime mode, the gift-card flag cut-in and the IOSS and DDP accounts. A queued row can wait, so immediately before anything is sent the poster compares the recorded settings with the ones in force. If they differ, or none were recorded, **nothing is sent**. For a new WooCommerce invoice the queued row is retired (status *Cancelled*, note *Superseded: the EU VAT regime settings changed since this invoice was prepared...*) and in the same step the invoice goes back to being a **held invoice**: the PENDING hold the importer uses, still carrying the settings it was decided under, whose note says it was moved back and to re-import the order. The invoice number stays on the order. The sweep will not release it. **Re-import the order from WooCommerce**: the re-import rebuilds the invoice from the order under the settings now in force, compares it with the held one, and releases it with the current settings recorded, or leaves the hold PENDING (marked *order changed* where the order itself differs) with the reason, for example that a gift-card line now needs its flag. **Which settings are recorded.** The recorded policy is the regime mode, the gift-card flag cut-in, the IOSS, DDP, fee and rounding accounts and the base currency, all from the one read the decision used. A hold or invoice recorded before the fee, rounding and base-currency fields existed lacks them and is treated as a mismatch (it is rebuilt, never released as it stands). **An account setting is different from the others:** the regime stamp is write-once and the treated lines carry their accounts, so a re-import cannot adopt a changed account. For a queued invoice the row is therefore *not* superseded: it is refused (failed, retryable) with *the EU VAT account setting(s) changed since it was prepared ... re-importing the order will not fix it*. **Restore the previous account setting in Settings > Accounting and retry the row on /sync, or post the invoice by hand in Xero and record it on the row with the settle action on /sync.** A held invoice (not yet queued) whose account setting changed is left PENDING with the same explanation: restore the previous account setting, then re-import the order. **The queued row is superseded only on durable proof that no create was ever dispatched for it**: the claim in hand is the row's first ever (attempt revision 1, with the row's custody intact), it has no document id and no dispatch marker, and **no other sales-invoice row exists for the order in any status unless that row was never claimed at all** (revision 0 with custody intact, no document id). The money stamps are not used, because an invoice never writes them: a claimed row, even a failed one with every field empty, may have reached Xero and lost its response, so it blocks. **Accepted limit:** the proof cannot recognise a row that a binary older than this feature claimed and sent without leaving any trace (it did not bump the attempt revision, and the response was lost). That needs a row sent by such a binary, which a fresh installation, a held Xero outbound and stop-then-start deploys rule out; it is not guarded further. Its mirrored event is voided as a retired *attempt* (a later attempt may take the document up), not as a cancelled sale. Any ambiguous history (a retry, a recorded dispatch, an earlier attempt, a sibling document) is **never superseded**: the row stays refused with *an earlier attempt on this row may already have created the invoice in Xero*, nothing is parked and the mirror is untouched. **Check Xero for that invoice first** and record it on the row from /sync if it exists there; do not re-import the order until the row is settled, because a rebuilt invoice would be created under a new idempotency key and could be created twice. **The checks are repeated at the last point before the request leaves.** The pre-socket authorization the HTTP client runs as its final statement does, for a new invoice, first the invoice-number fence (a transaction that can take time) and only then a final check, and for an update just the final check. The final check is one function: it re-proves the scheme posting type against the stored Xero tax-rate list (still known, active and exactly 0%), and then compares the recorded regime settings with the ones in force as its very last step, returning straight after. A stored list or a setting that changed while the number fence or the payload preparation ran is therefore seen. It only *refuses* (it never supersedes, since a dispatch record has been minted by then), with *check Xero for the invoice first* wording. **Accepted residual: a setting changed after that point, while the request is on the wire, cannot be checked by anything**; the invoice goes out under the settings it was prepared under. For an invoice *update* of a document already in Xero, or an order with no WooCommerce link, the row is refused instead (*the EU VAT regime settings changed since it was prepared; re-import the order*) and shows as refused on /sync. Untreated invoices are not affected, and an ordinary taxed order the treatment left exactly as it was carries no marker and is not checked. The poster asks the same question again immediately before it sends an invoice carrying the treatment marker for a scheme order (the type can change in Xero while a payload waits): a failure is a refusal with "NOTHING WAS SENT" and the reason.
- **Draft or live is not decided here.** The status Xero receives follows the *Sales invoices* posting mode (`xero_sync_sales_invoice`): `draft` creates DRAFT invoices, `submitted` creates authorised ones. In the parallel phase, while Xeroom posts the live invoices, set it to `draft`; the treatment does not read or change it. Writes to Xero also still need the producer-side hold lifted for the tenant.
- **Held invoices.** With the switch on, every invoice parked for a missing invoice number says whether the treatment ran on it (`applied`, plus the order total for an ordinary taxed invoice); with the switch **off** the original payload is parked exactly as built, with no marker (an absent marker is an untreated hold). An invoice the treatment **refused** (numbered or not; a refused invoice is never queued, because the poster would always refuse it and a re-import only repairs held invoices) is parked as an untreated hold carrying the refusal's reason (`applied:false`), never as treated: the sweep never releases it, and once the cause is fixed a re-import verifies it against the order, retries the treatment and releases only if that succeeds (otherwise it stays PENDING with the reason). A hold parked while the switch is off, or before this treatment existed (no marker at all), is not released untreated: once the switch is on, the release leaves it PENDING with a note; **re-import the order**: with the switch on, the re-import applies the treatment to the parked payload (from the order's own facts, replacing it under the order lock) and releases it; if the treatment refuses, the hold stays PENDING and says why (fix that and re-import again). **A held invoice is checked against the order before it is released** (switch on): on a re-import the parked payload is compared with the order as it is now (every line's description, quantity, unit amount and discount, the fee markings, shipping, the order discount the parked currency equal to the order's currency now, the landed-cost fee marker (checked apart from the no-tax status, and recorded on the parked fee line), and, for a treated hold, that the document still totals the order), and a treated hold's regime, VAT account, zero-rated type and VAT amount are re-resolved from the current facts and compared with what was parked and with the order's stamp. Any difference keeps the hold PENDING, marks it *order changed* and says the order changed after it was held and **needs its invoice rebuilt**; nothing releases or re-treats a hold marked that way (there is no automatic rebuild of a held invoice, so it needs a person). The **tax outputs** are compared first, on every route: the invoice builder and the check before release call the same function (`resolveWcInvoiceTaxTypes`), and the marker records, per line (goods and fee lines), for the shipping and for the order-level discount, the resolved IMS rate, where it came from (the WooCommerce rate, the product-category resolver, the order default, or the fee no-tax rule) and the effective posted tax type; a line that names no WooCommerce rate is resolved and compared like any other, so a changed category selection or order default is caught. The order discount's type is the order default rate's type, so a hold with a positive discount is also refused when only the default rate's mapping changed and no line moved (the four taxable components, goods lines, fee lines, shipping and the discount, are all compared). The **tax inputs** are kept and compared too, to say why: before any line is re-typed the treatment marker records the WooCommerce tax rate of every line and of the shipping; for each rate, the mapped IMS rate and its accounting type, reverse-charge flag, active flag, percentage, compound flag, scheme fields, replacement and components, and what the rate stands for now after a re-key; the reverse-charge sales tax type setting; and each line's final effective tax type as the invoice builder computes it. The release (and its own re-check under the order lock) re-resolves all of them and compares: equal-value lines exchanging tax classes, a flipped reverse-charge flag, a changed setting, a rate made inactive, a re-mapped or unmapped rate all keep the hold PENDING. An untreated hold's parked tax types are compared with what the order's lines resolve to now. An untreated hold's **total** is checked too, before the treatment can mark it applied: the parked payload's document total is computed from its own lines, tax codes, shipping and discount (the invoice-to-order reconciliation, with its rounding allowance) and compared with the order's total now, and the payment the payload would register is compared with the same total; a payload that no longer produces the order's total is marked *order changed* and is never stamped with a total it does not produce. **A held invoice the importer stamped as not totalling its order** (`_taxUnreconciled`: a tax mismatch or an unmapped or inactive rate that moved money) is never treated at import and never released with the stamp: it stays PENDING with the reason until a re-import finds that the importer's own reconciliation now passes on the current order. Then the stamp is removed, the payment details are rebuilt, the checks above and the treatment run, and the invoice is released; if it still does not reconcile the hold keeps its reason. **The authority before any release is a fresh build.** The importer's own pieces are run again on the order as it is now, writing nothing (the document's lines, shipping, discount, fees and tax types; the tax reconciliation with what WooCommerce charged; and the EU VAT treatment, using the order's existing regime stamp only if it still agrees with the fresh decision), and the parked invoice is compared with the result on every accounting field: each line's description, quantity, unit amount, tax type, account, discount and kind, the shipping and discount amounts, accounts and types, the VAT and rounding lines, the currency, the invoice date, the exchange-rate stamp and the payment fields (method, payment date, settlement rate, receipt id and the amount), each derived from the current order and the receipt row the import wrote (never from today's rates). Only true identity (the contact, the reference and the invoice number) is left out, because an erasure scrubs the contact and the number arrives with the release. If any step refuses, the hold stays PENDING with that reason; otherwise any difference marks it *order changed* and names the first differing field. This runs for treated holds in the locked release check as well as at re-import, and for untreated holds before the treatment; the per-fact checks above remain as diagnostics for the common causes. A held invoice whose order now carries **store credit** (added after the invoice was parked) is an order change: it is marked *order changed*, stays PENDING and neither the invoice nor its payment is queued; the locked release check refuses it too. Releasing a payload that still carries the stamp is refused on every path (the sweep included), so a hold is never marked synced over an invoice the poster would refuse. A parked payload that cannot be compared (an unreadable or missing figure) is treated as different. The release **repeats the whole check inside its own order-locked transaction, immediately before it enqueues**, re-reading the hold and the order's facts there, so a change between the first check and the release also keeps the hold PENDING and is never released. **Every** release path, the sweep's included, also re-reads the hold inside that locked transaction and releases what it re-read: the same row, still PENDING, not marked *order changed*, and (switch on) still marked as treated; a hold a concurrent re-import marked in between is never queued. The held-release sweep has no WooCommerce order in hand, so it does not compare the order: it refuses holds not marked as treated, and it **fails closed on the regime settings**: a treated hold records the settings it was decided under (the regime mode, the gift-card flag cut-in and the IOSS and DDP accounts), taken from the one read the decision was made on (never a second read, so a setting changed while the treatment runs cannot be recorded as the policy of a decision made under the old value), and the sweep releases it only if those are unchanged. After a change (for example the cut-in is moved to cover an order whose line carries no flag) the hold stays PENDING with the reason and nothing is queued; **re-import the order**, which re-verifies the held invoice against the order under the current settings and releases it only if it still holds. A hold parked before the settings were recorded is treated the same way. With the switch off nothing changes.

### EU IOSS / VOEC / DDP credit-note treatment

**Built and switched off.** A credit note for a refund is treated only while the Sales Invoices switch is on (the same switch and the same verdict as the invoice treatment above). While it is off nothing here is read, snapshotted or rewritten: the credit note IMS queues is exactly what it was, and
IMS writes nothing new on the refund. It applies to every route that raises a credit note: a WooCommerce refund, a refund an operator records, the whole-order reversal the payment poller raises when a payment is reversed (the cancellation case), and an accounting retry of any of them.

- **The stamp decides, never the facts.** The credit note takes the regime and the VAT account from the order's write-once stamp (821 for IOSS and VOEC, 232 for DDP). It does not decide again, so a later exchange rate, or a changed *EU IOSS/VOEC VAT collected* account setting, cannot move a credit note to another account than the invoice used.
- **What a scheme credit note carries.** Each goods and shipping line goes on the scheme's zero-rated type at net, on the type the **invoice was posted on**: the stamp records it when the order is stamped, and the refund line snapshots it from there when the refund is created (beside the tax rate's own code, which is never sent for such a line). A rate whose scheme type is later moved to another zero-rated type therefore does not change what a credit note reverses. A stamp written before the type was kept has none; its credit note is a refused row posted by hand (below). A refunded landed-cost fee goes net on the fee account (232) on No VAT, and **only the fees the refund touches are on the credit note**. **One VAT line** carries the refund's own tax on the stamped account on No VAT. The credit note **totals the refund exactly**, to the minor unit; there is no rounding line. It never carries a store-credit line (a credit note on a store-credit order is still refused whole).
- **Where the figures come from.** A WooCommerce refund states its amount in all: the VAT is that amount less the net of the lines, and it must agree with the tax the lines' own rates give to within rounding, or the credit note is refused. A refund hand-recorded from a parked WooCommerce refund (Sync > Exceptions) passes the WooCommerce amount the same way, so the credit note totals it exactly. **Every scheme refund freezes its pricing when it is created**: each line's VAT rate and the refund's gross (the source's own amount, or for an IMS-recorded refund the recorded line amounts with their tax rounded once, so a 0.025 net line refunded as 0.03 is a 0.03 credit note, never 0.04). The credit note, and any accounting retry of it, is built from those frozen figures only, never from a tax rate that has changed since. A scheme refund created before this was kept (or a line whose rate could not be priced then) is a refused, settle-by-hand row like the no-stamp case. A whole-order reversal reverses the order's whole collected VAT on its lines; it does not reverse a rounding adjustment line the invoice may carry (a known gap, tracked separately), so it is not claimed to total the whole invoice to the cent.
- **What refuses, and what to do** (nothing is sent to Xero in any of these):
  - *The order was sold under the scheme but has no recorded VAT regime* (an order imported before the Sales Invoices switch was on; a re-import does not stamp it). IMS queues a **refused credit-note row** for it: the poster refuses it on every attempt, so nothing is ever sent, and it shows on /sync as failed with the wording. The refund is then no longer an accounting exception. Check Xero for the credit note first; if it is not there, post it by hand in Xero on the account the order's invoice used (821 for IOSS and VOEC, 232 for DDP) and the zero-rated type of the order's scheme rate, then record the outcome on that row with the settle action on /sync.
  - *Unstamped orders are recognised by immutable evidence first:* an invoice IMS itself queued or posted for the order that carries the EU VAT treatment marker makes it a scheme order whatever the rates map to now. An order with no stamp and no such invoice (its invoice came from the storefront plugin before cut-over) can only be recognised by its rates' **current** scheme mapping. **Accepted limit:** removing a rate's scheme mapping while refunds of such pre-cut-over scheme orders are still possible makes their credit notes be treated as ordinary ones, so do not remove scheme mappings from rates used on those orders.
  - *The invoice honours the stamp's posting type too.* If a rate's Xero mapping moves to another zero-rated type after the order was stamped, a re-import refuses to post the invoice on the new type (it is held with the reason): restore the rate's scheme posting type or post the invoice by hand, so a credit note always reverses the type the invoice used.
  - *A WooCommerce refund whose tax is booked on rate 182* (the rate the EAS compliance plugin uses when it re-prices a refund, which also leaves fee lines out) on a scheme order **is recorded** (while the Sales Invoices switch is on). Its VAT is the tax the refund states summed across **all** its rate ids, 182 included, and it is posted as the credit note's one VAT line on the order's **stamped** VAT account (821 for IOSS and VOEC, 232 for DDP), on No VAT, with the credit note totalling the refund exactly. IMS uses the refund's own figures, not the order's rates, because the plugin booked its own. Two checks must pass or the credit note is refused (nothing is queued and the refund stays marked for retry): the VAT must agree with the tax the refund states, to within rounding, and the VAT credited across all the order's refunds, this one included, must not exceed the order's collected VAT by more than one small rounding allowance of the order's own (not granted again per refund), and nothing positive is accepted once it is all refunded. A rate-182 refund whose tax figure cannot be read at all is still parked under Sync > Exceptions as quarantined, to be recorded by hand.
  - *The first rate-182 credit notes are held for you to check* (the owner's ruling). While the number held so far (setting `eu_vat_refund182_held_count`) is below the threshold (`eu_vat_refund182_hold_threshold`, 10 when not set), IMS queues the credit note as a **refused row that is never sent**, shown on /sync as failed with the wording, and adds one to the count in the same step (so refunds arriving at the same moment cannot take more than the threshold). Check Xero for the credit note first; if it is not there, post it by hand in Xero for the amount shown, with the VAT on the stamped account, review it against the WooCommerce refund, then record the outcome on the row with the settle action on /sync. The refused row, the count and the held mark are committed together: if the row cannot be queued nothing is counted and the retry holds it again. **A held credit note stays held**: once held, it is held again on every later retry, even if the Sales Invoices switch is turned off, and it never posts by itself. A retry never counts the same refund twice. Once the count reaches the threshold, later rate-182 credit notes post as any other scheme credit note. A threshold or count that is not a whole number holds the credit note and counts nothing; a threshold of 0 holds nothing. Only a credit note that would otherwise post is counted: a refusal is not.
  - *A refund line with no scheme posting type snapshot* (a refund recorded before the order's regime was, or an order whose stamp predates the invoice's type being recorded) is a refused, settle-by-hand row like the no-stamp case above (check Xero, post by hand on the invoice's tax type and the stamped VAT account, settle the row on /sync). *Other causes:*, *an unreadable or unproven scheme type* (the stored Xero list must show it known, ACTIVE and exactly 0%), *a landed-cost fee with no fee account*, *a total that is not the refund's amount*, or *a stated refund amount the lines' own tax does not explain*: the credit note is not queued and the activity log entry names the cause. Fix the cause (the Xero tax type, an account setting) and retry the refund's accounting.
- **The regime settings are checked again before the credit note is sent.** The credit note records the settings it was decided under (the same record as an invoice: mode, gift-card cut-in, IOSS, DDP, fee and rounding accounts, base currency). The poster compares it with the settings in force before it claims the row again and once more as the last step before the request leaves, together with the proof that the zero-rated type is still ACTIVE and 0%. A difference refuses the credit note: it is never rebuilt or moved back in place, because an earlier attempt on that row may already have created it in Xero. The refusal says to check Xero for the credit note first; then either restore the previous EU VAT settings (Settings > Accounting) and retry the row on /sync, or post the credit note by hand in Xero and record it on the row with the settle action on /sync.
- **No default tax type.** A credit note line with no tax type is refused, and No VAT is accepted only on a line that names why (`fee-no-tax`, `eu-vat-recovery`), as for invoices.

### EU IOSS / VOEC / DDP go-live: shadow comparison and cut-over runbook

**Built, switched off.** Nothing in this section is live. The Sales Invoices switch is off, no order is stamped and no EU invoice is treated by IMS. This is the runbook for the day the owner decides to turn it on, and the shadow report that
precedes it. Every step that touches the live Xero organisation, the live store or a production setting is the owner's call; none is run by IMS or by an assistant on its own.

**1. Preflight (read only; all of it must be clean first).**

- `npm run eu-vat:preflight` exits 0 (no error finding). If it lists work, `npm run eu-vat:seed` (dry run, read it, apply it with its digest) and `npm run tax:rekey`, then run the preflight again. See *EU IOSS / VOEC rate configuration* above.
- `npm run vat:diff` (or *Compare VAT rates* in Settings) lists no difference for the IOSS, VOEC, UK and other-foreign schemes. **This compares rate configuration only**: it never reads a posted document, so "no differences" says nothing about how an order is invoiced. Use the shadow report below for that.
- The parity test (`tests/tax/eu-vat-parity.test.ts`) passes on the release being deployed, and the hourly tax-rate sweep shows no drift on /sync (including the scheme-posting-type drift checks above).
- The settings read by the treatment are what the declaration says: the three EU account roles and the rounding account (see *Settings* above), `eu_vat_regime_mode` (`adopt_plugin` while the plugin still decides), and the *Sales invoices* posting mode `xero_sync_sales_invoice` set to `draft` for the first live orders.
- The producer-side write hold for the Xero tenant is still in place (it is lifted last, step 3).

**2. Shadow report (IMS shadow first; the plugin and Xeroom keep posting).** `npm run eu-vat:shadow -- --live-read ...` builds, for each chosen EU order, the invoice IMS **would** post and compares it with the invoice Xero holds. Run it only when the owner has said to: it reads the live Xero organisation and the live store.

```
npm run eu-vat:shadow -- --live-read --orders 1001,1002,1003        # IMS order ids or storefront order numbers
npm run eu-vat:shadow -- --live-read --from 2026-11-01 --to 2026-11-07 --max 50 [--json]
```

- **Read only, by construction.** It performs GET requests only (Xero: the invoice by its number, then by id; WooCommerce: the order by id) and reads the IMS database. It uses the stored Xero token **only if it has not expired**: it never refreshes a token (a refresh is a POST and a database write), logs or notifies. If the token has expired the orders show *not comparable* with "Xero access token expired; open IMS Sync once to refresh, then rerun"; do that and rerun. WooCommerce credentials are read without the settings store's re-encrypt-on-read. A WooCommerce tax rate that is not mapped to an IMS rate makes the order *IMS refused* (`unmapped_tax_rate`) instead of building it on the default rate, and logs nothing. It builds the payload with the importer's own builder and the real treatment, with the Sales Invoices switch assumed on **for that build only, in memory**: the setting is neither read nor changed. An order with no stamp is decided in memory and **not stamped**; an order that already has a stamp is built through it. It never enqueues, parks, writes, posts, stamps, logs or settles anything. `--live-read` is required; without it the command refuses and does nothing.
- **What it prints.** For each order: the order number and a status; per line the account code, TaxType, line amount and tax amount on both sides; the VAT line; the invoice total. Never a customer name, email, address, line description, response body or credential. `--max` is a hard cap (default 25, ceiling 200); a larger selection is cut and reported as truncated. Orders whose destination is not an EU member state, Monaco or Norway are skipped and counted.
- **Statuses.** *match*; *differs* (it names the lines and fields); *review* (a boundary order, below); *no Xero doc* (nothing, or only a voided document, under the order's invoice number); *IMS refused* (a closed code only, such as `tax_mismatch`, `unmapped_tax_rate`, `gift_card_flag_missing`, `scheme_posting_type` or `other`: the importer's own sentence can quote a line or fee name, so it is never printed; the real import's activity log has it; store-credit orders always show here until their lines exist); *not comparable* (no invoice number yet, more than one document under the number, a read failed or the Xero token expired: a closed code is shown; or **the comparison was incomplete**: a tax rate, a Xero TaxAmount or a total was unavailable, with the reason). **Match means fully compared**: an unavailable figure is never read as equal. For a foreign-currency invoice the exchange rate is compared too (IMS's rate rounded to Xero's 6 decimal places, within 1e-6): a missing rate on either side is *not comparable* (`currency_rate_unavailable`), a different rate is *differs* (or *review* for a boundary order). A base-currency invoice is unchanged.
- **Boundary orders (owner ruling).** An order within 5% of the threshold, or whose adopted regime differs from IMS's own value test, can legitimately decide differently from the plugin, because IMS converts at the order-date rate and the plugin at its live rate. If such an order differs it is **review**, not *differs*; it is looked at by a person, never auto-corrected. One that matches is *match*.
- **Tax figures.** IMS sends no tax amount; the expected tax of a line is its net times the rate of its type in the stored Xero list, within one minor unit per taxed line. A type the stored list does not prove makes the order *not comparable* (it is never a match). On scheme, B2B and fee lines every type is zero-rated or No VAT, so those compare exactly.
- **Exit code.** 0 only when every order matched; 1 for anything else (a *review* order is accepted by a person, not by the code); 4 when **no EU order was compared** (every selected order was non-EU, or none was found: "No EU orders were compared; this is not an acceptance pass"); 3 when it did not start.
- **Acceptance bar (the owner's call on the sample).** Every order in the sample is *match*, or a *review* / *differs* / *IMS refused* order that a person has looked at and accepted with the reason written down. A sample worth trusting covers an IOSS order, a VOEC (Norway) order, a DDP order, a B2B zero-rated order, an order with a landed-cost fee, a taxed order outside the scheme (route none) and a boundary order in a foreign currency. A *no Xero doc* or *not comparable* row is not an acceptance: find out why.

**3. Order of switching over (design: IMS shadow first, the plugin stays until IMS is live).**

1. **Shadow** (step 2) while the plugin and Xeroom post as they do today and IMS posts nothing. IMS's own invoice for an order Xeroom already invoiced is refused by the ownership check (*The ownership check before every sales-invoice create*), which is the intended fence, not a fault.
2. **Gift-card cut-in** (step 4) once the plugin's flag is live on the store.
3. **Cut-over window.** Stop Xeroom's invoice pushes **before** IMS is allowed to post (two writers on one invoice number is what the ownership check exists to stop; see its *Cutover note*). **Leave the storefront plugin active**: while `eu_vat_regime_mode` is `adopt_plugin`, IMS adopts the plugin's recorded decision (`_o3d_ioss_vat_account` and its FX record) from each order, and credit notes on pre-cut-over orders use the same meta. Then turn the *Sales invoices* switch on with the posting mode `draft`, and **lift the producer-side write hold last**, so no invoice is posted untreated in between. Do not leave a gap in which orders are imported with the switch off and the hold lifted.
4. **Verify the first live orders** in Xero as DRAFTs (account, TaxType, VAT line, total against the WooCommerce order), then move the posting mode to `submitted`.
5. **Disabling the plugin** comes last and is a separate decision: only after IMS is live and checked, and only once the regime is to be decided by IMS (`eu_vat_regime_mode` = `decide`, which needs the gift-card flag settled and an order-date rate for every day). If the plugin and Xeroom are disabled together, rounding moves to 860 as it already has; otherwise do that first so 821 holds only IOSS/VOEC.

**4. The gift-card flag cut-in (`eu_vat_gift_card_flag_cut_in`; the owner sets it).** IMS must be at least **4.2.0** (the release that lets an operator settle a gift-card line the store left unknown) on the installation before it is set. Set it only after the plugin that writes `_o3d_is_voucher` on every order line is live on the store, as a date (`YYYY-MM-DD`) or an instant with a zone (`2026-12-01T00:00:00Z`); an order created at or after it must carry a readable yes/no on every goods line, or it is refused (`gift_card_flag_missing`). Setting it before the plugin change is live refuses every new order. See *The gift-card flag cut-in* above, and answer unsettled lines under Sync > Exceptions.

**5. The first rate-182 credit notes (hold release).** The first 10 credit notes on a scheme order whose refund VAT is booked on WooCommerce rate 182 are held, never sent, until a person has checked them (the owner's ruling). For each: check Xero for the credit note; if it is not there, post it by hand for the amount shown with the VAT on the stamped account; compare it with the WooCommerce refund; record the outcome with the settle action on /sync. The count is the setting `eu_vat_refund182_held_count`, the number held before later ones post is `eu_vat_refund182_hold_threshold` (10 when not set). **The release is the count reaching the threshold**: once 10 have been held, later rate-182 credit notes post as any other scheme credit note. Do not raise the count by hand. If the first ones are not trustworthy, raise the threshold to keep holding; 0 holds nothing. A credit note that was held stays held on every retry, even if the switch is turned off.

**6. Rollback.**

1. Re-impose the producer-side write hold for the Xero tenant **first**, so nothing posts while the rest is undone.
2. Turn the *Sales invoices* switch off. The importer stops stamping and treating at once; the hold on a credit note already held stays. Invoices IMS already posted stay in Xero: do not delete them without the owner.
3. Re-enable Xeroom for orders created from the rollback onward, and confirm before it runs that it will not re-send an order IMS already invoiced: Xeroom posts under the same invoice number and an update on a number **replaces** the document that holds it.
4. Put the settings back (`eu_vat_regime_mode`, the posting mode, the gift-card cut-in if it was set too early). Stamps on orders are write-once and harmless; leave them.
5. Run `npm run eu-vat:shadow` on a few orders posted by each side to see what is where, and review the /sync failures and held invoices the window produced before lifting the hold again.

## Invoice PDF & Email

When a sales invoice is synced to Xero and payment is registered:

1. The Xero invoice PDF is downloaded and saved locally
2. The PDF is emailed to the customer with a branded email template
3. A signed download link is pushed to the WooCommerce order as a customer-visible note
4. An admin-only note with a "View in Xero" link is added to the WC order

For an invoice **Xeroom** (not IMS) posted, IMS finds it in Xero read-only by its number, fetches the PDF and keeps it as the customer's one invoice; see the **Customer invoice in My Account** runbook (`docs/ops/invoice-documents-switchover-runbook.md`). Orders from before this existed are fetched on the customer's first click (queued, then fetched in the background within the shared 5,000-a-day Xero allowance, with a per-day cap), never in bulk. Credit notes are separate documents. IMS only reads from Xero for all of this; it writes nothing to Xero.

Invoice PDFs are accessible via a signed URL: `/api/invoices/[orderId]?token=<hmac>`. The token is generated using HMAC-SHA256 and verified with timing-safe comparison.

## Xero Deep Links

When an order or purchase invoice has been synced to Xero, a **View in Xero** link appears on the detail page:

- **Sales orders**: Links to `https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=...`
- **Purchase orders**: Links to `https://go.xero.com/AccountsPayable/View.aspx?InvoiceID=...`

## Payment Method Mapping

The IMS maps payment methods to Xero bank accounts using a composite key of `{method}:{currency}`. This allows different bank accounts for different payment processors and currencies:

- `stripe:BASE` → Stripe clearing account in the IMS/Xero base currency
- `stripe:EUR` → Stripe EUR clearing account
- `paypal:BASE` → PayPal account in the IMS/Xero base currency
- `bank-transfer:BASE` → Primary bank account in the IMS/Xero base currency

Configure this mapping in **Integrations → Xero → Payment Account Mapping**.

The mapping is **shared by every accounting connector**, but its values are one connector's own bank-account IDs. A payment is only queued when the mapped account exists in the active connector's synced chart of accounts — see *Payments and updates refused because IMS cannot tell which connector holds the document* below.

## Settlement: is the payment actually in the ledger?

Marking something paid in the IMS and the ledger agreeing are two different facts. Registering the payment is a separate sync (`INVOICE_PAYMENT` for a customer receipt, `BILL_PAYMENT` for a supplier payment) that can fail, be cancelled, or never be queued — so a green **Paid** badge on its own only means the IMS was told the money arrived.

Sales orders and supplier bills therefore show a **settlement verdict** derived from that payment sync row:

| Shown as | Meaning |
|---|---|
| *Paid* (green) | The ledger confirmed the payment in full. |
| *awaiting ledger* (amber) | The payment is queued or retrying. Normal, briefly. |
| **LEDGER REJECTED** (red) | The payment sync failed. The ledger still shows the amount outstanding. |
| **NOT SENT TO LEDGER** (red) | No payment was ever queued, or it was cancelled. The ledger will not learn about it on its own. |
| **PART PAID IN LEDGER** (red) | The ledger recorded less than the document total, so a balance remains there. |

Hover the badge for the detail; the red states also print it under the invoice. Nothing is expected to post while accounting sync is off, or before the invoice/bill itself has reached the ledger — a payment cannot attach to a document Xero has never seen, so in that case the **document** sync is what to chase.

### Receipts recorded by hand

A payment recorded on a sales order (**Add Payment**) is registered against the Xero invoice automatically, provided:

- accounting sync is on and the invoice has already posted to Xero;
- the payment method and currency resolve to a bank account in the mapping above;
- the receipt still **fits** in what is left of the invoice Xero holds, after everything already registered against it.

If any of those does not hold, the receipt is still recorded in the IMS, nothing is sent, and a warning naming the order appears in the activity log — the order then shows **NOT SENT TO LEDGER** until it is registered.

**Part payments.** Each receipt gets its own Xero payment, so a deposit followed by a balance settles the invoice in two steps without anyone touching Xero. What tells two payments apart is the **receipt**: IMS identifies a payment by the receipt (payment row) it was recorded for, not by the invoice, the amount or the date. A payment already sent for a *different* receipt on the same order never stops this one — not when it has posted, not when it failed, not when two receipts are the same size on the same day — while a **repeat of the same receipt** is always refused, because that is the only way the same money can reach Xero twice. IMS recognises a deposit's payment in Xero by the reference it wrote on it, never by amount and date alone: a payment somebody typed into Xero by hand with the same amount and date as this receipt still stops it, and a reference found on two Xero payments stops it too. The IMS keeps a running total instead of a one-at-a-time rule: the receipt that would take the total past the invoice is the one refused, and the warning names both figures. A failed payment for another receipt counts towards that total (it may have reached Xero) until the ledger shows it did not. If a registration already on the invoice does not record its amount, the IMS cannot work out the room left and refuses rather than guess. A failed deposit can be retried after the balance has posted, as long as Xero does not already hold it.

**Several payments for one order, and the cap.** Two receipts recorded for the same real payment (a double entry) are two receipts, so both are sent; the only stop is the total — IMS refuses a receipt that would take the order's receipts past its total, and Xero itself refuses a payment above what is still outstanding on the invoice (net of any credit notes). IMS does not create an *overpayment* in Xero: money that cannot be placed against the invoice stays recorded in IMS and is dealt with in Xero by hand. A repeat send of one receipt reuses the same idempotency key, so Xero returns the original payment instead of making a second.

**Receipts for cancelled orders.** A receipt can be recorded on a cancelled order. What happens next depends on **when it was paid compared with when the order was cancelled** (the cancellation time is stamped by the database at the moment the status changes). Paid *before or at* the cancellation, or when the cancellation time is not known, follows the ordinary credit-note path and registers as usual. Paid *after* the cancellation, the invoice is void or credited and Xero would refuse a payment against it (it books such money as an overpayment, which IMS does not create yet): the receipt stays recorded, **nothing is sent**, and the warning says so. Record it in Xero by hand as an overpayment on the customer.

**Imported orders.** A paid WooCommerce order is imported with its receipt: a payment row is created with the order, and the payment registered in Xero after the invoice posts carries that receipt's identity. A deposit or balance recorded by hand on the same order is therefore a *different* receipt and registers normally (within the invoice total). Only a registration that carries no receipt at all — one made before this was the case — cannot be told apart from a repeat of any receipt, and so still blocks a hand-recorded payment on that order.

**The fit check is applied again at the moment of posting**, not only when the receipt is recorded. Every payment bound for Xero — hand-recorded, re-registered after the invoice posts, or raised automatically by an imported order — is measured against the invoice one last time immediately before the call goes out, counting only payments that have actually posted. A payment that no longer fits is **not sent**: its sync entry is retired as cancelled and an error appears in the activity log naming the invoice, what is already registered against it, and the amount refused. Reconcile the invoice in Xero and register the balance there by hand if it is genuinely owed. If the order or its totals cannot be read at that moment, nothing is sent either and the entry retries — an unreadable order is never treated as permission to move money.

**A receipt recorded before the invoice posts** is no longer lost. A payment cannot attach to a document Xero has never seen, so it is refused at the time with a warning — but the IMS now re-registers it by itself as soon as the invoice reaches Xero, re-running the same checks. Only receipts with no registration attempt of their own are picked up this way; one that already failed is left to the retry path, since a failed attempt may still have reached Xero.

**A re-issued invoice** (deleted in Xero and posted again) starts with a clean slate: payments registered against the old invoice no longer count against the new one, and the payment for the replacement is queued rather than skipped as already-done.

Deleting a payment removes its queued registration if it has not posted yet; if it already reached Xero, a warning asks you to reverse it there. A receipt whose registration an operator settled as **"did not post"** is refused too: that settlement is a person's word about a ledger the IMS did not check, so the registration is treated as an attempt nobody can speak for — look at the invoice in Xero and, if a payment is on it, reverse it and enter its reference (the IMS then checks that exact payment before deleting anything).

### Supplier bills: marking one paid again

The payment poller clears **Paid** on a bill whose payment Xero has demonstrably released, so a bill can legitimately be marked paid a second time. The poller is the only thing that retires the earlier registration, and it does so in the same write that clears **Paid** — because it has just read the bill back from Xero, which is the one moment "the ledger no longer holds this payment" is an *observation* rather than a guess. With the registration retired, **Mark as paid** queues a fresh one normally.

**"Not fully paid" is not "the payment is gone", and only a voided invoice proves the difference.** Xero marks a bill *authorised* whenever it is approved and not fully settled, which is equally what a genuine **part payment** looks like, and what a bill looks like in the minutes between **Mark as paid** and the sync worker actually posting the payment. Clearing **Paid** on either of those re-arms the button over money that has already left, or is about to — and pressing it again pays the supplier twice, with nothing downstream to refuse it. So the poller only retires a registration and clears **Paid** when Xero has **voided** the invoice, which Xero does not allow while any payment is attached to it. Every other regression is reported and left alone:

| What Xero says | What the poller does | What to do |
|---|---|---|
| The invoice is **voided** | Clears **Paid** and retires the payment registration, so the bill can be marked paid again | Nothing, unless the void was a mistake |
| The invoice is **authorised** (approved, not fully paid) | Leaves **Paid** set, retires nothing, and logs a warning against the PO | Open the bill in Xero. If a part payment is sitting against it, settle the balance there or correct the bill total in the IMS. If the payment really was removed, cancel the bill's payment sync entry by hand and mark the bill paid again |

**Mark as paid refuses whenever the IMS cannot prove what the ledger holds.** Each refusal leaves the bill unpaid, queues nothing, changes nothing, and writes a warning naming the sync entry involved:

| What the IMS sees | Why it refuses | What to do |
|---|---|---|
| The registration is **being sent now** (claimed by the sync worker) | The request may already be on its way and nothing here can recall it | Wait for that entry to finish — it will end up synced or failed; a dead claim is released after 15 minutes — then check the bill in Xero |
| The registration is **synced** and no poll has retired it | It posted, and no Xero read has since disproved it | Open the bill in Xero. If the payment is there, the bill is settled. If it is genuinely gone, cancel that sync entry and mark the bill paid again |
| The registration **failed** | A failed money call is *not* proof that nothing reached Xero — the payment may have been created and the response lost | Open the bill in Xero. If the failed payment is there, the bill is settled. If it is not, pay the bill in Xero directly |
| The registration was **settled as "did not post"** by an operator | An operator's "not posted" is a person's word about a ledger the IMS did not check — a lost response or a payment made by hand leaves the same row — so it does **not** clear the refusal | Open the bill in Xero. If the payment is there, the bill is settled. If it is not, pay the bill in Xero directly |
| The registration was **settled as "did post"** by an operator (a payment id typed in) | The IMS did not verify that payment, and paying again could pay the supplier twice | Open the bill in Xero and confirm the payment. If it is not there, the record was wrong — pay the bill in Xero directly |
| The registration **changed status** while the bill was being marked paid | A worker picked it up mid-operation, so its outcome is open | Check that entry, then try again |

A failed registration whose stored request was missing a field Xero rejects before sending (no invoice id, no bank account, no amount) blocks nothing — that one *is* provable. So does a registration the IMS itself retired before it was ever sent (superseded by **Mark as paid**, or cancelled by the sweep while still queued) and one whose payment the poller verified as reversed in Xero.

**When the poller cannot decide, it leaves the bill marked Paid.** The same is true one step further in, on a voided invoice: if a payment registration finished *after* the Xero read the reversal was computed from, that read cannot say whether the payment it created is gone. Clearing **Paid** then would re-arm the button over money that may have moved, so the poll withholds the whole verdict, logs a warning naming the undecidable entries, and counts it on the poll result. The IMS resolves this by itself on the next Xero read that covers those registrations. If it never does, the daily reconcile keeps reporting the bill as a *suspect advance* — settle it in Xero, or cancel the named sync entry by hand.

**Marking a bill paid needs somewhere to send the payment.** If the bill has already been posted to Xero but bill-payment posting is switched off, **Mark as paid** is refused rather than recorded locally: marking it paid with nothing queued would leave Xero showing the full amount outstanding and nothing to correct it. A bill that was never posted to Xero is unaffected — there is no second system to keep in step.

## FIFO Cost Layers

Group B of the daily batch consumes FIFO (First In, First Out) cost layers when booking COGS. Each shipment line decrements `remainingQty` on the oldest cost layers first. This ensures COGS reflects the actual purchase cost of the specific units shipped.

## Back-Reference Repair

After a document posts, its external id has to be written back onto the source document
(`accountingInvoiceId` on a sales order or bill, `accountingCreditNoteId` on a customer refund or a
supplier credit note). If that write fails, or the process dies between
marking the sync row SYNCED and running it, the document is orphaned: it exists in Xero but IMS
cannot link, update or pay it. All four document types are repaired. The back-reference repair sweep runs inside
`/api/cron/accounting-sync` (and on demand from **Integrations → Xero**), re-applies the id from
the sync row, and re-enqueues the follow-ups (PDF, payment, attachment) that never ran.

**A row is only finished when its follow-ups have actually run.** Writing the id back and enqueueing
the follow-ups are two separate steps, and the second can fail on its own — a busy queue, a momentary
database error. When it does, the row is *not* marked as reconciled: it is left open, flagged as still
owing its follow-ups, and the next sweep retries them. That holds whether the row was `FAILED` or
`SYNCED`; the sweep will not close a row on the strength of the id being present, because a document
can be correctly linked and still be missing its PDF or its payment. Nothing is retried forever in
silence, either — each failed attempt writes `xero_backreference_followup_deferred` to the activity
log.

**The sync itself records what it still owes, not just the sweep.** A linked, `SYNCED` row says
nothing on its own about whether its PDF, payment or attachment ever ran — so the sync writes that
down at the moment it is true, in the very same database write that marks the row synced with its
external id. It is cleared only once the follow-ups have actually been queued. That is what makes a
process restart in the middle of a sync recoverable: whatever was interrupted, the row still says the
follow-ups are outstanding and the next sweep runs them. Rows that were synced *before* this was
introduced cannot be assessed retrospectively — a completed row and an interrupted one look identical
afterwards — so nothing was back-filled; the protection applies from that point on.

**Every follow-up obligation is now swept, not only the ones attached to a document.** The record of
"this row still owes its follow-ups" is written for every sync type, but the sweep used to look only
at rows that carry an external id *and* are one of the four document types. That left the invoice
PDF stranded: its own follow-ups are nested — a successful PDF is what queues the customer invoice
email and the WooCommerce order note — and the PDF step returns no external id, so it matched
neither condition. A restart between saving the PDF and queueing those two lost them silently. The
sweep now treats an outstanding obligation as a reason to look at a row in its own right, so that
pair is rebuilt, and the row keeps its own status: discharging an obligation never turns a failed
email into a successful one.

**A repair never invents an invoice date.** When the sweep links a sales order after the fact, it
stamps the order's invoice date with the date the invoice was actually *posted with*, read back out
of the request that was sent — not the moment the repair runs. Repairs happen an arbitrary time
later, sometimes months, and VAT and currency reporting select on that date, so using the repair time
would quietly move the sale into whichever period the sweep happened to run in. If the row can no
longer tell us the posted date — a payload compacted away by retention, or a legacy row — **no date
is written at all** and a WARNING goes to the activity log
(`xero_backreference_invoice_date_unrecoverable`) naming the order. Set the invoice date from the
document in Xero: until you do, that sale is in no reporting period. An invoice date the order
already has is never overwritten.

**A Xero row still marked as owing follow-ups needs nothing from you.** Xero has a
back-reference repair sweep bound (`repairXeroBackReferences`, run by the accounting-sync cron and by
a manual sync), so a Xero row whose deferred receipt is still unregistered is retained *work* rather
than stranded work: the sweep re-reads the marker and re-enqueues the follow-ups idempotently, and
the `xero_followup_obligation_retained` activity now says exactly that. It used to tell the operator
to drive the sync for that reference again or settle the receipt themselves — which on this connector
is the *worse* advice, because the automatic retry really does exist and a settlement made in the
Xero UI races work already queued, producing a second payment no request id can deduplicate. If a row
is still marked after the next accounting-sync run, read the invoice in Xero, record what is present,
and escalate that reading.

**A row from a connector this build no longer ships is different.** No sweep is bound for it, so
nothing will come back for it. Such rows are listed under **Sync → Exceptions**, in the section
**"Accounting follow-ups owed, with nothing to re-drive them"**. The remedy is READ AND ESCALATE: open
the document in the accounting system that holds it, record what is actually there (payment, PDF,
email, attachment) and hand that reading to accounting. Do not settle one of these rows by hand. The
follow-ups were separate local queue rows, so a payment may already be sitting `PENDING` locally,
and a payment created in the ledger UI cannot be deduplicated against it.

**When the id itself is the blocker.** One case cannot be resolved by linking the document by hand:
the write was refused because *another local record already holds that id*.
A manual link is refused for exactly the same reason, so the stale claim has to come off first.
On Xero it surfaces in one of two places:

- **When the post's own back-reference is refused,** the processor writes the refusal text into the
  sync row's error message and lets the row retry, so it ends up `FAILED` — still carrying the
  external id, which is stored before the local write is attempted.
- **When the repair sweep hits it,** it logs `xero_backreference_id_conflict` as a WARNING naming
  the id, the row and the release command, and defers the row for a recheck interval rather than
  retrying it on every run. The warning repeats until the claim is resolved.

See *Releasing a stale external id* below.

**It refuses to guess.** Sync rows created before the bill-keyed change name the *purchase order*,
not the bill. When such a row cannot be attributed to exactly one bill, the sweep writes a WARNING
to the activity log (`xero_backreference_repair_ambiguous`) asking you to link it manually, and
tries again once every 24 hours until it can. The warning repeats — deliberately — so a row nobody
ever links does not go quiet. Reasons you may see:

| Reason | What it means |
|---|---|
| `MULTIPLE_SYNC_ROWS` | Two or more posted bill sync rows reference this PO |
| `MULTIPLE_UNLINKED_BILLS` | The PO has several bills with no external id |
| `NO_LIVE_SYNC_ROW` | No live sync row for this PO carries this external id any more — it was cancelled, or its external id was cleared, mid-repair — so nothing evidences the attribution |
| `EXTERNAL_ID_LINKED_ELSEWHERE` | Another bill — on another PO — already carries this Xero bill id |
| `EXTERNAL_ID_CLAIMED_CONCURRENTLY` | Another bill claimed the id while this repair was being written |

For `EXTERNAL_ID_LINKED_ELSEWHERE` the warning also says **how the blocking bill got its link**,
which is usually the fastest way to decide which of the two candidates to check in Xero first:

| Blocking link | What the warning tells you |
|---|---|
| Written by a sync that named that bill | Authoritative — the refused row's own reference is the likelier mistake |
| Deduced by an earlier repair | A deduction from the purchase order, not something Xero reported — a candidate for being wrong |
| Set by an operator | Someone compared both documents and chose; treat it as correct unless you know why that changed |
| Never recorded | The bill was linked before IMS recorded this, so neither claim is proven — check the Xero bill against both |

IMS still refuses either way. Deciding automatically would need IMS to read the Xero bill and compare
it against both local candidates, which it does not do; the provenance narrows the search, it does not
make the decision.

**One ledger document, one local record — enforced by the database.** Two purchase invoices can
never carry the same bill id, two sales orders can never carry the same invoice id, and two credit
notes (customer or supplier) can never carry the same credit-note id: each of those columns has a
unique index. That matters because a stored external id is what every later action is aimed at —
invoice and bill updates post to `/Invoices/{id}`, and payment polling marks **every** local record
carrying a matching id as paid. A duplicate would mean one correction rewriting the wrong document,
or one customer payment silently settling two orders.

So a write that would duplicate an id is **refused**, with an error naming the document, the id and
the record that already holds it. Nothing is overwritten. IMS will not clear or move an existing link
on its own, because nothing in IMS records whether that link was posted authoritatively or deduced —
releasing it is an explicit, confirmed operator action (see *Releasing a stale external id* below).
The repair sweep reports a refusal it hits as `xero_backreference_id_conflict` and re-reports it once
a day until it is resolved, rather than retrying silently.

One cause is the ledger merging two of our documents because they were posted under the same
document number. That used to have a live case in supplier credit notes: two credits raised against one
purchase order with the number left blank on both posted under the purchase order's own reference,
and Xero treated the second as an edit of the first.

That is fixed at the source. **A supplier credit note now posts under a document number IMS mints
from the credit note's own record (`SCN-…`)**, whatever you type in the number field, so two credits
can never claim one number. What you type is still sent — it travels as the credit note's *Reference*
in Xero, which is also where the purchase order reference goes when you leave the field blank.

A number that is unique to the record is also what makes the *other* supplier credit-note hazard
closable. If the response to a post is lost in transit — the request landed, the reply did not — IMS
has no ledger id for the credit note and the sync row retries. Xero's idempotency key only covers six
minutes, so a queued retry is a fresh request, and nothing about the posting verb reliably stops it
becoming a **second credit note**, which understates payables by the duplicate.

So IMS asks the ledger first. Before creating a supplier credit note it looks for one already filed
under that `SCN-…` number, and because the number is minted from the credit note's own record, a
document found under it can only be this credit note:

- **Found** — IMS links that document and sends nothing. This is the lost-response case healing
  itself
- **Not there, and IMS has never sent a create for this credit note** — it is created
- **Not there, but a create was already sent** — IMS **refuses** and says so. An empty answer is not
  proof the earlier attempt failed. Check Xero for the number: if the credit note is there, link it
  to the IMS record; if it genuinely is not, post it in Xero and link it
- **The ledger could not answer** (Xero unreachable, or a partial result it cannot vouch for) — IMS
  refuses and retries later

The last two are deliberate: refusing costs an operator a look at Xero, where a duplicate credit note
is a mis-stated payables balance nobody goes looking for.

**The number has to be one IMS actually minted, not one that looks like it.** All of the above rests
on `SCN-<the credit note's own record id>` being unique by construction; a number you typed yourself
is not, even if you happen to type it starting `SCN-`. A supplier's own reference of the shape
`SCN-2026-114`, or a purchase order reference every credit against that order shares, would let IMS
either link the wrong ledger document or refuse this one for ever on the strength of somebody else's.
So before it asks Xero anything, IMS checks that the queued number is exactly the one this credit
note's record mints. If it is not — a credit note queued before this change, or one whose sync row no
longer names its credit note — **nothing is sent at all**, not even the supplier lookup, and the
failure names both the number found and the number expected. Re-record the credit note so it is
queued under its own minted number.

### Releasing a stale external id

A refused write leaves the ledger document with no local record of it, and "resolve it by hand" is
not something you can actually do while the id is claimed — the unique index refuses a manual link
for the same reason it refused the automatic one. The claim has to be released first, and IMS will
not do that on its own: nothing in the database distinguishes a stale id from a
live, correct link, so the decision is yours.

1. Read the activity entry (`xero_backreference_id_conflict`). It names the **blocking record** and the
   command, with the ids already filled in.
2. Open that record in IMS and confirm it is stale — for example it points at a ledger document that no longer exists. **If it is a live, correctly linked
   document, stop.** Releasing it detaches a good link, which is worse than the refusal.
3. Dry-run (reads only, writes nothing):
   `tsx scripts/release-accounting-external-id-claim.ts --sync-log <id> --holder <id>`
   It reports the blocking record, the document the id belongs to, and whether that document is
   still unlinked — if it has acquired its own id since the warning was written, `--apply` will
   refuse and say so.
4. Re-run with `--apply`. The id is cleared from the blocking record, written onto the document that
   actually posted it, and recorded in the activity log as
   `accounting_external_id_claim_released` — all in **one transaction**. The audit entry is part of
   the transaction rather than something written afterwards, so a completed release can never end up
   with no record of who detached what: if the record cannot be written, the release does not happen
   either and you are told the command failed.

The release and the re-link are one atomic operation on purpose: clearing the id and stopping would
leave the ledger document attached to nothing at all. Because they are one transaction, **any** failure — a refusal, an error, a lost
connection part-way through — leaves everything exactly as it was, and the recovery is simply to run
the command again.

Everything it acts on is re-checked at the moment it writes, not when you read the warning, and
anything unexpected is a refusal rather than a write:

- the sync row must still be the one you named — still carrying the record of the refusal, still
  carrying the same external id, and still in a state a repair applies to. A row that has re-posted
  under a new id is no longer about the id you are releasing, and a row with a sync **in flight**
  (`PENDING`/`PROCESSING`) may be about to post again under a different id;
- the blocking record must still be the one you confirmed, and must still hold exactly that id;
- the document being linked must still **have no external id of its own**. If it has been linked
  correctly in the meantime, the older id from your warning is refused, never written over the top.

**Which sync rows this applies to.** Xero lets the refusal fail the row, so it retries and ends up
`FAILED` — still carrying the external id, because that is stored before the local write is ever
attempted. A `FAILED` row is the normal shape of a Xero conflict, not a broken one. Running the command a second time after it has
succeeded is safe: it reports that the id is already on the document and does nothing.

**Rows past their retention window.** Data retention clears the stored payload of an unresolved sync
row once it is older than the sync-log retention period, keeping only the identifying record. Such a
row is still repaired — the external id can still be written onto the order or bill — but its
outstanding follow-ups (PDF, payment, attachment) can no longer be rebuilt. When that happens the
sweep logs `xero_backreference_followups_discarded` naming the document. That line is a notice, not a
work order: the interrupted pass enqueues each follow-up as its own sync row, so one for the part it
names may already be sitting in the queue, and a payment or attachment created by hand afterwards
cannot be deduplicated against it. Open the document in Xero, record what is actually present, and
escalate that reading to accounting. Do not settle one of these rows by hand.

## Connecting a different company

**IMS is built for one accounting company at a time.** Connecting a different one is possible, but
the external ids already stored against your orders, bills and credit notes stay behind, and they
belong to the company that issued them.

That is harmless in practice with Xero: organisation ids and document ids are GUIDs, so an id
from a previous organisation can never be mistaken for one of the new organisation's documents — it
simply resolves to nothing, and the failure is a loud "not found" rather than a wrong document.

### Disconnecting and reconnecting

Disconnecting clears the token, the company pin, and the cached contact/item ids — but **not** the
external ids on your orders, bills and credit notes. Those are the only local record of which ledger
document each one became, and every later correction or payment posts against them.

- **Reconnect to the same company** — everything resumes where it was.
- **Reconnect to a different company** — see above.

Re-authorising to a *different* company while still connected is refused; only an explicit
disconnect clears the pin.

**The sweep always makes forward progress.** It examines a bounded number of rows per run and
remembers where it stopped, so the next run resumes behind them and wraps round to the start when it
reaches the end. Rows it cannot settle — a permanent ambiguity, a connector outage — are retried
rather than retired, and because the sweep resumes rather than restarting, they cannot consume every
run's budget and hide newer breakages behind them.

**Retention interacts with this.** Sync logs are normally deleted once they pass the retention
period (Settings → Data Retention). A row the sweep has *not yet settled* — a posted row whose
document is still unlinked — is not deleted, because deleting it would erase the only evidence of
which document an unlinked bill belongs to, and deleting a *competing* row would silently turn an
ambiguity the sweep was refusing to guess at into a confident wrong answer.

It is **compacted** instead: at the retention cutoff the row keeps its connector, type, reference and
external id, and loses its payload and error message — the parts holding customer details, addresses
and financial lines. Nothing is retained past the retention period in full.

A compacted row is **still a repair candidate**, and the split is by what each piece of work needs
rather than by the row as a whole. Everything the id write reads — the reference and the external
id — survives compaction, so the sweep can still link the order or bill, including one whose
ambiguity only cleared *after* the retention cutoff. What cannot survive is the follow-up work built
from the payload (PDF, payment registration, bill attachment); whenever the sweep settles one of
these rows with follow-ups still outstanding — whether it repaired the link on that pass or the link
was already there — it logs `*_backreference_followups_discarded` naming the document, so you can
check for a missing PDF or payment and re-drive it by hand. The row is only closed once that warning
has been written, so the loss is never absorbed silently. A compacted row also still counts as a claim when the
sweep decides whether a purchase order's bill is ambiguous.

**Retrying a compacted row by hand reports the same loss.** If you press *Retry* (or *Retry all*) on
the Accounting Sync page and the row already carries an external id, IMS does **not** re-send the
document — it settles the row against the id that is already there. On a compacted row that means
the follow-ups built from the payload cannot be rebuilt either, so the retry writes the same
`xero_backreference_followups_discarded` WARNING naming the document, and the row is settled only
once that warning has been written. A retry that turns such a row green is therefore never silent
about what it could not do: check the activity log after a bulk retry over old failures.

The follow-ups that **do** survive compaction are still queued in that situation. A sales invoice
tombstone, for example, keeps everything the invoice-PDF job needs, so the retry enqueues it even
when the warning itself could not be written down — only the *settling* of the row waits for the
warning, never the work. **The repair sweep queues them too**, which it previously did not: it used
to announce the loss and settle a tombstone without calling the enqueue at all, which threw away the
same PDF the warning was telling you had survived.

**The warning names what the row actually owed, not what its type could owe.** A sales invoice only
owes a payment registration when the payment was recorded on it at the time it was queued — an order
invoiced with no receipt against it never owed one, and a tombstone of it lost nothing. Retention
therefore writes down what each row owed at the moment it compacts it, from the payload it is about
to erase, and the warning is raised only for what that record names. Two consequences worth knowing:

- rows compacted **before this shipped** carry no such record, and there is no way to give them one —
  the payload it would be derived from is exactly what was thrown away. Those rows keep the older,
  broader answer, so a sales invoice tombstone from before the change is still reported as having
  lost a payment registration even when it never owed one. The activity entry says which it was:
  `classificationBasis` is `row-record` for a row that answered for itself and `type-table` for one
  that could not;
- a row that owed nothing recoverable is now **settled silently**, with no warning at all. That is
  the intended outcome, not a missing alarm: there was nothing to lose.

**A compacted journal keeps its per-account net.** Retention writes each reversal-proof journal's per-account totals (codes and two numbers, no names) onto the row as it clears the payload, and the proof reads them once the lines are gone; a journal that cannot be summarised is left uncompacted and reported. A journal compacted **before this shipped** has neither, stays unprovable, and the credit is posted by hand. The refund and the daily batch treat such an unearned-revenue reversal as an **unknown amount, never zero**: the refund reverses no unearned revenue and logs a warning, and the daily batch skips that order's shipments (warning logged, nothing journaled) until the reversal is readable.

A follow-up rebuilt from a tombstone also carries the organisation the original row was raised
against — recorded in a column retention does not touch — so it can be posted. Before, it was queued
carrying nothing and refused at the socket, which meant the PDF the table promised never actually
went out.

**Do not cancel one of these rows to tidy it away.** Cancelling is irreversible in two ways the row
gives no warning about: a cancelled row is no longer a repair candidate, so the link that was still
perfectly possible is given up permanently; and it no longer counts as a competing claim, so an
ambiguity the sweep was refusing to guess at can silently become a confident wrong answer on some
other row. Cancel only when you have decided the document is genuinely abandoned. Rows the sweep
settles expire normally.

## Cron Endpoints

| Endpoint | Schedule | Purpose |
|---|---|---|
| `/api/cron/accounting-sync` | Every 5 min | Settle any held ("unconfirmed") posting refusals — which happens on every run, whether or not an accounting connector is enabled — then process pending accounting sync entries (invoices, journals) for whichever accounting connector is active, then, for Xero only, run the back-reference repair sweep |
| `/api/cron/accounting-daily-batch` | Daily (02:00 by default) | Run sub-ledger Groups A1, A2, B |
| `/api/cron/accounting-payment-poll` | Every 15 min | Detect paid invoices and bills in the active accounting connector |
| `/api/cron/accounting-payment-reconcile` | Daily (03:00) | Backlog sweep: check every locally-linked invoice/bill against its current Xero status by id (report-only unless `xero_payment_reconcile_apply`) |
| `/api/cron/accounting-fx-revaluation` | **Retired** (do not schedule) | Answers a successful skip and does nothing: Xero revalues open foreign balances itself (see *Unrealised FX* below). Remove it from the server's crontab if it is still there |
| `/api/cron/xero-chart-sync` | Daily (00:30 by default) | Refresh the stored Xero chart of accounts (read-only) before the balance snapshot |
| `/api/cron/account-balance-snapshot` | Daily (01:00 by default) | Snapshot Xero account balances for period reporting |
| `/api/cron/xero-tax-rate-drift` | Hourly | Read the full Xero tax-rate list into the tax-rate master store (rows, header and read-sync stamp in one transaction) and record IMS-vs-Xero tax-rate drift |

All cron endpoints require the `CRON_SECRET` bearer header in production. These jobs are switched on and timed on **Settings > System > Scheduler**; after an upgrade that adds or retimes one (the chart refresh is new, the tax-rate drift check is hourly), press **Save & Apply** there once so it reaches the crontab. See [Settings](settings.md#cron-jobs).


### Account balance snapshots (Trial Balance)

The snapshot pull reads Xero's Trial Balance and stores, per configured account, the balance at the report date: **YTD Debit minus YTD Credit**, so a credit-balance account such as Income in Advance is negative. Columns are found by **name** in the report's Header row (a blank cell is an empty string and means zero), never by position among the cells that happen to hold a number, and the period columns (Debit, Credit) are never used as a balance. A report with no Header, or with no YTD Debit / YTD Credit columns, is refused as a whole; a row with a non-money YTD cell or a different cell count from the Header is refused, and a configured account whose row is refused gets a named error (`TB_NON_MONEY_CELL`, `TB_ROW_CELL_COUNT`, `TB_NO_HEADER`, `TB_NO_YTD_COLUMNS`) and **nothing is stored for it**. **Balances stored before this fix were misread (blank cells were dropped, which shifted values into the wrong column) and must be re-pulled.** The pull upserts by connector + account + balance date + currency (`persistAccountingAccountBalanceSnapshots` in `lib/domain/accounting/account-balance-snapshots.ts`), so re-running it for a date replaces that date's row; there is no backfill, and the reconciliation pack, inventory GL reconciliation and transit reconciliation read correct figures only for dates pulled after this fix.

**Inventory reconciliation: no standing residue.** A rounding sweep is posted only while the NET of the sweeps of the trailing 30 days (a debit counts plus, a credit minus, so residue that alternates in sign nets out; failed and cancelled sweeps are not counted) stays within £5. A residue that would take the net past that is not posted and is reported as a warning, "recurring small residue not swept (cap reached)", since a small amount that recurs in one direction every day is an error, not rounding. A gap larger than the per-day limit is still a critical mismatch.

**Inventory reconciliation: stock in transit is its own line.** A stock transfer posts nothing, so the units on a transfer that has been dispatched and not yet fully received are still in the Inventory GL, but they have left the source warehouse and are in no warehouse's snapshot. The daily inventory snapshot therefore also records an **in transit** line, one row per transfer, and the reconciliation compares the GL with the on-hand value **plus** the in-transit value (the invariant details show both: `onHandValue` and `inTransitValue`). A transfer's in-transit value is the cost dispatched, plus any landed-cost revaluation capitalised for its units while they were on their way (the same amount the landed-cost journal debited to Inventory at that moment), minus the cost received so far by every route: a manual or partial receipt, a Mintsoft booked-in webhook, and a Mintsoft stock-sync alignment credit. It is measured as of the snapshot's own instant, so a transfer dispatched before a day and received after it is in transit on that day. A transfer that is closed (received or cancelled) is never in transit; a difference left on a closed transfer shows up as a reconciliation gap, as it should. Snapshot days written by the daily job before this line existed are compared on the on-hand value alone, as before (their on-hand was read at an unrecorded moment, so no in-transit instant matches it); backfilled days are valued from the movement ledger at their cutoff. A transfer with a dispatch or receipt movement that carries no value is left out of the comparison and named in an `inventory_transit_transfer_unvalued` warning, and that date is not swept. The reconciliation pack's inventory basis still compares the GL with the on-hand snapshot only, so on a day with stock in transit its figure differs from this check by the in-transit value. A landed-cost revaluation of in-transit stock that was made before this change is not in the revaluation record, so a transfer dispatched before then and revalued while in transit can show a gap equal to that revaluation until it is received.

**Independent check of the COGS and Transit sub-ledgers.** The accounting invariant report compares each sub-ledger with the journals as they were queued (not only with Xero), for the flows that are journals on both sides, and raises a warning `cogs_subledger_queued_journal_mismatch` or `transit_subledger_queued_journal_mismatch` when they differ by more than rounding. If the check itself fails to run, it reports an info finding `cogs_subledger_queued_journal_mismatch_unavailable` or `transit_subledger_queued_journal_mismatch_unavailable` instead of staying silent. Failed and cancelled journals are reported apart (their sub-ledger rows remain), journals emptied by retention are counted as unreadable, manufacturing reclass journals queued before their sub-ledger row existed are left out, and when journals in the window carry lines for other accounts but not the configured one (the account was re-bound) the check is reported as inconclusive (an info finding) instead of a mismatch. A retrospective manufacturing-cost reclass now records its COGS leg in the COGS sub-ledger.

**Year-to-date and the financial year.** The Trial Balance figure is year-to-date. For a balance-sheet account (Inventory, Allocated Inventory, Stock in Transit, Unearned Revenue) that is the lifetime balance, so closing minus opening is the period movement. For a profit-and-loss account such as COGS it restarts from zero at the start of each financial year. Each pull therefore stores the organisation's financial-year end (Xero `FinancialYearEndMonth`/`FinancialYearEndDay`, from the Organisation request the pull already makes) **on each snapshot row** (`financialYearEnd`, `MM-DD`) beside the tenant, null when the Organisation carried no valid one, so the year end in force at each pull travels with the balance and is overwritten, never carried over, by a re-pull. Every reader that subtracts two stored balances (the GL COGS reconciliation, the COGS report's GL variance) classifies the account by its **chart account type** (not by which setting holds it) and, for a profit-and-loss account, **withholds** the figure by name when the two balances do not both prove the same year end for the same organisation (`financial_year_end_unproven`: a year end that changed between the pulls, a balance pulled without one, or two organisations) or when the window crosses a financial-year start (`window_crosses_financial_year_start`): the reconciliation reports `financial_year_boundary`, the COGS report leaves the GL variance blank with a notice. An account type the chart does not know is treated as profit-and-loss. The reconciliation pack reads COGS only as the balance at the as-of date and never differences it. A row that carries a Xero account id different from the configured account's is never stored under that account (`TB_ACCOUNT_ID_CONFLICT`; the code is a fallback only for a row with no id), and a refused row that cannot be tied to any account (`TB_UNIDENTIFIED_REFUSED_ROW`) refuses the whole report, so an account Xero is assumed to have omitted is never stored as zero while an unreadable row exists.

**Which account, and unreadable rows.** A Trial Balance data row with a blank label is refused (`TB_BLANK_LABEL`), never skipped: if it names an account (by id or code) that account is not stored; if it names none, the whole report is refused (`TB_UNIDENTIFIED_REFUSED_ROW`). Header, Section and SummaryRow (totals) rows are not account rows. Xero leaves accounts with no balance out of the Trial Balance, so a configured account that is absent may be a true zero, but only if the report proves itself complete: the YTD Debit and YTD Credit of every row read must add up, exactly to the cent in both columns, to the report's single "Total" summary row (Xero's own Total is not required to balance: it can differ by a cent or two through rounding, so debit equals credit is deliberately not tested). Otherwise (no Total row, two of them, an unreadable one, rows that do not reach it, or any refused row) every absent configured account is withheld with `TB_COMPLETENESS_UNPROVEN` and the scheduled-pull success stamp does not advance. When the report does prove itself complete, the zero stored for an absent configured account carries that proof in its source reference (`xero:trial-balance:<date>:absent-from-complete-tb`, written at parser version 2 only), so a reader can tell a PROVEN zero from a zero recorded without the proof (the older `...:absent-from-tb` reference, from an earlier build, which is never read as a reported zero). The reconciliation pack reads the proven zero as a real balance (for example Allocated Inventory at P1 has no balance, so Xero omits it; the inventory comparison is no longer withheld), and still withholds on the older reference, rereading a non-zero amount under either as unreadable. The other readers (the inventory, COGS and transit GL reconciliations and the inventory valuation and COGS reports) use only the amount, but they accept an amount only from a balance that proves its provenance: a row Xero reported, or a proven-absent zero (the `absent-from-complete-tb` reference for the balance's own date, parser version 2, an amount of exactly zero), which is compared as the real zero it is and labelled `proven-absent` in the result. The older `...:absent-from-tb` zero, a reference for another date, an unknown reference or none, and a proven reference over a non-zero amount are not balances: the reconciliation is unavailable with `gl_balance_unproven` (the report variance is blank with a notice) until the date is pulled again. A configured account matched by more than one row (a repeated account id, or an id row plus an id-less row for the same code) is refused with `TB_DUPLICATE_ACCOUNT_ROW`; the first row is never taken. Stored balances belong to the Xero account id they were pulled for, so a code reassigned to another account is never mixed with the old account's balances: a period movement resolves the configured code to its one active chart account and reads both balances for that id (and one organisation), withholding by name otherwise (`account_identity_unproven`, `account_identity_changed`), and the reconciliation pack's as-of basis uses only the balance pulled for the configured account's id (`gl_account_identity`).

**The chart is read fresh by the pull.** The balance pull also GETs Xero's current chart of accounts and resolves each configured code against it, not against the locally stored chart (which may be stale after Xero reassigns a code): a code must be held by exactly one active account, otherwise nothing is stored for it (`TB_CHART_CODE_UNRESOLVED`). The chart is read twice, once before and once after the Trial Balance (three GETs in all), and a code is accepted only if both reads name the same active holder; a code Xero moved while the report was in flight is refused (`TB_CHART_CHANGED_DURING_PULL`) and nothing is stored for it. **Accepted limit:** a change that lands and is reverted between the two chart reads cannot be detected. The second chart read is written to the local chart in the same fenced transaction as the balances, so the local chart and the stored balances agree as of the pull. Every other single-balance read by a configured code (inventory GL reconciliation, COGS and transit reconciliations, the inventory valuation report's GL variance) resolves the code to its one active local-chart account, reads by that account id under the connected organisation, and withholds (`account_identity_unproven`) when that is not proven; these, like the pack basis, rest on the chart as of the latest pull.

**Every account row must carry its Xero account id.** The live report puts the account's UUID (an `account` attribute) on the label cell of every data row, and a code in a label can be reassigned after the report date, so a row without an id is refused (`TB_ROW_WITHOUT_ACCOUNT_ID`); a configured account is matched to its row by id alone, never by code. A refused id-less row that names a configured code withholds that account, and one that names no code at all refuses the whole report (`TB_UNIDENTIFIED_REFUSED_ROW`).

**The report must be for the requested date.** Xero's `ReportDate` is the day the report was generated, not the as-at date, so it is not read. The as-at date is the single `ReportTitles` entry of the form `As at 23 October 2026`; the report must also be of type `TrialBalance`. A response with no such entry, more than one, an unreadable one, a different day or another report type is refused whole (`TB_REPORT_DATE_MISMATCH`): nothing is stored and the scheduled-pull success stamp does not advance. A period movement likewise needs a stored balance for exactly the day before the window and exactly the last day of it; a balance from an earlier day is treated as missing (so the on-demand Trial Balance sync runs), never used in its place.

**Balances stored before the parser fix are ignored until re-pulled.** Each stored balance records the version of the parser that wrote it (`parserVersion`; the current version is 2, written by the pull). A balance with no version, or any other version, was written by the earlier parser that shifted values between columns; every reader (period movements, the single-balance reads of the reconciliations and the valuation report, the reconciliation pack's as-of basis and its transit opening balance, and the pack's IMS snapshot read) treats it as **absent**, never as a value: the movement readers report the snapshot as missing (so the on-demand Trial Balance pull runs), the pack reports `no_gl_snapshot` / `not_for_date`, and the transit leg is unusable. Re-pulling a date replaces its row (the upsert overwrites the version too); nothing is deleted or backfilled.

## Realised and Unrealised FX

Xero books both kinds of foreign-currency gain and loss itself. IMS posts no FX journal of either kind; it sends its own rate on every foreign document and payment, and keeps an FX Gain/Loss report for information.

### Realised FX (at settlement)

When a multi-currency invoice or bill is paid, the actual settlement exchange rate may differ from the rate booked at invoice creation. The system computes the realised FX gain or loss at payment time:

- **AR (sales invoice paid)** — gain when the settlement base value exceeds the booked base value (the customer's currency strengthened in your favour).
- **AP (supplier bill paid)** — gain when the settlement base value is less than the booked base value (your home currency strengthened against the supplier's).

**Xero books the realised FX itself, at IMS's rate, and IMS no longer journals it.** Every payment IMS sends for a foreign invoice or bill carries the settlement rate IMS resolved for that payment as the payment's `CurrencyRate` (the rate as is, 6 dp), so Xero posts the realised currency gain or loss to its own system gain/loss account using the same rate IMS measures. IMS does **not** queue its own `REALISED_FX_JOURNAL` manual journal for Xero: that journal targets the AR/AP control account (which Xero rejects) and would book the same gain or loss a second time. `computeRealisedFx` still runs on every payment, for IMS's own reporting only (the **FX Gain/Loss report**, Analytics → FX Gain/Loss); it never posts. A `REALISED_FX_JOURNAL` row that was already queued before this change is **retired, not sent**: it is marked Cancelled with the reason "Xero books the realised FX gain/loss itself, at the settlement rate IMS sends on the payment" and an `xero_realised_fx_journal_retired` warning is logged, so a payment and a journal queued before the change cannot both book the movement. A row whose record shows an earlier attempt **may have sent it** (a create-dispatch marker, a remote-attempt stamp or a document id) is not called "not sent": it is marked **Failed**, with its retries used up, and the message *may have posted on an earlier attempt … Check Xero Manual Journals for the reference …: if it is there, reverse it by hand in Xero* (activity `xero_realised_fx_journal_parked_may_have_posted`, level Error). IMS sends nothing for it either way. The Realised FX Gain/Loss account mapping is no longer used for Xero postings, and the **Realised FX Journals** switch is no longer shown on the Sync types list (its stored value is kept and ignored).

**A missing settlement rate refuses; there is no fallback.** The settlement rate is the latest `fx_rates` row on or before the end of the payment date (a date picked in the form is a whole business day, so a rate fetched at 09:00 that day is that day's rate). If the currency has no rate for that date, or its stored rate is zero, negative or ambiguous, the payment is **refused before anything is written**: no customer receipt or bill-paid status is recorded, nothing is queued, and the message names the currency and date. The old behaviour (use the document's booked rate, then 1, with an `fx_rate_fallback_used` warning) is gone. **Operator action: add the rate in Settings → Currencies for that date (or earlier), then record the payment again.** Refund payments and base-currency documents never need a rate.

### Unrealised FX (period revaluation) — retired

**IMS no longer revalues open foreign balances, and posts no unrealised FX journal.** With multi-currency switched on, Xero revalues open foreign-currency invoices, bills and bank balances itself: its system *Unrealised Currency Gains* account is calculated on unpaid invoices and bills at the current exchange rate, cannot be posted to, and shows on the Profit and Loss and Executive Summary; the *Bank Revaluation* account does the same for foreign-currency bank accounts; and Xero's **Foreign Currency Gains and Losses** report shows the balances revalued in the base currency (Xero Central: *Foreign currency accounts in the chart of accounts*, *Foreign Currency Gains and Losses report*). An IMS revaluation journal for the same balances would state the movement a second time, and its control leg is the AR/AP control account, which Xero refuses on a manual journal.

What changed (owner decision 2026-11-22):

- **The cron does nothing.** `/api/cron/accounting-fx-revaluation` still authenticates and rate-limits, then answers `success: true, skipped: true` with the reason *Retired: Xero revalues open foreign-currency invoices, bills and bank balances itself …*. It reads no documents, looks up no rate, reverses nothing, queues nothing and writes no activity entry. It is not in the Scheduler; remove it from the server's crontab if you added it.
- **Nothing is queued.** The enqueue suppresses `UNREALISED_FX_JOURNAL` for Xero, for a revaluation and for the reversal of one.
- **A row already queued is retired, not sent.** The Xero processor marks any `UNREALISED_FX_JOURNAL` row (either kind) **Cancelled** with the reason *Retired, not sent: Xero revalues open foreign-currency invoices, bills and bank balances itself …* and logs an `xero_unrealised_fx_journal_retired` warning, before any request to Xero. If the attempt that picked the row up no longer holds it, nothing is retired by that attempt and an Info entry `xero_unrealised_fx_journal_not_retired_claim_moved` says so (the attempt that holds it decides).
- **A row that may already have posted is parked, not called "not sent".** When the row's record shows an earlier attempt may have reached Xero (a create-dispatch marker, a remote-attempt stamp or a document id), it is marked **Failed** with its retries used up and the message *may have posted on an earlier attempt … Check Xero Manual Journals with the reference FXREV-<date>: if it is there, reverse it by hand in Xero; if it is not, nothing is owed* (activity `xero_unrealised_fx_journal_parked_may_have_posted`, level Error). Nothing is sent and IMS does not re-queue it.
- **The reversal of a revaluation that already posted.** If the row being retired is a reversal and the revaluation it reverses is **Synced** to Xero, not sending the reversal leaves that revaluation standing in Xero beside Xero's own. The reversal is still retired (Cancelled, nothing sent), and IMS logs an **Error** `xero_unrealised_fx_reversal_retired_source_posted` naming the Xero manual journal id of the revaluation, and records an `unrealised_fx_journal` row in the **exception inbox** (reason `retired_reversal_source_posted`) with the same journal id. That row stays until someone reverses the journal by hand in Xero and marks it handled.
- **The Unrealised FX Gain/Loss account mapping and the Unrealised FX Revaluation switch are not used.** Leaving them set changes nothing. The switch is no longer shown on the Sync types list (its stored value is kept and ignored).

**A revaluation that did post before this change.** None is expected: IMS has suppressed the journal for Xero since 2026-07, and before that its control leg was the AR/AP system account, which Xero is expected to refuse on a manual journal (not verified against a posting from that period). If one did post, IMS raised its reversal on the next run, so a revaluation whose reversal never posted would leave its amount standing in Xero next to Xero's own revaluation. IMS will not post a final reversal. Find any such journal in Xero (Manual Journals, narration *Unrealised AR FX revaluation at …* or *Unrealised AP FX revaluation at …*, reference `FXREV-<date>`) with no matching *Reverse unrealised FX revaluation from <date>* journal, and reverse it by hand in Xero after checking with your accountant.

The **FX Gain/Loss report** (Analytics → FX Gain/Loss) is kept as **information only**: it lists realised gain or loss per settled foreign receivable and payable at IMS's rates, and posts nothing. A settlement with no rate is listed as *Not computable*, with the reason, an empty rate and gain/loss, and counted under "Not computable (no rate)"; it is excluded from the totals and never valued at the booked rate or 1.

### FX rate staleness

Settlement no longer writes `fx_rate_fallback_used` entries: it uses the latest rate on or before the date, and refuses when there is none. Period-movement queries for accounts strictly require a previous-day snapshot — if no snapshot exists, the report shows a notice rather than silently using a stale value.


## Daily Batch Caps

The Xero daily batch processes orders and shipments in batches to avoid creating multi-thousand-line journals that are slow to post and hard for finance to read. The default cap is 1,000 entities per group per run (configurable via `XERO_DAILY_BATCH_LIMIT`, max 5,000).

If a single day exceeds the cap, the batch creates multiple journals for that date:

- **A1 — Revenue Deferral**: e.g. `A1-2026-06-09-abc12345` and `A1-2026-06-09-def67890`
- **A2 — Inventory Reclassification**: same pattern
- **Group B — Shipment Recognition**: same pattern

The hash suffix is deterministic (computed from the entity IDs in the batch), so re-runs produce the same reference IDs and don't double-post. Finance reading the Xero ledger should sum all entries for a given date to reconcile against the IMS daily total.

## Sync Log

The sync log at **Integrations → Xero** shows queued transactions for the **currently active** accounting connector, with their status:

- **Pending** — Queued, waiting for next cron run
- **Synced** — Successfully pushed to Xero (shows Xero transaction ID)
- **Failed** — Failed after 5 retries (shows error message)

- **Cancelled** (shown as **Retired**) — the row was taken out of the queue rather than completed. Usually nothing was posted (a sales order cancelled before its invoice went out, an orphaned queue row swept up). **Sometimes something was**: when the repair sweep retires a row because the sale is not live, the Xero document it names is real and is kept on the row on purpose. No sweep re-queues a retired row.
- **Cancelled, with the reason "Not sent by IMS: writes to Xero are held on this installation (…)"** — a *shadow*. A held WooCommerce sales invoice whose release the hold shadowed is closed (its queue row reads "Closed as a shadow") and raises no posting refusal; the daily-batch rebuild sweep blocks quietly over a shadowed batch rather than reporting it every run. The producer-side hold recorded what IMS would have queued instead of queuing it (see "Producer-side hold" in the installation guide). It has no Xero document id, was never claimable, has no outbox job and no accounting event, and carries a **shadow** badge on this page whose tooltip says IMS did not send it. It says nothing about whether the owner it names (Xeroom, Qoblex's own Xero integration, an operator working by hand) wrote the document to Xero, so it counts as **unproven**, not as absent: deleting an order, deleting a payment receipt, reversing or re-posting over a shadow is refused until Xero itself has been checked. A queued entry that already existed when the hold was switched on is not changed, but it is handed back unsent (activity `xero_sync_producer_held_before_post`) instead of being posted while the hold says it may not be. An entry that is only waiting for the owner's confirmation (Qoblex has not been confirmed stopped, or the confirmation has not been read yet) is not claimed at all: it stays Pending, its queue job is offered again every minute or two with no attempt spent and its last error shows the same sentence, and it goes out once the confirmation is recorded. Shadows exist only on an installation that names Xero in `PRODUCER_HOLD_ENFORCED_DESTINATIONS`; the same piece of work produced again is counted on one shadow record rather than added as another row, and Retry and Retry All never touch a shadow (they only touch Failed rows). A Failed entry that the hold would now shadow is not retried either (Retry and Retry All leave it Failed and name the hold), and neither the automatic follow-up revival nor the daily-batch reset turns it back into queued work. **The shadow row expires with the sync-log retention period, the shadow record does not.** Once the row has been deleted, deleting an order, correcting a stored invoice number and editing a posted stock adjustment are still refused, from the persistent shadow record, with the same unproven wording. One gap is known and tracked: deleting a payment receipt after the shadow row has expired is not yet refused on the shadow record, because that record does not yet carry the payment it was for.

Failed entries can be investigated via the error message and retried by resetting their status in the database.

#### Releasing a retired row after the sale comes back

If a retired row still shows a **Xero document id** and its sales order is **live again** — an order cancelled by mistake in WooCommerce and then reinstated, which pushes the live status back into IMS — the document is sitting in Xero with nothing linking it to the order, and no other control on this page applies: Retry and Retry All only ever touch `FAILED` rows, and the settle control answers that a recorded outcome cannot be rewritten.

The **release** button (the undo arrow) on that row is the way out. It:

- re-reads the sales order **under that order's row lock, inside the transaction that writes**, so a cancellation landing at the same moment cannot be overwritten by a decision taken just before it;
- releases the row back to `SYNCED` **only if the order is live**, so the ordinary back-reference repair sweep picks it up on its next run and writes the link and the outstanding follow-ups (PDF, email, storefront note, payment);
- **sends nothing to Xero**, either way. The document already posted; this only decides whether IMS may finish linking it.

It refuses, naming what to do instead, when:

- the order is **still cancelled** — the document must not be revived. Void or credit-note it in Xero, or reinstate the order first;
- the order **no longer exists** — same answer: the document is real, undo it in Xero;
- the order **could not be read** — nothing was changed and this is not a verdict about the sale, only about that moment. Try again;
- the row's outcome was recorded by an **operator assertion** rather than by Xero — the document id is unverified, so open it in Xero and link it to the order by hand;
- the **repair sweep has already reached a verdict** on the row — releasing it would produce a row no later pass looks at. Use the external-id release command instead. The row is re-read under the order's lock inside the transaction that writes, so a sweep verdict landing while you press the button is caught rather than overwritten;
- the row has **moved on to a different attempt** since the page was rendered. Reload and judge what the list shows.

**Rows that have never been picked up by a processor can be released too.** Historic rows — and any row the sweep retires before a processor ever claimed it — carry no attempt of their own. The release adopts such a row instead of refusing it: the write is still a compare-and-swap, so if anything claims or moves the row first, the release loses and tells you what changed.

Releasing needs the **settings** permission.

### Payments IMS refuses to send

Before every payment, bill payment and credit-note allocation — automatic or retried by hand — IMS reads the target document in the accounting system and refuses to post if it cannot positively establish that the settlement is not already there. These refusals are recorded as ordinary failures on the row, and all of them start "Not sent". They are not bugs to retry around; each one means a person has to look at the document.

- **"already holds a settlement of £X dated …"** — the payment is in the ledger. Either IMS sent it and lost the reply, or it was entered by hand. Reconcile the row against the settlement it names rather than sending another.
- **"could not establish what the accounting connector already holds"** — the read failed (the connector was down, or it returned something IMS cannot measure). Nothing was sent. The row retries on the next run and usually clears itself.
- **"does not record the amount its attempt would send, and the accounting connector already holds N settlement(s)"** — the queued row is incomplete, so IMS cannot tell its payment apart from what is already on the document. It only appears when the document is not empty; a document with nothing on it still posts normally.
- **"... not sent: ... is in EUR but carries no usable IMS rate to GBP"** — a payment against a foreign invoice or bill whose queued work has no usable settlement rate (or whose payload names no currency). IMS sends its own rate on every foreign payment and never lets Xero fall back to its XE.com day rate, so this payment was not sent. A payment recorded in IMS always carries its rate, so this appears only for work queued by an older build or damaged at rest: re-record the payment after adding the rate in Settings → Currencies. Nothing reached Xero.
- **"another entry for this document is posting … right now"** — two queued rows target the same document. Nothing is wrong; the second one retries once the first is readable.
- **"the money-post lock for this document was lost while IMS was posting"** — rare. The database connection holding this document's exclusive claim died mid-call, so another entry could in principle have posted at the same instant. Check the document for a duplicate settlement before retrying. When this happens the server log also carries a line beginning `[money-post] EXCLUSION LOST` naming the connector, document and entry.
### Settling a row IMS cannot resolve for itself

A **Failed** row does **not** prove that nothing reached Xero. The remote call is made *before* the
result is written back, so a row can end up Failed with a real document sitting in the ledger. That
is why a Failed row keeps its sales order from being deleted, and it is also why some Failed rows
must never be retried: when several rows for one reference posted under different idempotency
tokens, IMS refuses the retry outright, because a manual retry is far too late for Xero to
deduplicate it.

**Journals go further than that, because a journal create has no natural key.** Before a manual
journal (COGS, inventory adjustment, stock-in-transit, the daily batches and the rest) is put on the
wire, IMS commits a note on the row saying a create is about to be dispatched, together with the
idempotency token it will carry. If the post lands and the write-back then fails at commit, that
note is the only thing left saying a document may exist — so a later attempt is **refused** rather
than sent, once Xero's six-minute idempotency window has passed.

Read the refusal carefully, because it names **two** things that produce the same row, and IMS
cannot tell them apart from the row alone:

- the post landed and the write-back failed — **a real journal is in Xero**; or
- IMS recorded the dispatch and then **refused to send it itself**, before anything left the
  process: no usable Xero connection, posting paused for the organisation, an egress authorisation
  refusing the write, or the day's API budget exhausted. **Nothing is in Xero.**

The second case leaves a warning in the Activity log —
`xero_sync_transport_refused_before_post`, naming the sync row and the reason. **Look for that
first**: if it is there, IMS refused to send and the ledger should be empty. An attempt refused that
way does not fail the row or spend a retry; it is handed back and re-run, and only the note it left
behind persists. The note itself is never cleared — it is a prohibition, and one that could be
cleared would be no protection at all — so resolve the row with the **Settle** control below, or (for
an ordinary journal) cancel it and re-queue the work, which raises a fresh row with no note on it.

Rows in that position — and **Processing** rows whose connector was switched off while a worker held
them — now carry a **Settle** control (the gavel icon) beside Retry, both in the sync log and in the
stranded-rows banner. It records what *you* found in Xero:

- **It DID post** — you supply the Xero document id. The row becomes **Synced** and records that id.
- **It did NOT post** — the row becomes **Cancelled** and no id is written, and it is shown everywhere as
  **asserted: not posted**. **It does NOT make the order deletable again, and it does NOT free the posting to
  be sent again.** (The order's Delete stays refused — cancel the order instead, which keeps the record.) Your statement is your word about
  a ledger IMS did not check — a lost response, a late webhook or a payment made by hand all leave the
  same row — so IMS treats the row as *possibly posted*: it will not queue a replacement, it will not
  clear a held "paid" flag, it will refuse deletion of the receipt it registered, and it keeps the row
  (aged-out rows are compacted, never deleted). To get the posting into the ledger, **check Xero first and, only if the document is not there, record it in
  Xero by hand and mark the posting handled** in the refusal inbox.

Read what this is, because it is not a repair. IMS cannot check either statement; the control records
**your assertion**, logged against your account with the time, and it appears in the Activity log as a
warning rather than an ordinary note. Look the document up in Xero before using it.

**The decision applies to one attempt, and says so.** The dialog names the attempt it is about, and
the assertion is refused — with nothing written — if the row has moved on since the page was
rendered: "this row has moved on to attempt 5; the decision was made about attempt 3". Reload and
judge what the sync log then shows. This is what stops a conclusion about one failure landing on a
later, still-unresolved one.

**Evidence outranks the assertion, in both directions.** Settling a row as "did not post" is refused
outright if the row already names a Xero document. And if a claim you settled as "did not post" turns
out to have posted after all, the connector records that document's id on the row anyway and raises
an error naming it — so the order stays undeletable and you are told, rather than the assertion being
quietly believed.

The same applies to the **accounting event** IMS mirrors alongside the row. If that event already
names a document and you assert a different one — or assert that nothing posted at all — the whole
settlement is **refused and nothing is written**, naming both ids. Two documents cannot both be one
posting, and a settlement that reported success over a contradiction would leave the two records
disagreeing with nobody told. Check both ids in Xero: if the one already recorded is the real one
there is nothing to settle, and if it is not, reverse it in Xero before recording the other.

**A document id you typed in is a claim that the document exists, not a figure the IMS read.** Settling a row as "posted" with a document id you entered stops the IMS posting it a second time, but the lines IMS holds for it are what was *queued*, not what Xero holds. So wherever an amount is needed, the IMS no longer uses them:

- **A refund** that has to net an earlier reversal journal you settled this way (an order-level reversal, an Allocated Inventory reversal, the order's A2 batch journal, or an earlier refund's reversal) **withholds its Allocated Inventory reversal** instead of crediting against a figure not verified against the ledger: nothing is credited, the order keeps its A2 stamp, and the refund row's allocation-basis note says "settled as posted by an OPERATOR" and gives the steps. It is announced twice: a warning in the activity log at the moment it is withheld, and the standing **critical** accounting finding `sales_order_refund_allocation_basis_unresolved` for that refund. **What you must do today:** check the journal in Xero, then raise the credit by hand in Xero (DR Inventory / CR Allocated Inventory). What to credit depends on the refund. For a **full** refund it is the open balance (the recorded A2 debit less relief already credited; the note states each figure). For a **partial** refund it is **the lesser of two figures** the note states side by side: what the refunded units value, and the order's open A2 balance (recorded debit less relief already credited). Never credit more than the open balance, and credit nothing for the units the customer still holds, whose part of the A2 debit comes out when they are dispatched or refunded. If you already applied a manual credit for this order, deduct it. If the note says it could not establish the figure, work it out from the refunded lines; it never prescribes the order's whole debit for a partial refund; the same is said when the open balance itself cannot be established (for example, another reversal it depends on is also settled by hand). The IMS does **not** yet have a screen that records that credit or clears the finding, and checking the journal does not change what the IMS stored, so neither a later refund nor a full refund resolves it; the finding stays listed until that action exists. An unearned-revenue reversal you settled this way is still counted (arithmetic unchanged for now) and the refund adds a warning to the activity log.
- **The deferred-revenue true-up** of the daily batch and its preview count the same rows as before and now say, per order, which rows they rest on that were not verified against the ledger (an asserted row they counted, or a cancelled row that may have posted and they left out). The Daily Batch panel shows the warnings above the preview figures (an amber box, one line per order); the batch logs them. Nothing is held back yet.
- **The unrealised FX run** is retired (see *Unrealised FX (period revaluation) — retired*): it no longer reads journals at all.
- **A discount restated or reversed from a posted document** (chargebacks, the restated-discount handoff, credit-note netting) goes to **manual** when the posted document's mirror records only your assertion, or records no confirmation at all (every mirror written before the IMS recorded how a post was confirmed). Raise the credit note or adjustment by hand.

**What the sync pages now show: whose word a row rests on.** A row's badge and its document id are no longer
left to be read as "Xero holds it". The sync log, the stranded-rows banner, the exceptions inbox and the health
page say which of these a row is:

| Shown as | What it means | What it does NOT mean |
| --- | --- | --- |
| *(no badge), "posted as INV-1"* | Xero answered and returned that document | — |
| **asserted** | An operator typed that document id in; IMS did not verify the document or its amount | that Xero holds it |
| **asserted: not posted** | An operator settled the row "did not post". A claim, not proof | that nothing reached Xero — a lost response or a late webhook leaves the same row |
| **unproven** | A failed row, or one retired by something that could not tell whether a request had already been sent | that nothing was sent |
| **never sent** | The row was retired before any request was made, and that was recorded at the time (orphan sweep, supersession) | — |
| **verified reversed** | IMS asked Xero and it reported the payment gone. It may have been posted earlier; the id on the row is kept for the audit trail | that it was never sent |
| **rejected before posting** | The row's own stored request is missing something the connector requires, so it was refused before any request could be accepted | — |

Only **never sent** (a pre-call abandonment recorded at the time) is ever described as not sent; a **verified reversed** row may well have been posted first. An unproven or asserted-not-posted row always says to look in
Xero. The same rule shapes the rest of the product:

- **Deleting an order** is refused while any of its accounting rows may have reached Xero — that now includes a
  cancelled row nobody proved was unsent, and a row settled "did not post". The message says the document is
  *unproven*, to check Xero, and to **cancel the order instead**. The orphan sweep's own cancellations (stamped
  before any request) and a payment IMS verified gone from Xero still let the order go.
- **Taking a refused posting for hand posting** is not blocked by a cancelled row (a cancelled row can never post
  again, and hand-posting is the remedy for it) but the inbox, and the log entry written when you take the posting,
  now list every earlier attempt retired without proof — "settled by an operator as NOT posted (an assertion, not
  proof that it did not post)" — and tell you to **look in Xero first and post by hand only if the document is not there**, because a second document is
  not undone by marking the posting handled.
- **Retention** keeps every row an operator typed a document id into, whatever it is keyed to, as a compacted
  tombstone: the personal data in its payload still expires on schedule, the claim (connector, type, reference, status,
  id, basis) is never deleted.
- **The health page** no longer shows a batch whose journal id was typed in as a plain green SYNCED; it reads
  "SYNCED (asserted by an operator, not confirmed)" and warns. **Reconciliation** says whose post a "posted event has
  no external ID" finding is, and the **invariant check** logs an info finding for each posting that counts as
  evidence only on an operator's assertion. A discount or restatement decision that finds an invoice row naming a document
  says how many rest on the connector and how many on an operator's word.

**Settling "it did not post" retires that attempt, not the document.** A "did not post" settlement
marks the shared accounting event **Void**, which is what stops a finished row leaving work that
reconciliation reads as still owed. It is not a statement that the document is no longer wanted. Since
IMS no longer treats your statement as proof, the posting is **not** queued again on the strength of it
(see above): the enqueue is refused and the posting stays owed until you check Xero and, only if the document is not there, record it by hand and
mark it handled. A replacement that arrives some other way — after a row IMS itself retired — takes a
Void event of this kind back to **Pending**, and the revival is recorded against the event in its own
history.

Two things are deliberately **not** brought back by a replacement. An event that already names a Xero document is
never revived, whatever its status says — a document that exists is not queued work. And an event
voided because **the order was cancelled** stays voided: that retires the document itself, and a
later enqueue does not overrule the cancellation. If you see a cancelled order's invoice event still
Void while a live sync row exists for it, the sync row is the thing to look at, not the event.

**And the back-reference repair sweep now asks the same question itself.** It is the sweep — not the row that fed it — that actually restarts a sale's work: it writes the Xero id onto the order and re-enqueues the invoice's PDF, email, WooCommerce note and **payment**. Gating only the paths that *produce* its candidate rows could never be complete, because the ordinary success path reads no sales order at all: an invoice that posted and then failed its back-reference or its follow-up enqueue is marked `FAILED` with its Xero id intact, which is precisely the sweep's candidate shape, with nobody having asked about the sale. So before it releases anything, the sweep reads the sales order under that order's row lock and:

- **live** — repairs it, exactly as before;
- **cancelled** — retires the row to `CANCELLED` instead, writes nothing onto the order, enqueues no follow-ups, and raises an ERROR naming the Xero document that is now the only thing left to undo;
- **unreadable** — defers: nothing is written, nothing is retired, the row keeps its status and the next sweep asks again. A WARNING records the deferral.

A retirement is **not** the end of the story if the sale comes back: see *Releasing a retired row after the sale comes back* above. The retirement is deliberately fail-closed, and the release is the operator's way to answer it once the sale can be proved live again.

Only rows whose reference is a **sales order** are gated this way. A supplier bill has no sale behind it, and a refund credit note is very often the direct consequence of the cancellation — refusing to finish *that* back-reference would strand the very document the cancellation created.

The sweep result (returned by the cron endpoint and by manual sync) reports these as `retiredCancelledSale`, alongside `checked` / `repaired` / `failed` / `skippedAmbiguous`.

What remains is a cancellation that commits **after** the sweep has read the order and released the lock — the same sub-second window the pre-post order check has, and bounded by the same lock. What is gone is the open-ended version of it: a sale cancelled hours or days ago whose row still sat in the candidate shape and was released afresh on every single sweep run.

One posting can be mirrored under **either of two keys** — the one tied to this sync row, and an
older form shared by every attempt at the same document on the same day — and *both* are checked.
An earlier attempt's real document sitting on the second key refuses the settlement exactly as one
on the first does, rather than the settlement succeeding because the key it happened to write was
the empty one.

**A settled row is marked as settled by hand, and stays marked.** IMS never verified it — no call was
made, no document was read, and no *amount* was compared. That matters most for payments: Xero will
accept a payment for less than the invoice as a **part payment** and hand back a perfectly valid
payment id, so an asserted payment id can name a part payment while IMS's own figures agree with each
other exactly. So the order and bill screens do not show an asserted payment as **Settled**. They show
**"asserted, not verified"** and flag it as a discrepancy, with the payment id to look up. Open that
payment in Xero and check its amount against the document total; once the two really do agree there is
nothing further to do in IMS, and the flag is there so nobody mistakes a colleague's note for Xero's
word.

**And the repair sweep will not turn your assertion into the ledger link.** A row you settle as
"it DID post" looks, on the row itself, exactly like one Xero confirmed — so the back-reference
repair sweep used to pick it up and stamp the id you typed onto the order or bill. That column is
what the rest of IMS treats as proof the document exists: the PDF, the attachment and the
**payment** are built from it, the settlement verdict is measured against it, and the order delete
guard reads it as evidence. The sweep now **refuses** such a row instead — it writes no link and
queues no follow-ups — and logs `xero_backreference_unverified_assertion` naming the document and
the record it would have linked.

That refusal is repeated about once a day until someone acts on it, because the only thing that
clears it is a person: open the document in Xero, and if it is the right one, **link it to the order
or bill by hand**. The sweep then finds the document already linked, settles the row and stops
warning, having taken nothing from the assertion. If the document is *not* the right one, correct
the sync row — it must not be repaired from.

**Settling a row whose order has been cancelled records the document and stops there.** If you assert
"it DID post" against a row belonging to a **cancelled** sales order, IMS keeps the document id — the
delete guard needs it, and the document is real — but leaves the row **Cancelled** rather than Synced,
and tells you it has done so. A Synced row with a document id is what the repair sweep takes as an
instruction to carry on with that order's work: stamp the id onto the order and queue the PDF, the
email, the storefront note and the **payment**. None of that should happen for a sale that was
cancelled. Reverse the document in Xero instead.

**What cannot be settled, and why the control says so instead of disappearing:**

- **Pending** rows — nothing was sent, so there is nothing to assert. The ordinary sweeps retire them.
- **Synced** and **Cancelled** rows — the outcome is already recorded and must not be rewritten. A
  **Cancelled** row that still names a Xero document, on a sales order that is live again, has its own
  control — see *Releasing a retired row after the sale comes back*. It does not settle the row; it
  hands it back to the repair sweep.
- **Daily batch** rows — a batch row covers every order staged into it, so cancelling one could let an
  order be deleted while a recreate is still building a journal containing its value. Reverse the
  journal in Xero and let the batch sweep re-derive it.
- Rows showing **attempt 0** *on the active connector* — no fence-aware worker has ever claimed them
  yet, so a decision cannot be tied to an attempt. **Retry** the row: the worker stamps an attempt
  when it claims it, and the row can be settled from the next page load. Rows on a **retired**
  connector are a different case — see below.

Settling needs the **sync** permission and a recently re-verified session; you will be asked to
confirm your identity if your session is older than that.

### A document posted in Xero that IMS could not record

Very rarely a worker posts a document to Xero and then finds its sync row already naming a **different**
document — a replacement worker took the row while the first request was still on the wire, and posted
its own. Both documents are real and in the Xero ledger. IMS refuses to overwrite what the row already
names, because that would destroy the only local record of one of the two.

When that happens an **ERROR** entry appears in the activity log with the action
`xero_posted_document_unrecorded`. It names **both** ids — the one the row keeps and the one that could
not be recorded — and the sync row's reference, and it is written in the same database transaction that
detected the conflict, so it exists whenever the conflict did. The same wording is put on the outbox job
as its final error, so the two never describe the incident differently.

**Remedy.** Open both ids in Xero. Keep the document the sync row names; **void or credit-note the
duplicate**. Nothing further will be retried for either one — the sync row is settled against the first
document and the outbox job is closed — so this is a one-off manual correction, not something that will
resolve itself on the next cron run.

A rarer variant of the same entry says the sync row **no longer exists** at all
(`reason: ROW_MISSING`). The remedy there is to find the document in Xero by the id in the entry and
either keep it, re-entering the reference by hand, or void it.

**This entry is never deleted by activity-log retention.** Ordinary ERROR entries are purged after
90 days (configurable under **Settings → Data retention**); `xero_posted_document_unrecorded` is
exempt, because it is not a log of something that happened — it is the *only* place in IMS that the
displaced document exists, and nothing can rebuild it. Expect these entries to accumulate until an
operator has dealt with each one in Xero; they are meant to be read, not aged out.

**If the entry itself could not be written** — a database problem at exactly the wrong moment — IMS
does *not* quietly retry the sync. A retry would find the row already naming the other document,
settle it and report success, and the id that could not be recorded would be lost for good. Instead
the outbox job is closed as **permanently failed** and its error message carries the whole incident,
both ids included, and the same text is written to the application log. Look for
`[xero-sync] Xero … POSTED as …` there. The remedy is the same as above.

**No sync run will ever report one of these jobs as succeeded.** Before a run completes an outbox job
whose sync row is already settled — a replay, or a row that settled while the job was being claimed —
it asks the activity log whether a `xero_posted_document_unrecorded` entry exists for that row, *at that
moment*, and buries the job with the entry's wording if one does. It asks again immediately after
writing the completion, because the entry may be filed by another worker in between; if it appears in
that gap the completion is retracted and the job is put back to permanently failed. So a job you find
closed green never had one of these entries against it, and the presence of an entry always shows up as
a failed job you can find on **Integrations**, no matter which worker or which run detected it.

### A post that landed after its attempt had moved on

A worker claims a sync row, mints an **attempt** for it, and only then calls Xero. Almost always the
row is still on that attempt when the result comes back. Occasionally it is not — a settlement you
recorded about that attempt, or a retirement, moved it while the request was on the wire.

The result is still recorded: the document id goes onto the row exactly as it would have, because
evidence that something posted must never depend on winning a race. What also happens is an **ERROR**
in the Activity log with the action `xero_sync_post_fenced_out`, which:

- names the attempt that posted and the attempt the row is on now, so a decision you made about the
  first one is visibly a decision made without this outcome;
- says what the post actually *did* for that sync type — a ledger document, a manual journal, an
  applied payment, an in-place edit of an existing document, or an effect that creates nothing in the
  ledger at all (an invoice PDF, an invoice email, a WooCommerce note, a bill attachment, a
  credit-note allocation);
- and states the remedy that matches: void or credit-note the document, post a reversing journal
  (or, for a journal sent in **draft** posting mode, **delete the draft** — a draft has not reached
  the ledger, so posting a reversal would move the accounts by exactly the amount the draft never
  moved), remove the payment, correct the edited document — or, for the effects that create nothing,
  that there is nothing to reverse.

So if you settled a row as "it did NOT post" and it turns out it did, you are told, with the id and
with the right remedy, rather than the assertion being quietly believed.

### Postings refused because they were built for the connector you switched away from

Switching the active accounting connector while IMS is composing a document is the one moment the
document's own account numbers can stop describing the ledger it is about to be written to. Every
account code IMS sends — the sales account on each invoice line, the shipping and discount accounts,
the inventory, COGS, unearned-revenue, allocated-inventory and FX accounts on a journal — is read from
**one** connector's chart of accounts. The row is written a moment later. If the selection moves in
between, the document would land in the other connector's queue still carrying the first connector's
account numbers: it is then either rejected by that accounting system, or posted against whatever
those numbers happen to mean in its own chart.

IMS no longer writes such a row. The posting is **refused** and recorded in the activity log as
`accounting_enqueue_refused_retired_chart` (or, for an edit to an invoice that has already posted,
`sales_invoice_update_refused_retired_chart`), naming the document type, the order or refund it was
for, the connector whose chart it was built from and the one that is active now. The message says
plainly that **nothing was queued** and that the posting is **still outstanding**.

**What to do.** Nothing is lost and nothing partial was written — there is no row to find, no document
to reverse, no half-posted invoice. Once the connector selection has settled, queue the posting again
from its source: re-save or re-finalise the sales order for an invoice, press **Retry accounting** on
the refund for a credit note and its reversals, re-run the revaluation for an FX journal. A refund
whose credit note was refused keeps its **accounting retry required** flag and its warning, so it
stays on the list of refunds owing accounting rather than looking settled.

**Only a clean hand-off or Retry accounting takes that flag down.** A storefront delivering the same
refund a second time (a redelivered WooCommerce refund) is recognised as a replay of the refund IMS
already has: it creates nothing, queues nothing new, and **leaves the flag and the recorded postings
alone**. Until the refund's accounting has been retried, a further refund on the same order is refused
("A previous refund on this order has unresolved accounting and must be retried before another refund
can be created"), so the order's next refund can never be worked out against a reversal that was not
queued. The Allocated Inventory relief a refund records when it is created is counted by the order's
next refund only against a reversal journal that exists; if the connector's posting of that reversal was
switched off when the hand-off ran (so it will never exist), the recorded relief is written down to £0
in the same step that clears the flag, and the next refund credits the open balance in full.

This is a refusal, not a retry: IMS does not re-resolve the connector and try again on its own,
because "which books does this belong in" is not a question it can answer for you in the middle of a
switch.

**It is a narrow window, not a general refusal.** A posting is refused only when the selection actually
changed while that one document was being built. Ordinary posting, including posting to a connector you
switched to hours ago, is unaffected — the document is built and written under the same connector, as
before. A refund or order posted while no accounting connector was enabled at all is unchanged too: as
before, nothing is queued, because there is nothing for it to post to.

**Which postings this covers.** All of them. The rule applies to every accounting document IMS queues,
not only to the sales invoice and credit note: stock receipts and supplier returns, purchase bills and
bill edits, supplier credit notes, bill payments and invoice payments, manufacturing overhead and
manufacturing reclass journals, landed-cost reclass and COGS journals, shipment COGS revaluations,
inventory adjustments, allocation and unearned-revenue reversals and tax-rate syncs (the unrealised FX
revaluation, once on this list, is retired). Every one of them now records which connector's chart of accounts it was built from, and
every one of them is refused rather than mis-routed.

**Three postings behave slightly differently, and it is worth knowing why.**

* **Reversing a previous FX revaluation.** Retired with the unrealised FX revaluation: IMS raises no
  reversal. A revaluation that needs unwinding is reversed by hand in Xero (see *Unrealised FX (period
  revaluation) — retired*).
* **A sales invoice held waiting for a WooCommerce invoice number.** These holds can sit for days, and
  the account numbers are frozen when the order is imported. A hold parked by an older version of IMS,
  before it recorded which connector those numbers came from, cannot be released automatically: the
  hold stays PENDING, the reason is shown on the row and in the activity log
  (`sales_invoice_release_failed`), and the remedy is to queue the sales invoice from the order.
* **Retrying a refund's accounting.** A refund whose reversals were staged by an older version of IMS,
  before it recorded the chart, cannot be replayed automatically either. **Retry accounting** reports
  the refund as still owing, logs `refund_accounting_replay_unchartered`, and leaves the flag set —
  check whether the reversal already posted and, if not, raise it by hand from the refund's own cost
  snapshots.

### Payments and updates refused because IMS cannot tell which connector holds the document

Some postings carry more than account numbers. A **customer payment** and a **supplier bill payment**
name the invoice or bill they settle and the bank account the money moves through; a **bill edit** and a
**sales invoice edit** name the document they overwrite; a **supplier credit note** names the bill it is
allocated against. Those are the accounting system's own document and account IDs — and IMS keeps an
invoice's ID when you change the accounting connector, because the invoice still exists in the books it
was posted to. So "this payment's account numbers are the active connector's" says nothing about whether
the invoice it pays is in that connector at all.

**IMS now records which connector each posted document belongs to**, at the moment the ID is written
back (sales invoices, credit notes, purchase bills and supplier credit notes). A payment, edit or
allocation is only queued when that recorded connector is the one it would post to. Otherwise it is
**refused**, nothing is queued, and it is reported:

* customer payments: `invoice_payment_not_registered` with refusal **DOCUMENT_PROVENANCE_UNPROVEN**;
* bill payments: the bill is **not** marked paid and `bill_payment_enqueue_declined` says the payment was
  *refused* (not that posting is switched off);
* bill edits: the edit is saved in IMS and `purchase_invoice_update_not_queued` (ERROR) says the ledger
  still holds the previous version;
* sales invoice edits: `sales_invoice_update_refused_unattributable_document`;
* supplier credit notes: the credit note stays **draft** and `supplier_credit_note_not_posted` explains why;
* anything else carrying a document ID: `accounting_enqueue_refused_unattributable_document_id`.

**Documents posted before this version have no recorded connector, and are refused too.** This is
deliberate and is *not* a narrow window like the chart refusal above: IMS does not guess which ledger holds
an older invoice, because guessing is the mistake being prevented. **Do not re-post it:** a
document that is already in a ledger and is posted again can create a second one. Identify the existing
document in the accounting system and confirm it exists there, then pay or edit it in the accounting system
itself (IMS will not do it for a document whose connector it cannot prove, and has no step that makes it
guess). For a customer payment, follow the remedy in the refusal message itself: it says whether settling
by hand is safe, because a deferred re-drive may still register the receipt.

**The payment account mapping is shared by every accounting connector.** Its keys (`method:currency`)
are connector-neutral, but each value is one connector's own bank-account ID. A customer payment is
therefore only queued when the mapped account is an active bank account in the connector's synced chart
of accounts; otherwise it is refused with **PAYMENT_ACCOUNT_NOT_IN_LEDGER**. After switching connector,
sync the chart of accounts and re-map each method against the new connector.

The same check applies to payments registered for **imported (WooCommerce) orders**, whose bank account is
chosen when the sales invoice posts rather than when the receipt is recorded. If the mapped account is not
one of the posting connector's own bank accounts, the payment is not queued and `xero_payment_skipped` names the mapped account; the retry picks it up once the mapping is fixed. The
account that passes the check is the one written into the payment, so a later edit to the mapping does not
redirect a payment that is already queued.

**"Posting is switched off" and "the connector changed" are no longer the same answer.** A supplier credit
note, a bill edit, a manufacturing journal or reclass, and a sales invoice edit each check whether the
connector their account codes came from is still the active one. If it is and that posting type is off,
nothing is expected, as before (a credit note posts locally). If the connector has changed, the posting is
**refused** and reported instead — a credit note stays draft (`supplier_credit_note_not_posted`), a bill
edit logs `purchase_invoice_update_not_queued`, a sales invoice edit whose update the queue declines logs
`sales_invoice_update_not_queued` — rather than being silently treated as switched off.

### Refused postings appear in the exception inbox as outstanding work

A posting IMS refuses is **not** only an activity-log line. Each refusal is recorded as a row on
**Sync → Exceptions**, in the section *"Accounting postings IMS refused to queue"*, beside the accounting
follow-ups that page already lists. Each row names the document and its reference, the chart of accounts
the payload was built from **and** the connector that was active when it was refused, how long it has been
owed (and how many attempts), what still stands in IMS, and what to do about it.

Three things about those rows:

* **How a row is closed depends on the place that refused it**, not on its text, and the page says which on
  every row. The classification, generated from the code:

<!-- posting-refusal-kinds:begin (generated from lib/domain/accounting/posting-refusal-kinds.ts; do not edit by hand) -->

**Clears itself** — IMS queues the same posting again and nothing can make it refuse for ever. No action is offered.

| Refused posting | Why |
| --- | --- |
| `tax_rate_sync` (TAX_RATE_SYNC / TaxRate) | Saving the tax rate again pushes it to whichever connector is active then; it leaves this list when the push is queued. |

**IMS retries it, but the retry can get stuck** — press *Take for hand posting* first (that cancels IMS's own queued attempt and stops it queueing another), then identify the posting type before any ledger work (the exception inbox names it on the row), then check the ledger for the CURRENT version of the posting: if it is there, do not post again; otherwise follow the step for that posting type, then *Mark as handled*.

| Refused posting | Why |
| --- | --- |
| `sales_invoice_held_release` (SALES_INVOICE / SalesOrder) | The WooCommerce reconcile sweep retries the held invoice, but always for the connector it was built for — after a permanent connector switch it is refused on every run. |
| `sales_invoice_update` (SALES_INVOICE_UPDATE / SalesOrder) | Re-saving the order queues the update again, but it is refused for as long as the invoice belongs to a connector that is no longer active. |
| `purchase_invoice_update` (PURCHASE_INVOICE_UPDATE / PurchaseOrder) | Re-saving the bill queues the update again, but it is refused for as long as the bill belongs to a connector that is no longer active. |
| `invoice_payment_receipt` (INVOICE_PAYMENT / SalesOrder) | The receipt is registered again only when the invoice's deferred-receipt recovery runs, which does not happen for every invoice. |
| `credit_note_allocation` (PURCHASE_CREDIT_NOTE_ALLOCATION / SupplierCreditNote) | The credit-note allocation sweep retries it, but refuses on every run until both documents are recorded as belonging to the active connector. |
| `unrealised_fx_journal` (UNREALISED_FX_JOURNAL / FxRevaluation) | Retired: IMS no longer queues this posting (Xero revalues open foreign balances itself) and the revaluation run queues nothing, so nothing raises it any more. A row here predates the retirement, or is the reversal of a revaluation that had already posted to Xero, which the row names; mark it handled once that revaluation has been dealt with in Xero. |
| `landed_cost_cogs_journal` (COGS_JOURNAL / PurchaseOrder) | The landed-cost journal outbox retries it, but gives up after a fixed number of attempts. |
| `landed_cost_transit_journal` (STOCK_IN_TRANSIT / PurchaseOrder) | The landed-cost journal outbox retries it, but gives up after a fixed number of attempts. |
| `refund_credit_note` (CREDIT_NOTE / SalesOrderRefund) | The Retry button on refund accounting queues it again, but always for the connector the refund was staged for — after a connector switch it is refused every time. |
| `refund_cogs_reversal` (COGS_REVERSAL / SalesOrderRefund) | The Retry button on refund accounting queues it again, but always for the connector the refund was staged for — after a connector switch it is refused every time. |
| `refund_unearned_reversal` (UNEARNED_REV_REVERSAL / SalesOrderRefund) | The Retry button on refund accounting queues it again, but always for the connector the refund was staged for — after a connector switch it is refused every time. |

**Nothing in IMS posts it again** — press *Take for hand posting* first, then identify the posting type before any ledger work (the exception inbox names it on the row), then check the ledger for the CURRENT version of the posting: if it is there, do not post again; otherwise follow the step for that posting type, then *Mark as handled* (which also stops IMS ever posting it).

| Refused posting | Why |
| --- | --- |
| `sales_invoice_order` (SALES_INVOICE / SalesOrder) | The invoice is queued once, when the order is created or finalised, and nothing queues it again. |
| `sales_invoice_import` (SALES_INVOICE / SalesOrder) | The invoice is queued once, when the WooCommerce order is imported, and nothing queues it again. |
| `stock_adjustment_journal` (INVENTORY_ADJUSTMENT / StockMovement) | The journal is queued once, with the stock movement; nothing queues it again for that movement. |
| `returns_inbox_restock_journal` (INVENTORY_ADJUSTMENT / WmsReturnsInbox) | The journal is queued once, with the restock; the returns-inbox item is then closed, so restocking again is not possible. |
| `refund_adoption_reclass_journal` (INVENTORY_ADJUSTMENT / SalesOrderRefund) | IMS queues no journal for this: a refund that adopts an already restocked arrival raises this owed-posting record once, and it stays in the inbox until it is marked handled. Deleting the refund closes the record. |
| `purchase_order_cancellation_reversal` (INVENTORY_ADJUSTMENT / PurchaseOrder) | Retired. Cancelling a part-received purchase order now closes it short and queues no reversal, so nothing raises this posting any more; the kind stays so a row already in the inbox can still be marked handled. |
| `supplier_return_reversal` (INVENTORY_ADJUSTMENT / PurchaseReturn) | The reversal is queued once, with the return; raising the return again would be a second return. |
| `stock_receipt_journal` (STOCK_RECEIPT / PurchaseOrder) | The journal is queued once, with the receipt; receiving again is a different receipt. |
| `purchase_invoice` (PURCHASE_INVOICE / PurchaseInvoice) | The bill is queued once, when it is created; creating it again would be a second bill. |
| `realised_fx_bill_payment` (REALISED_FX_JOURNAL / PurchaseInvoice) | Retired: Xero books the realised gain/loss itself, at the settlement rate IMS sends on the payment. IMS no longer queues it (when the bill is paid or otherwise), so nothing raises it any more; the kind stays so a row already in the inbox can still be marked handled. |
| `realised_fx_receipt` (REALISED_FX_JOURNAL / Payment) | Retired: Xero books the realised gain/loss itself, at the settlement rate IMS sends on the payment. IMS no longer queues it (when the receipt settles or otherwise), so nothing raises it any more; the kind stays so a row already in the inbox can still be marked handled. |
| `manufacturing_journal` (MANUFACTURING_JOURNAL / ProductionOrder) | The journal is queued once, when the production order completes, which cannot happen twice. |
| `manufacturing_reclass` (MANUFACTURING_RECLASS / ProductionOrder) | The reclass is queued once for this cost change; a later cost change is a different reclass. |
| `purchase_fx_variance` (PURCHASE_FX_VARIANCE / PurchaseOrder) | The journal is queued for one change of the bill or its receipts; the next change queues only the difference that is still owed. |
| `allocation_reversal` (ALLOCATION_REVERSAL / SalesOrder) | Each reversal belongs to one trim of the order's allocations and is never raised again. |

<!-- posting-refusal-kinds:end -->

  **Settling a posting by hand is two steps, and the first one is not optional.**

  What to do in the ledger depends on what IMS knows, and every surface says the same thing (the row, the *Take for hand posting*, *Mark as handled* and *Release* dialogs, and the log entry are all produced by one function):

<!-- hand-post-instruction:begin -->
Take the posting for hand posting first and hold that claim while you work: every row below applies only under that claim.

| Posting type | What the page, the dialogs and the log tell you | When to press *Mark as handled* |
|---|---|---|
| An invoice or bill UPDATE (SALES_INVOICE_UPDATE, PURCHASE_INVOICE_UPDATE) - whatever IMS loaded: earlier versions, retired attempts, or nothing | Hold the hand-post claim, then: check the ledger for the CURRENT version (the one this refused posting would have made, not an earlier version): if the current version is there, do not post again; if only an earlier version is there, apply the update to it (do not raise a second document); if nothing is there, post it as a new document. | Only once the CURRENT version is in the ledger. |
| A bill PAYMENT (BILL_PAYMENT) - whatever IMS loaded | Hold the hand-post claim, then: check the ledger for the CURRENT payment (the one this refused posting would have registered, not an earlier payment; an earlier payment does NOT discharge this one): if the current payment is there, do not post again; if only an earlier payment is there, register THIS payment as a NEW payment and do NOT alter the earlier payment; if nothing is there, post it as a new payment. | Only once the CURRENT payment is in the ledger. |
| A DELETE of a synced invoice or bill (SALES_INVOICE_DELETE, PURCHASE_INVOICE_DELETE) - the work is removing the document, not posting it | Hold the hand-post claim, then: check the ledger for the document: if it is already deleted or voided, do not repeat it; only if it still exists, first change its number (add a suffix such as -DEL-ABC123) so the original number is free, then delete it if it is a draft or submitted, or void it if it is authorised and has no payments or credit applied. | Only once the document is deleted or voided in the ledger. |
| Any other posting (no earlier document can exist) | Hold the hand-post claim, then: check the ledger for that document first; post it ONLY if it is absent. If it exists, do not post again. | Only once the document is in the ledger (already there, or posted by you). |
| The posting type is not known where the text is shown | Hold the hand-post claim, then: identify the posting type before any ledger work (the exception inbox names it on the row), then check the ledger for the CURRENT version of the posting: if it is there, do not post again; otherwise follow the step for that posting type. | Only once the CURRENT version of the posting is in the ledger. |
<!-- hand-post-instruction:end -->

<!-- hand-post-settlement:begin -->
  **1. Take for hand posting.** Press this *before* you go to the ledger. While you hold the claim, IMS does not queue this posting. (Not on a sweep, not when another operator saves the document.) It cancels any queued attempt at that posting that nothing has picked up. If a sync row for it may ALREADY have been sent (it is being processed, has failed, or carries a document id) you are refused here and nothing is changed: check the ledger and settle that sync row first. While you hold the claim the row is on this list, marked as being settled by you; another operator who opens the page is told you hold it. Each refused attempt is logged as `accounting_posting_suppressed_hand_post_claimed`.

  **2. Mark as handled.** Marking this records your confirmation and cancels IMS's own queued retry of this posting. IMS does not read the ledger when you press it: it takes your word, so press it only when the table above says so. It asks for an optional note (for example the ledger journal number) and records who marked it and when. It is refused if you do not hold the posting, and on a row that IMS clears itself. Check Sync > Exceptions afterwards to see whether this row closed or a new one appeared. Resolved rows from the last 30 days are listed underneath with how each was closed.

  **Release.** Releasing gives up your claim on this posting. Do not release it if you have already posted it by hand: press *Mark as handled* instead. Releasing somebody else's claim is allowed and is recorded as a **warning**. Check Sync > Exceptions afterwards to see whether this row closed or a new one appeared.

  **Postings being settled by hand.** Every claim is listed in its own section, independent of the refusal list (which shows the oldest 50 debts). A claim has no expiry: somebody confirms the posting or releases it. Each row shows who holds it, how long it has been held, and how many postings IMS declined to queue while it was held. That count includes an attempt that was already queued when the posting was taken: taking it cancels that attempt, and the decline is logged as `accounting_posting_refusal_clear_declined_hand_post_claim`. If the count could not be written the row says "at least one, NOT COUNTED" and its history is incomplete: compare the document with the ledger. Check Sync > Exceptions afterwards to see whether this row closed or a new one appeared. Anything held far longer than a hand posting takes is flagged: a prompt to ask the holder or release it.

  **Finding a claim.** The longest-held claims are listed separately at the top, each with its own Release. Below them is the rest of the list, and **Show more claims** pages through it. The page does not tell you when you have seen every claim, because claims are taken and given back while you read. To reach a specific posting, SEARCH for its document: the **Find** box searches the reference id (an order or PO number), the reference type, the posting type and the refusal id. It does not search the holder's name, so an empty result is not evidence that nobody holds the posting. Anybody with sync access may release anybody's claim.

  **If the document is saved again while you hold the claim.** IMS declines to queue that posting, including a later version of the same document (an invoice update, a bill update, a bill payment). Each decline is counted on the row and shown in the claims section as *postponed behind it*. When you press *Mark as handled* after that, the page tells you whether the row is still outstanding. Check whether the current version is already in the accounting system. If it is, take a fresh claim and mark the outstanding refusal handled. If it is absent, EITHER take a fresh claim first (the claim is what stops IMS queueing it while you post), check the ledger again under that claim, and only then post the current version by hand, OR - holding NO claim, because a save is declined while a claim is held - re-save the document. Check Sync > Exceptions afterwards to see whether this row closed or a new one appeared.

  **An earlier version of the same document.** For the postings where successive versions share one entry (an invoice update, a bill update, a bill payment) the ledger may already hold the previous version. IMS names that document on the row and does not stop you taking the posting. Whatever its standing, the earlier document is not the current version: check the ledger for the CURRENT version (the table above).

  **Refusals recorded after a mark.** A refusal of a posting that was marked handled is logged (`accounting_posting_refused_after_handled_by_hand`) or listed, depending on the posting type. A refusal that arrives while the posting is being queued is logged (`accounting_posting_refused_after_queued`) and not listed, because the posting is in the accounting sync log. A refusal raised from inside a piece of work that is not allowed to wait for the posting's lock is held with that work, and the next **accounting sync** run settles it under the lock (`accounting_posting_refusal_not_recorded_contended`). When IMS is unable to tell whether a posting beat a refusal it lists the refusal: look at the sync log entry and settle it there; *Take for hand posting* is refused while IMS may already have posted.

  **Unconfirmed rows.** A held refusal that the accounting sync run has not settled within about 15 minutes is listed marked **Unconfirmed — not yet known to be owed**. An unconfirmed row offers no *Take for hand posting* action and **must not be posted by hand**: the posting may still belong to the job that held the lock. The usual cause is that `/api/cron/accounting-sync` is not running: check that first. A claim the run keeps failing to settle is moved to the **integration outbox failures** section.
<!-- hand-post-settlement:end -->
* **If IMS cannot tell whether a posting was marked handled, it does not post it.** The check runs before
  every accounting entry is queued. When the check itself cannot be made — the database is unreachable, the
  query times out, the transaction is cancelled — IMS refuses the enqueue rather than reading "cannot tell"
  as "nothing was marked": **nothing is written**, the whole operation that would have queued it is rolled
  back and retried (by a sweep, the outbox, or by you re-running it), and an **ERROR**
  (`accounting_posting_suppression_unreadable`) names the posting and the cause. An unreadable state is
  never permission to post.
* **One row per posting**, and a posting means the thing that is owed rather than the document it belongs
  to: a customer payment is one **receipt** against one invoice, a stock receipt is one delivery against a
  purchase order, a landed-cost journal is one recalculation, a bill update is one **bill** (a purchase
  order can hold several), and an allocation reversal is one trim of an order's allocations. A sweep that
  refuses the same work every few minutes updates that row and counts the attempts rather than filling the
  page.

This is what makes the WooCommerce **held invoice release** safe to leave to the sweep: it can refuse for
days with nobody watching, and the debt is on the exceptions page the whole time.

### Postings that were not queued are now reported where they happen

Every place in IMS that queues an accounting posting now reads the answer. When a posting is refused or
cannot be queued, the IMS action still completes where that is the right thing to do (a stock receipt is
still received, a bill is still recorded), but the posting is listed as outstanding on **Sync →
Exceptions** (above) and an **ERROR** is written to the activity log naming what
stands in IMS, what the ledger is missing, and what to do — for example `stock_receipt_journal_not_queued`,
`purchase_invoice_not_queued`, `supplier_return_journal_not_queued`,
`landed_cost_reclass_not_queued`, `landed_cost_cogs_journal_not_queued`, `manufacturing_journal_not_queued`,
`manufacturing_reclass_not_queued`, `purchase_fx_variance_not_queued`, `inventory_adjustment_journal_not_queued`, `sales_invoice_not_queued`,
`realised_fx_journal_not_queued` and `tax_rate_sync_not_queued`. Where marking something done would be
untrue without the posting, it is rolled back instead: a bill is not marked paid, a supplier credit note
stays draft.

Two consequences worth knowing:

* **Landed-cost changes on already-journaled shipments.** If the COGS reversal for a shipment cannot be
  queued, IMS no longer records it in the COGS subledger and no longer removes that amount from the
  retrospective landed-cost COGS journal — so the adjustment still reaches the ledger through that
  journal instead of disappearing from both.
* **The landed-cost journal backstop.** When a landed-cost recalculation's journals cannot be queued, its
  background retry job is kept retrying (and fails visibly once its attempts are spent) instead of being
  marked done.
* **Unrealised FX revaluation.** Retired: the run queues nothing, so it has nothing to refuse (see
  *Unrealised FX (period revaluation) — retired*).

### Rows stranded on a connector you switched away from

Because the sync log is scoped to the active connector, unresolved rows left behind on a connector that has since been turned off appear in **no** sync log. They are listed instead in the amber banner at the top of **Integrations**, which shows each row's connector, type, reference, status, age in days, and last error — plus the external transaction ID if the row already posted something before it stalled.

Each row also shows the **attempt** it is on, and carries the same per-row **Settle** control described
above — which is the point of the list: an aggregate count is not something anyone can act on.

**Rows here can be settled even at attempt 0.** Every row that predates the attempt fence sits at
attempt 0, and a row on a retired connector will stay there for ever, because the thing that stamps an
attempt is a worker claiming the row and no worker will ever claim this one. Rather than refuse those
rows permanently — which would be every row on this page — settling one **mints** the attempt, and the
dialog says so. It is safe here for exactly one reason: nothing can ever claim these rows, so the
attempt in front of you is the only one the row can ever have had. If anything does move the row
before you record your decision (another operator, or a sweep retiring it), the settlement is refused
and names what moved.

These rows still block their sales order from being deleted. To clear one you have three routes:
re-enable the connector it was queued for (Pending rows then resume on the next cron run); look the
document up in that accounting system using the reference and external ID shown and then **Settle**
the row with what you found; or, for Pending and Processing rows only, bulk-cancel them from the same
banner. Bulk-cancelling discards the queued row and does not stop the document syncing to the active
connector later. Settling is the route to use when the connector can never be re-enabled — the usual
reason a connector is retired is that its credentials or tenant are gone.

**If a cancel reports an error, read which kind it is.** There are two, and they mean different things:

- A stated refusal — for example "The active accounting connector changed while this ran, so nothing was cancelled" — is a guarantee. Nothing was discarded, the reason is recorded in the activity log, and it is safe to reload and try again.
- "The cancel request failed before it could report its outcome, so it is NOT known whether any rows were cancelled" means exactly that. The request may have been refused, or it may have completed and lost its reply on the way back. The banner reloads the stranded rows from the server when this happens: check that list, and the activity log, before pressing the button again — do not assume the attempt did nothing.

Cancelling cannot be caught out by a connector switch happening at the same moment. The plugin selection is locked for the duration of the cancel, so a switch either lands entirely before it or entirely after it; if one somehow does land in between, the whole cancel is rolled back and reported rather than half-applied.

**The list shows the oldest 50 rows only.** When there are more, it says so explicitly — "Showing the oldest 50 of 137 stranded row(s) — 87 more are not listed here." The hidden rows stay hidden until the listed ones are resolved. Most can now be cleared from this page with **Settle**, but not all of them: a daily-batch row and a Pending row no sweep reaches are not clearable from here at all, so a run of those at the front of the list will still keep newer rows out of view. Resolve the oldest ones (settle them, re-enable their connector, or cancel the Pending/Processing ones) and the next set appears on reload. When the list is complete it says "Showing all N stranded row(s)" instead, so a count on this banner is never ambiguous about what it excludes.

If the list itself cannot be loaded, the banner says so in red — "The list of stranded sync rows could not be loaded" — rather than showing nothing. An empty banner section always means there is nothing stranded; it never means the lookup failed.

The banner does not depend on the rest of the page loading. If the integration settings and sync history below it cannot be read, they are replaced by a notice saying so and the banners above still render. This matters because the usual reason the stranded list fails — the database being unreachable — is the same reason those panels fail, and that is precisely when you need the banner. As with the banner, an unavailable panel says so: it is never rendered as "nothing is configured" or "nothing has synced".

The list requires the **sync** permission (Admin and Manager). Roles without it do not see this section — the whole **Integrations** page requires it. Opening `/sync` directly (a bookmark, a pasted link) as a role without **sync** shows a short "You don't have access to Integrations" page naming the missing permission, with a link back to the dashboard: it is not an error, and signing in again or retrying will not change it. Nothing on the page is read for such a role, so no integration setting, log or stranded row is fetched at all.

**Turning every integration off does not hide these rows.** Integrations normally redirects to the plugin settings when no connector is enabled, but if you hold **sync** and unresolved accounting rows exist, the page still opens and shows this banner — switching the last accounting connector off is precisely what strands every unresolved row, so that is the state where the list matters most.
## Xero Daily Batch Retry Semantics

The daily batch intentionally processes A1 revenue deferral, A2 inventory allocation, and Group B shipment recognition in separate database transactions. A crash can therefore leave a partially advanced day, but each group is idempotent:

- A1 selects orders with `revenueDeferredDate = null` and writes `DAILY_BATCH_REVENUE_DEFERRAL` plus per-order deferral markers in one transaction.
- A2 selects orders with revenue deferred but `inventoryAllocatedDate = null`, snapshots allocation FIFO layers, writes `DAILY_BATCH_INVENTORY_ALLOC`, and marks allocation state in one transaction. It skips units whose shipment was already costed before payment (`cogsRelievedFromInventoryAt`).
- Group B selects shipped shipments with `shipmentJournalDate = null` after A1/A2 are staged, writes `DAILY_BATCH_GROUP_B`, and marks shipment recognition in one transaction. It also selects shipments of an invoiced order that has no deferral yet and journals them DR COGS / CR Inventory, setting `cogsRelievedFromInventoryAt` in the same statement as `shipmentJournalDate`, so a rerun cannot cost them twice.

Retry behavior is marker-driven. If the process stops after A1, the next run skips A1-marked orders and continues with A2. If it stops after A2, the next run continues with Group B. If Group B partially fails, unmarked shipments remain eligible for the next run. Do not manually clear these dates unless finance has also reversed any exported journals.

**The daily batch refuses a negative cost, by name, instead of posting it short.** A cost layer's
unit cost used to be able to go below zero when a landed-cost recalculation spread a credit freight
cost line larger than the goods it was spread over, rewriting the cost recorded on allocations and
shipments that already used that layer. Landed cost can no longer do that to a purchase order's own
layers: a unit is valued at zero instead of below it (see *Recalculation after receipt* in the purchasing guide;
manufactured goods built from such a layer are not floored). The daily batch keeps
its three checks as defence in depth against any other source of a negative cost, because posting one
short is the defect they exist to prevent:

- **Group A2** — an order whose allocated or dispatched units would be reclassified at a negative
  cost is not reclassified. The other orders in the batch are reclassified as normal, and the
  journal is built from them alone. Note that **one negative cost layer can hold back several
  orders that would take stock from it**: A2 rebuilds its cost layers from the database on every
  pass and every run (a refusal does not reduce what a layer holds), so whether a given order is
  refused depends on its position in the queue and on the daily batch limit
  (`XERO_DAILY_BATCH_LIMIT`), not simply on the cost being corrected. Refused orders do not hold up
  the orders queued behind them: the batch looks past them in the same run, up to a cap of 5,000
  refused orders per run, and the rest wait for the next run.
- **Group B** — an order whose shipment would be journaled at a negative cost is not journaled. Its shipments no longer crowd out the others: when a pass leaves shipments unjournaled and more are waiting, the run makes another pass that skips them (same 5,000 cap), so healthy shipments behind a block of refused ones still post.
- **Rebuilding a lost Group B journal** — only when a Group B journal is genuinely **missing**
  (never for one that is already posted or queued): a batch holding a shipment whose total COGS was
  revalued below zero is not rebuilt. This check sees each shipment's total, not the cost of each
  unit in it.

For Group A2 and Group B nothing about the refused order is stamped, so it stays queued: correct the
cost basis that went negative (the activity log entry names the cost layer) and the next batch
reclassifies the order, then posts its COGS — the Allocated Inventory debit and credit come out
equal. For a refused **rebuild** the
shipments are already stamped from the original run; correcting the cost basis revalues their COGS
back above zero, and the next batch's rebuild sweep then recreates the missing journal. Nothing
needs clearing by hand in either case. Before this, Group A2 debited Allocated Inventory short,
Group B journaled revenue with no COGS, and the rebuild posted revenue only, all without an error.

**How you find out.** Each refusal writes an **ERROR** entry in the activity log against the sales
order (or, for a rebuild, against the batch reference), naming the shipment and the cost layer, and
it is listed first in the daily batch run's errors, which marks that cron run failed. A failed cron
run shows on System Health as a warning, not an alert, so the activity log is the place to look.

**A shipment that was *already* journaled is protected earlier, at the revaluation itself.**
Revaluing it below zero used to post the reversal of its old COGS and drop the negative repost, so
the difference posted nowhere. The revaluation refuses and changes nothing if it is ever asked to
(see *Recalculation after receipt* in the purchasing guide). A landed-cost recalculation cannot ask
any more for a purchase order's own layers, because it floors each unit cost at zero, so a freight credit that exceeds the goods
cost revalues the shipment down to 0.00 (the reversal leg only) and reports the part of the credit it
could not absorb as a warning. The refusal stays as the backstop (o3d-c08y).

**The checks above read each shipment's cost *after* locking it, so a recalculation running at the
same time cannot slip a stale value past them.** A landed-cost recalculation may change a shipment's
recorded cost at any moment, including while a batch run is in progress. The batch used to read the
whole window first and take its cost-layer locks afterwards, so a run that waited for a recalculation
to finish then carried on with the figures it had read *before* the wait: it journalled the old,
positive cost, and the negative one it should have refused was never seen. The batch now reads only
the list of shipments first, locks their cost layers, and then reads the costs — so a recalculation
either finished before the lock (the batch sees its result and refuses the order) or waits for the
batch (and then meets the already-journaled refusal above). Nothing needs configuring (o3d-c08y).

**What this does not cover.** Other places a negative cost can reach are catalogued in
`docs/todo/negative-basis-cost-layers-decision.md`. Whether IMS should ever post a negative cost
basis at all is an open decision (o3d-gd2f). The three checks above are Xero's, and Xero is the only
accounting connector this build ships.

### Which batch a row belongs to

Each staged row also records the exact journal reference it went into, alongside its marker date: `revenueDeferredBatchRef` (A1) and `inventoryAllocatedBatchRef` (A2) on the order, `shipmentJournalBatchRef` (Group B) on the shipment. That is what the order delete guard, the recreate sweep, the accounting invariants and reconciliation match on.

This matters because the batch date is fixed when the run starts, while the marker dates are written as each row is processed. A long or late-evening run that crosses UTC midnight therefore stamps rows with the *next* day while the journal is keyed on the previous one. Reading the batch back from the marker date alone finds nothing in that case — which previously let an order be deleted while its value sat in a posted journal.

Rows staged before this was introduced have no reference recorded, and are still matched on their marker date. Nothing needs to be backfilled; both paths are supported indefinitely.
