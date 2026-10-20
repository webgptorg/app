import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

export interface SourceFile {
    /** Relative to the repo root, with forward slashes. */
    readonly path: string;
    readonly text: string;
}

const PRIMITIVE = /--ptbk-[\w-]+/g;
const COLOUR_LITERAL =
    /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})(?![\w-])|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\(/gi;

const THEME_DIR = 'packages/ui/src/theme/';
const PRIMITIVES_FILE = 'packages/ui/src/theme/primitives.css';

/**
 * ADR 0015's boundary: primitives (`--ptbk-*`) appear only in the theme, colour literals only in primitives.css.
 * Everything else, in both modules, uses semantic or component tokens.
 */
export function findTokenViolations(files: readonly SourceFile[]): string[] {
    const violations: string[] = [];
    for (const { path, text } of files) {
        if (!path.startsWith(THEME_DIR)) {
            for (const [match] of text.matchAll(PRIMITIVE)) violations.push(`${path}: primitive ${match}`);
        }
        if (path !== PRIMITIVES_FILE) {
            for (const [match] of text.matchAll(COLOUR_LITERAL)) violations.push(`${path}: colour literal ${match}`);
        }
    }
    return violations;
}

const SCANNED = /\.(ts|tsx|css)$/;
const SKIPPED = /(\.test\.tsx?$|\/testing\/|\/paraglide\/|routeTree\.gen\.ts$)/;

/** The shipped sources of a module: code and styles, without tests, test helpers or generated files. */
export async function readSources(repoRoot: string, dir: string): Promise<SourceFile[]> {
    const entries = await readdir(join(repoRoot, dir), { recursive: true });
    const paths = entries
        .map((entry) =>
            relative(repoRoot, join(repoRoot, dir, entry))
                .split(sep)
                .join('/'),
        )
        .filter((path) => SCANNED.test(path) && !SKIPPED.test(path))
        .sort();
    return Promise.all(paths.map(async (path) => ({ path, text: await readFile(join(repoRoot, path), 'utf8') })));
}
