import { LinkCode } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';
import { TEST_ENGINE_INSTALLATION } from '../../testing/install-fixtures';
import { cloudInit } from './cloud-init';

describe('VPS first boot', () => {
    const release = { ...TEST_ENGINE_INSTALLATION, digitalOceanOwner: true as const };
    const origin = 'https://app.ptbk.test';
    const code = LinkCode.parse('a'.repeat(26));
    const digest = '0'.repeat(64);

    it('requires a release that can verify the first owner', () => {
        expect(() => cloudInit(TEST_ENGINE_INSTALLATION, origin, code, digest)).toThrow('Invalid VPS bootstrap');
    });

    it('rejects an unsupported host or malformed owner digest before generating the boot script', () => {
        expect(() => cloudInit(release, 'https://[::1]', code, digest)).toThrow('Invalid VPS bootstrap');
        expect(() => cloudInit(release, origin, code, 'invalid')).toThrow('Invalid VPS bootstrap');
    });
});
