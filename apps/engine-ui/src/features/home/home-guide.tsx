import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import type { ReadChat } from '@ptbk/engine-api';
import { Button, IconButton, RobotGuide } from '@ptbk/ui';
import type { PreferenceStorage, RobotPose } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useState } from 'react';

import { useBrowser } from '../../app/browser-context';
import { useEngineApi } from '../../app/engine-api-context';
import { ButtonLink } from '../../app/link';
import { useAllows } from '../../app/registry/use-visible-features';
import { m } from '../../paraglide/messages';
import { AGENT_WIZARD_REQUIREMENT } from '../agent-wizard/agent-wizard-feature';
import { agentListQueryOptions } from '../agents/agents-queries';
import { inviteListQueryOptions, memberListQueryOptions } from '../members/members-queries';
import { walletQueryOptions } from '../wallet/wallet-queries';
import { nextHomeGuide, walletNeedsSetup } from './home-guide-steps';
import type { HomeGuideStep, StepState } from './home-guide-steps';

export const HOME_GUIDE_DISMISSED_KEY = 'ptbk.home-guide.dismissed';

/** The Ask Chatter composer's wrapper, so "Ask Chatter…" can put the cursor in it. */
export const ASK_CHATTER_ID = 'home-ask-chatter';

/** A failed read is never a reason to ask the member for something: the step just does not show. */
function pendingFrom<T>(
    query: { readonly data: T | undefined; readonly isError: boolean },
    test: (data: T) => boolean,
): boolean | undefined {
    if (query.isError) return false;
    return query.data === undefined ? undefined : test(query.data);
}

function readDismissed(storage: PreferenceStorage | undefined): boolean {
    try {
        return storage?.getItem(HOME_GUIDE_DISMISSED_KEY) === '1';
    } catch {
        return false;
    }
}

/** Reads only what Home and its features already ask the engine for; each query shares its cache with its page. */
function useStepStates(chats: readonly ReadChat[] | undefined, canAsk: boolean): Record<HomeGuideStep, StepState> {
    const engineApi = useEngineApi();
    const mayCreateAgent = useAllows(AGENT_WIZARD_REQUIREMENT);
    const canCreateAgent = useAllows({ permission: 'agents.read' }) && mayCreateAgent;
    const canSetUpWallet = useAllows({ capability: KNOWN_CAPABILITIES.wallet, permission: 'wallet.manage' });
    const canInvite = useAllows({ capability: KNOWN_CAPABILITIES.members, permission: 'members.manage' });
    const agents = useQuery({
        ...agentListQueryOptions(engineApi, { origin: 'content', limit: 1 }),
        enabled: canCreateAgent,
    });
    const wallet = useQuery({ ...walletQueryOptions(engineApi), enabled: canSetUpWallet });
    const members = useQuery({ ...memberListQueryOptions(engineApi, {}), enabled: canInvite });
    const invites = useQuery({ ...inviteListQueryOptions(engineApi), enabled: canInvite });
    const invitePending = pendingFrom(members, (data) => data.items.length <= 1);
    const noInvites = pendingFrom(invites, (data) => data.items.length === 0);
    return {
        'create-agent': canCreateAgent ? { pending: pendingFrom(agents, (data) => data.items.length === 0) } : null,
        'set-up-wallet': canSetUpWallet ? { pending: pendingFrom(wallet, walletNeedsSetup) } : null,
        'invite-colleague': canInvite
            ? {
                  pending:
                      invitePending === undefined || noInvites === undefined ? undefined : invitePending && noInvites,
              }
            : null,
        'ask-chatter': canAsk ? { pending: chats === undefined ? undefined : chats.length === 0 } : null,
    };
}

const POSES: Record<HomeGuideStep, RobotPose> = {
    'create-agent': 'assembling',
    'set-up-wallet': 'thinking',
    'invite-colleague': 'working',
    'ask-chatter': 'working',
};

function focusAskChatter() {
    document.getElementById(ASK_CHATTER_ID)?.querySelector('textarea')?.focus();
}

function StepAction({ step }: { readonly step: HomeGuideStep }) {
    switch (step) {
        case 'create-agent':
            return (
                <ButtonLink to="/agents/new" variant="primary" size="sm">
                    {m.home_guide_create_agent_action()}
                </ButtonLink>
            );
        case 'set-up-wallet':
            return (
                <ButtonLink to="/wallet" variant="primary" size="sm">
                    {m.home_guide_wallet_action()}
                </ButtonLink>
            );
        case 'invite-colleague':
            return (
                <ButtonLink to="/members" variant="primary" size="sm">
                    {m.home_guide_invite_action()}
                </ButtonLink>
            );
        case 'ask-chatter':
            return (
                <Button variant="primary" size="sm" onClick={focusAskChatter}>
                    {m.home_guide_ask_action()}
                </Button>
            );
    }
}

function stepLine(step: HomeGuideStep): string {
    switch (step) {
        case 'create-agent':
            return m.home_guide_create_agent();
        case 'set-up-wallet':
            return m.home_guide_wallet();
        case 'invite-colleague':
            return m.home_guide_invite();
        case 'ask-chatter':
            return m.home_guide_ask();
    }
}

export interface HomeGuideProps {
    /** `undefined` while loading; `[]` without `chats.read`. */
    readonly chats: readonly ReadChat[] | undefined;
    readonly canAsk: boolean;
}

/**
 * Promptbook's robot under the greeting: the one next step while something is still to set up, in one line with one
 * action; once everything is, a small tip the member can put away for good on this device.
 */
export function HomeGuide({ chats, canAsk }: HomeGuideProps) {
    const { storage } = useBrowser();
    const [dismissed, setDismissed] = useState(() => readDismissed(storage));
    const guide = nextHomeGuide(useStepStates(chats, canAsk), dismissed);
    if (guide.kind === 'loading' || guide.kind === 'hidden') return null;
    if (guide.kind === 'step') {
        return (
            <div data-home-guide={guide.step}>
                <RobotGuide pose={POSES[guide.step]} size="sm" action={<StepAction step={guide.step} />}>
                    {stepLine(guide.step)}
                </RobotGuide>
            </div>
        );
    }
    return (
        <div className="flex items-center gap-1" data-home-guide="done">
            <RobotGuide pose="finished" size="sm">
                {m.home_guide_done()}
            </RobotGuide>
            <IconButton
                label={m.home_guide_dismiss()}
                icon={<X aria-hidden className="size-4" />}
                variant="ghost"
                size="sm"
                onClick={() => {
                    setDismissed(true);
                    try {
                        storage?.setItem(HOME_GUIDE_DISMISSED_KEY, '1');
                    } catch {
                        // Hidden for this page; it comes back after a reload, which is harmless.
                    }
                }}
            />
        </div>
    );
}
