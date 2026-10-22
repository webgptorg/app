import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_SCENARIO, SCENARIOS, scenarioNamed } from './scenarios.ts';

const E2E_DIR = join(import.meta.dirname, '..');
const TESTS_DIR = join(E2E_DIR, 'tests');
const DEV_STACK_SPECS = 'dev-stack';

function specFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return specFiles(path);
        return entry.name.endsWith('.spec.ts') ? [relative(TESTS_DIR, path)] : [];
    });
}

function matches(spec: string, pattern: string): boolean {
    if (!pattern.includes('*')) return spec === pattern;
    const [directory, rest] = [pattern.slice(0, pattern.lastIndexOf('/')), pattern.slice(pattern.lastIndexOf('/') + 1)];
    return spec.startsWith(`${directory}/`) && !spec.slice(directory.length + 1).includes('/') && rest === '*.spec.ts';
}

describe('SCENARIOS', () => {
    it('runs every spec in exactly one scenario, so none is silently skipped', () => {
        // tests/dev-stack/ runs on the host against the dev stack (playwright.dev.config.ts), never in a scenario.
        const devStackConfig = readFileSync(join(E2E_DIR, 'playwright.dev.config.ts'), 'utf8');
        expect(devStackConfig).toContain(`testDir: './tests/${DEV_STACK_SPECS}'`);
        for (const spec of specFiles(TESTS_DIR).filter((path) => !path.startsWith(`${DEV_STACK_SPECS}/`))) {
            const owners = SCENARIOS.filter((scenario) => scenario.specs.some((pattern) => matches(spec, pattern)));
            expect(
                owners.map((owner) => owner.name),
                spec,
            ).toHaveLength(1);
        }
    });

    it('names only overlays that exist', () => {
        for (const overlay of new Set(SCENARIOS.flatMap((scenario) => scenario.overlays))) {
            expect(existsSync(join(E2E_DIR, `compose.${overlay}.yaml`)), overlay).toBe(true);
        }
    });

    it('defaults to the spike scenario and refuses unknown names', () => {
        expect(scenarioNamed(undefined).name).toBe(DEFAULT_SCENARIO);
        expect(scenarioNamed('').name).toBe(DEFAULT_SCENARIO);
        expect(() => scenarioNamed('../nat')).toThrow('is not one of');
    });
});
