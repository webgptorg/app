import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { Hostname } from '../common';
import { EngineInfo } from '../engine';
import { toTolerant } from '../tolerant';
import { CapabilityId, KNOWN_CAPABILITIES, capabilityLabel, supports } from './capability';

/** `EngineInfo` exactly as API 1.0 (C-04) shipped it, to stand in for a UI built against 1.0. */
const EngineInfoV1_0 = z.strictObject({
    name: z.string().min(1).max(128),
    hostname: Hostname,
    dashboardUrl: z
        .url({ protocol: /^https$/ })
        .max(2048)
        .nullable(),
    mode: z.enum(['tunnel', 'direct', 'local']),
});

const ENGINE_ID = 'abcdefghijklmnopqrstuvwxyz';

const engineV1_0 = {
    name: 'Home engine',
    hostname: `${ENGINE_ID}.ptbk.example`,
    dashboardUrl: 'https://app.ptbk.io/engines/1',
    mode: 'tunnel',
};

const engineV1_1 = {
    ...engineV1_0,
    engineId: ENGINE_ID,
    capabilities: [
        { id: 'runs', version: 1 },
        { id: 'files', version: 1 },
    ],
};

describe('supports', () => {
    const info = {
        capabilities: [
            { id: 'runs', version: 1 },
            { id: 'runs', version: 2 },
            { id: 'teleport', version: 1 },
        ],
    };

    it('matches each advertised version, also side by side', () => {
        expect(supports(info, KNOWN_CAPABILITIES.runs)).toBe(true);
        expect(supports(info, { id: 'runs', version: 2 })).toBe(true);
    });

    it('never matches another version or an unadvertised capability', () => {
        expect(supports(info, { id: 'runs', version: 3 })).toBe(false);
        expect(supports(info, KNOWN_CAPABILITIES.files)).toBe(false);
        expect(supports({ capabilities: [] }, KNOWN_CAPABILITIES.runs)).toBe(false);
    });

    it('labels capability versions as id@version', () => {
        expect(capabilityLabel(KNOWN_CAPABILITIES.integrations)).toBe('integrations@1');
        expect(Object.values(KNOWN_CAPABILITIES).map(capabilityLabel)).toEqual([
            'runs@1',
            'files@1',
            'triggers@1',
            'integrations@1',
            'test-chat@1',
        ]);
    });
});

describe('CapabilityId', () => {
    it.each(['runs', 'a', 'web-hooks2', 'a'.repeat(32)])('accepts %s', (id) => {
        expect(CapabilityId.safeParse(id).success).toBe(true);
    });

    it.each(['', 'Runs', '1runs', '-runs', 'runs@1', 'run_s', 'a'.repeat(33)])('refuses %s', (id) => {
        expect(CapabilityId.safeParse(id).success).toBe(false);
    });
});

describe('EngineInfo', () => {
    it('reads an engine on API 1.0 without capabilities as none', () => {
        const legacy = { ...engineV1_0, engineId: ENGINE_ID };
        expect(EngineInfo.parse(legacy).capabilities).toEqual([]);
        expect(toTolerant(EngineInfo).parse(legacy).capabilities).toEqual([]);
    });

    it('reads a 1.0 GET /engine response, which has no engine ID either', () => {
        expect(toTolerant(EngineInfo).parse(engineV1_0)).toEqual({ ...engineV1_0, engineId: null, capabilities: [] });
    });

    it('keeps capabilities this client does not know, which then match nothing', () => {
        const info = EngineInfo.parse({ ...engineV1_1, capabilities: [{ id: 'teleport', version: 7 }] });
        expect(info.capabilities).toEqual([{ id: 'teleport', version: 7 }]);
        expect(supports(info, KNOWN_CAPABILITIES.runs)).toBe(false);
    });

    it('refuses a malformed engine ID or capability', () => {
        expect(EngineInfo.safeParse({ ...engineV1_1, engineId: 'ABC' }).success).toBe(false);
        expect(EngineInfo.safeParse({ ...engineV1_1, capabilities: [{ id: 'runs', version: 0 }] }).success).toBe(false);
        expect(EngineInfo.safeParse({ ...engineV1_1, capabilities: [{ id: 'runs' }] }).success).toBe(false);
    });

    it('lets a 1.0 client read a 1.1 GET /engine response', () => {
        expect(EngineInfoV1_0.safeParse(engineV1_1).success).toBe(false);
        expect(toTolerant(EngineInfoV1_0).parse(engineV1_1)).toEqual(engineV1_0);
    });

    it('lets this client read a later response with fields it does not know', () => {
        const later = {
            ...engineV1_1,
            region: 'eu',
            capabilities: [{ id: 'runs', version: 1, experimental: true }],
        };
        expect(EngineInfo.safeParse(later).success).toBe(false);
        expect(toTolerant(EngineInfo).parse(later)).toEqual({
            ...engineV1_1,
            capabilities: [{ id: 'runs', version: 1 }],
        });
    });
});
