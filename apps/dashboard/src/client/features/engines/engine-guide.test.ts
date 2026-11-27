import { describe, expect, it } from 'vitest';

import { troubleshootingLink } from './engine-guide';

describe('troubleshooting guide links', () => {
    it('uses an existing heading in the public Promptbook guide', () => {
        const guide = 'https://github.com/webgptorg/promptbook/blob/reborn/2026-10/specs/app/connection.md';
        expect(troubleshootingLink(guide)).toBe(`${guide}#the-running-connection`);
    });

    it('keeps the integration guide heading for other configured guides and replaces an old fragment', () => {
        const guide = 'https://docs.ptbk.test/installation';
        expect(troubleshootingLink(guide)).toBe(`${guide}#troubleshooting`);
        expect(troubleshootingLink(`${guide}#old`)).toBe(`${guide}#troubleshooting`);
    });
});
