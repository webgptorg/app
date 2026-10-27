import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { GATEWAY_PAGES, GATEWAY_PAGES_DIR, SIMPLEWEBAUTHN_BROWSER_SHA256 } from './assets';
import { readPage } from './testing/pages';

const vendored = readFileSync(new URL('simplewebauthn-browser.umd.min.js', GATEWAY_PAGES_DIR));
// The bundle is not in the package's exports map, so it is found next to the entry that is.
const installedEntry = pathToFileURL(createRequire(import.meta.url).resolve('@simplewebauthn/browser'));
const installed = readFileSync(new URL('../dist/bundle/index.umd.min.js', installedEntry));

describe('vendored @simplewebauthn/browser', () => {
    it('has the pinned SHA-256', () => {
        expect(createHash('sha256').update(vendored).digest('hex')).toBe(SIMPLEWEBAUTHN_BROWSER_SHA256);
    });

    it('is byte for byte the installed catalog version', () => {
        expect(vendored.equals(installed)).toBe(true);
        expect(vendored.subarray(0, 40).toString('utf8')).toContain('[@simplewebauthn/browser@14.0.0]');
    });

    it('is pinned with Subresource Integrity in every page', () => {
        const integrity = `sha256-${Buffer.from(SIMPLEWEBAUTHN_BROWSER_SHA256, 'hex').toString('base64')}`;
        for (const page of GATEWAY_PAGES) {
            expect(readPage(page)).toContain(`integrity="${integrity}"`);
        }
    });
});
