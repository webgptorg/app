import type { z } from 'zod';

import type { Bytes } from '../bytes';

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Strict UTF-8 (no BOM), JSON and schema; `undefined` for anything else. Never throws. */
export function parseJsonPayload<T>(payload: Bytes, schema: z.ZodType<T>): T | undefined {
    let json: unknown;
    try {
        json = JSON.parse(utf8.decode(payload));
    } catch {
        return undefined;
    }
    const parsed = schema.safeParse(json);
    return parsed.success ? parsed.data : undefined;
}
