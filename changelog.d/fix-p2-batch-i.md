### Settings secrets hardened (settings / security)

- **Fixed: `getSetting` returned decrypted credentials to an admin without step-up.** A sensitive setting is now returned masked (first four characters and `****`), never in clear. The screens that call it already mask again, so they look the same. A masked value posted back through the generic settings save is ignored instead of overwriting the stored credential.
- **Fixed: a masked WooCommerce webhook secret skipped the step-up gate but was still written.** The WooCommerce sync save now drops masked secrets, so the webhook secret can only be changed through the gated path.
- **Fixed: the SMTP test email (and the SMTP save) used the stored password against a server the caller supplied.** If the password field is the masked stored one and the SMTP host, port, user or security differs from what is saved, the action is refused with "Re-enter the SMTP password". Typing the password still lets you test any server.
