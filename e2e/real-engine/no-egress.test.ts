import { describe, expect, it } from 'vitest';

import type { EgressProbe } from './no-egress.ts';
import { INSIDE_URLS, OUTSIDE_ADDRESSES, OUTSIDE_NAMES, egressFailures } from './no-egress.ts';

const blocked = (target: string, outcome = 'unreachable'): EgressProbe => ({ target, expected: 'blocked', outcome });
const reachable = (target: string, outcome = 'reachable'): EgressProbe => ({ target, expected: 'reachable', outcome });

describe('egressFailures', () => {
    it('passes when nothing outside answers and everything inside does', () => {
        expect(
            egressFailures([blocked('tcp 1.1.1.1:443'), blocked('dns example.com', 'ENOTFOUND'), reachable('app')]),
        ).toEqual([]);
    });

    it('fails on anything outside that answered', () => {
        expect(egressFailures([blocked('tcp 1.1.1.1:443', 'reachable'), reachable('app')])).toEqual([
            'tcp 1.1.1.1:443 is reachable from the engine',
        ]);
    });

    it('fails when the stack itself is out of reach, since then the check proves nothing', () => {
        expect(egressFailures([blocked('tcp 1.1.1.1:443'), reachable('app', 'ECONNREFUSED')])).toEqual([
            'app is not reachable (ECONNREFUSED)',
        ]);
        expect(egressFailures([blocked('tcp 1.1.1.1:443')])).toEqual(['the check needs both kinds of probe']);
    });

    it('probes a public address, public names and every service the engine needs', () => {
        expect(OUTSIDE_ADDRESSES).toContainEqual(['1.1.1.1', 443]);
        expect(OUTSIDE_NAMES).toContain('api.openai.com');
        expect(INSIDE_URLS.map((url) => new URL(url).hostname)).toEqual([
            'app.ptbk.test',
            'relay-a.ptbk.test',
            'relay-b.ptbk.test',
            'releases.ptbk.test',
        ]);
    });
});
