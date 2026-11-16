import type { AgentProfile } from '@ptbk/engine-api';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';

import { renderUi } from '../../testing/render-ui';
import { AgentAvatar } from './agent-avatar';
import { AgentIllustration } from './illustrations/illustrations';
import type { IllustrationId } from './illustrations/illustrations';

/** The drawing's shapes, tag and attributes, to tell one illustration from another. */
const illustrationOf = (avatar: Element | null | undefined) =>
    [...(avatar?.querySelector('svg')?.children ?? [])]
        .map((shape) =>
            [shape.tagName, ...[...shape.attributes].map(({ name, value }) => `${name}=${value}`)].join(' '),
        )
        .join('\n');
const render = (id: IllustrationId) => illustrationOf(renderUi(<AgentIllustration id={id} />).container);

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
        expect(image?.className).toContain('size-14');
    });

    it('falls back to the illustration for a picture from another origin', () => {
        const { container } = renderUi(
            <AgentAvatar name=" ádam" profile={profile({ avatarUrl: 'https://attacker.example/x.png' })} />,
        );
        expect(container.querySelector('img')).toBeNull();
        expect(container.querySelector('span svg.agent-art')).not.toBeNull();
    });

    it('draws the illustration the engine chose, else one from the built-in name, the name or the role', () => {
        const drawn = (ui: ReactElement) => {
            const { container } = renderUi(ui);
            const avatar = container.querySelector('span');
            expect(avatar?.dataset['initial']).toBeUndefined();
            return illustrationOf(avatar);
        };
        expect(drawn(<AgentAvatar name="Iris" profile={profile({ illustration: 'analyst' })} />)).toBe(
            drawn(<AgentAvatar name="Analyst" profile={profile()} />),
        );
        expect(drawn(<AgentAvatar name="Chatter" origin="core" profile={profile()} />)).toBe(render('chatter'));
        expect(drawn(<AgentAvatar name="Chatter" origin="content" profile={profile()} />)).toBe(render('agent'));
        expect(drawn(<AgentAvatar name="Max" profile={profile({ description: 'Answers support email' })} />)).toBe(
            render('support'),
        );
        expect(drawn(<AgentAvatar name="Právník" profile={{ avatarUrl: null, color: null }} />)).toBe(render('lawyer'));
    });

    it('draws the illustration decoratively, with no inline style and every size', () => {
        const { container } = renderUi(
            <>
                {(['2xs', 'xs', 'sm', 'lg', 'xl'] as const).map((size) => (
                    <AgentAvatar key={size} name="Ada" agentKey="agent-ada" profile={profile()} size={size} />
                ))}
            </>,
        );
        const avatars = [...container.querySelectorAll('span')];
        expect(avatars.map((avatar) => /size-\d+/.exec(avatar.className)?.[0])).toEqual([
            'size-4',
            'size-6',
            'size-8',
            'size-14',
            'size-18',
        ]);
        for (const svg of container.querySelectorAll('svg')) {
            expect(svg.getAttribute('aria-hidden')).toBe('true');
            expect(svg.getAttribute('focusable')).toBe('false');
        }
        expect(container.querySelectorAll('svg [style], svg[style]')).toHaveLength(0);
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

    it('draws the generic agent for a blank name', () => {
        const { container } = renderUi(<AgentAvatar name="  " profile={profile()} />);
        expect(illustrationOf(container.querySelector('span'))).toBe(render('agent'));
    });
});
