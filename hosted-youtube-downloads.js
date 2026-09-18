const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const JOB_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TOKEN = /^[A-Za-z0-9_-]{20,256}$/;
const ACTIVE = new Set(['starting', 'queued', 'running', 'cancelling']);
const STATES = new Set(['queued', 'running', 'complete', 'error', 'cancelled']);
const scopeKey = (owner, videoId) => JSON.stringify([owner, videoId]);

function gatewayOrigin(serviceUrl) {
  const url = new URL(serviceUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      !['', '/'].includes(url.pathname)) throw new Error('Downloads require a configured HTTPS service origin.');
  return url.origin;
}

function workerLinks(data, previous) {
  const token = data.token ?? previous?.token;
  if (!TOKEN.test(token || '')) throw new Error('The download service returned an invalid download token.');
  let status, download;
  try {
    status = new URL(data.statusUrl ?? previous?.statusUrl);
    download = new URL(data.downloadUrl ?? previous?.downloadUrl);
  } catch { throw new Error('The download service returned an invalid file address.'); }
  for (const url of [status, download]) {
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port ||
        !/^[a-z0-9-]+\.vercel\.run$/i.test(url.hostname)) {
      throw new Error('The download service returned an untrusted file address.');
    }
  }
  if (status.origin !== download.origin || status.search || status.pathname !== `/jobs/${data.id}` || download.pathname !== `/files/${data.id}` ||
      download.searchParams.get('token') !== token || [...download.searchParams.keys()].some(key => key !== 'token') ||
      download.searchParams.getAll('token').length !== 1) {
    throw new Error('The download service returned inconsistent file addresses.');
  }
  if (previous?.statusUrl && (status.href !== previous.statusUrl || download.href !== previous.downloadUrl || token !== previous.token)) {
    throw new Error('The download service changed the identity of this download.');
  }
  return { token, statusUrl: status.href, downloadUrl: download.href };
}

/** A response with Content-Disposition: attachment downloads without navigating the map. */
function startBrowserDownload(url) {
  const doc = globalThis.document;
  if (!doc?.body) throw new Error('Use the ready-file link to save your download.');
  const frame = doc.createElement('iframe');
  frame.hidden = true;
  frame.setAttribute('aria-hidden', 'true');
  frame.setAttribute('sandbox', 'allow-downloads');
  frame.referrerPolicy = 'no-referrer';
  frame.src = url;
  doc.body.append(frame);
  // Keep the attachment request alive; this frame contains no player or executable page.
  setTimeout(() => frame.remove(), 60_000);
}

/** Jobs and download capabilities stay in memory, scoped to the original idea and video. */
export function createHostedDownloadSession({
  serviceUrl,
  fetch: fetchRequest = (...args) => globalThis.fetch(...args),
  setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now,
  requestTimeout = 250000, statusTimeout = 15000, pollInterval = 1800, jobTimeout = 20 * 60 * 1000,
  requestId = () => globalThis.crypto.randomUUID(),
  downloadFile = startBrowserDownload,
} = {}) {
  const origin = gatewayOrigin(serviceUrl);
  const listeners = new Set(), jobs = new Map();
  let active = null;
  const notify = () => listeners.forEach(listener => listener());
  const update = (job, change) => { Object.assign(job, change); notify(); };

  async function request(url, { method = 'GET', body, token } = {}) {
    const controller = new AbortController();
    const timer = setTimer(() => controller.abort(), method === 'POST' ? requestTimeout : statusTimeout);
    try {
      const response = await fetchRequest(url, {
        method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: controller.signal,
        cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
      });
      let data;
      try { data = await response.json(); } catch {
        if (response.ok) throw new Error('The download service returned an unreadable response.');
        data = {};
      }
      if (!response.ok) {
        const detail = typeof data?.message === 'string' ? data.message : typeof data?.error === 'string' ? data.error : '';
        const fallback = response.status === 429 ? 'The download service is busy. Please try again shortly.'
          : response.status === 401 || response.status === 403 ? 'This download has expired or is no longer available. Please start again.'
          : response.status === 404 || response.status === 410 ? 'This download has expired. Please start again.'
          : 'The download service could not complete this request.';
        const error = new Error(detail.slice(0, 300) || fallback); error.status = response.status; throw error;
      }
      return data;
    } catch (error) {
      if (error?.name === 'AbortError' || error instanceof TypeError) throw new Error('The download service could not be reached. Check your connection and try again.');
      throw error;
    } finally { clearTimer(timer); }
  }

  function release(job) {
    if (!ACTIVE.has(job.state) && !job.uncertain && active === job) active = null;
  }

  function accept(job, data) {
    if (!data || !JOB_ID.test(data.id || '') || (job.id && data.id !== job.id) ||
        data.videoId !== job.videoId || data.format !== job.format || !STATES.has(data.state)) {
      throw new Error('The download service returned a result for a different video.');
    }
    const links = workerLinks(data, job);
    const filename = data.state === 'complete' && typeof data.filename === 'string' ? data.filename.slice(0, 240) : '';
    if (data.state === 'complete' && !filename) throw new Error('The download service did not return a completed file.');
    Object.assign(job, links, {
      id: data.id, state: data.state, message: typeof data.message === 'string' ? data.message.slice(0, 300) : '',
      progress: typeof data.progress === 'number' && Number.isFinite(data.progress) ? Math.max(0, Math.min(100, data.progress)) : null,
      filename, uncertain: false,
    });
    release(job);
    if (job.state === 'complete' && !job.downloadAttempted && !job.cancelRequested) {
      // This belongs to the user's original click even if another idea is now selected.
      job.downloadAttempted = true;
      try { downloadFile(job.downloadUrl, job.filename); }
      catch { job.message = 'Your file is ready. Use the ready-file link to save it.'; }
    }
    notify();
  }

  function failure(job, error, context = '') {
    const uncertain = !Number.isInteger(error.status) || error.status >= 500;
    update(job, { state: 'error', uncertain, message: `${error.message}${context && uncertain ? ` ${context}` : ''}` });
    release(job); notify();
  }

  function schedule(job) {
    if (!ACTIVE.has(job.state) || job.timer || job.cancelling || job.submitting) return;
    if (now() >= job.deadline) {
      update(job, { state: 'error', uncertain: true, message: 'Status checks timed out. Check this download again or cancel it below.' });
      return;
    }
    job.timer = setTimer(() => { job.timer = null; void check(job); }, pollInterval);
  }

  async function check(job) {
    if (!job.id || job.checking || job.cancelling) return;
    job.checking = true;
    const version = job.cancelVersion || 0;
    try {
      const data = await request(job.statusUrl, { token: job.token });
      if (version === (job.cancelVersion || 0)) accept(job, data);
    } catch (error) {
      if (version === (job.cancelVersion || 0)) failure(job, error, 'The request may still be running.');
    } finally { job.checking = false; schedule(job); }
  }

  async function submit(job) {
    if (job.submitting) return;
    job.submitting = true;
    update(job, { state: job.cancelRequested ? 'cancelling' : 'starting', message: job.cancelRequested ? 'Finding the download to cancel…' : 'Preparing your download…' });
    try {
      const data = await request(`${origin}/api/jobs`, { method: 'POST', body: { videoId: job.videoId, format: job.format, clientRequestId: job.requestId } });
      accept(job, data);
      job.submitting = false;
      if (job.cancelRequested && ACTIVE.has(job.state)) await cancel(job);
    } catch (error) {
      failure(job, error, 'Retry the original request below to recover it without starting another download.');
    } finally { job.submitting = false; schedule(job); }
  }

  async function cancel(job) {
    if (!job || job.cancelling || (!ACTIVE.has(job.state) && !job.uncertain)) return;
    job.cancelRequested = true;
    job.cancelVersion = (job.cancelVersion || 0) + 1;
    if (job.timer) { clearTimer(job.timer); job.timer = null; }
    update(job, { state: 'cancelling', message: 'Cancelling download…' });
    if (job.submitting) return;
    if (!job.id) return submit(job);
    job.cancelling = true;
    try { accept(job, await request(job.statusUrl, { method: 'DELETE', token: job.token })); }
    catch (error) { failure(job, error, 'Cancellation could not be confirmed.'); }
    finally { job.cancelling = false; schedule(job); }
  }

  return {
    async start(owner, videoId, format) {
      if (active || !owner || !VIDEO_ID.test(videoId || '') || !['video', 'mp3'].includes(format)) return;
      const key = scopeKey(owner, videoId);
      const job = { key, owner, videoId, format, id: '', state: 'starting', requestId: requestId(), deadline: now() + jobTimeout };
      const records = jobs.get(key) || new Map(); records.set(format, job); jobs.set(key, records);
      active = job; await submit(job);
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    snapshot(owner, videoId) {
      return { available: true, busy: !!active, jobs: [...(jobs.get(scopeKey(owner, videoId))?.values() || [])].map(job => ({
        id: job.id, format: job.format, state: job.state, message: job.message || '', filename: job.filename || '',
        progress: job.progress ?? null, uncertain: !!job.uncertain,
        downloadUrl: job.state === 'complete' ? job.downloadUrl : '',
      })) };
    },
    cancel(owner, videoId, format) { return cancel(jobs.get(scopeKey(owner, videoId))?.get(format)); },
    retry(owner, videoId, format) {
      const job = jobs.get(scopeKey(owner, videoId))?.get(format);
      if (!job?.uncertain) return;
      job.deadline = now() + jobTimeout;
      return job.id ? (job.cancelRequested ? cancel(job) : check(job)) : submit(job);
    },
  };
}

const sharedSessions = new Map();
const unavailableSession = {
  snapshot: () => ({ available: false, busy: false, jobs: [] }),
  subscribe: () => () => {}, start: () => {},
};

/** The download component owns only this container; it never modifies a video player. */
export function createYouTubeDownloads(root, { label = 'Video downloads', serviceUrl, session } = {}) {
  if (!session && serviceUrl) {
    const origin = gatewayOrigin(serviceUrl);
    if (!sharedSessions.has(origin)) sharedSessions.set(origin, createHostedDownloadSession({ serviceUrl: origin }));
    session = sharedSessions.get(origin);
  }
  session ||= unavailableSession;
  const doc = root.ownerDocument;
  const element = (tag, className, text) => {
    const node = doc.createElement(tag); if (className) node.className = className;
    if (text) node.textContent = text; return node;
  };
  const button = text => { const node = element('button', 'yt-download-button', text); node.type = 'button'; return node; };
  let owner = '', current = null, renderedScope = '', destroyed = false;
  const rows = new Map();
  root.classList.add('yt-download'); root.setAttribute('aria-label', label); root.hidden = true;
  const actions = element('div', 'yt-download-actions');
  const videoButton = button('Download video'), mp3Button = button('Download MP3');
  actions.append(videoButton, mp3Button);
  const status = element('p', 'yt-download-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const results = element('div', 'yt-download-results');
  root.append(actions, status, results);
  videoButton.addEventListener('click', () => { if (current && !destroyed) void session.start(owner, current.videoId, 'video'); });
  mp3Button.addEventListener('click', () => { if (current && !destroyed) void session.start(owner, current.videoId, 'mp3'); });

  function render() {
    if (destroyed || !current) return;
    const snapshot = session.snapshot(owner, current.videoId);
    videoButton.disabled = mp3Button.disabled = !snapshot.available || snapshot.busy;
    status.textContent = !snapshot.available ? 'Downloads are not available in this preview.'
      : snapshot.busy && !snapshot.jobs.some(job => ACTIVE.has(job.state) || job.uncertain)
        ? 'Another download is being prepared. Its progress is shown where you started it.' : '';
    for (const job of snapshot.jobs) {
      let row = rows.get(job.format);
      const kind = job.format === 'mp3' ? 'MP3' : 'Video';
      if (!row) {
        const container = element('div', 'yt-download-result');
        const message = element('p'); message.setAttribute('role', 'status');
        const progress = element('progress'); progress.max = 100; progress.setAttribute('aria-label', `${kind} download progress`);
        const cancelButton = button(`Cancel ${kind} download`), retryButton = button('Check download status');
        const fileLink = element('a', '', 'Download ready file');
        fileLink.target = '_blank'; fileLink.rel = 'noopener noreferrer'; fileLink.referrerPolicy = 'no-referrer';
        const capturedOwner = owner, capturedVideoId = current.videoId, capturedFormat = job.format;
        cancelButton.addEventListener('click', () => { void session.cancel(capturedOwner, capturedVideoId, capturedFormat); });
        retryButton.addEventListener('click', () => { void session.retry(capturedOwner, capturedVideoId, capturedFormat); });
        container.append(message, progress, cancelButton, retryButton, fileLink); results.append(container);
        row = { message, progress, cancelButton, retryButton, fileLink }; rows.set(job.format, row);
      }
      row.message.textContent = `${kind}: ${job.state === 'complete' ? `Ready — ${job.filename}. ${job.message || 'Your browser download should start automatically.'}` : job.message || job.state}`;
      row.progress.hidden = !ACTIVE.has(job.state) || job.state === 'cancelling';
      if (job.progress === null) row.progress.removeAttribute('value'); else row.progress.value = job.progress;
      row.cancelButton.hidden = !(ACTIVE.has(job.state) || job.uncertain);
      row.cancelButton.disabled = job.state === 'cancelling';
      row.retryButton.hidden = !job.uncertain;
      row.retryButton.textContent = job.id ? 'Check download status' : 'Retry download request';
      row.fileLink.hidden = job.state !== 'complete';
      if (job.state === 'complete') { row.fileLink.href = job.downloadUrl; row.fileLink.download = job.filename; }
      else row.fileLink.removeAttribute('href');
    }
  }
  const unsubscribe = session.subscribe(render);
  return {
    setVideo(video, nextOwner) {
      current = video && VIDEO_ID.test(video.videoId || '') && nextOwner ? { videoId: video.videoId } : null;
      owner = nextOwner || ''; root.hidden = !current;
      const nextScope = current ? scopeKey(owner, current.videoId) : '';
      if (renderedScope !== nextScope) { results.replaceChildren(); rows.clear(); renderedScope = nextScope; }
      if (!current) { status.textContent = ''; return; }
      render();
    },
    destroy() { destroyed = true; unsubscribe(); current = null; root.replaceChildren(); root.hidden = true; },
  };
}
