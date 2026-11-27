import { expect, it } from 'vitest';
import { readBoundedJson } from './read-bounded-json';
it('rejects oversized, malformed and missing bodies before parsing remote input', async () => {
    expect(await readBoundedJson(Response.json({ ok: true }), 100)).toEqual({
        ok: true,
    });
    await expect(readBoundedJson(new Response('x'.repeat(101)), 100)).rejects.toThrow('Response too large');
    await expect(readBoundedJson(new Response('{'), 100)).rejects.toThrow();
    await expect(readBoundedJson(new Response(null), 100)).rejects.toThrow('Empty response');
});
