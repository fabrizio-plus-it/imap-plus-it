# imap-plus-it

Netlify functions for validating the Plus IT IMAP integration with SkyMail.

## Endpoints

- `/.netlify/functions/imap-check` checks TLS connectivity only. This existing function is intentionally unchanged.
- `/.netlify/functions/imap-auth-check` validates the HTTP token, logs in to IMAP, and opens `INBOX` read-only. It does not fetch or download messages.
- `/emails` searches the read-only `INBOX` by `from`, `subject`, `since`, and `before`.
- `/emails/{id}` returns metadata and a bounded text body without attachments. Message reads use `BODY.PEEK` and preserve `\\Seen`.

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

## Email API tests

The API requires the same bearer token as the diagnostic authentication endpoint. The list endpoint accepts `from`, `subject`, `since`, `before`, and `limit` (1–50). `since` is inclusive and `before` is exclusive; dates use `YYYY-MM-DD`. Results are returned newest first, and each `id` is bound to the mailbox `UIDVALIDITY`.

PowerShell examples (replace placeholders locally; do not commit real values):

```powershell
$headers = @{ Authorization = "Bearer <IMAP_AUTH_CHECK_TOKEN>" }
Invoke-RestMethod -Headers $headers `
  "https://<NETLIFY_SITE>.netlify.app/emails?from=<SENDER>&subject=<SUBJECT>&since=2026-01-01&before=2026-02-01&limit=20"

Invoke-RestMethod -Headers $headers `
  "https://<NETLIFY_SITE>.netlify.app/emails/<MESSAGE_ID_FROM_LIST>"
```

Expected errors are `400` for invalid filters, `401` for a missing/invalid token, `404` for an obsolete or missing message ID, and `502` for an IMAP operation failure. The response body is capped at 256 KiB and responses are not cached.

OpenAPI for configuring a private GPT Action is in [openapi.yaml](./openapi.yaml).
