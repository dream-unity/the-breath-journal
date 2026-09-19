import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { IDBFactory } from 'fake-indexeddb';

const source = await readFile(new URL('../mindmap-library.js', import.meta.url), 'utf8');
const { createMapLibrary, nextMapTitle } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

class Element {
  constructor() { this.children = []; this.attributes = {}; this.handlers = {}; this.value = ''; this.hidden = false; this.disabled = false; }
  append(...children) { for (const child of children) this.insertBefore(child, null); }
  insertBefore(child, before) { child.remove(); this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, child); child.parent = this; }
  remove() { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; } }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(type, fn) { this.handlers[type] = fn; }
  click() { if (!this.disabled) this.handlers.click?.(); }
  focus() { this.focused = true; }
}
function harness() {
  const fields = Object.fromEntries(['list', 'search', 'clear', 'count', 'results', 'empty'].map(key => [key, new Element()]));
  const opened = [];
  const root = {
    ownerDocument: { createElement: () => new Element() },
    querySelector: selector => fields[/\[data-map-(.+)\]/.exec(selector)[1]],
  };
  const library = createMapLibrary(root, { onOpen: id => opened.push(id) });
  return { fields, opened, library, buttons: () => fields.list.children.map(item => item.children[0]) };
}
const map = (id, title, minute = 0) => ({ id, title, updatedAt: `2026-09-19T12:${String(minute).padStart(2, '0')}:00.000Z`, nodes: [{}] });

test('each saved map reopens by identity, including maps with identical titles', () => {
  const h = harness();
  const first = map('first', 'Same title'), second = map('second', 'Same title', 1);
  h.library.update([first, second], second.id);
  const [current, older] = h.buttons();
  current.click(); assert.deepEqual(h.opened, [], 'clicking the already open map does not restart its players');
  older.click(); assert.deepEqual(h.opened, ['first']);
  h.library.update([first, second], first.id);
  current.click(); assert.deepEqual(h.opened, ['first', 'second']);
  assert.equal(h.fields.count.textContent, '2 saved maps');
});

test('search, clearing and autosave updates preserve all records and their existing buttons', () => {
  const h = harness();
  const first = map('first', 'Earlier thoughts'), second = map('second', '<b>New reflections</b>', 1);
  const maps = [first, second], before = structuredClone(maps);
  h.library.update(maps, 'second');
  const buttons = h.buttons();
  h.fields.search.value = 'EARLIER'; h.fields.search.handlers.input();
  assert.equal(h.fields.list.children.filter(item => !item.hidden).length, 1);
  assert.deepEqual(maps, before, 'filtering never changes stored-map data');
  assert.deepEqual(h.buttons(), buttons);
  h.fields.clear.click();
  assert.equal(h.fields.list.children.filter(item => !item.hidden).length, 2);
  assert.equal(h.fields.search.focused, true);
  const renamed = { ...second, title: 'A clearer title', updatedAt: '2026-09-19T12:02:00.000Z' };
  h.library.update([first, renamed], 'second');
  assert.deepEqual(h.buttons(), buttons, 'autosaves do not replace focused map controls');
  assert.equal(buttons[0].children[0].textContent, 'A clearer title');
  h.fields.search.value = 'not found'; h.fields.search.handlers.input();
  assert.match(h.fields.empty.textContent, /Clear the search/);
  h.library.clearSearch();
  assert.equal(h.fields.list.children.filter(item => !item.hidden).length, 2);
});

test('saving blocks map switches and missing storage does not claim there are no maps', () => {
  const h = harness();
  assert.match(h.fields.empty.textContent, /Loading/);
  h.library.setError(); assert.match(h.fields.empty.textContent, /could not be loaded/);
  h.library.update([map('old', 'Old map'), map('new', 'New map', 1)], 'new');
  h.library.setBusy(true); h.buttons()[1].click(); assert.deepEqual(h.opened, []);
  h.library.setBusy(false); h.buttons()[1].click(); assert.deepEqual(h.opened, ['old']);
  h.library.update([map('old', 'Old map')], 'old');
  assert.equal(h.buttons().length, 1);
  assert.equal(h.fields.count.textContent, '1 saved map');
});

test('starting titles distinguish new maps without renaming existing maps', () => {
  const existing = [map('one', 'Mind map 1'), map('two', 'mind map 2'), map('four', 'My ideas')];
  const before = structuredClone(existing);
  assert.equal(nextMapTitle(existing), 'Mind map 3');
  assert.deepEqual(existing, before);
  assert.equal(nextMapTitle([]), 'Mind map 1');
});

test('saving a new map and reopening storage keeps the older map and its notes available in the library', async t => {
  const previous = globalThis.indexedDB;
  globalThis.indexedDB = new IDBFactory();
  t.after(() => { if (previous === undefined) delete globalThis.indexedDB; else globalThis.indexedDB = previous; });
  const coreSource = await readFile(new URL('../mindmap-core.js', import.meta.url), 'utf8');
  const loadCore = suffix => import(`data:text/javascript;base64,${Buffer.from(coreSource + '\n// library reload ' + suffix).toString('base64')}`);
  const core = await loadCore('first');
  const first = core.createMap('Earlier map');
  first.nodes[0].notes = 'Keep this earlier idea.';
  first.video = core.parseYouTubeUrl('https://youtu.be/M7lc1UVf-VE?t=15');
  const savedFirst = await core.saveMap(first);
  const second = await core.saveMap(core.createMap(nextMapTitle(await core.listMaps())));
  second.nodes[0].notes = 'Only the newer map.';
  await core.saveMap(second);

  const reloaded = await loadCore('second');
  const maps = await reloaded.listMaps();
  assert.equal(maps.length, 2);
  assert.deepEqual(maps.find(item => item.id === first.id), savedFirst);
  assert.equal(maps.find(item => item.id === second.id).nodes[0].notes, 'Only the newer map.');
  const h = harness();
  h.library.update(maps, second.id);
  const oldButton = h.buttons().find(button => button.attributes['aria-label'] === 'Open map: Earlier map');
  oldButton.click(); assert.deepEqual(h.opened, [first.id]);
  assert.equal(maps.find(item => item.id === h.opened[0]).nodes[0].notes, 'Keep this earlier idea.');
});
