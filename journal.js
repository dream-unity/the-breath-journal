(() => {
  'use strict';

  const WORLDS = {
    machine: {
      number: '01',
      title: 'Video Journal',
      prompt: 'Record what you perceive before interpretation takes hold.'
    },
    maker: {
      number: '02',
      title: 'Mind-Mapping Videos',
      prompt: 'Watch a video. Connect its ideas. Keep your perspective.'
    },
    reality: {
      number: '03',
      title: 'World Perspectives',
      prompt: 'Record what you are choosing to carry from imagination into reality.'
    }
  };

  const requestedWorld = new URLSearchParams(location.search).get('world');
  const worldKey = Object.hasOwn(WORLDS, requestedWorld) ? requestedWorld : 'machine';
  const world = WORLDS[worldKey];

  const elements = {
    cameraStage: document.getElementById('cameraStage'),
    preview: document.getElementById('cameraPreview'),
    recordingState: document.getElementById('recordingState'),
    recordingTime: document.getElementById('recordingTime'),
    openCamera: document.getElementById('openCamera'),
    startRecording: document.getElementById('startRecording'),
    stopRecording: document.getElementById('stopRecording'),
    closeCamera: document.getElementById('closeCamera'),
    cameraStatus: document.getElementById('cameraStatus'),
    entriesGrid: document.getElementById('entriesGrid'),
    emptyState: document.getElementById('emptyState'),
    entryCount: document.getElementById('entryCount'),
    entryTemplate: document.getElementById('entryTemplate'),
    toast: document.getElementById('toast')
  };

  document.body.dataset.world = worldKey;
  document.getElementById('worldNumber').textContent = world.number;
  document.getElementById('worldTitle').textContent = world.title;
  document.getElementById('worldPrompt').textContent = world.prompt;
  document.title = `${world.title} · Dream Unity`;

  document.querySelector(`[data-portal="${worldKey}"]`)?.setAttribute('aria-current', 'page');
  if (worldKey === 'maker') {
    document.querySelector('.eyebrow').textContent = '02 · WATCH, CONNECT, REFLECT';
    const recordings = document.createElement('details');
    recordings.className = 'local-recordings';
    const summary = document.createElement('summary');
    summary.textContent = 'Record or revisit your local videos';
    recordings.append(summary, document.querySelector('.recorder-card'), document.querySelector('.entries-section'));
    document.querySelector('.journal-shell').append(recordings);
  }

  const DB_NAME = 'dream-unity-video-journal';
  const DB_VERSION = 1;
  const VIDEO_STORE = 'videos';
  const NOTE_STORE = 'notes';
  const objectUrls = new Set();
  let databasePromise;
  let mediaStream = null;
  let mediaRecorder = null;
  let recordedChunks = [];
  let recordingStartedAt = 0;
  let timerId = 0;
  let toastTimer = 0;

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('This browser does not support local video storage.'));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(VIDEO_STORE)) {
          const videos = database.createObjectStore(VIDEO_STORE, { keyPath: 'id' });
          videos.createIndex('world', 'world', { unique: false });
        }
        if (!database.objectStoreNames.contains(NOTE_STORE)) {
          database.createObjectStore(NOTE_STORE, { keyPath: 'videoId' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('The journal database could not be opened.'));
      request.onblocked = () => reject(new Error('Close other open Dream Unity tabs, then try again.'));
    });
    return databasePromise;
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('The journal operation failed.'));
    });
  }

  function transactionComplete(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('The journal operation failed.'));
      transaction.onabort = () => reject(transaction.error || new Error('The journal operation was cancelled.'));
    });
  }

  async function getWorldEntries() {
    const database = await openDatabase();
    const videoTransaction = database.transaction(VIDEO_STORE, 'readonly');
    const videos = await requestResult(videoTransaction.objectStore(VIDEO_STORE).index('world').getAll(worldKey));
    const noteTransaction = database.transaction(NOTE_STORE, 'readonly');
    const notes = await requestResult(noteTransaction.objectStore(NOTE_STORE).getAll());
    const notesByVideo = new Map(notes.map(note => [note.videoId, note.text]));
    return videos
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(video => ({ ...video, note: notesByVideo.get(video.id) || '' }));
  }

  async function saveVideo(video) {
    const database = await openDatabase();
    const transaction = database.transaction(VIDEO_STORE, 'readwrite');
    transaction.objectStore(VIDEO_STORE).put(video);
    await transactionComplete(transaction);
  }

  async function saveNote(videoId, text) {
    const database = await openDatabase();
    const transaction = database.transaction(NOTE_STORE, 'readwrite');
    transaction.objectStore(NOTE_STORE).put({ videoId, text, updatedAt: Date.now() });
    await transactionComplete(transaction);
  }

  async function deleteEntry(videoId) {
    const database = await openDatabase();
    const transaction = database.transaction([VIDEO_STORE, NOTE_STORE], 'readwrite');
    transaction.objectStore(VIDEO_STORE).delete(videoId);
    transaction.objectStore(NOTE_STORE).delete(videoId);
    await transactionComplete(transaction);
  }

  function setStatus(message, kind = '') {
    elements.cameraStatus.textContent = message;
    elements.cameraStatus.className = `status-line${kind ? ` ${kind}` : ''}`;
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.hidden = false;
    toastTimer = window.setTimeout(() => { elements.toast.hidden = true; }, 3200);
  }

  function formatDuration(milliseconds) {
    const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  function entryDate(timestamp) {
    const date = new Date(timestamp);
    return {
      date: new Intl.DateTimeFormat(undefined, { day: '2-digit', month: 'short', year: 'numeric' }).format(date).toUpperCase(),
      time: new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date)
    };
  }

  function clearObjectUrls() {
    objectUrls.forEach(url => URL.revokeObjectURL(url));
    objectUrls.clear();
  }

  function renderEntry(entry) {
    const fragment = elements.entryTemplate.content.cloneNode(true);
    const article = fragment.querySelector('.journal-entry');
    const video = fragment.querySelector('.entry-video');
    const textarea = fragment.querySelector('textarea');
    const noteStatus = fragment.querySelector('.note-status');
    const deleteButton = fragment.querySelector('.delete-entry');
    const formatted = entryDate(entry.createdAt);
    const url = URL.createObjectURL(entry.blob);
    objectUrls.add(url);

    article.dataset.entryId = entry.id;
    fragment.querySelector('.entry-date').textContent = formatted.date;
    fragment.querySelector('.entry-time').textContent = formatted.time;
    fragment.querySelector('.entry-duration').textContent = formatDuration(entry.durationMs);
    video.src = url;
    textarea.value = entry.note;

    let saveTimer = 0;
    let latestText = entry.note;
    const commitNote = async () => {
      clearTimeout(saveTimer);
      if (textarea.value === latestText) return;
      noteStatus.textContent = 'Saving…';
      try {
        await saveNote(entry.id, textarea.value);
        latestText = textarea.value;
        noteStatus.textContent = 'Saved with this entry';
      } catch (error) {
        console.error(error);
        noteStatus.textContent = 'Could not save — try again';
      }
    };

    textarea.addEventListener('input', () => {
      noteStatus.textContent = 'Writing…';
      clearTimeout(saveTimer);
      saveTimer = window.setTimeout(commitNote, 550);
    });
    textarea.addEventListener('blur', commitNote);

    deleteButton.addEventListener('click', async () => {
      if (!window.confirm('Delete this video and its written reflection from this device?')) return;
      deleteButton.disabled = true;
      try {
        await deleteEntry(entry.id);
        URL.revokeObjectURL(url);
        objectUrls.delete(url);
        article.remove();
        await refreshEntries();
        showToast('Journal entry deleted.');
      } catch (error) {
        console.error(error);
        deleteButton.disabled = false;
        showToast('The entry could not be deleted.');
      }
    });

    return fragment;
  }

  async function refreshEntries() {
    try {
      const entries = await getWorldEntries();
      clearObjectUrls();
      elements.entriesGrid.replaceChildren(...entries.map(renderEntry));
      elements.emptyState.hidden = entries.length > 0;
      elements.entryCount.textContent = `${entries.length} ${entries.length === 1 ? 'ENTRY' : 'ENTRIES'}`;
    } catch (error) {
      console.error(error);
      elements.emptyState.hidden = false;
      elements.emptyState.querySelector('span').textContent = 'JOURNAL UNAVAILABLE';
      elements.emptyState.querySelector('p').textContent = error.message;
      elements.entryCount.textContent = 'UNAVAILABLE';
    }
  }

  function chooseMimeType() {
    if (!window.MediaRecorder?.isTypeSupported) return '';
    return [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
      'video/mp4'
    ].find(type => MediaRecorder.isTypeSupported(type)) || '';
  }

  function stopMediaStream() {
    if (mediaStream) mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
    elements.preview.srcObject = null;
    elements.cameraStage.classList.remove('camera-on');
    elements.openCamera.hidden = false;
    elements.startRecording.hidden = true;
    elements.stopRecording.hidden = true;
    elements.closeCamera.hidden = true;
    elements.recordingState.hidden = true;
  }

  async function openCamera() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setStatus('Video recording is not supported by this browser. Try a current version of Chrome, Edge, Firefox or Safari.', 'error');
      return;
    }
    elements.openCamera.disabled = true;
    setStatus('Waiting for camera and microphone permission…');
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: { echoCancellation: true, noiseSuppression: true }
      });
      elements.preview.srcObject = mediaStream;
      await elements.preview.play().catch(() => {});
      elements.cameraStage.classList.add('camera-on');
      elements.openCamera.hidden = true;
      elements.startRecording.hidden = false;
      elements.closeCamera.hidden = false;
      setStatus('Camera ready. Recording starts only when you press Start recording.', 'success');
    } catch (error) {
      console.error(error);
      const message = error.name === 'NotAllowedError'
        ? 'Camera or microphone access was declined. Allow access in your browser settings and try again.'
        : error.name === 'NotFoundError'
          ? 'No available camera or microphone was found on this device.'
          : error.name === 'NotReadableError'
            ? 'The camera is already in use by another application.'
            : 'The camera could not be started. Check your browser permissions and try again.';
      setStatus(message, 'error');
      stopMediaStream();
    } finally {
      elements.openCamera.disabled = false;
    }
  }

  function updateRecordingClock() {
    elements.recordingTime.textContent = formatDuration(Date.now() - recordingStartedAt);
  }

  async function finishAndSaveRecording() {
    clearInterval(timerId);
    timerId = 0;
    const durationMs = Math.max(1, Date.now() - recordingStartedAt);
    const mimeType = mediaRecorder?.mimeType || recordedChunks[0]?.type || 'video/webm';
    const blob = new Blob(recordedChunks, { type: mimeType });
    recordedChunks = [];
    elements.stopRecording.disabled = true;
    setStatus('Saving the recording to this device…');

    try {
      if (!blob.size) throw new Error('The browser produced an empty recording.');
      await saveVideo({
        id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        world: worldKey,
        createdAt: Date.now(),
        durationMs,
        mimeType,
        blob
      });
      if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
      stopMediaStream();
      await refreshEntries();
      setStatus('Recording saved privately in this browser.', 'success');
      showToast('Video journal entry saved.');
      document.getElementById('entriesTitle').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      console.error(error);
      setStatus(error.name === 'QuotaExceededError'
        ? 'This browser has run out of storage space. Remove an older entry and try again.'
        : `The recording could not be saved. ${error.message || ''}`.trim(), 'error');
      stopMediaStream();
    } finally {
      elements.stopRecording.disabled = false;
      mediaRecorder = null;
    }
  }

  function startRecording() {
    if (!mediaStream) return;
    try {
      const mimeType = chooseMimeType();
      mediaRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined);
      recordedChunks = [];
      mediaRecorder.ondataavailable = event => {
        if (event.data?.size) recordedChunks.push(event.data);
      };
      mediaRecorder.onerror = event => {
        console.error(event.error || event);
        setStatus('Recording stopped because the camera reported an error.', 'error');
      };
      mediaRecorder.onstop = finishAndSaveRecording;
      mediaRecorder.start(1000);
      recordingStartedAt = Date.now();
      updateRecordingClock();
      timerId = window.setInterval(updateRecordingClock, 250);
      elements.recordingState.hidden = false;
      elements.startRecording.hidden = true;
      elements.stopRecording.hidden = false;
      elements.closeCamera.hidden = true;
      setStatus('Recording now. Press Finish & save when you are ready.');
    } catch (error) {
      console.error(error);
      setStatus('This browser could not begin the recording. Try another current browser.', 'error');
    }
  }

  function stopRecording() {
    if (mediaRecorder?.state === 'recording') {
      elements.stopRecording.disabled = true;
      mediaRecorder.stop();
    }
  }

  elements.openCamera.addEventListener('click', openCamera);
  elements.startRecording.addEventListener('click', startRecording);
  elements.stopRecording.addEventListener('click', stopRecording);
  elements.closeCamera.addEventListener('click', () => {
    stopMediaStream();
    setStatus('Camera and microphone are off.');
  });

  addEventListener('pagehide', () => {
    if (mediaRecorder?.state === 'recording') mediaRecorder.stop();
    else stopMediaStream();
    clearObjectUrls();
  });

  refreshEntries();
})();
