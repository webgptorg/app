export interface TaskName {
    /** What a person calls the task: the name without its stamp. */
    readonly readable: string;
    /** The engine's instance stamp (`2026-10-30 09:00`), seconds dropped when they are zero; `null` without one. */
    readonly stamp: string | null;
}

/**
 * Reborn names a task instance `<Name> — <YYYY-MM-DD HH:MM:SS>` so recurring and repeated tasks stay unique. The
 * stamp is part of the engine's name, so it stays visible, but as quiet secondary text: the readable part is what a
 * person scans for. A name that only looks like a stamp keeps it, so nothing is ever shown blank.
 */
export function splitTaskName(name: string): TaskName {
    const match = /^(.*\S)\s+[—–-]\s+(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(:\d{2})?)?$/u.exec(name);
    if (match === null) return { readable: name, stamp: null };
    const [, readable = name, date = '', time, seconds] = match;
    const clock = time === undefined ? '' : ` ${time}${seconds === undefined || seconds === ':00' ? '' : seconds}`;
    return { readable, stamp: `${date}${clock}` };
}
