import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { handleEmailsRequest } from '../netlify/functions/emails.mjs';

const messageIdSchema = z.string().regex(/^v1\.[0-9]+\.[1-9][0-9]*$/);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function requestWithToken(path) {
  const token = process.env.IMAP_AUTH_CHECK_TOKEN ?? '';
  return new Request(`https://mcp.local${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

async function callRest(path, requestHandler) {
  const response = await requestHandler(requestWithToken(path));
  const body = await response.json();
  return { response, body };
}

function toolResult(response, body) {
  const text = JSON.stringify(body, null, 2);
  return {
    content: [{ type: 'text', text }],
    ...(response.ok
      ? { structuredContent: Array.isArray(body) ? { emails: body } : body }
      : { isError: true }),
  };
}

export function createMcpServer({ requestHandler = handleEmailsRequest } = {}) {
  const server = new McpServer({ name: 'imap-plus-it', version: '1.0.0' });

  server.registerTool('buscar_emails', {
    description: 'Busca e-mails da INBOX por remetente, assunto e período, retornando os mais recentes primeiro.',
    inputSchema: {
      from: z.string().max(200).optional().describe('Remetente ou trecho do remetente.'),
      subject: z.string().max(200).optional().describe('Assunto ou trecho do assunto.'),
      since: dateSchema.optional().describe('Data inicial inclusiva, no formato YYYY-MM-DD.'),
      before: dateSchema.optional().describe('Data final exclusiva, no formato YYYY-MM-DD.'),
      limit: z.number().int().min(1).max(50).optional().describe('Limite de resultados, de 1 a 50.'),
    },
  }, async ({ from, subject, since, before, limit }) => {
    const params = new URLSearchParams();
    if (from !== undefined) params.set('from', from);
    if (subject !== undefined) params.set('subject', subject);
    if (since !== undefined) params.set('since', since);
    if (before !== undefined) params.set('before', before);
    if (limit !== undefined) params.set('limit', String(limit));

    const { response, body } = await callRest(`/emails?${params}`, requestHandler);
    return toolResult(response, body);
  });

  server.registerTool('ler_email', {
    description: 'Lê o corpo textual de um e-mail da INBOX pelo ID retornado por buscar_emails. Não retorna anexos.',
    inputSchema: {
      id: messageIdSchema.describe('ID no formato v1.UIDVALIDITY.UID retornado por buscar_emails.'),
    },
  }, async ({ id }) => {
    const { response, body } = await callRest(`/emails/${encodeURIComponent(id)}`, requestHandler);
    if (response.ok && body && typeof body === 'object') {
      const { attachments, ...withoutAttachments } = body;
      return toolResult(response, withoutAttachments);
    }
    return toolResult(response, body);
  });

  return server;
}

async function main() {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
}

if (process.env.MCP_STDIO === '1') {
  main().catch(() => process.exit(1));
}
