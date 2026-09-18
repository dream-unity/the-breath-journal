import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { IDBCursor, IDBFactory, IDBIndex, IDBObjectStore } from 'fake-indexeddb';

const source = await readFile(new URL('../mindmap-core.js', import.meta.url), 'utf8');
let instance = 0;

async function setup(t) {
  const previous = globalThis.indexedDB;
  const factory = new IDBFactory();
  globalThis.indexedDB = factory;
  t.after(() => {
    if (previous === undefined) delete globalThis.indexedDB;
    else globalThis.indexedDB = previous;
  });
  const core = await import(`data:text/javascript;base64,${Buffer.from(`${source}\n// recording test ${instance++}`).toString('base64')}`);
  return { core, factory };
}

function branchedMap(core) {
  const map = core.createMap('Recorded ideas');
  map.nodes.push(
    { id: 'child', label: 'Branch', notes: '', parentId: map.nodes[0].id, x: 400, y: 100 },
    { id: 'descendant', label: 'Detail', notes: '', parentId: 'child', x: 700, y: 100 },
  );
  return map;
}

function recording(map, nodeId, id = 'recording-1') {
  return {
    id, mapId: map.id, nodeId,
    createdAt: '2026-09-18T12:00:00.000Z', durationMs: 2500,
    mimeType: 'video/webm;codecs=vp8,opus',
    blob: new Blob([`private clip ${id}`], { type: 'video/webm;codecs=vp8,opus' }),
  };
}

function openDatabase(factory, version, upgrade) {
  return new Promise((resolve, reject) => {
    const request = factory.open('dream-unity-mind-maps', version);
    request.onupgradeneeded = () => upgrade?.(request.result);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function complete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error);
  });
}

test('version 1 upgrades in place without losing existing maps, notes, or YouTube links', async (t) => {
  const { core, factory } = await setup(t);
  const legacy = branchedMap(core);
  legacy.nodes[1].notes = 'Keep these notes.';
  legacy.nodes[1].video = core.parseYouTubeUrl('https://youtu.be/M7lc1UVf-VE?t=10');
  legacy.video = core.parseYouTubeUrl('https://youtu.be/dQw4w9WgXcQ');
  const oldDatabase = await openDatabase(factory, 1, (database) => database.createObjectStore('maps', { keyPath: 'id' }));
  const write = oldDatabase.transaction('maps', 'readwrite');
  write.objectStore('maps').put(legacy);
  await complete(write);
  oldDatabase.close();

  assert.deepEqual(await core.listMaps(), [core.validateMap(legacy)]);
  const upgraded = await openDatabase(factory, 2);
  assert.equal(upgraded.version, 2);
  assert.deepEqual([...upgraded.objectStoreNames], ['maps', 'recordings']);
  const store = upgraded.transaction('recordings').objectStore('recordings');
  assert.deepEqual(store.index('idea').keyPath, ['mapId', 'nodeId']);
  assert.equal(store.index('mapId').keyPath, 'mapId');
  upgraded.close();
  await core.saveIdeaRecording(recording(legacy, 'child'));
  assert.equal((await core.listIdeaRecordings(legacy.id, 'child')).length, 1);
});

test('recordings remain isolated between ideas and between maps with identical node IDs', async (t) => {
  const { core } = await setup(t);
  const first = await core.saveMap(branchedMap(core));
  const second = await core.saveMap(core.importMap(core.serializeMap(first)));
  await core.saveIdeaRecording(recording(first, 'child', 'first-child'));
  await core.saveIdeaRecording(recording(first, 'descendant', 'first-descendant'));
  await core.saveIdeaRecording(recording(second, 'child', 'second-child'));
  const later = recording(first, 'child', 'first-child-later');
  later.createdAt = '2026-09-18T13:00:00.000Z';
  await core.saveIdeaRecording(later);

  const originalGetAll = IDBIndex.prototype.getAll;
  const queries = [];
  IDBIndex.prototype.getAll = function (query, ...args) {
    if (this.objectStore.name === 'recordings') queries.push({ index: this.name, query });
    return originalGetAll.call(this, query, ...args);
  };
  t.after(() => { IDBIndex.prototype.getAll = originalGetAll; });
  const recordings = await core.listIdeaRecordings(first.id, 'child');
  assert.deepEqual(recordings.map((entry) => entry.id), ['first-child-later', 'first-child']);
  assert.equal(await recordings[1].blob.text(), 'private clip first-child');
  assert.deepEqual(queries, [{ index: 'idea', query: [first.id, 'child'] }]);
  assert.deepEqual((await core.listIdeaRecordings(first.id, 'descendant')).map((entry) => entry.id), ['first-descendant']);
  assert.deepEqual((await core.listIdeaRecordings(second.id, 'child')).map((entry) => entry.id), ['second-child']);
  assert.deepEqual(await core.listIdeaRecordings(first.id, first.nodes[0].id), []);
  assert.deepEqual(await core.listIdeaRecordings(first.id, 'missing'), []);
  assert.deepEqual(await core.listIdeaRecordings('missing', 'child'), []);
});

test('a recording cannot be overwritten or deleted from another idea or another map', async (t) => {
  const { core } = await setup(t);
  const first = await core.saveMap(branchedMap(core));
  const second = await core.saveMap(core.importMap(core.serializeMap(first)));
  await core.saveIdeaRecording(recording(first, 'child'));
  await assert.rejects(core.saveIdeaRecording(recording(first, 'descendant')), { name: 'ConstraintError' });
  await assert.rejects(core.saveIdeaRecording(recording(second, 'child')), { name: 'ConstraintError' });
  await assert.rejects(core.deleteIdeaRecording(first.id, 'descendant', 'recording-1'), { name: 'SecurityError' });
  await assert.rejects(core.deleteIdeaRecording(second.id, 'child', 'recording-1'), { name: 'SecurityError' });
  assert.equal((await core.listIdeaRecordings(first.id, 'child')).length, 1);
  assert.equal(await core.deleteIdeaRecording(first.id, 'child', 'recording-1'), true);
  assert.equal(await core.deleteIdeaRecording(first.id, 'child', 'recording-1'), false);
  assert.deepEqual(await core.listIdeaRecordings(first.id, 'child'), []);
});

test('removing a branch prunes its recordings and descendants, while unrelated ideas survive', async (t) => {
  const { core } = await setup(t);
  const map = await core.saveMap(branchedMap(core));
  const rootId = map.nodes[0].id;
  await core.saveIdeaRecording(recording(map, rootId, 'root-clip'));
  await core.saveIdeaRecording(recording(map, 'child', 'branch-clip'));
  await core.saveIdeaRecording(recording(map, 'descendant', 'detail-clip'));
  map.nodes = [map.nodes[0]];
  await core.saveMap(map);
  assert.deepEqual((await core.listIdeaRecordings(map.id, rootId)).map((entry) => entry.id), ['root-clip']);
  assert.equal(await core.deleteIdeaRecording(map.id, 'child', 'branch-clip'), false);
  assert.equal(await core.deleteIdeaRecording(map.id, 'descendant', 'detail-clip'), false);
  await assert.rejects(core.saveIdeaRecording(recording(map, 'child', 'late-clip')), { name: 'NotFoundError' });
  assert.equal(await core.deleteIdeaRecording(map.id, 'child', 'late-clip'), false);
});

test('map deletion removes only its own recordings and rejects a concurrent late recorder save', async (t) => {
  const { core } = await setup(t);
  const first = await core.saveMap(branchedMap(core));
  const second = await core.saveMap(core.importMap(core.serializeMap(first)));
  await core.saveIdeaRecording(recording(first, 'child', 'first-clip'));
  await core.saveIdeaRecording(recording(second, 'child', 'second-clip'));
  const deleting = core.deleteMap(first.id);
  const lateSave = core.saveIdeaRecording(recording(first, 'child', 'late-clip'));
  const rejection = assert.rejects(lateSave, { name: 'NotFoundError' });
  await deleting;
  await rejection;
  assert.equal(await core.deleteIdeaRecording(first.id, 'child', 'first-clip'), false);
  assert.equal(await core.deleteIdeaRecording(first.id, 'child', 'late-clip'), false);
  assert.deepEqual((await core.listIdeaRecordings(second.id, 'child')).map((entry) => entry.id), ['second-clip']);
  assert.deepEqual((await core.listMaps()).map((entry) => entry.id), [second.id]);
});

test('a branch removed while a recorder finishes cannot acquire an orphaned recording', async (t) => {
  const { core } = await setup(t);
  const map = await core.saveMap(branchedMap(core));
  const deletion = core.saveMap({ ...map, nodes: [map.nodes[0]] });
  const lateSave = core.saveIdeaRecording(recording(map, 'child'));
  const rejection = assert.rejects(lateSave, { name: 'NotFoundError' });
  await deletion;
  await rejection;
  assert.equal(await core.deleteIdeaRecording(map.id, 'child', 'recording-1'), false);
});

test('failed branch-pruning transaction restores both the original map and its recordings', async (t) => {
  const { core } = await setup(t);
  const map = await core.saveMap(branchedMap(core));
  await core.saveIdeaRecording(recording(map, 'child'));
  const originalDelete = IDBCursor.prototype.delete;
  let deletedBeforeAbort = false;
  IDBCursor.prototype.delete = function () {
    const request = originalDelete.call(this);
    request.addEventListener('success', () => {
      deletedBeforeAbort = true;
      request.transaction.abort();
    });
    return request;
  };
  t.after(() => { IDBCursor.prototype.delete = originalDelete; });
  await assert.rejects(core.saveMap({ ...map, nodes: [map.nodes[0]] }));
  assert.equal(deletedBeforeAbort, true, 'the recording deletion must actually occur before rollback');
  assert.deepEqual((await core.listMaps())[0].nodes, map.nodes);
  assert.equal((await core.listIdeaRecordings(map.id, 'child')).length, 1);
});

test('failed map deletion restores both map and recording in the same transaction', async (t) => {
  const { core } = await setup(t);
  const map = await core.saveMap(branchedMap(core));
  await core.saveIdeaRecording(recording(map, 'child'));
  const originalDelete = IDBCursor.prototype.delete;
  IDBCursor.prototype.delete = function () {
    const request = originalDelete.call(this);
    request.addEventListener('success', () => request.transaction.abort());
    return request;
  };
  t.after(() => { IDBCursor.prototype.delete = originalDelete; });
  await assert.rejects(core.deleteMap(map.id));
  assert.equal((await core.listMaps())[0].id, map.id);
  assert.equal((await core.listIdeaRecordings(map.id, 'child')).length, 1);
});

test('recording request success cannot report success if its transaction later aborts', async (t) => {
  const { core } = await setup(t);
  const map = await core.saveMap(branchedMap(core));
  const originalAdd = IDBObjectStore.prototype.add;
  let requestSucceeded = false;
  IDBObjectStore.prototype.add = function (...args) {
    const request = originalAdd.apply(this, args);
    request.addEventListener('success', () => {
      requestSucceeded = true;
      request.transaction.abort();
    });
    return request;
  };
  t.after(() => { IDBObjectStore.prototype.add = originalAdd; });
  await assert.rejects(core.saveIdeaRecording(recording(map, 'child')));
  assert.equal(requestSucceeded, true);
  assert.deepEqual(await core.listIdeaRecordings(map.id, 'child'), []);
});

test('quota failures are exposed and do not leave a saved recording', async (t) => {
  const { core } = await setup(t);
  const map = await core.saveMap(branchedMap(core));
  const originalAdd = IDBObjectStore.prototype.add;
  IDBObjectStore.prototype.add = function (...args) {
    if (this.name === 'recordings') throw new DOMException('Storage is full.', 'QuotaExceededError');
    return originalAdd.apply(this, args);
  };
  t.after(() => { IDBObjectStore.prototype.add = originalAdd; });
  await assert.rejects(core.saveIdeaRecording(recording(map, 'child')), { name: 'QuotaExceededError' });
  assert.deepEqual(await core.listIdeaRecordings(map.id, 'child'), []);
  assert.deepEqual((await core.listMaps())[0].nodes, map.nodes);
  IDBObjectStore.prototype.add = originalAdd;
  await core.saveIdeaRecording(recording(map, 'child'));
  assert.equal((await core.listIdeaRecordings(map.id, 'child')).length, 1, 'the same retained recording can be retried');
});

test('malformed recordings and identifiers are rejected, and exports never contain binary recordings', async (t) => {
  const { core } = await setup(t);
  const map = await core.saveMap(branchedMap(core));
  for (const changes of [
    { id: '../recording' }, { mapId: '' }, { nodeId: '<script>' },
    { createdAt: 'yesterday' }, { durationMs: -1 }, { durationMs: Infinity },
    { durationMs: '2' }, { mimeType: 'text/html' }, { mimeType: 'video/webm\ntext/html' },
    { blob: null }, { blob: 'not a blob' }, { blob: new Blob() },
  ]) {
    await assert.rejects(core.saveIdeaRecording({ ...recording(map, 'child'), ...changes }));
  }
  await assert.rejects(core.listIdeaRecordings('', 'child'));
  await assert.rejects(core.deleteIdeaRecording(map.id, '<script>', 'recording-1'));
  await assert.rejects(core.saveIdeaRecording(recording({ id: 'not-saved' }, 'child')), { name: 'NotFoundError' });
  await core.saveIdeaRecording(recording(map, 'child'));
  map.recordings = [recording(map, 'child')];
  map.nodes[1].recordings = [recording(map, 'child')];
  const exported = core.serializeMap(map);
  assert.equal(exported.includes('recordings'), false);
  assert.equal(exported.includes('blob'), false);
  const imported = await core.saveMap(core.importMap(exported));
  assert.deepEqual(await core.listIdeaRecordings(imported.id, 'child'), []);
  assert.equal((await core.listIdeaRecordings(map.id, 'child')).length, 1);
});
