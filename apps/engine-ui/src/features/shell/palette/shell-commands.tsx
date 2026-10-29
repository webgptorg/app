import { THEME_PREFERENCES, useToast } from '@ptbk/ui';
import { Languages, LogOut, PanelLeftClose, PanelLeftOpen, SunMoon } from 'lucide-react';
import type { ReactNode } from 'react';

import { useBrowser } from '../../../app/browser-context';
import { useAppLocale } from '../../../app/locale';
import { useThemePreference } from '../../../app/theme';
import { m } from '../../../paraglide/messages';
import { localeLabel, themeLabel } from '../../settings/preference-labels';
import type { SidebarState } from '../sidebar-preference';
import { signOut } from '../sign-out';

export interface ShellCommand {
    readonly id: string;
    readonly label: string;
    readonly keywords: readonly string[];
    readonly icon: ReactNode;
    readonly run: () => void;
}

/**
 * What the shell itself can do from the palette: the member's own preferences, the sidebar and sign-out. Only
 * changes are offered (the theme and language not already chosen), so each one is a single step.
 */
export function useShellCommands(sidebar: SidebarState | null): ShellCommand[] {
    const { preference, setPreference } = useThemePreference();
    const { locale, locales, changeLocale } = useAppLocale();
    const browser = useBrowser();
    const toast = useToast();
    const themes = THEME_PREFERENCES.filter((option) => option !== preference).map((option): ShellCommand => ({
        id: `shell:theme-${option}`,
        label: m.palette_theme({ theme: themeLabel(option) }),
        keywords: [m.settings_appearance()],
        icon: <SunMoon aria-hidden className="size-4" />,
        run: () => {
            setPreference(option);
        },
    }));
    const languages = locales
        .filter((option) => option !== locale)
        .map((option): ShellCommand => ({
            id: `shell:locale-${option}`,
            label: m.palette_language({ language: localeLabel(option) }),
            // The target language's own word for "language", so a member who cannot read the current one finds it.
            keywords: [m.language_label({}, { locale: option }), m.settings_appearance()],
            icon: <Languages aria-hidden className="size-4" />,
            run: () => {
                changeLocale(option);
            },
        }));
    const sidebarCommands: ShellCommand[] =
        sidebar === null
            ? []
            : [
                  {
                      id: 'shell:sidebar',
                      label: sidebar.collapsed ? m.sidebar_expand() : m.sidebar_collapse(),
                      keywords: [],
                      icon: sidebar.collapsed ? (
                          <PanelLeftOpen aria-hidden className="size-4" />
                      ) : (
                          <PanelLeftClose aria-hidden className="size-4" />
                      ),
                      run: sidebar.toggle,
                  },
              ];
    return [
        ...themes,
        ...languages,
        ...sidebarCommands,
        {
            id: 'shell:sign-out',
            label: m.sign_out(),
            keywords: [m.palette_sign_out_keywords()],
            icon: <LogOut aria-hidden className="size-4" />,
            run: () => {
                void signOut(browser).then((signedOut) => {
                    if (!signedOut) toast.show({ tone: 'danger', title: m.sign_out_failed() });
                });
            },
        },
    ];
}
