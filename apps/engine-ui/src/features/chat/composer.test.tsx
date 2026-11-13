import { screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render-ui';
import { Composer } from './composer';
import type { ComposerAgent } from './composer';

const AGENTS: readonly ComposerAgent[] = [
    { key: 'agent-chatter', name: 'Chatter', color: 'var(--color-agent-1)', description: 'Routes your requests' },
    { key: 'agent-copy', name: 'Copywriter', color: '#123abc', description: 'Writes copy' },
    { key: 'agent-lead', name: 'Lead copy bot', color: 'var(--color-agent-3)', description: null },
];

function Harness({ onSend }: { readonly onSend: (content: string) => Promise<boolean> }) {
    const [addressee, setAddressee] = useState<ComposerAgent | null>(null);
    return (
        <Composer
            label="Message"
            placeholder={`Message ${addressee?.name ?? 'Chatter'}…`}
            busy={false}
            onSend={onSend}
            mentionables={AGENTS}
            addressee={addressee}
            onAddresseeChange={setAddressee}
        />
    );
}

function setup() {
    const onSend = vi.fn<(content: string) => Promise<boolean>>(() => Promise.resolve(true));
    const user = userEvent.setup();
    const { container } = renderUi(<Harness onSend={onSend} />);
    const box = screen.getByRole('textbox', { name: 'Message' });
    return { onSend, user, container, box };
}

const options = () => within(screen.getByRole('listbox', { name: 'Agents to mention' })).getAllByRole('option');

describe('Composer mentions', () => {
    it('suggests agents on @, driven from the keyboard, and inserts the picked name', async () => {
        const { user, box, container, onSend } = setup();
        await user.click(box);
        await user.keyboard('Ask @cop');
        expect(box.getAttribute('aria-autocomplete')).toBe('list');
        expect(options().map((option) => option.textContent)).toEqual(['CopywriterWrites copy', 'Lead copy bot']);
        expect(box.getAttribute('aria-activedescendant')).toBe(options()[0]?.id);
        expect(options()[0]?.getAttribute('aria-selected')).toBe('true');
        await expectNoAxeViolations(container);

        await user.keyboard('{ArrowDown}');
        expect(box.getAttribute('aria-activedescendant')).toBe(options()[1]?.id);
        await user.keyboard('{ArrowDown}');
        expect(box.getAttribute('aria-activedescendant')).toBe(options()[0]?.id);
        await user.keyboard('{Enter}');
        expect(screen.queryByRole('listbox')).toBeNull();
        expect((box as HTMLTextAreaElement).value).toBe('Ask @Copywriter ');
        expect(onSend).not.toHaveBeenCalled();

        await user.keyboard('now{Enter}');
        expect(onSend).toHaveBeenCalledWith('Ask @Copywriter now');
    });

    it('closes the list on Esc and when nothing matches, and leaves e-mail addresses alone', async () => {
        const { user, box } = setup();
        await user.click(box);
        await user.keyboard('@');
        expect(options()).toHaveLength(3);
        await user.keyboard('{Escape}');
        expect(screen.queryByRole('listbox')).toBeNull();
        await user.keyboard('zz');
        expect(screen.queryByRole('listbox')).toBeNull();
        await user.clear(box);
        await user.keyboard('ada@ch');
        expect(screen.queryByRole('listbox')).toBeNull();
    });

    it('addresses the agent picked with +@, sends +@Name and clears the address after sending', async () => {
        const { user, box, onSend } = setup();
        await user.click(box);
        await user.keyboard('+@Copy');
        await user.click(screen.getByRole('option', { name: /Copywriter/ }));
        expect(screen.getByText('@Copywriter')).toBeTruthy();
        expect(screen.getByText('to')).toBeTruthy();
        expect((box as HTMLTextAreaElement).value).toBe('');
        expect(box.getAttribute('placeholder')).toBe('Message Copywriter…');
        expect(document.activeElement).toBe(box);

        await user.keyboard('rewrite the headline{Enter}');
        expect(onSend).toHaveBeenCalledWith('+@Copywriter rewrite the headline');
        expect(screen.queryByText('@Copywriter')).toBeNull();
    });

    it('drops the address with its × or Backspace at the start', async () => {
        const { user, box } = setup();
        await user.click(box);
        await user.keyboard('+@Chat{Enter}');
        await user.click(screen.getByRole('button', { name: 'Stop addressing Chatter' }));
        expect(screen.queryByText('@Chatter')).toBeNull();
        expect(document.activeElement).toBe(box);

        await user.keyboard('+@Chat{Enter}hi');
        expect(screen.getByText('@Chatter')).toBeTruthy();
        await user.keyboard('{Backspace}{Backspace}');
        expect(screen.getByText('@Chatter')).toBeTruthy();
        await user.keyboard('{Backspace}');
        expect(screen.queryByText('@Chatter')).toBeNull();
    });

    it('treats @ as a character when nothing can be mentioned', async () => {
        const onSend = vi.fn<(content: string) => Promise<boolean>>(() => Promise.resolve(true));
        const user = userEvent.setup();
        renderUi(<Composer label="Message" placeholder="Message" busy={false} onSend={onSend} />);
        const box = screen.getByRole('textbox', { name: 'Message' });
        await user.click(box);
        await user.keyboard('@a{Enter}');
        expect(box.getAttribute('aria-autocomplete')).toBeNull();
        expect(onSend).toHaveBeenCalledWith('@a');
    });
});
