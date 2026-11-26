import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../mcp/server.mjs';

const originalToken = process.env.IMAP_AUTH_CHECK_TOKEN;

before(() => {
  process.env.IMAP_AUTH_CHECK_TOKEN = 'test-token';
});

after(() => {
  if (originalToken === undefined) delete process.env.IMAP_AUTH_CHECK_TOKEN;
  else process.env.IMAP_AUTH_CHECK_TOKEN = originalToken;
});

function fakeHandler(request) {
  const url = new URL(request.url);
  if (request.headers.get('authorization') !== 'Bearer test-token') {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (url.pathname === '/emails') {
    return Response.json([{
      id: 'v1.77.12',
      from: 'sender@example.test',
      subject: 'New',
      date: '2026-01-02T10:00:00.000Z',
    }]);
  }
  if (url.pathname === '/emails/v1.77.12') {
    return Response.json({
      id: 'v1.77.12',
      from: 'sender@example.test',
      subject: 'New',
      date: '2026-01-02T10:00:00.000Z',
      to: 'me@example.test',
      cc: '',
      body: 'hello',
      contentType: 'text/plain',
      bodyTruncated: false,
      attachments: [{ id: '2', filename: 'file.pdf' }],
    });
  }
  return Response.json({ error: 'not found' }, { status: 404 });
}

async function connectedPair() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ requestHandler: fakeHandler });
  const client = new Client({ name: 'imap-plus-it-test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

test('discovers and calls both MCP tools', async () => {
  const { client, server } = await connectedPair();
  try {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(tool => tool.name).sort(), ['buscar_emails', 'ler_email']);

    const search = await client.callTool({ name: 'buscar_emails', arguments: { from: 'sender@example.test', limit: 5 } });
    assert.match(search.content[0].text, /v1\.77\.12/);

    const email = await client.callTool({ name: 'ler_email', arguments: { id: 'v1.77.12' } });
    assert.match(email.content[0].text, /hello/);
    assert.doesNotMatch(email.content[0].text, /attachments/);
  } finally {
    await client.close();
    await server.close();
  }
});
