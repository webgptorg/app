import { Menu, useToast } from '@ptbk/ui';
import type { MenuEntry } from '@ptbk/ui';
import { THEME_PREFERENCES } from '@ptbk/ui';
import { LogOut } from 'lucide-react';

import { useBrowser } from '../../app/browser-context';
import { useAppLocale } from '../../app/locale';
import { useThemePreference } from '../../app/theme';
import { m } from '../../paraglide/messages';
import { localeLabel, themeLabel } from '../settings/preference-labels';
import { useCurrentMember } from '../session/use-current-member';
import { roleLabel } from './role-label';
import { signOut } from './sign-out';

/** The member's name and role label, language, theme and sign-out. */
export function UserMenu({ compact = false }: { readonly compact?: boolean }) {
    const member = useCurrentMember();
    const { locale, locales, changeLocale } = useAppLocale();
    const { preference, setPreference } = useThemePreference();
    const browser = useBrowser();
    const toast = useToast();
    const items: MenuEntry[] = [
        { kind: 'heading', id: 'member', label: `${member.displayName} · ${roleLabel(member.roleLabel)}` },
        { kind: 'separator', id: 'language-separator' },
        { kind: 'heading', id: 'language', label: m.language_label() },
        ...locales.map((option): MenuEntry => ({
            kind: 'item',
            id: `locale-${option}`,
            label: localeLabel(option),
            checked: option === locale,
            onSelect: () => {
                changeLocale(option);
            },
        })),
        { kind: 'separator', id: 'theme-separator' },
        { kind: 'heading', id: 'theme', label: m.theme_label() },
        ...THEME_PREFERENCES.map((option): MenuEntry => ({
            kind: 'item',
            id: `theme-${option}`,
            label: themeLabel(option),
            checked: option === preference,
            onSelect: () => {
                setPreference(option);
            },
        })),
        { kind: 'separator', id: 'sign-out-separator' },
        {
            kind: 'item',
            id: 'sign-out',
            label: m.sign_out(),
            icon: <LogOut aria-hidden />,
            onSelect: () => {
                void signOut(browser).then((signedOut) => {
                    if (!signedOut) toast.show({ tone: 'danger', title: m.sign_out_failed() });
                });
            },
        },
    ];
    const initial = member.displayName.trim().charAt(0).toUpperCase();
    return (
        <Menu
            label={m.user_menu()}
            align="start"
            items={items}
            trigger={(props) => (
                <button
                    {...props}
                    type="button"
                    aria-label={compact ? `${m.user_menu()}: ${member.displayName}` : undefined}
                    className="flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-control p-2 text-start hover:bg-hover motion-safe:transition-colors motion-safe:duration-(--motion-state)"
                >
                    <span
                        aria-hidden="true"
                        className="inline-flex size-8 shrink-0 items-center justify-center rounded-pill bg-accent-soft font-display text-sm font-semibold text-accent-text"
                    >
                        {initial}
                    </span>
                    {compact ? null : (
                        <span className="flex min-w-0 flex-col">
                            <span className="truncate text-sm font-medium">{member.displayName}</span>
                            <span className="truncate text-xs text-text-muted">{roleLabel(member.roleLabel)}</span>
                        </span>
                    )}
                </button>
            )}
        />
    );
}
