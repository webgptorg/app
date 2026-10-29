import { ROLES } from '@ptbk/engine-api';
import type { Role } from '@ptbk/engine-api';
import { Button, CopyButton, Dialog, Field, Input, Select } from '@ptbk/ui';
import { useId, useState } from 'react';
import type { SyntheticEvent } from 'react';

import { m } from '../../paraglide/messages';
import { roleLabel } from '../shell/role-label';
import type { MemberMutations, MemberTarget } from './use-member-mutations';

/**
 * The contract guarantees only that `owner` holds every permission, so only a member who holds every permission is
 * offered the owner role: nobody hands out more than they hold. The engine decides the rest.
 */
export function assignableRoles(holdsEveryPermission: boolean): readonly Role[] {
    return holdsEveryPermission ? ROLES : ROLES.filter((role) => role !== 'owner');
}

function RoleField({
    roles,
    value,
    onChange,
}: {
    readonly roles: readonly Role[];
    readonly value: Role;
    readonly onChange: (role: Role) => void;
}) {
    return (
        <Field label={m.members_role_label()} hint={m.members_role_hint()}>
            {(control) => (
                <Select
                    {...control}
                    value={value}
                    onChange={(event) => {
                        const next = roles.find((role) => role === event.target.value);
                        if (next !== undefined) onChange(next);
                    }}
                >
                    {roles.map((role) => (
                        <option key={role} value={role}>
                            {roleLabel(role)}
                        </option>
                    ))}
                </Select>
            )}
        </Field>
    );
}

export interface ChangeRoleDialogProps {
    readonly member: MemberTarget & { readonly role: Role };
    readonly roles: readonly Role[];
    readonly mutations: MemberMutations;
    readonly onClose: () => void;
}

export function ChangeRoleDialog({ member, roles, mutations, onClose }: ChangeRoleDialogProps) {
    const formId = useId();
    const [role, setRole] = useState<Role>(member.role);
    const submit = (event: SyntheticEvent<HTMLFormElement>) => {
        event.preventDefault();
        mutations.changeRole.mutate({ member, role }, { onSuccess: onClose });
    };
    return (
        <Dialog
            open
            onClose={onClose}
            title={m.members_change_role_title({ name: member.displayName })}
            description={m.members_change_role_body()}
            footer={
                <>
                    <Button variant="ghost" onClick={onClose}>
                        {m.members_cancel()}
                    </Button>
                    <Button
                        type="submit"
                        form={formId}
                        variant="primary"
                        disabled={role === member.role}
                        loading={mutations.changeRole.isPending}
                    >
                        {m.members_change_role()}
                    </Button>
                </>
            }
        >
            <form id={formId} noValidate onSubmit={submit}>
                <RoleField
                    roles={roles.includes(member.role) ? roles : [member.role, ...roles]}
                    value={role}
                    onChange={setRole}
                />
            </form>
        </Dialog>
    );
}

const INVITE_DAYS = [1, 7, 30] as const;
const DEFAULT_INVITE_DAYS = 7;

function expiryLabel(days: number): string {
    return m.invites_expiry_days({ count: days });
}

interface CreatedInvite {
    readonly url: string;
    readonly role: Role;
    readonly days: number;
}

export interface InviteDialogProps {
    readonly roles: readonly Role[];
    readonly mutations: MemberMutations;
    readonly onClose: () => void;
}

/**
 * Creates an invite link and shows it once. The link carries the invite secret: it lives only in this dialog's state,
 * as text, and is gone when the dialog closes.
 */
export function InviteDialog({ roles, mutations, onClose }: InviteDialogProps) {
    const formId = useId();
    const [role, setRole] = useState<Role>('member');
    const [days, setDays] = useState<number>(DEFAULT_INVITE_DAYS);
    const [created, setCreated] = useState<CreatedInvite | null>(null);

    if (created !== null) {
        return (
            <Dialog
                open
                onClose={onClose}
                title={m.invites_created_title()}
                description={m.invites_created_body({
                    role: roleLabel(created.role),
                    expiry: expiryLabel(created.days),
                })}
                footer={
                    <Button variant="primary" onClick={onClose}>
                        {m.invites_done()}
                    </Button>
                }
            >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                    <Field label={m.invites_link_label()} className="min-w-0 flex-1">
                        {(control) => (
                            <Input
                                {...control}
                                readOnly
                                value={created.url}
                                spellCheck={false}
                                autoComplete="off"
                                className="font-mono"
                                onFocus={(event) => {
                                    event.currentTarget.select();
                                }}
                            />
                        )}
                    </Field>
                    <CopyButton value={created.url} label={m.invites_copy()} />
                </div>
            </Dialog>
        );
    }

    const submit = (event: SyntheticEvent<HTMLFormElement>) => {
        event.preventDefault();
        mutations.invite.mutate({
            role,
            days,
            reveal: (url) => {
                setCreated({ url, role, days });
            },
        });
    };
    return (
        <Dialog
            open
            onClose={onClose}
            title={m.invites_title()}
            description={m.invites_body()}
            footer={
                <>
                    <Button variant="ghost" onClick={onClose}>
                        {m.members_cancel()}
                    </Button>
                    <Button type="submit" form={formId} variant="primary" loading={mutations.invite.isPending}>
                        {m.invites_create()}
                    </Button>
                </>
            }
        >
            <form id={formId} noValidate onSubmit={submit} className="flex flex-col gap-4">
                <RoleField roles={roles} value={role} onChange={setRole} />
                <Field label={m.invites_expiry_label()}>
                    {(control) => (
                        <Select
                            {...control}
                            value={String(days)}
                            onChange={(event) => {
                                setDays(Number(event.target.value));
                            }}
                        >
                            {INVITE_DAYS.map((option) => (
                                <option key={option} value={option}>
                                    {expiryLabel(option)}
                                </option>
                            ))}
                        </Select>
                    )}
                </Field>
            </form>
        </Dialog>
    );
}
