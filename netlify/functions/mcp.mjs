import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createMcpServer } from '../../mcp/server.mjs';
import { hasValidToken } from '../lib/imap.mjs';

export async function handleMcpRequest(request, dependencies = {}) {
  if (!hasValidToken(request)) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' },
    });
  }

  const server = (dependencies.createServer ?? createMcpServer)();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);
  const response = await transport.handleRequest(request);
  const body = await response.text();
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response(body, {
      status: response.status,
      headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' },
    });
  }
  return Response.json(payload, {
    status: response.status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

async function responseToNetlify(response) {
  return {
    statusCode: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: await response.text(),
  };
}

export async function handler(event) {
  const method = event.httpMethod ?? 'GET';
  const rawBody = event.body && event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  const request = new Request(event.rawUrl ?? `https://${event.headers?.host ?? 'mcp.local'}${event.path ?? '/mcp'}`, {
    method,
    headers: event.headers ?? {},
    body: method === 'GET' || method === 'HEAD' ? undefined : rawBody,
  });
  return responseToNetlify(await handleMcpRequest(request));
}
