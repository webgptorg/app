import type { Invite, MemberId } from '@ptbk/engine-api';
import { Card, ConfirmDialog, ErrorState, IconButton, Menu, RelativeTime } from '@ptbk/ui';
import type { MenuEntry } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { Ban, Ellipsis, Link2 } from 'lucide-react';
import { useState } from 'react';

import { useEngineApi } from '../../app/engine-api-context';
import { m } from '../../paraglide/messages';
import { roleLabel } from '../shell/role-label';
import { memberDetailQueryOptions } from './members-queries';
import type { MemberMutations } from './use-member-mutations';

function CreatorName({ memberId }: { readonly memberId: MemberId }) {
    const member = useQuery(memberDetailQueryOptions(useEngineApi(), memberId));
    return <>{member.data?.displayName ?? m.invites_creator_unknown()}</>;
}

function InviteRow({ invite, onRevoke }: { readonly invite: Invite; readonly onRevoke: (() => void) | null }) {
    const title = m.invites_row_title({ role: roleLabel(invite.role) });
    const menuLabel = m.invites_actions_for({ invite: title });
    const items: MenuEntry[] =
        onRevoke === null
            ? []
            : [
                  {
                      kind: 'item',
                      id: 'revoke',
                      label: m.invites_revoke(),
                      icon: <Ban />,
                      tone: 'danger',
                      onSelect: onRevoke,
                  },
              ];
    return (
        <li className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
            <Link2 aria-hidden className="mt-0.5 size-5 shrink-0 text-text-muted" />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="font-medium">{title}</span>
                <span className="text-sm break-words text-text-muted">
                    {m.invites_created_by()} <CreatorName memberId={invite.createdBy} />{' '}
                    <RelativeTime value={new Date(invite.createdAt)} />
                    {' · '}
                    {m.invites_expires()} <RelativeTime value={new Date(invite.expiresAt)} />
                </span>
            </div>
            {items.length === 0 ? null : (
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
            )}
        </li>
    );
}

export interface PendingInvitesProps {
    readonly query: UseQueryResult<{ readonly items: readonly Invite[] }>;
    readonly canManage: boolean;
    readonly mutations: MemberMutations;
}

/** Invites nobody has used yet. Nothing shows while there are none: the page header offers the next invite. */
export function PendingInvites({ query, canManage, mutations }: PendingInvitesProps) {
    const [target, setTarget] = useState<Invite | null>(null);
    const close = () => {
        setTarget(null);
    };
    if (query.isError) {
        return (
            <Card title={m.invites_pending()}>
                <ErrorState
                    message={m.section_load_failed()}
                    onRetry={() => {
                        void query.refetch();
                    }}
                    retrying={query.isFetching}
                />
            </Card>
        );
    }
    const invites = query.data?.items ?? [];
    if (invites.length === 0) return null;
    return (
        <Card title={m.invites_pending()}>
            <ul className="flex flex-col divide-y divide-divider">
                {invites.map((invite) => (
                    <InviteRow
                        key={invite.id}
                        invite={invite}
                        onRevoke={
                            canManage
                                ? () => {
                                      setTarget(invite);
                                  }
                                : null
                        }
                    />
                ))}
            </ul>
            {target === null ? null : (
                <ConfirmDialog
                    open
                    onClose={close}
                    tone="danger"
                    title={m.invites_revoke_title({ role: roleLabel(target.role) })}
                    description={m.invites_revoke_body()}
                    confirmLabel={m.invites_revoke()}
                    loading={mutations.revokeInvite.isPending}
                    onConfirm={() => {
                        mutations.revokeInvite.mutate(target, { onSuccess: close });
                    }}
                />
            )}
        </Card>
    );
}
