import { describe, expect, it } from 'vitest';

import { sessionDevice } from './session-device';

const client = (userAgent: string) => ({ ip: '203.0.113.7', userAgent });

describe('sessionDevice', () => {
    it.each([
        [
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0',
            { browser: 'Firefox', os: 'macOS', kind: 'computer' },
        ],
        [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
            { browser: 'Edge', os: 'Windows', kind: 'computer' },
        ],
        [
            'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
            { browser: 'Safari', os: 'iOS', kind: 'phone' },
        ],
        [
            'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1',
            { browser: 'Chrome', os: 'iPadOS', kind: 'tablet' },
        ],
        [
            'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
            { browser: 'Chrome', os: 'Android', kind: 'phone' },
        ],
        [
            'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Safari/537.36',
            { browser: 'Samsung Internet', os: 'Android', kind: 'tablet' },
        ],
        [
            'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/114.0.0.0',
            { browser: 'Opera', os: 'ChromeOS', kind: 'computer' },
        ],
        [
            'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
            { browser: 'Firefox', os: 'Linux', kind: 'computer' },
        ],
    ])('reads %s', (userAgent, expected) => {
        expect(sessionDevice(client(userAgent))).toEqual(expected);
    });

    it('knows nothing about an agent it does not recognise, or a session without a client', () => {
        expect(sessionDevice(client('curl/8.7.1'))).toEqual({ browser: null, os: null, kind: 'computer' });
        expect(sessionDevice(null)).toEqual({ browser: null, os: null, kind: 'computer' });
    });
});
