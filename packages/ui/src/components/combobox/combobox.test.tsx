import { fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render';
import { TEST_MESSAGES } from '../../testing/test-messages';
import { Field } from '../field/field';
import { Combobox } from './combobox';
import type { ComboboxOption, ComboboxProps } from './combobox';

const OPTIONS: readonly ComboboxOption[] = [
    { value: 'ada', label: 'Ada', description: 'Writes the release notes', leading: <span>A</span> },
    { value: 'bob', label: 'Bob', disabled: true },
    { value: 'cyril', label: 'Cyril' },
    { value: 'sarka', label: 'Šárka' },
    { value: 'cecil', label: 'Cecil' },
    { value: 'zoe', label: 'Zoe', disabled: true },
];

type HarnessProps = Partial<ComboboxProps> & { readonly initial?: string | null };

function Harness({ initial = null, onChange, ...props }: HarnessProps) {
    const [value, setValue] = useState<string | null>(initial);
    return (
        <>
            <Combobox
                aria-label="Assignee"
                options={OPTIONS}
                {...props}
                value={value}
                onChange={(next) => {
                    setValue(next);
                    onChange?.(next);
                }}
            />
            <button type="button">After</button>
        </>
    );
}

function setup(props: HarnessProps = {}, theme: 'light' | 'dark' = 'light') {
    const rendered = renderUi(<Harness {...props} />, { theme });
    const trigger = screen.getByRole('combobox', { name: 'Assignee' });
    return { ...rendered, trigger };
}

function searchField(): HTMLInputElement {
    const field = document.querySelector<HTMLInputElement>('input[role="combobox"]');
    if (field === null) throw new Error('no search field');
    return field;
}

const activeLabel = (owner: HTMLElement) => {
    const id = owner.getAttribute('aria-activedescendant');
    return id === null ? null : document.getElementById(id)?.textContent;
};

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('Combobox', () => {
    it.each(['light', 'dark'] as const)(
        'wires the trigger to a named listbox without axe violations (%s)',
        async (theme) => {
            const { container, trigger, user } = setup({ initial: 'ada', placeholder: 'Pick someone' }, theme);
            expect(trigger.getAttribute('aria-haspopup')).toBe('listbox');
            expect(trigger.getAttribute('aria-expanded')).toBe('false');
            expect(trigger.textContent).toBe('AAda');
            await expectNoAxeViolations(container);

            await user.click(trigger);
            const listbox = screen.getByRole('listbox', { name: 'Assignee' });
            expect(trigger.getAttribute('aria-expanded')).toBe('true');
            expect(trigger.getAttribute('aria-controls')).toBe(listbox.id);
            expect(document.activeElement).toBe(trigger);
            expect(activeLabel(trigger)).toContain('Ada');
            expect(screen.getByRole('option', { name: /Ada/ }).getAttribute('aria-selected')).toBe('true');
            expect(screen.getByRole('option', { name: 'Bob' }).getAttribute('aria-disabled')).toBe('true');
            expect(screen.getByRole('option', { name: 'Cyril' }).getAttribute('aria-selected')).toBe('false');
            await expectNoAxeViolations(container);
        },
    );

    it('marks a label in another language with its lang, on the option and the trigger', async () => {
        const options = [
            { value: 'en', label: 'English', lang: 'en' },
            { value: 'cs', label: 'Čeština', lang: 'cs' },
        ];
        const { trigger, user } = setup({ options, initial: 'cs' });
        expect(trigger.querySelector('[lang="cs"]')?.textContent).toBe('Čeština');
        await user.click(trigger);
        expect(screen.getByRole('option', { name: 'English' }).querySelector('[lang="en"]')?.textContent).toBe(
            'English',
        );
        expect(screen.getByRole('option', { name: 'Čeština' }).querySelector('[lang]')?.getAttribute('lang')).toBe(
            'cs',
        );
    });

    it('shows the placeholder until something is chosen, and toggles on click', async () => {
        const { trigger, user } = setup({ placeholder: 'Pick someone' });
        expect(trigger.textContent).toBe('Pick someone');
        await user.click(trigger);
        expect(activeLabel(trigger)).toContain('Ada');
        await user.click(trigger);
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
        expect(document.activeElement).toBe(trigger);
    });

    it.each(['{ArrowDown}', '{ArrowUp}', '{Enter}', ' '])('opens with %s on the selected option', async (key) => {
        const { trigger, user } = setup({ initial: 'cyril' });
        trigger.focus();
        await user.keyboard(key);
        expect(trigger.getAttribute('aria-expanded')).toBe('true');
        expect(activeLabel(trigger)).toBe('Cyril');
    });

    it('opens with Home on the first and End on the last enabled option', async () => {
        const { trigger, user } = setup({ initial: 'cyril' });
        trigger.focus();
        await user.keyboard('{End}');
        expect(activeLabel(trigger)).toBe('Cecil');
        await user.keyboard('{Escape}');
        await user.keyboard('{Home}');
        expect(activeLabel(trigger)).toContain('Ada');
    });

    it('moves with arrows, Home, End and pages, skipping disabled options and stopping at the ends', async () => {
        const { trigger, user } = setup();
        await user.click(trigger);
        expect(activeLabel(trigger)).toContain('Ada');
        await user.keyboard('{ArrowUp}');
        expect(activeLabel(trigger)).toContain('Ada');
        await user.keyboard('{ArrowDown}');
        expect(activeLabel(trigger)).toBe('Cyril');
        await user.keyboard('{End}');
        expect(activeLabel(trigger)).toBe('Cecil');
        await user.keyboard('{ArrowDown}');
        expect(activeLabel(trigger)).toBe('Cecil');
        await user.keyboard('{ArrowUp}');
        expect(activeLabel(trigger)).toBe('Šárka');
        await user.keyboard('{PageUp}');
        expect(activeLabel(trigger)).toContain('Ada');
        await user.keyboard('{PageDown}');
        expect(activeLabel(trigger)).toBe('Cecil');
        await user.keyboard('{Home}');
        expect(activeLabel(trigger)).toContain('Ada');
    });

    it('pages to the nearest enabled option when the page lands on a disabled one', async () => {
        const options: ComboboxOption[] = Array.from({ length: 12 }, (_, index) => ({
            value: String(index),
            label: `Option ${String(index)}`,
            disabled: index === 0 || index >= 10,
        }));
        const { trigger, user } = setup({ options, initial: '5' });
        await user.click(trigger);
        await user.keyboard('{PageDown}');
        expect(activeLabel(trigger)).toBe('Option 9');
        await user.keyboard('{PageUp}');
        expect(activeLabel(trigger)).toBe('Option 1');
    });

    it('selects with Enter and Space, closes and keeps focus on the trigger', async () => {
        const onChange = vi.fn();
        const { trigger, user } = setup({ onChange, name: 'assignee' });
        const hidden = document.querySelector<HTMLInputElement>('input[type="hidden"][name="assignee"]');
        expect(hidden?.value).toBe('');

        trigger.focus();
        await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
        expect(onChange).toHaveBeenLastCalledWith('cyril');
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
        expect(document.activeElement).toBe(trigger);
        expect(trigger.textContent).toBe('Cyril');
        expect(hidden?.value).toBe('cyril');

        await user.keyboard('{ArrowDown}{ArrowDown} ');
        expect(onChange).toHaveBeenLastCalledWith('sarka');
        expect(trigger.getAttribute('aria-expanded')).toBe('false');

        await user.keyboard('{Enter}{Enter}');
        expect(onChange).toHaveBeenCalledTimes(2);
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
    });

    it('selects the active option on Tab and moves on', async () => {
        const onChange = vi.fn();
        const onBlur = vi.fn();
        const { trigger, user } = setup({ onChange, onBlur });
        await user.click(trigger);
        await user.keyboard('{ArrowDown}');
        await user.tab();
        expect(onChange).toHaveBeenCalledWith('cyril');
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'After' }));
        expect(onBlur).toHaveBeenCalledOnce();
    });

    it('closes on Tab without a change when nothing can be chosen', async () => {
        const onChange = vi.fn();
        const { trigger, user } = setup({ onChange, options: [{ value: 'x', label: 'X', disabled: true }] });
        await user.click(trigger);
        expect(trigger.hasAttribute('aria-activedescendant')).toBe(false);
        await user.keyboard('{Enter}');
        expect(trigger.getAttribute('aria-expanded')).toBe('true');
        await user.tab();
        expect(onChange).not.toHaveBeenCalled();
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
    });

    it('closes on Esc without a change, returns focus and keeps a surrounding handler from seeing it', async () => {
        const onChange = vi.fn();
        const outer = vi.fn<(event: KeyboardEvent) => void>();
        document.addEventListener('keydown', outer);
        const { user } = renderUi(<Combobox aria-label="Assignee" options={OPTIONS} value="ada" onChange={onChange} />);
        const trigger = screen.getByRole('combobox', { name: 'Assignee' });
        await user.click(trigger);
        await user.keyboard('{ArrowDown}{Escape}');
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
        expect(onChange).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(trigger);
        expect(outer.mock.calls.map(([event]) => event.key)).toEqual(['ArrowDown']);
        document.removeEventListener('keydown', outer);
    });

    it('selects by click, ignores disabled options and keeps the value when it is chosen again', async () => {
        const onChange = vi.fn();
        const { trigger, user } = setup({ onChange, initial: 'ada' });
        await user.click(trigger);
        await user.click(screen.getByRole('option', { name: 'Bob' }));
        expect(trigger.getAttribute('aria-expanded')).toBe('true');
        await user.click(screen.getByRole('option', { name: /Ada/ }));
        expect(onChange).not.toHaveBeenCalled();
        expect(trigger.getAttribute('aria-expanded')).toBe('false');

        await user.click(trigger);
        await user.hover(screen.getByRole('option', { name: 'Šárka' }));
        expect(activeLabel(trigger)).toBe('Šárka');
        await user.hover(screen.getByRole('option', { name: 'Zoe' }));
        expect(activeLabel(trigger)).toBe('Šárka');
        await user.click(screen.getByRole('option', { name: 'Cecil' }));
        expect(onChange).toHaveBeenCalledWith('cecil');
        expect(document.activeElement).toBe(trigger);
    });

    it('closes on a click outside or a scroll of the page, but not a scroll of its own list', async () => {
        const onBlur = vi.fn();
        const { trigger, user } = setup({ onBlur });
        await user.click(trigger);
        fireEvent.scroll(screen.getByRole('listbox'));
        expect(trigger.getAttribute('aria-expanded')).toBe('true');
        fireEvent.scroll(window);
        expect(trigger.getAttribute('aria-expanded')).toBe('false');

        await user.click(trigger);
        fireEvent.mouseDown(screen.getByRole('listbox'));
        expect(trigger.getAttribute('aria-expanded')).toBe('true');
        await user.click(document.body);
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
        expect(onBlur).toHaveBeenCalledOnce();
    });

    it('jumps by typeahead, open or closed, ignoring diacritics and cycling on a repeated letter', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const onChange = vi.fn();
        const { trigger, user } = setup({ onChange });
        trigger.focus();
        await user.keyboard('c');
        expect(trigger.getAttribute('aria-expanded')).toBe('true');
        expect(activeLabel(trigger)).toBe('Cyril');
        await user.keyboard('c');
        expect(activeLabel(trigger)).toBe('Cecil');
        await user.keyboard('c');
        expect(activeLabel(trigger)).toBe('Cyril');
        await user.keyboard('q');
        expect(activeLabel(trigger)).toBe('Cyril');
        await user.keyboard('{Escape}');

        vi.advanceTimersByTime(600);
        await user.keyboard('s');
        expect(activeLabel(trigger)).toBe('Šárka');
        vi.advanceTimersByTime(600);
        await user.keyboard('cy');
        expect(activeLabel(trigger)).toBe('Cyril');
        await user.keyboard('{Control>}a{/Control}');
        expect(activeLabel(trigger)).toBe('Cyril');
        expect(onChange).not.toHaveBeenCalled();
    });

    describe('searchable', () => {
        it('filters by a case- and diacritic-insensitive substring and selects from the filtered list', async () => {
            const onChange = vi.fn();
            const { container, trigger, user } = setup({ onChange, searchable: true, searchPlaceholder: 'Search…' });
            await user.click(trigger);
            const search = searchField();
            expect(screen.getAllByRole('combobox', { name: 'Assignee' })).toEqual([trigger, search]);
            expect(document.activeElement).toBe(search);
            expect(search.getAttribute('placeholder')).toBe('Search…');
            expect(trigger.hasAttribute('aria-activedescendant')).toBe(false);
            expect(activeLabel(search)).toContain('Ada');
            await expectNoAxeViolations(container);

            await user.keyboard('SAR');
            expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Šárka']);
            expect(activeLabel(search)).toBe('Šárka');
            await user.keyboard('{Enter}');
            expect(onChange).toHaveBeenCalledWith('sarka');
            expect(document.activeElement).toBe(trigger);
            expect(trigger.getAttribute('aria-expanded')).toBe('false');

            await user.click(trigger);
            expect(searchField().value).toBe('');
            expect(screen.getAllByRole('option')).toHaveLength(OPTIONS.length);
        });

        it('moves through the filtered list, leaves Home, End and Space to the field', async () => {
            const { trigger, user } = setup({ searchable: true });
            await user.click(trigger);
            const search = searchField();
            await user.keyboard('c');
            expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Cyril', 'Cecil']);
            expect(activeLabel(search)).toBe('Cyril');
            await user.keyboard('{ArrowDown}');
            expect(activeLabel(search)).toBe('Cecil');
            await user.keyboard('{Home}{End}');
            expect(activeLabel(search)).toBe('Cecil');
            await user.keyboard(' ');
            expect(search.value).toBe('c ');
            expect(activeLabel(search)).toBe('Cyril');
            expect(trigger.getAttribute('aria-expanded')).toBe('true');
        });

        it('says so when nothing matches, and Enter then does nothing', async () => {
            const onChange = vi.fn();
            const { container, trigger, user } = setup({ onChange, searchable: true });
            await user.click(trigger);
            await user.keyboard('xyz');
            expect(screen.queryAllByRole('option')).toEqual([]);
            expect(screen.getByText(TEST_MESSAGES.noResults())).toBeDefined();
            await expectNoAxeViolations(container);
            await user.keyboard('{Enter}');
            expect(trigger.getAttribute('aria-expanded')).toBe('true');
            await user.keyboard('{Escape}');
            expect(onChange).not.toHaveBeenCalled();
            expect(document.activeElement).toBe(trigger);
        });

        it('starts the search with a letter typed on the closed trigger', async () => {
            const { trigger, user } = setup({ searchable: true });
            trigger.focus();
            await user.keyboard('ce');
            const search = searchField();
            expect(search.value).toBe('ce');
            expect(activeLabel(search)).toBe('Cecil');
        });

        it('selects on Tab and calls onBlur once focus leaves', async () => {
            const onChange = vi.fn();
            const onBlur = vi.fn();
            const { trigger, user } = setup({ onChange, onBlur, searchable: true });
            await user.click(trigger);
            await user.keyboard('{ArrowDown}');
            expect(onBlur).not.toHaveBeenCalled();
            await user.tab();
            expect(onChange).toHaveBeenCalledWith('cyril');
            expect(trigger.getAttribute('aria-expanded')).toBe('false');
            expect(onBlur).toHaveBeenCalledOnce();
        });

        it('names the search field and the list by aria-labelledby when given', async () => {
            const { user } = renderUi(
                <>
                    <span id="assignee-label">Owner</span>
                    <Combobox
                        aria-labelledby="assignee-label"
                        options={OPTIONS}
                        value={null}
                        onChange={vi.fn()}
                        searchable
                    />
                </>,
            );
            await user.click(screen.getByRole('combobox', { name: 'Owner' }));
            expect(screen.getByRole('listbox', { name: 'Owner' })).toBeDefined();
            expect(screen.getAllByRole('combobox', { name: 'Owner' })).toHaveLength(2);
        });
    });

    it('works inside Field: label, description, invalid and required reach the trigger and name the popup', async () => {
        const { container, user } = renderUi(
            <Field label="Assignee" hint="Who picks it up." error="Choose someone." required>
                {(control) => (
                    <Combobox {...control} options={OPTIONS} value={null} onChange={vi.fn()} searchable name="a" />
                )}
            </Field>,
        );
        const trigger = screen.getByRole('combobox', { name: /Assignee/ });
        expect(trigger.getAttribute('aria-invalid')).toBe('true');
        expect(trigger.getAttribute('aria-required')).toBe('true');
        expect(trigger.getAttribute('aria-describedby')).toContain(`${trigger.id}-hint`);
        await expectNoAxeViolations(container);
        await user.click(trigger);
        expect(screen.getByRole('listbox').getAttribute('aria-label')).toBe(`Assignee (${TEST_MESSAGES.required()})`);
    });

    it('marks itself invalid, and does nothing while disabled', async () => {
        const { rerender, user } = renderUi(
            <Combobox aria-label="Assignee" options={OPTIONS} value={null} onChange={vi.fn()} invalid size="sm" />,
        );
        const trigger = screen.getByRole('combobox', { name: 'Assignee' });
        expect(trigger.getAttribute('aria-invalid')).toBe('true');
        expect(trigger.className).toContain('min-h-8');
        rerender(
            <Combobox
                aria-label="Assignee"
                options={OPTIONS}
                value={null}
                onChange={vi.fn()}
                invalid
                aria-invalid={false}
                disabled
            />,
        );
        expect(trigger.hasAttribute('aria-invalid')).toBe(false);
        expect((trigger as HTMLButtonElement).disabled).toBe(true);
        await user.click(trigger);
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
    });

    it('opens above the trigger when there is no room below', async () => {
        const { trigger, user } = setup();
        vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 700, 200, 40));
        const popup = screen.getByRole('listbox', { hidden: true }).parentElement;
        if (popup === null) throw new Error('no popup');
        vi.spyOn(popup, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 160, 200));
        await user.click(trigger);
        expect(popup.style.bottom).toBe(`${String(window.innerHeight - 700 + 4)}px`);
        expect(popup.style.top).toBe('');
        expect(popup.style.minWidth).toBe('200px');
        expect(popup.style.left).toBe('100px');

        vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 10, 200, 40));
        fireEvent(window, new Event('resize'));
        expect(popup.style.top).toBe('54px');
        expect(popup.style.bottom).toBe('');
    });

    it('stays usable under StrictMode', async () => {
        const { user } = renderUi(<Harness />, { strict: true });
        const trigger = screen.getByRole('combobox', { name: 'Assignee' });
        await user.click(trigger);
        await user.keyboard('{ArrowDown}{Enter}');
        expect(trigger.textContent).toBe('Cyril');
    });
});
