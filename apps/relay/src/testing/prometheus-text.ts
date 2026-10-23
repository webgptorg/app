export interface Sample {
    readonly name: string;
    readonly labels: Readonly<Record<string, string>>;
    readonly value: number;
}

export interface Exposition {
    readonly samples: readonly Sample[];
    readonly types: ReadonlyMap<string, string>;
    readonly helps: ReadonlyMap<string, string>;
    /** The value of the one sample of `name` whose labels include `labels`; throws if there is not exactly one. */
    value(name: string, labels?: Readonly<Record<string, string>>): number;
}

const SAMPLE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})? (\S+)$/;
const LABEL = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;

/** A strict reader of the Prometheus text format as the relay writes it, for tests; any other line throws. */
export function parseExposition(text: string): Exposition {
    const samples: Sample[] = [];
    const types = new Map<string, string>();
    const helps = new Map<string, string>();
    for (const line of text.split('\n')) {
        if (line === '') continue;
        const comment = /^# (HELP|TYPE) (\S+) (.*)$/.exec(line);
        if (comment !== null) {
            (comment[1] === 'HELP' ? helps : types).set(comment[2] ?? '', comment[3] ?? '');
            continue;
        }
        const match = SAMPLE.exec(line);
        if (match === null) throw new Error(`not a sample line: ${line}`);
        const labels: Record<string, string> = {};
        for (const label of (match[2] ?? '').matchAll(LABEL)) labels[label[1] ?? ''] = label[2] ?? '';
        samples.push({ name: match[1] ?? '', labels, value: match[3] === '+Inf' ? Infinity : Number(match[3]) });
    }
    return {
        samples,
        types,
        helps,
        value(name, labels = {}) {
            const found = samples.filter(
                (sample) =>
                    sample.name === name &&
                    Object.entries(labels).every(([label, value]) => sample.labels[label] === value),
            );
            if (found.length !== 1) throw new Error(`${String(found.length)} samples of ${name}`);
            return (found[0] as Sample).value;
        },
    };
}
