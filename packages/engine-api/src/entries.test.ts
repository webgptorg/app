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
            'DEFAULT_EVENT_BUFFER_SIZE',
            'IN_MEMORY_CLIENT_MARKER',
            'PERMISSION_AUTHORIZER',
            'RESOURCE_KINDS',
            'createDemoSeed',
            'createInMemoryEngine',
            'createInMemoryEngineApiClient',
            'createInMemoryEngineCore',
            'nextScheduleFireAt',
            'truncateRunText',
        ]);
        expect(Object.keys(http).sort()).toEqual(['createEngineApiHttpHandler', 'serveEngineApiRoute']);
    });
});
