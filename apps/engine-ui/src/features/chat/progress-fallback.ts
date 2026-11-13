/*
 * Interim: reads an engine from before C-14, which flattens an agent's steps into message text ("- thinking: …",
 * "- Read /path", "- mcp__ptbk__create_task …"), as progress. Delete this module once the engine sends `phase` and
 * `steps` (E-03 checks it).
 */
import type { ReadMessage, ReadReplyStep } from '@ptbk/engine-api';

// Claude Code's built-in tools: a bare capitalised word is otherwise just the start of an ordinary bullet.
const BUILT_IN_TOOLS: ReadonlySet<string> = new Set([
    'Agent',
    'Bash',
    'BashOutput',
    'Edit',
    'ExitPlanMode',
    'Glob',
    'Grep',
    'KillShell',
    'LS',
    'MultiEdit',
    'NotebookEdit',
    'NotebookRead',
    'Read',
    'Skill',
    'SlashCommand',
    'Task',
    'TodoWrite',
    'WebFetch',
    'WebSearch',
    'Write',
]);
const MCP_TOOL = /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/;
const THINKING = /^- thinking:(?: (.*))?$/;
const TOOL_LINE = /^- (\S+)(?: (.*))?$/;
// What a file tool is called on: a path, a glob or a pattern, rather than the rest of an English sentence.
const PATH_LIKE = /^[/~.{*]|\//;
const MAX_STEP_TEXT = 500;

interface ParsedLine {
    readonly step: ReadReplyStep;
    /** Only an adapter writes this line; a person writing a list would not. */
    readonly distinctive: boolean;
}

function parseLine(line: string): ParsedLine | null {
    const thinking = THINKING.exec(line);
    if (thinking !== null) {
        return {
            step: { kind: 'reasoning', tool: null, text: (thinking[1] ?? '').slice(0, MAX_STEP_TEXT), level: 'info' },
            distinctive: true,
        };
    }
    const tool = TOOL_LINE.exec(line);
    const name = tool?.[1];
    if (tool === null || name === undefined) return null;
    const text = (tool[2] ?? '').trim();
    const mcp = MCP_TOOL.test(name);
    if (!mcp && !BUILT_IN_TOOLS.has(name)) return null;
    return {
        step: { kind: 'tool', tool: name, text: text.slice(0, MAX_STEP_TEXT), level: 'info' },
        distinctive: mcp || PATH_LIKE.test(text),
    };
}

/**
 * The steps a flattened progress message spells, or `null` when its text is anything else. Every non-empty line must
 * be a step and at least one must be one no person would write ("- thinking:", an MCP tool, a file tool on a path),
 * so "- Read the brief" alone stays an ordinary list.
 */
export function parseFlattenedSteps(content: string): ReadReplyStep[] | null {
    const lines = content.split('\n').map((line) => line.trimEnd());
    const parsed: ParsedLine[] = [];
    for (const line of lines) {
        if (line.trim() === '') continue;
        const step = parseLine(line);
        if (step === null) return null;
        parsed.push(step);
    }
    if (!parsed.some((line) => line.distinctive)) return null;
    return parsed.map((line) => line.step);
}

/**
 * A message an old engine flattened from its agent's steps: no phase, finished, all steps, and the same agent wrote
 * the next message, so the turn went on. The reply that ends a turn is never eaten, even if it is a list.
 */
export function flattenedProgress(message: ReadMessage, next: ReadMessage | undefined): ReadReplyStep[] | null {
    if (message.phase !== null || message.author.kind !== 'agent' || message.status !== 'completed') return null;
    if (next?.author.kind !== message.author.kind || next.author.key !== message.author.key) return null;
    return parseFlattenedSteps(message.content);
}
