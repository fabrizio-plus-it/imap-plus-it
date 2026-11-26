import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { handleMcpRequest } from '../netlify/functions/mcp.mjs';
import { createMcpServer } from '../mcp/server.mjs';

const originalToken = process.env.IMAP_AUTH_CHECK_TOKEN;

before(() => {
  process.env.IMAP_AUTH_CHECK_TOKEN = 'test-token';
});

after(() => {
  if (originalToken === undefined) delete process.env.IMAP_AUTH_CHECK_TOKEN;
  else process.env.IMAP_AUTH_CHECK_TOKEN = originalToken;
});

test('rejects MCP HTTP requests before creating a server', async () => {
  let created = false;
  const response = await handleMcpRequest(new Request('https://example.test/mcp', { method: 'POST' }), {
    createServer: () => {
      created = true;
      return createMcpServer();
    },
  });

  assert.equal(response.status, 401);
  assert.equal(created, false);
});

test('accepts an authenticated stateless MCP initialize request', async () => {
  const request = new Request('https://example.test/mcp', {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-token',
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    }),
  });
  const response = await handleMcpRequest(request, {
    createServer: () => createMcpServer({
      requestHandler: async () => Response.json({ error: 'not called' }, { status: 500 }),
    }),
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.result.serverInfo.name, 'imap-plus-it');
});
