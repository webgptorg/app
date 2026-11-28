import { Combobox, Section, THEME_PREFERENCES } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';

import { useEngineApi } from '../../app/engine-api-context';
import { ButtonLink } from '../../app/link';
import { useAllows } from '../../app/registry/use-visible-features';
import { isPageLevelFailure } from '../../app/list-errors';
import { useAppLocale } from '../../app/locale';
import { useThemePreference } from '../../app/theme';
import { m } from '../../paraglide/messages';
import { isLocale } from '../../paraglide/runtime';
import { AI_TOOLS_READ } from '../ai-tools/ai-tools-queries';
import { securityOverviewQueryOptions } from '../security/security-queries';
import { usePermissions } from '../session/use-permissions';
import { Page } from '../shell/page';
import { DashboardAttentionSection } from './dashboard-attention-section';
import { localeLabel, themeLabel } from './preference-labels';
import { PropertyList, PropertyRow } from './property-row';
import { UpdatesSection } from './updates-section';

/**
 * What a member changes: this device's language and theme, the engine's update policy for those who see it, and for
 * the owner whether heartbeats carry how many things wait for whom.
 * Language and theme apply the moment they are picked, so they have no save button.
 */
export function SettingsPage() {
    const { locale, locales, changeLocale } = useAppLocale();
    const { preference, setPreference } = useThemePreference();
    const { can } = usePermissions();
    const aiTools = useAllows(AI_TOOLS_READ);
    const overview = useQuery({
        ...securityOverviewQueryOptions(useEngineApi()),
        enabled: can('security.read'),
        throwOnError: isPageLevelFailure,
    });
    return (
        <Page title={m.settings_title()} width="reading">
            <Section title={m.settings_appearance()} description={m.settings_appearance_hint()} divided={false}>
                <PropertyList>
                    <PropertyRow label={m.language_label()}>
                        {({ labelId }) => (
                            <Combobox
                                aria-labelledby={labelId}
                                className="w-full sm:w-56"
                                value={locale}
                                options={locales.map((option) => ({
                                    value: option,
                                    label: localeLabel(option),
                                    lang: option,
                                }))}
                                onChange={(value) => {
                                    if (isLocale(value)) changeLocale(value);
                                }}
                            />
                        )}
                    </PropertyRow>
                    <PropertyRow label={m.theme_label()}>
                        {({ labelId }) => (
                            <Combobox
                                aria-labelledby={labelId}
                                className="w-full sm:w-56"
                                value={preference}
                                options={THEME_PREFERENCES.map((option) => ({
                                    value: option,
                                    label: themeLabel(option),
                                }))}
                                onChange={(value) => {
                                    const next = THEME_PREFERENCES.find((option) => option === value);
                                    if (next !== undefined) setPreference(next);
                                }}
                            />
                        )}
                    </PropertyRow>
                </PropertyList>
            </Section>
            {aiTools ? (
                <Section title={m.ai_tools_title()} description={m.ai_tools_settings_hint()}>
                    <ButtonLink to="/settings/ai-tools" size="sm" className="w-fit">
                        {m.ai_tools_open()}
                    </ButtonLink>
                </Section>
            ) : null}
            {can('security.read') ? <UpdatesSection query={overview} /> : null}
            <DashboardAttentionSection />
        </Page>
    );
}
