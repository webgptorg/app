import { THEME_PREFERENCES } from '@ptbk/ui';
import type { ThemePreference } from '@ptbk/ui';
import { Card, Field, Select } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';

import { useEngineApi } from '../../app/engine-api-context';
import { isPageLevelFailure } from '../../app/list-errors';
import { useAppLocale } from '../../app/locale';
import { useThemePreference } from '../../app/theme';
import { m } from '../../paraglide/messages';
import { isLocale } from '../../paraglide/runtime';
import { securityOverviewQueryOptions } from '../security/security-queries';
import { usePermissions } from '../session/use-permissions';
import { Page } from '../shell/page';
import { localeLabel, themeLabel } from './preference-labels';
import { UpdatesCard } from './updates-card';

/** What a member changes: this device's language and theme, and the engine's update policy for those who see it. */
export function SettingsPage() {
    const { locale, locales, changeLocale } = useAppLocale();
    const { preference, setPreference } = useThemePreference();
    const { can } = usePermissions();
    const overview = useQuery({
        ...securityOverviewQueryOptions(useEngineApi()),
        enabled: can('security.read'),
        throwOnError: isPageLevelFailure,
    });
    return (
        <Page title={m.settings_title()}>
            <Card title={m.settings_appearance()}>
                <div className="flex max-w-md flex-col gap-4">
                    <p className="text-sm text-text-muted">{m.settings_appearance_hint()}</p>
                    <Field label={m.language_label()}>
                        {(control) => (
                            <Select
                                {...control}
                                value={locale}
                                onChange={(event) => {
                                    if (isLocale(event.target.value)) changeLocale(event.target.value);
                                }}
                            >
                                {locales.map((option) => (
                                    <option key={option} value={option} lang={option}>
                                        {localeLabel(option)}
                                    </option>
                                ))}
                            </Select>
                        )}
                    </Field>
                    <Field label={m.theme_label()}>
                        {(control) => (
                            <Select
                                {...control}
                                value={preference}
                                onChange={(event) => {
                                    const next = THEME_PREFERENCES.find((option) => option === event.target.value);
                                    if (next !== undefined) setPreference(next);
                                }}
                            >
                                {THEME_PREFERENCES.map((option: ThemePreference) => (
                                    <option key={option} value={option}>
                                        {themeLabel(option)}
                                    </option>
                                ))}
                            </Select>
                        )}
                    </Field>
                </div>
            </Card>
            {can('security.read') ? <UpdatesCard query={overview} /> : null}
        </Page>
    );
}
