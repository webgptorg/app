import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import { KeyRound } from 'lucide-react';

import { defineFeature } from '../../app/registry/feature';
import type { Attention } from '../../app/registry/feature';
import { m } from '../../paraglide/messages';
import { useWallet } from './wallet-queries';

/** Requests nobody marked as seen; a seen one still waits on the page but no longer asks for attention. */
function useWalletAttention(): Attention {
    const wallet = useWallet().data;
    return {
        count: wallet?.pending.filter(({ seenAt }) => seenAt === null).length ?? 0,
        to: '/wallet',
        pending: wallet === undefined,
    };
}

/** The engine's Wallet (`wallet@1`): saved logins without secrets and the logins agents are waiting for. */
export const walletFeature = defineFeature({
    id: 'wallet',
    requires: { capability: KNOWN_CAPABILITIES.wallet, permission: 'wallet.read' },
    nav: { group: 'admin', order: 30, label: m.nav_wallet, icon: KeyRound, to: '/wallet' },
    commands: [
        {
            id: 'wallet.add',
            label: m.wallet_add_login,
            keywords: () => [m.nav_wallet(), m.wallet_add_keywords()],
            to: '/wallet',
            search: { dialog: 'new' },
            requires: { capability: KNOWN_CAPABILITIES.wallet, permission: 'wallet.manage' },
        },
    ],
    attention: {
        id: 'wallet.attention',
        useAttention: useWalletAttention,
        label: (count) => m.wallet_attention({ count }),
    },
});
