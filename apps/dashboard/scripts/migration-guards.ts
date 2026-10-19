import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

const run = promisify(execFile);

/** The first line a contract step must carry; the only hand edit allowed in a generated migration. */
export const CONTRACT_MARKER = /^-- contract: \S.*; unused since \S.*$/;

const DESTRUCTIVE_PATTERNS: readonly { readonly finding: string; readonly pattern: RegExp }[] = [
    { finding: 'DROP TABLE', pattern: /\bDROP\s+TABLE\b/i },
    { finding: 'DROP COLUMN', pattern: /\bDROP\s+COLUMN\b/i },
    { finding: 'RENAME', pattern: /\bRENAME\b/i },
    { finding: 'table rebuild (__new_ table)', pattern: /\b__new_\w+/i },
    { finding: 'table rebuild (PRAGMA foreign_keys=OFF)', pattern: /\bPRAGMA\s+foreign_keys\s*=\s*OFF\b/i },
];

export type DestructiveCheck =
    | { readonly kind: 'ok' }
    | { readonly kind: 'contract'; readonly findings: readonly string[] }
    | { readonly kind: 'destructive'; readonly findings: readonly string[] };

/** A migration that removes, renames or rebuilds must say so on its first line (ADR 0009, expand/contract). */
export function checkDestructive(sql: string): DestructiveCheck {
    const findings = DESTRUCTIVE_PATTERNS.filter(({ pattern }) => pattern.test(sql)).map(({ finding }) => finding);
    if (findings.length === 0) {
        return { kind: 'ok' };
    }
    const firstLine = sql.split('\n', 1)[0] ?? '';
    return CONTRACT_MARKER.test(firstLine) ? { kind: 'contract', findings } : { kind: 'destructive', findings };
}

const journalSchema = z.object({
    entries: z.array(z.object({ idx: z.number().int(), tag: z.string().regex(/^\d{4}_[a-z0-9_]+$/) })),
});

/** `migrations/` holds only drizzle-kit output: every SQL file is in the journal and has a snapshot, nothing else. */
export async function checkLayout(migrationsDir: string): Promise<readonly string[]> {
    const journal = journalSchema.parse(
        JSON.parse(await readFile(join(migrationsDir, 'meta', '_journal.json'), 'utf8')),
    );
    const expectedSql = new Set(journal.entries.map((entry) => `${entry.tag}.sql`));
    const expectedMeta = new Set([
        '_journal.json',
        ...journal.entries.map((entry) => `${entry.tag.slice(0, 4)}_snapshot.json`),
    ]);
    const problems: string[] = [];
    for (const name of await readdir(migrationsDir)) {
        if (name !== 'meta' && !expectedSql.delete(name)) {
            problems.push(`${name} is not in meta/_journal.json`);
        }
    }
    for (const name of await readdir(join(migrationsDir, 'meta'))) {
        if (!expectedMeta.delete(name)) {
            problems.push(`meta/${name} is not drizzle-kit output`);
        }
    }
    problems.push(...[...expectedSql, ...expectedMeta].map((name) => `${name} is missing`));
    return problems;
}

export type DriftCheck = { readonly kind: 'clean' } | { readonly kind: 'drift'; readonly newFiles: readonly string[] };

async function listFiles(dir: string, prefix = ''): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = `${prefix}${entry.name}`;
        out.push(...(entry.isDirectory() ? await listFiles(join(dir, entry.name), `${path}/`) : [path]));
    }
    return out;
}

/**
 * Runs `drizzle-kit check` and `drizzle-kit generate` against a copy of the migrations, so the working tree is never
 * touched. Any file generate would add means the schema changed without its migration.
 */
export async function checkDrift(args: {
    readonly appDir: string;
    readonly schemaPath: string;
    readonly migrationsDir: string;
}): Promise<DriftCheck> {
    const scratchRoot = join(args.appDir, 'node_modules', '.tmp');
    await mkdir(scratchRoot, { recursive: true });
    const scratch = await mkdtemp(join(scratchRoot, 'drift-'));
    try {
        const out = join(scratch, 'migrations');
        await cp(args.migrationsDir, out, { recursive: true });
        const before = new Set(await listFiles(out));
        const drizzleKit = join(args.appDir, 'node_modules', '.bin', 'drizzle-kit');
        // drizzle-kit prefixes `./` to its paths, so they must be relative to its working directory.
        const common = ['--dialect', 'sqlite', '--out', 'migrations'];
        await run(drizzleKit, ['check', ...common], { cwd: scratch });
        await run(drizzleKit, ['generate', ...common, '--schema', relative(scratch, args.schemaPath)], {
            cwd: scratch,
        });
        const newFiles = (await listFiles(out)).filter((file) => !before.has(file));
        return newFiles.length === 0 ? { kind: 'clean' } : { kind: 'drift', newFiles };
    } finally {
        await rm(scratch, { recursive: true, force: true });
    }
}
