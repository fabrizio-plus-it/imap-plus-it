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
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_FILTER_LENGTH = 200;

function parseRoute(request) {
  const pathname = new URL(request.url).pathname;
  const match = pathname.match(/(?:^|\/)emails(?:\/([^/]+))?\/?$/);
  return match ? (match[1] ? decodeURIComponent(match[1]) : null) : undefined;
}

function parseAttachmentRoute(request) {
  const pathname = new URL(request.url).pathname;
  const match = pathname.match(/(?:^|\/)emails\/([^/]+)\/attachments\/([^/]+)\/?$/);
  if (!match) return null;
  return {
    messageId: decodeURIComponent(match[1]),
    attachmentId: decodeURIComponent(match[2]),
  };
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

function effectiveSearchQuery(query) {
  if (!query.before) return query;

  // ImapFlow uses the server's WITHIN extension when available. A future
  // BEFORE date becomes "older than 0 seconds" there, which incorrectly
  // matches nothing. A future upper bound does not restrict today's mailbox,
  // so omit it from the IMAP search.
  const today = new Date().toISOString().slice(0, 10);
  if (query.before > today) {
    const { before, ...withoutFutureBefore } = query;
    return withoutFutureBefore;
  }

  return query;
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

function collectMimeParts(node, path = '1', result = { text: [], attachments: [] }) {
  if (!node) return result;

  const type = String(node.type ?? '').toLowerCase();
  const disposition = String(node.disposition ?? '').toLowerCase();
  const part = node.part ?? path;
  const filename = node.dispositionParameters?.filename ?? node.parameters?.name ?? null;

  if (type === 'text/plain' || type === 'text/html') {
    if (disposition !== 'attachment') result.text.push({ part, type });
  } else if (disposition === 'attachment' || filename) {
    result.attachments.push({
      id: part,
      filename: filename || `attachment-${part}`,
      contentType: type || 'application/octet-stream',
      size: Number.isFinite(node.size) ? node.size : null,
    });
  }

  if (node.childNodes?.length) {
    node.childNodes.forEach((child, index) => collectMimeParts(child, `${path}.${index + 1}`, result));
  }

  return result;
}

async function downloadPartText(client, uid, part) {
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

  return { text: Buffer.concat(chunks).toString('utf8'), truncated: size >= MAX_BODY_BYTES };
}

function htmlToText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function readTextBody(client, uid, bodyStructure) {
  const parts = collectMimeParts(bodyStructure).text;
  for (const part of parts.sort((a, b) => (a.type === 'text/plain' ? -1 : 1) - (b.type === 'text/plain' ? -1 : 1))) {
    const downloaded = await downloadPartText(client, uid, part);
    const body = part.type === 'text/html' ? htmlToText(downloaded.text) : downloaded.text;
    if (body.trim()) {
      return { body, contentType: part.type, truncated: downloaded.truncated };
    }
  }

  return { body: '', contentType: parts[0]?.type ?? null, truncated: false };
}

async function listEmails(client, url) {
  const filters = parseFilters(url);
  if (filters.error) return jsonResponse({ error: filters.error }, 400);

  const mailbox = await client.mailboxOpen('INBOX', { readOnly: true });
  const uidValidity = uidValidityString(mailbox);
  if (!uidValidity) return jsonResponse({ error: 'mailbox UIDVALIDITY unavailable' }, 502);

  const foundUids = await client.search(effectiveSearchQuery(filters.query), { uid: true });
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
  const attachments = collectMimeParts(message.bodyStructure).attachments;
  const envelope = message.envelope ?? {};
  return jsonResponse({
    ...messageMetadata(message, uidValidity),
    to: formatAddresses(envelope.to),
    cc: formatAddresses(envelope.cc),
    body: body.body,
    contentType: body.contentType,
    bodyTruncated: body.truncated,
    attachments,
  });
}

async function downloadAttachment(client, route) {
  const requested = parseMessageId(route.messageId);
  if (!requested || !/^\d+(?:\.\d+)*$/.test(route.attachmentId)) {
    return jsonResponse({ error: 'attachment id is invalid or obsolete' }, 404);
  }

  const mailbox = await client.mailboxOpen('INBOX', { readOnly: true });
  const uidValidity = uidValidityString(mailbox);
  if (!uidValidity || uidValidity !== requested.uidValidity) {
    return jsonResponse({ error: 'message id is invalid or obsolete' }, 404);
  }

  const message = await client.fetchOne(requested.uid, {
    uid: true,
    bodyStructure: true,
  }, { uid: true });
  if (!message || message.uid !== requested.uid) {
    return jsonResponse({ error: 'message not found' }, 404);
  }

  const attachment = collectMimeParts(message.bodyStructure).attachments
    .find(item => item.id === route.attachmentId);
  if (!attachment) {
    return jsonResponse({ error: 'attachment not found' }, 404);
  }

  const download = await client.download(requested.uid, attachment.id, {
    uid: true,
    maxBytes: MAX_ATTACHMENT_BYTES + 1,
  });
  const chunks = [];
  let size = 0;
  for await (const chunk of download.content) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_ATTACHMENT_BYTES) {
      return jsonResponse({ error: 'attachment exceeds the 25 MiB limit' }, 413);
    }
    chunks.push(buffer);
  }

  const safeFilename = attachment.filename.replace(/[\r\n"]/g, '_') || 'attachment';
  return new Response(Buffer.concat(chunks), {
    status: 200,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': attachment.contentType,
      'Content-Length': String(size),
      'Content-Disposition': `attachment; filename="${safeFilename}"`,
    },
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
    const attachmentRoute = parseAttachmentRoute(request);
    if (attachmentRoute) return await downloadAttachment(client, attachmentRoute);
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
