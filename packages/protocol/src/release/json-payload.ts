import type { z } from 'zod';

import type { Bytes } from '../bytes';
import { hasDuplicateJsonKeys } from './json-duplicate-keys';

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Strict UTF-8 (no BOM), JSON without duplicate keys, and schema; `undefined` for anything else. Never throws. */
export function parseJsonPayload<T>(payload: Bytes, schema: z.ZodType<T>): T | undefined {
    let json: unknown;
    try {
        const text = utf8.decode(payload);
        if (hasDuplicateJsonKeys(text)) return undefined;
        json = JSON.parse(text);
    } catch {
        return undefined;
    }
    const parsed = schema.safeParse(json);
    return parsed.success ? parsed.data : undefined;
}
