import { describe, expect, it } from 'vitest';

import { createMemoryBudget, createMemoryCharge } from './memory-budget';

describe('createMemoryBudget', () => {
    it('is over once more than the budget is held', () => {
        const budget = createMemoryBudget(800);
        budget.adjust(700);
        expect([budget.hasRoomFor(100), budget.hasRoomFor(101)]).toEqual([true, false]);
        budget.adjust(100);
        expect(budget.isOver()).toBe(false);
        budget.adjust(1);
        expect([budget.used(), budget.isOver()]).toEqual([801, true]);
    });

    it('wakes waiters once usage is back within the budget, and not those cancelled', () => {
        const budget = createMemoryBudget(800);
        budget.adjust(1000);
        const woken: string[] = [];
        budget.whenRelieved(() => woken.push('a'));
        budget.whenRelieved(() => woken.push('b'));
        const cancel = budget.whenRelieved(() => woken.push('cancelled'));
        cancel();
        budget.adjust(-150);
        budget.adjust(50);
        expect(woken).toEqual([]);
        budget.adjust(-100);
        expect(budget.used()).toBe(800);
        expect(woken).toEqual(['a', 'b']);
        budget.adjust(-100);
        expect(woken).toEqual(['a', 'b']);
    });

    it('lets a waiter wait again from inside its callback', () => {
        const budget = createMemoryBudget(800);
        budget.adjust(900);
        let wakes = 0;
        const wait = (): void => {
            wakes++;
            budget.whenRelieved(wait);
        };
        budget.whenRelieved(wait);
        budget.adjust(-500);
        expect(wakes).toBe(1);
        budget.adjust(500);
        budget.adjust(-500);
        expect(wakes).toBe(2);
    });
});

describe('createMemoryCharge', () => {
    it('reports each holder by its current size', () => {
        const budget = createMemoryBudget(1000);
        const first = createMemoryCharge(budget);
        const second = createMemoryCharge(budget);
        first.set(300);
        second.set(200);
        first.set(100);
        first.set(100);
        expect(budget.used()).toBe(300);
        first.set(0);
        second.set(0);
        expect(budget.used()).toBe(0);
    });
});
