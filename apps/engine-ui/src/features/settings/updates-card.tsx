import { SemVer, UPDATE_POLICIES } from '@ptbk/engine-api';
import type { ReadSecurityOverview, UpdatePolicy } from '@ptbk/engine-api';
import { Button, CodeText, Field, Input, Select, useLocale } from '@ptbk/ui';
import type { UseQueryResult } from '@tanstack/react-query';
import { useState } from 'react';
import type { SyntheticEvent } from 'react';

import { unwrap } from '../../app/api-errors';
import { useEngineApi } from '../../app/engine-api-context';
import { useStepUpAwareMutation } from '../../app/mutations';
import { m } from '../../paraglide/messages';
import { Facts, FactsSkeleton } from '../security/facts';
import { SectionCard } from '../security/section-card';
import { securityKeys } from '../security/security-keys';
import { updateStatusLabel } from '../security/security-labels';
import { usePermissions } from '../session/use-permissions';

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
        mutationFn: async (next: { readonly policy: PolicyName; readonly pinnedVersion: string }) =>
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
        <form noValidate onSubmit={submit} className="flex max-w-md flex-col gap-4">
            <Field label={m.security_policy_label()} hint={POLICY_HINT[policy]()}>
                {(control) => (
                    <Select
                        {...control}
                        value={policy}
                        onChange={(event) => {
                            const next = UPDATE_POLICIES.find((option) => option === event.target.value);
                            if (next !== undefined) setPolicy(next);
                        }}
                    >
                        {UPDATE_POLICIES.map((option) => (
                            <option key={option} value={option}>
                                {POLICY_LABEL[option]()}
                            </option>
                        ))}
                    </Select>
                )}
            </Field>
            {policy === 'pinned' ? (
                <Field
                    label={m.security_policy_version()}
                    hint={m.security_policy_version_hint({ version: runningVersion })}
                    error={versionError}
                    required
                >
                    {(control) => (
                        <Input
                            {...control}
                            value={version}
                            autoComplete="off"
                            spellCheck={false}
                            maxLength={256}
                            onChange={(event) => {
                                setVersion(event.target.value);
                            }}
                        />
                    )}
                </Field>
            ) : null}
            <div>
                <Button type="submit" variant="primary" loading={save.isPending} disabled={unchanged}>
                    {m.security_policy_save()}
                </Button>
            </div>
        </form>
    );
}

function UpdateFacts({ overview: { engine, update } }: { readonly overview: ReadSecurityOverview }) {
    const locale = useLocale();
    return (
        <Facts
            facts={[
                { label: m.security_version(), value: <CodeText value={engine.version} /> },
                { label: m.security_update_status(), value: updateStatusLabel(update.status) },
                update.availableVersion === null
                    ? null
                    : { label: m.security_update_version(), value: <CodeText value={update.availableVersion} /> },
                update.eligibleAt === null
                    ? null
                    : {
                          label: m.security_update_earliest(),
                          value: (
                              <time dateTime={update.eligibleAt}>
                                  {locale.formatDateTime(new Date(update.eligibleAt))}
                              </time>
                          ),
                      },
            ]}
        />
    );
}

/**
 * The engine's version and update policy, with `security.read` (the policy is part of the security overview). The
 * policy is read-only without `settings.manage`; a change needs a fresh passkey assertion and is logged.
 */
export function UpdatesCard({ query }: { readonly query: UseQueryResult<ReadSecurityOverview> }) {
    const { can } = usePermissions();
    return (
        <SectionCard title={m.settings_updates()} query={query} skeleton={<FactsSkeleton rows={3} />}>
            {(overview) => {
                const { update } = overview;
                return (
                    <div className="flex flex-col gap-5">
                        <UpdateFacts overview={overview} />
                        {can('settings.manage') ? (
                            <div className="flex flex-col gap-3 border-t border-divider pt-5">
                                <p className="text-sm text-text-muted">{m.security_policy_logged()}</p>
                                <PolicyForm
                                    key={`${update.policy}:${update.pinnedVersion ?? ''}`}
                                    current={update}
                                    runningVersion={overview.engine.version}
                                />
                            </div>
                        ) : (
                            <Facts
                                facts={[
                                    {
                                        label: m.security_policy_label(),
                                        value:
                                            update.policy === 'pinned' && update.pinnedVersion !== null ? (
                                                <span>
                                                    {POLICY_LABEL.pinned()} <CodeText value={update.pinnedVersion} />
                                                </span>
                                            ) : (
                                                POLICY_LABEL[update.policy]()
                                            ),
                                    },
                                ]}
                            />
                        )}
                    </div>
                );
            }}
        </SectionCard>
    );
}
