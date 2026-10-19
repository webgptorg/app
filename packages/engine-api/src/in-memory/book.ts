import type { AgentProfile } from '../agents';
import type { Diagnostic } from '../common';

export interface BookCheck {
    readonly diagnostics: readonly Diagnostic[];
    readonly name: string;
    readonly profile: AgentProfile;
}

const KNOWN_COMMITMENTS = new Set([
    'PERSONA',
    'KNOWLEDGE',
    'RULE',
    'STYLE',
    'GOAL',
    'META',
    'INITIAL',
    'MODEL',
    'ACTION',
    'NOTE',
    'SAMPLE',
    'FORMAT',
    'MEMORY',
    'LANGUAGE',
]);

/**
 * A stand-in for the engine's book parser, just rich enough to exercise the UI: the first line names the agent,
 * `PERSONA`, `META FULLNAME`, `META COLOR` and `INITIAL MESSAGE` fill the profile, an empty book or a malformed colour
 * is an error, and an unknown upper-case commitment is a warning.
 */
export function checkBook(source: string): BookCheck {
    const diagnostics: Diagnostic[] = [];
    const lines = source.split(/\r\n|\r|\n/);
    const nameIndex = lines.findIndex((line) => line.trim() !== '');
    const name = nameIndex === -1 ? '' : (lines[nameIndex]?.trim().slice(0, 256) ?? '');
    if (nameIndex === -1) {
        diagnostics.push(diagnostic('error', 'empty-book', 'The book is empty; its first line names the agent.', 1, 1));
    }
    const profile = { fullname: name, description: '', avatarUrl: null, color: null, initialMessage: null } as {
        -readonly [Key in keyof AgentProfile]: AgentProfile[Key];
    };
    lines.forEach((line, index) => {
        if (index <= nameIndex) return;
        const lineNumber = index + 1;
        const commitment = /^([A-Z]{2,})\b\s*(.*)$/.exec(line.trim());
        if (!commitment) return;
        const [, keyword = '', rest = ''] = commitment;
        if (!KNOWN_COMMITMENTS.has(keyword)) {
            diagnostics.push(
                diagnostic('warning', 'unknown-commitment', `Unknown commitment ${keyword}.`, lineNumber, line.length),
            );
            return;
        }
        if (keyword === 'PERSONA') profile.description = rest.slice(0, 4096);
        if (keyword === 'INITIAL' && rest.startsWith('MESSAGE')) {
            profile.initialMessage = rest.slice('MESSAGE'.length).trim().slice(0, 4096);
        }
        if (keyword === 'META' && rest.startsWith('FULLNAME')) {
            profile.fullname = rest.slice('FULLNAME'.length).trim().slice(0, 256);
        }
        if (keyword === 'META' && rest.startsWith('COLOR')) {
            const color = rest.slice('COLOR'.length).trim();
            if (/^#[0-9a-fA-F]{6}$/.test(color)) profile.color = color;
            else {
                diagnostics.push(
                    diagnostic('error', 'invalid-color', 'META COLOR needs a #rrggbb colour.', lineNumber, line.length),
                );
            }
        }
    });
    return { diagnostics, name, profile };
}

function diagnostic(
    severity: Diagnostic['severity'],
    code: string,
    message: string,
    line: number,
    endColumn: number,
): Diagnostic {
    return {
        severity,
        code,
        message,
        range: { startLine: line, startColumn: 1, endLine: line, endColumn: Math.max(endColumn, 1) },
    };
}
