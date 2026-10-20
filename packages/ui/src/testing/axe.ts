import axe from 'axe-core';
import { expect } from 'vitest';

/** Fails with every axe-core violation in `container`. jsdom has no layout, so contrast is the contrast test's job. */
export async function expectNoAxeViolations(container: Element): Promise<void> {
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
}
