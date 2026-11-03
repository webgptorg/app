import { ACCESS_CODE_PATTERN, ROLES } from '@ptbk/engine-api';
import type { AccessRequest, Role } from '@ptbk/engine-api';
import { Banner, Button, Card, Dialog, ErrorState, Field, IconButton, Input, Menu, RelativeTime } from '@ptbk/ui';
import type { MenuEntry } from '@ptbk/ui';
import type { UseQueryResult } from '@tanstack/react-query';
import { Ellipsis, UserRoundCheck, UserX } from 'lucide-react';
import { useId, useState } from 'react';
import type { SyntheticEvent } from 'react';

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
                <Field label={m.access_code_label()} error={error} required>
                    {(control) => (
                        <Input
                            {...control}
                            value={code}
                            inputMode="numeric"
                            autoComplete="off"
                            spellCheck={false}
                            maxLength={7}
                            className="w-32 font-mono tracking-widest tabular-nums"
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
    const menuLabel = m.access_actions_for({ name: request.displayName });
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
        <li className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                {/* Name and email come from the dashboard's ticket: untrusted text, rendered as text. */}
                <span className="font-medium break-words">{request.displayName}</span>
                <span className="text-sm break-words text-text-muted">
                    {request.email} · {m.access_asked()} <RelativeTime value={new Date(request.createdAt)} />
                </span>
                <span className="text-sm text-text-muted">
                    {m.access_proposed_role({ role: roleLabel(request.proposedRole) })}
                </span>
            </div>
            {onApprove === null ? null : (
                <div className="flex items-center gap-1">
                    <Button size="sm" onClick={onApprove}>
                        <UserRoundCheck aria-hidden className="size-4" />
                        {m.access_approve()}
                    </Button>
                    <Menu
                        label={menuLabel}
                        align="end"
                        items={items}
                        trigger={(triggerProps) => (
                            <IconButton
                                {...triggerProps}
                                variant="ghost"
                                size="sm"
                                label={menuLabel}
                                icon={<Ellipsis aria-hidden className="size-4" />}
                            />
                        )}
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
            <Card title={m.access_title()}>
                <ErrorState
                    message={m.access_load_failed()}
                    onRetry={() => {
                        void query.refetch();
                    }}
                    retrying={query.isFetching}
                />
            </Card>
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
                <Card title={m.access_title()}>
                    <div className="flex flex-col gap-4">
                        <p className="text-sm text-text-muted">{m.access_intro()}</p>
                        <ul className="flex flex-col divide-y divide-divider">
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
                    </div>
                </Card>
            )}
            {dialog}
        </>
    );
}
