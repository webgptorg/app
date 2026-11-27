import { describe, expect, it } from 'vitest';

import { TEST_ENGINE_INSTALLATION } from '../../testing/install-fixtures';
import { createFetchEngineInstallReleaseSource } from './fetch-engine-install-release-source';

const VERSION = '0.119.0-125';
const SHA = 'c'.repeat(64);

// Node accepts request options that workerd rejects (e.g. `redirect: 'error'`), and the source falls back silently
// on any throw, so only workerd's own Request constructor proves a lookup can ever succeed on the edge.
describe('published engine installation releases in workerd', () => {
    it('sends request options the Workers runtime accepts', async () => {
        const responses = [
            Response.json({ name: 'ptbk', version: VERSION }),
            Response.json({
                tag_name: `v${VERSION}`,
                draft: false,
                published_at: '2026-11-20T09:17:27Z',
                assets: [
                    { name: `Promptbook-Setup-${VERSION}-windows-x64.exe`, state: 'uploaded', digest: `sha256:${SHA}` },
                ],
            }),
        ];
        const requests: Request[] = [];
        const releases = createFetchEngineInstallReleaseSource({
            fetch(url, init) {
                requests.push(new Request(url, init));
                const response = responses.shift();
                return response === undefined
                    ? Promise.reject(new Error('unexpected request'))
                    : Promise.resolve(response);
            },
        });
        const release = await releases.current(TEST_ENGINE_INSTALLATION, new AbortController().signal);
        expect(release).toEqual({ ...TEST_ENGINE_INSTALLATION, version: VERSION, windowsSha256: SHA });
        expect(requests.map((request) => request.redirect)).toEqual(['manual', 'manual']);
    });
});
