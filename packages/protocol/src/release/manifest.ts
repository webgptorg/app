import { z } from 'zod';

import { EngineVersion } from '../ids';
import { GitCommit, Sha256Hex } from './entry';

export const UI_BUNDLE_ENTRY = 'index.html';
export const MAX_UI_BUNDLE_FILES = 4096;
export const MAX_UI_BUNDLE_PATH_LENGTH = 1024;
const MAX_CSP_LENGTH = 4096;
const MAX_ENGINE_API_RANGE_LENGTH = 128;

// Control characters and backslashes are refused so a path means the same thing on every filesystem and in a URL.
function hasUnsafeCharacter(path: string): boolean {
    for (let index = 0; index < path.length; index++) {
        const code = path.charCodeAt(index);
        if (code < 0x20 || code === 0x7f || code === 0x5c) return true;
    }
    return false;
}

/**
 * A relative path inside the bundle: 1–1,024 characters, no leading `/`, no empty, `.` or `..` segment, no backslash
 * or control character. `.` is refused too so no two spellings name the same file.
 */
export const BundlePath = z
    .string()
    .min(1)
    .max(MAX_UI_BUNDLE_PATH_LENGTH)
    .refine(
        (path) =>
            !hasUnsafeCharacter(path) &&
            path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
        'not a safe relative path',
    );

const CORE_VERSION = '(0|[1-9][0-9]{0,14})\\.(0|[1-9][0-9]{0,14})\\.(0|[1-9][0-9]{0,14})';
const COMPARATOR = `(>=|<|\\^)${CORE_VERSION}`;
const COMPARATOR_PATTERN = new RegExp(`^${COMPARATOR}$`);
const CORE_VERSION_PATTERN = new RegExp(`^${CORE_VERSION}$`);

/**
 * The `ENGINE_API_VERSION` values a bundle supports: space-separated comparators `>=X.Y.Z`, `<X.Y.Z` or `^X.Y.Z`
 * (npm caret semantics) on full versions without pre-release, all of which must hold, e.g. `>=1.0.0 <2.0.0`.
 */
export const EngineApiRange = z
    .string()
    .max(MAX_ENGINE_API_RANGE_LENGTH)
    .refine((range) => range.split(' ').every((part) => COMPARATOR_PATTERN.test(part)), 'not an engine API range');
export type EngineApiRange = z.infer<typeof EngineApiRange>;

export const UiBundleFile = z.strictObject({
    path: BundlePath,
    sha256: Sha256Hex,
    size: z.int().min(0),
});
export type UiBundleFile = z.infer<typeof UiBundleFile>;

/**
 * The manifest inside the `ui` artifact, so the loader can re-check every unpacked file. `csp` records the
 * `ENGINE_UI_CSP` the bundle was tested against and is informational only: the engine's headers are engine code.
 */
export const UiBundleManifest = z
    .strictObject({
        v: z.literal(1),
        version: EngineVersion,
        commit: GitCommit,
        engineApi: EngineApiRange,
        entry: z.literal(UI_BUNDLE_ENTRY),
        files: z.array(UiBundleFile).min(1).max(MAX_UI_BUNDLE_FILES),
        csp: z.string().max(MAX_CSP_LENGTH),
    })
    .refine((manifest) => new Set(manifest.files.map(({ path }) => path)).size === manifest.files.length, {
        message: 'file paths must be unique',
    })
    .refine((manifest) => manifest.files.some(({ path }) => path === manifest.entry), {
        message: 'the entry must be one of the files',
    });
export type UiBundleManifest = z.infer<typeof UiBundleManifest>;

type Core = readonly [number, number, number];

function core(major: string | undefined, minor: string | undefined, patch: string | undefined): Core {
    return [Number(major), Number(minor), Number(patch)];
}

function compareCore(a: Core, b: Core): number {
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function caretUpperBound([major, minor, patch]: Core): Core {
    if (major > 0) return [major + 1, 0, 0];
    if (minor > 0) return [0, minor + 1, 0];
    return [0, 0, patch + 1];
}

/** Whether `version` (`X.Y.Z`, e.g. `ENGINE_API_VERSION`) satisfies every comparator of a parsed `EngineApiRange`. */
export function satisfiesEngineApiRange(range: EngineApiRange, version: string): boolean {
    const target = CORE_VERSION_PATTERN.exec(version);
    if (target === null) return false;
    const current = core(target[1], target[2], target[3]);
    return range.split(' ').every((part) => {
        const match = COMPARATOR_PATTERN.exec(part);
        if (match === null) return false;
        const bound = core(match[2], match[3], match[4]);
        if (match[1] === '>=') return compareCore(current, bound) >= 0;
        if (match[1] === '<') return compareCore(current, bound) < 0;
        return compareCore(current, bound) >= 0 && compareCore(current, caretUpperBound(bound)) < 0;
    });
}
