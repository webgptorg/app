import { ROLES } from '@ptbk/engine-api';
import type { Role } from '@ptbk/engine-api';
import { Button, Combobox, Dialog, Field } from '@ptbk/ui';
import { useId, useState } from 'react';
import type { SyntheticEvent } from 'react';

import { m } from '../../paraglide/messages';
import { roleLabel } from '../shell/role-label';
import type { MemberMutations, MemberTarget } from './use-member-mutations';

/** Every role is offered; which roles a member may grant, and to whom, is the engine's policy and it refuses the rest. */
export function RoleField({ value, onChange }: { readonly value: Role; readonly onChange: (role: Role) => void }) {
    return (
        <Field label={m.members_role_label()} hint={m.members_role_hint()}>
            {(control) => (
                <Combobox
                    {...control}
                    className="w-full"
                    value={value}
                    options={ROLES.map((role) => ({ value: role, label: roleLabel(role) }))}
                    onChange={(picked) => {
                        const next = ROLES.find((role) => role === picked);
                        if (next !== undefined) onChange(next);
                    }}
                />
            )}
        </Field>
    );
}

export interface ChangeRoleDialogProps {
    readonly member: MemberTarget & { readonly role: Role };
    readonly mutations: MemberMutations;
    readonly onClose: () => void;
}

export function ChangeRoleDialog({ member, mutations, onClose }: ChangeRoleDialogProps) {
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
                <RoleField value={role} onChange={setRole} />
            </form>
        </Dialog>
    );
}
