import { timingSafeEqual } from 'node:crypto';
import { ImapFlow } from 'imapflow';

const host = process.env.IMAP_HOST ?? 'imap.skymail.net.br';
const port = Number(process.env.IMAP_PORT ?? '993');
const token = process.env.IMAP_AUTH_CHECK_TOKEN ?? '';

function response(ok, status) {
  return Response.json({ ok }, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function hasValidToken(request) {
  const authorization = request.headers.get('authorization') ?? '';
  const supplied = authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : '';

  if (!token || !supplied) return false;

  const expectedBytes = Buffer.from(token);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length
    && timingSafeEqual(expectedBytes, suppliedBytes);
}

export default async (request) => {
  if (request.method !== 'GET') return response(false, 405);
  if (!hasValidToken(request)) return response(false, 401);

  const username = process.env.IMAP_USERNAME;
  const password = process.env.IMAP_PASSWORD;
  if (!username || !password || !Number.isInteger(port) || port < 1 || port > 65535) {
    return response(false, 500);
  }

  const client = new ImapFlow({
    host,
    port,
    secure: true,
    auth: { user: username, pass: password },
    socketTimeout: 7000,
    authTimeout: 7000,
    logger: false,
  });

  try {
    await client.connect();
    await client.mailboxOpen('INBOX', { readOnly: true });
    return response(true, 200);
  } catch {
    return response(false, 502);
  } finally {
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }
};
