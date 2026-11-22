import { describe, expect, it } from 'vitest';

import {
    createClickCounter,
    createInputBudget,
    heldButton,
    liveKey,
    pressedButton,
    toTabPoint,
    wheelDelta,
} from './live-input';

const BOX = { left: 10, top: 20, width: 640, height: 400 };
const VIEWPORT = { width: 1280, height: 800 };
const key = (value: string, modifiers: Partial<Record<'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey', boolean>> = {}) =>
    liveKey({ key: value, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...modifiers });

describe('live input', () => {
    it('scales a point on the picture to the tab and clamps it to the viewport', () => {
        expect(toTabPoint(330, 220, BOX, VIEWPORT)).toEqual({ x: 640, y: 400 });
        expect(toTabPoint(0, 0, BOX, VIEWPORT)).toEqual({ x: 0, y: 0 });
        expect(toTabPoint(2000, 2000, BOX, VIEWPORT)).toEqual({ x: 1280, y: 800 });
        expect(toTabPoint(10.5, 20, BOX, VIEWPORT)).toEqual({ x: 1, y: 0 });
        expect(toTabPoint(1, 1, { ...BOX, width: 0 }, VIEWPORT)).toBeNull();
    });

    it('names the buttons the contract knows', () => {
        expect([0, 1, 2, 3, 4].map(pressedButton)).toEqual(['left', 'middle', 'right', null, null]);
        expect([0, 1, 2, 4, 3].map(heldButton)).toEqual(['none', 'left', 'right', 'middle', 'left']);
    });

    it('turns wheel lines and pages into bounded pixels', () => {
        expect(wheelDelta(120, 0)).toBe(120);
        expect(wheelDelta(3, 1)).toBe(48);
        expect(wheelDelta(-1, 2)).toBe(-800);
        expect(wheelDelta(1e9, 0)).toBe(10_000);
    });

    it('sends named keys and one printable character, with Shift as the only modifier', () => {
        expect(key('Enter')).toEqual({ key: 'Enter', shift: false });
        expect(key('A', { shiftKey: true })).toEqual({ key: 'A', shift: true });
        expect(key('ž')).toEqual({ key: 'ž', shift: false });
        expect(key(' ')).toEqual({ key: ' ', shift: false });
        for (const refused of ['F12', 'Shift', 'Control', 'Dead', 'Unidentified', '\u0007'])
            expect(key(refused)).toBeNull();
        expect(key('c', { ctrlKey: true })).toBeNull();
        expect(key('v', { metaKey: true })).toBeNull();
        expect(key('p', { altKey: true })).toBeNull();
        expect(key('Backspace', { altKey: true })).toBeNull();
        expect(key('@', { altKey: true })).toEqual({ key: '@', shift: false });
        const altGraph = (value: string) =>
            liveKey({
                key: value,
                shiftKey: false,
                ctrlKey: true,
                metaKey: false,
                altKey: true,
                getModifierState: (name) => name === 'AltGraph',
            });
        expect(altGraph('@')).toEqual({ key: '@', shift: false });
        expect(altGraph('ą')).toEqual({ key: 'ą', shift: false });
        expect(altGraph('c')).toBeNull();
        expect(key('@', { ctrlKey: true, altKey: true })).toBeNull();
        expect(key('@', { metaKey: true, altKey: true })).toBeNull();
        expect(
            liveKey({ key: 'a', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: true }),
        ).toBeNull();
    });

    it('counts a double and a triple click, and starts over when far or late', () => {
        let now = 0;
        const count = createClickCounter(() => now);
        expect(count(10, 10)).toBe(1);
        now = 200;
        expect(count(11, 11)).toBe(2);
        now = 400;
        expect(count(11, 11)).toBe(3);
        now = 500;
        expect(count(11, 11)).toBe(3);
        expect(count(100, 11)).toBe(1);
        now = 2_000;
        expect(count(100, 11)).toBe(1);
    });

    it('stays under the engine’s rate in any second, letting presses outlast moves', () => {
        let now = 0;
        const budget = createInputBudget(() => now);
        let moves = 0;
        for (let index = 0; index < 200; index++) if (budget(false)) moves++;
        expect(moves).toBe(90);
        let presses = 0;
        for (let index = 0; index < 50; index++) if (budget(true)) presses++;
        expect(moves + presses).toBe(112);
        now = 999;
        expect(budget(true)).toBe(false);
        now = 1_000;
        expect(budget(false)).toBe(true);
    });
});
