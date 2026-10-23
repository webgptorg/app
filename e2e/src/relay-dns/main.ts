// The relay-dns service of the nat scenario (compose.relay-dns.yaml), a test-only stand-in for the engine domain's
// health-checked DNS. Only node: imports: it runs from an image that carries no node_modules.
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { probe } from '../probe.ts';
import { HTTPS_PORT, MOUNTS, PUBLIC_FILES, RELAYS, RELAY_DNS } from '../stack.ts';
import { createRelayDnsChecker, healthzCheck } from './checker.ts';
import { zoneFileWriter } from './zones.ts';

const ca = readFileSync(`${MOUNTS.public}/${PUBLIC_FILES.caCertificate}`, 'utf8');
const checker = createRelayDnsChecker({
    relays: RELAYS,
    thresholds: RELAY_DNS,
    check: healthzCheck(probe, ca, HTTPS_PORT, RELAY_DNS.timeoutMs),
    writer: zoneFileWriter(RELAY_DNS.zonesMount, RELAYS, RELAY_DNS.ttlS),
    alert: (alert) => process.stdout.write(`${JSON.stringify(alert)}\n`),
});

await checker.start();
process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), event: 'relay_dns.started' })}\n`);
for (;;) {
    const started = Date.now();
    await checker.tick();
    await sleep(Math.max(0, RELAY_DNS.intervalMs - (Date.now() - started)));
}
