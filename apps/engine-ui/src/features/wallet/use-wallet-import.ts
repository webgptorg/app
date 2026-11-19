import { useEngineApi } from '../../app/engine-api-context';
import { useStepUpAwareMutation } from '../../app/mutations';
import { m } from '../../paraglide/messages';
import type { ImportProgress, WalletImportBatch } from './wallet-import-batch';
import { walletKeys } from './wallet-queries';

export function useWalletImport(onProgress: (value: ImportProgress) => void) {
    const api = useEngineApi();
    return useStepUpAwareMutation({
        mutationFn: (batch: WalletImportBatch) => batch.run(api.wallet, onProgress),
        invalidates: [walletKeys.all],
        errorMessage: () => m.wallet_import_save_failed(),
    });
}
