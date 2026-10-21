import { expect, test } from '../../src/fixtures.ts';

const EVENT_COUNT = 20;
const ROUND_TRIPS = 20;
const BINARY_BYTES = 256 * 1024;

test.beforeEach(async ({ page, spikeUrl }) => {
    await page.goto(spikeUrl);
});

test('SSE through the passthrough delivers every event, in order', async ({ page }) => {
    const events = await page.evaluate(
        (count) =>
            new Promise<{ id: string; data: string }[]>((resolve, reject) => {
                const received: { id: string; data: string }[] = [];
                const source = new EventSource(`/__spike/sse?count=${String(count)}&intervalMs=20`);
                source.onmessage = (event: MessageEvent<string>) => {
                    received.push({ id: event.lastEventId, data: event.data });
                    if (received.length === count) {
                        source.close();
                        resolve(received);
                    }
                };
                source.onerror = () => {
                    if (source.readyState === EventSource.CLOSED) reject(new Error('the event stream failed'));
                };
            }),
        EVENT_COUNT,
    );

    const expected = Array.from({ length: EVENT_COUNT }, (_, index) => ({
        id: String(index + 1),
        data: JSON.stringify({ id: index + 1 }),
    }));
    expect(events).toEqual(expected);
});

test('a WebSocket through the passthrough echoes text and a 256 KiB binary message', async ({ page }) => {
    const result = await page.evaluate(
        async ({ roundTrips, binaryBytes }) => {
            const socket = new WebSocket(`wss://${location.host}/__spike/ws`);
            socket.binaryType = 'arraybuffer';
            const queue: (string | ArrayBuffer)[] = [];
            const waiting: ((message: string | ArrayBuffer) => void)[] = [];
            socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
                const next = waiting.shift();
                if (next === undefined) queue.push(event.data);
                else next(event.data);
            };
            const nextMessage = () =>
                new Promise<string | ArrayBuffer>((resolve) => {
                    const queued = queue.shift();
                    if (queued === undefined) waiting.push(resolve);
                    else resolve(queued);
                });
            await new Promise<void>((resolve, reject) => {
                socket.onopen = () => {
                    resolve();
                };
                socket.onerror = () => {
                    reject(new Error('the WebSocket failed'));
                };
            });

            const binary = new Uint8Array(binaryBytes);
            // getRandomValues fills at most 64 KiB per call.
            for (let offset = 0; offset < binary.length; offset += 65_536) {
                crypto.getRandomValues(binary.subarray(offset, offset + 65_536));
            }
            let textEchoes = 0;
            let binaryEchoed = false;
            for (let index = 0; index < roundTrips; index++) {
                if (index === roundTrips - 1) {
                    socket.send(binary);
                    const echo = await nextMessage();
                    binaryEchoed =
                        echo instanceof ArrayBuffer &&
                        echo.byteLength === binary.length &&
                        new Uint8Array(echo).every((byte, offset) => byte === binary[offset]);
                } else {
                    const text = `round trip ${String(index)}`;
                    socket.send(text);
                    if ((await nextMessage()) === text) textEchoes++;
                }
            }
            socket.close();
            return { textEchoes, binaryEchoed };
        },
        { roundTrips: ROUND_TRIPS, binaryBytes: BINARY_BYTES },
    );

    expect(result).toEqual({ textEchoes: ROUND_TRIPS - 1, binaryEchoed: true });
});
