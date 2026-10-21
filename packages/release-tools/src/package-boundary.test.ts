import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const IMPORTS_SIGSTORE = /(?:from|import|require\()\s*\(?\s*['"]sigstore(?:\/[^'"]*)?['"]/;

describe('package boundary', () => {
    it('never imports sigstore, whose verify() matches identities by unanchored pattern and compares raw DER', () => {
        const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
        for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
            expect(Object.keys((manifest[field] ?? {}) as Record<string, string>)).not.toContain('sigstore');
        }
        const sources = readdirSync(import.meta.dirname).filter((name) => name.endsWith('.ts'));
        expect(sources.length).toBeGreaterThan(0);
        for (const name of sources) {
            expect(readFileSync(join(import.meta.dirname, name), 'utf8'), name).not.toMatch(IMPORTS_SIGSTORE);
        }
    });
});
