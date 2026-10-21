import type { HighlightedLine, Highlighter } from './tokens';

/** Longer code is shown unhighlighted: parsing it would block the main thread for little benefit. */
export const MAX_HIGHLIGHT_LENGTH = 20_000;

type Language =
    | 'javascript'
    | 'jsx'
    | 'typescript'
    | 'tsx'
    | 'json'
    | 'python'
    | 'shell'
    | 'css'
    | 'html'
    | 'sql'
    | 'yaml'
    | 'markdown';

const ALIASES: ReadonlyMap<string, Language> = new Map(
    Object.entries({
        js: 'javascript',
        javascript: 'javascript',
        mjs: 'javascript',
        cjs: 'javascript',
        jsx: 'jsx',
        ts: 'typescript',
        typescript: 'typescript',
        mts: 'typescript',
        cts: 'typescript',
        tsx: 'tsx',
        json: 'json',
        py: 'python',
        python: 'python',
        sh: 'shell',
        bash: 'shell',
        shell: 'shell',
        zsh: 'shell',
        css: 'css',
        html: 'html',
        htm: 'html',
        sql: 'sql',
        yaml: 'yaml',
        yml: 'yaml',
        md: 'markdown',
        markdown: 'markdown',
    } satisfies Record<string, Language>),
);

// One dynamic import per grammar, so each is its own chunk, fetched only when a reply contains that language.
const LOADERS: Readonly<Record<Language, () => Promise<Highlighter>>> = {
    javascript: () => import('./languages/javascript').then((module) => module.javascriptHighlighter),
    jsx: () => import('./languages/javascript').then((module) => module.jsxHighlighter),
    typescript: () => import('./languages/javascript').then((module) => module.typescriptHighlighter),
    tsx: () => import('./languages/javascript').then((module) => module.tsxHighlighter),
    json: () => import('./languages/json').then((module) => module.jsonHighlighter),
    python: () => import('./languages/python').then((module) => module.pythonHighlighter),
    shell: () => import('./languages/shell').then((module) => module.shellHighlighter),
    css: () => import('./languages/css').then((module) => module.cssHighlighter),
    html: () => import('./languages/html').then((module) => module.htmlHighlighter),
    sql: () => import('./languages/sql').then((module) => module.sqlHighlighter),
    yaml: () => import('./languages/yaml').then((module) => module.yamlHighlighter),
    markdown: () => import('./languages/markdown').then((module) => module.markdownHighlighter),
};

/** The highlighter for a code fence's language, or `null` for a language we do not highlight. */
export async function loadHighlighter(lang: string): Promise<Highlighter | null> {
    const language = ALIASES.get(lang.toLowerCase());
    return language === undefined ? null : LOADERS[language]();
}

/** The code's highlighted lines, or `null` when it stays plain: an unknown language, or too long to parse. */
export async function highlightLines(code: string, lang: string): Promise<readonly HighlightedLine[] | null> {
    if (code.length > MAX_HIGHLIGHT_LENGTH) return null;
    const highlighter = await loadHighlighter(lang);
    return highlighter === null ? null : highlighter(code);
}
