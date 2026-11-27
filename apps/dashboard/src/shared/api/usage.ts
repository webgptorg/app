import { EngineId } from '@ptbk/protocol';
import { z } from 'zod';

import { overLimitSchema } from '../billing';
import { METERS, meterIdSchema } from '../metering';

/** Days of history `GET /api/usage` answers, today included. */
export const USAGE_HISTORY_DAYS = 31;

const countSchema = z.int().nonnegative();
const meterCountSchema = z.strictObject({ value: countSchema, unreported: countSchema });
const limitSchema = countSchema.nullable();

/** ADR 0025's meters: counts and limits only, never what was counted. Read-only. */
export const usageViewSchema = z.strictObject({
    overLimit: overLimitSchema,
    meters: z
        .array(
            z.strictObject({
                meter: meterIdSchema,
                /** Null is unlimited, and so is a scope the meter has no quota for. */
                limits: z.strictObject({ org: limitSchema, project: limitSchema }),
                org: meterCountSchema,
                teams: z.array(meterCountSchema.extend({ teamId: z.string() })),
                projects: z.array(meterCountSchema.extend({ engineId: EngineId })),
            }),
        )
        .length(METERS.length),
    /** The organization's totals per UTC day, oldest first: the day's latest value and its peak. */
    history: z.array(
        z.strictObject({
            day: z.iso.date(),
            meter: meterIdSchema,
            value: countSchema,
            unreported: countSchema,
            peak: countSchema,
        }),
    ),
});
export type UsageView = z.infer<typeof usageViewSchema>;
