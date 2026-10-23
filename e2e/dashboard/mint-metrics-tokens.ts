// The metrics-tokens service (compose.monitoring.yaml), once per stack before the relays and the dashboard start:
// one metrics token per relay, made here and never written to the repo or a log. Each relay's goes only to
// /metrics-tokens/<relay>/token, owned by the relays' user (uid 1000, SERVICE_UID in src/stack.ts); the dashboard gets
// all of them, with the monitoring settings, as vars in /monitoring/vars.json (DASHBOARD_VARS_FILE).
import { randomBytes } from 'node:crypto';
import { chmodSync, chownSync, writeFileSync } from 'node:fs';

const RELAY_UID = 1000;

/**
 * Short checks, so the e2e sees an alert two triggers after a relay stops; the job runs only when triggered. The dev
 * CA's relay certificates live 7 days, inside the production 14-day warning, so the certificate rule here warns at 1.
 */
const MONITORING = { opsEmail: 'ops@ptbk.test', probeTimeoutMs: 3000, thresholds: { certificateExpiryDays: 1 } };

const tokens: Record<string, string> = {};
for (const relay of process.argv.slice(2)) {
    const token = `ptbk_mt_${randomBytes(32).toString('base64url')}`;
    const dir = `/metrics-tokens/${relay}`;
    writeFileSync(`${dir}/token`, `${token}\n`, { mode: 0o400 });
    chownSync(dir, RELAY_UID, RELAY_UID);
    chownSync(`${dir}/token`, RELAY_UID, RELAY_UID);
    chmodSync(dir, 0o700);
    tokens[relay] = token;
}
writeFileSync('/monitoring/vars.json', JSON.stringify({ MONITORING, RELAY_METRICS_TOKENS: JSON.stringify(tokens) }), {
    mode: 0o400,
});
console.log(`metrics tokens made for ${Object.keys(tokens).join(', ')}`);
