import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '../../../testing/axe';
import { renderUi, TEST_ORIGIN } from '../../../testing/render-ui';
import { MessageMarkdown, preloadMarkdown } from './lazy-markdown';
import { Markdown, MarkdownTree } from './markdown';
import type { Nodes } from 'mdast';

const renderMarkdown = (source: string) => renderUi(<Markdown source={source} origin={TEST_ORIGIN} />);

const RICH = [
    '# Report',
    '',
    'Some *emphasis*, **strong**, ~~gone~~ and `inline code`.  ',
    'A hard break above.',
    '',
    '> quoted',
    '',
    '3. three',
    '4. four',
    '',
    '- [x] shipped',
    '- [ ] pending',
    '',
    '| Item | Owner |',
    '| :--- | ---: |',
    '| Billing | Ada |',
    '',
    '---',
    '',
    '[docs](https://example.com/docs)',
    '',
    '```ts',
    'const a = 1;',
    '```',
].join('\n');

describe('Markdown', () => {
    it('renders the allowed nodes, headings one level lower', async () => {
        const { container } = renderMarkdown(RICH);
        expect(screen.getByRole('heading', { level: 2, name: 'Report' })).toBeDefined();
        expect(container.querySelector('em')?.textContent).toBe('emphasis');
        expect(container.querySelector('strong')?.textContent).toBe('strong');
        expect(container.querySelector('del')?.textContent).toBe('gone');
        expect(container.querySelector('p > code')?.textContent).toBe('inline code');
        expect(container.querySelector('br')).not.toBeNull();
        expect(container.querySelector('blockquote')?.textContent).toBe('quoted');
        expect(container.querySelector('ol')?.getAttribute('start')).toBe('3');
        expect(container.querySelectorAll('ol > li')).toHaveLength(2);
        expect(container.querySelector('hr')).not.toBeNull();
        const table = screen.getByRole('table');
        expect(
            within(table)
                .getAllByRole('columnheader')
                .map((cell) => cell.textContent),
        ).toEqual(['Item', 'Owner']);
        expect(
            within(table)
                .getAllByRole('cell')
                .map((cell) => cell.className),
        ).toEqual([expect.stringContaining('text-start'), expect.stringContaining('text-end')]);
        expect(container.querySelector('pre code')?.textContent).toBe('const a = 1;');
        await expectNoAxeViolations(container);
    });

    it('shows task items as disabled checkboxes that say whether they are done', () => {
        renderMarkdown('- [x] shipped\n- [ ] pending');
        const done = screen.getByRole('checkbox', { name: 'Done' });
        const open = screen.getByRole('checkbox', { name: 'Not done' });
        expect(done).toHaveProperty('checked', true);
        expect(done).toHaveProperty('disabled', true);
        expect(open).toHaveProperty('checked', false);
        expect(open).toHaveProperty('disabled', true);
    });

    it.each([1, 2, 3, 4, 5, 6])('renders a level %i heading one level lower, at most h6', (depth) => {
        renderMarkdown(`${'#'.repeat(depth)} Title`);
        expect(screen.getByRole('heading', { level: Math.min(depth + 1, 6), name: 'Title' })).toBeDefined();
    });

    it('keeps loose list items as paragraphs and tight ones inline', () => {
        const { container } = renderMarkdown('- a\n\n- b\n\n* c\n* d');
        expect(container.querySelectorAll('ul')[0]?.querySelectorAll('li > p')).toHaveLength(2);
        expect(container.querySelectorAll('ul')[1]?.querySelectorAll('li > p')).toHaveLength(0);
    });

    it('keeps list markers: a plain list item is never a flex box, which would drop its bullet', () => {
        const { container } = renderMarkdown('- a\n- b\n\n1. c');
        const items = [...container.querySelectorAll('li')];
        expect(items).toHaveLength(3);
        for (const item of items) expect(item.className.split(' ')).not.toContain('flex');
        expect(container.querySelector('ul')?.className).toContain('list-disc');
        expect(container.querySelector('ol')?.className).toContain('list-decimal');
    });

    it('renders references, footnotes and front matter as text, never as links or images', () => {
        const { container } = renderMarkdown(
            [
                'See [the docs][docs] and ![logo][logo] and ![][logo] and a note[^1].',
                '',
                '[docs]: https://example.com/docs',
                '[logo]: https://example.com/logo.png',
                '',
                '[^1]: The note.',
            ].join('\n'),
        );
        expect(container.textContent).toContain('See the docs and Image: logo and Image and a note[^1].');
        expect(container.textContent).toContain('The note.');
        expect(container.querySelector('a, img')).toBeNull();
    });

    it('renders an image whose URL is not allowed as its label alone', () => {
        const { container } = renderMarkdown('![chart](/files/chart.png) ![](data:image/png;base64,AAAA)');
        expect(container.textContent).toBe('Image: chart Image');
        expect(container.querySelector('a, img')).toBeNull();
    });

    it('renders a table without alignment and a code block without a language', () => {
        const { container } = renderMarkdown('| a |\n| - |\n| b |\n\n```\nplain\n```');
        expect(container.querySelector('td')?.className).toContain('text-start');
        expect(container.querySelector('pre code')?.textContent).toBe('plain');
    });
});

describe('MarkdownTree', () => {
    it('renders node types it does not know as their text only', () => {
        const tree = {
            type: 'root',
            children: [
                { type: 'math', value: 'x^2' },
                { type: 'container', children: [{ type: 'text', value: ' inside' }] },
                { type: 'mystery' },
                { type: 'tableCell', children: [{ type: 'text', value: ' cell' }] },
                { type: 'yaml', value: ' a: 1' },
                { type: 'footnoteReference', identifier: 'n' },
                { type: 'tableRow', children: [] },
                { type: 'list', ordered: true, children: [{ type: 'listItem', children: [] }] },
            ],
        } as unknown as Nodes;
        const { container } = renderUi(<MarkdownTree tree={tree} origin={TEST_ORIGIN} />);
        expect(container.textContent).toBe('x^2 inside cell a: 1[^n]');
        expect(container.querySelector('ol')?.getAttribute('start')).toBe('1');
    });
});

describe('MessageMarkdown', () => {
    it('shows the text plain until the renderer has loaded, then as markdown', async () => {
        renderUi(<MessageMarkdown source={'## Done\n\nAll **good**.'} />);
        expect(screen.getByText(/## Done/).tagName).toBe('P');
        expect(await screen.findByRole('heading', { level: 3, name: 'Done' })).toBeDefined();
        expect(screen.getByText('good').tagName).toBe('STRONG');
    });

    it('loads the renderer once, however often it is preloaded', () => {
        expect(preloadMarkdown()).toBe(preloadMarkdown());
    });
});
