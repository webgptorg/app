/** Short enough to cost a provider next to nothing, long enough to be a clip. */
export const SILENT_CLIP_MS = 1_000;

const SAMPLE_RATE = 16_000;
const HEADER_BYTES = 44;

/**
 * The UI's WAV fallback: 16-bit PCM, mono, 16 kHz, `audio/wav`. `fill` writes the samples' bytes (silence by default),
 * e.g. a marker the checks then look for in every answer.
 */
export function wavClip(ms: number, fill?: (data: Uint8Array) => void): Blob {
    const dataBytes = Math.round((SAMPLE_RATE * ms) / 1000) * 2;
    const bytes = new Uint8Array(HEADER_BYTES + dataBytes);
    const view = new DataView(bytes.buffer);
    const ascii = (offset: number, text: string): void => {
        for (let index = 0; index < text.length; index++) bytes[offset + index] = text.charCodeAt(index);
    };
    ascii(0, 'RIFF');
    view.setUint32(4, 36 + dataBytes, true);
    ascii(8, 'WAVE');
    ascii(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, SAMPLE_RATE, true);
    view.setUint32(28, SAMPLE_RATE * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    ascii(36, 'data');
    view.setUint32(40, dataBytes, true);
    fill?.(bytes.subarray(HEADER_BYTES));
    return new Blob([bytes], { type: 'audio/wav' });
}

export function silentWav(ms: number): Blob {
    return wavClip(ms);
}

/** A clip whose samples repeat `marker`, so an answer that echoes any of the audio contains it. */
export function markedWav(ms: number, marker: string): Blob {
    const pattern = new TextEncoder().encode(marker);
    return wavClip(ms, (data) => {
        for (let offset = 0; offset < data.length; offset += pattern.length)
            data.set(pattern.subarray(0, data.length - offset), offset);
    });
}
