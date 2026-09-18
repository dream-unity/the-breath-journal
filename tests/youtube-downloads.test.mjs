import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../youtube-downloads.js', import.meta.url), 'utf8');
const { createDownloadSession, createYouTubeDownloads } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const TOKEN = 'A'.repeat(43), FIRST = 'M7lc1UVf-VE', SECOND = 'dQw4w9WgXcQ';
const video = videoId => ({ videoId, url: `https://www.youtube.com/watch?v=${videoId}&t=30s`, embedUrl: `https://www.youtube-nocookie.com/embed/${videoId}?start=30` });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const job = (extra = {}) => ({ id: 'job_1', videoId: FIRST, format: 'video', state: 'queued', message: 'Queued', ...extra });

function harness(route = () => response(job())) {
  let clock = 0, counter = 0, requests = 0;
  const calls = [], timers = new Map();
  const session = createDownloadSession({
    fetch: async (url, options) => {
      const call = { path: url.slice('http://127.0.0.1:8766'.length), ...options, body: options.body ? JSON.parse(options.body) : undefined };
      calls.push(call);
      if (call.path === '/health') return response({ version: 1, ready: true, missing: [], folder: '/home/test/Downloads/Dream Unity' });
      return route(call);
    },
    now: () => clock,
    setTimer: (callback, delay) => { const id = ++counter; timers.set(id, { callback, delay }); return id; },
    clearTimer: id => timers.delete(id), requestId: () => `request_${String(++requests).padStart(16, '0')}`,
    jobTimeout: 10000,
  });
  return { session, calls, timers,
    advance(ms) { clock += ms; },
    async poll() {
      const next = [...timers].find(([, timer]) => timer.delay === 1800);
      assert.ok(next, 'Expected a scheduled status check'); timers.delete(next[0]); next[1].callback(); await settle();
    },
  };
}

class Element {
  constructor(tagName, document) { this.tagName = tagName; this.ownerDocument = document; this.children = []; this.listeners = new Map(); this.attributes = {}; this.classList = { add: () => {} }; this.hidden = false; this.value = ''; this._text = ''; }
  set textContent(value) { this._text = value; this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; this._text = ''; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(type, listener) { const list = this.listeners.get(type) || []; list.push(listener); this.listeners.set(type, list); }
  async dispatch(type) { await Promise.all((this.listeners.get(type) || []).map(listener => listener({ preventDefault() {} }))); await settle(); }
  focus() { this.focused = true; }
}
function root() {
  const doc = { createElement: tag => new Element(tag, doc), createTextNode: text => ({ textContent: text }) };
  return new Element('section', doc);
}
function all(node) { return [node, ...(node.children || []).flatMap(all)]; }
function named(node, tag, text) { return all(node).find(element => element.tagName === tag && element.textContent === text); }

test('mounting, selecting and unpaired download gestures make no network requests or player changes', async () => {
  const state = harness(), container = root(), player = { src: 'original-player', currentTime: 124 };
  const parent = { children: [player, container] };
  const view = createYouTubeDownloads(container, { session: state.session });
  view.setVideo(video(FIRST), 'map-1');
  view.setVideo(video(SECOND), 'map-1:idea-1');
  await named(container, 'button', 'Download MP3').dispatch('click');
  assert.equal(state.calls.length, 0);
  assert.equal(all(container).find(node => node.tagName === 'details').open, true);
  assert.equal(all(container).find(node => node.tagName === 'input').focused, true);
  assert.deepEqual(parent.children, [player, container]);
  assert.deepEqual(player, { src: 'original-player', currentTime: 124 });
  view.setVideo(null, 'map-1:idea-1'); assert.equal(container.hidden, true);
  view.destroy(); assert.equal(state.calls.length, 0);
});

test('pairing is shared across players, ephemeral, and does not start an automatic download', async () => {
  const state = harness(), main = root(), branch = root();
  createYouTubeDownloads(main, { session: state.session }).setVideo(video(FIRST), 'main');
  createYouTubeDownloads(branch, { session: state.session }).setVideo(video(SECOND), 'branch');
  all(main).find(node => node.tagName === 'input').value = TOKEN;
  await all(main).find(node => node.tagName === 'form').dispatch('submit');
  assert.equal(state.calls.length, 1); assert.equal(state.calls[0].path, '/health');
  assert.equal(state.calls[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(all(main).find(node => node.tagName === 'input').value, '');
  assert.equal(main.textContent.includes(TOKEN), false);
  assert.equal(branch.textContent.includes('Desktop helper connected'), true);
  assert.equal(named(branch, 'button', 'Download video').disabled, false);
  assert.equal(state.session.snapshot('branch', SECOND).connection.state, 'ready');
});

test('a pending request captures its original owner, ID and format across branch switches', async () => {
  const pending = deferred(), state = harness(() => pending.promise), container = root();
  await state.session.connect(TOKEN);
  const view = createYouTubeDownloads(container, { session: state.session });
  view.setVideo(video(FIRST), 'branch-a');
  const start = state.session.start('branch-a', FIRST, 'mp3');
  view.setVideo(video(SECOND), 'branch-b');
  const post = state.calls.find(call => call.path === '/jobs');
  assert.deepEqual(post.body, { videoId: FIRST, format: 'mp3', clientRequestId: 'request_0000000000000001' });
  assert.equal(JSON.stringify(post.body).includes('youtube.com'), false);
  pending.resolve(response(job({ format: 'mp3', state: 'complete', filename: 'first-video.mp3' }))); await start;
  assert.equal(container.textContent.includes('first-video.mp3'), false);
  assert.equal(state.session.snapshot('branch-b', SECOND).jobs.length, 0);
  view.setVideo(video(FIRST), 'branch-a');
  assert.equal(container.textContent.includes('Saved — first-video.mp3'), true);
  assert.equal(state.session.snapshot('branch-a', FIRST).busy, false);
});

test('HTTP rejection releases the single-job gate and remains scoped to the failed idea', async () => {
  for (const status of [400, 401, 409]) {
    const state = harness(() => response({}, status)); await state.session.connect(TOKEN);
    await state.session.start('branch-a', FIRST, 'video');
    const failed = state.session.snapshot('branch-a', FIRST);
    assert.equal(failed.jobs[0].state, 'error'); assert.ok(failed.jobs[0].message);
    assert.equal(failed.busy, false); assert.equal(failed.jobs[0].uncertain, false);
    assert.deepEqual(state.session.snapshot('branch-b', FIRST).jobs, []);
  }
});

test('ambiguous POST failure retries the same request ID and prevents a duplicate download', async () => {
  let first = true;
  const state = harness(() => { if (first) { first = false; throw new TypeError('network'); } return response(job({ state: 'complete', filename: 'complete.mp4' })); });
  await state.session.connect(TOKEN); await state.session.start('branch-a', FIRST, 'video');
  assert.equal(state.session.snapshot('branch-a', FIRST).jobs[0].uncertain, true);
  assert.equal(state.session.snapshot('branch-a', FIRST).busy, true);
  await state.session.start('branch-b', SECOND, 'mp3');
  assert.equal(state.calls.filter(call => call.path === '/jobs').length, 1);
  await state.session.retry('branch-a', FIRST, 'video');
  const posts = state.calls.filter(call => call.path === '/jobs');
  assert.deepEqual(posts[0].body, posts[1].body);
  assert.equal(state.session.snapshot('branch-a', FIRST).jobs[0].filename, 'complete.mp4');
});

test('cancelling an idea rejects a late running status response and never targets another idea', async () => {
  const late = deferred();
  const state = harness(call => call.path === '/jobs' ? response(job())
    : call.method === 'DELETE' ? response(job({ state: 'cancelled' })) : late.promise);
  await state.session.connect(TOKEN); await state.session.start('branch-a', FIRST, 'video');
  await state.poll();
  await state.session.cancel('branch-b', FIRST, 'video');
  assert.equal(state.calls.some(call => call.method === 'DELETE'), false);
  await state.session.cancel('branch-a', FIRST, 'video');
  late.resolve(response(job({ state: 'running' }))); await settle();
  assert.equal(state.calls.find(call => call.method === 'DELETE').path, '/jobs/job_1');
  assert.equal(state.session.snapshot('branch-a', FIRST).jobs[0].state, 'cancelled');
  assert.equal(state.session.snapshot('branch-a', FIRST).busy, false);
  assert.equal([...state.timers.values()].some(timer => timer.delay === 1800), false);
});

test('status polling validates echoed ownership and bounds background polling', async () => {
  const state = harness(call => call.path === '/jobs' ? response(job()) : response(job({ videoId: SECOND, state: 'complete', filename: 'wrong.mp4' })));
  await state.session.connect(TOKEN); await state.session.start('branch-a', FIRST, 'video'); await state.poll();
  const wrong = state.session.snapshot('branch-a', FIRST).jobs[0];
  assert.equal(wrong.state, 'error'); assert.equal(wrong.filename, ''); assert.equal(wrong.uncertain, true);
  assert.equal([...state.timers.values()].some(timer => timer.delay === 1800), false);
  const timeout = harness(() => response(job({ state: 'running' })));
  await timeout.session.connect(TOKEN); await timeout.session.start('branch-a', FIRST, 'video'); timeout.advance(10001); await timeout.poll();
  assert.equal(timeout.session.snapshot('branch-a', FIRST).jobs[0].uncertain, true);
  assert.match(timeout.session.snapshot('branch-a', FIRST).jobs[0].message, /timed out/);
  assert.equal([...timeout.timers.values()].some(timer => timer.delay === 1800), false);
});

test('completed video and MP3 results remain separately available and folder opens only on a click', async () => {
  const state = harness(call => call.path === '/open-folder' ? response({ opened: true })
    : response(job({ id: `job_${call.body.format}`, format: call.body.format, state: 'complete', filename: `saved.${call.body.format === 'mp3' ? 'mp3' : 'mp4'}` })));
  await state.session.connect(TOKEN);
  const container = root(), view = createYouTubeDownloads(container, { session: state.session }); view.setVideo(video(FIRST), 'map');
  await state.session.start('map', FIRST, 'video'); await state.session.start('map', FIRST, 'mp3');
  assert.match(container.textContent, /saved.mp4/); assert.match(container.textContent, /saved.mp3/);
  assert.equal(state.calls.some(call => call.path === '/open-folder'), false);
  await named(container, 'button', 'Open downloads folder').dispatch('click');
  assert.deepEqual(state.calls.find(call => call.path === '/open-folder').body, {});
  view.setVideo(video(SECOND), 'map'); assert.equal(container.textContent.includes('saved.mp'), false);
  view.setVideo(video(FIRST), 'map'); assert.equal(container.textContent.includes('saved.mp3'), true);
});

test('invalid connection codes never make a request and missing prerequisites prevent downloading', async () => {
  let calls = 0;
  const session = createDownloadSession({ fetch: async () => { calls++; return response({ version: 1, ready: false, missing: ['yt-dlp', 'ffmpeg'], folder: '/downloads' }); } });
  await session.connect('too short'); assert.equal(calls, 0);
  await session.connect(TOKEN); assert.equal(calls, 1);
  assert.match(session.snapshot('map', FIRST).connection.message, /yt-dlp, ffmpeg/);
  await session.start('map', FIRST, 'mp3'); assert.equal(calls, 1);
});

test('reconnecting to a restarted helper retires the old job and rejects late responses', async () => {
  const late = deferred();
  const state = harness(call => call.path === '/jobs' ? response(job({ videoId: call.body.videoId, format: call.body.format })) : late.promise);
  await state.session.connect(TOKEN); await state.session.start('branch-a', FIRST, 'video'); await state.poll();
  await state.session.connect('B'.repeat(43));
  const previous = state.session.snapshot('branch-a', FIRST);
  assert.equal(previous.busy, false); assert.equal(previous.jobs[0].uncertain, false);
  assert.match(previous.jobs[0].message, /helper restarted/);
  late.resolve(response(job({ state: 'complete', filename: 'outdated.mp4' }))); await settle();
  assert.equal(state.session.snapshot('branch-a', FIRST).jobs[0].filename, '');
  const before = state.calls.length;
  await state.session.retry('branch-a', FIRST, 'video'); await state.session.cancel('branch-a', FIRST, 'video');
  assert.equal(state.calls.length, before);
  await state.session.start('branch-b', SECOND, 'mp3');
  const last = state.calls.at(-1);
  assert.equal(last.body.videoId, SECOND); assert.equal(last.headers.Authorization, `Bearer ${'B'.repeat(43)}`);
});

test('a missing helper job releases the gate and polling preserves focused action elements', async () => {
  let missing = false;
  const state = harness(call => call.path === '/jobs' ? response(job()) : missing ? response({ error: 'Download not found.' }, 404) : response(job({ state: 'running' })));
  await state.session.connect(TOKEN);
  const container = root(); createYouTubeDownloads(container, { session: state.session }).setVideo(video(FIRST), 'map');
  await state.session.start('map', FIRST, 'video');
  const cancelButton = named(container, 'button', 'Cancel Video download'); cancelButton.focus();
  await state.poll();
  assert.equal(named(container, 'button', 'Cancel Video download'), cancelButton); assert.equal(cancelButton.focused, true);
  missing = true; await state.poll();
  assert.equal(state.session.snapshot('map', FIRST).busy, false);
  assert.equal(state.session.snapshot('map', FIRST).jobs[0].uncertain, false);
  assert.match(state.session.snapshot('map', FIRST).jobs[0].message, /Download not found/);
});
