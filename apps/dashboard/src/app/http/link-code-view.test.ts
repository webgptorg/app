import { LinkCode } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { linkCodeIdSchema } from '../../domain/ids';
import type { InstallCommandConfig } from '../config';
import { issuedLinkCodeView } from './link-code-view';
import { TEST_ENGINE_INSTALLATION } from '../../testing/install-fixtures';
import { linkCodeViewSchema } from '../../shared/api/routes';

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
    it('adds typed installation choices and retains a usable command for older clients', () => {
        const view = issuedLinkCodeView(
            {
                ...config('https://app.ptbk.io', ['ptbk connect --link {linkUrl}']),
                engineInstallation: TEST_ENGINE_INSTALLATION,
            },
            ISSUED,
        );
        expect(linkCodeViewSchema.parse(view)).toEqual(view);
        expect(view.installCommands[0]?.labelKey).toBe('new-project');
        const primary = view.installationOptions?.find((option) => option.kind === 'command');
        expect(view.installCommands[0]?.command).toBe(primary?.commands.posix);
        expect(view.installCommands[0]?.command).toContain('/assets/install-project-v1.sh');
        expect(view.installCommands[0]?.command).toContain(view.linkUrl);
        expect(view.installCommands[1]?.id).toBe('connect');
        expect(view.installationOptions?.map((option) => option.kind)).toEqual(['command', 'ai', 'download']);
    });
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
