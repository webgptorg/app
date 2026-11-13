import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { srcDir } from './theme-sources.ts';

const require = createRequire(import.meta.url);

describe('self-hosted fonts', () => {
    it('are byte-identical to the pinned @fontsource-variable releases', async () => {
        const fonts = (await readdir(join(srcDir, 'fonts'))).filter((file) => file.endsWith('.woff2'));
        expect(fonts).toHaveLength(4);
        for (const font of fonts) {
            const family = font.replace(/-latin(-ext)?-wght-normal\.woff2$/, '');
            const packageDir = dirname(require.resolve(`@fontsource-variable/${family}/package.json`));
            const [ours, theirs] = await Promise.all([
                readFile(join(srcDir, 'fonts', font)),
                readFile(join(packageDir, 'files', font)),
            ]);
            expect(ours.equals(theirs), font).toBe(true);
        }
    });

    it('are all referenced by theme.css with their OFL licence alongside', async () => {
        const theme = await readFile(join(srcDir, 'theme.css'), 'utf8');
        const files = await readdir(join(srcDir, 'fonts'));
        for (const font of files.filter((file) => file.endsWith('.woff2'))) expect(theme).toContain(`./fonts/${font}`);
        expect(files.filter((file) => file.startsWith('OFL-'))).toHaveLength(2);
        expect(theme).not.toMatch(/@import\s+url\(|https?:\/\//);
    });
});
