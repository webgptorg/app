import type { Nodes, Parents, RootContent, Table } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { ExternalLink } from '@ptbk/ui';
import type { ReactNode } from 'react';

import { m } from '../../../paraglide/messages';
import { safeLinkUrl } from '../../../security/safe-url';
import { CodeBlock } from './code-block';

/** What a node needs from its surroundings while it renders. */
interface Context {
    readonly origin: string;
    /** Inside a tight list, paragraphs render without a block of their own. */
    readonly tight: boolean;
}

const HEADINGS = { 1: 'h2', 2: 'h3', 3: 'h4', 4: 'h5', 5: 'h6', 6: 'h6' } as const;

const ALIGN_CLASSES = { left: 'text-start', center: 'text-center', right: 'text-end' } as const;

function children(node: Parents, context: Context): ReactNode[] {
    return node.children.map((child, index) => renderNode(child, context, index));
}

/** A link only to another origin over http(s) (`safeLinkUrl`); anything else is its text, with no href at all. */
function SafeLink({
    url,
    origin,
    children: content,
}: {
    readonly url: string;
    readonly origin: string;
    readonly children: ReactNode;
}) {
    const href = safeLinkUrl(url, origin);
    if (href === null) return <span>{content}</span>;
    return (
        <span className="group relative">
            <ExternalLink href={href}>{content}</ExternalLink>
            {/* The full destination on hover and focus; out of layout at rest, so it can never widen the page. */}
            <span className="absolute start-0 top-full z-10 mt-1 hidden w-max max-w-[min(32rem,80vw)] rounded-small bg-raised px-2 py-1 font-mono text-xs break-all text-text shadow-md group-focus-within:block group-hover:block">
                {href}
            </span>
        </span>
    );
}

function TableNode({ node, context }: { readonly node: Table; readonly context: Context }) {
    const cells = (row: Table['children'][number], header: boolean) =>
        row.children.map((cell, index) => {
            const align = node.align?.[index];
            const className = `border border-divider px-2 py-1 ${align ? ALIGN_CLASSES[align] : 'text-start'}`;
            return header ? (
                <th key={index} scope="col" className={`${className} font-semibold`}>
                    {children(cell, context)}
                </th>
            ) : (
                <td key={index} className={className}>
                    {children(cell, context)}
                </td>
            );
        });
    return (
        // Scrolls on its own so a wide table never widens the page; focusable so the keyboard can scroll it.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        <div tabIndex={0} className="max-w-full overflow-x-auto">
            <table className="border-collapse text-sm">
                {/* GFM requires a header row, so the first row is always the head. */}
                <thead>
                    {node.children.slice(0, 1).map((row, index) => (
                        <tr key={index}>{cells(row, true)}</tr>
                    ))}
                </thead>
                <tbody>
                    {node.children.slice(1).map((row, index) => (
                        <tr key={index}>{cells(row, false)}</tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

/** A node type this renderer does not know: its text, never an element of its own choosing. */
function renderUnknown(node: unknown, context: Context, key: number): ReactNode {
    const record = node as Readonly<Record<string, unknown>>;
    if (Array.isArray(record['children'])) {
        return <span key={key}>{children(node as Parents, context)}</span>;
    }
    return typeof record['value'] === 'string' ? record['value'] : null;
}

/**
 * Agent output is untrusted, so every node type is listed here and becomes plain React elements: raw HTML stays
 * literal text, images are never loaded, and links lead only to other origins. Keys are positions; the tree is static.
 */
function renderNode(node: RootContent | Nodes, context: Context, key: number): ReactNode {
    switch (node.type) {
        case 'root':
            return children(node, context);
        case 'paragraph':
            return context.tight ? (
                <span key={key}>{children(node, context)}</span>
            ) : (
                <p key={key}>{children(node, context)}</p>
            );
        case 'heading': {
            const Heading = HEADINGS[node.depth];
            return (
                <Heading key={key} className="font-semibold">
                    {children(node, context)}
                </Heading>
            );
        }
        case 'text':
            return node.value;
        case 'emphasis':
            return <em key={key}>{children(node, context)}</em>;
        case 'strong':
            return <strong key={key}>{children(node, context)}</strong>;
        case 'delete':
            return <del key={key}>{children(node, context)}</del>;
        case 'break':
            return <br key={key} />;
        case 'inlineCode':
            return (
                <code key={key} className="rounded-small bg-sunken px-1 font-mono text-[0.9em]">
                    {node.value}
                </code>
            );
        case 'code':
            return <CodeBlock key={key} code={node.value} lang={node.lang ?? null} />;
        case 'blockquote':
            return (
                <blockquote key={key} className="flex flex-col gap-2 border-s-4 border-divider ps-3 text-text-muted">
                    {children(node, { ...context, tight: false })}
                </blockquote>
            );
        case 'list': {
            const items = children(node, { ...context, tight: node.spread !== true });
            return node.ordered === true ? (
                <ol key={key} start={node.start ?? 1} className="flex list-decimal flex-col gap-1 ps-6">
                    {items}
                </ol>
            ) : (
                <ul key={key} className="flex list-disc flex-col gap-1 ps-6">
                    {items}
                </ul>
            );
        }
        case 'listItem':
            if (node.checked === null || node.checked === undefined) {
                return (
                    <li key={key} className="flex flex-col gap-2">
                        {children(node, context)}
                    </li>
                );
            }
            return (
                <li key={key} className="flex list-none items-start gap-2">
                    <input
                        type="checkbox"
                        disabled
                        checked={node.checked}
                        aria-label={node.checked ? m.chat_task_done() : m.chat_task_open()}
                        className="mt-1 -ms-5"
                    />
                    <div className="flex min-w-0 flex-col gap-2">{children(node, context)}</div>
                </li>
            );
        case 'table':
            return <TableNode key={key} node={node} context={context} />;
        case 'tableRow':
        case 'tableCell':
            return <span key={key}>{children(node, context)}</span>;
        case 'thematicBreak':
            return <hr key={key} className="border-divider" />;
        case 'link':
            return (
                <SafeLink key={key} url={node.url} origin={context.origin}>
                    {children(node, context)}
                </SafeLink>
            );
        case 'image': {
            const label = node.alt ? m.chat_image({ alt: node.alt }) : m.chat_image_no_alt();
            return (
                <SafeLink key={key} url={node.url} origin={context.origin}>
                    {label}
                </SafeLink>
            );
        }
        case 'html':
            // Inline or block, raw HTML is shown as the characters the agent sent.
            return (
                <span key={key} className="whitespace-pre-wrap">
                    {node.value}
                </span>
            );
        case 'linkReference':
        case 'footnoteDefinition':
            return <span key={key}>{children(node, context)}</span>;
        case 'imageReference':
            return node.alt ? m.chat_image({ alt: node.alt }) : m.chat_image_no_alt();
        case 'footnoteReference':
            return `[^${node.label ?? node.identifier}]`;
        case 'definition':
            return null;
        case 'yaml':
            return node.value;
        default:
            return renderUnknown(node, context, key);
    }
}

/** Parses GitHub-flavoured markdown into a syntax tree; no HTML is parsed at any point. */
export function parseMarkdown(source: string) {
    return fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}

/** A parsed tree; node types a newer parser might add render as their text. */
export function MarkdownTree({ tree, origin }: { readonly tree: Nodes; readonly origin: string }) {
    return (
        <div className="flex min-w-0 flex-col gap-3 [overflow-wrap:anywhere]">
            {renderNode(tree, { origin, tight: false }, 0)}
        </div>
    );
}

/** A finished agent reply as markdown; `origin` is the engine UI's own, which links may never point back to. */
export function Markdown({ source, origin }: { readonly source: string; readonly origin: string }) {
    return <MarkdownTree tree={parseMarkdown(source)} origin={origin} />;
}
