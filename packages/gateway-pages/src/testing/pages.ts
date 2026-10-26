import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { GatewayPage } from '../assets';
import type { GatewayPageValues } from '../render-page';

export const SAMPLE_CELLS = '1010101110110110010010001';

export const SAMPLE_VALUES: GatewayPageValues = {
    lang: 'en',
    engineId: 'k5dq4tq2m9xd4traovhepz3nab',
    hostname: 'k5dq4tq2m9xd4traovhepz3nab.ptbk.example',
    fingerprint: '7KQ2-M9XD-4TRA-0VHE-PZ3N',
    fingerprintCells: SAMPLE_CELLS,
    command: 'mock-engine',
    owner: 'none',
};

// By directory, not GATEWAY_PAGES_DIR: under jsdom, Vitest serves modules over http, so import.meta.url is not a file.
export const readPackageFile = (relative: string): string =>
    readFileSync(resolve(import.meta.dirname, '../../pages', relative), 'utf8');

export const readPage = (page: GatewayPage): string => readPackageFile(page);
