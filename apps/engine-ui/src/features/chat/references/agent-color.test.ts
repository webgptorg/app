import { describe, expect, it } from 'vitest';

import { AGENT_PALETTE_SIZE, agentColor, tintStyle } from './agent-color';

describe('agentColor', () => {
    it('uses the profile colour when the book sets one', () => {
        expect(agentColor('#12ab9F', 'agent-copywriter')).toBe('#12ab9F');
    });

    it('hashes the key into the palette, the same every time', () => {
        const first = agentColor(null, 'agent-copywriter');
        expect(first).toMatch(/^var\(--color-agent-[1-8]\)$/);
        expect(agentColor(null, 'agent-copywriter')).toBe(first);
        expect(agentColor(undefined, 'agent-copywriter')).toBe(first);
    });

    it('spreads keys over the whole palette', () => {
        const used = new Set(Array.from({ length: 200 }, (_, index) => agentColor(null, `agent-${String(index)}`)));
        expect(used.size).toBe(AGENT_PALETTE_SIZE);
    });

    it.each(['red', '#fff', 'url(https://x.example)', '#123456; background: red', 'var(--x)'])(
        'never passes anything but #rrggbb into CSS: %s',
        (hostile) => {
            expect(agentColor(hostile, 'agent-a')).toMatch(/^var\(--color-agent-[1-8]\)$/);
        },
    );

    it('sets the colour as --tint, with label colours derived for each theme', () => {
        const style = tintStyle('#123456') as Record<string, string>;
        expect(style['--tint']).toBe('#123456');
        expect(style['--tint-text-light']).toMatch(/^#[0-9a-f]{6}$/);
        expect(style['--tint-text-dark']).toMatch(/^#[0-9a-f]{6}$/);
        expect(tintStyle('var(--color-agent-2)')).toMatchObject({ '--tint': 'var(--color-agent-2)' });
        expect(tintStyle('red')).toEqual({});
    });
});
