import { timingSafeEqual } from 'node:crypto';
import { ImapFlow } from 'imapflow';

export function jsonResponse(body, status = 200) {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

export function hasValidToken(request) {
  const expected = process.env.IMAP_AUTH_CHECK_TOKEN ?? '';
  const authorization = request.headers.get('authorization') ?? '';
  const supplied = authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : '';

  if (!expected || !supplied) return false;

  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length
    && timingSafeEqual(expectedBytes, suppliedBytes);
}

export function getImapConfig() {
  const port = Number(process.env.IMAP_PORT ?? '993');
  const username = process.env.IMAP_USERNAME;
  const password = process.env.IMAP_PASSWORD;
  const host = process.env.IMAP_HOST;

  if (!host || !username || !password || !Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }

  return { host, port, username, password };
}

export function createImapClient(config = getImapConfig()) {
  if (!config) return null;

  return new ImapFlow({
    host: config.host,
    port: config.port,
    secure: true,
    auth: { user: config.username, pass: config.password },
    socketTimeout: 7000,
    authTimeout: 7000,
    logger: false,
  });
}

export async function closeImapClient(client) {
  if (!client) return;

  try {
    await client.logout();
  } catch {
    client.close();
  }
}
