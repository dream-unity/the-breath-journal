import { saveIdeaRecording, listIdeaRecordings, deleteIdeaRecording } from './mindmap-core.js?v=20260918-independent-players-5';

const keyOf = scope => scope ? `${scope.mapId}\u0000${scope.nodeId}` : '';
const durationText = ms => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

function cameraError(error) {
  if (['NotAllowedError', 'SecurityError'].includes(error?.name)) return 'Camera or microphone access was not allowed. Allow both in your browser settings, then try again.';
  if (['NotFoundError', 'DevicesNotFoundError'].includes(error?.name)) return 'No camera or microphone was found. Connect both, then try again.';
  if (['NotReadableError', 'TrackStartError'].includes(error?.name)) return 'The camera or microphone is busy. Close any other app using it, then try again.';
  return error?.message || 'The camera could not be started. Please try again.';
}

/** Camera recordings belong only to the captured map/idea, never the journal or shared player. */
export function createIdeaRecorder({
  root, prepare = async () => {},
  storage = { saveIdeaRecording, listIdeaRecordings, deleteIdeaRecording },
  mediaDevices = globalThis.navigator?.mediaDevices,
  Recorder = globalThis.MediaRecorder,
  urls = globalThis.URL,
  now = () => Date.now(),
  makeId = () => globalThis.crypto.randomUUID(),
  schedule = (callback, ms) => globalThis.setInterval(callback, ms),
  unschedule = handle => globalThis.clearInterval(handle),
  confirm = message => globalThis.confirm(message),
  lifecycle = globalThis.window,
} = {}) {
  const element = name => {
    const found = root.querySelector(`[data-recorder-${name}]`);
    if (!found) throw new Error(`Missing idea recorder control: ${name}`);
    return found;
  };
  const el = Object.fromEntries(['label', 'preview', 'enable', 'start', 'stop', 'close', 'status', 'timer', 'list'].map(name => [name, element(name)]));
  const doc = root.ownerDocument;
  const pending = new Map();
  const sessions = new Set();
  const cards = new Map();
  let emptyCard = null;
  let scope = null, epoch = 0, loadSequence = 0, disposed = false;
  let stream = null, cameraRequest = null, startRequest = null, recording = null, timer = null;
  let savedRecords = [], removeTrackListeners = () => {};

  const isCurrent = (owner, generation) => !disposed && scope && keyOf(owner) === keyOf(scope) && (generation === undefined || generation === epoch);
  const status = (message, owner = scope, generation) => { if (isCurrent(owner, generation)) el.status.textContent = message; };
  const unsupported = !mediaDevices?.getUserMedia || !Recorder;

  function controls() {
    el.enable.disabled = !scope || disposed || unsupported || !!cameraRequest || !!stream || !!recording || !!startRequest;
    el.start.disabled = !scope || disposed || !stream || !!recording || !!startRequest;
    el.stop.disabled = !recording || recording.stopping;
    el.close.disabled = !stream && !cameraRequest && !startRequest;
  }

  function releaseCard(view) {
    view.video.pause();
    view.video.removeAttribute('src');
    view.video.load();
    view.card.remove();
    urls.revokeObjectURL(view.url);
    cards.delete(view.recordId);
  }

  function releaseCards() {
    for (const view of cards.values()) releaseCard(view);
    emptyCard?.remove();
    emptyCard = null;
  }

  function stopCamera() {
    removeTrackListeners();
    removeTrackListeners = () => {};
    if (stream) for (const track of stream.getTracks()) track.stop();
    stream = null;
    el.preview.pause();
    el.preview.srcObject = null;
    el.preview.hidden = true;
  }

  function append(parent, tag, text, className) {
    const child = doc.createElement(tag);
    if (text) child.textContent = text;
    if (className) child.className = className;
    parent.append(child);
    return child;
  }

  function createCard(owner, item) {
    const { record } = item;
    const generation = epoch;
    const card = doc.createElement('article');
    card.className = 'idea-recording-card';
    const heading = append(card, 'h4', `Recorded ${new Date(record.createdAt).toLocaleString()}`);
    const video = append(card, 'video');
    const url = urls.createObjectURL(record.blob);
    video.controls = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.disablePictureInPicture = true;
    video.disableRemotePlayback = true;
    video.src = url;
    const meta = append(card, 'p', '', 'idea-recording-meta');
    const actions = append(card, 'div', '', 'idea-recording-actions');
    const download = append(actions, 'a', 'Download video');
    download.href = url;
    const extension = record.mimeType.includes('mp4') ? 'mp4' : 'webm';
    download.download = `idea-recording-${record.id}.${extension}`;
    const retry = append(actions, 'button', 'Retry save');
    retry.type = 'button';
    const remove = append(actions, 'button', 'Delete recording');
    remove.type = 'button';
    remove.className = 'danger';
    const view = { recordId: record.id, card, heading, video, url, meta, retry, remove, item, deleting: false };
    const isMounted = () => isCurrent(owner, generation) && cards.get(record.id) === view;
    retry.addEventListener('click', async () => {
      const current = view.item;
      if (!isMounted() || !current.error || current.saving) return;
      try {
        await prepare(owner);
        if (isMounted()) await storeRecording(current);
      } catch (error) { status(error.message || 'This idea could not be saved. Download your video to keep a copy.', owner, generation); }
    });
    remove.addEventListener('click', async () => {
      if (!isMounted() || view.item.saving || view.deleting || !confirm('Delete this recording from this idea? This cannot be undone.')) return;
      view.deleting = true;
      remove.disabled = true;
      try {
        if (pending.has(record.id)) pending.delete(record.id);
        else await storage.deleteIdeaRecording(owner.mapId, owner.nodeId, record.id);
        if (isMounted()) {
          loadSequence++;
          savedRecords = savedRecords.filter(saved => saved.id !== record.id);
          renderCards();
          status('Recording deleted from this idea.', owner, generation);
        }
      } catch (error) {
        status(error.message || 'The recording could not be deleted.', owner, generation);
        if (isMounted()) { view.deleting = false; remove.disabled = false; }
      }
    });
    return view;
  }

  function renderCards() {
    if (!scope || disposed) { releaseCards(); return; }
    const owner = { ...scope };
    const waiting = [...pending.values()].filter(item => keyOf(item.record) === keyOf(owner));
    const pendingIds = new Set(waiting.map(item => item.record.id));
    const entries = [...savedRecords.filter(record => !pendingIds.has(record.id)).map(record => ({ record })), ...waiting]
      // Only this exact scope may receive a mounted player or a live object URL.
      .filter(item => keyOf(item.record) === keyOf(owner))
      .sort((a, b) => Date.parse(b.record.createdAt) - Date.parse(a.record.createdAt));
    const ids = new Set(entries.map(item => item.record.id));
    for (const [id, view] of cards) if (!ids.has(id)) releaseCard(view);
    if (!entries.length) {
      if (!emptyCard) emptyCard = append(el.list, 'p', 'No recordings for this idea yet.', 'idea-recording-empty');
      return;
    }
    emptyCard?.remove();
    emptyCard = null;
    for (let index = 0; index < entries.length; index++) {
      const item = entries[index];
      const { record } = item;
      let view = cards.get(record.id);
      if (!view) {
        view = createCard(owner, item);
        // Recording IDs and creation dates are immutable. Insert only new cards;
        // moving an existing media element can interrupt its current playback.
        const nextView = entries.slice(index + 1).map(entry => cards.get(entry.record.id)).find(Boolean);
        el.list.insertBefore(view.card, nextView?.card || null);
        cards.set(record.id, view);
      }
      view.item = item;
      view.video.setAttribute('aria-label', `Recording for ${scope.label || 'Untitled idea'} — ${view.heading.textContent}`);
      view.meta.textContent = `${durationText(record.durationMs)}${item.saving ? ' · Saving…' : item.error ? ' · Not saved — download a copy or retry.' : ' · Saved in this browser'}`;
      view.retry.hidden = !item.error;
      view.retry.disabled = !item.error || !!item.saving || view.deleting;
      view.remove.textContent = item.error ? 'Discard recording' : 'Delete recording';
      view.remove.disabled = !!item.saving || view.deleting;
    }
  }

  async function loadRecordings(owner, generation) {
    const sequence = ++loadSequence;
    try {
      const records = await storage.listIdeaRecordings(owner.mapId, owner.nodeId);
      if (!isCurrent(owner, generation) || sequence !== loadSequence) return;
      savedRecords = records.filter(record => keyOf(record) === keyOf(owner));
      renderCards();
    } catch (error) { if (sequence === loadSequence) status(error.message || 'Recordings could not be loaded. Switch to another idea and back to retry.', owner, generation); }
  }

  async function storeRecording(item) {
    if (item.saving || item.discarded) return;
    item.saving = true;
    item.error = null;
    const owner = item.record;
    if (isCurrent(owner)) { renderCards(); status('Saving this idea’s recording…', owner); }
    try {
      const saved = await storage.saveIdeaRecording(item.record);
      if (item.discarded) return;
      pending.delete(item.record.id);
      if (isCurrent(owner)) {
        // Refresh after commit so an older list read cannot hide this or other saved videos.
        savedRecords = [saved, ...savedRecords.filter(record => record.id !== saved.id)];
        renderCards();
        status('Recording saved to this idea only.', owner);
        void loadRecordings({ ...scope }, epoch);
      }
    } catch (error) {
      if (item.discarded) return;
      item.error = error;
      item.saving = false;
      if (isCurrent(owner)) {
        renderCards();
        status(error?.name === 'QuotaExceededError' ? 'This browser is out of storage. Download your video now, then free space and retry saving.' : 'The recording could not be saved. Download a copy or retry before leaving this page.', owner);
      }
    } finally { item.saving = false; }
  }

  async function finishSession(session) {
    if (session.finished) return;
    session.finished = true;
    sessions.delete(session);
    if (recording === session) {
      recording = null;
      if (timer !== null) unschedule(timer);
      timer = null;
      stopCamera();
      controls();
    }
    if (session.discarded) return;
    const mimeType = session.recorder.mimeType || session.chunks.find(chunk => chunk.type)?.type || 'video/webm';
    const blob = new Blob(session.chunks, { type: mimeType });
    if (!blob.size) { status('No video was captured. Enable the camera and try again.', session.owner); return; }
    const record = { id: session.id, mapId: session.owner.mapId, nodeId: session.owner.nodeId, createdAt: session.createdAt, durationMs: Math.max(0, (session.stoppedAt ?? now()) - session.startedAt), mimeType, blob };
    const item = { record, saving: false, error: null };
    pending.set(record.id, item);
    await storeRecording(item);
  }

  function finishRecording() {
    const session = recording;
    if (!session || session.stopping) return;
    session.stopping = true;
    session.stoppedAt = now();
    if (timer !== null) unschedule(timer);
    timer = null;
    controls();
    status('Finishing this idea’s recording…', session.owner);
    try {
      if (session.recorder.state !== 'inactive') session.recorder.stop();
      // An inactive recorder may still have final dataavailable/stop events queued.
      // Only its stop event may finalize that session.
    } catch { void finishSession(session); }
    // MediaRecorder delivers its final data asynchronously, but camera access ends now.
    stopCamera();
  }

  async function enableCamera() {
    if (el.enable.disabled || !scope) return;
    const owner = { ...scope }, generation = epoch;
    const request = {};
    cameraRequest = request;
    controls();
    status('Preparing the camera and microphone…', owner, generation);
    try {
      await prepare(owner);
      if (!isCurrent(owner, generation) || cameraRequest !== request) return;
      const acquired = await mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: true });
      if (!isCurrent(owner, generation) || cameraRequest !== request) { for (const track of acquired.getTracks()) track.stop(); return; }
      stream = acquired;
      const ended = () => {
        if (!isCurrent(owner, generation)) return;
        finishRecording();
        stopCamera();
        controls();
        status('The camera or microphone disconnected. Any captured video is being saved to this idea.', owner, generation);
      };
      for (const track of acquired.getTracks()) track.addEventListener('ended', ended);
      removeTrackListeners = () => { for (const track of acquired.getTracks()) track.removeEventListener('ended', ended); };
      el.preview.srcObject = acquired;
      el.preview.hidden = false;
      el.preview.muted = true;
      el.preview.play()?.catch(() => {});
      status('Camera ready. Press Start recording when you are ready.', owner, generation);
    } catch (error) { status(cameraError(error), owner, generation); }
    finally { if (cameraRequest === request) cameraRequest = null; controls(); }
  }

  async function startRecording() {
    if (el.start.disabled || !scope || !stream) return;
    const owner = { ...scope }, generation = epoch, activeStream = stream;
    const request = {};
    startRequest = request;
    controls();
    try {
      await prepare(owner);
      if (!isCurrent(owner, generation) || stream !== activeStream || startRequest !== request) return;
      const candidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
      const mimeType = candidates.find(type => Recorder.isTypeSupported?.(type));
      let recorder;
      try { recorder = mimeType ? new Recorder(activeStream, { mimeType }) : new Recorder(activeStream); }
      catch { recorder = new Recorder(activeStream); }
      const startedAt = now();
      const session = { owner, recorder, chunks: [], id: makeId(), createdAt: new Date(startedAt).toISOString(), startedAt, stopping: false, finished: false };
      recorder.addEventListener('dataavailable', event => { if (event.data?.size && !session.finished) session.chunks.push(event.data); });
      recorder.addEventListener('stop', () => { void finishSession(session); }, { once: true });
      recorder.addEventListener('error', () => {
        status('Recording was interrupted. Any captured video will be saved to this idea.', owner);
        if (recording === session) finishRecording();
      });
      recorder.start(1000);
      recording = session;
      sessions.add(session);
      el.timer.textContent = '0:00';
      timer = schedule(() => { if (recording === session && isCurrent(owner, generation)) el.timer.textContent = durationText(now() - startedAt); }, 250);
      status('Recording this idea. Finish recording to save it.', owner, generation);
    } catch (error) { status(error.message || 'Recording could not start. Please try again.', owner, generation); }
    finally { if (startRequest === request) startRequest = null; controls(); }
  }

  function setIdea(nextScope) {
    if (disposed) return;
    if (scope && nextScope && keyOf(scope) === keyOf(nextScope)) {
      scope = { ...nextScope };
      el.label.textContent = scope.label || 'Untitled idea';
      return;
    }
    // Change the owner first so no asynchronous work can repaint the previous idea.
    scope = nextScope ? { ...nextScope } : null;
    epoch++;
    loadSequence++;
    cameraRequest = startRequest = null;
    finishRecording();
    // Detach the old recording session: its final event retains only its captured owner.
    recording = null;
    stopCamera();
    releaseCards();
    savedRecords = [];
    el.timer.textContent = '0:00';
    el.label.textContent = scope?.label || 'Select an idea';
    el.status.textContent = unsupported ? 'Camera recording is not available in this browser. Open this page in a browser that supports camera recording over HTTPS.' : 'Record a video for this idea. It will be available only when this idea is selected.';
    root.hidden = !scope;
    controls();
    if (scope) { renderCards(); void loadRecordings({ ...scope }, epoch); }
  }

  function turnOffCamera() {
    cameraRequest = startRequest = null;
    finishRecording();
    stopCamera();
    controls();
    if (!recording) status('Camera and microphone are off.');
  }

  function discardIdeas(mapId, nodeIds) {
    const ids = nodeIds == null ? null : new Set(nodeIds);
    const matches = owner => owner.mapId === mapId && (ids === null || ids.has(owner.nodeId));
    for (const session of sessions) if (matches(session.owner)) session.discarded = true;
    for (const [id, item] of pending) if (matches(item.record)) { item.discarded = true; pending.delete(id); }
    if (scope && matches(scope)) setIdea(null);
  }

  function suspend() { setIdea(null); }
  el.enable.addEventListener('click', enableCamera);
  el.start.addEventListener('click', startRecording);
  el.stop.addEventListener('click', finishRecording);
  el.close.addEventListener('click', turnOffCamera);
  el.preview.disablePictureInPicture = true;
  el.preview.disableRemotePlayback = true;
  lifecycle?.addEventListener('pagehide', suspend);
  setIdea(null);

  return {
    setIdea,
    discardIdeas,
    hasUnfinished: () => sessions.size > 0 || pending.size > 0,
    dispose() {
      if (disposed) return;
      setIdea(null);
      disposed = true;
      el.enable.removeEventListener('click', enableCamera);
      el.start.removeEventListener('click', startRecording);
      el.stop.removeEventListener('click', finishRecording);
      el.close.removeEventListener('click', turnOffCamera);
      lifecycle?.removeEventListener('pagehide', suspend);
      controls();
    },
  };
}
