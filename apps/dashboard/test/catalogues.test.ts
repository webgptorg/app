import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

/** A message is plain text or Paraglide variants (plurals: declarations, selectors and a `match` table). */
const variantSchema = z.object({ match: z.record(z.string(), z.string()) });
const catalogueSchema = z.record(z.string(), z.union([z.string(), z.array(variantSchema).min(1)]));
type Message = z.infer<typeof catalogueSchema>[string];

async function catalogue(locale: string): Promise<Record<string, Message>> {
    const raw: unknown = JSON.parse(await readFile(new URL(`../messages/${locale}.json`, import.meta.url), 'utf8'));
    return Object.fromEntries(Object.entries(catalogueSchema.parse(raw)).filter(([key]) => key !== '$schema'));
}

function texts(message: Message): readonly string[] {
    return typeof message === 'string' ? [message] : message.flatMap((variant) => Object.values(variant.match));
}

async function sourceFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true, recursive: true });
    return entries
        .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name))
        .map((entry) => join(entry.parentPath, entry.name))
        .filter((path) => !path.includes('/paraglide/'));
}

describe('message catalogues', () => {
    it('have exactly the same keys in English and Czech', async () => {
        const [en, cs] = await Promise.all([catalogue('en'), catalogue('cs')]);
        expect(Object.keys(cs).sort()).toEqual(Object.keys(en).sort());
    });

    it.each(['en', 'cs'])('have no empty value in %s', async (locale) => {
        for (const [key, value] of Object.entries(await catalogue(locale))) {
            for (const text of texts(value)) {
                expect(text.trim(), key).not.toBe('');
            }
        }
    });

    it('hold every message the SPA uses, in both languages', async () => {
        const [en, cs] = await Promise.all([catalogue('en'), catalogue('cs')]);
        const files = await sourceFiles(new URL('../src/client', import.meta.url).pathname);
        const used = new Set<string>();
        for (const file of files) {
            for (const match of (await readFile(file, 'utf8')).matchAll(/\bm\.([a-z][a-z0-9_]*)\(/g)) {
                used.add(match[1] ?? '');
            }
        }
        expect(used.size).toBeGreaterThan(100);
        expect([...used].filter((key) => !(key in en) || !(key in cs))).toEqual([]);
    });
});
