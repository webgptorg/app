import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import type { ReadSecurityOverview, ReadUiUpdateCheck } from '@ptbk/engine-api';
import { Button, RelativeTime, useLocale } from '@ptbk/ui';

import type { ApiFailure } from '../../app/api-errors';
import { unwrap } from '../../app/api-errors';
import { useEngineApi } from '../../app/engine-api-context';
import { useStepUpAwareMutation } from '../../app/mutations';
import { useAccess } from '../../app/registry/use-visible-features';
import { useNow } from '../../app/ticker';
import { UI_VERSION } from '../../app/ui-version';
import { m } from '../../paraglide/messages';
import { securityKeys } from '../security/security-keys';
import { checkOutcomeLabel, refusalReasonLabel } from '../security/security-labels';
import { PropertyRow } from './property-row';

/** A check longer than this through the relay is the engine's problem, not the browser's; the result still arrives. */
const CHECK_TIMEOUT_MS = 120_000;
/** A next check this far in the past is late, not merely running. */
const LATE_AFTER_MS = 2 * 60_000;

type Formatters = ReturnType<typeof useLocale>;

/** Why the app is on the version it is, in plain words: the last check's outcome and, for a refusal, its reason. */
export function checkSentence(check: ReadUiUpdateCheck, locale: Formatters): string {
    const version = check.version ?? '';
    switch (check.outcome) {
        case 'up-to-date':
            return m.updates_check_up_to_date();
        case 'installed':
            return m.updates_check_installed({ version });
        case 'refused':
            if (check.reason === 'delay-not-elapsed' && check.eligibleAt !== null) {
                return m.updates_check_waiting({ version, at: locale.formatDateTime(new Date(check.eligibleAt)) });
            }
            return m.updates_check_refused({
                version,
                reason: check.reason === null ? m.security_value_unknown() : refusalReasonLabel(check.reason),
            });
        case 'unavailable':
        case 'unknown':
            return checkOutcomeLabel(check.outcome);
    }
}

function toastFor(check: ReadUiUpdateCheck, locale: Formatters): string {
    return check.outcome === 'unavailable' ? m.updates_check_unavailable_toast() : checkSentence(check, locale);
}

function failureText(failure: ApiFailure): string {
    if (failure.kind === 'problem' && failure.problem.code === 'update-check-too-soon')
        return m.updates_check_too_soon();
    return m.updates_check_failed();
}

function CheckNowButton() {
    const engineApi = useEngineApi();
    const locale = useLocale();
    const check = useStepUpAwareMutation({
        mutationFn: async () => unwrap(await engineApi.updates.checkUi(AbortSignal.timeout(CHECK_TIMEOUT_MS))),
        invalidates: [securityKeys.overview()],
        successMessage: (result) => toastFor(result, locale),
        errorMessage: failureText,
    });
    return (
        <Button
            variant="secondary"
            size="sm"
            loading={check.isPending}
            onClick={() => {
                check.mutate();
            }}
        >
            {m.updates_check_now()}
        </Button>
    );
}

function NextCheck({ ui, manual }: { readonly ui: ReadSecurityOverview['ui']; readonly manual: boolean }) {
    const locale = useLocale();
    const now = useNow();
    if (manual) return <span className="text-text-muted">{m.updates_next_manual()}</span>;
    if (ui.nextCheckAt === null) return <span className="text-text-muted">{m.updates_next_unknown()}</span>;
    const next = new Date(ui.nextCheckAt);
    if (next.getTime() < now - LATE_AFTER_MS) {
        return <span className="text-warning">{m.updates_next_late({ at: locale.formatDateTime(next) })}</span>;
    }
    return <RelativeTime value={next} className="text-text-muted tabular-nums" />;
}

/**
 * The UI bundle's side of updates: the version this project serves, its last and next check, and with `updates@1`
 * and `settings.manage` a "Check now" that runs the regular check early. It never skips the delay or any verification,
 * so the copy says only what the engine reports.
 */
export function UiUpdateRows({ overview }: { readonly overview: ReadSecurityOverview }) {
    const locale = useLocale();
    const access = useAccess();
    const { ui, update } = overview;
    const updates = access.supports(KNOWN_CAPABILITIES.updates);
    const manual = update.policy === 'manual';
    const check = ui.lastUpdateCheck;
    return (
        <>
            <PropertyRow
                label={m.updates_app_version()}
                hint={ui.version === UI_VERSION ? undefined : m.updates_app_newer({ version: ui.version })}
            >
                {ui.version === UI_VERSION ? (
                    <span className="font-mono text-text-muted">{ui.version}</span>
                ) : (
                    <Button
                        variant="secondary"
                        size="sm"
                        className="self-start"
                        onClick={() => {
                            window.location.reload();
                        }}
                    >
                        {m.updates_reload_action()}
                    </Button>
                )}
            </PropertyRow>
            <PropertyRow
                label={m.updates_last_check()}
                hint={check === null ? undefined : checkSentence(check, locale)}
            >
                {check === null ? (
                    <span className="text-text-muted">{m.updates_never_checked()}</span>
                ) : (
                    <RelativeTime value={new Date(check.at)} className="text-text-muted tabular-nums" />
                )}
            </PropertyRow>
            {updates ? (
                <PropertyRow
                    label={m.updates_next_check()}
                    hint={!manual && access.can('settings.manage') ? m.updates_check_now_hint() : undefined}
                >
                    <div className="flex flex-wrap items-center gap-3">
                        <NextCheck ui={ui} manual={manual} />
                        {!manual && access.can('settings.manage') ? <CheckNowButton /> : null}
                    </div>
                </PropertyRow>
            ) : null}
        </>
    );
}
