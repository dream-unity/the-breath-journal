// This database deliberately does not share the video journal's recording store.
const DATABASE_NAME = 'dream-unity-mind-maps';
const STORE_NAME = 'maps';
const MAX_NODES = 500;
const MAX_IMPORT_LENGTH = 8_000_000;
const MAX_COORDINATE = 10_000;
const MAX_START_SECONDS = 31_536_000;
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/;

let activeDatabase = null;
let databasePromise = null;

function newId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  if (globalThis.crypto?.getRandomValues) {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return `map-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function parseStartTime(value) {
  if (value === null || value === '') return 0;
  let seconds;
  if (/^\d+$/.test(value)) {
    seconds = Number(value);
  } else {
    const parts = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(value);
    if (!parts || !parts.slice(1).some((part) => part !== undefined)) {
      throw new Error('The YouTube start time must be seconds or a time such as 1h2m3s.');
    }
    seconds = Number(parts[1] || 0) * 3600 + Number(parts[2] || 0) * 60 + Number(parts[3] || 0);
  }
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > MAX_START_SECONDS) {
    throw new Error('The YouTube start time is too large.');
  }
  return seconds;
}

/** Parse a YouTube link into trusted, canonical watch and privacy-enhanced embed URLs. */
export function parseYouTubeUrl(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 4096) {
    throw new Error('Paste a valid YouTube video link.');
  }
  let value = input.trim();
  if (value.includes('\\')) throw new Error('Paste a valid YouTube video link.');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) value = `https://${value}`;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Paste a valid YouTube video link.');
  }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.port) {
    throw new Error('Use a standard YouTube link without login details or a custom port.');
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.replace(/\/$/, '');
  let videoId;
  if (host === 'youtu.be' || host === 'www.youtu.be') {
    videoId = /^\/([A-Za-z0-9_-]{11})$/.exec(path)?.[1];
  } else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) {
    videoId = path === '/watch'
      ? parsed.searchParams.get('v')
      : /^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})$/.exec(path)?.[1];
  } else if (host === 'youtube-nocookie.com' || host === 'www.youtube-nocookie.com') {
    videoId = /^\/embed\/([A-Za-z0-9_-]{11})$/.exec(path)?.[1];
  } else {
    throw new Error('Use a youtube.com or youtu.be video link.');
  }
  if (!videoId || !VIDEO_ID_PATTERN.test(videoId)) {
    throw new Error('This link does not identify a YouTube video. Paste its Watch, Share, Shorts or Live link.');
  }
  const fragment = parsed.hash.slice(1);
  const fragmentTime = new URLSearchParams(fragment).get('t');
  const time = parsed.searchParams.get('t') ?? parsed.searchParams.get('start') ?? fragmentTime;
  const startSeconds = parseStartTime(time);
  const url = `https://www.youtube.com/watch?v=${videoId}${startSeconds ? `&t=${startSeconds}s` : ''}`;
  const embedUrl = `https://www.youtube-nocookie.com/embed/${videoId}?rel=0&playsinline=1${startSeconds ? `&start=${startSeconds}` : ''}`;
  return { videoId, startSeconds, url, embedUrl };
}

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value;
}

function text(value, name, maximum, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > maximum || (!allowEmpty && !value.trim())) {
    throw new Error(`${name} must ${allowEmpty ? '' : 'not be empty and must '}contain at most ${maximum.toLocaleString('en')} characters.`);
  }
  return value;
}

function identifier(value, name) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new Error(`${name} must be a valid identifier of at most 160 characters.`);
  }
  return value;
}

function date(value, name) {
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${name} must be a valid date.`);
  }
  return new Date(value).toISOString();
}

/** Return only known, validated fields; imported HTML and object properties remain inert data. */
export function validateMap(input) {
  const source = object(input, 'The mind map');
  const id = identifier(source.id, 'The mind-map ID');
  const title = text(source.title, 'The title', 160, true).trim() || 'Untitled mind map';
  const createdAt = date(source.createdAt, 'The creation date');
  const updatedAt = date(source.updatedAt, 'The update date');
  if (!Array.isArray(source.nodes) || source.nodes.length < 1 || source.nodes.length > MAX_NODES) {
    throw new Error(`A mind map must contain between 1 and ${MAX_NODES} ideas.`);
  }
  const nodes = source.nodes.map((entry) => {
    const node = object(entry, 'Each idea');
    const nodeId = identifier(node.id, 'Each idea ID');
    const parentId = node.parentId === null ? null : identifier(node.parentId, 'The parent idea ID');
    for (const axis of ['x', 'y']) {
      if (typeof node[axis] !== 'number' || !Number.isFinite(node[axis]) || node[axis] < 0 || node[axis] > MAX_COORDINATE) {
        throw new Error(`Idea positions must be finite numbers between 0 and ${MAX_COORDINATE}.`);
      }
    }
    return {
      id: nodeId,
      label: text(node.label, 'Each idea label', 200, true).trim() || 'Untitled idea',
      notes: text(node.notes ?? '', 'Idea notes', 12_000, true),
      parentId,
      x: node.x,
      y: node.y,
    };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (byId.size !== nodes.length) throw new Error('Every idea must have a different ID.');
  if (nodes.filter((node) => node.parentId === null).length !== 1) {
    throw new Error('A mind map must have exactly one main idea.');
  }
  for (const node of nodes) {
    if (node.parentId !== null && !byId.has(node.parentId)) {
      throw new Error('An idea refers to a parent that does not exist.');
    }
  }
  // Walking parent chains detects disconnected cycles as well as self-parenting.
  const checked = new Set();
  for (const node of nodes) {
    const chain = new Set();
    let current = node;
    while (current && !checked.has(current.id)) {
      if (chain.has(current.id)) throw new Error('Ideas cannot form a circular parent chain.');
      chain.add(current.id);
      current = current.parentId === null ? null : byId.get(current.parentId);
    }
    for (const visited of chain) checked.add(visited);
  }
  const video = source.video == null ? null : parseYouTubeUrl(object(source.video, 'The linked video').url);
  return { id, title, createdAt, updatedAt, video, nodes };
}

export function createMap(title = 'Untitled mind map') {
  const now = new Date().toISOString();
  return validateMap({
    id: newId(),
    title,
    createdAt: now,
    updatedAt: now,
    video: null,
    nodes: [{ id: newId(), label: 'Main idea', notes: '', parentId: null, x: 80, y: 220 }],
  });
}

export function serializeMap(map) {
  return JSON.stringify({ version: 1, map: validateMap(map) }, null, 2);
}

/** Imports always receive a fresh map ID so an existing saved map cannot be overwritten. */
export function importMap(input) {
  if (typeof input !== 'string' || input.length > MAX_IMPORT_LENGTH) {
    throw new Error('This mind-map file is too large. Choose a smaller JSON export.');
  }
  let imported;
  try {
    imported = JSON.parse(input);
  } catch {
    throw new Error('This file is not valid mind-map JSON.');
  }
  object(imported, 'The imported file');
  if (imported.version !== 1) throw new Error('This mind-map file version is not supported.');
  const map = validateMap(imported.map);
  const now = new Date().toISOString();
  return { ...map, id: newId(), createdAt: now, updatedAt: now };
}

function forgetDatabase(database) {
  if (activeDatabase === database) {
    activeDatabase = null;
    databasePromise = null;
  }
}

function getDatabase() {
  if (activeDatabase) return Promise.resolve(activeDatabase);
  if (databasePromise) return databasePromise;
  if (!globalThis.indexedDB) {
    return Promise.reject(new Error('Mind-map storage is unavailable in this browser. You can still export your work as a JSON file.'));
  }
  const opening = new Promise((resolve, reject) => {
    let settled = false;
    let request;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      databasePromise = null;
      reject(error);
    };
    try {
      request = globalThis.indexedDB.open(DATABASE_NAME, 1);
    } catch (error) {
      // Run after databasePromise is assigned, including for synchronous security errors.
      queueMicrotask(() => fail(error));
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME, { keyPath: 'id' });
    };
    request.onerror = () => fail(request.error || new Error('The mind-map database could not be opened.'));
    request.onblocked = () => fail(new Error('Mind-map storage is blocked by another tab. Close other tabs for this journal, then try again.'));
    request.onsuccess = () => {
      const database = request.result;
      if (settled) {
        database.close();
        return;
      }
      activeDatabase = database;
      database.onversionchange = () => {
        database.close();
        forgetDatabase(database);
      };
      database.onclose = () => forgetDatabase(database);
      settled = true;
      resolve(database);
    };
  });
  databasePromise = opening;
  return opening;
}

async function transaction(mode, operation) {
  let database = await getDatabase();
  let pending;
  try {
    pending = database.transaction(STORE_NAME, mode);
  } catch (error) {
    if (error.name !== 'InvalidStateError') throw error;
    // A versionchange can close a connection between awaiting it and starting a transaction.
    forgetDatabase(database);
    database = await getDatabase();
    pending = database.transaction(STORE_NAME, mode);
  }
  return new Promise((resolve, reject) => {
    let result;
    let failure;
    pending.oncomplete = () => resolve(result);
    pending.onerror = (event) => { failure = pending.error || event.target.error || failure; };
    pending.onabort = () => reject(failure || pending.error || new Error('The mind-map storage transaction was cancelled.'));
    try {
      const request = operation(pending.objectStore(STORE_NAME));
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => { failure = request.error; };
    } catch (error) {
      failure = error;
      try { pending.abort(); } catch { reject(error); }
    }
  });
}

export async function listMaps() {
  const stored = await transaction('readonly', (store) => store.getAll());
  return stored.map(validateMap).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/** Resolve only once the write transaction commits; request success alone is insufficient. */
export async function saveMap(input) {
  const map = validateMap(input);
  map.updatedAt = new Date().toISOString();
  await transaction('readwrite', (store) => store.put(map));
  return map;
}

export async function deleteMap(id) {
  identifier(id, 'The mind-map ID');
  await transaction('readwrite', (store) => store.delete(id));
}
