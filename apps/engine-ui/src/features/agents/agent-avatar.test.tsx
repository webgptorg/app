import type { AgentProfile } from '@ptbk/engine-api';
import { describe, expect, it } from 'vitest';

import { renderUi } from '../../testing/render-ui';
import { AgentAvatar } from './agent-avatar';

const profile = (fields: Partial<AgentProfile> = {}): AgentProfile => ({
    fullname: 'Ada',
    description: '',
    avatarUrl: null,
    color: null,
    initialMessage: null,
    ...fields,
});

describe('AgentAvatar', () => {
    it('shows a same-origin picture', () => {
        const { container } = renderUi(
            <AgentAvatar name="Ada" profile={profile({ avatarUrl: '/avatars/ada.png', color: '#ff0000' })} size="lg" />,
        );
        const image = container.querySelector('img');
        expect(image?.getAttribute('src')).toBe('/avatars/ada.png');
        expect(image?.getAttribute('alt')).toBe('');
        expect(image?.style.getPropertyValue('--tint')).toBe('#ff0000');
        expect(image?.className).toContain('size-14');
    });

    it('falls back to the initial for a picture from another origin', () => {
        const { container } = renderUi(
            <AgentAvatar name=" ádam" profile={profile({ avatarUrl: 'https://attacker.example/x.png' })} />,
        );
        expect(container.querySelector('img')).toBeNull();
        expect(container.textContent).toBe('Á');
        expect(container.querySelector('span')?.style.getPropertyValue('--tint')).toBe('');
    });

    it("tints the initial with the agent's colour: its profile colour, else its key's palette hue", () => {
        const { container } = renderUi(
            <>
                <AgentAvatar name="Ada" agentKey="agent-ada" profile={profile({ color: '#123456' })} />
                <AgentAvatar name="Max" agentKey="agent-max" profile={profile()} />
            </>,
        );
        const [ada, max] = container.querySelectorAll('span');
        expect(ada?.style.getPropertyValue('--tint')).toBe('#123456');
        expect(max?.style.getPropertyValue('--tint')).toMatch(/^var\(--color-agent-[1-8]\)$/);
    });

    it('never passes a profile colour that is not #rrggbb into CSS', () => {
        const { container } = renderUi(
            <AgentAvatar name="Eve" profile={profile({ color: 'red;background:url(x)' })} />,
        );
        expect(container.querySelector('span')?.style.getPropertyValue('--tint')).toBe('');
    });

    it('shows nothing for a blank name', () => {
        const { container } = renderUi(<AgentAvatar name="  " profile={profile()} />);
        expect(container.querySelector('span')?.textContent).toBe('');
    });
});
