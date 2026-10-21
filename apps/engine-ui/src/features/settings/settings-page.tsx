import { THEME_PREFERENCES } from '@ptbk/ui';
import type { ThemePreference } from '@ptbk/ui';
import { Card, Field, Select } from '@ptbk/ui';
import { KeyRound } from 'lucide-react';

import { ButtonLink } from '../../app/link';
import { useAppLocale } from '../../app/locale';
import { useThemePreference } from '../../app/theme';
import { m } from '../../paraglide/messages';
import { isLocale } from '../../paraglide/runtime';
import { Page } from '../shell/page';
import { localeLabel, themeLabel } from './preference-labels';

export function SettingsPage() {
    const { locale, locales, changeLocale } = useAppLocale();
    const { preference, setPreference } = useThemePreference();
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
            <Card title={m.settings_security()}>
                <div className="flex flex-col items-start gap-3">
                    <p className="text-sm text-text-muted">{m.settings_passkeys_hint()}</p>
                    <ButtonLink to="/settings/passkeys">
                        <KeyRound aria-hidden className="size-4" />
                        {m.settings_passkeys_link()}
                    </ButtonLink>
                </div>
            </Card>
        </Page>
    );
}
