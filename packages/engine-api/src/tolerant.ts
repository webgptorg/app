import { z } from 'zod';

type Def = Readonly<Record<string, unknown>>;

function defOf(schema: z.core.$ZodType): Def {
    return schema._zod.def as unknown as Def;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A copy of `value` without the object keys `schema` does not declare, at every depth. Values the schema does not
 * expect are returned unchanged, so the strict parse that follows reports them. Union members are tried in order and
 * the first one that parses after stripping wins.
 */
export function stripUnknownFields(schema: z.core.$ZodType, value: unknown): unknown {
    const def = defOf(schema);
    switch (def['type']) {
        case 'object': {
            if (!isRecord(value)) return value;
            const shape = def['shape'] as Readonly<Record<string, z.core.$ZodType>>;
            const stripped: Record<string, unknown> = {};
            for (const [key, fieldSchema] of Object.entries(shape)) {
                if (key in value) stripped[key] = stripUnknownFields(fieldSchema, value[key]);
            }
            return stripped;
        }
        case 'array':
            return Array.isArray(value)
                ? value.map((item: unknown) => stripUnknownFields(def['element'] as z.core.$ZodType, item))
                : value;
        case 'union':
            for (const option of def['options'] as readonly z.core.$ZodType[]) {
                const candidate = stripUnknownFields(option, value);
                if (z.safeParse(option, candidate).success) return candidate;
            }
            return value;
        case 'pipe':
            return stripUnknownFields(def['in'] as z.core.$ZodType, value);
        case 'nullable':
        case 'optional':
        case 'default':
        case 'prefault':
        case 'readonly':
        case 'nonoptional':
            return value === null || value === undefined
                ? value
                : stripUnknownFields(def['innerType'] as z.core.$ZodType, value);
        default:
            return value;
    }
}

/**
 * The tolerant reader for a strict response schema (ADR 0010 §3): unknown object keys are dropped at every depth, then
 * the strict schema validates every field it knows, with all its checks and brands. Engines keep checking responses
 * against the strict schema itself, so drift is still caught where it is introduced.
 */
export function toTolerant<Schema extends z.ZodType>(schema: Schema): z.ZodType<z.output<Schema>> {
    return z.preprocess((value) => stripUnknownFields(schema, value), schema);
}
