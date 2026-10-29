import { ChevronDown } from 'lucide-react';

import { useUiMessages } from '../../i18n/ui-provider';
import { Menu } from '../menu/menu';
import type { MenuEntry } from '../menu/menu';

export interface LanguageOption<Code extends string> {
    /** A BCP 47 tag ("en", "cs"); shown uppercase on the trigger and set as the option's `lang`. */
    readonly code: Code;
    /** The language in its own name ("Čeština"), so it is recognisable whatever language the page is in. */
    readonly name: string;
}

export interface LanguageSwitchProps<Code extends string> {
    readonly languages: readonly LanguageOption<Code>[];
    readonly current: Code;
    readonly onChange: (code: Code) => void;
    /** Which edge of the trigger the menu lines up with; `end` for a control at the right of a header. */
    readonly align?: 'start' | 'end';
}

/**
 * A compact header control for the page language: the current code ("EN") opens the languages, each in its own name,
 * the current one checked. The app applies and persists the choice in `onChange`.
 */
export function LanguageSwitch<Code extends string>({
    languages,
    current,
    onChange,
    align = 'end',
}: LanguageSwitchProps<Code>) {
    const messages = useUiMessages();
    const currentName = languages.find((language) => language.code === current)?.name ?? current;
    const items: MenuEntry[] = languages.map((language) => ({
        kind: 'item',
        id: `language-${language.code}`,
        label: language.name,
        content: <span lang={language.code}>{language.name}</span>,
        checkable: 'radio',
        checked: language.code === current,
        onSelect: () => {
            if (language.code !== current) {
                onChange(language.code);
            }
        },
    }));
    return (
        <Menu
            label={messages.language()}
            align={align}
            items={items}
            trigger={(props) => (
                <button
                    {...props}
                    type="button"
                    aria-label={messages.languageCurrent({ language: currentName })}
                    className="inline-flex min-h-8 min-w-8 shrink-0 cursor-pointer items-center justify-center gap-0.5 rounded-control px-2 text-sm font-medium text-(--language-switch-text) hover:bg-(--language-switch-bg-hover) motion-safe:transition-colors motion-safe:duration-(--motion-state)"
                >
                    <span aria-hidden="true">{current.toUpperCase()}</span>
                    <ChevronDown aria-hidden className="size-3.5 text-(--language-switch-muted)" />
                </button>
            )}
        />
    );
}
