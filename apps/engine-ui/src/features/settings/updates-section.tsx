import { SemVer, UPDATE_POLICIES } from '@ptbk/engine-api';
import type { ReadSecurityOverview, UpdatePolicy } from '@ptbk/engine-api';
import { Button, CodeText, Combobox, ErrorState, Input, Section, Skeleton, StatusPill, useLocale } from '@ptbk/ui';
import type { StatusTone } from '@ptbk/ui';
import type { UseQueryResult } from '@tanstack/react-query';
import { useState } from 'react';
import type { SyntheticEvent } from 'react';

import { unwrap } from '../../app/api-errors';
import { useEngineApi } from '../../app/engine-api-context';
import { useStepUpAwareMutation } from '../../app/mutations';
import { m } from '../../paraglide/messages';
import { securityKeys } from '../security/security-keys';
import { updateStatusLabel } from '../security/security-labels';
import { usePermissions } from '../session/use-permissions';
import { PropertyList, PropertyRow } from './property-row';
import { UiUpdateRows } from './ui-updates';

type PolicyName = UpdatePolicy['policy'];

const MUTATION_TIMEOUT_MS = 30_000;

const POLICY_LABEL: Readonly<Record<PolicyName, () => string>> = {
    auto: m.security_policy_auto,
    manual: m.security_policy_manual,
    pinned: m.security_policy_pinned,
};

const POLICY_HINT: Readonly<Record<PolicyName, () => string>> = {
    auto: m.security_policy_auto_hint,
    manual: m.security_policy_manual_hint,
    pinned: m.security_policy_pinned_hint,
};

function policyText(policy: PolicyName, pinnedVersion: string | null): string {
    return policy === 'pinned' && pinnedVersion !== null
        ? m.security_policy_pinned_to({ version: pinnedVersion })
        : POLICY_LABEL[policy]();
}

const UPDATE_TONE: Readonly<Record<ReadSecurityOverview['update']['status'], StatusTone>> = {
    none: 'success',
    available: 'info',
    pending: 'waiting',
    installing: 'live',
};

const POLICY_ACTION = 'settings.update-policy';

interface PolicyChange {
    readonly policy: PolicyName;
    readonly pinnedVersion: string;
}

function parsePolicyChange(data: unknown): PolicyChange | undefined {
    if (typeof data !== 'object' || data === null) return undefined;
    const { policy, pinnedVersion } = data as Record<string, unknown>;
    const name = UPDATE_POLICIES.find((option) => option === policy);
    if (name === undefined || typeof pinnedVersion !== 'string' || pinnedVersion.length > 256) return undefined;
    return { policy: name, pinnedVersion };
}

interface PolicyFormProps {
    readonly current: ReadSecurityOverview['update'];
    /** What a new pin starts from: pinning usually means "stay where you are". */
    readonly runningVersion: string;
}

function PolicyForm({ current, runningVersion }: PolicyFormProps) {
    const engineApi = useEngineApi();
    const [policy, setPolicy] = useState<PolicyName>(current.policy);
    const [version, setVersion] = useState(current.pinnedVersion ?? runningVersion);
    const [versionError, setVersionError] = useState<string | undefined>(undefined);
    const save = useStepUpAwareMutation({
        mutationFn: async (next: PolicyChange) =>
            unwrap(
                await engineApi.settings.setUpdatePolicy(
                    next.policy === 'pinned'
                        ? { policy: 'pinned', pinnedVersion: next.pinnedVersion }
                        : { policy: next.policy },
                    AbortSignal.timeout(MUTATION_TIMEOUT_MS),
                ),
            ),
        invalidates: [securityKeys.overview()],
        successMessage: (saved) => m.security_policy_saved({ policy: policyText(saved.policy, saved.pinnedVersion) }),
        errorMessage: () => m.security_policy_failed(),
        // The policy is the whole input and no secret: back from a full-page step-up, it is saved without a click.
        resumeAs: { action: POLICY_ACTION, data: (next) => next, rerun: parsePolicyChange },
    });
    const unchanged = policy === current.policy && (policy !== 'pinned' || version === current.pinnedVersion);

    const submit = (event: SyntheticEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (policy === 'pinned' && !SemVer.safeParse(version.trim()).success) {
            setVersionError(m.security_policy_version_invalid());
            return;
        }
        setVersionError(undefined);
        save.mutate({ policy, pinnedVersion: version.trim() });
    };

    return (
        <form noValidate onSubmit={submit} className="flex flex-col divide-y divide-hairline">
            <PropertyRow label={m.security_policy_label()} hint={POLICY_HINT[policy]()}>
                {({ labelId, hintId }) => (
                    <Combobox
                        aria-labelledby={labelId}
                        aria-describedby={hintId}
                        className="w-full sm:w-56"
                        value={policy}
                        options={UPDATE_POLICIES.map((option) => ({ value: option, label: POLICY_LABEL[option]() }))}
                        onChange={(value) => {
                            const next = UPDATE_POLICIES.find((option) => option === value);
                            if (next !== undefined) setPolicy(next);
                        }}
                    />
                )}
            </PropertyRow>
            {policy === 'pinned' ? (
                <PropertyRow
                    label={m.security_policy_version()}
                    hint={
                        versionError === undefined ? (
                            m.security_policy_version_hint({ version: runningVersion })
                        ) : (
                            <span className="text-danger">{versionError}</span>
                        )
                    }
                >
                    {({ labelId, hintId }) => (
                        <Input
                            aria-labelledby={labelId}
                            aria-describedby={hintId}
                            aria-invalid={versionError === undefined ? undefined : true}
                            required
                            value={version}
                            autoComplete="off"
                            spellCheck={false}
                            maxLength={256}
                            className="w-full font-mono sm:w-56"
                            onChange={(event) => {
                                setVersion(event.target.value);
                            }}
                        />
                    )}
                </PropertyRow>
            ) : null}
            <div className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs text-text-muted">{m.security_policy_logged()}</p>
                {/* Enabled only once something changed: a save that would change nothing never asks for a passkey. */}
                <Button
                    type="submit"
                    variant="primary"
                    size="sm"
                    className="self-start sm:self-auto"
                    loading={save.isPending}
                    disabled={unchanged}
                >
                    {m.security_policy_save()}
                </Button>
            </div>
        </form>
    );
}

function UpdateFacts({ overview: { engine, update } }: { readonly overview: ReadSecurityOverview }) {
    const locale = useLocale();
    return (
        <>
            <PropertyRow label={m.security_version()}>
                <span className="font-mono text-text-muted">{engine.version}</span>
            </PropertyRow>
            <PropertyRow label={m.security_update_status()}>
                <StatusPill tone={UPDATE_TONE[update.status]} variant="quiet">
                    {updateStatusLabel(update.status)}
                </StatusPill>
            </PropertyRow>
            {update.availableVersion === null ? null : (
                <PropertyRow label={m.security_update_version()}>
                    <span className="font-mono text-text-muted">{update.availableVersion}</span>
                </PropertyRow>
            )}
            {update.eligibleAt === null ? null : (
                <PropertyRow label={m.security_update_earliest()}>
                    <time dateTime={update.eligibleAt} className="text-text-muted tabular-nums">
                        {locale.formatDateTime(new Date(update.eligibleAt))}
                    </time>
                </PropertyRow>
            )}
            {/* Shown only with a newer version to install: the command is the engine's, copied and run by hand. */}
            {update.command === null || update.availableVersion === null ? null : (
                <PropertyRow label={m.updates_engine_command()} hint={m.updates_engine_command_hint()}>
                    <CodeText value={update.command} copyable copyLabel={m.updates_copy_command()} />
                </PropertyRow>
            )}
        </>
    );
}

/**
 * The engine's version and update policy, with `security.read` (the policy is part of the security overview). The
 * policy is read-only without `settings.manage`; a change needs a fresh passkey assertion and is logged.
 */
export function UpdatesSection({ query }: { readonly query: UseQueryResult<ReadSecurityOverview> }) {
    const { can } = usePermissions();
    let content;
    if (query.isError) {
        content = (
            <ErrorState
                message={m.section_load_failed()}
                onRetry={() => {
                    void query.refetch();
                }}
                retrying={query.isFetching}
            />
        );
    } else if (query.data === undefined) {
        content = <Skeleton shape="block" className="h-32 w-full" />;
    } else {
        const overview = query.data;
        const { update } = overview;
        content = (
            <PropertyList>
                <UpdateFacts overview={overview} />
                <UiUpdateRows overview={overview} />
                {can('settings.manage') ? (
                    <PolicyForm
                        key={`${update.policy}:${update.pinnedVersion ?? ''}`}
                        current={update}
                        runningVersion={overview.engine.version}
                    />
                ) : (
                    <PropertyRow label={m.security_policy_label()}>
                        {update.policy === 'pinned' && update.pinnedVersion !== null ? (
                            <span>
                                {POLICY_LABEL.pinned()}{' '}
                                <span className="font-mono text-text-muted">{update.pinnedVersion}</span>
                            </span>
                        ) : (
                            POLICY_LABEL[update.policy]()
                        )}
                    </PropertyRow>
                )}
            </PropertyList>
        );
    }
    return <Section title={m.settings_updates()}>{content}</Section>;
}
