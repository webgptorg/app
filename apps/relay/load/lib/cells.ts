/** One measured configuration of the screencast scenario. */
export type Cell =
    | {
          readonly kind: 'screencast';
          readonly frameBytes: number;
          readonly fps: number;
          readonly streams: number;
          readonly seconds: number;
      }
    /** Engine A saturates its bandwidth budget with `bulkStreams` downloads while engine B runs a 100 KB, 5 fps cast. */
    | { readonly kind: 'fairness'; readonly bulkStreams: number; readonly seconds: number };

export const FAIRNESS_FRAME_BYTES = 102_400;
export const FAIRNESS_FPS = 5;
const DEFAULT_BULK_STREAMS = 8;

/**
 * `100kx5x1@600` is 100 KB frames at 5 fps on 1 stream for 600 s; `fair@600` (or `fair8@600`, the bulk stream count)
 * is the fairness run. A missing `@seconds` takes `defaultSeconds`.
 */
export function parseCells(spec: string, defaultSeconds: number): Cell[] {
    return spec
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '')
        .map((item): Cell => {
            const [body = '', secondsText] = item.split('@');
            const seconds = secondsText === undefined ? defaultSeconds : Number(secondsText);
            if (!Number.isFinite(seconds) || seconds <= 0) throw new RangeError(`bad duration in cell ${item}`);
            const fairness = /^fair(\d*)$/.exec(body);
            if (fairness !== null) {
                const bulkStreams =
                    fairness[1] === '' || fairness[1] === undefined ? DEFAULT_BULK_STREAMS : Number(fairness[1]);
                return { kind: 'fairness', bulkStreams, seconds };
            }
            const match = /^(\d+)kx(\d+)x(\d+)$/.exec(body);
            if (match === null) throw new RangeError(`bad cell ${item}`);
            return {
                kind: 'screencast',
                frameBytes: Number(match[1]) * 1024,
                fps: Number(match[2]),
                streams: Number(match[3]),
                seconds,
            };
        });
}

export function cellName(cell: Cell): string {
    return cell.kind === 'fairness'
        ? `fair${String(cell.bulkStreams)}`
        : `${String(cell.frameBytes / 1024)}kx${String(cell.fps)}x${String(cell.streams)}`;
}

/** Engines a cell needs at once. */
export function enginesFor(cell: Cell): number {
    return cell.kind === 'fairness' ? 2 : cell.streams;
}
