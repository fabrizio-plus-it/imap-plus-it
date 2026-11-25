import { connect } from 'node:tls';

export default async () => {
  const host = process.env.IMAP_HOST;
  const port = Number(process.env.IMAP_PORT ?? '993');

  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    return Response.json({ ok: false }, {
      status: 500,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  const result = await new Promise((resolve) => {
    const socket = connect({ host, port, servername: host, rejectUnauthorized: true });
    const timer = setTimeout(() => finish({ ok: false, error: 'TIMEOUT' }), 7000);

    function finish(result) {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    }

    socket.once('secureConnect', () => finish({ ok: true, protocol: socket.getProtocol() }));
    socket.once('error', (error) => finish({ ok: false, error: error.code ?? 'CONNECTION_FAILED' }));
  });

  return Response.json({ host, port, ...result }, {
    status: result.ok ? 200 : 502,
    headers: { 'Cache-Control': 'no-store' },
  });
};
