import { describe, expect, it } from 'vitest';

import { createDurableObjectWebRiskStore, WEB_RISK_LISTS_NAME } from './durable-object-web-risk-store';
import { createMemoryWebRiskStorage, createWebRiskStore } from './web-risk-store';

describe('createDurableObjectWebRiskStore', () => {
    it('sends every call to the one object, by its fixed name', async () => {
        const store = createWebRiskStore(createMemoryWebRiskStorage());
        const names: string[] = [];
        const remote = createDurableObjectWebRiskStore({
            idFromName: (name) => {
                names.push(name);
                return name as unknown as DurableObjectId;
            },
            get: () => store,
        });
        const prefix = Uint8Array.from([1, 2, 3, 4]);
        await remote.cacheSearches([{ prefix, result: { threats: [], negativeUntil: 10 } }], 0);
        expect(await remote.cachedSearches([prefix])).toEqual([{ threats: [], negativeUntil: 10 }]);
        expect(await remote.versions()).toEqual({});
        expect(await remote.prefixHits([new Uint8Array(32)])).toEqual([[]]);
        expect(
            await remote.apply(
                'MALWARE',
                {
                    kind: 'diff',
                    additions: [],
                    removals: [0],
                    checksum: new Uint8Array(32),
                    versionToken: 'AQ==',
                    nextDiffAt: 0,
                },
                0,
            ),
        ).toBe(false);
        expect(new Set(names)).toEqual(new Set([WEB_RISK_LISTS_NAME]));
    });
});
