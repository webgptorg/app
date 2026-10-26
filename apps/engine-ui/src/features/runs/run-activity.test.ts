import { afterEach, describe, expect, it } from 'vitest';

import { getLocale, overwriteGetLocale } from '../../paraglide/runtime';

const baseGetLocale = getLocale;
import { runOrigin } from './run-activity';

const SOURCES = ['web', 'api', 'email', 'schedule', 'member', 'goal', 'webhook', 'unknown'] as const;

afterEach(() => {
    overwriteGetLocale(baseGetLocale);
});

describe('runOrigin', () => {
    it('names a run by what started it, as the subject of a sentence', () => {
        expect(SOURCES.map((source) => runOrigin(source))).toEqual([
            'A run from a chat',
            'A run from the API',
            'A run from an email',
            'A scheduled run',
            "A team member's run",
            'A run toward a goal',
            'A run from a webhook',
            'A run',
        ]);
    });

    it('names it in Czech too', () => {
        overwriteGetLocale(() => 'cs');
        expect(SOURCES.map((source) => runOrigin(source))).toEqual([
            'Běh z chatu',
            'Běh z API',
            'Běh z e-mailu',
            'Plánovaný běh',
            'Běh spuštěný členem týmu',
            'Běh k cíli',
            'Běh z webhooku',
            'Běh',
        ]);
    });
});
