import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { after, before, test } from 'node:test';
import { handleEmailsRequest } from '../netlify/functions/emails.mjs';

const originalEnvironment = {
  IMAP_AUTH_CHECK_TOKEN: process.env.IMAP_AUTH_CHECK_TOKEN,
  IMAP_HOST: process.env.IMAP_HOST,
  IMAP_USERNAME: process.env.IMAP_USERNAME,
  IMAP_PASSWORD: process.env.IMAP_PASSWORD,
};

before(() => {
  process.env.IMAP_AUTH_CHECK_TOKEN = 'test-token';
  process.env.IMAP_HOST = 'test.invalid';
  process.env.IMAP_USERNAME = 'test-user';
  process.env.IMAP_PASSWORD = 'test-password';
});

after(() => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function request(path, token = 'test-token') {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  return new Request(`https://example.test${path}`, { headers });
}

class FakeClient {
  constructor() {
    this.mailboxOpenCalls = [];
    this.searchCalls = [];
    this.fetchAllCalls = [];
    this.fetchOneCalls = [];
    this.downloadCalls = [];
    this.logoutCalls = 0;
    this.closeCalls = 0;
    this.flags = new Set(['\\Seen']);
    this.bodyStructure = { type: 'text/plain', part: undefined };
  }

  async connect() {}

  async mailboxOpen(path, options) {
    this.mailboxOpenCalls.push({ path, options });
    return { uidValidity: 77n };
  }

  async search(query, options) {
    this.searchCalls.push({ query, options });
    return [11, 12];
  }

  async fetchAll(uids, query, options) {
    this.fetchAllCalls.push({ uids, query, options });
    return [
      { uid: 11, internalDate: new Date('2026-01-01T10:00:00Z'), envelope: { from: [{ address: 'old@example.test' }], subject: 'Old' } },
      { uid: 12, internalDate: new Date('2026-01-02T10:00:00Z'), envelope: { from: [{ address: 'new@example.test' }], subject: 'New' } },
    ];
  }

  async fetchOne(uid, query, options) {
    this.fetchOneCalls.push({ uid, query, options });
    return {
      uid,
      internalDate: new Date('2026-01-02T10:00:00Z'),
      flags: this.flags,
      envelope: { from: [{ address: 'new@example.test' }], to: [{ address: 'me@example.test' }], subject: 'New' },
      bodyStructure: this.bodyStructure,
    };
  }

  async download(uid, part, options) {
    this.downloadCalls.push({ uid, part, options });
    return { content: Readable.from([Buffer.from('hello from IMAP')]) };
  }

  async logout() {
    this.logoutCalls += 1;
  }

  close() {
    this.closeCalls += 1;
  }
}

test('rejects unauthorized requests before creating an IMAP client', async () => {
  let factoryCalls = 0;
  const response = await handleEmailsRequest(request('/emails', null), {
    createClient: () => {
      factoryCalls += 1;
      throw new Error('must not connect');
    },
  });

  assert.equal(response.status, 401);
  assert.equal(factoryCalls, 0);
});

test('validates filters and returns newest summaries first', async () => {
  const client = new FakeClient();
  const response = await handleEmailsRequest(
    request('/emails?from=sender%40example.test&subject=invoice&since=2026-01-01&before=2026-02-01&limit=1'),
    { createClient: () => client },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(client.searchCalls[0], {
    query: { from: 'sender@example.test', subject: 'invoice', since: '2026-01-01', before: '2026-02-01' },
    options: { uid: true },
  });
  assert.deepEqual(await response.json(), [{
    id: 'v1.77.12',
    from: 'new@example.test',
    subject: 'New',
    date: '2026-01-02T10:00:00.000Z',
  }]);
  assert.equal(client.mailboxOpenCalls[0].options.readOnly, true);
  assert.equal(client.logoutCalls, 1);
});

test('rejects invalid filter values', async () => {
  const client = new FakeClient();
  const response = await handleEmailsRequest(request('/emails?limit=51'), { createClient: () => client });
  assert.equal(response.status, 400);
  assert.equal(client.mailboxOpenCalls.length, 0);
  assert.equal(client.logoutCalls, 1);
});

test('ignores a future before date instead of returning an empty result', async () => {
  const client = new FakeClient();
  const response = await handleEmailsRequest(
    request('/emails?from=sender%40example.test&before=2099-12-31'),
    { createClient: () => client },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(client.searchCalls[0].query, { from: 'sender@example.test' });
});

test('reads a UIDVALIDITY-bound message without changing Seen', async () => {
  const client = new FakeClient();
  const response = await handleEmailsRequest(request('/emails/v1.77.12'), { createClient: () => client });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    id: 'v1.77.12',
    from: 'new@example.test',
    subject: 'New',
    date: '2026-01-02T10:00:00.000Z',
    to: 'me@example.test',
    cc: '',
    body: 'hello from IMAP',
    contentType: 'text/plain',
    bodyTruncated: false,
    attachments: [],
  });
  assert.equal(client.mailboxOpenCalls[0].options.readOnly, true);
  assert.equal(client.downloadCalls[0].options.uid, true);
  assert.deepEqual([...client.flags], ['\\Seen']);
  assert.equal(client.logoutCalls, 1);
});

test('falls back to non-empty HTML and returns attachment metadata', async () => {
  const client = new FakeClient();
  client.bodyStructure = {
    type: 'multipart/mixed',
    childNodes: [
      {
        type: 'multipart/alternative',
        part: '1',
        childNodes: [
          { type: 'text/plain', part: '1.1', size: 2 },
          { type: 'text/html', part: '1.2', size: 40 },
        ],
      },
      {
        type: 'application/pdf',
        part: '2',
        disposition: 'attachment',
        dispositionParameters: { filename: 'documento.pdf' },
        size: 1234,
      },
    ],
  };
  client.download = async (uid, part) => ({
    content: Readable.from([Buffer.from(part === '1.1' ? '\r\n' : '<p>Mensagem encaminhada</p>')]),
  });

  const response = await handleEmailsRequest(request('/emails/v1.77.12'), { createClient: () => client });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.body, 'Mensagem encaminhada');
  assert.equal(body.contentType, 'text/html');
  assert.deepEqual(body.attachments, [{
    id: '2',
    filename: 'documento.pdf',
    contentType: 'application/pdf',
    size: 1234,
  }]);
});

test('downloads an attachment by MIME part id without changing Seen', async () => {
  const client = new FakeClient();
  client.bodyStructure = {
    type: 'multipart/mixed',
    childNodes: [{
      type: 'application/pdf',
      part: '2',
      disposition: 'attachment',
      dispositionParameters: { filename: 'documento.pdf' },
      size: 7,
    }],
  };
  client.download = async (uid, part, options) => {
    client.downloadCalls.push({ uid, part, options });
    return { content: Readable.from([Buffer.from('PDFDATA')]) };
  };

  const response = await handleEmailsRequest(
    request('/emails/v1.77.12/attachments/2'),
    { createClient: () => client },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/pdf');
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="documento.pdf"');
  assert.equal(await response.text(), 'PDFDATA');
  assert.equal(client.mailboxOpenCalls[0].options.readOnly, true);
  assert.equal(client.downloadCalls[0].options.uid, true);
  assert.deepEqual([...client.flags], ['\\Seen']);
  assert.equal(client.logoutCalls, 1);
});

test('returns 404 for an obsolete UIDVALIDITY', async () => {
  const client = new FakeClient();
  const response = await handleEmailsRequest(request('/emails/v1.78.12'), { createClient: () => client });
  assert.equal(response.status, 404);
  assert.equal(client.fetchOneCalls.length, 0);
  assert.equal(client.logoutCalls, 1);
});
