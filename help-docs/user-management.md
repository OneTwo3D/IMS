# User Management & Security

## Your Profile

Visit **Profile** from the user menu in the top-right corner (or navigate to `/profile`) to manage your account. The page has **Profile Details** (photo, name, email, role) and **Security** (password, two-factor authentication and passkeys).

### Avatar

Use **Upload Photo** (or **Change Photo**; **Remove** takes it away) to personalise your account. Supported formats:

- JPEG, PNG, WebP, GIF
- Maximum file size: 2 MB

Your avatar updates instantly in the top bar after uploading.

### Name & Email

Edit your display name and email address directly on the profile page. Changes take effect immediately, with two rules for the email address, which is also your sign-in:

- Changing it needs a **recent sign-in**. If you have been signed in for a while you are told "Please sign in again to change your email address"; sign in again and retry.
- A **Supplier** login cannot change its own email. Ask the buyer who issued the login to change it for you.

Changing your email address too many times in a short period is refused for a while.

### Role

Your role is displayed on the profile page but cannot be changed by you — only an administrator can assign roles. See [Roles and what each can do](#roles-and-what-each-can-do) below.

### Join Date

The date your account was created is shown under your name on your profile (**Joined ...**) for reference.


## Changing Your Password

Click **Change Password** on your profile page to open the password dialog. You will need to provide:

- Your current password
- A new password that meets the password policy:
  - **Minimum 12 characters**
  - At least one **uppercase letter**
  - At least one **lowercase letter**
  - At least one **number**
  - At least one **symbol** (anything non-alphanumeric)
  - Not in the system's deny-list of common weak passwords (e.g. `password123`, `Welcome2024!`)
- Confirmation of the new password

If your new password fails any rule, the form returns a specific message indicating which rule was violated. The policy is enforced consistently wherever a password is created or changed. Changing your password signs your sign-ins out, so expect to sign in again on your devices.


## Forgotten Password

On the login page, click **Forgot password?** (next to the password box), enter your email address and click **Send reset link**.

- The page always says "If an account exists for that email, a password reset link is on its way", whether or not the address is registered, so it cannot be used to find out who has an account. Only an active account is sent a link.
- The email carries a **Reset password** button. The link **expires in 60 minutes and works once**. Requests are rate limited, so repeated requests in a short time stop sending emails for a while.
- The link opens a page where you type the **New password** twice (**Confirm new password**) under the same password policy. On success you are told "Your password has been updated" and can go to sign in. All your existing sign-ins on other devices are ended.
- "This reset link is invalid or has expired. Request a new one." means the link was already used, is older than 60 minutes, or was copied incompletely. Use **Request a new link**.
- No email arriving usually means outbound email is not working (see Settings > Company > Email and use **Test SMTP**), or the address is not the one on your account. An administrator can also set a new password for you from **Settings > Users**.
- Resetting a password does not turn off two-factor authentication; you still need your authenticator code to sign in.


## Confirming It's You (Re-authentication)

Sensitive actions ask you to prove it is you again, even though you are already signed in. A **Confirm it's you** box appears and asks for your **Password** (and your **Authenticator code** if you use two-factor authentication); click **Confirm** to carry on with the action, or **Cancel** to stop. You see it when you, for example:

- create, change or delete a user (Settings > Users)
- create, restore or delete a backup
- save or test connector credentials, or run an integration action that cannot be undone (replaying work from the sync exceptions inbox, settling a ledger row, retrying failed accounting rows)
- reset the database
- change your own sign-in email

Once you have confirmed, you are not asked again for a short time (15 minutes by default). If the password is wrong, the box says "Re-authentication failed." and the action is not carried out.


## Confirmation Dialogs

Risky or irreversible actions open a confirmation dialog instead of acting at once. It names what will happen and has a **Cancel** button next to the action button, which is coloured red for destructive actions. Depending on the action the dialog also asks for one or both of:

- **Type the name to confirm** — for example the backup file name before **Delete backup**, or the word the screen shows before a restore. The action button stays disabled until you type it exactly.
- **A tick box** — for example "I have checked Xero and none of these documents already exist there" before **Retry all failed rows**. The button stays disabled until it is ticked.

While the action is running the dialog cannot be dismissed. If the action fails, the reason is shown in the dialog. A failure does not always mean nothing happened: actions that write to another system item by item (for example generating missing tax rates in Xero) keep the items that were created before the failure. Read the per-item result the action shows, and check the other system (for example Xero) before you retry.


## Two-Factor Authentication (TOTP)

Add an extra layer of security by enabling time-based one-time passwords (TOTP).

### Setting Up

1. On your profile page, under **Security**, click **Enable 2FA**
2. Scan the QR code with your authenticator app (Google Authenticator, Authy, 1Password, or any TOTP-compatible app)
3. Enter the six-digit code from your app to confirm setup

### Signing In with TOTP

When two-factor authentication is enabled, you will be prompted for a code from your authenticator app after entering your email and password.

### Turning it off, or losing your authenticator

You can turn it off yourself: click **Disable 2FA** on your profile and enter a current code from the app. There is no button for an administrator to turn it off for someone else on **Settings > Users** (the **2FA** column there only shows whether it is on). If you lost your device and cannot produce a code, ask your system administrator to reset your two-factor setting.


## Passkeys (WebAuthn)

Passkeys let you sign in using biometrics, security keys, or other platform authenticators — no password required.

### Registering a Passkey

1. On your profile page, scroll to the **Passkeys** section
2. Click **Add Passkey**
3. Follow your browser or device prompts to create the passkey (fingerprint, face recognition, hardware key, etc.)

### Signing In with a Passkey

On the login page, click **Sign in with Passkey** instead of entering your email and password. Your browser will prompt you to use your registered passkey.

Passkey authentication is considered strong authentication, so TOTP is not required when signing in with a passkey.

### Managing Passkeys

From your profile page you can:

- **Rename** a passkey (the pencil icon) to help identify it (e.g. "MacBook Touch ID", "YubiKey")
- **Delete** a passkey you no longer use (the bin icon)


## Login Page

The login page provides two ways to sign in:

- **Email and password** — the standard login form, followed by a TOTP prompt if two-factor authentication is enabled. **Forgot password?** is next to the password box (see [Forgotten Password](#forgotten-password)).
- **Sign in with Passkey** — a single button that triggers your browser's passkey flow

Repeated failed sign-ins for the same email from the same address are blocked for 15 minutes; wait and try again. If your session ended (you were signed out by an administrator's change, or it expired) the login page says so above the form. Some installations also show a bot check on the form.


## User Administration (Settings > Users)

Administrators can manage all user accounts from **Settings > Users**:

The list shows each user's name, email, role, linked supplier, status (Active or Inactive), whether **2FA** is on and the last login.

- **Add User** — add a new user with name, email, password (under the password policy) and role. A **Supplier** user is linked to a supplier company.
- **Edit** (pencil icon) — change the name, email, a **New Password** (leave blank to keep the current one), the role, the **Linked Supplier**, or untick **Active** to deactivate the account (the person can no longer sign in, but their history stays).
- **Delete** (bin icon) — remove the account. The dialog asks what to do with the sales orders the user owns: **keep the name as plain text** on them, or **reassign them to another active user**. This cannot be undone.

Safeguards: you cannot change your own role away from Administrator, deactivate yourself or delete yourself, and at least one active Administrator must always remain. Changing a user's role, email, active status, linked supplier or password signs that user out everywhere, so they sign in again with the new access. The role list under the table (**Role Permissions**) summarises what each role is for. Creating, changing and deleting users asks you to confirm it is you (see above), and each change is recorded in the Activity log under the `auth` tag. Role assignment is validated on both client and server to prevent privilege escalation.


## Roles and what each can do

| Role | Sidebar sections it sees | Notable limits |
|---|---|---|
| **Administrator** | Everything, including Integrations, Activity and all Settings pages | None |
| **Manager** | Dashboard, Inventory (including HS Code Review), Stock Control, Purchases, Sales, Analytics, Manufacturing, Integrations, Activity | No Settings and no user management |
| **Warehouse** | Dashboard, Inventory (can edit products and use HS Code Review; no cost prices), Stock Control (adjustments and transfers), Purchases (receive goods; cannot create orders or record supplier invoices), Sales (process and ship; cannot create orders or refund), Manufacturing, inventory-ledger reports | No Integrations, no Activity, no Settings, no other Analytics |
| **Finance** | Dashboard, Inventory (read, with prices), Purchases (create, supplier invoices), Sales (read, refunds), Analytics | No Stock Control, no Manufacturing, no Integrations, no Activity, no Settings; cannot create or process sales orders |
| **Read Only** | Dashboard, Inventory, Purchases, Sales, Analytics (all view-only) | Cannot change anything; some purchasing and cost reports are not shown to this role |
| **Supplier** | Their own portal only (see below) | No access to the internal system |

The **Role Permissions** panel on Settings > Users shows a one-line summary of each role. Refunds, and seeing cost prices, are limited to the Administrator, Manager and Finance roles; Warehouse and Read Only users do not see cost prices.

## Permission System

The system includes a role-based access control (RBAC) layer. Permissions control:

- **Sidebar filtering** — each role sees only the navigation items relevant to their access level
- **Server action authorisation** — every server action verifies the caller's permission before executing. A server action is a directly callable HTTP endpoint, so this is the boundary; hiding a menu item or gating a page is not
- **Internal vs external principals** — every role except **Supplier** holds the `internal` permission. Supplier is an *external* party, so the reads that any signed-in staff member may perform (products, customers, sales and purchase orders, stock, warehouses, the user list) require `internal` and refuse a supplier session outright
- **API route protection** — cron endpoints require the `CRON_SECRET` bearer header in production


## Supplier Portal

Users with the **Supplier** role access a dedicated portal with its own navigation:

- **RFQs** — view requests for quotation that the buyer has sent (never drafts) and submit quotes (with prices, quantities, PO number, delivery date, and shipping details). After you submit, the RFQ opens read-only with a "Quote submitted" confirmation.
- **Purchase Orders** — view purchase orders addressed to their supplier company (drafts and orders cancelled before they were sent are hidden)
- **My Products** — view products linked to their supplier (without financial data such as prices, margins, or COGS)

Supplier users are linked to a supplier company record. Signing in takes them straight to the portal (RFQs). They cannot access prices, margins, COGS data, or analytics.

Two separate controls keep a supplier inside its own data, and they are not substitutes for one another:

- **Outside the portal**, a supplier is refused entirely. The internal purchasing, sales, inventory and settings endpoints require a permission no supplier holds, so a supplier session cannot read another company's orders even by calling the endpoint directly.
- **Inside the portal**, a permission proves nothing — every supplier holds the same supplier-portal permissions. Each query is therefore filtered by the signed-in user's own supplier id, and any record fetched by id is re-checked for ownership before it is returned. Asking for another supplier's RFQ by id returns nothing, and neither does asking for a purchase order that has not been sent yet.


## Sessions

- Sessions are JWT-based and last for 30 days
- An administrator changing your role, email, active status or password, you changing your password, or a password reset, ends your existing sign-ins everywhere and you are asked to sign in again
- The top bar displays your avatar and name throughout your session
- Signing out clears your session immediately
