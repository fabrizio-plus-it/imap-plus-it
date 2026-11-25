import {
  closeImapClient,
  createImapClient,
  getImapConfig,
  hasValidToken,
  jsonResponse,
} from '../lib/imap.mjs';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_CANDIDATE_UIDS = 1000;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_FILTER_LENGTH = 200;

function parseRoute(request) {
  const pathname = new URL(request.url).pathname;
  const match = pathname.match(/(?:^|\/)emails(?:\/([^/]+))?\/?$/);
  return match ? (match[1] ? decodeURIComponent(match[1]) : null) : undefined;
}

function parseLimit(value) {
  if (value === null || value === '') return DEFAULT_LIMIT;
  if (!/^\d+$/.test(value)) return null;
  const limit = Number(value);
  return limit >= 1 && limit <= MAX_LIMIT ? limit : null;
}

function parseDate(value) {
  if (value === null) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value
    ? null
    : value;
}

function parseFilters(url) {
  const limit = parseLimit(url.searchParams.get('limit'));
  const from = url.searchParams.get('from') ?? '';
  const subject = url.searchParams.get('subject') ?? '';
  const since = parseDate(url.searchParams.get('since'));
  const before = parseDate(url.searchParams.get('before'));

  if (limit === null) return { error: 'limit must be an integer from 1 to 50' };
  if (from.length > MAX_FILTER_LENGTH || subject.length > MAX_FILTER_LENGTH) {
    return { error: 'from and subject must be at most 200 characters' };
  }
  if (since === null || before === null) {
    return { error: 'since and before must use YYYY-MM-DD' };
  }
  if (since && before && since >= before) {
    return { error: 'since must be earlier than before' };
  }

  const query = {};
  if (from) query.from = from;
  if (subject) query.subject = subject;
  if (since) query.since = since;
  if (before) query.before = before;
  if (!Object.keys(query).length) query.all = true;

  return { limit, query };
}

function uidValidityString(mailbox) {
  if (mailbox?.uidValidity === undefined || mailbox?.uidValidity === null) return null;
  return String(mailbox.uidValidity);
}

export function makeMessageId(uidValidity, uid) {
  return `v1.${uidValidity}.${uid}`;
}

export function parseMessageId(id) {
  const match = /^v1\.([0-9]+)\.([1-9][0-9]*)$/.exec(id);
  return match ? { uidValidity: match[1], uid: Number(match[2]) } : null;
}

function formatAddresses(addresses = []) {
  return addresses
    .map(({ name, address }) => name && address ? `${name} <${address}>` : address || name || '')
    .filter(Boolean)
    .join(', ');
}

function messageMetadata(message, uidValidity) {
  const envelope = message.envelope ?? {};
  return {
    id: makeMessageId(uidValidity, message.uid),
    from: formatAddresses(envelope.from),
    subject: envelope.subject ?? '',
    date: message.internalDate instanceof Date
      ? message.internalDate.toISOString()
      : message.internalDate ?? envelope.date ?? null,
  };
}

function findTextPart(node, preferredType = 'text/plain', path = '1') {
  if (!node) return null;
  if (node.childNodes?.length) {
    let fallback = null;
    for (let index = 0; index < node.childNodes.length; index += 1) {
      const found = findTextPart(node.childNodes[index], preferredType, `${path}.${index + 1}`);
      if (found?.type === preferredType) return found;
      if (found && !fallback) fallback = found;
    }
    return fallback;
  }

  const type = String(node.type ?? '').toLowerCase();
  const disposition = String(node.disposition ?? '').toLowerCase();
  if (type === preferredType && disposition !== 'attachment') {
    return { part: node.part ?? path, type };
  }
  if (type === 'text/html' && disposition !== 'attachment') {
    return { part: node.part ?? path, type };
  }
  return null;
}

async function readTextBody(client, uid, bodyStructure) {
  const part = findTextPart(bodyStructure);
  if (!part) return { body: '', contentType: null, truncated: false };

  const download = await client.download(uid, part.part, {
    uid: true,
    maxBytes: MAX_BODY_BYTES,
  });
  const chunks = [];
  let size = 0;
  for await (const chunk of download.content) {
    const remaining = MAX_BODY_BYTES - size;
    if (remaining <= 0) break;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(buffer.subarray(0, remaining));
    size += Math.min(buffer.length, remaining);
    if (buffer.length > remaining) break;
  }

  return {
    body: Buffer.concat(chunks).toString('utf8'),
    contentType: part.type,
    truncated: size >= MAX_BODY_BYTES,
  };
}

async function listEmails(client, url) {
  const filters = parseFilters(url);
  if (filters.error) return jsonResponse({ error: filters.error }, 400);

  const mailbox = await client.mailboxOpen('INBOX', { readOnly: true });
  const uidValidity = uidValidityString(mailbox);
  if (!uidValidity) return jsonResponse({ error: 'mailbox UIDVALIDITY unavailable' }, 502);

  const foundUids = await client.search(filters.query, { uid: true });
  const uids = Array.isArray(foundUids) ? foundUids.slice(-MAX_CANDIDATE_UIDS) : [];
  if (!uids.length) return jsonResponse([]);

  const messages = await client.fetchAll(uids, {
    uid: true,
    envelope: true,
    internalDate: true,
  }, { uid: true });

  messages.sort((a, b) => {
    const aTime = new Date(a.internalDate ?? 0).getTime();
    const bTime = new Date(b.internalDate ?? 0).getTime();
    return bTime - aTime || b.uid - a.uid;
  });

  return jsonResponse(messages.slice(0, filters.limit).map(message => messageMetadata(message, uidValidity)));
}

async function getEmail(client, id) {
  const requested = parseMessageId(id);
  if (!requested) return jsonResponse({ error: 'message id is invalid or obsolete' }, 404);

  const mailbox = await client.mailboxOpen('INBOX', { readOnly: true });
  const uidValidity = uidValidityString(mailbox);
  if (!uidValidity || uidValidity !== requested.uidValidity) {
    return jsonResponse({ error: 'message id is invalid or obsolete' }, 404);
  }

  const message = await client.fetchOne(requested.uid, {
    uid: true,
    envelope: true,
    internalDate: true,
    bodyStructure: true,
  }, { uid: true });
  if (!message || message.uid !== requested.uid) {
    return jsonResponse({ error: 'message not found' }, 404);
  }

  const body = await readTextBody(client, requested.uid, message.bodyStructure);
  const envelope = message.envelope ?? {};
  return jsonResponse({
    ...messageMetadata(message, uidValidity),
    to: formatAddresses(envelope.to),
    cc: formatAddresses(envelope.cc),
    body: body.body,
    contentType: body.contentType,
    bodyTruncated: body.truncated,
  });
}

export async function handleEmailsRequest(request, dependencies = {}) {
  if (request.method !== 'GET') return jsonResponse({ error: 'method not allowed' }, 405);
  if (!hasValidToken(request)) return jsonResponse({ error: 'unauthorized' }, 401);

  const clientFactory = dependencies.createClient ?? createImapClient;
  const client = clientFactory(dependencies.config ?? getImapConfig());
  if (!client) return jsonResponse({ error: 'IMAP configuration unavailable' }, 500);

  try {
    await client.connect();
    const url = new URL(request.url);
    const id = parseRoute(request);
    if (id === undefined) return jsonResponse({ error: 'invalid route' }, 404);
    return id === null ? await listEmails(client, url) : await getEmail(client, id);
  } catch {
    return jsonResponse({ error: 'IMAP operation failed' }, 502);
  } finally {
    await closeImapClient(client);
  }
}

export default handleEmailsRequest;
