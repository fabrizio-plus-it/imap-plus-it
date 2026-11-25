import { connect } from 'node:tls';

export default async () => {
  const host = 'imap.skymail.net.br';
  const port = 993;

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
