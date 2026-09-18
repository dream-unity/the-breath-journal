const HELPER_URL = 'http://127.0.0.1:8766';
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const JOB_ID = /^[A-Za-z0-9_-]{1,128}$/;
const FORMATS = ['video', 'mp3'];
const ACTIVE = new Set(['starting', 'queued', 'running', 'cancelling']);
const scopeKey = (owner, videoId) => JSON.stringify([owner, videoId]);

/** Ephemeral, shared pairing. No requests are made until the user connects. */
export function createDownloadSession({
  fetch: fetchRequest = (...args) => globalThis.fetch(...args),
  setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now,
  requestTimeout = 15000, pollInterval = 1800, jobTimeout = 45 * 60 * 1000,
  requestId = () => globalThis.crypto.randomUUID(),
} = {}) {
  let token = '', connection = { state: 'disconnected', message: '' }, connecting = false;
  let active = null;
  const listeners = new Set(), jobs = new Map();
  const notify = () => listeners.forEach(listener => listener());
  const update = (job, change) => { Object.assign(job, change); notify(); };

  async function request(path, { method = 'GET', body, code = token } = {}) {
    const controller = new AbortController();
    const timer = setTimer(() => controller.abort(), requestTimeout);
    try {
      const response = await fetchRequest(`${HELPER_URL}${path}`, {
        method, headers: { Authorization: `Bearer ${code}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: controller.signal,
        cache: 'no-store', credentials: 'omit', redirect: 'error',
      });
      let data;
      try { data = await response.json(); } catch { throw new Error('The helper returned an unreadable response. Restart it and try again.'); }
      if (!response.ok) {
        const message = data?.message || data?.error;
        const detail = typeof message === 'string' ? message.slice(0, 300) : '';
        const fallback = response.status === 401 ? 'Connection code rejected. Paste the code shown by the running helper.'
          : response.status === 409 ? 'Another download is already running in the helper. Wait for it to finish and try again.'
          : response.status === 400 ? 'The helper could not accept this video or format.'
          : 'The helper could not complete this request.';
        const error = new Error(detail || fallback); error.status = response.status; throw error;
      }
      return data;
    } catch (error) {
      if (error?.name === 'AbortError' || error instanceof TypeError) {
        throw new Error('Cannot reach the desktop helper. Start it on this computer, allow local network access if asked, then reconnect.');
      }
      throw error;
    } finally { clearTimer(timer); }
  }

  async function connect(code) {
    if (connecting) return;
    const next = String(code || '').trim();
    if (!/^[A-Za-z0-9_-]{16,256}$/.test(next)) {
      connection = { state: 'error', message: 'Paste the connection code printed by the desktop helper.' }; notify(); return;
    }
    connecting = true;
    connection = { state: 'connecting', message: 'Connecting to the helper on this computer…' }; notify();
    try {
      const health = await request('/health', { code: next });
      if (health?.version !== 1 || typeof health.ready !== 'boolean' || !Array.isArray(health.missing)) {
        throw new Error('This helper version is not supported. Download the current helper below.');
      }
      if (active && active.code !== next) {
        const previous = active;
        if (previous.timer) { clearTimer(previous.timer); previous.timer = null; }
        previous.abandoned = true; previous.cancelVersion = (previous.cancelVersion || 0) + 1;
        active = null;
        update(previous, { state: 'error', uncertain: false, message: 'The helper restarted. This earlier download can no longer be tracked. Check Downloads/Dream Unity for its file.' });
      }
      token = next;
      connection = health.ready
        ? { state: 'ready', folder: String(health.folder || 'Downloads/Dream Unity'), message: 'Connected. Files save to Downloads/Dream Unity on this computer.' }
        : { state: 'missing', message: `Install the missing helper tools: ${health.missing.map(String).join(', ')}. Then reconnect.` };
    } catch (error) {
      token = '';
      connection = { state: 'error', message: error.message };
    } finally { connecting = false; notify(); }
  }

  function accept(job, data) {
    if (!data || data.id !== job.id || data.videoId !== job.videoId || data.format !== job.format ||
      !['queued', 'running', 'complete', 'error', 'cancelled'].includes(data.state)) {
      throw new Error('The helper returned a status for a different download. Check the helper before retrying.');
    }
    update(job, { state: data.state, message: String(data.message || ''), uncertain: false,
      filename: data.state === 'complete' && typeof data.filename === 'string' ? data.filename : '' });
    if (!ACTIVE.has(job.state) && active === job) active = null;
    notify();
  }

  function schedule(job) {
    if (job.abandoned) return;
    if (!ACTIVE.has(job.state) || job.timer) return;
    if (now() >= job.deadline) {
      update(job, { state: 'error', uncertain: true, message: 'Status checks timed out. The download may still be running on your computer. Check its status or cancel it below.' });
      return;
    }
    job.timer = setTimer(() => { job.timer = null; void check(job); }, pollInterval);
  }

  async function check(job) {
    if (!job.id || job.checking || job.cancelling || job.abandoned) return;
    job.checking = true;
    const version = job.cancelVersion || 0;
    try {
      const data = await request(`/jobs/${encodeURIComponent(job.id)}`, { code: job.code });
      if (version === (job.cancelVersion || 0)) accept(job, data);
    } catch (error) {
      if (version === (job.cancelVersion || 0)) {
        const uncertain = error.status !== 404;
        if (!uncertain && active === job) active = null;
        update(job, { state: 'error', uncertain, message: `${error.message}${uncertain ? ' The download may still be running on your computer.' : ' Check Downloads/Dream Unity for its file.'}` });
      }
    }
    finally { job.checking = false; schedule(job); }
  }

  async function submit(job) {
    if (job.submitting || job.abandoned) return;
    job.submitting = true;
    update(job, { state: 'starting', message: 'Starting download…' });
    try {
      const data = await request('/jobs', { method: 'POST', body: { videoId: job.videoId, format: job.format, clientRequestId: job.requestId }, code: job.code });
      if (job.abandoned) return;
      if (!JOB_ID.test(data?.id || '') || data.videoId !== job.videoId || data.format !== job.format) {
        throw new Error('The helper returned a different download. Retry the original request to recover its status.');
      }
      job.id = data.id;
      accept(job, data);
      schedule(job);
    } catch (error) {
      if (job.abandoned) return;
      const uncertain = !Number.isInteger(error.status);
      update(job, { state: 'error', uncertain, message: `${error.message}${uncertain ? ' The request may already be running. Retry the request below to recover its status safely.' : ''}` });
      if (!uncertain && active === job) active = null;
      notify();
    } finally { job.submitting = false; }
  }

  async function start(owner, videoId, format) {
    if (connection.state !== 'ready' || active || !VIDEO_ID.test(videoId) || !FORMATS.includes(format) || !owner) return;
    const key = scopeKey(owner, videoId);
    const job = { key, owner, videoId, format, state: 'starting', message: 'Starting download…', id: '', code: token,
      requestId: requestId(), deadline: now() + jobTimeout };
    const records = jobs.get(key) || new Map(); records.set(format, job); jobs.set(key, records);
    active = job; notify();
    await submit(job);
  }

  async function cancel(job) {
    if (!job?.id || job.abandoned || job.cancelling || (!ACTIVE.has(job.state) && !job.uncertain)) return;
    job.cancelling = true;
    if (job.timer) { clearTimer(job.timer); job.timer = null; }
    // An in-flight GET can finish after DELETE. Its response must never resurrect a cancelled job.
    job.cancelVersion = (job.cancelVersion || 0) + 1;
    update(job, { state: 'cancelling', message: 'Cancelling download…' });
    try {
      const data = await request(`/jobs/${encodeURIComponent(job.id)}`, { method: 'DELETE', code: job.code });
      if (!job.abandoned) accept(job, data);
    } catch (error) {
      if (!job.abandoned) {
        const uncertain = error.status !== 404;
        if (!uncertain && active === job) active = null;
        update(job, { state: 'error', uncertain, message: `${error.message}${uncertain ? ' Cancellation could not be confirmed.' : ' Check Downloads/Dream Unity for its file.'}` });
      }
    }
    finally { job.cancelling = false; schedule(job); }
  }

  return {
    connect, start,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    snapshot(owner, videoId) {
      return { connection: { ...connection }, busy: !!active,
        jobs: [...(jobs.get(scopeKey(owner, videoId))?.values() || [])].map(job => ({
          id: job.id, format: job.format, state: job.state, message: job.message, filename: job.filename || '', uncertain: !!job.uncertain,
        })) };
    },
    cancel(owner, videoId, format) { return cancel(jobs.get(scopeKey(owner, videoId))?.get(format)); },
    retry(owner, videoId, format) {
      const job = jobs.get(scopeKey(owner, videoId))?.get(format);
      if (!job?.uncertain) return;
      job.deadline = now() + jobTimeout;
      return job.id ? check(job) : submit(job);
    },
    async openFolder() { await request('/open-folder', { method: 'POST', body: {} }); },
  };
}

let sharedSession;

/** This component owns only its supplied container; it never touches player DOM or map data. */
export function createYouTubeDownloads(root, { label = 'Video downloads', session } = {}) {
  session ||= (sharedSession ||= createDownloadSession());
  const doc = root.ownerDocument;
  let current = null, owner = '', destroyed = false, folderMessage = '', renderedScope = '';
  const resultRows = new Map();
  const element = (tag, className, text) => {
    const node = doc.createElement(tag); if (className) node.className = className;
    if (text) node.textContent = text; return node;
  };
  const button = text => { const node = element('button', 'yt-download-button', text); node.type = 'button'; return node; };
  root.classList.add('yt-download'); root.setAttribute('aria-label', label); root.hidden = true;
  const actions = element('div', 'yt-download-actions');
  const videoButton = button('Download video'), mp3Button = button('Download MP3');
  actions.append(videoButton, mp3Button);
  const status = element('p', 'yt-download-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const results = element('div', 'yt-download-results');
  const details = element('details', 'yt-download-setup');
  const summary = element('summary', '', 'Download setup');
  const description = element('p', '', 'Downloads need the Dream Unity helper running on this computer. Setup is required once; run the helper whenever you want to download.');
  const links = element('p', 'yt-download-setup-links');
  const helperLink = element('a', '', 'Download desktop helper'); helperLink.href = './downloads/dream-unity-helper.py'; helperLink.download = 'dream-unity-helper.py';
  const guideLink = element('a', '', 'Setup instructions'); guideLink.href = './downloads/setup.html'; guideLink.target = '_blank'; guideLink.rel = 'noopener noreferrer';
  links.append(helperLink, doc.createTextNode(' · '), guideLink);
  const form = element('form', 'yt-download-connect');
  const inputLabel = element('label', '', 'Helper connection code');
  const input = element('input', 'yt-download-code'); input.type = 'password'; input.autocomplete = 'off'; input.spellcheck = false;
  input.placeholder = 'Paste the code printed by the helper'; input.setAttribute('aria-label', 'Helper connection code');
  inputLabel.append(input);
  const connectButton = button('Connect helper'); connectButton.type = 'submit';
  form.append(inputLabel, connectButton);
  const localNote = element('p', 'yt-download-hint', 'If your browser asks, allow access to your local network. The code stays in this tab only. Files save directly to Downloads/Dream Unity on your computer.');
  const rights = element('p', 'yt-download-hint', 'Download only videos you own or have permission to save. Private, protected or unavailable videos may not download.');
  details.append(summary, description, links, form, localNote);
  root.append(actions, status, results, details, rights);

  async function download(format) {
    if (!current || destroyed) return;
    if (session.snapshot(owner, current.videoId).connection.state !== 'ready') { details.open = true; input.focus(); return; }
    await session.start(owner, current.videoId, format);
  }
  videoButton.addEventListener('click', () => { void download('video'); });
  mp3Button.addEventListener('click', () => { void download('mp3'); });
  form.addEventListener('submit', async event => {
    event.preventDefault(); const code = input.value; input.value = '';
    await session.connect(code);
    if (session.snapshot(owner, current?.videoId).connection.state === 'ready') details.open = false;
  });

  function render() {
    if (destroyed || !current) return;
    const snapshot = session.snapshot(owner, current.videoId);
    const { connection, jobs } = snapshot;
    connectButton.disabled = connection.state === 'connecting';
    videoButton.disabled = mp3Button.disabled = snapshot.busy || connection.state === 'connecting';
    summary.textContent = connection.state === 'ready' ? 'Desktop helper connected' : 'Download setup';
    status.textContent = folderMessage || connection.message || 'Use the desktop helper to save this video or its MP3 audio.';
    if (snapshot.busy && !jobs.some(job => ACTIVE.has(job.state) || job.uncertain)) status.textContent = 'Another download is running. Finish or cancel it where you started it.';
    for (const job of jobs) {
      let row = resultRows.get(job.format);
      const kind = job.format === 'mp3' ? 'MP3' : 'Video';
      if (!row) {
        const container = element('div', 'yt-download-result');
        const message = element('p'); message.setAttribute('role', 'status');
        const cancelButton = button(`Cancel ${kind} download`);
        const retryButton = button('Check download status');
        const openButton = button('Open downloads folder');
        const capturedOwner = owner, capturedVideoId = current.videoId, capturedFormat = job.format;
        cancelButton.addEventListener('click', () => { void session.cancel(capturedOwner, capturedVideoId, capturedFormat); });
        retryButton.addEventListener('click', () => { void session.retry(capturedOwner, capturedVideoId, capturedFormat); });
        openButton.addEventListener('click', async () => {
          try { await session.openFolder(); }
          catch (error) { if (owner === capturedOwner && current?.videoId === capturedVideoId) { folderMessage = error.message; render(); } }
        });
        container.append(message, cancelButton, retryButton, openButton); results.append(container);
        row = { message, cancelButton, retryButton, openButton }; resultRows.set(job.format, row);
      }
      row.message.textContent = `${kind}: ${job.state === 'complete' ? `Saved — ${job.filename || 'file saved to Downloads/Dream Unity'}` : job.message || job.state}`;
      row.cancelButton.hidden = !(job.id && (ACTIVE.has(job.state) || job.uncertain));
      row.cancelButton.disabled = job.state === 'cancelling';
      row.retryButton.hidden = !job.uncertain;
      row.retryButton.textContent = job.id ? 'Check download status' : 'Retry download request';
      row.openButton.hidden = job.state !== 'complete';
    }
  }
  const unsubscribe = session.subscribe(render);
  return {
    setVideo(video, nextOwner) {
      current = video && VIDEO_ID.test(video.videoId || '') && nextOwner ? { videoId: video.videoId } : null;
      owner = nextOwner || ''; folderMessage = ''; root.hidden = !current;
      const nextScope = current ? scopeKey(owner, current.videoId) : '';
      if (renderedScope !== nextScope) { results.replaceChildren(); resultRows.clear(); renderedScope = nextScope; }
      if (!current) { results.replaceChildren(); status.textContent = ''; input.value = ''; return; }
      render();
    },
    destroy() { destroyed = true; unsubscribe(); current = null; input.value = ''; root.replaceChildren(); root.hidden = true; },
  };
}
