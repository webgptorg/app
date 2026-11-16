import { describe, expect, it } from 'vitest';

import { ILLUSTRATION_IDS, isIllustrationId } from './illustrations';
import { resolveIllustration } from './resolve-illustration';
import type { IllustratedAgent } from './resolve-illustration';

const agent = (name: string, description = '', fields: Partial<IllustratedAgent> = {}): IllustratedAgent => ({
    name,
    origin: 'content',
    profile: { description },
    ...fields,
});

describe('resolveIllustration', () => {
    it('draws a built-in by name where the origin is not known, but never a project agent that shares the name', () => {
        expect(resolveIllustration({ name: 'Chatter', profile: {} })).toBe('chatter');
        expect(resolveIllustration(agent('Chatter'))).toBe('agent');
    });

    it("uses the engine's choice when it is one this UI draws", () => {
        expect(resolveIllustration(agent('Max', 'Writes code', { profile: { illustration: 'support' } }))).toBe(
            'support',
        );
        expect(
            resolveIllustration({
                name: 'Chatter',
                origin: 'core',
                profile: { description: '', illustration: 'mail' },
            }),
        ).toBe('mail');
    });

    it('falls through an unknown or empty choice to the next rule', () => {
        expect(
            resolveIllustration({
                name: 'Max',
                profile: { description: 'Answers support email', illustration: 'unicorn' },
            }),
        ).toBe('support');
        expect(resolveIllustration({ name: 'Max', profile: { description: 'Writes code', illustration: null } })).toBe(
            'developer',
        );
    });

    it('draws a built-in agent as itself, unless the engine says it is one of the project’s', () => {
        const builtIns = ['Chatter', 'Adam', 'Tasker', 'Router', 'Fixer', 'Teacher'] as const;
        for (const name of builtIns) {
            expect(resolveIllustration({ name, origin: 'core', profile: { description: 'Plans the release' } })).toBe(
                name.toLowerCase(),
            );
        }
        expect(resolveIllustration({ name: ' expert ', origin: 'system', profile: {} })).toBe('expert');
        expect(resolveIllustration(agent('Adam'))).toBe('agent');
        expect(resolveIllustration(agent('Router', 'Plans trips'))).toBe('planner');
        expect(resolveIllustration({ name: 'Analyst', origin: 'core', profile: {} })).toBe('analyst');
    });

    it.each([
        ['Support', '', 'support'],
        ['Podpora zákazníků', '', 'support'],
        ['Copywriter', '', 'copywriter'],
        ['Textař', '', 'copywriter'],
        ['Blog', '', 'copywriter'],
        ['Marketing', '', 'marketing'],
        ['Kampaně', '', 'marketing'],
        ['Developer', '', 'developer'],
        ['Code reviewer', '', 'developer'],
        ['Vývojář', '', 'developer'],
        ['Programátorka', '', 'developer'],
        ['Lawyer', '', 'lawyer'],
        ['Legal desk', '', 'lawyer'],
        ['Právník', '', 'lawyer'],
        ['Smlouvy', '', 'lawyer'],
        ['Planner', '', 'planner'],
        ['Plánovač', '', 'planner'],
        ['Mail', '', 'mail'],
        ['E-mail', '', 'mail'],
        ['Finance', '', 'finance'],
        ['Účetní', '', 'finance'],
        ['Faktury', '', 'finance'],
        ['Invoices', '', 'finance'],
        ['Designer', '', 'designer'],
        ['Analyst', '', 'analyst'],
        ['Analýza trhu', '', 'analyst'],
        ['Weekly report', '', 'analyst'],
        ['Security', '', 'security'],
        ['Bezpečnost', '', 'security'],
        ['Launch', '', 'launch'],
        ['Release notes', '', 'launch'],
        ['Spuštění', '', 'launch'],
    ])('reads %s as %s', (name, description, expected) => {
        expect(resolveIllustration(agent(name, description))).toBe(expected);
    });

    it('ignores case and diacritics', () => {
        expect(resolveIllustration(agent('PRÁVNÍ PORADCE'))).toBe('lawyer');
        expect(resolveIllustration(agent('pravni poradce'))).toBe('lawyer');
        expect(resolveIllustration(agent('BEZPECNOST'))).toBe('security');
    });

    it('picks what the agent does over its field, and its field over its channel', () => {
        expect(resolveIllustration(agent('Max', 'Answers support email'))).toBe('support');
        expect(resolveIllustration(agent('Nova', 'Email marketing for the shop'))).toBe('marketing');
        expect(resolveIllustration(agent('Iris', 'Writes marketing copy'))).toBe('copywriter');
        expect(resolveIllustration(agent('Iris', 'Writes the weekly report'))).toBe('analyst');
        expect(resolveIllustration(agent('Guard', 'Checks data protection and security'))).toBe('security');
        expect(resolveIllustration(agent('Ledger', 'Sends invoices by e-mail'))).toBe('finance');
        expect(resolveIllustration(agent('Ship', 'Plans and runs the release'))).toBe('planner');
    });

    it('trusts the name over the role', () => {
        expect(resolveIllustration(agent('Copywriter', 'Writes marketing copy from what the project has'))).toBe(
            'copywriter',
        );
        expect(resolveIllustration(agent('Mail', 'Writes code reviews'))).toBe('mail');
    });

    it('matches stems at the start of a word only', () => {
        expect(resolveIllustration(agent('Helper', 'Gives context and explanations'))).toBe('agent');
        expect(resolveIllustration(agent('Flawless'))).toBe('agent');
    });

    it('falls back to the generic agent', () => {
        expect(resolveIllustration(agent('Ada', 'Reviews pull requests carefully'))).toBe('agent');
        expect(resolveIllustration(agent('', ''))).toBe('agent');
        expect(resolveIllustration({ name: 'Zed', profile: {} })).toBe('agent');
    });

    it('only ever returns an illustration this UI draws', () => {
        expect(ILLUSTRATION_IDS).toHaveLength(20);
        expect(isIllustrationId('agent')).toBe(true);
        expect(isIllustrationId('Agent')).toBe(false);
    });
});
