import { describe, expect, it } from 'vitest';

import { TEST_ENGINE_INSTALLATION } from '../../testing/install-fixtures';
import { renderInstallScript } from './install-scripts';
import { INSTALL_SCRIPT_PATHS, type InstallScript } from './installation-options';

const ORIGIN = 'https://app.ptbk.test:8444';
const SCRIPTS = Object.keys(INSTALL_SCRIPT_PATHS) as InstallScript[];

describe('install scripts', () => {
    it.each(SCRIPTS)('fills in every value of the %s script and carries no pairing data', (script) => {
        const text = renderInstallScript(script, TEST_ENGINE_INSTALLATION, ORIGIN);
        expect(text).not.toContain('__PTBK_');
        expect(text).toContain(`'${TEST_ENGINE_INSTALLATION.version}'`);
        expect(text).toContain(`${ORIGIN}/link#`);
        expect(text).not.toMatch(/[a-z2-7]{25}[aeimquy4]\b/);
    });

    it.each(SCRIPTS)('runs nothing in the %s script before its last line', (script) => {
        const text = renderInstallScript(script, TEST_ENGINE_INSTALLATION, ORIGIN);
        expect(text.endsWith(script === 'windows' ? '\n}\n' : '\nmain "$@"\n')).toBe(true);
        if (script !== 'windows') {
            const topLevel = text.split('\n').filter((line) => /^[^\s#})]/.test(line) && !/^\w+\(\) /.test(line));
            expect(topLevel).toEqual(['set -euo pipefail', 'main "$@"']);
        }
    });

    it('pins the verified artifacts of the selected release', () => {
        const release = TEST_ENGINE_INSTALLATION;
        expect(renderInstallScript('windows', release, ORIGIN)).toContain(`-ne '${release.windowsSha256}'`);
        const server = renderInstallScript('server', release, ORIGIN);
        expect(server).toContain(`/webgptorg/promptbook/${release.bootstrapRevision}/deploy/ubuntu/install.sh`);
        expect(server).toContain(`'${release.bootstrapSha256}'`);
    });

    it('refuses a value that could leave its quotes', () => {
        expect(() => renderInstallScript('desktop', TEST_ENGINE_INSTALLATION, "https://a.test/'$(id)")).toThrow(
            /unsafe __PTBK_ORIGIN__/,
        );
    });
});
