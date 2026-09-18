import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { ALLOWED_ORIGIN, SANDBOX_NAME, createHandler, createServiceProvider } from '../api/jobs.mjs';

const secret = 'a'.repeat(64);
const origin = 'https://worker-8080.vercel.run';
const payload = { videoId: 'M7lc1UVf-VE', format: 'mp3', clientRequestId: 'request_123456789012345' };
const runningJob = { id: '1'.repeat(32), videoId: payload.videoId, format: 'mp3', state: 'running',
  message: 'Preparing your download.', token: 'J'.repeat(43) };
function request(body = payload, extra = {}) {
  return new Request('https://gateway.vercel.app/api/jobs', { method: 'POST', headers: {
    Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json', 'x-vercel-forwarded-for': '203.0.113.42',
    ...extra,
  }, body: typeof body === 'string' ? body : JSON.stringify(body) });
}
function handler(overrides = {}) {
  return createHandler({ getService: async () => ({ origin, secret }), vercel: () => true,
    fetchImpl: async () => Response.json(runningJob, { status: 202 }), ...overrides });
}

test('only exact allowed origin reaches the worker; preflight creates no sandbox', async () => {
  let calls = 0;
  const fn = handler({ getService: async () => { calls++; throw new Error(); } });
  for (const Origin of ['', 'null', 'https://evil.test', ALLOWED_ORIGIN + '.evil.test']) {
    const result = await fn(request(payload, { Origin }));
    assert.equal(result.status, 403);
    assert.equal(result.headers.get('access-control-allow-origin'), null);
  }
  const preflight = await fn(new Request('https://gateway.vercel.app/api/jobs', {
    method: 'OPTIONS', headers: { Origin: ALLOWED_ORIGIN },
  }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
  assert.equal(calls, 0);
});

test('rejects oversized bodies and injected URLs/options before allocating resources', async () => {
  let calls = 0;
  const fn = handler({ getService: async () => { calls++; throw new Error(); } });
  assert.equal((await fn(request(' '.repeat(1025)))).status, 413);
  for (const data of [null, [], { ...payload, url: 'http://127.0.0.1' },
    { ...payload, clientKey: 'spoof' }, { ...payload, videoId: '../passwd' },
    { ...payload, format: '--exec' }, { ...payload, clientRequestId: 'tiny' }]) {
    assert.equal((await fn(request(JSON.stringify(data)))).status, 400);
  }
  assert.equal(calls, 0);
});

test('trusted edge IP is mandatory and visitors cannot choose their quota identity', async () => {
  let calls = 0;
  const fn = handler({ getService: async () => { calls++; return { origin, secret }; } });
  for (const ip of ['', 'garbage', '203.0.113.1, 203.0.113.2']) {
    assert.equal((await fn(request(payload, { 'x-vercel-forwarded-for': ip }))).status, 503);
  }
  assert.equal((await handler({ vercel: () => false })(request())).status, 503);
  assert.equal(calls, 0);
});

test('actual running worker response maps to direct status/file URLs without exposing service secret', async () => {
  const calls = [];
  const fn = handler({ fetchImpl: async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return Response.json({ ...runningJob, serviceSecret: secret, clientKey: 'internal' }, { status: 202 });
  } });
  const result = await fn(request());
  const body = await result.json();
  assert.equal(result.status, 202);
  assert.equal(body.state, 'running');
  assert.equal(body.statusUrl, `${origin}/jobs/${runningJob.id}`);
  assert.equal(body.downloadUrl, `${origin}/files/${runningJob.id}?token=${runningJob.token}`);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(calls[0].url, `${origin}/jobs`);
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${secret}`);
  assert.equal(calls[0].body.clientKey, createHmac('sha256', secret).update('client-ip\0' + '203.0.113.42').digest('hex'));
  assert.equal(JSON.stringify(body).includes(secret), false);
  assert.equal('clientKey' in body, false);
  await fn(request());
  assert.deepEqual(calls[0].body, calls[1].body, 'network retries keep idempotency scope');
});

test('rejects mismatched worker IDs and sanitizes worker errors', async () => {
  for (const change of [{ videoId: 'aaaaaaaaaaa' }, { format: 'video' }, { id: '../../x' },
    { token: 'short' }, { state: 'unknown' }, { filename: '../secret.mp3' }]) {
    const fn = handler({ fetchImpl: async () => Response.json({ ...runningJob, ...change }) });
    assert.equal((await fn(request())).status, 503);
  }
  const unavailable = handler({ getService: async () => { throw new Error(`SDK credential ${secret}`); } });
  assert.equal((await (await unavailable(request())).text()).includes(secret), false);
  const limited = await handler({ fetchImpl: async () => Response.json({ error: secret }, { status: 429 }) })(request());
  assert.equal(limited.status, 429);
  assert.equal((await limited.text()).includes(secret), false);
});

function sandboxMock(overrides = {}) {
  const calls = [];
  const sandbox = {
    expiresAt: new Date(Date.now() + 40 * 60_000),
    domain: () => origin,
    readFileToBuffer: async () => Buffer.from(secret),
    extendTimeout: async function (duration) { calls.push(['extend', duration]); this.expiresAt = new Date(this.expiresAt.getTime() + duration); },
    runCommand: async (cmd, args) => { calls.push([cmd, args]); return { exitCode: 0 }; },
    writeFiles: async files => { calls.push(['files', files]); },
    ...overrides,
  };
  const sdk = { getOrCreate: async options => { calls.push(['getOrCreate', options]); return sandbox; } };
  return { sandbox, sdk, calls };
}

test('warm service reuses exactly one named sandbox and coalesces concurrent initialization', async () => {
  const { sdk, calls } = sandboxMock();
  const service = createServiceProvider({ sandboxSDK: sdk, fetchImpl: async () => Response.json({ version: 1, ready: true }) });
  const results = await Promise.all([service(), service(), service()]);
  assert.equal(calls.filter(([name]) => name === 'getOrCreate').length, 1);
  assert.equal(calls[0][1].name, SANDBOX_NAME);
  assert.equal(calls[0][1].resume, true);
  assert.equal(calls.some(([name]) => name === 'files'), false);
  assert.deepEqual(results[0], { origin, secret });
});

test('cold service starts only after bootstrap success and confirmed readiness', async () => {
  const { sdk, calls } = sandboxMock();
  let checks = 0;
  const service = createServiceProvider({ sandboxSDK: sdk,
    readAsset: async path => Buffer.from(path),
    fetchImpl: async () => Response.json({ version: 1, ready: ++checks > 1 }) });
  assert.deepEqual(await service(), { origin, secret });
  assert.equal(calls.filter(([cmd]) => cmd === 'python3').length, 1);
  assert.equal(calls.find(([name]) => name === 'files')[1].length, 4);
  assert.equal(calls.filter(([cmd]) => cmd === 'rm').length, 1);
  assert.equal(checks, 2);
});

test('bootstrap failure cleans only uploaded bundle and never creates a job', async () => {
  const commands = [];
  const { sdk } = sandboxMock({ runCommand: async (cmd, args) => {
    commands.push([cmd, args]); return { exitCode: cmd === 'python3' ? 1 : 0 };
  } });
  const service = createServiceProvider({ sandboxSDK: sdk, readAsset: async () => Buffer.from('asset'),
    fetchImpl: async () => Response.json({ version: 1, ready: false }) });
  await assert.rejects(service(), /initialization failed/);
  assert.match(commands.at(-1)[1].at(-1), /^\/vercel\/sandbox\/download-bootstrap-[a-f0-9-]+$/);
  assert.equal(commands.at(-1)[0], 'rm');
});

test('does not accept a new job near session expiry unless extension provides full time budget', async () => {
  const ready = async () => Response.json({ version: 1, ready: true });
  const { sdk, calls } = sandboxMock({ expiresAt: new Date(Date.now() + 5 * 60_000) });
  await createServiceProvider({ sandboxSDK: sdk, fetchImpl: ready })();
  assert.equal(calls.filter(([cmd]) => cmd === 'extend').length, 1);
  for (const extendTimeout of [async () => { throw new Error('plan limit'); }, async () => {}]) {
    const blocked = sandboxMock({ expiresAt: new Date(Date.now() + 5 * 60_000), extendTimeout });
    await assert.rejects(createServiceProvider({ sandboxSDK: blocked.sdk, fetchImpl: ready })());
    assert.equal(blocked.calls.some(([cmd]) => cmd === 'stop'), false);
  }
});

test('creation race reuses the same name instead of allocating another worker', async () => {
  const { sandbox } = sandboxMock();
  let gets = 0;
  const sdk = {
    getOrCreate: async () => { throw { response: { status: 409 } }; },
    get: async options => { gets++; assert.equal(options.name, SANDBOX_NAME); return sandbox; },
  };
  await createServiceProvider({ sandboxSDK: sdk, fetchImpl: async () => Response.json({ version: 1, ready: true }) })();
  assert.equal(gets, 1);
});

test('packaged helper is exactly the reviewed desktop helper', async () => {
  const original = await readFile(new URL('../../downloads/dream-unity-helper.py', import.meta.url));
  const bundled = await readFile(new URL('../worker/helper.py', import.meta.url));
  assert.deepEqual(bundled, original);
});
