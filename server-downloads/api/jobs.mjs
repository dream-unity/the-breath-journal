import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';

export const ALLOWED_ORIGIN = 'https://dream-unity.github.io';
export const SANDBOX_NAME = 'dream-unity-downloads-v1';
const ROOT = '/vercel/sandbox/download-service';
const SESSION_MS = 40 * 60 * 1000;
const ASSETS = ['bootstrap.py', 'service.py', 'requirements.txt', 'worker/helper.py'];
const ID = /^[A-Za-z0-9_-]{11}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{16,128}$/;
const JOB_ID = /^[a-f0-9]{32}$/;
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
const STATES = new Set(['queued', 'running', 'complete', 'error', 'cancelled']);

class PublicError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function response(request, status, value) {
  const headers = {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
  if (request.headers.get('origin') === ALLOWED_ORIGIN) {
    headers['Access-Control-Allow-Origin'] = ALLOWED_ORIGIN;
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type';
    headers['Access-Control-Max-Age'] = '600';
  }
  if (status === 429 || status === 503) headers['Retry-After'] = '10';
  return new Response(status === 204 ? null : JSON.stringify(value), { status, headers });
}

async function readPayload(request) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new PublicError(415, 'Use a JSON download request.');
  }
  if (Number(request.headers.get('content-length')) > 1024) {
    throw new PublicError(413, 'Download request is too large.');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new PublicError(400, 'Missing download request.');
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 1024) {
        await reader.cancel();
        throw new PublicError(413, 'Download request is too large.');
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new PublicError(400, 'Invalid download request.'); }
  if (!body || Array.isArray(body) || typeof body !== 'object' ||
      Object.keys(body).some(key => !['videoId', 'format', 'clientRequestId'].includes(key)) ||
      typeof body.videoId !== 'string' || !ID.test(body.videoId) ||
      !['video', 'mp3'].includes(body.format) ||
      typeof body.clientRequestId !== 'string' || !REQUEST_ID.test(body.clientRequestId)) {
    throw new PublicError(400, 'Choose a valid YouTube video and download format.');
  }
  return { videoId: body.videoId, format: body.format, clientRequestId: body.clientRequestId };
}

function sandboxOrigin(sandbox) {
  const url = new URL(sandbox.domain(8080));
  if (url.protocol !== 'https:' || url.port || url.username || url.password ||
      !/^[a-z0-9-]+\.vercel\.run$/.test(url.hostname) || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Unexpected sandbox origin.');
  }
  return url.origin;
}

async function isReady(origin, fetchImpl) {
  try {
    const result = await fetchImpl(`${origin}/health`, { signal: AbortSignal.timeout(3000), redirect: 'error' });
    if (!result.ok) return false;
    const health = await result.json();
    return health?.version === 1 && health?.ready === true;
  } catch { return false; }
}

export function createServiceProvider({ sandboxSDK, fetchImpl = fetch, readAsset = path => readFile(new URL(`../${path}`, import.meta.url)) } = {}) {
  // A single promise coalesces concurrent requests in one function instance.
  // Sandbox's unique name and worker flock cover separate function instances.
  let pending;
  async function prepare() {
    const Sandbox = sandboxSDK || (await import('@vercel/sandbox')).Sandbox;
    const options = {
      name: SANDBOX_NAME, image: 'vercel/sandbox/universal:latest',
      ports: [8080], resources: { vcpus: 2 }, resume: true,
      persistent: true, timeout: SESSION_MS,
      snapshotExpiration: 24 * 60 * 60 * 1000,
      keepLastSnapshots: { count: 1, deleteEvicted: true },
    };
    let sandbox;
    try { sandbox = await Sandbox.getOrCreate(options); }
    catch (error) {
      // SDK 3.3 getOrCreate can race when two function instances create a name.
      // A conflicting creation must reuse that name; never create another VM.
      if (error?.response?.status !== 409 && error?.status !== 409 && error?.statusCode !== 409 && error?.code !== 'conflict') throw error;
      sandbox = await Sandbox.get({ name: SANDBOX_NAME, resume: true });
    }
    const origin = sandboxOrigin(sandbox);
    if (!(await isReady(origin, fetchImpl))) {
      const source = `/vercel/sandbox/download-bootstrap-${randomUUID()}`;
      try {
        const mkdir = await sandbox.runCommand('mkdir', ['-p', `${source}/worker`]);
        if (mkdir.exitCode !== 0) throw new Error('Could not prepare worker assets.');
        await sandbox.writeFiles(await Promise.all(ASSETS.map(async path => ({
          path: `${source}/${path}`, content: await readAsset(path), mode: 0o600,
        }))));
        const bootstrap = await sandbox.runCommand('python3', [`${source}/bootstrap.py`]);
        if (bootstrap.exitCode !== 0) throw new Error('Worker initialization failed.');
        if (!(await isReady(origin, fetchImpl))) throw new Error('Worker is not ready.');
      } finally {
        // Only remove this request's generated source directory, never job files.
        await sandbox.runCommand('rm', ['-rf', '--', source]).catch(() => {});
      }
    }
    const credential = await sandbox.readFileToBuffer({ path: `${ROOT}/service-secret` });
    const secret = credential?.toString('utf8');
    if (!secret || !/^[a-f0-9]{64}$/.test(secret)) throw new Error('Worker credential is unavailable.');
    const remaining = sandbox.expiresAt?.getTime() - Date.now();
    if (!Number.isFinite(remaining)) throw new Error('Worker expiry is unavailable.');
    if (remaining < 35 * 60 * 1000) {
      // SDK extends the current session's total duration, subject to plan caps.
      // Never stop/recycle a live worker here: existing downloads still own it.
      await sandbox.extendTimeout(SESSION_MS - Math.max(0, remaining));
      if (sandbox.expiresAt?.getTime() - Date.now() < 35 * 60 * 1000) {
        throw new Error('Worker cannot provide enough remaining session time.');
      }
    }
    return { origin, secret };
  }
  return async () => {
    if (!pending) pending = prepare().finally(() => { pending = undefined; });
    return pending;
  };
}

export function createHandler({ getService = createServiceProvider(), fetchImpl = fetch, vercel = () => process.env.VERCEL === '1' } = {}) {
  return async request => {
    if (request.headers.get('origin') !== ALLOWED_ORIGIN) return response(request, 403, { error: 'This download request is not allowed.' });
    if (request.method === 'OPTIONS') return response(request, 204);
    if (request.method !== 'POST') return response(request, 405, { error: 'Use POST to request a download.' });
    try {
      const payload = await readPayload(request);
      // Vercel overwrites this header at its trusted edge. No body/cookie/IP fallback.
      const ip = request.headers.get('x-vercel-forwarded-for')?.trim();
      if (!vercel() || !ip || !isIP(ip)) throw new PublicError(503, 'The download service is not ready. Try again shortly.');
      const { origin, secret } = await getService();
      const clientKey = createHmac('sha256', secret).update(`client-ip\0${ip}`).digest('hex');
      const upstream = await fetchImpl(`${origin}/jobs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
        body: JSON.stringify({ ...payload, clientKey }),
        signal: AbortSignal.timeout(15_000), redirect: 'error',
      });
      const job = await upstream.json();
      if (!upstream.ok) {
        const status = [400, 409, 429, 503].includes(upstream.status) ? upstream.status : 503;
        throw new PublicError(status, status === 429 ? 'Download capacity is temporarily full. Please try again later.' : 'The download could not start. Please try again shortly.');
      }
      if (!JOB_ID.test(job?.id) || job.videoId !== payload.videoId || job.format !== payload.format ||
          !TOKEN.test(job.token) || !STATES.has(job.state) || typeof job.message !== 'string' ||
          job.message.length > 500 || (job.filename !== undefined &&
          (typeof job.filename !== 'string' || !/^[A-Za-z0-9_. -]{1,200}$/.test(job.filename)))) {
        throw new Error('Invalid worker response.');
      }
      const result = { id: job.id, videoId: job.videoId, format: job.format, state: job.state,
        message: job.message, token: job.token,
        statusUrl: `${origin}/jobs/${job.id}`,
        downloadUrl: `${origin}/files/${job.id}?token=${encodeURIComponent(job.token)}` };
      if (job.filename !== undefined) result.filename = job.filename;
      return response(request, 202, result);
    } catch (error) {
      // Never return package output, credentials, OIDC tokens, or SDK internals.
      return response(request, error instanceof PublicError ? error.status : 503,
        { error: error instanceof PublicError ? error.message : 'The download service is starting or temporarily unavailable. Please try again shortly.' });
    }
  };
}

export default { fetch: createHandler() };
