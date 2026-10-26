import { EngineId } from '@ptbk/protocol';
import { z } from 'zod';

/**
 * R-07: where each relay reports the engines it holds a ready tunnel for. Ours on both ends (relay and dashboard), so
 * the schema lives here and in the relay's adapter, not in `@ptbk/protocol`.
 */
export const RELAY_PRESENCE_PATH = '/internal/v1/relays/presence';

/** The relay default of 10,000 connections, tunnels included, so a full relay still fits in one report. */
export const MAX_PRESENCE_ENGINE_IDS = 10_000;

const ENGINE_ID_CHARS = 26;

/**
 * Compact JSON of a report at the cap, plus one byte: the envelope and a quoted ID with its comma per engine. One ID
 * more no longer fits, so a report over the cap is refused as too large (413) before anything parses it.
 */
export const RELAY_PRESENCE_MAX_BODY_BYTES =
    '{"v":1,"engineIds":[]}'.length + MAX_PRESENCE_ENGINE_IDS * (ENGINE_ID_CHARS + 3);

/** A relay's full list, never a delta, so a lost report heals at the next one. The relay ID comes from its key. */
export const RelayPresenceReport = z.strictObject({
    v: z.literal(1),
    engineIds: z
        .array(EngineId)
        .max(MAX_PRESENCE_ENGINE_IDS)
        .refine((ids) => new Set(ids).size === ids.length, 'engine IDs must be unique'),
});
export type RelayPresenceReport = z.infer<typeof RelayPresenceReport>;
