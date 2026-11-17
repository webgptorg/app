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
    RelativeTime,
    Section,
    STATUS_TINT_CLASSES,
} from '@ptbk/ui';
import type { MenuEntry } from '@ptbk/ui';
import type { UseQueryResult } from '@tanstack/react-query';
import { UserRoundCheck, UserX } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode, SyntheticEvent } from 'react';

import { cx } from '../../app/cx';
import { m } from '../../paraglide/messages';
import { roleLabel } from '../shell/role-label';
import { useResumedStepUp } from '../step-up/step-up';
import { AccessCodeInput } from './access-code-input';
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

function mismatchMessage(name: string, attemptsRemaining: number | undefined): string {
    return attemptsRemaining === undefined
        ? m.access_code_mismatch({ name })
        : m.access_code_mismatch_left({ name, count: attemptsRemaining });
}

/**
 * The code is what makes approving safe: the dashboard's name and email are only hints, the code ties the request to
 * the person. Role first, then the code: the sixth digit submits, and the engine may then ask for a fresh passkey.
 */
function ApproveDialog({ request, gone, initialRole, resumed, mutations, onClose }: ApproveDialogProps) {
    const formId = useId();
    const [code, setCode] = useState('');
    const [role, setRole] = useState<Role>(initialRole);
    const [error, setError] = useState<string | undefined>(undefined);
    const [mismatched, setMismatched] = useState(false);
    const codeInput = useRef<HTMLInputElement>(null);
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
    const approve = (typed: string) => {
        if (mutations.approveAccess.isPending) return;
        if (!ACCESS_CODE_PATTERN.test(typed)) {
            setError(m.access_code_invalid());
            codeInput.current?.focus();
            return;
        }
        setError(undefined);
        mutations.approveAccess.mutate(
            { request, code: typed, role },
            {
                onSuccess: (outcome) => {
                    if (outcome.kind === 'approved') {
                        onClose();
                        return;
                    }
                    setMismatched(true);
                    setCode('');
                    setError(mismatchMessage(request.displayName, outcome.attemptsRemaining));
                    codeInput.current?.focus();
                },
            },
        );
    };
    const submit = (event: SyntheticEvent<HTMLFormElement>) => {
        event.preventDefault();
        approve(code);
    };
    return (
        <Dialog
            open
            onClose={onClose}
            title={m.access_approve_title({ name: request.displayName })}
            description={m.access_approve_body({ name: request.displayName })}
            initialFocusRef={codeInput}
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
            <form id={formId} noValidate onSubmit={submit} className="flex flex-col gap-5">
                {resumed ? <Banner tone="info">{m.step_up_resumed()}</Banner> : null}
                {/* From the dashboard's ticket: untrusted text, rendered as text and labelled as a hint. */}
                <p className="text-sm break-words text-text-muted">
                    {m.access_reported_by_organization({ email: request.email })}
                </p>
                <RoleField value={role} onChange={setRole} />
                <Field label={m.access_code_label()} hint={m.access_code_hint()} error={error} required>
                    {(control) => (
                        <AccessCodeInput
                            {...control}
                            ref={codeInput}
                            value={code}
                            onChange={(next) => {
                                setCode(next);
                                if (error !== undefined && next !== '') setError(undefined);
                            }}
                            onComplete={approve}
                        />
                    )}
                </Field>
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
    /** `?request=<id>` from the approver's email or Home: that request's dialog opens on arrival. */
    readonly linkedRequestId?: string | undefined;
    /** The linked dialog was closed, so the page can drop `?request` from the URL. */
    readonly onLinkClosed?: () => void;
}

interface Approving {
    readonly request: AccessRequest;
    readonly role: Role;
    readonly resumed: boolean;
}

function LinkGoneDialog({ onClose }: { readonly onClose: () => void }) {
    return (
        <Dialog
            open
            onClose={onClose}
            title={m.access_link_gone_title()}
            description={m.access_link_gone_body()}
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

/**
 * People the organization invited, waiting for someone here to let them in (`access-requests@1`). Nothing shows while
 * none wait. Coming back from step-up reopens the approval the member had started, without the code; a link with
 * `?request=<id>` opens that request's dialog, which still waits for the code, so the link alone changes nothing.
 */
export function AccessRequests({ query, canManage, mutations, linkedRequestId, onLinkClosed }: AccessRequestsProps) {
    const [chosen, setChosen] = useState<Approving | null>(null);
    const [resumeDismissed, setResumeDismissed] = useState(false);
    const [dismissedLink, setDismissedLink] = useState<string | undefined>(undefined);
    const [opened, setOpened] = useState<string | undefined>(undefined);
    const resumed = useResumedStepUp(APPROVE_ACCESS_ACTION, parseResumedApproval);
    const requests = query.data?.items;
    const resumedRequest =
        resumed === undefined || resumeDismissed || !canManage
            ? undefined
            : requests?.find((candidate) => candidate.id === resumed.accessRequestId);
    const linked = !canManage || linkedRequestId === dismissedLink ? undefined : linkedRequestId;
    const linkedRequest = linked === undefined ? undefined : requests?.find((candidate) => candidate.id === linked);
    // A list cached before the request arrived would call it gone: only a list fetched on this visit decides that.
    const { isFetchedAfterMount, isFetching, refetch } = query;
    const linkUnchecked = linked !== undefined && linkedRequest === undefined && !isFetchedAfterMount;
    useEffect(() => {
        if (linkUnchecked && !isFetching) void refetch();
    }, [linkUnchecked, isFetching, refetch]);
    const linkGone =
        linked !== undefined && linkedRequest === undefined && requests !== undefined && isFetchedAfterMount;
    let arriving: Approving | null = null;
    if (resumedRequest !== undefined && resumed !== undefined)
        arriving = { request: resumedRequest, role: resumed.role, resumed: true };
    else if (linkedRequest !== undefined)
        arriving = { request: linkedRequest, role: linkedRequest.proposedRole, resumed: false };
    // Held as chosen, so the dialog stays open to say why once the request leaves the list (the last wrong code).
    const arrivingKey = arriving === null ? undefined : `${String(arriving.resumed)}:${arriving.request.id}`;
    if (chosen === null && arriving !== null && arrivingKey !== opened) {
        setOpened(arrivingKey);
        setChosen(arriving);
    }
    const approving = chosen ?? arriving;
    const close = () => {
        setChosen(null);
        setResumeDismissed(true);
        if (linked !== undefined) {
            setDismissedLink(linked);
            onLinkClosed?.();
        }
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
    let dialog: ReactNode = null;
    if (approving !== null) {
        const { request } = approving;
        dialog = (
            <ApproveDialog
                key={request.id}
                request={request}
                gone={requests !== undefined && !requests.some(({ id }) => id === request.id)}
                initialRole={approving.role}
                resumed={approving.resumed}
                mutations={mutations}
                onClose={close}
            />
        );
    } else if (linkGone) dialog = <LinkGoneDialog onClose={close} />;
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
