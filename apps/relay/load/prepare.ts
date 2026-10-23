/**
 * One-shot, before every load run: fresh certificates for the relay and the engines and fresh engine identities, plus
 * the static registry the relay reads. Everything lives in the run's volumes and dies with them; nothing is committed.
 */
import { chownSync, writeFileSync } from 'node:fs';

import { createTestCertificate } from '../src/testing/test-pki';
import { ENGINE_DOMAIN, PATHS, RELAY_ID, createEngineIdentity } from './lib/fixtures';
import { log, parseOptions } from './lib/output';

/** The `node` user of the relay image. */
const RELAY_UID = 1000;

const options = parseOptions({ engines: 5200 });

const relayTls = createTestCertificate([RELAY_ID]);
writeFileSync(PATHS.relayCert, relayTls.cert, { mode: 0o644 });
writeFileSync(PATHS.relayKey, relayTls.key, { mode: 0o600 });
chownSync(PATHS.relayKey, RELAY_UID, RELAY_UID);

// Browsers trust the engines' certificate directly; the relay never gets its key.
const engineTls = createTestCertificate([`*.${ENGINE_DOMAIN}`]);
writeFileSync(PATHS.engineCa, engineTls.cert, { mode: 0o644 });
writeFileSync(PATHS.engineCert, engineTls.cert, { mode: 0o644 });
writeFileSync(PATHS.engineKey, engineTls.key, { mode: 0o600 });

const identities = await Promise.all(Array.from({ length: options.engines }, () => createEngineIdentity()));
writeFileSync(PATHS.engines, JSON.stringify(identities.map(({ record }) => record)), { mode: 0o600 });
writeFileSync(
    PATHS.registry,
    JSON.stringify({ v: 1, engines: identities.map(({ record, entry }) => ({ engineId: record.engineId, ...entry })) }),
    { mode: 0o644 },
);
log('prepared', { engines: options.engines });
