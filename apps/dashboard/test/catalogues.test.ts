import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const catalogueSchema = z.record(z.string(), z.string());

async function catalogue(locale: string): Promise<Record<string, string>> {
    const raw: unknown = JSON.parse(await readFile(new URL(`../messages/${locale}.json`, import.meta.url), 'utf8'));
    return Object.fromEntries(Object.entries(catalogueSchema.parse(raw)).filter(([key]) => key !== '$schema'));
}

describe('message catalogues', () => {
    it('have exactly the same keys in English and Czech', async () => {
        const [en, cs] = await Promise.all([catalogue('en'), catalogue('cs')]);
        expect(Object.keys(cs).sort()).toEqual(Object.keys(en).sort());
    });

    it.each(['en', 'cs'])('have no empty value in %s', async (locale) => {
        for (const [key, value] of Object.entries(await catalogue(locale))) {
            expect(value.trim(), key).not.toBe('');
        }
    });
});
