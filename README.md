# imap-plus-it

Netlify functions for validating the Plus IT IMAP integration with SkyMail.

## Endpoints

- `/.netlify/functions/imap-check` checks TLS connectivity only. This existing function is intentionally unchanged.
- `/.netlify/functions/imap-auth-check` validates the HTTP token, logs in to IMAP, and opens `INBOX` read-only. It does not fetch or download messages.

The authentication endpoint returns only `{ "ok": true }` or `{ "ok": false }`. Send its separate token as:

```text
Authorization: Bearer <IMAP_AUTH_CHECK_TOKEN>
```

## Netlify variables

Set these in the existing Netlify site, for the deploy context being tested:

- `IMAP_AUTH_CHECK_TOKEN` — a long random token used only to protect the endpoint.
- `IMAP_USERNAME` — the Plus IT mailbox login.
- `IMAP_PASSWORD` — the Plus IT mailbox password.
- `IMAP_HOST` — the IMAP server hostname supplied by the mail provider.
- `IMAP_PORT` — optional; defaults to `993`.

Do not commit `.env` files or any real credentials. The repository should be created as the private repository `imap-plus-it` and linked to the existing Netlify site (site ID is kept in local Netlify state, which is ignored).

## Local checks

```powershell
npm install
npx netlify dev
```

Then call the auth endpoint with the bearer token. A successful response confirms TLS, IMAP authentication, and read-only access to `INBOX`; it does not download messages.
