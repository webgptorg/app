import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { PATHS } from './fixtures';

/** Written whole and renamed into place, so the orchestrator polling it never reads half a file. */
export function writeResult(name: string, value: unknown): void {
    const path = join(PATHS.results, name);
    writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(`${path}.tmp`, path);
}

export function log(event: string, fields: Readonly<Record<string, unknown>> = {}): void {
    process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`);
}

/** `--name value` options, every one a non-negative number unless listed in `strings`. */
export function parseOptions<N extends string, S extends string = never>(
    numbers: Readonly<Record<N, number>>,
    strings: Readonly<Record<S, string>> = {} as Record<S, string>,
): Readonly<Record<N, number> & Record<S, string>> {
    const names = [...Object.keys(numbers), ...Object.keys(strings)];
    const { values } = parseArgs({
        args: process.argv.slice(2),
        options: Object.fromEntries(names.map((name) => [name, { type: 'string' as const }])),
        strict: true,
        allowPositionals: false,
    });
    const result: Record<string, number | string> = { ...numbers, ...strings };
    for (const [name, raw] of Object.entries(values)) {
        if (typeof raw !== 'string') continue;
        if (name in strings) {
            result[name] = raw;
            continue;
        }
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed < 0) throw new RangeError(`--${name} must be a non-negative number`);
        result[name] = parsed;
    }
    return result as Record<N, number> & Record<S, string>;
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
