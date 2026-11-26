# imap-plus-it

Netlify functions for validating the Plus IT IMAP integration with SkyMail.

## Endpoints

- `/.netlify/functions/imap-check` checks TLS connectivity only. This existing function is intentionally unchanged.
- `/.netlify/functions/imap-auth-check` validates the HTTP token, logs in to IMAP, and opens `INBOX` read-only. It does not fetch or download messages.
- `/emails` searches the read-only `INBOX` by `from`, `subject`, `since`, and `before`.
- `/emails/{id}` returns metadata, a bounded text body, and attachment metadata without downloading attachment contents. If the plain-text part is empty, the HTML part is converted to text. Message reads use `BODY.PEEK` and preserve `\\Seen`.
- `/emails/{id}/attachments/{attachmentId}` downloads one attachment by the MIME part ID listed in `attachments`, with a 25 MiB response limit.
- The local MCP server exposes `buscar_emails` and `ler_email` over stdio. `/mcp` is prepared as an authenticated stateless Streamable HTTP endpoint for deploy testing.

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

The message detail response includes `attachments` with an attachment part ID, filename, MIME type, and size. To download one, use the same bearer token and the message ID plus the MIME part ID:

```powershell
Invoke-WebRequest -Headers $headers `
  "http://localhost:8888/emails/<MESSAGE_ID>/attachments/<ATTACHMENT_PART_ID>" `
  -OutFile .\downloaded-attachment.bin
```

The route returns the original MIME type and filename and does not mark the message as read.

## MCP local client

Install dependencies and start the MCP server as a stdio process:

```powershell
npm install
npm run mcp
```

Configure a local MCP client to launch `node mcp/server.mjs` with the workspace as its working directory and these environment variables: `IMAP_HOST`, `IMAP_PORT`, `IMAP_USERNAME`, `IMAP_PASSWORD`, and `IMAP_AUTH_CHECK_TOKEN`. Keep the values in the client environment or local `.env`; do not put real values in a committed configuration file.

The official JavaScript SDK's `StdioClientTransport` intentionally inherits only a safe allowlist of environment variables. A client that spawns this server must explicitly pass the five IMAP variables in its `env` map. The server writes no protocol logs to stdout.

The MCP tools are:

- `buscar_emails`: optional `from`, `subject`, `since`, `before`, and `limit` (1–50); returns the same summaries as `GET /emails`.
- `ler_email`: receives an ID from `buscar_emails` and returns metadata plus bounded text, intentionally omitting attachments.

The `/mcp` Netlify function uses the official SDK's web-standard Streamable HTTP transport in stateless mode and checks the bearer token before creating the MCP server. It is prepared for a draft deploy test; production publication remains pending review.

OpenAPI for configuring a private GPT Action is in [openapi.yaml](./openapi.yaml).
