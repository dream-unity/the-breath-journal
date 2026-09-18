import { readFile, mkdir, writeFile } from 'node:fs/promises';

for (const path of ['bootstrap.py', 'service.py', 'requirements.txt', 'worker/helper.py']) {
  const contents = await readFile(new URL(`../${path}`, import.meta.url));
  if (!contents.length) throw new Error(`Missing worker asset: ${path}`);
}
await mkdir(new URL('../public/', import.meta.url), { recursive: true });
await writeFile(new URL('../public/index.html', import.meta.url), '<!doctype html><title>Dream Unity downloads</title><p>Dream Unity download service.</p>\n');
