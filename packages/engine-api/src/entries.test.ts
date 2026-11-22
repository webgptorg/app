import { describe, expect, it } from 'vitest';

import * as http from './http';
import * as inMemory from './in-memory';
import * as main from './index';

describe('package entries', () => {
    it('keeps the in-memory engine and the HTTP binding out of the main entry', () => {
        const exported = Object.keys(main);
        for (const name of [...Object.keys(inMemory), ...Object.keys(http)]) expect(exported).not.toContain(name);
        expect(exported.some((name) => /in-?memory/i.test(name))).toBe(false);
    });

    it('serves them from their subpaths', () => {
        expect(Object.keys(inMemory).sort()).toEqual([
            'CHECK_MS',
            'CREATE_MS',
            'DEFAULT_CAPABILITIES',
            'DEFAULT_EVENT_BUFFER_SIZE',
            'DEVICE_LOGIN_MS',
            'FAKE_FRAME_HEIGHT',
            'FAKE_FRAME_WIDTH',
            'FAKE_VIEWPORT',
            'INSTALL_MS',
            'IN_MEMORY_CLIENT_MARKER',
            'PERMISSION_AUTHORIZER',
            'RECHECK_DELAY_MS',
            'RESOURCE_KINDS',
            'STEP_ANNOUNCE_INTERVAL_MS',
            'builtInAgents',
            'createDemoSeed',
            'createInMemoryEngine',
            'createInMemoryEngineApiClient',
            'createInMemoryEngineCore',
            'demoReplyScript',
            'nextScheduleFireAt',
            'renderFakeFrame',
            'runPreview',
            'truncateRunText',
        ]);
        expect(Object.keys(http).sort()).toEqual(['createEngineApiHttpHandler', 'serveEngineApiRoute']);
    });
});
