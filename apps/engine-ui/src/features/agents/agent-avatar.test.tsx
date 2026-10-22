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
    it('shows a same-origin picture with the profile colour as its ring', () => {
        const { container } = renderUi(
            <AgentAvatar name="Ada" profile={profile({ avatarUrl: '/avatars/ada.png', color: '#ff0000' })} size="lg" />,
        );
        const image = container.querySelector('img');
        expect(image?.getAttribute('src')).toBe('/avatars/ada.png');
        expect(image?.getAttribute('alt')).toBe('');
        expect(image?.style.borderColor).toBe('rgb(255, 0, 0)');
        expect(image?.className).toContain('size-14');
    });

    it('falls back to the initial for a picture from another origin', () => {
        const { container } = renderUi(
            <AgentAvatar name=" ádam" profile={profile({ avatarUrl: 'https://attacker.example/x.png' })} />,
        );
        expect(container.querySelector('img')).toBeNull();
        expect(container.textContent).toBe('Á');
        expect(container.querySelector('span')?.style.borderColor).toBe('');
    });

    it('shows nothing for a blank name', () => {
        const { container } = renderUi(<AgentAvatar name="  " profile={profile()} />);
        expect(container.querySelector('span')?.textContent).toBe('');
    });
});
