import { describe, expect, it } from 'vitest';

import { engineInstallReleaseSchema, installationOptionSchema } from '../../shared/engine-installation';
import { TEST_ENGINE_INSTALLATION } from '../../testing/install-fixtures';
import { installationOptions } from './installation-options';

const CODE = 'a'.repeat(26);
const LINK = `https://app.ptbk.io/link#${CODE}`;

describe('engine-first installation options', () => {
    it('separates bounded shell, localized AI prompts and a real version-matched download', () => {
        const options = installationOptions(TEST_ENGINE_INSTALLATION, LINK);
        expect(options.map((option) => option.kind)).toEqual(['command', 'ai', 'download']);
        for (const option of options) expect(installationOptionSchema.parse(option)).toEqual(option);
        for (const option of options) {
            switch (option.kind) {
                case 'command':
                    expect(option.commands).toEqual({
                        posix: `curl -fsSL https://app.ptbk.io/install.sh | PTBK_LINK=${CODE} bash`,
                        powershell: `$env:PTBK_LINK='${CODE}'; irm https://app.ptbk.io/install.ps1 | iex`,
                        ubuntu: `curl -fsSL https://app.ptbk.io/install-server.sh | PTBK_LINK=${CODE} bash`,
                    });
                    break;
                case 'ai':
                    for (const targets of Object.values(option.prompts)) {
                        for (const prompt of Object.values(targets)) {
                            expect(prompt).toContain(`PTBK_LINK=${CODE}`);
                            expect(prompt).toContain('ptbk onboarding --id <engine-id>');
                        }
                    }
                    expect(option.prompts.cs.local).toContain('Windows PowerShell:');
                    expect(option.prompts.en.server).toContain('SSH');
                    expect(option.prompts.en.server).toContain('/install-server.sh');
                    break;
                case 'download':
                    expect(option.url).toBe(
                        'https://github.com/webgptorg/promptbook/releases/download/v0.119.0-117/Promptbook-Setup-0.119.0-117-windows-x64.exe',
                    );
                    expect(option.afterInstall).toContain(LINK);
                    expect(option.afterInstall).toContain('$LASTEXITCODE');
                    expect(option.sha256).toBe(TEST_ENGINE_INSTALLATION.windowsSha256);
                    break;
            }
        }
    });

    it('needs a valid link URL to build commands from', () => {
        expect(() => installationOptions(TEST_ENGINE_INSTALLATION, 'https://app.ptbk.io/link#short')).toThrow(
            TypeError,
        );
    });

    it('refuses old product lines, unsupported prereleases, malformed checksums and unknown config fields', () => {
        for (const version of [
            'latest',
            '0.114.0-42',
            '0.119.0-113',
            '0.119.0-114',
            '0.119.0-116',
            '0.119.0-0114',
            '0.119.0-117\n',
            '0.119.0-117; echo injected',
        ]) {
            expect(engineInstallReleaseSchema.safeParse({ ...TEST_ENGINE_INSTALLATION, version }).success).toBe(false);
        }
        expect(engineInstallReleaseSchema.parse({ ...TEST_ENGINE_INSTALLATION, version: '0.119.0' }).version).toBe(
            '0.119.0',
        );
        expect(
            engineInstallReleaseSchema.safeParse({ ...TEST_ENGINE_INSTALLATION, windowsSha256: 'wrong' }).success,
        ).toBe(false);
        expect(
            engineInstallReleaseSchema.safeParse({ ...TEST_ENGINE_INSTALLATION, bootstrapRevision: 'main' }).success,
        ).toBe(false);
        expect(
            engineInstallReleaseSchema.safeParse({ ...TEST_ENGINE_INSTALLATION, url: 'https://elsewhere.test' })
                .success,
        ).toBe(false);
    });
});
