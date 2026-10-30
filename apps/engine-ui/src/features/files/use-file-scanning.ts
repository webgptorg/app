import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';

import { useAllows } from '../../app/registry/use-visible-features';

/** Whether the engine scans files for malware (`file-scanning@1`); without a scanner nothing about scanning shows. */
export function useFileScanning(): boolean {
    return useAllows({ capability: KNOWN_CAPABILITIES.fileScanning });
}
