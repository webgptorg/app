import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import type { CapabilityRef } from '@ptbk/engine-api';
import type { FileUploadPolicies } from '@ptbk/engine-api/in-memory';
import { z } from 'zod';

/** The capabilities by their IDs, each at the version this mock serves. */
const MOCK_CAPABILITIES = {
    runs: KNOWN_CAPABILITIES.runs,
    files: KNOWN_CAPABILITIES.files,
    triggers: KNOWN_CAPABILITIES.triggers,
    integrations: KNOWN_CAPABILITIES.integrations,
    'test-chat': KNOWN_CAPABILITIES.testChat,
    'access-requests': KNOWN_CAPABILITIES.accessRequests,
    'file-scanning': KNOWN_CAPABILITIES.fileScanning,
} as const satisfies Readonly<Record<string, CapabilityRef>>;

export const MockCapabilityName = z.enum(
    Object.keys(MOCK_CAPABILITIES) as [keyof typeof MOCK_CAPABILITIES, ...(keyof typeof MOCK_CAPABILITIES)[]],
);
export type MockCapabilityName = z.infer<typeof MockCapabilityName>;

export const ALL_CAPABILITY_NAMES: readonly MockCapabilityName[] = MockCapabilityName.options;

/** What the mock advertises unless told otherwise: everything but malware scanning, which needs a scanner service. */
export const DEFAULT_CAPABILITY_NAMES: readonly MockCapabilityName[] = ALL_CAPABILITY_NAMES.filter(
    (name) => name !== 'file-scanning',
);

export function capabilitiesFor(names: readonly MockCapabilityName[]): readonly CapabilityRef[] {
    return [...new Set(names)].map((name) => MOCK_CAPABILITIES[name]);
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

/**
 * What `files@1` accepts: knowledge is limited to documents an agent can read, like a real engine's ingestion would
 * be, and to 10 MiB; every other purpose takes any type up to the contract's `MAX_FILE_BYTES`.
 */
export const MOCK_UPLOAD_POLICIES: FileUploadPolicies = {
    knowledge: {
        maxBytes: 10 * 1024 * 1024,
        accept: [
            '.pdf',
            '.txt',
            '.md',
            '.markdown',
            '.csv',
            '.json',
            '.html',
            '.htm',
            '.docx',
            '.odt',
            '.rtf',
            'application/pdf',
            'text/*',
            'application/json',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.oasis.opendocument.text',
        ],
    },
};
