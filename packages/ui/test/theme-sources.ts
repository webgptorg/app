import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseTokenSheet } from '../src/theme/tokens.ts';
import type { TokenSheet } from '../src/theme/tokens.ts';

export const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');
export const srcDir = join(packageDir, 'src');
export const PRIMITIVES = join(srcDir, 'theme', 'primitives.css');

export async function componentCssFiles(): Promise<string[]> {
    const entries = await readdir(join(srcDir, 'components'), { recursive: true });
    return entries
        .filter((entry) => entry.endsWith('.css') && entry !== 'tokens.css')
        .map((entry) => join(srcDir, 'components', entry))
        .sort();
}

/** The three token layers as the browser cascades them, with `primitivesFile` standing in for primitives.css. */
export async function loadTokenSheet(primitivesFile = PRIMITIVES): Promise<TokenSheet> {
    const files = [primitivesFile, join(srcDir, 'theme', 'semantic.css'), ...(await componentCssFiles())];
    return parseTokenSheet(...(await Promise.all(files.map((file) => readFile(file, 'utf8')))));
}
