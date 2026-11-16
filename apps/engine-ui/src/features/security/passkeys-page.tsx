import type { MemberId, PasskeyId, ReadPasskey } from '@ptbk/engine-api';
import { ActionMenu, ConfirmDialog, EmptyState, RelativeTime, StatusPill } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { Cloud, Fingerprint, Key, KeyRound } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { unwrap } from '../../app/api-errors';
import { useEngineApi } from '../../app/engine-api-context';
import { isPageLevelFailure } from '../../app/list-errors';
import { useStepUpAwareMutation } from '../../app/mutations';
import { m } from '../../paraglide/messages';
import { memberKeys } from '../members/members-keys';
import { memberDetailQueryOptions } from '../members/members-queries';
import { useCurrentMember } from '../session/use-current-member';
import { usePermissions } from '../session/use-permissions';
import { Crumb, Page } from '../shell/page';
import { useResumedStepUp } from '../step-up/step-up';
import { FactsSkeleton } from './facts';
import { QuerySection } from './query-section';
import { CredentialRow, MetaDot } from './security-parts';
import { securityKeys } from './security-keys';
import {
    allPasskeysQueryOptions,
    CREDENTIALS_PAGE_SIZE,
    myPasskeysQueryOptions,
    mySessionsQueryOptions,
} from './security-queries';

const MUTATION_TIMEOUT_MS = 30_000;
const FIRST_PAGE = { limit: CREDENTIALS_PAGE_SIZE } as const;

interface PasskeyPageData {
    readonly items: readonly ReadPasskey[];
    readonly nextCursor: string | null;
}

interface RevokeTarget {
    readonly passkey: ReadPasskey;
    /** Mine go through `/me/passkeys`, which needs no permission; others' through the admin route. */
    readonly own: boolean;
    readonly current: boolean;
}

const REVOKE_ACTION = 'security.revoke-passkey';

function parseRevoke(data: unknown): { readonly passkeyId: string } | undefined {
    if (typeof data !== 'object' || data === null) return undefined;
    const { passkeyId } = data as Record<string, unknown>;
    return typeof passkeyId === 'string' && passkeyId.length <= 256 ? { passkeyId } : undefined;
}

function displayName(passkey: ReadPasskey): string {
    return passkey.name === '' ? m.passkeys_unnamed() : passkey.name;
}

/** Members whose only listed passkey is this one: the engine refuses to revoke it, so the UI never offers it. */
function lastPasskeyIds(items: readonly ReadPasskey[], complete: boolean): ReadonlySet<PasskeyId> {
    if (!complete) return new Set();
    const counts = new Map<MemberId, number>();
    for (const { memberId } of items) counts.set(memberId, (counts.get(memberId) ?? 0) + 1);
    return new Set(items.filter(({ memberId }) => counts.get(memberId) === 1).map(({ id }) => id));
}

function kindLabel(passkey: ReadPasskey): string {
    const attachment = passkey.authenticator?.attachment ?? null;
    if (attachment === 'platform') return m.passkeys_kind_platform();
    if (attachment === 'cross-platform') return m.passkeys_kind_roaming();
    return m.passkeys_kind_unknown();
}

/** Built-in authenticators unlock with the device's own check (Touch ID, Windows Hello); a roaming one is a key. */
function KindIcon({ passkey }: { readonly passkey: ReadPasskey }) {
    const attachment = passkey.authenticator?.attachment ?? null;
    if (attachment === 'platform') return <Fingerprint />;
    if (attachment === 'cross-platform') return <KeyRound />;
    return <Key />;
}

/** Synced or bound to one device, in words with a small cloud for synced ones; nothing when the engine cannot tell. */
function Backup({ passkey }: { readonly passkey: ReadPasskey }) {
    const backedUp = passkey.authenticator?.backedUp ?? null;
    if (backedUp === null) return null;
    return (
        <>
            <MetaDot />
            <span className="inline-flex items-center gap-1">
                {backedUp ? <Cloud aria-hidden className="size-3" /> : null}
                {backedUp ? m.passkeys_synced() : m.passkeys_device_bound()}
            </span>
        </>
    );
}

function MemberName({ memberId }: { readonly memberId: MemberId }) {
    const member = useQuery(memberDetailQueryOptions(useEngineApi(), memberId));
    return member.data === undefined ? (
        <span className="font-mono">{memberId}</span>
    ) : (
        <span className="font-medium text-text">{member.data.displayName}</span>
    );
}

function PasskeyMeta({ passkey, showOwner }: { readonly passkey: ReadPasskey; readonly showOwner: boolean }) {
    let owner: ReactNode = null;
    if (showOwner)
        owner = (
            <>
                <MemberName memberId={passkey.memberId} />
                <MetaDot />
            </>
        );
    return (
        <>
            {owner}
            <span>{kindLabel(passkey)}</span>
            <Backup passkey={passkey} />
            <MetaDot />
            <span>
                {m.passkeys_created()} <RelativeTime value={new Date(passkey.createdAt)} />
            </span>
            <MetaDot />
            <span>
                {passkey.lastUsedAt === null ? (
                    m.passkeys_never_used()
                ) : (
                    <>
                        {m.passkeys_last_used()} <RelativeTime value={new Date(passkey.lastUsedAt)} />
                    </>
                )}
            </span>
        </>
    );
}

interface PasskeyListProps {
    readonly query: UseQueryResult<PasskeyPageData>;
    readonly title: string;
    readonly currentPasskeyId: PasskeyId | null;
    readonly showOwner: boolean;
    readonly ownerOf: (passkey: ReadPasskey) => boolean;
    readonly onRevoke: (target: RevokeTarget) => void;
    /** Passkeys listed elsewhere on the page, e.g. the viewer's own in the everyone list. */
    readonly hide?: (passkey: ReadPasskey) => boolean;
    readonly emptyText: string;
}

function PasskeyList({
    query,
    title,
    currentPasskeyId,
    showOwner,
    ownerOf,
    onRevoke,
    hide,
    emptyText,
}: PasskeyListProps) {
    return (
        <QuerySection
            title={title}
            query={query}
            skeleton={<FactsSkeleton rows={3} />}
            count={({ items: listed }) => {
                const shown = hide === undefined ? listed : listed.filter((passkey) => !hide(passkey));
                return shown.length === 0 ? undefined : shown.length;
            }}
        >
            {({ items: listed, nextCursor }) => {
                const lastOnes = lastPasskeyIds(listed, nextCursor === null);
                const items = hide === undefined ? listed : listed.filter((passkey) => !hide(passkey));
                return items.length === 0 ? (
                    <EmptyState variant="inline" icon={<Key />} title={emptyText} />
                ) : (
                    <div className="flex flex-col gap-3">
                        <ul className="flex flex-col divide-y divide-hairline">
                            {items.map((passkey) => {
                                const current = passkey.id === currentPasskeyId;
                                const name = displayName(passkey);
                                const last = lastOnes.has(passkey.id);
                                return (
                                    <CredentialRow
                                        key={passkey.id}
                                        icon={<KindIcon passkey={passkey} />}
                                        name={name}
                                        current={
                                            current ? (
                                                <StatusPill tone="success">{m.passkeys_current()}</StatusPill>
                                            ) : undefined
                                        }
                                        meta={<PasskeyMeta passkey={passkey} showOwner={showOwner} />}
                                        action={
                                            <ActionMenu
                                                label={m.passkeys_actions({ name })}
                                                variant="ghost"
                                                size="sm"
                                                items={[
                                                    {
                                                        kind: 'item',
                                                        id: 'revoke',
                                                        label: m.passkeys_revoke(),
                                                        tone: 'danger',
                                                        disabled: last,
                                                        ...(last ? { description: m.passkeys_last_one_hint() } : {}),
                                                        onSelect: () => {
                                                            onRevoke({ passkey, own: ownerOf(passkey), current });
                                                        },
                                                    },
                                                ]}
                                            />
                                        }
                                    />
                                );
                            })}
                        </ul>
                        {nextCursor === null ? null : (
                            <p className="text-xs text-text-muted">
                                {m.passkeys_more({ count: String(CREDENTIALS_PAGE_SIZE) })}
                            </p>
                        )}
                    </div>
                );
            }}
        </QuerySection>
    );
}

/**
 * The signed-in member's passkeys, and everyone's for members who may revoke them. Registering a passkey is the
 * engine gateway's job; this page lists and revokes, and every revoke asks first and needs a fresh assertion.
 */
export function PasskeysPage() {
    const engineApi = useEngineApi();
    const me = useCurrentMember();
    const { can } = usePermissions();
    const canManageAll = can('members.manage') && can('security.read');
    const [target, setTarget] = useState<RevokeTarget | null>(null);
    const mine = useQuery({ ...myPasskeysQueryOptions(engineApi, FIRST_PAGE), throwOnError: isPageLevelFailure });
    const all = useQuery({ ...allPasskeysQueryOptions(engineApi, FIRST_PAGE), enabled: canManageAll });
    const sessions = useQuery(mySessionsQueryOptions(engineApi));
    const currentPasskeyId = sessions.data?.items.find(({ current }) => current)?.passkeyId ?? null;

    const revoke = useStepUpAwareMutation({
        mutationFn: async ({ passkey, own }: RevokeTarget) => {
            const signal = AbortSignal.timeout(MUTATION_TIMEOUT_MS);
            return unwrap(
                own
                    ? await engineApi.me.revokePasskey(passkey.id, signal)
                    : await engineApi.passkeys.revoke(passkey.id, signal),
            );
        },
        invalidates: [securityKeys.passkeys(), securityKeys.mySessions(), memberKeys.all],
        successMessage: (_, { passkey }) => m.passkeys_revoked({ name: displayName(passkey) }),
        errorMessage: (failure, { passkey }) =>
            failure.kind === 'problem' && failure.problem.code === 'last-passkey'
                ? m.passkeys_last_one({ name: displayName(passkey) })
                : m.passkeys_revoke_failed({ name: displayName(passkey) }),
        resumeAs: { action: REVOKE_ACTION, data: ({ passkey }) => ({ passkeyId: passkey.id }) },
    });
    // Back from the step-up: the same confirmation again, for one more click, once the passkey is listed.
    const resumed = useResumedStepUp(REVOKE_ACTION, parseRevoke);
    const [resumeDismissed, setResumeDismissed] = useState(false);
    const resumedPasskey =
        resumed === undefined || resumeDismissed || sessions.isPending
            ? undefined
            : [...(mine.data?.items ?? []), ...(all.data?.items ?? [])].find(({ id }) => id === resumed.passkeyId);
    const shown: RevokeTarget | null =
        target ??
        (resumedPasskey === undefined
            ? null
            : {
                  passkey: resumedPasskey,
                  own: resumedPasskey.memberId === me.memberId,
                  current: resumedPasskey.id === currentPasskeyId,
              });
    const choose = (next: RevokeTarget) => {
        setResumeDismissed(true);
        setTarget(next);
    };
    const close = () => {
        setResumeDismissed(true);
        setTarget(null);
    };

    return (
        <Page
            title={m.passkeys_title()}
            description={m.passkeys_intro()}
            breadcrumbs={[
                <Crumb key="security" to="/security">
                    {m.security_title()}
                </Crumb>,
            ]}
        >
            <PasskeyList
                query={mine}
                title={m.passkeys_mine()}
                currentPasskeyId={currentPasskeyId}
                showOwner={false}
                ownerOf={() => true}
                emptyText={m.passkeys_empty()}
                onRevoke={choose}
            />
            {canManageAll ? (
                <PasskeyList
                    query={all}
                    title={m.passkeys_everyone()}
                    currentPasskeyId={currentPasskeyId}
                    showOwner
                    ownerOf={(passkey) => passkey.memberId === me.memberId}
                    hide={(passkey) => passkey.memberId === me.memberId}
                    emptyText={m.passkeys_others_empty()}
                    onRevoke={choose}
                />
            ) : null}
            {shown === null ? null : (
                <ConfirmDialog
                    open
                    onClose={close}
                    tone="danger"
                    title={m.passkeys_revoke_title({ name: displayName(shown.passkey) })}
                    description={shown.current ? m.passkeys_revoke_current_body() : m.passkeys_revoke_body()}
                    confirmLabel={shown.current ? m.passkeys_revoke_and_sign_out() : m.passkeys_revoke()}
                    loading={revoke.isPending}
                    onConfirm={() => {
                        revoke.mutate(shown, { onSuccess: close });
                    }}
                />
            )}
        </Page>
    );
}
