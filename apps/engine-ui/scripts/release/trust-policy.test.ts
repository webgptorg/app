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
});
