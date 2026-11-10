import { isStagingPolicy } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { STAGING_POLICY_FILE } from './paths.ts';
import { readTrustPolicy } from './trust-policy.ts';

describe('the staging trust policy', () => {
    it('parses as a C-06 TrustPolicy pinned to this repository and the release workflow', async () => {
        const policy = await readTrustPolicy(STAGING_POLICY_FILE);
        expect(policy.workflowIdentity).toEqual({
            issuer: 'https://token.actions.githubusercontent.com',
            repository: 'webgptorg/app',
            repositoryId: '1411959168',
            workflowPath: '.github/workflows/ui-release.yml',
        });
        expect(policy.releaseKeys).toHaveLength(1);
    });

    it('is a staging profile whose releases install 5 minutes after publishing', async () => {
        const policy = await readTrustPolicy(STAGING_POLICY_FILE);
        expect(isStagingPolicy(policy)).toBe(true);
        expect(policy.delays).toEqual({ regularMs: 5 * 60_000, securityMs: 5 * 60_000 });
    });
});
