import { createWriteStream, existsSync, statSync } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const [url, destination] = process.argv.slice(2);
if (!url || !destination) throw new Error('usage: node download.mjs URL DESTINATION');
await mkdir(dirname(destination), { recursive:true });
const partial = `${destination}.part`;
for (let attempt = 1; attempt <= 8; attempt += 1) {
  const offset = existsSync(partial) ? statSync(partial).size : 0;
  try {
    const response = await fetch(url, { redirect:'follow', headers:offset ? { Range:`bytes=${offset}-` } : {} });
    if ((!response.ok && response.status !== 206) || !response.body) throw new Error(`download failed: ${response.status} ${response.statusText}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { flags:offset && response.status === 206 ? 'a' : 'w' }));
    await rename(partial, destination);
    console.log(`downloaded ${destination}`);
    process.exit(0);
  } catch (error) {
    if (attempt === 8) throw error;
    await new Promise(resolve => setTimeout(resolve, attempt * 1000));
  }
}
