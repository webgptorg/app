// Guards docs/engine-integration/, which moves to the public repo with the contracts (E-02): every conformance check
// must be trackable from checklist.md, every link must survive the move as a relative link, and nothing private or
// secret may slip in. Dependency-free on purpose, like plan.ts.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';

interface Problem {
    readonly file: string;
    readonly line: number;
    readonly message: string;
}

interface ContentRule {
    readonly pattern: RegExp;
    readonly message: string;
}

const REPO_ROOT = resolve(import.meta.dirname, '..');

/** A check ID as C-05 declares it: `id: 'engine-api.secrets.never-returned'`, at least two dots. */
const CHECK_ID_DECLARATION = /\bid:\s*(['"`])([a-z][a-z0-9-]*(?:\.[a-z0-9-]+){2,})\1/g;
const BACKTICKED_CHECK_ID = /`([a-z][a-z0-9-]*(?:\.[a-z0-9-]+){2,})`/g;

/** Repo paths the guide may not link to: they are private and stay behind when the guide moves public. */
const PRIVATE_LINK_TARGETS = ['apps/relay', 'apps/dashboard', 'apps/engine-ui', 'infra', 'docs/plan', '.github'];

const CONTENT_RULES: readonly ContentRule[] = [
    {
        pattern: /\b(?![a-z0-9-]*\bapp\.ptbk\.io\b)[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ptbk\.io\b/gi,
        message: 'private hostname under ptbk.io (only app.ptbk.io is public)',
    },
    {
        pattern:
            /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:workers\.dev|pages\.dev|r2\.dev|r2\.cloudflarestorage\.com|internal|corp|lan|home\.arpa|your-server\.de)\b/gi,
        message: 'private or infrastructure hostname',
    },
    { pattern: /\b(?:staging|relay-fsn|relay-hel)\.[a-z0-9-]+/gi, message: 'deployment-specific hostname' },
    {
        pattern: /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g,
        message: 'private IPv4 address',
    },
    { pattern: /\/internal\/(?!v1\/)/g, message: 'internal path outside /internal/v1' },
    { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, message: 'private key' },
    {
        pattern: /\b(?:ptbk_rt_[A-Za-z0-9_-]{8,}|gh[opsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
        message: 'token',
    },
    { pattern: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}|\bwhsec_[A-Za-z0-9]{10,}/g, message: 'Stripe key' },
    { pattern: /\bAKIA[0-9A-Z]{16}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAIza[0-9A-Za-z_-]{30,}/g, message: 'API key' },
    { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}/g, message: 'JWT' },
    { pattern: /\b[0-9a-f]{40,}\b/gi, message: 'long hex string (key, digest or token?)' },
    {
        pattern: /(?<![A-Za-z0-9+/_=.-])(?=[A-Za-z0-9+/_=-]*\d)(?=[A-Za-z0-9+/_=-]*[A-Za-z])[A-Za-z0-9+/_=-]{40,}/g,
        message: 'long base64 string (key, signature or token?)',
    },
];

function walk(dir: string, accept: (path: string) => boolean): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
        .flatMap((entry) => {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(path, accept);
            return accept(path) ? [path] : [];
        })
        .sort();
}

function lineAt(source: string, index: number): number {
    return source.slice(0, index).split('\n').length;
}

/** Test files, fixtures and test helpers declare fake checks for self-tests; only real checks count. */
function isCheckSource(path: string): boolean {
    const parts = path.split(sep);
    return /\.ts$/.test(path) && !/\.test\.ts$/.test(path) && !parts.includes('fixtures') && !parts.includes('testing');
}

function declaredCheckIds(conformanceDir: string): Map<string, string> {
    const ids = new Map<string, string>();
    for (const dir of ['src', 'node', 'bin']) {
        for (const file of walk(join(conformanceDir, dir), isCheckSource)) {
            for (const match of readFileSync(file, 'utf8').matchAll(CHECK_ID_DECLARATION)) {
                const id = match[2];
                if (id !== undefined && !ids.has(id)) ids.set(id, relative(REPO_ROOT, file));
            }
        }
    }
    return ids;
}

function checkChecklist(checklistPath: string, conformanceDir: string): Problem[] {
    const file = relative(REPO_ROOT, checklistPath);
    if (!existsSync(checklistPath)) return [{ file, line: 1, message: 'checklist.md is missing' }];
    const listed = new Set(
        [...readFileSync(checklistPath, 'utf8').matchAll(BACKTICKED_CHECK_ID)].map((match) => match[1]),
    );
    return [...declaredCheckIds(conformanceDir)]
        .filter(([id]) => !listed.has(id))
        .map(([id, source]) => ({ file, line: 1, message: `conformance check ${id} (${source}) is not listed` }));
}

/** GitHub's heading anchors: lowercase, punctuation dropped, spaces to hyphens, duplicates numbered. */
function headingAnchors(markdown: string): Set<string> {
    const anchors = new Set<string>();
    const seen = new Map<string, number>();
    for (const line of stripCode(markdown).split('\n')) {
        const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)?.[1];
        if (heading === undefined) continue;
        const base = heading
            .replace(/`/g, '')
            .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s_-]/gu, '')
            .replace(/\s/g, '-');
        const count = seen.get(base) ?? 0;
        seen.set(base, count + 1);
        anchors.add(count === 0 ? base : `${base}-${String(count)}`);
    }
    return anchors;
}

/** Blanks fenced blocks and inline code, keeping line numbers, so examples are not read as links. */
function stripCode(markdown: string): string {
    return markdown
        .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, (block) => block.replace(/[^\n]/g, ' '))
        .replace(/`[^`\n]*`/g, (code) => ' '.repeat(code.length));
}

function linkTargets(markdown: string): { target: string; index: number }[] {
    const prose = stripCode(markdown);
    const inline = [...prose.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)];
    const references = [...prose.matchAll(/^\s*\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+"[^"]*")?\s*$/gm)];
    const autolinks = [...prose.matchAll(/<([a-z][a-z0-9+.-]*:[^>\s]+)>/gi)];
    return [...inline, ...references, ...autolinks].map((match) => ({ target: match[1] ?? '', index: match.index }));
}

function checkLinks(guideDir: string): Problem[] {
    const problems: Problem[] = [];
    const anchorCache = new Map<string, Set<string>>();
    const anchorsOf = (path: string): Set<string> => {
        let anchors = anchorCache.get(path);
        if (anchors === undefined) {
            anchors = headingAnchors(readFileSync(path, 'utf8'));
            anchorCache.set(path, anchors);
        }
        return anchors;
    };
    for (const path of walk(guideDir, (file) => file.endsWith('.md'))) {
        const source = readFileSync(path, 'utf8');
        const file = relative(REPO_ROOT, path);
        for (const { target, index } of linkTargets(source)) {
            const report = (message: string): void => {
                problems.push({ file, line: lineAt(source, index), message: `${message}: ${target}` });
            };
            if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) {
                report('absolute URL (relative links only)');
                continue;
            }
            if (target.startsWith('/')) {
                report('root-relative link (relative links only)');
                continue;
            }
            const [rawPath = '', anchor] = target.split('#', 2);
            const resolved = rawPath === '' ? path : resolve(dirname(path), decodeURIComponent(rawPath));
            const inRepo = relative(REPO_ROOT, resolved);
            if (inRepo.startsWith('..')) {
                report('link leaves the repository');
                continue;
            }
            if (PRIVATE_LINK_TARGETS.some((prefix) => inRepo === prefix || inRepo.startsWith(prefix + sep))) {
                report('link to a private module');
                continue;
            }
            if (!existsSync(resolved)) {
                report('missing target');
                continue;
            }
            if (anchor === undefined || anchor === '') continue;
            if (!statSync(resolved).isFile() || !resolved.endsWith('.md')) {
                report('anchor on a non-Markdown target (line anchors drift)');
            } else if (!anchorsOf(resolved).has(anchor)) {
                report('missing anchor');
            }
        }
    }
    return problems;
}

function checkContent(guideDir: string): Problem[] {
    return walk(guideDir, () => true).flatMap((path) => {
        const source = readFileSync(path, 'utf8');
        const file = relative(REPO_ROOT, path);
        return CONTENT_RULES.flatMap((rule) =>
            [...source.matchAll(rule.pattern)].map((match) => ({
                file,
                line: lineAt(source, match.index),
                message: `${rule.message}: ${match[0]}`,
            })),
        );
    });
}

const { values } = parseArgs({
    options: {
        guide: { type: 'string', default: join(REPO_ROOT, 'docs', 'engine-integration') },
        conformance: { type: 'string', default: join(REPO_ROOT, 'packages', 'conformance') },
    },
});
const guideDir = resolve(values.guide);
const problems = [
    ...checkChecklist(join(guideDir, 'checklist.md'), resolve(values.conformance)),
    ...checkLinks(guideDir),
    ...checkContent(guideDir),
];
for (const problem of problems) console.error(`${problem.file}:${String(problem.line)}: ${problem.message}`);
process.exit(problems.length === 0 ? 0 : 1);
