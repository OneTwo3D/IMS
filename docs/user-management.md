# User Management & Security

## Your Profile

Visit **Profile** from the user menu in the top-right corner (or navigate to `/profile`) to manage your account.

### Avatar

Upload a profile picture to personalise your account. Supported formats:

- JPEG, PNG, WebP, GIF
- Maximum file size: 2 MB

Your avatar updates instantly in the top bar after uploading.

### Name & Email

Edit your display name and email address directly on the profile page. Changes take effect immediately.

### Role

Your role is displayed on the profile page but cannot be changed by you — only an administrator can assign roles.

| Role | Description |
|---|---|
| Administrator | Full access to all features and settings |
| Warehouse Manager | Inventory, stock control, purchasing, and manufacturing |
| Finance | Sales, purchasing, invoicing, and accounting integrations |
| Read Only | View-only access across all modules |

### Join Date

The date your account was created is shown on your profile for reference.


## Changing Your Password

Click **Change Password** on your profile page to open the password dialog. You will need to provide:

- Your current password
- A new password (minimum 8 characters)
- Confirmation of the new password


## Two-Factor Authentication (TOTP)

Add an extra layer of security by enabling time-based one-time passwords (TOTP).

### Setting Up

1. On your profile page, click **Enable Two-Factor Authentication**
2. Scan the QR code with your authenticator app (Google Authenticator, Authy, 1Password, or any TOTP-compatible app)
3. Enter the six-digit code from your app to confirm setup

### Signing In with TOTP

When two-factor authentication is enabled, you will be prompted for a code from your authenticator app after entering your email and password.


## Passkeys (WebAuthn)

Passkeys let you sign in using biometrics, security keys, or other platform authenticators — no password required.

### Registering a Passkey

1. On your profile page, scroll to the **Passkeys** section
2. Click **Register Passkey**
3. Follow your browser or device prompts to create the passkey (fingerprint, face recognition, hardware key, etc.)

### Signing In with a Passkey

On the login page, click **Sign in with Passkey** instead of entering your email and password. Your browser will prompt you to use your registered passkey.

Passkey authentication is considered strong authentication, so TOTP is not required when signing in with a passkey.

### Managing Passkeys

From your profile page you can:

- **Rename** a passkey to help identify it (e.g. "MacBook Touch ID", "YubiKey")
- **Delete** a passkey you no longer use


## Login Page

The login page provides two ways to sign in:

- **Email and password** — the standard login form, followed by a TOTP prompt if two-factor authentication is enabled
- **Sign in with Passkey** — a single button that triggers your browser's passkey flow


## Sessions

- Sessions are JWT-based and last for 30 days
- The top bar displays your avatar and name throughout your session
- Signing out clears your session immediately
