import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import type { CapabilityRef } from '@ptbk/engine-api';
import { z } from 'zod';

/** The C-07 capabilities by name, each at the version this mock serves. */
export const MockCapabilityName = z.enum(['runs', 'files', 'triggers', 'integrations']);
export type MockCapabilityName = z.infer<typeof MockCapabilityName>;

export const ALL_CAPABILITY_NAMES: readonly MockCapabilityName[] = MockCapabilityName.options;

export function capabilitiesFor(names: readonly MockCapabilityName[]): readonly CapabilityRef[] {
    return [...new Set(names)].map((name) => KNOWN_CAPABILITIES[name]);
}

/** `MOCK_CAPABILITIES`: comma-separated names, or `none`. Problems name the entry, never its value. */
export function parseCapabilityList(
    text: string,
    problem: (message: string) => void,
): readonly MockCapabilityName[] | undefined {
    if (text.trim() === 'none') return [];
    const names: MockCapabilityName[] = [];
    const invalid: number[] = [];
    text.split(',').forEach((entry, index) => {
        const name = MockCapabilityName.safeParse(entry.trim());
        if (name.success) names.push(name.data);
        else invalid.push(index + 1);
    });
    for (const index of invalid) problem(`entry ${String(index)} must be one of ${ALL_CAPABILITY_NAMES.join(', ')}`);
    return invalid.length === 0 ? Object.freeze([...new Set(names)]) : undefined;
}
