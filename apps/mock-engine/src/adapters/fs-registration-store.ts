import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { RegisterEngineResponse } from '@ptbk/protocol';
import { z } from 'zod';

import type { Registration, RegistrationStore } from '../domain/registration/registration';
import { currentUid, lstatOrNull, privacyProblem, replacePrivateFile } from './private-files';

export const REGISTRATION_FILE = 'registration.json';

const MAX_FILE_BYTES = 16 * 1024;

/** What `registration.json` holds: the dashboard's response as checked, and which dashboard sent it. Never the link code. */
const StoredRegistration = z.strictObject({
    v: z.literal(1),
    dashboardUrl: z.url({ protocol: /^https$/ }).max(2048),
    ...RegisterEngineResponse.shape,
});

/** A registration file that cannot be trusted or read. Messages name the path, never its content. */
export class RegistrationStoreError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RegistrationStoreError';
    }
}

function parse(text: string): Registration | null {
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch {
        return null;
    }
    const parsed = StoredRegistration.safeParse(json);
    if (!parsed.success) return null;
    const { dashboardUrl, engineId, hostname, relays } = parsed.data;
    return Object.freeze({ dashboardUrl, engineId, hostname, relays: Object.freeze(relays) });
}

/**
 * `<dataDir>/registration.json`, mode 0600, written atomically and durably. Loading refuses a file that is not
 * private to the engine's user or does not match the strict schema, rather than registering again or guessing.
 */
export function createFsRegistrationStore(
    dataDir: string,
    options: { readonly uid?: number | null } = {},
): RegistrationStore {
    const uid = options.uid === undefined ? currentUid() : options.uid;
    const path = join(dataDir, REGISTRATION_FILE);
    return {
        async load() {
            const stats = await lstatOrNull(path);
            if (stats === null) return null;
            const problem = privacyProblem(stats, { label: REGISTRATION_FILE, path, kind: 'file' }, uid);
            if (problem !== null) throw new RegistrationStoreError(problem);
            if (stats.size > MAX_FILE_BYTES)
                throw new RegistrationStoreError(`${REGISTRATION_FILE} ${path} is too large`);
            const registration = parse(await readFile(path, 'utf8'));
            if (registration === null) {
                throw new RegistrationStoreError(`${REGISTRATION_FILE} ${path} is not a valid registration`);
            }
            return registration;
        },
        async save(registration) {
            const stored: z.input<typeof StoredRegistration> = {
                v: 1,
                ...registration,
                relays: [...registration.relays],
            };
            await replacePrivateFile(path, `${JSON.stringify(StoredRegistration.parse(stored), null, 4)}\n`);
        },
    };
}
