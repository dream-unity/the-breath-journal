import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Load the browser ES module without changing this static site's package configuration.
const source = await readFile(new URL('../mindmap-core.js', import.meta.url), 'utf8');
let moduleCount = 0;
const loadCore = () => import(`data:text/javascript;base64,${Buffer.from(`${source}\n// instance ${moduleCount++}`).toString('base64')}`);
const core = await loadCore();
const videoId = 'dQw4w9WgXcQ';

test('YouTube links normalize to a trusted video and preserve supported timestamps', () => {
  const cases = [
    [`https://www.youtube.com/watch?v=${videoId}&t=95`, 95],
    [`https://youtube.com/watch?v=${videoId}&t=1h2m3s`, 3723],
    [`https://m.youtube.com/watch?v=${videoId}&start=60`, 60],
    [`https://music.youtube.com/watch?v=${videoId}`, 0],
    [`https://youtu.be/${videoId}?si=share&t=2m`, 120],
    [`youtu.be/${videoId}`, 0],
    [`https://www.youtube.com/shorts/${videoId}`, 0],
    [`https://www.youtube.com/live/${videoId}?t=30s`, 30],
    [`https://www.youtube.com/embed/${videoId}?start=90`, 90],
    [`https://www.youtube-nocookie.com/embed/${videoId}?start=1`, 1],
    [`https://youtube-nocookie.com/embed/${videoId}/`, 0],
    [`http://www.youtube.com/watch?v=${videoId}#t=2m3s`, 123],
  ];
  for (const [url, seconds] of cases) {
    const result = core.parseYouTubeUrl(url);
    assert.equal(result.videoId, videoId, url);
    assert.equal(result.startSeconds, seconds, url);
    assert.equal(new URL(result.url).origin, 'https://www.youtube.com');
    assert.equal(new URL(result.embedUrl).origin, 'https://www.youtube-nocookie.com');
    assert.equal(new URL(result.embedUrl).searchParams.get('playsinline'), '1');
    assert.equal(core.parseYouTubeUrl(result.url).startSeconds, seconds);
  }
});

test('YouTube parser rejects spoofed hosts, active URLs, credentials, and invalid video IDs', () => {
  const badLinks = [
    '', null, {},
    `https://youtube.com.evil.test/watch?v=${videoId}`,
    `https://notyoutube.com/watch?v=${videoId}`,
    `https://youtube.com@evil.test/watch?v=${videoId}`,
    `https://evil.test@youtube.com/watch?v=${videoId}`,
    `https://user:password@www.youtube.com/watch?v=${videoId}`,
    `javascript:alert(1)`,
    `data:text/html,<iframe src=https://youtube.com/watch?v=${videoId}>`,
    `ftp://www.youtube.com/watch?v=${videoId}`,
    `https://www.youtube.com:8000/watch?v=${videoId}`,
    `https://www.youtube.com/playlist?list=${videoId}`,
    `https://www.youtube-nocookie.com/watch?v=${videoId}`,
    `https://youtu.be/${videoId}/other`,
    `https://www.youtube.com/watch?v=short`,
    `https://www.youtube.com/watch?v=${videoId}x`,
    `https://www.youtube.com/watch?v=${videoId}&t=-1`,
    `https://www.youtube.com/watch?v=${videoId}&t=1.5`,
    `https://www.youtube.com/watch?v=${videoId}&t=0x10`,
    `https://www.youtube.com/watch?v=${videoId}&t=1m2h`,
    `https://www.youtube.com/watch?v=${videoId}&t=99999999999999999999`,
    `https:\\www.youtube.com\\watch?v=${videoId}`,
  ];
  for (const url of badLinks) assert.throws(() => core.parseYouTubeUrl(url), Error, String(url));
});

function branchedMap() {
  const map = core.createMap('A video worth understanding');
  map.nodes.push(
    { id: 'child-a', label: 'Claim', notes: 'Test the evidence.', video: null, parentId: map.nodes[0].id, x: 400, y: 120 },
    { id: 'child-b', label: 'Evidence', notes: '', video: null, parentId: 'child-a', x: 700, y: 120 },
  );
  return map;
}

test('map creation and validation produce an independent, whitelisted data tree', () => {
  const first = branchedMap();
  const second = core.createMap();
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.nodes[0].id, second.nodes[0].id);
  assert.equal(second.title, 'Untitled mind map');
  first.video = { url: `https://youtu.be/${videoId}?t=62`, embedUrl: 'javascript:alert(1)' };
  first.unsupported = { private: true };
  first.nodes[0].unsupported = 'ignore';
  const valid = core.validateMap(first);
  assert.equal(valid.video.embedUrl, `https://www.youtube-nocookie.com/embed/${videoId}?rel=0&playsinline=1&start=62`);
  assert.equal('unsupported' in valid, false);
  assert.equal('unsupported' in valid.nodes[0], false);
  valid.nodes[1].label = 'Changed';
  assert.equal(first.nodes[1].label, 'Claim');
  assert.deepEqual(Object.keys(valid).sort(), ['createdAt', 'id', 'nodes', 'title', 'updatedAt', 'video']);
});

test('map validation rejects malformed trees including disconnected parent cycles', () => {
  const mutations = [
    (map) => { map.nodes = []; },
    (map) => { map.nodes[1].id = map.nodes[0].id; },
    (map) => { map.nodes[1].parentId = 'missing-parent'; },
    (map) => { map.nodes[0].parentId = 'child-a'; },
    (map) => { map.nodes[1].parentId = null; },
    (map) => { map.nodes[1].parentId = 'child-b'; },
    (map) => { map.nodes[1].parentId = 'child-a'; },
    (map) => { delete map.nodes[0].parentId; },
  ];
  for (const mutate of mutations) {
    const map = branchedMap();
    mutate(map);
    assert.throws(() => core.validateMap(map), Error);
  }
});

test('map validation rejects oversized or malformed data before it reaches storage', () => {
  const mutations = [
    (map) => { map.title = 'x'.repeat(161); },
    (map) => { map.nodes[0].label = 'x'.repeat(201); },
    (map) => { map.nodes[0].notes = 'x'.repeat(12_001); },
    (map) => { map.nodes[0].x = NaN; },
    (map) => { map.nodes[0].y = Infinity; },
    (map) => { map.nodes[0].x = 10_001; },
    (map) => { map.nodes[0].x = -1; },
    (map) => { map.nodes[0].x = '40'; },
    (map) => { map.id = '<script>'; },
    (map) => { map.createdAt = 'not a date'; },
    (map) => { map.video = { url: 'https://evil.test/video' }; },
    (map) => { map.video = `https://youtu.be/${videoId}`; },
    (map) => {
      for (let i = 0; i < 500; i++) map.nodes.push({ ...map.nodes[0], id: `extra-${i}`, parentId: map.nodes[0].id });
    },
  ];
  for (const mutate of mutations) {
    const map = core.createMap();
    mutate(map);
    assert.throws(() => core.validateMap(map), Error);
  }
});

test('temporarily empty titles and labels normalize without blocking autosave', () => {
  const map = core.createMap('   ');
  assert.equal(map.title, 'Untitled mind map');
  map.title = '';
  map.nodes[0].label = '   ';
  const valid = core.validateMap(map);
  assert.equal(valid.title, 'Untitled mind map');
  assert.equal(valid.nodes[0].label, 'Untitled idea');
  assert.equal(core.importMap(core.serializeMap(map)).nodes[0].label, 'Untitled idea');
});

test('export/import preserves content while always creating a fresh saved-map identity', () => {
  const original = branchedMap();
  original.createdAt = '2020-01-01T00:00:00.000Z';
  original.updatedAt = '2021-01-01T00:00:00.000Z';
  original.video = core.parseYouTubeUrl(`https://youtu.be/${videoId}?t=3m`);
  const exported = core.serializeMap(original);
  assert.equal(JSON.parse(exported).version, 1);
  const first = core.importMap(exported);
  const second = core.importMap(exported);
  assert.notEqual(first.id, original.id);
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.createdAt, original.createdAt);
  assert.equal(first.createdAt, first.updatedAt);
  assert.deepEqual(first.nodes, original.nodes);
  assert.deepEqual(first.video, original.video);
  assert.equal(first.title, original.title);
  for (const value of ['bad json', '{}', '{"version":2}', 'null', 'x'.repeat(8_000_001)]) {
    assert.throws(() => core.importMap(value), Error);
  }
});

test('each idea keeps its own video and timestamp through export and import', () => {
  const original = branchedMap();
  original.video = core.parseYouTubeUrl(`https://youtu.be/${videoId}?t=3m`);
  original.nodes[0].video = core.parseYouTubeUrl(`https://youtu.be/${videoId}?t=12s`);
  original.nodes[1].video = core.parseYouTubeUrl('https://www.youtube.com/watch?v=M7lc1UVf-VE&t=1m30s');
  original.nodes[2].video = core.parseYouTubeUrl(`https://youtu.be/${videoId}?t=2m`);
  const imported = core.importMap(core.serializeMap(original));
  assert.deepEqual(imported.nodes, original.nodes);
  assert.deepEqual(imported.video, original.video);

  imported.nodes[1].video = null;
  imported.nodes[2].video.startSeconds = 500;
  assert.equal(original.nodes[1].video.videoId, 'M7lc1UVf-VE');
  assert.equal(original.nodes[2].video.startSeconds, 120);
  assert.equal(imported.nodes[0].video.startSeconds, 12);
  assert.equal(imported.video.startSeconds, 180);
  const reimported = core.importMap(core.serializeMap(imported));
  assert.equal(reimported.nodes[1].video, null);
  assert.equal(reimported.nodes[2].video.startSeconds, 120, 'the trusted URL determines the timestamp');
});

test('legacy maps without idea videos load and import with existing map video intact', () => {
  const legacy = branchedMap();
  legacy.video = core.parseYouTubeUrl(`https://youtu.be/${videoId}?t=3m`);
  legacy.nodes.forEach((node) => { delete node.video; });
  const validated = core.validateMap(legacy);
  const imported = core.importMap(JSON.stringify({ version: 1, map: legacy }));
  for (const map of [validated, imported]) {
    assert.deepEqual(map.nodes.map((node) => node.video), [null, null, null]);
    assert.deepEqual(map.video, legacy.video);
    assert.equal(map.nodes[1].notes, 'Test the evidence.');
    assert.equal(map.nodes[2].parentId, 'child-a');
  }
  assert.equal('video' in legacy.nodes[0], false, 'normalizing must not mutate the legacy record');
});

test('idea videos rebuild safe player URLs and reject malformed or malicious links', () => {
  const map = branchedMap();
  map.nodes[1].video = {
    url: 'https://youtu.be/M7lc1UVf-VE?t=1m30s',
    videoId: '<script>alert(1)</script>',
    embedUrl: 'javascript:alert(1)',
    startSeconds: -1,
    unsupported: '<iframe src="https://evil.test"></iframe>',
  };
  const valid = core.validateMap(map);
  assert.deepEqual(valid.nodes[1].video, core.parseYouTubeUrl('https://youtu.be/M7lc1UVf-VE?t=90s'));
  assert.equal(valid.nodes[0].video, null);
  assert.equal(valid.nodes[2].video, null);
  assert.equal(valid.video, null);

  for (const invalid of [
    `https://youtu.be/${videoId}`, [], false, 3, {}, { url: null },
    { url: 'javascript:alert(1)' },
    { url: `https://youtube.com.evil.test/watch?v=${videoId}` },
    { url: `https://evil.test@youtube.com/watch?v=${videoId}` },
    { url: `https://youtu.be/${videoId}?t=-1` },
    { url: 'https://youtu.be/short' },
  ]) {
    map.nodes[1].video = invalid;
    assert.throws(() => core.validateMap(map), Error);
    assert.throws(() => core.serializeMap(map), Error);
    assert.throws(() => core.importMap(JSON.stringify({ version: 1, map })), Error);
  }
});

function installDatabaseHarness(t) {
  const original = globalThis.indexedDB;
  const transactions = [];
  const databases = [];
  let openCount = 0;
  globalThis.indexedDB = {
    open(name, version) {
      assert.equal(name, 'dream-unity-mind-maps');
      assert.equal(version, 1);
      openCount++;
      const request = {};
      const database = {
        closeCount: 0,
        close() { this.closeCount++; },
        transaction(store, mode) {
          assert.equal(store, 'maps');
          const transaction = {
            mode,
            request: {},
            objectStore() {
              return {
                put(map) { transaction.writtenMap = map; return transaction.request; },
                getAll() { return transaction.request; },
                delete(id) { transaction.deletedId = id; return transaction.request; },
              };
            },
            abort() { queueMicrotask(() => this.onabort?.()); },
          };
          transactions.push(transaction);
          return transaction;
        },
      };
      databases.push(database);
      queueMicrotask(() => { request.result = database; request.onsuccess?.(); });
      return request;
    },
  };
  t.after(() => {
    if (original === undefined) delete globalThis.indexedDB;
    else globalThis.indexedDB = original;
  });
  return { transactions, databases, get openCount() { return openCount; } };
}

const turn = () => new Promise((resolve) => setImmediate(resolve));

test('saving waits for the transaction commit and exposes quota failures', async (t) => {
  const harness = installDatabaseHarness(t);
  const isolated = await loadCore();
  const map = isolated.createMap('Commit matters');
  let settled = false;
  const saved = isolated.saveMap(map).then((value) => { settled = true; return value; });
  await turn();
  const first = harness.transactions[0];
  assert.equal(first.mode, 'readwrite');
  first.request.result = map.id;
  first.request.onsuccess();
  await turn();
  assert.equal(settled, false, 'request success must not report the map as saved');
  first.oncomplete();
  assert.equal((await saved).id, map.id);
  assert.notEqual(first.writtenMap, map, 'storage receives a validated clone');

  const rejected = assert.rejects(isolated.saveMap(map), { name: 'QuotaExceededError' });
  await turn();
  const second = harness.transactions[1];
  second.request.error = new DOMException('Storage is full.', 'QuotaExceededError');
  second.request.onerror();
  second.onabort();
  await rejected;
});

test('listing sorts saved maps, deletion commits, and version changes reopen the connection', async (t) => {
  const harness = installDatabaseHarness(t);
  const isolated = await loadCore();
  const old = isolated.createMap('Older');
  old.updatedAt = '2020-01-01T00:00:00.000Z';
  const recent = isolated.createMap('Recent');
  const listed = isolated.listMaps();
  await turn();
  harness.transactions[0].request.result = [old, recent];
  harness.transactions[0].request.onsuccess();
  harness.transactions[0].oncomplete();
  assert.deepEqual((await listed).map((map) => map.title), ['Recent', 'Older']);

  harness.databases[0].onversionchange();
  assert.equal(harness.databases[0].closeCount, 1);
  let deleted = false;
  const deletion = isolated.deleteMap(old.id).then(() => { deleted = true; });
  await turn();
  assert.equal(harness.openCount, 2);
  assert.equal(harness.transactions[1].deletedId, old.id);
  harness.transactions[1].request.onsuccess();
  await turn();
  assert.equal(deleted, false);
  harness.transactions[1].oncomplete();
  await deletion;
});

test('saving and listing preserve independent idea videos and normalize legacy records', async (t) => {
  const harness = installDatabaseHarness(t);
  const isolated = await loadCore();
  const map = branchedMap();
  map.video = isolated.parseYouTubeUrl(`https://youtu.be/${videoId}?t=3m`);
  map.nodes[1].video = isolated.parseYouTubeUrl('https://youtu.be/M7lc1UVf-VE?t=45s');
  map.nodes[2].video = isolated.parseYouTubeUrl(`https://youtu.be/${videoId}?t=90s`);
  const pendingSave = isolated.saveMap(map);
  await turn();
  const write = harness.transactions[0];
  assert.deepEqual(write.writtenMap.nodes, map.nodes);
  assert.notEqual(write.writtenMap.nodes[1].video, map.nodes[1].video);
  write.request.result = map.id;
  write.request.onsuccess();
  write.oncomplete();
  const saved = await pendingSave;
  assert.deepEqual(saved.nodes, map.nodes);
  assert.deepEqual(saved.video, map.video);

  const legacy = isolated.createMap('Legacy');
  legacy.video = isolated.parseYouTubeUrl(`https://youtu.be/${videoId}?t=1m`);
  delete legacy.nodes[0].video;
  const pendingList = isolated.listMaps();
  await turn();
  const read = harness.transactions[1];
  read.request.result = [write.writtenMap, legacy];
  read.request.onsuccess();
  read.oncomplete();
  const maps = await pendingList;
  const restored = maps.find((entry) => entry.id === map.id);
  assert.deepEqual(restored.nodes, map.nodes);
  assert.deepEqual(restored.video, map.video);
  assert.equal(maps.find((entry) => entry.id === legacy.id).nodes[0].video, null);
  assert.deepEqual(maps.find((entry) => entry.id === legacy.id).video, legacy.video);

  map.nodes[1].video = { url: 'javascript:alert(1)' };
  await assert.rejects(isolated.saveMap(map), Error);
  assert.equal(harness.transactions.length, 2, 'malformed videos must not reach storage');
});

test('unavailable browser storage rejects without pretending the map was saved', async (t) => {
  const original = globalThis.indexedDB;
  delete globalThis.indexedDB;
  t.after(() => { if (original !== undefined) globalThis.indexedDB = original; });
  const isolated = await loadCore();
  await assert.rejects(isolated.saveMap(isolated.createMap()), /storage is unavailable/i);
});
