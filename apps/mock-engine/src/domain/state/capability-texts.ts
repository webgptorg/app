/**
 * Believable text for seeded and simulated runs: what agents work on, the tools they call, how they fail and what
 * they change. Plain text only; nothing here is shown as markup.
 */

export const RUNNERS = ['promptbook', 'claude-code', 'codex'] as const;
export const MODELS = ['claude-sonnet-4-5', 'gpt-5', 'gpt-5-mini', 'gemini-2.5-pro', 'claude-haiku-4-5'] as const;

/** USD per million input and output tokens, so costs scale with usage like a real bill. */
export const MODEL_PRICES: Readonly<Record<(typeof MODELS)[number], readonly [input: number, output: number]>> = {
    'claude-sonnet-4-5': [3, 15],
    'gpt-5': [1.25, 10],
    'gpt-5-mini': [0.25, 2],
    'gemini-2.5-pro': [1.25, 10],
    'claude-haiku-4-5': [1, 5],
};

export interface TaskTemplate {
    readonly title: string;
    readonly steps: readonly string[];
}

export const TASKS: readonly TaskTemplate[] = [
    {
        title: 'Triage new support tickets',
        steps: ['Fetch open tickets', 'Classify by product area', 'Draft first replies', 'Tag urgent ones'],
    },
    {
        title: 'Write the weekly release notes',
        steps: ['List merged pull requests', 'Group changes by area', 'Write the summary', 'Open a draft post'],
    },
    {
        title: 'Reconcile unpaid invoices',
        steps: ['Export invoices from billing', 'Match bank transfers', 'Flag mismatches', 'Email the finance team'],
    },
    {
        title: 'Review the open pull request',
        steps: ['Read the diff', 'Run the test suite', 'Check for breaking API changes', 'Post review comments'],
    },
    {
        title: 'Summarise yesterday’s meetings',
        steps: ['Read calendar events', 'Collect the notes', 'Extract decisions and owners', 'Send the summary'],
    },
    {
        title: 'Investigate the checkout latency alert',
        steps: ['Pull the last hour of metrics', 'Compare with the last deploy', 'Find the slow query', 'Write up'],
    },
    {
        title: 'Update the onboarding guide',
        steps: ['Read the current guide', 'Check the new signup flow', 'Rewrite outdated sections', 'Commit'],
    },
    {
        title: 'Prepare the quarterly sales report',
        steps: ['Query closed deals', 'Compute growth by region', 'Render the charts', 'Write the commentary'],
    },
    {
        title: 'Check the new supplier contract',
        steps: ['Extract the key terms', 'Compare with our standard terms', 'List the risky clauses'],
    },
    {
        title: 'Follow up on demo requests',
        steps: ['Load this week’s demo requests', 'Look up each company', 'Draft personal follow-ups'],
    },
];

export interface ToolTemplate {
    readonly name: string;
    /** A command line and its outcome, as the runner logged them. */
    readonly ok: string;
    readonly failed: string;
}

/** Subjects of the emails that started seeded `email` runs. */
export const EMAIL_SUBJECTS = [
    'Refund for order 4471',
    'Re: Invoice INV-2026-0912 is overdue',
    'Cannot sign in since the update',
    'Partnership enquiry: Q4 webinar',
    'Fwd: Contract renewal draft',
    'Shipping address change for order 4502',
] as const;

export const TOOLS: readonly ToolTemplate[] = [
    {
        name: 'github.search_code',
        ok: '$ github.search_code q="rounding mode" repo=acme/billing-service\n→ 7 matches in 4 files (0.84 s)\n',
        failed: '$ github.search_code q="rounding mode" repo=acme/billing-service\n✗ 401 Bad credentials\n',
    },
    {
        name: 'github.create_pull_request',
        ok: '$ github.create_pull_request base=main head=agent/fix-rounding\n→ opened #482 (3 files changed)\n',
        failed: '$ github.create_pull_request base=main head=agent/fix-rounding\n✗ 422 A pull request already exists\n',
    },
    {
        name: 'web.fetch',
        ok: '$ web.fetch https://status.example.com/api/v2/summary.json\n→ 200 OK, 4.1 kB in 212 ms\n',
        failed: '$ web.fetch https://status.example.com/api/v2/summary.json\n✗ timed out after 30 s\n',
    },
    {
        name: 'calendar.list_events',
        ok: '$ calendar.list_events from=yesterday to=today\n→ 6 events, 2 with notes\n',
        failed: '$ calendar.list_events from=yesterday to=today\n✗ 403 insufficient scope calendar.readonly\n',
    },
    {
        name: 'mail.send',
        ok: '$ mail.send to=finance@acme.example subject="Unmatched transfers"\n→ queued as <8f2c@mail>\n',
        failed: '$ mail.send to=finance@acme.example\n✗ 550 mailbox unavailable\n',
    },
    {
        name: 'sql.query',
        ok: '$ sql.query "select region, sum(amount) from deals group by 1"\n→ 5 rows in 1.2 s\n',
        failed: '$ sql.query "select region, sum(amount) from deals group by 1"\n✗ canceling statement due to timeout\n',
    },
    {
        name: 'docs.search',
        ok: '$ docs.search q="refund policy"\n→ 3 pages, best match: /policies/refunds\n',
        failed: '$ docs.search q="refund policy"\n✗ 503 Service Unavailable\n',
    },
    {
        name: 'shell.run',
        ok: '$ bun run test\n✓ 214 passed (12.4 s)\n',
        failed: '$ bun run test\n✗ 2 failed, 212 passed (12.9 s)\n',
    },
    {
        name: 'files.read',
        ok: '$ files.read knowledge/escalation-policy.md\n→ 2.3 kB\n',
        failed: '$ files.read knowledge/escalation-policy.md\n✗ file is still being scanned\n',
    },
    {
        name: 'slack.post_message',
        ok: '$ slack.post_message channel=#support-leads\n→ posted (ts 1729500000.0042)\n',
        failed: '$ slack.post_message channel=#support-leads\n✗ 429 rate limited, retry after 30 s\n',
    },
];

/** How runs fail, with the error code and a summary like a runner would report it. */
export const RUN_ERRORS: readonly { readonly code: string; readonly summary: string }[] = [
    { code: 'tool-timeout', summary: 'The tool web.fetch did not answer within 30 s.' },
    { code: 'rate-limited', summary: 'The model provider rate-limited the request (429); retried 3 times.' },
    { code: 'invalid-credentials', summary: 'GITHUB_TOKEN was rejected by api.github.com (401 Bad credentials).' },
    { code: 'context-length-exceeded', summary: 'The conversation exceeded the model’s context window.' },
    { code: 'integration-unreachable', summary: 'The MCP server mcp.slack.example.com refused the connection.' },
    { code: 'tests-failed', summary: 'Two tests failed after the change, so nothing was committed.' },
];

export const EXTERNAL_SOURCES = [
    'docs.github.com',
    'api.stripe.com',
    'status.example.com',
    'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API',
    'en.wikipedia.org',
    'support.acme.example',
] as const;

export const PROJECTS = ['website', 'billing-service', 'docs', 'infra', 'mobile-app'] as const;

export interface ProjectFileTemplate {
    readonly path: string;
    readonly before: readonly string[];
    readonly after: readonly string[];
}

/** Hunks a coding agent makes in TypeScript, Markdown and JSON, as unified diff material. */
export const PROJECT_FILES: readonly ProjectFileTemplate[] = [
    {
        path: 'src/invoices/round.ts',
        before: ['export function round(amount: number): number {', '    return Math.round(amount * 100) / 100;', '}'],
        after: [
            'export function round(amount: number): number {',
            '    // Banker’s rounding, as the ledger does.',
            '    return roundHalfEven(amount, 2);',
            '}',
        ],
    },
    {
        path: 'README.md',
        before: ['## Getting started', '', 'Run `npm install` and `npm start`.'],
        after: ['## Getting started', '', 'Run `bun install` and `bun run dev`.', 'See docs/setup.md for details.'],
    },
    {
        path: 'package.json',
        before: ['  "scripts": {', '    "test": "vitest"', '  },'],
        after: ['  "scripts": {', '    "test": "vitest run",', '    "test:watch": "vitest"', '  },'],
    },
    {
        path: 'docs/onboarding.md',
        before: ['1. Create an account.', '2. Verify your email.'],
        after: ['1. Create an account with a passkey.', '2. Invite your team.', '3. Create your first agent.'],
    },
    {
        path: 'src/routes/checkout.ts',
        before: ['const rows = await db.query(sql`select * from carts where user_id = ${id}`);'],
        after: ['const rows = await db.query(sql`select id, total from carts where user_id = ${id} limit 1`);'],
    },
];

export const KNOWLEDGE_FILES = [
    { name: 'escalation-policy.md', contentType: 'text/markdown' },
    { name: 'brand-voice.md', contentType: 'text/markdown' },
    { name: 'pricing-faq.md', contentType: 'text/markdown' },
    { name: 'product-catalog.csv', contentType: 'text/csv' },
    { name: 'api-reference.json', contentType: 'application/json' },
    { name: 'glossary.txt', contentType: 'text/plain' },
] as const;

export const ATTACHMENTS = [
    { name: 'screenshot.png', contentType: 'image/png' },
    { name: 'error-log.txt', contentType: 'text/plain' },
    { name: 'customer-list.csv', contentType: 'text/csv' },
    { name: 'requirements.md', contentType: 'text/markdown' },
] as const;

export const OUTPUTS = [
    { name: 'report.md', contentType: 'text/markdown' },
    { name: 'report.md', contentType: 'text/markdown' },
    { name: 'chart.png', contentType: 'image/png' },
    { name: 'summary.json', contentType: 'application/json' },
] as const;
