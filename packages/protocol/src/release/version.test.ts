import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { EngineVersion } from '../ids';
import { compareEngineVersions, versionPrecedenceKey } from './version';

const v = (text: string): EngineVersion => EngineVersion.parse(text);

describe('compareEngineVersions', () => {
    // SemVer 2.0 §11.
    const chain = [
        '1.0.0-alpha',
        '1.0.0-alpha.1',
        '1.0.0-alpha.beta',
        '1.0.0-beta',
        '1.0.0-beta.2',
        '1.0.0-beta.11',
        '1.0.0-rc.1',
        '1.0.0',
        '1.9.0',
        '1.10.0',
        '2.0.0',
        '2.0.1',
        '2.1.0',
    ];

    it.each(chain.slice(1).map((later, index) => [chain[index] ?? '', later]))('%s < %s', (earlier, later) => {
        expect(compareEngineVersions(v(earlier), v(later))).toBe(-1);
        expect(compareEngineVersions(v(later), v(earlier))).toBe(1);
    });

    it('orders every pair of the chain by position', () => {
        for (const [i, a] of chain.entries()) {
            for (const [j, b] of chain.entries()) {
                expect(compareEngineVersions(v(a), v(b))).toBe(Math.sign(i - j));
            }
        }
    });

    it('compares numeric parts beyond 2^53 exactly', () => {
        expect(compareEngineVersions(v('9007199254740993.0.0'), v('9007199254740992.0.0'))).toBe(1);
        expect(compareEngineVersions(v('1.0.0-9007199254740993'), v('1.0.0-9007199254740992'))).toBe(1);
        expect(compareEngineVersions(v('1.0.99999999999999999999'), v('1.0.99999999999999999999'))).toBe(0);
    });

    it('ranks numeric identifiers below alphanumeric ones', () => {
        expect(compareEngineVersions(v('1.0.0-999'), v('1.0.0-a'))).toBe(-1);
        expect(compareEngineVersions(v('1.0.0-a'), v('1.0.0-999'))).toBe(1);
    });

    it.each([
        ['1.2.3+a', '1.2.3'],
        ['1.2.3+a', '1.2.3+b'],
        ['1.2.3-rc.1+x', '1.2.3-rc.1'],
    ])('ignores build metadata: %s == %s', (a, b) => {
        expect(compareEngineVersions(v(a), v(b))).toBe(0);
        expect(versionPrecedenceKey(v(a))).toBe(versionPrecedenceKey(v(b)));
    });
});

const numeric = fc.oneof(fc.constant('0'), fc.integer({ min: 1, max: 12 }).map(String));
const identifier = fc.oneof(numeric, fc.constantFrom('alpha', 'beta', 'rc', 'a-b', 'x1'));
const version = fc
    .record({
        core: fc.tuple(numeric, numeric, numeric),
        prerelease: fc.array(identifier, { maxLength: 3 }),
        build: fc.option(fc.constantFrom('b1', 'sha.abc', '001'), { nil: undefined }),
    })
    .map(({ core, prerelease, build }) =>
        v(
            core.join('.') +
                (prerelease.length > 0 ? `-${prerelease.join('.')}` : '') +
                (build === undefined ? '' : `+${build}`),
        ),
    );

describe('compareEngineVersions (property)', () => {
    it('is antisymmetric and agrees with versionPrecedenceKey', () => {
        fc.assert(
            fc.property(version, version, (a, b) => {
                const order = compareEngineVersions(a, b);
                expect(compareEngineVersions(b, a)).toBe(-order || 0);
                expect(versionPrecedenceKey(a) === versionPrecedenceKey(b)).toBe(order === 0);
            }),
            { numRuns: 2000 },
        );
    });

    it('is transitive', () => {
        fc.assert(
            fc.property(version, version, version, (a, b, c) => {
                if (compareEngineVersions(a, b) <= 0 && compareEngineVersions(b, c) <= 0) {
                    expect(compareEngineVersions(a, c)).toBeLessThanOrEqual(0);
                }
            }),
        );
    });
});
