import type { EngineVersion } from '../ids';

interface ParsedVersion {
    readonly core: readonly [string, string, string];
    readonly prerelease: readonly string[];
}

function parse(version: EngineVersion): ParsedVersion {
    const withoutBuild = version.split('+', 1)[0] ?? '';
    const dash = withoutBuild.indexOf('-');
    const core = (dash < 0 ? withoutBuild : withoutBuild.slice(0, dash)).split('.');
    return {
        core: [core[0] ?? '', core[1] ?? '', core[2] ?? ''],
        prerelease: dash < 0 ? [] : withoutBuild.slice(dash + 1).split('.'),
    };
}

const NUMERIC = /^[0-9]+$/;

// Digit strings without leading zeros (the EngineVersion grammar), compared without Number so any length is exact.
function compareNumeric(a: string, b: string): number {
    if (a.length !== b.length) return a.length < b.length ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
}

function compareIdentifier(a: string, b: string): number {
    const aNumeric = NUMERIC.test(a);
    const bNumeric = NUMERIC.test(b);
    if (aNumeric && bNumeric) return compareNumeric(a, b);
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
}

/** SemVer 2.0 precedence (§11): build metadata is ignored, so `1.2.3+a` and `1.2.3` compare equal. */
export function compareEngineVersions(a: EngineVersion, b: EngineVersion): -1 | 0 | 1 {
    const left = parse(a);
    const right = parse(b);
    for (let index = 0; index < 3; index++) {
        const order = compareNumeric(left.core[index] ?? '', right.core[index] ?? '');
        if (order !== 0) return order < 0 ? -1 : 1;
    }
    if (left.prerelease.length === 0 || right.prerelease.length === 0) {
        if (left.prerelease.length === right.prerelease.length) return 0;
        return left.prerelease.length === 0 ? 1 : -1;
    }
    const shared = Math.min(left.prerelease.length, right.prerelease.length);
    for (let index = 0; index < shared; index++) {
        const order = compareIdentifier(left.prerelease[index] ?? '', right.prerelease[index] ?? '');
        if (order !== 0) return order < 0 ? -1 : 1;
    }
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length < right.prerelease.length ? -1 : 1;
}

/**
 * Equal for exactly the versions `compareEngineVersions` finds equal: the grammar forbids leading zeros, so dropping
 * build metadata leaves one spelling per precedence.
 */
export function versionPrecedenceKey(version: EngineVersion): string {
    return version.split('+', 1)[0] ?? '';
}
