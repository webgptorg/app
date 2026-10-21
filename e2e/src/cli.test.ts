import { describe, expect, it } from 'vitest';

import {
    composeArgs,
    everyServiceTarget,
    parseGid,
    parseOverlays,
    projectName,
    runArgs,
    scenarioTarget,
} from './cli.ts';
import { scenarioNamed } from './scenarios.ts';

const TARGET = { project: 'ptbk-e2e-app', e2eDir: '/repo/e2e', overlays: ['proxy'], scenario: 'spike' } as const;

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
        expect(runArgs(TARGET, []).slice(-7)).toEqual([
            'run',
            '--name',
            'ptbk-e2e-app-playwright-run',
            '--env',
            'E2E_SCENARIO=spike',
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

describe('scenarioTarget and everyServiceTarget', () => {
    const base = { project: 'p', e2eDir: '/repo/e2e' };

    it("layers the scenario's overlays, then extra ones, each once", () => {
        expect(scenarioTarget(base, scenarioNamed('egress-443'), ['debug', 'nat'])).toEqual({
            ...base,
            scenario: 'egress-443',
            overlays: ['nat', 'egress-443', 'debug'],
        });
    });

    it('cleans up with every overlay any scenario uses', () => {
        const target = scenarioTarget(base, scenarioNamed(undefined), ['debug']);
        expect(everyServiceTarget(target).overlays).toEqual([
            'nat',
            'capture',
            'egress-443',
            'connect-proxy',
            'tls-inspecting-proxy',
            'debug',
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
