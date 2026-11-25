import { memo } from 'react';

const COMMANDS = new Set([
    'bash',
    'bun',
    'curl',
    'docker',
    'get-command',
    'iex',
    'irm',
    'node',
    'ptbk',
    'ptbk.cmd',
    'sh',
    'sudo',
]);

// Quoted values and URLs stay whole, even when they contain a word such as "bash".
const SHELL_TOKENS = /(https?:\/\/[^\s'"]+|'[^'\r\n]*'|"[^"\r\n]*"|\$?[\w.:-]+|[|;&]+)/u;

function highlightShell(command: string) {
    return command.split(SHELL_TOKENS).map((part, index) => {
        if (COMMANDS.has(part.toLowerCase())) {
            return (
                <span key={index} className="font-medium text-link">
                    {part}
                </span>
            );
        }
        if (part === 'PTBK_LINK' || /^\$[\w:]+$|^--?[a-z]/iu.test(part)) {
            return (
                <span key={index} className="text-info">
                    {part}
                </span>
            );
        }
        return part;
    });
}

/** An AI prompt is prose apart from the installer one-liners it embeds. */
export const InstallationCode = memo(function InstallationCode(props: {
    readonly value: string;
    readonly prompt: boolean;
}) {
    const content = props.prompt
        ? props.value
              .split(/(?<=\n)/u)
              .map((line) => (/^(?:curl\s|\$env:PTBK_LINK=)/iu.test(line) ? highlightShell(line) : line))
        : highlightShell(props.value);
    return <code>{content}</code>;
});
