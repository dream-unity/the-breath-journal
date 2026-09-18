/** One stable iframe per player and owner. Unrelated UI updates never restart it. */
export function createYouTubePlayer(stage, placeholderText = '') {
  let iframe = null, owner = null, source = null;

  function clear() {
    stage.replaceChildren();
    iframe = owner = source = null;
  }

  function show(video, nextOwner, title) {
    if (video && iframe && owner === nextOwner && source === video.embedUrl) {
      iframe.title = title;
      return iframe;
    }
    if (!video && !iframe && stage.childNodes.length) return null;
    clear();
    if (!video) {
      if (placeholderText) {
        const placeholder = stage.ownerDocument.createElement('div');
        placeholder.className = 'map-video-placeholder';
        placeholder.textContent = placeholderText;
        stage.append(placeholder);
      }
      return null;
    }
    iframe = stage.ownerDocument.createElement('iframe');
    iframe.title = title;
    iframe.src = video.embedUrl;
    iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
    iframe.allowFullscreen = true;
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    owner = nextOwner;
    source = video.embedUrl;
    stage.append(iframe);
    return iframe;
  }

  // No visibility/blur listeners or forced-play timers: native playback stays mounted.
  return { show, clear };
}
