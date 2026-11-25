import {
  closeImapClient,
  createImapClient,
  getImapConfig,
  hasValidToken,
  jsonResponse,
} from '../lib/imap.mjs';

export default async (request) => {
  if (request.method !== 'GET') return jsonResponse({ ok: false }, 405);
  if (!hasValidToken(request)) return jsonResponse({ ok: false }, 401);

  const client = createImapClient(getImapConfig());
  if (!client) return jsonResponse({ ok: false }, 500);

  try {
    await client.connect();
    await client.mailboxOpen('INBOX', { readOnly: true });
    return jsonResponse({ ok: true });
  } catch {
    return jsonResponse({ ok: false }, 502);
  } finally {
    await closeImapClient(client);
  }
};
