import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../hosted-youtube-downloads.js', import.meta.url), 'utf8');
const { createHostedDownloadSession, createYouTubeDownloads } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const SERVICE = 'https://downloads.example.com', WORKER = 'https://download-worker-123.vercel.run';
const TOKEN = 'a'.repeat(43), FIRST = 'M7lc1UVf-VE', SECOND = 'dQw4w9WgXcQ';
const video = videoId => ({ videoId, embedUrl: `https://www.youtube-nocookie.com/embed/${videoId}` });
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { for (let index = 0; index < 16; index++) await Promise.resolve(); };
function job(extra = {}) {
  const value = { id: 'job_1', videoId: FIRST, format: 'video', state: 'queued', message: 'Queued', ...extra };
  return { token: TOKEN, statusUrl: `${WORKER}/jobs/${value.id}`, downloadUrl: `${WORKER}/files/${value.id}?token=${TOKEN}`, ...value };
}
function harness(route = () => response(job()), overrides = {}) {
  let clock = 0, nextTimer = 0, nextRequest = 0;
  const calls = [], downloads = [], timers = new Map();
  const session = createHostedDownloadSession({
    serviceUrl: SERVICE,
    fetch: async (url, options) => {
      const call = { url, ...options, body: options.body ? JSON.parse(options.body) : undefined };
      calls.push(call); return route(call);
    },
    now: () => clock,
    setTimer: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimer: id => timers.delete(id), requestId: () => `request_${++nextRequest}`,
    downloadFile: (url, filename) => downloads.push({ url, filename }), jobTimeout: 10000,
    ...overrides,
  });
  return { session, calls, downloads, timers,
    advance(ms) { clock += ms; },
    async poll() {
      const item = [...timers].find(([, timer]) => timer.delay === 1800);
      assert.ok(item, 'Expected a scheduled status check'); timers.delete(item[0]); item[1].callback(); await settle();
    },
  };
}
class Element {
  constructor(tagName, document) {
    this.tagName = tagName; this.ownerDocument = document; this.children = []; this.listeners = new Map();
    this.attributes = {}; this.classList = { add() {} }; this.hidden = false; this._text = '';
  }
  set textContent(value) { this._text = value; this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...nodes) { this.children.push(...nodes); for (const node of nodes) node.parentElement = this; }
  replaceChildren(...nodes) { this.children = [...nodes]; this._text = ''; }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; delete this[key]; }
  addEventListener(type, listener) { const list = this.listeners.get(type) || []; list.push(listener); this.listeners.set(type, list); }
  async dispatch(type) { await Promise.all((this.listeners.get(type) || []).map(listener => listener())); await settle(); }
  focus() { this.focused = true; }
  remove() { this.parentElement.children = this.parentElement.children.filter(node => node !== this); }
}
function root() {
  const doc = { createElement: tag => new Element(tag, doc) }; doc.body = new Element('body', doc);
  return new Element('section', doc);
}
function all(node) { return [node, ...(node.children || []).flatMap(all)]; }
function named(node, tag, text) { return all(node).find(element => element.tagName === tag && element.textContent === text); }

test('mounting and switching ideas makes no requests and exposes only two download actions', async () => {
  const state = harness(), container = root(), player = { src: 'original-player', currentTime: 124 };
  const parent = { children: [player, container] };
  const view = createYouTubeDownloads(container, { session: state.session });
  view.setVideo(video(FIRST), 'main'); view.setVideo(video(SECOND), 'idea-b');
  assert.deepEqual(all(container).filter(node => node.tagName === 'button').map(node => node.textContent), ['Download video', 'Download MP3']);
  assert.equal(all(container).some(node => ['form', 'input', 'details'].includes(node.tagName)), false);
  assert.equal(state.calls.length, 0); assert.equal(state.downloads.length, 0);
  assert.deepEqual(parent.children, [player, container]); assert.equal(player.currentTime, 124);
  view.setVideo(null, 'idea-b'); assert.equal(container.hidden, true); view.destroy();
});

test('one click creates the remote job and completion automatically downloads exactly once', async () => {
  const state = harness(call => response(job(call.method === 'POST' ? {} : { state: 'complete', filename: 'my-video.mp4', message: '' })));
  const container = root(), view = createYouTubeDownloads(container, { session: state.session }); view.setVideo(video(FIRST), 'main');
  await named(container, 'button', 'Download video').dispatch('click');
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].url, `${SERVICE}/api/jobs`);
  assert.deepEqual(state.calls[0].body, { videoId: FIRST, format: 'video', clientRequestId: 'request_1' });
  assert.equal(state.calls[0].headers.Authorization, undefined);
  await state.poll();
  assert.deepEqual(state.downloads, [{ url: `${WORKER}/files/job_1?token=${TOKEN}`, filename: 'my-video.mp4' }]);
  assert.equal(state.calls[1].headers.Authorization, `Bearer ${TOKEN}`);
  for (const call of state.calls) { assert.equal(call.credentials, 'omit'); assert.equal(call.redirect, 'error'); assert.equal(call.referrerPolicy, 'no-referrer'); }
  view.setVideo(video(SECOND), 'branch'); view.setVideo(video(FIRST), 'main'); view.setVideo(video(FIRST), 'main');
  assert.equal(state.downloads.length, 1); assert.match(container.textContent, /Ready — my-video.mp4/);
  const link = named(container, 'a', 'Download ready file'); assert.equal(link.href, state.downloads[0].url);
  assert.equal(link.download, 'my-video.mp4'); assert.equal(link.referrerPolicy, 'no-referrer');
});

test('delayed completion belongs only to the originating idea even when another idea is selected', async () => {
  const pending = deferred(), state = harness(() => pending.promise), container = root();
  const view = createYouTubeDownloads(container, { session: state.session }); view.setVideo(video(FIRST), 'idea-a');
  const start = state.session.start('idea-a', FIRST, 'mp3'); view.setVideo(video(SECOND), 'idea-b');
  pending.resolve(response(job({ format: 'mp3', state: 'complete', filename: 'idea-a.mp3' }))); await start;
  assert.equal(state.downloads.length, 1); assert.equal(container.textContent.includes('idea-a.mp3'), false);
  assert.deepEqual(state.session.snapshot('idea-b', SECOND).jobs, []);
  view.setVideo(video(FIRST), 'idea-a'); assert.match(container.textContent, /idea-a.mp3/);
});

test('status can omit the stable capability fields after the initial response', async () => {
  const state = harness(call => response(call.method === 'POST' ? job() : { id: 'job_1', videoId: FIRST, format: 'video', state: 'complete', filename: 'ready.mp4' }));
  await state.session.start('map', FIRST, 'video'); await state.poll();
  assert.equal(state.session.snapshot('map', FIRST).jobs[0].state, 'complete'); assert.equal(state.downloads.length, 1);
});

test('HTTP errors including unavailable and rate-limited service release the job gate', async () => {
  for (const status of [400, 401, 403, 404, 410, 429]) {
    const state = harness(() => response({}, status)); await state.session.start('idea-a', FIRST, 'video');
    const snapshot = state.session.snapshot('idea-a', FIRST);
    assert.equal(snapshot.busy, false); assert.equal(snapshot.jobs[0].uncertain, false); assert.ok(snapshot.jobs[0].message);
    assert.equal(state.downloads.length, 0); assert.deepEqual(state.session.snapshot('idea-b', SECOND).jobs, []);
  }
});

test('an HTML access rejection reports the HTTP error and permits another attempt', async () => {
  const state = harness(() => ({ ok: false, status: 403, json: async () => { throw new SyntaxError('HTML response'); } }));
  await state.session.start('map', FIRST, 'video');
  const snapshot = state.session.snapshot('map', FIRST);
  assert.equal(snapshot.busy, false); assert.equal(snapshot.jobs[0].uncertain, false);
  assert.match(snapshot.jobs[0].message, /expired or is no longer available/);
});

test('ambiguous start failure retries the same request ID without creating concurrent work', async () => {
  let fail = true;
  const state = harness(() => { if (fail) { fail = false; throw new TypeError('network'); } return response(job({ state: 'complete', filename: 'ready.mp4' })); });
  await state.session.start('idea-a', FIRST, 'video'); assert.equal(state.session.snapshot('idea-a', FIRST).busy, true);
  await state.session.start('idea-b', SECOND, 'mp3'); assert.equal(state.calls.length, 1);
  await state.session.retry('idea-a', FIRST, 'video');
  assert.deepEqual(state.calls[0].body, state.calls[1].body); assert.equal(state.downloads.length, 1);
  await state.session.retry('idea-a', FIRST, 'video'); assert.equal(state.calls.length, 2);
});

test('an HTTP 5xx result remains uncertain so retry reuses the original idempotency key', async () => {
  let count = 0;
  const state = harness(() => ++count === 1 ? response({}, 503) : response(job()));
  await state.session.start('map', FIRST, 'video');
  assert.equal(state.session.snapshot('map', FIRST).jobs[0].uncertain, true);
  await state.session.retry('map', FIRST, 'video'); assert.deepEqual(state.calls[0].body, state.calls[1].body);
});

test('cancellation ignores a stale completed GET and never downloads that result', async () => {
  const late = deferred();
  const state = harness(call => call.method === 'POST' ? response(job()) : call.method === 'DELETE' ? response(job({ state: 'cancelled' })) : late.promise);
  await state.session.start('map', FIRST, 'video'); await state.poll();
  await state.session.cancel('other-map', FIRST, 'video'); assert.equal(state.calls.some(call => call.method === 'DELETE'), false);
  await state.session.cancel('map', FIRST, 'video');
  late.resolve(response(job({ state: 'complete', filename: 'too-late.mp4' }))); await settle();
  assert.equal(state.session.snapshot('map', FIRST).jobs[0].state, 'cancelled'); assert.equal(state.downloads.length, 0);
  assert.equal(state.calls.find(call => call.method === 'DELETE').url, `${WORKER}/jobs/job_1`);
  assert.equal(state.session.snapshot('map', FIRST).busy, false);
});

test('cancelling while the initial job request is pending cancels it when its identity arrives', async () => {
  const pending = deferred();
  const state = harness(call => call.method === 'POST' ? pending.promise : response(job({ state: 'cancelled' })));
  const start = state.session.start('map', FIRST, 'video'); await state.session.cancel('map', FIRST, 'video');
  assert.equal(state.session.snapshot('map', FIRST).jobs[0].state, 'cancelling');
  pending.resolve(response(job())); await start;
  assert.equal(state.calls.at(-1).method, 'DELETE'); assert.equal(state.session.snapshot('map', FIRST).jobs[0].state, 'cancelled');
  assert.equal(state.downloads.length, 0);
});

test('a completion racing the user cancellation stays available without forcing a download', async () => {
  const pending = deferred(), state = harness(() => pending.promise);
  const start = state.session.start('map', FIRST, 'video'); await state.session.cancel('map', FIRST, 'video');
  pending.resolve(response(job({ state: 'complete', filename: 'ready.mp4' }))); await start;
  assert.equal(state.downloads.length, 0); assert.equal(state.session.snapshot('map', FIRST).jobs[0].state, 'complete');
});

test('cancelling an uncertain initial request recovers the same job before cancelling', async () => {
  let fail = true;
  const state = harness(call => {
    if (fail) { fail = false; throw new TypeError('network'); }
    return response(job(call.method === 'DELETE' ? { state: 'cancelled' } : {}));
  });
  await state.session.start('map', FIRST, 'video'); await state.session.cancel('map', FIRST, 'video');
  assert.deepEqual(state.calls[0].body, state.calls[1].body); assert.equal(state.calls[2].method, 'DELETE');
  assert.equal(state.session.snapshot('map', FIRST).jobs[0].state, 'cancelled');
});

test('untrusted, mismatched or mutated worker URLs and tokens never reach the network or downloader', async () => {
  const invalid = [
    { statusUrl: `http://download-worker-123.vercel.run/jobs/job_1` },
    { statusUrl: `https://download-worker-123.vercel.run.evil.example/jobs/job_1` },
    { statusUrl: `https://user:password@download-worker-123.vercel.run/jobs/job_1` },
    { statusUrl: `${WORKER}:444/jobs/job_1` },
    { statusUrl: `${WORKER}/jobs/job_2` },
    { statusUrl: `${WORKER}/jobs/job_1?token=${TOKEN}` },
    { downloadUrl: `https://other-worker.vercel.run/files/job_1?token=${TOKEN}` },
    { downloadUrl: `${WORKER}/files/job_1?token=wrong` },
    { downloadUrl: `${WORKER}/files/job_1?token=${TOKEN}&redirect=elsewhere` },
    { downloadUrl: `${WORKER}/files/job_1?token=${TOKEN}&token=${TOKEN}` },
    { downloadUrl: `${WORKER}/files/job_2?token=${TOKEN}` },
    { downloadUrl: `javascript:alert(1)` },
    { token: 'invalid' }, { videoId: SECOND }, { format: 'mp3' }, { id: '../file' },
  ];
  for (const extra of invalid) {
    const state = harness(() => response(job({ state: 'complete', filename: 'unsafe.mp4', ...extra })));
    await state.session.start('map', FIRST, 'video');
    assert.equal(state.session.snapshot('map', FIRST).jobs[0].state, 'error', JSON.stringify(extra));
    assert.equal(state.downloads.length, 0); assert.equal(state.calls.length, 1);
  }
  const state = harness(call => response(job(call.method === 'POST' ? {} : {
    statusUrl: 'https://different-worker.vercel.run/jobs/job_1', downloadUrl: `https://different-worker.vercel.run/files/job_1?token=${TOKEN}`,
    state: 'complete', filename: 'changed.mp4',
  })));
  await state.session.start('map', FIRST, 'video'); await state.poll(); assert.equal(state.downloads.length, 0);
  assert.equal(state.session.snapshot('map', FIRST).jobs[0].state, 'error');
});

test('polling is bounded and polling preserves the focused cancel action', async () => {
  const state = harness(() => response(job({ state: 'running', progress: 42 }))), container = root();
  createYouTubeDownloads(container, { session: state.session }).setVideo(video(FIRST), 'map');
  await state.session.start('map', FIRST, 'video');
  const cancel = named(container, 'button', 'Cancel Video download'); cancel.focus(); await state.poll();
  assert.equal(named(container, 'button', 'Cancel Video download'), cancel); assert.equal(cancel.focused, true);
  assert.equal(all(container).find(node => node.tagName === 'progress').value, 42);
  state.advance(10001); await state.poll();
  assert.match(state.session.snapshot('map', FIRST).jobs[0].message, /timed out/);
  assert.equal([...state.timers.values()].some(timer => timer.delay === 1800), false);
});

test('video and MP3 have separate ready files, with an explicit fallback if automatic download fails', async () => {
  const state = harness(call => response(job({ id: `job_${call.body.format}`, format: call.body.format, state: 'complete', filename: `ready.${call.body.format === 'video' ? 'mp4' : 'mp3'}` })),
    { downloadFile() { throw new Error('download blocked'); } });
  const container = root(); createYouTubeDownloads(container, { session: state.session }).setVideo(video(FIRST), 'map');
  await state.session.start('map', FIRST, 'video'); await state.session.start('map', FIRST, 'mp3');
  assert.match(container.textContent, /ready.mp4/); assert.match(container.textContent, /ready.mp3/);
  assert.equal(all(container).filter(node => node.tagName === 'a' && !node.hidden).length, 2);
  assert.match(container.textContent, /ready-file link/);
});

test('default attachment delivery uses a sandboxed hidden frame and keeps all players mounted', async () => {
  const container = root(), doc = container.ownerDocument, player = doc.createElement('iframe'); player.src = 'existing-player'; doc.body.append(player, container);
  const oldDocument = globalThis.document, oldTimer = globalThis.setTimeout;
  const cleanup = [];
  globalThis.document = doc; globalThis.setTimeout = (callback, delay) => { cleanup.push({ callback, delay }); return 1; };
  try {
    const state = harness(() => response(job({ state: 'complete', filename: 'ready.mp4' })), { downloadFile: undefined });
    await state.session.start('map', FIRST, 'video');
    assert.equal(doc.body.children[0], player); assert.equal(player.src, 'existing-player');
    const frame = doc.body.children[2]; assert.equal(frame.tagName, 'iframe'); assert.equal(frame.hidden, true);
    assert.equal(frame.referrerPolicy, 'no-referrer'); assert.equal(frame.attributes.sandbox, 'allow-downloads');
    assert.equal(frame.src, `${WORKER}/files/job_1?token=${TOKEN}`);
    assert.equal(cleanup[0].delay, 60000); cleanup[0].callback(); assert.deepEqual(doc.body.children, [player, container]);
  } finally { globalThis.document = oldDocument; globalThis.setTimeout = oldTimer; }
});

test('missing configuration yields an honest disabled preview and malformed configuration throws', () => {
  const container = root(); createYouTubeDownloads(container).setVideo(video(FIRST), 'map');
  assert.match(container.textContent, /not available in this preview/);
  assert.equal(named(container, 'button', 'Download video').disabled, true);
  for (const serviceUrl of [undefined, 'http://localhost:1234', 'https://user:pass@example.com', 'https://example.com/api/jobs', 'https://example.com/?secret=foo']) {
    assert.throws(() => createHostedDownloadSession({ serviceUrl }));
  }
});
