import { describe, expect, it } from 'vitest';

import type { EngineInstallReleaseSource } from '../../src/domain/registration/engine-install-release-source';
import type { LinkCodeView, TeamView } from '../../src/shared/api/routes';
import { signUp } from '../../src/testing/auth-flows';
import { createAuthHarness } from '../../src/testing/auth-harness';
import { TEST_ENGINE_INSTALLATION } from '../../src/testing/install-fixtures';
import { createMemoryAuthStore } from '../../src/testing/memory-auth-store';

describe('current installation release over HTTP', () => {
    it.each(['personal', 'team'] as const)(
        'puts the %s release selected at issuance in the EXE download only',
        async (target) => {
            let lookups = 0;
            const installReleases: EngineInstallReleaseSource = {
                current(fallback, signal) {
                    expect(fallback).toEqual(TEST_ENGINE_INSTALLATION);
                    expect(signal).toBeInstanceOf(AbortSignal);
                    lookups++;
                    return Promise.resolve({ ...fallback, version: '0.119.0-125', windowsSha256: 'b'.repeat(64) });
                },
            };
            const harness = createAuthHarness({
                store: createMemoryAuthStore(),
                billing: 'off',
                engineInstallation: TEST_ENGINE_INSTALLATION,
                installReleases,
            });
            const browser = harness.browser();
            await signUp(harness, browser);
            let path = '/api/engines/link-codes';
            if (target === 'team') {
                const created = await browser.request('POST', '/api/teams', { name: 'Release selection' });
                expect(created.status).toBe(200);
                path = `/api/teams/${(created.body as { team: TeamView }).team.teamId}/link-codes`;
            }
            const response = await browser.request('POST', path);
            expect(response.status).toBe(200);
            expect(lookups).toBe(1);
            const view = response.body as LinkCodeView;
            expect(view.installCommands[0]?.command).toContain(`PTBK_LINK=${view.linkCode} bash`);
            expect(JSON.stringify(view.installationOptions)).not.toContain(TEST_ENGINE_INSTALLATION.version);
            for (const option of view.installationOptions ?? []) {
                switch (option.kind) {
                    case 'command':
                    case 'ai':
                        // The release lives in the served script, so a copied command always gets the current one.
                        expect(JSON.stringify(option)).not.toContain('0.119.0-125');
                        break;
                    case 'download':
                        expect(option.version).toBe('0.119.0-125');
                        expect(option.url).toContain('Promptbook-Setup-0.119.0-125-windows-x64.exe');
                        expect(option.sha256).toBe('b'.repeat(64));
                        expect(option.afterInstall).toContain("'0.119.0-125'");
                        break;
                }
            }
        },
    );

    it('leaves legacy configurations offline and does not look up releases for denied issuance', async () => {
        const installReleases: EngineInstallReleaseSource = {
            current() {
                return Promise.reject(new Error('metadata lookup must not run'));
            },
        };
        const harness = createAuthHarness({ store: createMemoryAuthStore(), billing: 'off', installReleases });
        const browser = harness.browser();
        expect((await browser.request('POST', '/api/engines/link-codes')).status).toBe(401);
        await signUp(harness, browser);
        const response = await browser.request('POST', '/api/engines/link-codes');
        expect(response.status).toBe(200);
        expect((response.body as LinkCodeView).installationOptions).toBeUndefined();
    });
});
