import { SemVer, UPDATE_POLICIES } from '@ptbk/engine-api';
import type { ReadSecurityOverview, UpdatePolicy } from '@ptbk/engine-api';
import { Button, CodeText, Field, Input, Select } from '@ptbk/ui';
import type { UseQueryResult } from '@tanstack/react-query';
import { useState } from 'react';
import type { SyntheticEvent } from 'react';

import { unwrap } from '../../app/api-errors';
import { useEngineApi } from '../../app/engine-api-context';
import { useStepUpAwareMutation } from '../../app/mutations';
import { m } from '../../paraglide/messages';
import { usePermissions } from '../session/use-permissions';
import { Facts, FactsSkeleton } from './facts';
import { SectionCard } from './section-card';
import { securityKeys } from './security-keys';

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

function PolicyForm({ current }: { readonly current: ReadSecurityOverview['update'] }) {
    const engineApi = useEngineApi();
    const [policy, setPolicy] = useState<PolicyName>(current.policy);
    const [version, setVersion] = useState(current.pinnedVersion ?? '');
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
                <Field label={m.security_policy_version()} error={versionError} required>
                    {(control) => (
                        <Input
                            {...control}
                            value={version}
                            placeholder="1.4.0"
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

/** The update policy: read-only without `settings.manage`; a change needs a fresh passkey assertion and is logged. */
export function UpdatePolicySection({ query }: { readonly query: UseQueryResult<ReadSecurityOverview> }) {
    const { can } = usePermissions();
    return (
        <SectionCard title={m.security_policy_title()} query={query} skeleton={<FactsSkeleton rows={2} />}>
            {({ update }) => (
                <div className="flex flex-col gap-4">
                    <p className="text-sm text-text-muted">{m.security_policy_logged()}</p>
                    {can('settings.manage') ? (
                        <PolicyForm key={`${update.policy}:${update.pinnedVersion ?? ''}`} current={update} />
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
            )}
        </SectionCard>
    );
}
