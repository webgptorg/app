// Generates an Ed25519 release key for staging or tests (X-03): writes the base64url seed to <file> (0600, never
// overwritten) and prints the public KeyRef for a trust policy. Production release keys live on hardware tokens.
//
//   bun run --filter @ptbk/engine-ui release:keygen <file>
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { dsseKeyId, ed25519PublicKeyFromBytes, encodeBase64Url } from '@ptbk/protocol';

import { releaseSignerFromSeed } from './release/signed-release.ts';

const [file] = process.argv.slice(2);
if (file === undefined) throw new Error('usage: release:keygen <file>');
const seed = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
const publicKey = (await releaseSignerFromSeed(seed)).publicKey();
await writeFile(resolve(file), `${seed}\n`, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ publicKey: ed25519PublicKeyFromBytes(publicKey), keyid: await dsseKeyId(publicKey) }));
