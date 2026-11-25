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
      bodyStructure: { type: 'text/plain', part: undefined },
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
  });
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
