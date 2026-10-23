/** The relay container's healthcheck: `/healthz` on the relay's own hostname answers `ok`. */
import { readFileSync } from 'node:fs';
import { get } from 'node:https';

const request = get(
    {
        host: '127.0.0.1',
        port: 443,
        path: '/healthz',
        servername: 'relay.load.test',
        ca: readFileSync('/pki/relay-cert.pem', 'utf8'),
        timeout: 3000,
    },
    (response) => {
        process.exit(response.statusCode === 200 ? 0 : 1);
    },
);
request.on('error', () => process.exit(1));
request.on('timeout', () => process.exit(1));
