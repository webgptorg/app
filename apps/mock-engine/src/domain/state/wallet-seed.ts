import type { InMemorySeed } from '@ptbk/engine-api/in-memory';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

type WalletSeed = NonNullable<InMemorySeed['wallet']>;

/**
 * Logins a small company's engine would hold, one per verification outcome, and two agent requests: a missing login
 * and a refused one that moved to its second step. Usernames are on reserved example domains; no password exists.
 */
export function seedWallet(epochMs: number): WalletSeed {
    const at = (agoMs: number): string => new Date(epochMs - agoMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
    return {
        records: [
            {
                id: 'login-github',
                label: 'github.com · re…@acme.example',
                origin: 'https://github.com',
                username: 'release-bot@acme.example',
                fields: [],
                updatedAt: at(40 * DAY),
                lastUse: { at: at(2 * HOUR), outcome: 'signed-in' },
                verification: { state: 'verified', at: at(40 * DAY), reason: 'Signed in as release-bot.' },
            },
            {
                id: 'login-google',
                label: 'Google Workspace (Dana)',
                origin: 'https://accounts.google.com',
                username: 'dana.novak@acme.example',
                fields: [{ label: 'Recovery phone', uncertain: false }],
                updatedAt: at(12 * DAY),
                lastUse: { at: at(5 * HOUR), outcome: 'signed-in' },
                verification: { state: 'verified', at: at(12 * DAY), reason: 'Signed in as Dana Novak.' },
            },
            {
                id: 'login-fakturoid',
                label: 'app.fakturoid.cz · bi…@acme.example',
                origin: 'https://app.fakturoid.cz',
                username: 'billing@acme.example',
                fields: [{ label: 'Customer number', uncertain: true }],
                updatedAt: at(3 * DAY),
                lastUse: null,
                verification: {
                    state: 'incomplete',
                    at: at(3 * DAY),
                    reason: 'The website asked for a one-time code; the test stopped there.',
                },
            },
            {
                id: 'login-linkedin',
                label: 'linkedin.com · da…@acme.example',
                origin: 'https://www.linkedin.com',
                username: 'dana.novak@acme.example',
                fields: [],
                updatedAt: at(60 * DAY),
                lastUse: { at: at(6 * HOUR), outcome: 'rejected' },
                verification: { state: 'rejected', at: at(6 * HOUR), reason: 'The website refused the password.' },
            },
            {
                id: 'login-atlassian',
                label: 'acme.atlassian.net · ji…@acme.example',
                origin: 'https://acme.atlassian.net',
                username: 'jira-bot@acme.example',
                fields: [],
                updatedAt: at(1 * DAY),
                lastUse: null,
                verification: null,
            },
        ],
        pending: [
            {
                id: 'walletreq-hubspot',
                origin: 'https://app.hubspot.com',
                account: 'sales@acme.example',
                problem: 'missing',
                fields: [],
                recordId: null,
                reason: 'There is no saved login for HubSpot, so this week’s calls cannot be logged.',
                tasks: ['Log this week’s sales calls'],
                agents: ['Sales Follow-up'],
                requests: 1,
                createdAt: at(25 * MINUTE),
                seenAt: null,
                step: 0,
            },
            {
                id: 'walletreq-linkedin',
                origin: 'https://www.linkedin.com',
                account: 'dana.novak@acme.example',
                problem: 'rejected',
                fields: [],
                recordId: 'login-linkedin',
                reason: 'LinkedIn refused the saved password.',
                tasks: ['Publish the release announcement'],
                agents: ['Release Notes Writer', 'Chatter'],
                requests: 3,
                createdAt: at(6 * HOUR),
                seenAt: null,
                step: 1,
            },
        ],
    };
}
