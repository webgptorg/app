import { LinkCode } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { linkCodeIdSchema } from '../../domain/ids';
import type { InstallCommandConfig } from '../config';
import { issuedLinkCodeView } from './link-code-view';

const CODE = LinkCode.parse('abcdefghijklmnopqrstuvwxya');
const ISSUED = {
    kind: 'issued',
    linkCodeId: linkCodeIdSchema.parse('lllllllllllllllllllllllllq'),
    linkCode: CODE,
    expiresAt: 1_000,
} as const;
const TAB = { id: 'connect', labelKey: 'already-running', docsAnchor: 'networking' } as const;

function config(origin: string, templates: readonly string[]) {
    const installCommands: InstallCommandConfig[] = templates.map((template) => ({ ...TAB, template }));
    return { dashboardOrigin: origin, installCommands, installGuideUrl: 'https://docs.ptbk.test/install' };
}

describe('issuedLinkCodeView', () => {
    it('fills in the link URL, single-quoted as the template has it, and the code', () => {
        const view = issuedLinkCodeView(
            config('https://app.ptbk.link', ["ptbk connect --link '{linkUrl}'", 'connect --link {linkCode} $&']),
            ISSUED,
        );
        expect(view.linkUrl).toBe(`https://app.ptbk.link/link#${CODE}`);
        expect(view.installCommands.map((path) => path.command)).toEqual([
            `ptbk connect --link 'https://app.ptbk.link/link#${CODE}'`,
            `connect --link ${CODE} $&`,
        ]);
    });

    it('has no link URL on a plain-http dashboard, and refuses a {linkUrl} template there', () => {
        expect(issuedLinkCodeView(config('http://localhost:5173', ['{linkCode}']), ISSUED).linkUrl).toBeNull();
        expect(() => issuedLinkCodeView(config('http://localhost:5173', ['{linkUrl}']), ISSUED)).toThrow(
            /needs an https DASHBOARD_ORIGIN/,
        );
    });
});
