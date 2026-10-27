import { describe, expect, it } from 'vitest';

import type { ConformanceCheck, ConformanceSuite } from './check';
import { Findings, fail, notImplemented, skip } from './check';
import { createSeededRandom, randomSeed, randomToken } from './random';
import { summarize, writeJsonReport, writeJunitReport } from './report';
import { runConformance } from './runner';
import type { ConformanceTarget } from './target';

const target: ConformanceTarget = {
    baseUrl: new URL('https://engine.test'),
    fetch: () => Promise.reject(new Error('no network in this test')),
    session: () => Promise.resolve(null),
};

function check(id: string, run: ConformanceCheck['run']): ConformanceCheck {
    return { id, suite: 'test', title: `Title of ${id}`, run };
}

function suite(...checks: ConformanceCheck[]): ConformanceSuite {
    return { id: 'test', checks };
}

const options = { target, timeoutMs: 1000, signal: new AbortController().signal, seed: 1 };

describe('runConformance', () => {
    it('turns thrown failures, skips and unexpected errors into outcomes', async () => {
        const report = await runConformance({
            ...options,
            suites: [
                suite(
                    check('t.a.pass', () => Promise.resolve({ kind: 'pass' })),
                    check('t.a.fail', () => fail('it broke')),
                    check('t.a.skip', () => skip('not here')),
                    check('t.a.error', () => Promise.reject(new TypeError('fetch failed'))),
                    // An engine-side library may reject with a plain value; the runner must not crash on it.
                    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
                    check('t.a.odd', () => Promise.reject('not an error')),
                ),
            ],
        });
        expect(report.results.map(({ outcome }) => outcome)).toEqual([
            { kind: 'pass' },
            { kind: 'fail', detail: 'it broke' },
            { kind: 'skip', reason: 'not here' },
            { kind: 'fail', detail: 'unexpected TypeError: fetch failed' },
            { kind: 'fail', detail: 'unexpected error' },
        ]);
        expect(summarize(report)).toEqual({ passed: 1, failed: 3, skipped: 1 });
        expect(report.seed).toBe(1);
        expect(report.engineVersion).toBeNull();
    });

    it('times out a check that ignores its signal, and still runs its cleanup newest first', async () => {
        const order: string[] = [];
        const report = await runConformance({
            ...options,
            timeoutMs: 20,
            suites: [
                suite(
                    check('t.a.slow', (ctx) => {
                        ctx.resources.defer(() => Promise.resolve(order.push('first')));
                        ctx.resources.defer(() => Promise.resolve(order.push('second')));
                        ctx.resources.defer(() => Promise.reject(new Error('cleanup broke')));
                        return new Promise(() => undefined);
                    }),
                ),
            ],
        });
        expect(report.results[0]?.outcome).toEqual({ kind: 'fail', detail: 'timed out after 20 ms' });
        expect(report.results[0]?.cleanupFailures).toBe(1);
        expect(order).toEqual(['second', 'first']);
    });

    it('runs only the filtered checks, reports each one and finds the engine version', async () => {
        const seen: string[] = [];
        const report = await runConformance({
            ...options,
            suites: [
                // Never asked: the suite runs no check.
                { id: 'none', checks: [], engineVersion: () => Promise.resolve('0.0.0') },
                {
                    ...suite(
                        check('t.a.one', () => Promise.resolve({ kind: 'pass' })),
                        notImplemented({ id: 't.a.two', suite: 'test', title: 'Later' }),
                    ),
                    engineVersion: () => Promise.resolve('1.2.3'),
                },
                {
                    ...suite(check('t.b.unselected', () => fail('not selected'))),
                    engineVersion: () => Promise.reject(new Error('never asked')),
                },
            ],
            filter: ({ id }) => id === 't.a.two',
            onResult: ({ id }) => seen.push(id),
        });
        expect(seen).toEqual(['t.a.two']);
        expect(report.results[0]?.outcome).toEqual({ kind: 'skip', reason: 'not-implemented' });
        expect(report.engineVersion).toBe('1.2.3');
    });

    it('treats a failing version probe as unknown', async () => {
        const report = await runConformance({
            ...options,
            suites: [
                {
                    ...suite(check('t.a.x', () => Promise.resolve({ kind: 'pass' }))),
                    engineVersion: () => Promise.reject(new Error('down')),
                },
            ],
        });
        expect(report.engineVersion).toBeNull();
        expect(
            Number.isInteger((await runConformance({ ...options, seed: undefined as never, suites: [] })).seed),
        ).toBe(true);
    });

    it('stops when the run is cancelled', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(
            runConformance({
                ...options,
                signal: controller.signal,
                suites: [suite(check('t.a.x', () => fail('no')))],
            }),
        ).rejects.toThrow();
    });
});

describe('Findings', () => {
    it('passes when empty and shows at most twenty findings', () => {
        const findings = new Findings();
        expect(findings.outcome()).toEqual({ kind: 'pass' });
        for (let index = 0; index < 22; index++) findings.add(`finding ${String(index)}`);
        const outcome = findings.outcome();
        expect(outcome.kind === 'fail' && outcome.detail.split('\n')).toHaveLength(21);
        expect(outcome.kind === 'fail' && outcome.detail.endsWith('… and 2 more')).toBe(true);
    });
});

describe('reports', () => {
    it('writes JUnit with escaped text, one suite per suite and the right counts', async () => {
        const report = await runConformance({
            ...options,
            suites: [
                suite(
                    check('t.a.pass', () => Promise.resolve({ kind: 'pass' })),
                    check('t.a.fail', () => fail('a <b> & "c"\n\u0000second line')),
                ),
                { id: 'later', checks: [notImplemented({ id: 'l.a.b', suite: 'later', title: "It's later" })] },
            ],
        });
        const xml = writeJunitReport(report);
        expect(xml).toContain('<testsuites name="ptbk-conformance" tests="3" failures="1" skipped="1"');
        expect(xml).toContain('<testsuite name="test" tests="2" failures="1" skipped="0"');
        expect(xml).toContain('<failure message="a &lt;b&gt; &amp; &quot;c&quot;">Title of t.a.fail\na &lt;b&gt;');
        expect(xml).not.toContain('\u0000');
        expect(xml).toContain('<skipped message="not-implemented"/>');
        const json = JSON.parse(writeJsonReport(report)) as { summary: unknown; results: unknown[] };
        expect(json.summary).toEqual({ passed: 1, failed: 1, skipped: 1 });
        expect(json.results).toHaveLength(3);
    });
});

describe('createSeededRandom', () => {
    it('repeats for a seed, differs across seeds and refuses bad input', () => {
        expect(createSeededRandom(5).bytes(16)).toEqual(createSeededRandom(5).bytes(16));
        expect(createSeededRandom(5).bytes(16)).not.toEqual(createSeededRandom(6).bytes(16));
        expect(() => createSeededRandom(-1)).toThrow(RangeError);
        expect(() => createSeededRandom(2 ** 32)).toThrow(RangeError);
        expect(() => createSeededRandom(1).bytes(-1)).toThrow(RangeError);
        expect(randomToken(createSeededRandom(1), 40)).toMatch(/^[a-z0-9]{40}$/);
        expect(randomSeed()).toBeGreaterThanOrEqual(0);
    });
});
