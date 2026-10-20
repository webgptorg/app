import { readFile } from 'node:fs/promises';

import { TrustPolicy } from '@ptbk/protocol';

export async function readTrustPolicy(file: string): Promise<TrustPolicy> {
    return TrustPolicy.parse(JSON.parse(await readFile(file, 'utf8')));
}
