# Encryption key migration

IMS encrypts sensitive connector settings with AES-256-GCM. Production installs must use keys that are exactly 32 raw bytes or base64 strings that decode to exactly 32 bytes.

Older builds accepted arbitrary `ENCRYPTION_KEY` / `SETTINGS_ENCRYPTION_KEY` strings by hashing them with SHA-256. That fallback is intentionally removed because ad-hoc strings have no reliable entropy guarantee. If an install ever encrypted values with an ad-hoc string, those ciphertexts must be migrated before deploying a build that rejects the fallback.

## New installs

Generate one 32-byte base64 key and use it for `SETTINGS_ENCRYPTION_KEY`:

```bash
openssl rand -base64 32
```

Set `ENCRYPTION_KEY` only when migrating legacy ciphertexts. New installs should leave it empty.

## Existing installs using a valid 32-byte key

No migration is required when the configured key is already either:

- 32 raw UTF-8 bytes.
- Base64 that decodes to exactly 32 bytes.

Run production preflight before deploy to verify the key shape.

## Existing installs using an ad-hoc legacy key

Use this sequence before deploying the strict key-shape build:

1. Generate a new 32-byte base64 key with `openssl rand -base64 32`.
2. Keep the legacy ad-hoc key available only in the old deployment while migrating.
3. Re-encrypt each stored secret by decrypting it with the legacy SHA-256-derived key and writing it back with the new `SETTINGS_ENCRYPTION_KEY`.
4. Deploy the strict build with `SETTINGS_ENCRYPTION_KEY` set to the new 32-byte base64 key.
5. Remove the legacy `ENCRYPTION_KEY` after migration is complete.

Lazy rewrite-on-read is not sufficient after the strict build is deployed: the new resolver rejects the legacy ad-hoc key before it can decrypt old ciphertexts.

## Verification

After migration:

- Production preflight reports `settings-encryption-key` as pass.
- Connector settings pages can load existing encrypted credentials.
- OAuth refresh / webhook / sync jobs that depend on encrypted settings can read their credentials.
- No deployment environment contains the old ad-hoc key.
