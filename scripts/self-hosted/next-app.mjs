import next from 'next';

export function createSelfHostedNextApp({ dir, port }) {
  // NextURL normalizes both 127.0.0.1 and ::1 to localhost. Use that same
  // origin in Next's router so middleware rewrites stay internal, including
  // when the reverse proxy preserves X-Forwarded-Proto: https. Otherwise Next
  // can try HTTPS against our plain HTTP listener. This is NOT the bind host:
  // server.listen still uses the launcher's explicitly selected address.
  return next({ dev: false, dir, hostname: 'localhost', port });
}
