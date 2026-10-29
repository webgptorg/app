import { Menu, Monogram, useToast } from '@ptbk/ui';
import type { MenuEntry } from '@ptbk/ui';
import { THEME_PREFERENCES } from '@ptbk/ui';
import { useNavigate } from '@tanstack/react-router';
import { LogOut, Settings, ShieldCheck } from 'lucide-react';

import { useBrowser } from '../../app/browser-context';
import { useAppLocale } from '../../app/locale';
import { useVisibleFeatures } from '../../app/registry/use-visible-features';
import { useThemePreference } from '../../app/theme';
import { m } from '../../paraglide/messages';
import { securityFeature } from '../security/security-feature';
import { localeLabel, themeLabel } from '../settings/preference-labels';
import { useCurrentMember } from '../session/use-current-member';
import { roleLabel } from './role-label';
import { signOut } from './sign-out';

/**
 * The account menu: the member's own places (Settings, Security), language, theme and sign-out. The trigger already
 * shows the name and role, so the menu repeats the name only when the trigger is an icon.
 */
export function UserMenu({
    compact = false,
    onNavigate,
}: {
    readonly compact?: boolean;
    /** Called after a place is opened, e.g. to close the drawer the menu sits in. */
    readonly onNavigate?: () => void;
}) {
    const member = useCurrentMember();
    const { locale, locales, changeLocale } = useAppLocale();
    const { preference, setPreference } = useThemePreference();
    const browser = useBrowser();
    const toast = useToast();
    const navigate = useNavigate();
    const showSecurity = useVisibleFeatures().some((feature) => feature.id === securityFeature.id);
    const go = (to: '/settings' | '/security') => () => {
        onNavigate?.();
        void navigate({ to });
    };
    const items: MenuEntry[] = [
        ...(compact ? [{ kind: 'heading' as const, id: 'member', label: member.displayName }] : []),
        {
            kind: 'item',
            id: 'settings',
            label: m.nav_settings(),
            icon: <Settings aria-hidden />,
            onSelect: go('/settings'),
        },
        ...(showSecurity
            ? [
                  {
                      kind: 'item' as const,
                      id: 'security',
                      label: m.nav_security(),
                      icon: <ShieldCheck aria-hidden />,
                      onSelect: go('/security'),
                  },
              ]
            : []),
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
    return (
        <Menu
            label={m.user_menu()}
            align="start"
            items={items}
            matchTriggerWidth={!compact}
            trigger={(props) => (
                <button
                    {...props}
                    type="button"
                    aria-label={compact ? `${m.user_menu()}: ${member.displayName}` : undefined}
                    className="flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-control p-2 text-start hover:bg-hover motion-safe:transition-colors motion-safe:duration-(--motion-state)"
                >
                    <Monogram name={member.displayName} />
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
