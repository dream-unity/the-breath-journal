import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (await readFile(new URL('../idea-recorder.js', import.meta.url), 'utf8'))
  .replace(/^import .*?;\n/, 'const saveIdeaRecording = null, listIdeaRecordings = null, deleteIdeaRecording = null;\n');
const { createIdeaRecorder } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const a = { mapId: 'map-one', nodeId: 'idea-a', label: 'First idea' };
const b = { mapId: 'map-one', nodeId: 'idea-b', label: 'Second idea' };

class Events {
  listeners = new Map();
  addEventListener(name, fn, options = {}) { const entries = this.listeners.get(name) || []; entries.push({ fn, once: options.once }); this.listeners.set(name, entries); }
  removeEventListener(name, fn) { this.listeners.set(name, (this.listeners.get(name) || []).filter(entry => entry.fn !== fn)); }
  emit(name, event = {}) { return Promise.all((this.listeners.get(name) || []).slice().map(entry => { if (entry.once) this.removeEventListener(name, entry.fn); return entry.fn(event); })); }
}
class Element extends Events {
  constructor(tag = 'div') {
    super(); this.tagName = tag; this.children = []; this.attributes = {}; this.hidden = false; this.disabled = false; this.textContent = '';
    this.paused = true; this.currentTime = 0; this.pauseCount = 0; this.loadCount = 0; this.sourceChanges = 0; this.disconnections = 0; this.parentNode = null;
  }
  set src(value) { this.source = value; this.currentTime = 0; this.sourceChanges++; }
  get src() { return this.source; }
  append(child) { this.insertBefore(child, null); }
  insertBefore(child, next) {
    child.remove();
    const index = next ? this.children.indexOf(next) : this.children.length;
    if (index < 0) throw new Error('Insertion reference is not a child');
    this.children.splice(index, 0, child); child.parentNode = this;
  }
  disconnect() { this.disconnections++; for (const child of this.children) child.disconnect(); }
  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.children;
    siblings.splice(siblings.indexOf(this), 1); this.parentNode = null; this.disconnect();
  }
  replaceChildren(...children) { for (const child of [...this.children]) child.remove(); for (const child of children) this.append(child); }
  querySelectorAll(tag) { return this.children.flatMap(child => [...(child.tagName === tag ? [child] : []), ...child.querySelectorAll(tag)]); }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; if (key === 'src') this.src = ''; }
  pause() { this.paused = true; this.pauseCount++; }
  play() { this.paused = false; return Promise.resolve(); }
  load() { this.loaded = true; this.currentTime = 0; this.paused = true; this.loadCount++; }
  click() { return this.disabled || this.hidden ? Promise.resolve() : this.emit('click'); }
}

class Track extends Events { stopped = false; stop() { this.stopped = true; } }
const newStream = () => { const tracks = [new Track(), new Track()]; return { getTracks: () => tracks }; };
function harness(overrides = {}) {
  const elements = Object.fromEntries(['label', 'preview', 'enable', 'start', 'stop', 'close', 'status', 'timer', 'list'].map(name => [name, new Element(name === 'preview' ? 'video' : 'div')]));
  const root = new Element();
  root.ownerDocument = { createElement: tag => new Element(tag) };
  root.querySelector = selector => elements[/data-recorder-(.+)\]/.exec(selector)[1]];
  const calls = { saved: [], deleted: [], acquired: [], created: [], revoked: [], recorders: [] };
  let tick = 1000, id = 0;
  const lifecycle = new Events();
  class Recorder extends Events {
    static isTypeSupported(type) { return type === 'video/webm'; }
    constructor(stream, options = {}) { super(); this.stream = stream; this.state = 'inactive'; this.mimeType = options.mimeType || 'video/webm'; calls.recorders.push(this); }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; if (overrides.deferStop) return; queueMicrotask(() => this.finish()); }
    finish() { void this.emit('dataavailable', { data: new Blob(['captured-video'], { type: this.mimeType }) }); void this.emit('stop'); }
  }
  const stored = [];
  const storage = {
    listIdeaRecordings: async (mapId, nodeId) => stored.filter(record => record.mapId === mapId && record.nodeId === nodeId),
    saveIdeaRecording: async record => { calls.saved.push(record); stored.push(record); return record; },
    deleteIdeaRecording: async (mapId, nodeId, recordId) => {
      calls.deleted.push([mapId, nodeId, recordId]);
      const index = stored.findIndex(record => record.mapId === mapId && record.nodeId === nodeId && record.id === recordId);
      if (index >= 0) stored.splice(index, 1);
    },
    ...overrides.storage,
  };
  const options = {
    root, storage, Recorder, lifecycle,
    prepare: overrides.prepare || (async () => {}),
    mediaDevices: overrides.mediaDevices || { getUserMedia: async () => { const stream = newStream(); calls.acquired.push(stream); return stream; } },
    urls: { createObjectURL: () => { const url = `blob:test-${++id}`; calls.created.push(url); return url; }, revokeObjectURL: url => calls.revoked.push(url) },
    now: () => tick += 1000, makeId: () => `recording-${++id}`,
    schedule: () => 1, unschedule: () => {}, confirm: () => true,
  };
  const controller = createIdeaRecorder(options);
  return { controller, elements, calls, root, storage, stored, lifecycle, options };
}
async function record(h, owner = a) { h.controller.setIdea(owner); await settle(); await h.elements.enable.click(); await h.elements.start.click(); }
const cardButtons = h => h.elements.list.querySelectorAll('button').filter(button => !button.hidden);
const cardVideos = h => h.elements.list.querySelectorAll('video');

// These tests exercise ownership races, resource cleanup, and recovery rather than CSS/markup.
test('recording and playback stay attached to the captured idea; switching revokes access immediately', async () => {
  const h = harness();
  await record(h);
  assert.equal(h.controller.hasUnfinished(), true);
  await h.elements.stop.click(); await settle();
  assert.equal(h.calls.saved.length, 1);
  assert.equal(h.calls.saved[0].nodeId, a.nodeId);
  assert.equal(h.calls.saved[0].mapId, a.mapId);
  assert.equal(h.calls.saved[0].blob.size > 0, true);
  assert.equal(h.controller.hasUnfinished(), false);
  const oldVideo = cardVideos(h)[0];
  assert.equal(oldVideo.disablePictureInPicture, true);
  assert.equal(oldVideo.disableRemotePlayback, true);
  h.controller.setIdea(b);
  assert.equal(cardVideos(h).length, 0);
  assert.equal(oldVideo.paused, true);
  assert.equal(oldVideo.src, '');
  assert.equal(h.calls.created.every(url => h.calls.revoked.includes(url)), true);
  await settle();
  assert.equal(cardVideos(h).length, 0);
  h.controller.setIdea(a); await settle();
  assert.equal(cardVideos(h).length, 1);
});

test('late permission approval after switching never opens a camera on another idea', async () => {
  const permission = deferred();
  const h = harness({ mediaDevices: { getUserMedia: () => permission.promise } });
  h.controller.setIdea(a); await settle();
  const request = h.elements.enable.click(); await settle();
  h.controller.setIdea(b);
  const stream = newStream(); permission.resolve(stream); await request;
  assert.equal(stream.getTracks().every(track => track.stopped), true);
  assert.equal(h.elements.preview.srcObject, null);
  assert.equal(h.elements.preview.hidden, true);
  assert.equal(h.elements.start.disabled, true);
});

test('switching during recording captures the old owner even when final data arrives on the new idea', async () => {
  const h = harness({ deferStop: true });
  await record(h);
  h.controller.setIdea(b);
  assert.equal(h.calls.acquired[0].getTracks().every(track => track.stopped), true);
  assert.equal(cardVideos(h).length, 0);
  h.calls.recorders[0].finish(); await settle();
  assert.equal(h.calls.saved[0].nodeId, a.nodeId);
  assert.equal(cardVideos(h).length, 0);
  assert.equal(h.controller.hasUnfinished(), false);
});

test('a stale recording list cannot paint into the newly selected idea', async () => {
  const list = deferred();
  const h = harness({ storage: { listIdeaRecordings: (mapId, nodeId) => nodeId === a.nodeId ? list.promise : Promise.resolve([]) } });
  h.controller.setIdea(a);
  h.controller.setIdea(b); await settle();
  list.resolve([{ ...a, id: 'saved-a', createdAt: new Date().toISOString(), durationMs: 1000, mimeType: 'video/webm', blob: new Blob(['video']) }]); await settle();
  assert.equal(cardVideos(h).length, 0);
  assert.equal(h.calls.created.length, 0);
});

test('save failures retain recoverable bytes only under their original idea, including retry', async () => {
  let failing = true;
  const h = harness({ storage: { saveIdeaRecording: async record => { if (failing) throw Object.assign(new Error('Full'), { name: 'QuotaExceededError' }); return record; } } });
  await record(h); await h.elements.stop.click(); await settle();
  assert.equal(h.controller.hasUnfinished(), true);
  assert.equal(cardButtons(h).some(button => button.textContent === 'Retry save'), true);
  assert.match(h.elements.status.textContent, /out of storage/);
  h.controller.setIdea(b); await settle();
  assert.equal(cardVideos(h).length, 0);
  h.controller.setIdea(a); await settle();
  assert.equal(cardVideos(h).length, 1);
  failing = false;
  await cardButtons(h).find(button => button.textContent === 'Retry save').click(); await settle();
  assert.equal(h.controller.hasUnfinished(), false);
  assert.equal(cardButtons(h).some(button => button.textContent === 'Retry save'), false);
});

test('same-idea updates preserve camera state and do not reload recordings', async () => {
  const h = harness();
  await record(h);
  const preview = h.elements.preview.srcObject;
  h.controller.setIdea({ ...a, label: 'Renamed idea' });
  assert.equal(h.elements.preview.srcObject, preview);
  assert.equal(preview.getTracks().some(track => track.stopped), false);
  assert.equal(h.elements.label.textContent, 'Renamed idea');
  assert.equal(h.calls.recorders[0].state, 'recording');
  h.controller.dispose(); await settle();
});

test('recorder errors wait for final queued data after the recorder becomes inactive', async () => {
  const h = harness({ deferStop: true });
  await record(h);
  const recorder = h.calls.recorders[0];
  recorder.state = 'inactive';
  await recorder.emit('error');
  assert.equal(h.calls.saved.length, 0);
  recorder.finish(); await settle();
  assert.equal(h.calls.saved.length, 1);
  assert.equal(await h.calls.saved[0].blob.text(), 'captured-video');
});

test('intentional idea deletion discards an active recording and failed retry bytes', async () => {
  const h = harness({ deferStop: true });
  await record(h);
  h.controller.discardIdeas(a.mapId, [a.nodeId]);
  h.calls.recorders[0].finish(); await settle();
  assert.equal(h.calls.saved.length, 0);
  assert.equal(h.controller.hasUnfinished(), false);
  const failed = harness({ storage: { saveIdeaRecording: async () => { throw new Error('Full'); } } });
  await record(failed); await failed.elements.stop.click(); await settle();
  assert.equal(failed.controller.hasUnfinished(), true);
  failed.controller.discardIdeas(a.mapId);
  assert.equal(failed.controller.hasUnfinished(), false);
  assert.equal(cardVideos(failed).length, 0);
});

test('turning off the camera cancels an outstanding permission request safely', async () => {
  const permission = deferred();
  const h = harness({ mediaDevices: { getUserMedia: () => permission.promise } });
  h.controller.setIdea(a); await settle();
  const request = h.elements.enable.click(); await settle();
  await h.elements.close.click();
  const stream = newStream(); permission.resolve(stream); await request;
  assert.equal(stream.getTracks().every(track => track.stopped), true);
  assert.equal(h.elements.preview.srcObject, null);
});

test('pagehide stops camera tracks and clears all playback URLs synchronously', async () => {
  const h = harness();
  await record(h); await h.elements.stop.click(); await settle();
  await h.elements.enable.click();
  void h.lifecycle.emit('pagehide');
  assert.equal(h.calls.acquired.every(stream => stream.getTracks().every(track => track.stopped)), true);
  assert.equal(h.calls.created.every(url => h.calls.revoked.includes(url)), true);
  assert.equal(cardVideos(h).length, 0);
  assert.equal(h.elements.preview.srcObject, null);
});


const savedRecording = (id, createdAt = '2026-09-18T12:00:00.000Z') => ({
  ...a, id, createdAt, durationMs: 90000, mimeType: 'video/webm', blob: new Blob(['saved-video'], { type: 'video/webm' }),
});
const playbackSnapshot = video => ({
  src: video.src, currentTime: video.currentTime, paused: video.paused,
  sourceChanges: video.sourceChanges, pauseCount: video.pauseCount, loadCount: video.loadCount, disconnections: video.disconnections,
});

// Background playback depends on retaining the same connected media element and source.
test('saving another recording and refreshing cloned stored records preserves playing video and playhead', async () => {
  const save = deferred(), refresh = deferred();
  let listReads = 0;
  const existing = savedRecording('existing');
  const h = harness({ storage: {
    listIdeaRecordings: async () => ++listReads === 1 ? [existing] : refresh.promise,
    saveIdeaRecording: record => { h.calls.saved.push(record); return save.promise; },
  } });
  await record(h);
  const playing = cardVideos(h)[0];
  await playing.play(); playing.currentTime = 37.25;
  const before = playbackSnapshot(playing);
  await h.elements.stop.click(); await settle();
  assert.equal(cardVideos(h).includes(playing), true);
  assert.deepEqual(playbackSnapshot(playing), before, 'creating the pending card must leave existing playback untouched');
  const pendingVideo = cardVideos(h).find(video => video !== playing);
  await pendingVideo.play(); pendingVideo.currentTime = 1.5;
  const pendingBefore = playbackSnapshot(pendingVideo);
  save.resolve(h.calls.saved[0]); await settle();
  assert.deepEqual(playbackSnapshot(playing), before, 'save completion must not reset another recording');
  assert.deepEqual(playbackSnapshot(pendingVideo), pendingBefore, 'saving the playing recording must retain its pending player');
  refresh.resolve([structuredClone(existing), structuredClone(h.calls.saved[0])]); await settle();
  assert.equal(cardVideos(h).includes(playing), true);
  assert.equal(cardVideos(h).includes(pendingVideo), true);
  assert.deepEqual(playbackSnapshot(playing), before, 'IndexedDB clones must reuse the same video element and URL');
  assert.deepEqual(playbackSnapshot(pendingVideo), pendingBefore);
  assert.equal(h.calls.created.length, 2);
  assert.equal(h.calls.revoked.length, 0);
});

test('deleting one recording releases only its player while another keeps playing', async () => {
  const h = harness();
  h.stored.push(savedRecording('keep-playing'), savedRecording('delete-me', '2026-09-17T12:00:00.000Z'));
  h.controller.setIdea(a); await settle();
  const [playing, removed] = cardVideos(h);
  await playing.play(); playing.currentTime = 19.5;
  const before = playbackSnapshot(playing), removedUrl = removed.src;
  const deleteButton = removed.parentNode.querySelectorAll('button').find(button => button.textContent === 'Delete recording');
  await deleteButton.click(); await settle();
  assert.deepEqual(cardVideos(h), [playing]);
  assert.deepEqual(playbackSnapshot(playing), before);
  assert.equal(removed.paused, true);
  assert.equal(removed.src, '');
  assert.deepEqual(h.calls.revoked, [removedUrl]);
});

test('retrying a failed save updates status without restarting its playing recording', async () => {
  let failing = true;
  const h = harness({ storage: { saveIdeaRecording: async record => {
    if (failing) throw new Error('Temporary failure');
    h.stored.push(structuredClone(record));
    return structuredClone(record);
  } } });
  await record(h); await h.elements.stop.click(); await settle();
  const playing = cardVideos(h)[0];
  await playing.play(); playing.currentTime = 3.25;
  const before = playbackSnapshot(playing);
  failing = false;
  await cardButtons(h).find(button => button.textContent === 'Retry save').click(); await settle();
  assert.deepEqual(cardVideos(h), [playing]);
  assert.deepEqual(playbackSnapshot(playing), before);
  assert.equal(cardButtons(h).some(button => button.textContent === 'Retry save'), false);
  assert.equal(h.calls.revoked.length, 0);
});

test('switching browser tabs or focus does not pause, reset or unmount current-idea playback', async () => {
  const h = harness();
  h.stored.push(savedRecording('background'));
  h.controller.setIdea(a); await settle();
  const playing = cardVideos(h)[0];
  await playing.play(); playing.currentTime = 12.75;
  const before = playbackSnapshot(playing);
  await h.lifecycle.emit('blur');
  await h.lifecycle.emit('visibilitychange', { visibilityState: 'hidden' });
  h.controller.setIdea({ ...a, label: 'Renamed while playing' });
  await h.lifecycle.emit('visibilitychange', { visibilityState: 'visible' });
  await h.lifecycle.emit('focus');
  assert.deepEqual(cardVideos(h), [playing]);
  assert.deepEqual(playbackSnapshot(playing), before);
  assert.equal(h.calls.revoked.length, 0);
  // Scope privacy still applies even when another map reuses the same node ID.
  h.controller.setIdea({ ...a, mapId: 'another-map' });
  assert.equal(cardVideos(h).length, 0);
  assert.equal(playing.paused, true);
  assert.equal(playing.src, '');
  assert.equal(h.calls.revoked.includes(before.src), true);
});
