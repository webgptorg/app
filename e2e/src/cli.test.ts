import { describe, expect, it } from 'vitest';

import { composeArgs, parseGid, parseOverlays, projectName, runArgs } from './cli.ts';

const TARGET = { project: 'ptbk-e2e-app', e2eDir: '/repo/e2e', overlays: ['proxy'] } as const;

describe('projectName', () => {
    it('is one project per checkout, unless E2E_PROJECT names one', () => {
        expect(projectName('/work/App X-01', {})).toBe('ptbk-e2e-app-x-01');
        expect(projectName('/work/app-x-01', { E2E_PROJECT: 'mine' })).toBe('mine');
        expect(projectName('/', { E2E_PROJECT: '' })).toBe('ptbk-e2e');
    });
});

describe('parseOverlays', () => {
    it('reads a comma-separated list and refuses paths', () => {
        expect(parseOverlays(undefined)).toEqual([]);
        expect(parseOverlays(' nat , proxy,')).toEqual(['nat', 'proxy']);
        expect(() => parseOverlays('../evil')).toThrow('not an overlay name');
    });
});

describe('composeArgs and runArgs', () => {
    it('layers overlays over compose.yaml in order', () => {
        expect(composeArgs(TARGET, 'ps')).toEqual([
            'compose',
            '--project-name',
            'ptbk-e2e-app',
            '--project-directory',
            '/repo/e2e',
            '--file',
            '/repo/e2e/compose.yaml',
            '--file',
            '/repo/e2e/compose.proxy.yaml',
            'ps',
        ]);
    });

    it("keeps the image's command unless Playwright arguments are given", () => {
        expect(runArgs(TARGET, []).slice(-5)).toEqual([
            'run',
            '--name',
            'ptbk-e2e-app-playwright-run',
            '--no-deps',
            'playwright',
        ]);
        expect(runArgs(TARGET, ['--grep', 'sse']).slice(-5)).toEqual([
            'playwright',
            'node_modules/.bin/playwright',
            'test',
            '--grep',
            'sse',
        ]);
    });
});

describe('parseGid', () => {
    it("takes stat's numeric group and nothing else", () => {
        expect(parseGid('988\n')).toBe('988');
        expect(parseGid('0')).toBe('0');
        expect(() => parseGid('docker')).toThrow('group of the Docker socket');
        expect(() => parseGid('')).toThrow('group of the Docker socket');
    });
});
