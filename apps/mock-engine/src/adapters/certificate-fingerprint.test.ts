import { X509Certificate, createHash } from 'node:crypto';

import { Hostname } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { createFakeClock } from '../testing/fake-clock';
import { tlsCertificateInfo } from './certificate-fingerprint';
import { createDevCa, issueLeaf } from './dev-ca';

const START_MS = Date.parse('2026-10-20T08:00:00.400Z');

describe('tlsCertificateInfo', () => {
    it("reports the leaf's DER fingerprint and expiry, not the CA's", () => {
        const clock = createFakeClock(START_MS);
        const ca = createDevCa([Hostname.parse('engine.test')], clock);
        const leaf = issueLeaf(ca, ['abc.engine.test'], clock);

        const info = tlsCertificateInfo(`${leaf.certificatePem}\n${ca.certificatePem}`);

        const der = new X509Certificate(leaf.certificatePem).raw;
        expect(info.certificateSha256).toBe(createHash('sha256').update(der).digest('hex'));
        expect(info.notAfter).toBe(new Date(leaf.notAfterMs).toISOString().replace(/\.\d{3}Z$/, 'Z'));
    });

    it('refuses text without a certificate', () => {
        expect(() => tlsCertificateInfo('no certificate here')).toThrow('holds no certificate');
    });
});
