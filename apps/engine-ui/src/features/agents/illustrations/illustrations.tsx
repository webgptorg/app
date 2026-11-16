import type { ReactElement } from 'react';

export { ILLUSTRATION_IDS, isIllustrationId } from './illustration-ids';
export type { IllustrationId } from './illustration-ids';
import type { IllustrationId } from './illustration-ids';

function Body() {
    return <path className="art-body" d="M32 20c10.5 0 17 7.6 17 16.5S42.5 52 32 52s-17-6.6-17-15.5S21.5 20 32 20z" />;
}

function Eyes({ dx = 0, dy = 0 }: { readonly dx?: number; readonly dy?: number }) {
    return (
        <>
            <circle className="art-ink art-eye" cx={26.5 + dx} cy={36 + dy} r="2.3" />
            <circle className="art-ink art-eye" cx={37.5 + dx} cy={36 + dy} r="2.3" />
        </>
    );
}

function Smile() {
    return <path className="art-line" d="M28 42.5q4 3.2 8 0" />;
}

function Cheeks() {
    return (
        <>
            <circle className="art-cheek" cx="22.5" cy="41" r="2" />
            <circle className="art-cheek" cx="41.5" cy="41" r="2" />
        </>
    );
}

/** One round character per role, a prop for the role; children are in paint order, so later shapes sit on top. */
const ART: Readonly<Record<IllustrationId, ReactElement>> = {
    chatter: (
        <>
            <path className="art-line" d="M17 39 9 31" />
            <circle className="art-body" cx="8" cy="29.5" r="3.2" />
            <Body />
            <Eyes />
            <Cheeks />
            <path className="art-paper" d="M27.5 42h9q-.8 5.2-4.5 5.2T27.5 42z" />
            <path
                className="art-paper"
                d="M39 5h17a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4h-8l-5 4.5V21h-4a4 4 0 0 1-4-4V9a4 4 0 0 1 4-4z"
            />
            <circle className="art-ink" cx="43" cy="13" r="1.6" />
            <circle className="art-ink" cx="47.5" cy="13" r="1.6" />
            <circle className="art-ink" cx="52" cy="13" r="1.6" />
        </>
    ),
    adam: (
        <>
            <Body />
            <Eyes />
            <Smile />
            <path
                className="art-paper"
                d="M32 11.5c-2.6-2-7.4-.8-7.4 3.6 0 3.9 3.3 6.9 7.4 6.9s7.4-3 7.4-6.9c0-4.4-4.8-5.6-7.4-3.6z"
            />
            <path className="art-line" d="M32 11.5 33.2 6.5" />
            <path className="art-body" d="M34 7.5c1.8-3 5.6-3.4 7-2.4-.9 3-4.8 4.4-7 2.4z" />
        </>
    ),
    tasker: (
        <>
            <Body />
            <Eyes dx={-1.5} />
            <Smile />
            <rect className="art-paper" x="40" y="31" width="17" height="21" rx="2.5" />
            <rect className="art-ink" x="44.5" y="29" width="8" height="4.2" rx="1.6" />
            <path
                className="art-line art-thin"
                d="m43.5 38.5 1.7 1.7 3.2-3.4M43.5 45.5l1.7 1.7 3.2-3.4M50.5 39h3.5M50.5 46h3.5"
            />
        </>
    ),
    router: (
        <>
            <Body />
            <Eyes />
            <Smile />
            <path className="art-line" d="M32 20V3.5" />
            <path className="art-paper" d="M33.5 4.5h12.5l3.8 3.6L46 11.7H33.5z" />
            <path className="art-paper" d="M30.5 11.5H18l-3.8 3.6 3.8 3.6h12.5z" />
        </>
    ),
    fixer: (
        <>
            <Body />
            <Eyes dy={1} />
            <path className="art-line" d="M28 44q4 2.4 8 0" />
            <path className="art-shade" d="M18.5 27.5c0-8.2 6-14 13.5-14s13.5 5.8 13.5 14z" />
            <path className="art-line" d="M15 27.5h34M32 13.5v6.5" />
            <path className="art-line art-thick" d="m46.5 52.5 8.5-8.5" />
            <path
                className="art-paper"
                d="M61.6 38.3a5.4 5.4 0 0 1-7.2 6l-3.3-3.3a5.4 5.4 0 0 1 6-7.2l-3.2 3.2.6 2.7 2.7.6z"
            />
        </>
    ),
    teacher: (
        <>
            <Body />
            <Eyes />
            <Smile />
            <circle className="art-line" cx="26.5" cy="36" r="4.6" />
            <circle className="art-line" cx="37.5" cy="36" r="4.6" />
            <path className="art-line" d="M31.1 36h1.8" />
            <path className="art-body" d="M22.5 18.5v4c0 2 4.3 3.5 9.5 3.5s9.5-1.5 9.5-3.5v-4" />
            <path className="art-shade" d="M32 8.5 52 15.5 32 22.5 12 15.5z" />
            <path className="art-line" d="M48 17v8" />
            <circle className="art-ink" cx="48" cy="26.5" r="2" />
        </>
    ),
    expert: (
        <>
            <Body />
            <Eyes />
            <path className="art-line" d="M28.5 43q3.5 2 7 0" />
            <circle className="art-line" cx="37.5" cy="36" r="4.7" />
            <path className="art-line" d="m41.8 38.5 2 8.5" />
            <path className="art-shade" d="M19.5 25 31 1.5 44.5 25z" />
            <path className="art-line" d="M14.5 25c6.5 2.2 28.5 2.2 35 0" />
            <path className="art-ink" d="m31.5 10.5 1.3 2.7 3 .4-2.2 2.1.5 3-2.6-1.4-2.6 1.4.5-3-2.2-2.1 3-.4z" />
        </>
    ),
    copywriter: (
        <>
            <Body />
            <circle className="art-ink art-eye" cx="26.5" cy="36" r="2.3" />
            <path className="art-line art-eye" d="M35.3 36.6q2.2-2.4 4.4 0" />
            <Smile />
            <path
                className="art-shade"
                d="M16.5 25.5c1.5-6.8 8.8-10.7 16.3-10.7 8.4 0 14.7 3.7 14.7 8.4 0 2-2.6 2.6-6 2.6H19.2c-2 0-3-.1-2.7-.3z"
            />
            <path className="art-line" d="M33 14.8v-4" />
            <path className="art-paper" d="M59 17c-8.7 2.4-14.5 10.7-15.6 21.1l2.2 1.1C49.8 31 54.6 25.6 59 17z" />
            <path className="art-line" d="m44.4 40.5-2 5" />
        </>
    ),
    developer: (
        <>
            <Body />
            <Eyes />
            <path className="art-line" d="M28.5 42q3.5 2.6 7 0" />
            <path className="art-line" d="M15.5 37c0-12.5 7.4-19.5 16.5-19.5s16.5 7 16.5 19.5" />
            <rect className="art-shade" x="11" y="33" width="7.5" height="12" rx="3.2" />
            <rect className="art-shade" x="45.5" y="33" width="7.5" height="12" rx="3.2" />
            <path className="art-paper" d="M39 6h18a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3H39a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3z" />
            <path className="art-line art-thin" d="m44.5 10.5-2.6 3 2.6 3M51.5 10.5l2.6 3-2.6 3M49.4 9.5l-2.8 8" />
        </>
    ),
    lawyer: (
        <>
            <Body />
            <Eyes dy={0.5} />
            <path className="art-line" d="M23.5 31.5 29 32.6M40.5 31.5 35 32.6M29 43.5h6" />
            <path className="art-shade" d="m32 48.5-6.5-3.6v7.2zM32 48.5l6.5-3.6v7.2z" />
            <path className="art-line" d="M51 12v20M43 15.5h16" />
            <path className="art-line art-thin" d="m43 15.5-3.4 7.6h6.8zM59 15.5l-3.4 7.6h6.8z" />
        </>
    ),
    planner: (
        <>
            <Body />
            <Eyes dx={-1.5} />
            <Smile />
            <rect className="art-paper" x="4.5" y="29" width="19" height="19" rx="2.8" />
            <path className="art-shade" d="M4.5 31.8a2.8 2.8 0 0 1 2.8-2.8h13.4a2.8 2.8 0 0 1 2.8 2.8V35h-19z" />
            <path className="art-line" d="M9.5 26.5v5M18.5 26.5v5" />
            <circle className="art-line art-thin" cx="17" cy="42" r="2.8" />
            <circle className="art-ink" cx="9.5" cy="40" r="1" />
            <circle className="art-ink" cx="13" cy="40" r="1" />
            <circle className="art-ink" cx="9.5" cy="44" r="1" />
            <circle className="art-ink" cx="13" cy="44" r="1" />
        </>
    ),
    agent: (
        <>
            <Body />
            <Eyes />
            <Cheeks />
            <Smile />
            <path className="art-line" d="M32 20v-6.5" />
            <path className="art-ink" d="m32 2.5 1.8 4.4 4.4 1.8-4.4 1.8L32 15l-1.8-4.5-4.4-1.8 4.4-1.8z" />
        </>
    ),
    support: (
        <>
            <Body />
            <Eyes />
            <Cheeks />
            <Smile />
            <path className="art-line" d="M15.5 36c0-12 7.4-18.5 16.5-18.5S48.5 24 48.5 36" />
            <rect className="art-shade" x="11" y="31.5" width="7.5" height="11" rx="3.2" />
            <rect className="art-shade" x="45.5" y="31.5" width="7.5" height="11" rx="3.2" />
            <path className="art-line" d="M14.8 42.5c0 5 3 7 8.5 7" />
            <circle className="art-ink" cx="24.5" cy="49.5" r="2" />
        </>
    ),
    analyst: (
        <>
            <Body />
            <Eyes dx={-2} />
            <Smile />
            <circle className="art-paper" cx="44" cy="31" r="8" />
            <path className="art-line art-thick" d="m49.8 36.8 7 7" />
            <path className="art-line art-thin" d="M40.5 34v-2.5M44 34v-6M47.5 34v-4" />
        </>
    ),
    designer: (
        <>
            <Body />
            <Eyes />
            <Smile />
            <path
                className="art-paper"
                d="M50 26c-6.6 0-12 4.6-12 10.3 0 5.2 4.3 8.7 8.7 7.4 2.7-.8 2.2-3.7 4.4-4.4 4.1-1.3 10.9.6 10.9-4.3C62 30 56.6 26 50 26z"
            />
            <circle className="art-ink" cx="44" cy="35" r="1.8" />
            <circle className="art-shade" cx="49" cy="31" r="1.8" />
            <circle className="art-ink" cx="55" cy="32.5" r="1.8" />
        </>
    ),
    mail: (
        <>
            <Body />
            <Eyes dx={-1.5} />
            <Smile />
            <rect className="art-paper" x="38" y="34" width="22" height="15" rx="2.5" />
            <path className="art-line" d="m38.6 35 10.4 8 10.4-8" />
        </>
    ),
    finance: (
        <>
            <Body />
            <Eyes />
            <Cheeks />
            <Smile />
            <circle className="art-shade" cx="49" cy="15" r="9" />
            <path
                className="art-line art-thin"
                d="M51.5 11.5c-.8-1-2-1.5-3-1.5-1.8 0-3 1-3 2.4 0 3.3 6.4 1.8 6.4 5 0 1.4-1.4 2.4-3.3 2.4-1.2 0-2.5-.5-3.3-1.5M48.8 8.3v13.4"
            />
        </>
    ),
    marketing: (
        <>
            <Body />
            <Eyes dx={-1.5} />
            <path className="art-paper" d="M27.5 42h8q-.7 4.4-4 4.4t-4-4.4z" />
            <path className="art-shade" d="m44 34 12-8v22l-12-8z" />
            <rect className="art-paper" x="39" y="33" width="6" height="8" rx="1.5" />
            <path className="art-line art-thin" d="M59.5 31.5q2 5.5 0 11" />
        </>
    ),
    security: (
        <>
            <Body />
            <Eyes dx={-1.5} dy={0.5} />
            <path className="art-line" d="M28.5 43.5h6" />
            <path className="art-shade" d="M49.5 27.5 59 31v7c0 6-4 9.8-9.5 11.5C44 47.8 40 44 40 38v-7z" />
            <path className="art-line art-thin" d="m45.3 38.4 2.9 2.9 5.4-5.6" />
        </>
    ),
    launch: (
        <>
            <Body />
            <Eyes />
            <Cheeks />
            <Smile />
            <path className="art-paper" d="M52 3c-5.2 1.6-9 6.6-9.4 13.4l4.5 4.5C53.9 20.5 58.9 16.7 60.5 11.5z" />
            <circle className="art-ink" cx="53" cy="10.5" r="2" />
            <path className="art-shade" d="m43 17.2-4.4 1.1 2 3.6M46.3 20.5l-1.1 4.4-3.6-2" />
        </>
    ),
};

/**
 * An agent's illustration: strokes in `currentColor`, fills mixed from it and the raised surface
 * (illustrations.css), so the parent's text colour themes it. Decorative: the agent's name beside it is the label.
 */
export function AgentIllustration({ id, className }: { readonly id: IllustrationId; readonly className?: string }) {
    return (
        <svg
            viewBox="0 0 64 64"
            aria-hidden="true"
            focusable="false"
            className={className === undefined ? 'agent-art' : `agent-art ${className}`}
        >
            {ART[id]}
        </svg>
    );
}
