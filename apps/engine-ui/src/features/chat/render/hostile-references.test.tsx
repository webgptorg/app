import type { ReadAgent, ReadChat } from '@ptbk/engine-api';
import { fireEvent, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderUi, TEST_ORIGIN } from '../../../testing/render-ui';
import { buildThreadReferences, ThreadReferencesProvider } from '../references/thread-references';
import type { ReferenceAgent } from '../references/thread-references';
import { Markdown } from './markdown';
import { PlainText } from './plain-text';

const HOSTILE_NAME = '<img src=x onerror=alert(1)>"Evil"';
const LONG_NAME = 'W'.repeat(256);
const RTL_NAME = '‮טקסט';
const HOSTILE_TASK = '<script>alert(1)</script>';

type ChatTask = ReadChat['tasks'][number];

function task(name: string, overrides: Partial<ChatTask> = {}): ChatTask {
    return {
        name,
        taskId: null,
        detail: null,
        agentId: null,
        commit: null,
        reopened: false,
        startedAt: null,
        endedAt: null,
        state: 'running',
        ...overrides,
    };
}

const CHAT: Pick<ReadChat, 'members' | 'tasks' | 'working'> = {
    members: [
        { kind: 'user', key: 'user', name: 'User' },
        { kind: 'agent', key: 'agent-copy', name: 'Copywriter' },
        { kind: 'agent', key: 'agent-evil', name: HOSTILE_NAME },
        { kind: 'agent', key: 'agent-long', name: LONG_NAME },
        { kind: 'agent', key: 'agent-rtl', name: RTL_NAME },
    ],
    tasks: [task('Napsat text na web', { state: 'completed' }), task(HOSTILE_TASK)],
    working: [],
};

const PROJECT_AGENT = {
    id: 'agent-copy',
    name: 'Copywriter',
    profile: { fullname: '', description: 'Writes copy', avatarUrl: null, color: '#123abc', initialMessage: null },
} as unknown as ReadAgent;

function inThread(ui: ReactNode, onMention?: (agent: ReferenceAgent) => void) {
    const value = buildThreadReferences({ chat: CHAT, agents: [PROJECT_AGENT], canOpenTasks: true, onMention });
    return renderUi(<ThreadReferencesProvider value={value}>{ui}</ThreadReferencesProvider>).container;
}

/** Nothing loads or runs, and the only inline style is the `--tint` custom property a chip sets through the CSSOM. */
function expectInert(container: HTMLElement) {
    expect(
        container.querySelector('img, script, iframe, object, embed, style, form, a[href^="javascript"]'),
    ).toBeNull();
    for (const element of container.querySelectorAll<HTMLElement>('[style]')) {
        expect(element.style.length).toBe(1);
        expect(element.style.item(0)).toBe('--tint');
        expect(element.style.getPropertyValue('--tint')).toMatch(/^(#[0-9a-f]{6}|var\(--color-agent-[1-8]\))$/i);
    }
}

describe('references in agent output', () => {
    it('turns known names into chips and keeps every character of the text', () => {
        const source = '+@Copywriter finished {Napsat text na web}. +@User does it read well? Ask @Nobody.';
        const container = inThread(<Markdown source={source} origin={TEST_ORIGIN} />);
        expectInert(container);
        expect(screen.getByRole('button', { name: '@Copywriter' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Napsat text na web' })).toBeTruthy();
        expect(screen.getByText('asks you')).toBeTruthy();
        expect(container.textContent).toContain('Ask @Nobody.');
        expect(screen.getByRole('button', { name: '@Copywriter' }).style.getPropertyValue('--tint')).toBe('#123abc');
    });

    it('renders names with markup, huge names and bidi controls as text in a chip', () => {
        const source = `@${HOSTILE_NAME} @${LONG_NAME} @${RTL_NAME} {${HOSTILE_TASK}}`;
        const container = inThread(<PlainText text={source} />);
        expectInert(container);
        expect(screen.getByRole('button', { name: `@${HOSTILE_NAME}` }).textContent).toBe(`@${HOSTILE_NAME}`);
        const long = screen.getByRole('button', { name: `@${LONG_NAME}` });
        expect(long.className).toContain('[overflow-wrap:anywhere]');
        expect(screen.getByRole('button', { name: `@${RTL_NAME}` }).textContent).toBe(`@${RTL_NAME}`);
        expect(screen.getByRole('button', { name: HOSTILE_TASK }).textContent).toBe(HOSTILE_TASK);
        expect(container.textContent).toBe(source.replaceAll('{', '').replaceAll('}', ''));
    });

    it('leaves a { without its } and unknown tasks as the text they are', () => {
        const source = 'if (a) { @Copywriter {Unknown task} {Napsat text';
        const container = inThread(<PlainText text={source} />);
        expect(container.textContent).toBe(source);
        expect(screen.getAllByRole('button')).toHaveLength(1);
    });

    it('never puts a chip in code or in a link, and never makes a reference a link', () => {
        const source = [
            '`@Copywriter {Napsat text na web}`',
            '',
            '```',
            '+@Copywriter {Napsat text na web}',
            '```',
            '',
            '[@Copywriter](https://example.com/x)',
        ].join('\n');
        const container = inThread(<Markdown source={source} origin={TEST_ORIGIN} />);
        expectInert(container);
        expect(screen.queryAllByRole('button', { name: '@Copywriter' })).toHaveLength(0);
        expect(container.querySelector('code')?.textContent).toBe('@Copywriter {Napsat text na web}');
        const links = screen.getAllByRole('link');
        expect(links).toHaveLength(1);
        expect(links[0]?.getAttribute('href')).toBe('https://example.com/x');
    });

    it('addresses the agent when its chip is clicked', () => {
        const onMention = vi.fn();
        inThread(<PlainText text="Ask @copywriter" />, onMention);
        fireEvent.click(screen.getByRole('button', { name: '@Copywriter' }));
        expect(onMention).toHaveBeenCalledWith(expect.objectContaining({ key: 'agent-copy', name: 'Copywriter' }));
    });

    it('is the plain text outside a thread', () => {
        const { container } = renderUi(<PlainText text="@Copywriter {Napsat text na web} +@User" />);
        expect(container.querySelector('button')).toBeNull();
        expect(container.textContent).toBe('@Copywriter {Napsat text na web} +@User');
    });
});
