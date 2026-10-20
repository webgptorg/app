import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { AgentId, Timestamp } from './common';
import { stripUnknownFields, toTolerant } from './tolerant';

const Shape = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('circle'), radius: z.number().min(0) }),
    z.strictObject({ kind: z.literal('square'), side: z.number().min(0) }),
]);

const Doc = z.strictObject({
    id: AgentId,
    at: Timestamp,
    title: z.string().max(5),
    tags: z.array(z.strictObject({ name: z.string() })),
    parent: z.strictObject({ id: AgentId }).nullable(),
    note: z.strictObject({ text: z.string() }).optional(),
    labels: z.array(z.string()).default([]),
    shape: Shape,
    counted: z
        .strictObject({ items: z.array(z.string()) })
        .transform(({ items }) => items.length)
        .pipe(z.number()),
});

const valid = {
    id: 'agent-1',
    at: '2026-10-20T08:00:00Z',
    title: 'Hi',
    tags: [{ name: 'a' }],
    parent: { id: 'agent-0' },
    note: { text: 'n' },
    labels: ['x'],
    shape: { kind: 'square', side: 2 },
    counted: { items: ['a', 'b'] },
};

const withExtras = {
    ...valid,
    added: true,
    tags: [{ name: 'a', color: 'red' }],
    parent: { id: 'agent-0', depth: 1 },
    note: { text: 'n', pinned: true },
    shape: { kind: 'square', side: 2, rotation: 45 },
    counted: { items: ['a', 'b'], total: 2 },
};

describe('toTolerant', () => {
    it('strips unknown fields at every depth and keeps every known one', () => {
        const strict = Doc.safeParse(withExtras);
        expect(strict.success).toBe(false);
        expect(toTolerant(Doc).parse(withExtras)).toEqual({ ...valid, counted: 2 });
    });

    it('passes through null, missing optional and defaulted fields', () => {
        const partial: Record<string, unknown> = { ...withExtras, parent: null };
        delete partial['note'];
        delete partial['labels'];
        expect(toTolerant(Doc).parse(partial)).toMatchObject({ parent: null, labels: [] });
    });

    it('picks the union member that matches after stripping', () => {
        expect(toTolerant(Shape).parse({ kind: 'circle', radius: 1, colour: 'red' })).toEqual({
            kind: 'circle',
            radius: 1,
        });
        expect(toTolerant(Shape).safeParse({ kind: 'triangle', side: 1 }).success).toBe(false);
    });

    it.each([
        ['a wrong type', { title: 42 }],
        ['a failed check', { title: 'too long' }],
        ['a bad brand', { id: 'not an id!' }],
        ['a bad timestamp', { at: 'yesterday' }],
        ['a nested failed check', { shape: { kind: 'square', side: -1, extra: 1 } }],
        ['a non-object where an object is expected', { parent: 'agent-0' }],
        ['a non-array where an array is expected', { tags: { name: 'a' } }],
    ])('still rejects %s', (_label, patch) => {
        expect(toTolerant(Doc).safeParse({ ...withExtras, ...patch }).success).toBe(false);
    });

    it('rejects a missing required field', () => {
        const partial: Partial<typeof withExtras> = { ...withExtras };
        delete partial.title;
        expect(toTolerant(Doc).safeParse(partial).success).toBe(false);
    });
});

describe('stripUnknownFields', () => {
    it('returns values the schema does not expect unchanged, for the strict parse to report', () => {
        expect(stripUnknownFields(Doc, 'text')).toBe('text');
        expect(stripUnknownFields(z.array(z.string()), { a: 1 })).toEqual({ a: 1 });
        expect(stripUnknownFields(Shape, { kind: 'triangle', x: 1 })).toEqual({ kind: 'triangle', x: 1 });
        expect(stripUnknownFields(z.string(), { a: 1 })).toEqual({ a: 1 });
    });

    it('does not mutate its input', () => {
        const input = structuredClone(withExtras);
        stripUnknownFields(Doc, input);
        expect(input).toEqual(withExtras);
    });
});
