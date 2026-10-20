import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { INITIAL_WINDOW_BYTES } from './constants';
import { MAX_WINDOW_BYTES, createReceiveWindow, createSendWindow } from './window';

const OK = { kind: 'ok' };
const VIOLATION = { kind: 'violation' };

describe.each([
    ['send', createSendWindow],
    ['receive', createReceiveWindow],
])('%s window', (_, createWindow) => {
    it('starts with the initial credit', () => {
        expect(createWindow(INITIAL_WINDOW_BYTES).available()).toBe(INITIAL_WINDOW_BYTES);
    });

    it('accepts consuming exactly the credit', () => {
        const window = createWindow(INITIAL_WINDOW_BYTES);
        expect(window.consume(INITIAL_WINDOW_BYTES)).toEqual(OK);
        expect(window.available()).toBe(0);
    });

    it('reports one byte beyond the credit as a violation and keeps the credit', () => {
        const window = createWindow(INITIAL_WINDOW_BYTES);
        expect(window.consume(INITIAL_WINDOW_BYTES + 1)).toEqual(VIOLATION);
        expect(window.available()).toBe(INITIAL_WINDOW_BYTES);
        expect(window.consume(INITIAL_WINDOW_BYTES - 10)).toEqual(OK);
        expect(window.consume(11)).toEqual(VIOLATION);
        expect(window.available()).toBe(10);
    });

    it('accumulates grants', () => {
        const window = createWindow(0);
        expect(window.grant(100)).toEqual(OK);
        expect(window.grant(50)).toEqual(OK);
        expect(window.available()).toBe(150);
        expect(window.consume(150)).toEqual(OK);
    });

    it('lets credit reach 2^31-1 but never overflow it', () => {
        const window = createWindow(INITIAL_WINDOW_BYTES);
        expect(window.grant(MAX_WINDOW_BYTES - INITIAL_WINDOW_BYTES)).toEqual(OK);
        expect(window.available()).toBe(2 ** 31 - 1);
        expect(window.grant(1)).toEqual(VIOLATION);
        expect(window.available()).toBe(2 ** 31 - 1);
        expect(createWindow(1).grant(MAX_WINDOW_BYTES)).toEqual(VIOLATION);
    });

    it.each([0, -1, 1.5, Number.NaN, MAX_WINDOW_BYTES + 1])('throws on a byte count of %d', (bytes) => {
        const window = createWindow(10);
        expect(() => window.consume(bytes)).toThrow(RangeError);
        expect(() => window.grant(bytes)).toThrow(RangeError);
    });

    it.each([-1, 0.5, MAX_WINDOW_BYTES + 1])('throws on an initial credit of %d', (initial) => {
        expect(() => createWindow(initial)).toThrow(RangeError);
    });

    it('stays within 0..2^31-1 under any sequence of operations', () => {
        const operation = fc.tuple(fc.boolean(), fc.integer({ min: 1, max: MAX_WINDOW_BYTES }));
        fc.assert(
            fc.property(fc.integer({ min: 0, max: MAX_WINDOW_BYTES }), fc.array(operation), (initial, operations) => {
                const window = createWindow(initial);
                let expected = initial;
                for (const [isGrant, bytes] of operations) {
                    const result = isGrant ? window.grant(bytes) : window.consume(bytes);
                    const allowed = isGrant ? expected + bytes <= MAX_WINDOW_BYTES : bytes <= expected;
                    expect(result).toEqual(allowed ? OK : VIOLATION);
                    if (allowed) expected += isGrant ? bytes : -bytes;
                    expect(window.available()).toBe(expected);
                }
            }),
        );
    });
});
