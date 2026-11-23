import { describe, expect, it } from 'vitest';

import { engineInstallReleaseSchema, installationOptionSchema } from '../../shared/engine-installation';
import { TEST_ENGINE_INSTALLATION } from '../../testing/install-fixtures';
import { installationOptions } from './installation-options';

const LINK = `https://app.ptbk.io/link#${'a'.repeat(26)}`;

describe('engine-first installation options', () => {
    it('separates bounded shell, localized AI prompts and a real version-matched download', () => {
        const options = installationOptions(TEST_ENGINE_INSTALLATION, LINK);
        expect(options.map((option) => option.kind)).toEqual(['command', 'ai', 'download']);
        for (const option of options) expect(installationOptionSchema.parse(option)).toEqual(option);
        for (const option of options) {
            switch (option.kind) {
                case 'command':
                    for (const command of Object.values(option.commands)) {
                        expect(command).toContain(LINK);
                        expect(command).toContain(TEST_ENGINE_INSTALLATION.version);
                        expect(command).not.toMatch(/mkdir|my-agenda|--path/);
                    }
                    expect(option.commands.posix).toContain('/assets/install-project-v1.sh');
                    expect(option.commands.powershell).toContain(TEST_ENGINE_INSTALLATION.windowsSha256);
                    expect(option.commands.powershell).toContain('--prepare-only --link-stdin');
                    expect(option.commands.ubuntu).toContain('--prepare-only --link-stdin');
                    break;
                case 'ai':
                    for (const targets of Object.values(option.prompts)) {
                        for (const prompt of Object.values(targets)) {
                            expect(prompt).toContain(LINK);
                            expect(prompt).toContain(TEST_ENGINE_INSTALLATION.version);
                            expect(prompt).toContain('ptbk onboarding --id <engine-id>');
                        }
                    }
                    expect(option.prompts.cs.local).toContain('Windows PowerShell:');
                    expect(option.prompts.en.server).toContain('SSH');
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
