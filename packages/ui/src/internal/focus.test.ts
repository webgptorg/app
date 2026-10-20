import { afterEach, describe, expect, it } from 'vitest';

import { focusableIn, wrapTabFocus } from './focus';

function container(html: string): HTMLElement {
    const element = document.createElement('div');
    // Test fixture markup only; the package never parses HTML.
    element.append(document.createRange().createContextualFragment(html));
    document.body.append(element);
    return element;
}

describe('focus helpers', () => {
    afterEach(() => {
        document.body.replaceChildren();
    });

    it('lists what Tab reaches, skipping disabled, hidden and inert content', () => {
        const element = container(
            '<button>a</button><button disabled>b</button><div hidden><a href="#">c</a></div>' +
                '<div inert><input></div><input type="hidden"><span tabindex="0">d</span><span tabindex="-1">e</span>',
        );
        expect(focusableIn(element).map((node) => node.textContent)).toEqual(['a', 'd']);
    });

    it('pulls focus in from outside and claims Tab when nothing inside can take it', () => {
        const outside = container('<button>outside</button>');
        const inside = container('<button>first</button><button>last</button>');
        outside.querySelector('button')?.focus();
        expect(wrapTabFocus(inside, false)).toBe(true);
        expect(document.activeElement?.textContent).toBe('first');
        outside.querySelector('button')?.focus();
        expect(wrapTabFocus(inside, true)).toBe(true);
        expect(document.activeElement?.textContent).toBe('last');
        expect(wrapTabFocus(container('<p>text</p>'), false)).toBe(true);
    });
});
