import { ACCESS_CODE_PATTERN, ROLES } from '@ptbk/engine-api';
import type { AccessRequest, Role } from '@ptbk/engine-api';
import {
    ActionMenu,
    Avatar,
    Badge,
    Banner,
    Button,
    Dialog,
    ErrorState,
    Field,
    Input,
    RelativeTime,
    Section,
    STATUS_TINT_CLASSES,
} from '@ptbk/ui';
import type { MenuEntry } from '@ptbk/ui';
import type { UseQueryResult } from '@tanstack/react-query';
import { UserRoundCheck, UserX } from 'lucide-react';
import { useId, useState } from 'react';
import type { SyntheticEvent } from 'react';

import { cx } from '../../app/cx';
import { m } from '../../paraglide/messages';
import { roleLabel } from '../shell/role-label';
import { useResumedStepUp } from '../step-up/step-up';
import { RoleField } from './member-dialogs';
import { APPROVE_ACCESS_ACTION } from './use-member-mutations';
import type { MemberMutations } from './use-member-mutations';

interface ResumedApproval {
    readonly accessRequestId: string;
    readonly role: Role;
}

function parseResumedApproval(data: unknown): ResumedApproval | undefined {
    if (typeof data !== 'object' || data === null) return undefined;
    const { accessRequestId, role } = data as Record<string, unknown>;
    const known = ROLES.find((option) => option === role);
    if (typeof accessRequestId !== 'string' || accessRequestId.length > 64 || known === undefined) return undefined;
    return { accessRequestId, role: known };
}

interface ApproveDialogProps {
    readonly request: AccessRequest;
    /** The request is no longer listed: the last wrong code removed it, or it was handled elsewhere or expired. */
    readonly gone: boolean;
    readonly initialRole: Role;
    readonly resumed: boolean;
    readonly mutations: MemberMutations;
    readonly onClose: () => void;
}

/** The code is what makes approving safe: the dashboard's name and email are only hints, the code ties the request to the person. */
function ApproveDialog({ request, gone, initialRole, resumed, mutations, onClose }: ApproveDialogProps) {
    const formId = useId();
    const [code, setCode] = useState('');
    const [role, setRole] = useState<Role>(initialRole);
    const [error, setError] = useState<string | undefined>(undefined);
    const [mismatched, setMismatched] = useState(false);
    if (gone) {
        return (
            <Dialog
                open
                onClose={onClose}
                title={m.access_approve_title({ name: request.displayName })}
                description={
                    mismatched
                        ? m.access_removed_after_codes({ name: request.displayName })
                        : m.access_request_gone({ name: request.displayName })
                }
                footer={
                    <Button variant="secondary" onClick={onClose}>
                        {m.ui_close()}
                    </Button>
                }
            >
                {null}
            </Dialog>
        );
    }
    const submit = (event: SyntheticEvent<HTMLFormElement>) => {
        event.preventDefault();
        const typed = code.replace(/\s/g, '');
        if (!ACCESS_CODE_PATTERN.test(typed)) {
            setError(m.access_code_invalid());
            return;
        }
        setError(undefined);
        mutations.approveAccess.mutate(
            { request, code: typed, role },
            {
                onSuccess: (outcome) => {
                    if (outcome === 'approved') {
                        onClose();
                        return;
                    }
                    setMismatched(true);
                    setError(m.access_code_mismatch({ name: request.displayName }));
                },
            },
        );
    };
    return (
        <Dialog
            open
            onClose={onClose}
            title={m.access_approve_title({ name: request.displayName })}
            description={m.access_approve_body({ name: request.displayName })}
            footer={
                <>
                    <Button variant="ghost" onClick={onClose}>
                        {m.members_cancel()}
                    </Button>
                    <Button type="submit" form={formId} variant="primary" loading={mutations.approveAccess.isPending}>
                        {m.access_approve()}
                    </Button>
                </>
            }
        >
            <form id={formId} noValidate onSubmit={submit} className="flex flex-col gap-4">
                {resumed ? <Banner tone="info">{m.step_up_resumed()}</Banner> : null}
                <Field label={m.access_code_label()} hint={m.access_code_hint()} error={error} required>
                    {(control) => (
                        <Input
                            {...control}
                            value={code}
                            inputMode="numeric"
                            autoComplete="off"
                            spellCheck={false}
                            maxLength={7}
                            // Read out digit by digit and compared by eye: large, spaced and centred, like a sign-in code.
                            className="h-14 w-48 text-center font-mono text-2xl tracking-[0.35em] tabular-nums"
                            onChange={(event) => {
                                setCode(event.target.value);
                            }}
                        />
                    )}
                </Field>
                <RoleField value={role} onChange={setRole} />
            </form>
        </Dialog>
    );
}

interface RequestRowProps {
    readonly request: AccessRequest;
    /** `null` without `members.manage`: the request is listed, nothing more. */
    readonly onApprove: (() => void) | null;
    readonly onDecline: (() => void) | null;
}

function RequestRow({ request, onApprove, onDecline }: RequestRowProps) {
    const items: MenuEntry[] =
        onDecline === null
            ? []
            : [
                  {
                      kind: 'item',
                      id: 'decline',
                      label: m.access_decline(),
                      icon: <UserX />,
                      tone: 'danger',
                      onSelect: onDecline,
                  },
              ];
    return (
        <li
            className={cx(
                'soft-surface flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3',
                STATUS_TINT_CLASSES.warning,
            )}
        >
            <Avatar name={request.displayName} size="md" />
            <div className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
                {/* Name and email come from the dashboard's ticket: untrusted text, rendered as text. */}
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-sm font-medium break-words">{request.displayName}</span>
                    <Badge>{m.access_proposed_role({ role: roleLabel(request.proposedRole) })}</Badge>
                </span>
                <span className="text-xs break-words text-text-muted">
                    {request.email} · {m.access_asked()}{' '}
                    <RelativeTime value={new Date(request.createdAt)} className="tabular-nums" />
                </span>
            </div>
            {onApprove === null ? null : (
                <div className="ms-auto flex shrink-0 items-center gap-1">
                    <Button size="sm" variant="primary" onClick={onApprove}>
                        <UserRoundCheck aria-hidden className="size-4" />
                        {m.access_approve()}
                    </Button>
                    <ActionMenu
                        items={items}
                        label={m.access_actions_for({ name: request.displayName })}
                        size="sm"
                        variant="ghost"
                    />
                </div>
            )}
        </li>
    );
}

export interface AccessRequestsProps {
    readonly query: UseQueryResult<{ readonly items: readonly AccessRequest[] }>;
    readonly canManage: boolean;
    readonly mutations: MemberMutations;
}

interface Approving {
    readonly request: AccessRequest;
    readonly role: Role;
    readonly resumed: boolean;
}

/**
 * People the organization invited, waiting for someone here to let them in (`access-requests@1`). Nothing shows while
 * none wait. Coming back from step-up reopens the approval the member had started, without the code.
 */
export function AccessRequests({ query, canManage, mutations }: AccessRequestsProps) {
    const [chosen, setChosen] = useState<Approving | null>(null);
    const [resumeDismissed, setResumeDismissed] = useState(false);
    const resumed = useResumedStepUp(APPROVE_ACCESS_ACTION, parseResumedApproval);
    const requests = query.data?.items;
    const resumedRequest =
        resumed === undefined || resumeDismissed || !canManage
            ? undefined
            : requests?.find((candidate) => candidate.id === resumed.accessRequestId);
    const approving: Approving | null =
        chosen ??
        (resumedRequest === undefined || resumed === undefined
            ? null
            : { request: resumedRequest, role: resumed.role, resumed: true });
    const close = () => {
        setChosen(null);
        setResumeDismissed(true);
    };
    if (query.isError) {
        return (
            <Section title={m.access_title()} divided={false}>
                <ErrorState
                    message={m.access_load_failed()}
                    onRetry={() => {
                        void query.refetch();
                    }}
                    retrying={query.isFetching}
                />
            </Section>
        );
    }
    const dialog =
        approving === null ? null : (
            <ApproveDialog
                key={approving.request.id}
                request={approving.request}
                gone={requests !== undefined && !requests.some(({ id }) => id === approving.request.id)}
                initialRole={approving.role}
                resumed={approving.resumed}
                mutations={mutations}
                onClose={close}
            />
        );
    // The dialog sits beside the card, not in it, so it outlives the last row: a request that disappears while it is
    // open says why instead of vanishing.
    return (
        <>
            {requests === undefined || requests.length === 0 ? null : (
                <Section
                    title={m.access_title()}
                    count={requests.length}
                    description={m.access_intro()}
                    divided={false}
                >
                    <ul className="flex flex-col gap-2">
                        {requests.map((request) => (
                            <RequestRow
                                key={request.id}
                                request={request}
                                onApprove={
                                    canManage
                                        ? () => {
                                              setChosen({ request, role: request.proposedRole, resumed: false });
                                          }
                                        : null
                                }
                                onDecline={
                                    canManage
                                        ? () => {
                                              mutations.declineAccess.mutate(request);
                                          }
                                        : null
                                }
                            />
                        ))}
                    </ul>
                </Section>
            )}
            {dialog}
        </>
    );
}
