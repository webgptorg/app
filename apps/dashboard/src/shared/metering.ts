import { z } from 'zod';

/**
 * What billing counts (ADR 0025). A closed list: each ID has exactly one meter in `domain/metering/meters.ts`, and a
 * stored row or a plan that names anything else fails to parse.
 */
export const METERS = ['projects', 'agents', 'members', 'people'] as const;
export const meterIdSchema = z.enum(METERS);
export type MeterId = z.infer<typeof meterIdSchema>;

export const METER_SCOPES = ['org', 'team', 'project'] as const;
export const meterScopeSchema = z.enum(METER_SCOPES);
export type MeterScope = z.infer<typeof meterScopeSchema>;
