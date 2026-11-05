import { createFileRoute } from '@tanstack/react-router';

import { requireFeature } from '../app/registry/require-feature';
import { WalletPage } from '../features/wallet/wallet-page';
import { walletQueryOptions } from '../features/wallet/wallet-queries';
import { WalletSearch } from '../features/wallet/wallet-search';

export const Route = createFileRoute('/wallet')({
    beforeLoad: requireFeature('wallet'),
    validateSearch: WalletSearch,
    loader: ({ context }) => {
        context.queryClient.query(walletQueryOptions(context.engineApi)).catch(() => undefined);
    },
    component: WalletPage,
});
