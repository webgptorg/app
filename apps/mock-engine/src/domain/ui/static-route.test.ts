import { ENGINE_API_PREFIX, ENGINE_RESERVED_PATHS, ENGINE_UI_CSP } from '@ptbk/engine-api';
import type { UiBundleManifest } from '@ptbk/protocol';
import { UiBundleManifest as UiBundleManifestSchema } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { entryOf, resolveStatic } from './static-route';

const HTML = 'text/html,application/xhtml+xml,*/*;q=0.8';
const file = (path: string) => ({ path, sha256: 'a'.repeat(64), size: 1 });
const manifest: UiBundleManifest = UiBundleManifestSchema.parse({
    v: 1,
    version: '1.0.0',
    commit: 'c'.repeat(40),
    engineApi: '>=1.0.0 <2.0.0',
    entry: 'index.html',
    files: [
        file('index.html'),
        file('assets/index-BxD3f9_a.js'),
        file('assets/fonts/inter-Ab12Cd34.woff2'),
        file('assets/logo.svg'),
        file('robots.txt'),
        file('data.bin'),
    ],
    csp: ENGINE_UI_CSP,
});

describe('resolveStatic', () => {
    it('serves a hashed asset as immutable with its type', () => {
        expect(resolveStatic('/assets/index-BxD3f9_a.js', 'GET', '*/*', manifest)).toEqual({
            kind: 'asset',
            file: file('assets/index-BxD3f9_a.js'),
            contentType: 'text/javascript; charset=utf-8',
            cache: 'immutable',
        });
        expect(resolveStatic('/assets/fonts/inter-Ab12Cd34.woff2', 'HEAD', undefined, manifest)).toMatchObject({
            cache: 'immutable',
            contentType: 'font/woff2',
        });
    });

    it('serves index.html and unhashed files as no-cache', () => {
        expect(resolveStatic('/', 'GET', HTML, manifest)).toMatchObject({
            kind: 'asset',
            file: file('index.html'),
            contentType: 'text/html; charset=utf-8',
            cache: 'no-cache',
        });
        expect(resolveStatic('/index.html', 'GET', HTML, manifest)).toMatchObject({ cache: 'no-cache' });
        expect(resolveStatic('/assets/logo.svg', 'GET', '*/*', manifest)).toMatchObject({
            cache: 'no-cache',
            contentType: 'image/svg+xml',
        });
        expect(resolveStatic('/robots.txt', 'GET', '*/*', manifest)).toMatchObject({
            contentType: 'text/plain; charset=utf-8',
        });
        expect(resolveStatic('/data.bin', 'GET', '*/*', manifest)).toMatchObject({
            contentType: 'application/octet-stream',
        });
    });

    it('falls back to the entry for a document request to a client-side route', () => {
        expect(resolveStatic('/agents/123', 'GET', HTML, manifest)).toEqual({ kind: 'spa-fallback' });
        expect(resolveStatic('/agents/123', 'HEAD', 'TEXT/HTML', manifest)).toEqual({ kind: 'spa-fallback' });
    });

    it('answers 404 for a missing asset, even for a document request', () => {
        expect(resolveStatic('/assets/missing.js', 'GET', '*/*', manifest)).toEqual({ kind: 'not-found' });
        expect(resolveStatic('/assets/missing.js', 'GET', HTML, manifest)).toEqual({ kind: 'not-found' });
    });

    it('answers 404 for any method but GET and HEAD, on any path', () => {
        for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
            expect(resolveStatic('/agents/123', method, HTML, manifest), method).toEqual({ kind: 'not-found' });
            expect(resolveStatic('/', method, HTML, manifest), method).toEqual({ kind: 'not-found' });
        }
    });

    it('never falls back on API paths or any other reserved path', () => {
        const paths = [
            ENGINE_API_PREFIX,
            `${ENGINE_API_PREFIX}/agents`,
            '/api',
            '/api/v2/x',
            ...ENGINE_RESERVED_PATHS.map((prefix) => `${prefix}${prefix.endsWith('/') ? '' : '/'}x`),
            '/setup',
            '/.well-known',
            '/assets',
            '/__spike/whoami',
            '/__mock/state',
        ];
        for (const path of paths)
            expect(resolveStatic(path, 'GET', HTML, manifest), path).toEqual({ kind: 'not-found' });
        expect(resolveStatic('/setup-guide', 'GET', HTML, manifest)).toEqual({ kind: 'spa-fallback' });
        expect(resolveStatic('/apis', 'GET', HTML, manifest)).toEqual({ kind: 'spa-fallback' });
    });

    it('answers 404 for a non-document request to an unknown path', () => {
        expect(resolveStatic('/agents/123', 'GET', 'application/json', manifest)).toEqual({ kind: 'not-found' });
        expect(resolveStatic('/agents/123', 'GET', undefined, manifest)).toEqual({ kind: 'not-found' });
    });

    it('serves only files the manifest lists, matched exactly and never decoded', () => {
        expect(resolveStatic('/assets/index-BxD3f9_a%2Ejs', 'GET', '*/*', manifest)).toEqual({ kind: 'not-found' });
        expect(resolveStatic('//index.html', 'GET', '*/*', manifest)).toEqual({ kind: 'not-found' });
        expect(resolveStatic('/manifest.json', 'GET', '*/*', manifest)).toEqual({ kind: 'not-found' });
        expect(resolveStatic('index.html', 'GET', '*/*', manifest)).toEqual({ kind: 'not-found' });
    });
});

describe('entryOf', () => {
    it('is the manifest entry, never cached', () => {
        expect(entryOf(manifest)).toMatchObject({ kind: 'asset', file: file('index.html'), cache: 'no-cache' });
    });
});
