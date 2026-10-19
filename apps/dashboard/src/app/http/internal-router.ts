import { Hono } from 'hono';

export const INTERNAL_MOUNT = '/internal';

/** Machine API for relays, authenticated with the relay key (D-04). */
export function createInternalRouter(): Hono {
    return new Hono();
}
