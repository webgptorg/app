import { EngineVersion } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { readPackageVersion } from './paths.ts';

describe('readPackageVersion', () => {
    it('reads the semver the release tag must match', async () => {
        expect(EngineVersion.safeParse(await readPackageVersion()).success).toBe(true);
    });
});
