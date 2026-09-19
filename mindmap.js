import { createMap, listMaps, saveMap, deleteMap, parseYouTubeUrl, serializeMap, importMap } from './mindmap-core.js?v=20260918-independent-players-5';
import { createIdeaRecorder } from './idea-recorder.js?v=20260918-independent-players-5';
import { createYouTubePlayer } from './youtube-player.js?v=20260918-independent-players-5';
import { createMapLibrary, nextMapTitle } from './mindmap-library.js?v=20260919-saved-library-1';

if (new URLSearchParams(location.search).get('world') === 'maker') initMindMaps();

function initMindMaps() {
  const $ = id => document.getElementById(id);
  const el = Object.fromEntries(['mindMapWorkspace','savedMaps','newMap','importMap','mapFile','mapMessage','mapEmpty','mapEditor','mapTitle','mapSaveStatus','saveMap','exportMap','deleteMap','youtubeForm','youtubeUrl','youtubeStatus','videoDropZone','videoSize','videoStage','videoContext','videoActions','openYoutube','removeVideo','addChild','addSibling','removeNode','arrangeMap','zoomOut','zoomIn','fitMap','mapZoom','mapViewport','mapSpace','mapCanvas','mapConnections','mapNodes','nodeLabel','nodeNotes','nodeParent','nodeVideoPanel','nodeYoutubeForm','nodeYoutubeUrl','nodeYoutubeStatus','nodeVideoActions','nodeVideoPlayer','nodeVideoStage','nodeVideoSize','openNodeYoutube','removeNodeVideo'].map(id => [id, $(id)]));
  let current = null, selectedId = null, maps = [], revision = 0, savedRevision = 0;
  const mainPlayer = createYouTubePlayer(el.videoStage, 'Your video appears here. You can also map without a video.');
  const ideaPlayer = createYouTubePlayer(el.nodeVideoStage);
  let saveTimer = 0, queue = Promise.resolve(), busy = false, scale = 1, boardWidth = 720, boardHeight = 440;
  const uid = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const selected = () => current?.nodes.find(node => node.id === selectedId);
  const message = text => { el.mapMessage.textContent = text; el.mapMessage.hidden = !text; };
  const report = error => message(error?.name === 'QuotaExceededError' ? 'This browser is out of storage. Export your map now to keep a copy, then free some space and try Save now.' : error?.message || 'The map could not be saved. Export a backup and try again.');
  const ideaRecorder = createIdeaRecorder({
    root: $('ideaRecorder'),
    prepare: async scope => {
      const matches = () => current?.id === scope.mapId && selectedId === scope.nodeId && !!selected();
      if (!matches()) throw new Error('Select the idea again before recording.');
      await persist();
      if (!matches()) throw new Error('The selected idea changed before the camera was ready.');
    },
  });
  const library = createMapLibrary($('mapLibrary'), {
    onOpen: id => withSavedMap(() => {
      const map = maps.find(map => map.id === id);
      if (!map) throw new Error('This map is no longer in the library. Reload the page to refresh your saved maps.');
      openMap(map);
    }),
  });
  el.mindMapWorkspace.hidden = false;
  // Presentation only: always start at Regular, without changing saved map data.
  for (const [select, panel] of [[el.videoSize, el.videoDropZone], [el.nodeVideoSize, el.nodeVideoPanel]]) {
    select.value = 'regular';
    panel.dataset.videoSize = 'regular';
    select.addEventListener('change', () => {
      const size = ['regular', 'large', 'very-large'].includes(select.value) ? select.value : 'regular';
      select.value = size;
      panel.dataset.videoSize = size;
      // Resize only this player's CSS; never replace either iframe.
    });
  }

  function refreshLibrary() {
    library.update(maps, current?.id || null);
  }

  function changed() {
    revision++;
    current.updatedAt = new Date().toISOString();
    el.mapSaveStatus.textContent = 'Unsaved changes…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => persist().catch(report), 400);
  }

  // Snapshot before queuing; a later edit must never be marked saved by an older write.
  function persist() {
    clearTimeout(saveTimer);
    if (!current) return queue;
    if (revision === savedRevision) return queue;
    const snapshot = structuredClone(current), version = revision;
    el.mapSaveStatus.textContent = 'Saving…';
    const task = queue.catch(() => {}).then(() => saveMap(snapshot));
    queue = task.then(saved => {
      const index = maps.findIndex(map => map.id === snapshot.id);
      if (index < 0) maps.push(saved); else maps[index] = saved;
      if (current?.id === snapshot.id) {
        savedRevision = Math.max(savedRevision, version);
        el.mapSaveStatus.textContent = revision === savedRevision ? 'Saved in this browser' : 'Unsaved changes…';
        refreshLibrary();
      }
    }).catch(error => {
      if (current?.id === snapshot.id) el.mapSaveStatus.textContent = 'Not saved — export a backup or retry';
      throw error;
    });
    return queue;
  }

  async function withSavedMap(action, saveFirst = true) {
    if (busy) return;
    busy = true;
    // Prevent edits during navigation while the current map is being committed.
    el.mapEditor.inert = true;
    el.videoDropZone.inert = true;
    el.newMap.disabled = el.importMap.disabled = true;
    library.setBusy(true);
    try { if (saveFirst) await persist(); else { clearTimeout(saveTimer); await queue.catch(() => {}); } await action(); message(''); }
    catch (error) { report(error); refreshLibrary(); renderInspector(); }
    finally { busy = false; el.mapEditor.inert = el.videoDropZone.inert = false; el.newMap.disabled = el.importMap.disabled = false; library.setBusy(false); }
  }

  function openMap(map) {
    ideaRecorder.setIdea(null);
    // Stop the previous map's playback even if the next map links the same video.
    mainPlayer.clear();
    ideaPlayer.clear();
    el.nodeVideoPlayer.hidden = true;
    current = map ? structuredClone(map) : null;
    revision = savedRevision = 0;
    selectedId = current?.nodes.find(node => node.parentId === null)?.id;
    el.mapEmpty.hidden = !!current;
    el.mapEditor.hidden = !current;
    el.videoDropZone.hidden = !current;
    library.clearSearch();
    refreshLibrary();
    if (!current) return;
    el.mapTitle.value = current.title;
    el.mapSaveStatus.textContent = 'Saved in this browser';
    el.youtubeUrl.value = current.video?.url || '';
    el.youtubeUrl.removeAttribute('aria-invalid');
    el.youtubeStatus.textContent = '';
    renderVideo();
    scale = 1;
    renderMap();
    renderInspector();
    fitMap();
  }

  function descendants(id) {
    const result = new Set([id]);
    const pending = [id];
    while (pending.length) {
      const parent = pending.pop();
      for (const node of current.nodes) if (node.parentId === parent && !result.has(node.id)) { result.add(node.id); pending.push(node.id); }
    }
    return result;
  }

  function renderInspector() {
    const node = selected();
    ideaRecorder.setIdea(node ? {mapId:current.id,nodeId:node.id,label:node.label || 'Untitled idea'} : null);
    if (!node) return;
    el.nodeLabel.value = node.label;
    el.nodeNotes.value = node.notes;
    el.removeNode.disabled = el.addSibling.disabled = node.parentId === null;
    el.nodeParent.disabled = node.parentId === null;
    el.nodeParent.replaceChildren();
    if (node.parentId === null) el.nodeParent.add(new Option('Main idea', ''));
    else {
      const excluded = descendants(node.id);
      for (const parent of current.nodes) if (!excluded.has(parent.id)) el.nodeParent.add(new Option(parent.label || 'Untitled idea', parent.id));
      el.nodeParent.value = node.parentId;
    }
    renderNodeVideo();
  }

  function selectNode(id) {
    selectedId = id;
    for (const button of el.mapNodes.children) button.setAttribute('aria-pressed', String(button.dataset.id === id));
    renderInspector();
  }

  function resizeBoard() {
    boardWidth = Math.max(720, ...current.nodes.map(node => node.x + 220));
    boardHeight = Math.max(440, ...current.nodes.map(node => node.y + 128));
    el.mapCanvas.style.width = `${boardWidth}px`;
    el.mapCanvas.style.height = `${boardHeight}px`;
    el.mapConnections.setAttribute('width', boardWidth);
    el.mapConnections.setAttribute('height', boardHeight);
    applyZoom();
  }

  function applyZoom() {
    el.mapCanvas.style.transform = `scale(${scale})`;
    el.mapSpace.style.width = `${boardWidth * scale}px`;
    el.mapSpace.style.height = `${boardHeight * scale}px`;
    el.mapZoom.textContent = `${Math.round(scale * 100)}%`;
  }

  function fitMap() {
    if (!current) return;
    scale = Math.max(.08, Math.min(1, el.mapViewport.clientWidth / boardWidth, el.mapViewport.clientHeight / boardHeight));
    applyZoom(); el.mapViewport.scrollTo(0, 0);
  }

  function drawConnections() {
    const nodes = new Map(current.nodes.map(node => [node.id, node]));
    el.mapConnections.replaceChildren();
    for (const node of current.nodes) {
      const parent = nodes.get(node.parentId);
      if (!parent) continue;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const x1 = parent.x + 170, y1 = parent.y + 39, x2 = node.x, y2 = node.y + 39;
      const bend = Math.max(50, Math.abs(x2 - x1) / 2);
      path.setAttribute('d', `M${x1},${y1} C${x1+bend},${y1} ${x2-bend},${y2} ${x2},${y2}`);
      el.mapConnections.append(path);
    }
  }

  function nodeText(button, node) {
    button.replaceChildren();
    const label = document.createElement('span'); label.className = 'map-node-label'; label.textContent = node.label || 'Untitled idea'; button.append(label);
    const details = [node.notes ? 'Has notes' : '', node.video ? 'Has video' : ''].filter(Boolean);
    if (details.length) { const note = document.createElement('small'); note.textContent = details.join(' · '); button.append(note); }
    button.setAttribute('aria-label', `${node.label || 'Untitled idea'}${details.length ? `, ${details.join(', ').toLowerCase()}` : ''}`);
    button.title = node.label;
  }

  function moveNode(node, button, x, y) {
    node.x = Math.max(20, Math.min(10000, x)); node.y = Math.max(20, Math.min(10000, y));
    button.style.left = `${node.x}px`; button.style.top = `${node.y}px`;
    resizeBoard(); drawConnections();
  }

  function renderMap() {
    el.mapNodes.replaceChildren();
    for (const node of current.nodes) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'map-node'; button.dataset.id = node.id;
      button.dataset.root = String(node.parentId === null); button.setAttribute('aria-pressed', String(node.id === selectedId));
      button.style.left = `${node.x}px`; button.style.top = `${node.y}px`;
      nodeText(button, node);
      button.addEventListener('click', () => selectNode(node.id));
      let drag = null;
      button.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        selectNode(node.id);
        drag = {pointerId:event.pointerId, x:event.clientX, y:event.clientY, nodeX:node.x, nodeY:node.y, scrollX:el.mapViewport.scrollLeft, scrollY:el.mapViewport.scrollTop, moved:false};
        button.setPointerCapture(event.pointerId);
      });
      button.addEventListener('pointermove', event => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        const dx = event.clientX-drag.x, dy = event.clientY-drag.y;
        if (!drag.moved && Math.hypot(dx,dy) < 4) return;
        drag.moved = true;
        moveNode(node, button, drag.nodeX+(dx+el.mapViewport.scrollLeft-drag.scrollX)/scale, drag.nodeY+(dy+el.mapViewport.scrollTop-drag.scrollY)/scale);
        // Mark movement immediately so leaving mid-drag still prompts a save.
        changed();
      });
      const endDrag = () => { drag = null; };
      button.addEventListener('pointerup', endDrag); button.addEventListener('pointercancel', endDrag); button.addEventListener('lostpointercapture', endDrag);
      button.addEventListener('keydown', event => {
        if (!event.altKey || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
        event.preventDefault(); selectNode(node.id);
        const step = event.shiftKey ? 50 : 10;
        moveNode(node, button, node.x+(event.key==='ArrowRight'?step:event.key==='ArrowLeft'?-step:0), node.y+(event.key==='ArrowDown'?step:event.key==='ArrowUp'?-step:0));
        changed();
      });
      el.mapNodes.append(button);
    }
    resizeBoard(); drawConnections();
  }

  function addBranch(sibling = false) {
    if (!current || !selected()) return;
    if (current.nodes.length >= 500) { message('This map has reached 500 ideas. Create another map to continue.'); return; }
    const parent = sibling ? current.nodes.find(node => node.id === selected().parentId) : selected();
    if (!parent) return;
    const siblings = current.nodes.filter(node => node.parentId === parent.id);
    const node = {id:uid(),parentId:parent.id,label:'New idea',notes:'',video:null,x:Math.min(10000,parent.x+230),y:Math.min(10000,parent.y+siblings.length*110)};
    current.nodes.push(node); selectedId = node.id;
    renderMap(); renderInspector(); changed();
    const button = [...el.mapNodes.children].find(item => item.dataset.id === node.id);
    button?.scrollIntoView({block:'nearest',inline:'nearest'});
    el.nodeLabel.focus({preventScroll:true}); el.nodeLabel.select();
  }

  function arrangeMap() {
    const children = new Map(current.nodes.map(node => [node.id, []]));
    current.nodes.forEach(node => children.get(node.parentId)?.push(node));
    let row = 0;
    const position = (node, depth) => {
      const branches = children.get(node.id);
      node.x = 40 + depth * 230;
      if (!branches.length) node.y = 30 + row++ * 110;
      else { branches.forEach(child => position(child, depth+1)); node.y = (branches[0].y + branches.at(-1).y) / 2; }
    };
    position(current.nodes.find(node => node.parentId === null), 0);
    // Keep auto-layout within the same bounds accepted by import/storage validation.
    const maxX = Math.max(...current.nodes.map(node=>node.x)), maxY = Math.max(...current.nodes.map(node=>node.y));
    current.nodes.forEach(node=>{if(maxX>10000)node.x*=10000/maxX;if(maxY>10000)node.y*=10000/maxY;});
    renderMap(); fitMap(); changed();
  }

  function renderVideo() {
    // The main player belongs to the map, never to the selected branch.
    const video = current?.video;
    el.videoContext.textContent = 'Map video';
    el.videoActions.hidden = !video;
    if (video) el.openYoutube.href = video.url; else el.openYoutube.removeAttribute('href');
    mainPlayer.show(video, current?.id, 'YouTube video for this mind map');
  }

  function renderNodePlayer() {
    const node = selected();
    el.nodeVideoPlayer.hidden = !node?.video;
    ideaPlayer.show(node?.video, node ? `${current.id}:${node.id}` : null, `YouTube video for idea: ${node?.label || 'Untitled idea'}`);
  }

  function renderNodeVideo(status = '') {
    const node = selected();
    el.nodeYoutubeUrl.value = node?.video?.url || '';
    el.nodeYoutubeUrl.removeAttribute('aria-invalid');
    el.nodeYoutubeStatus.textContent = status;
    el.nodeVideoActions.hidden = !node?.video;
    if (node?.video) el.openNodeYoutube.href = node.video.url;
    else el.openNodeYoutube.removeAttribute('href');
    renderNodePlayer();
  }

  function refreshNodeBadge(node) {
    const button = [...el.mapNodes.children].find(item => item.dataset.id === node.id);
    if (button) nodeText(button, node);
  }

  function loadNodeVideo(value) {
    const node = selected();
    if (!node) return;
    try {
      const video = parseYouTubeUrl(value);
      if (node.video?.url !== video.url) { node.video = video; refreshNodeBadge(node); changed(); }
      renderNodeVideo('Video linked to this idea. Press play in the player below.');
    } catch (error) {
      el.nodeYoutubeUrl.setAttribute('aria-invalid', 'true');
      el.nodeYoutubeStatus.textContent = `${error.message}${node.video ? ' The existing video is unchanged.' : ''}`;
    }
  }

  function removeBranchVideo(node) {
    if (!node?.video) return;
    node.video = null;
    refreshNodeBadge(node);
    if (selectedId === node.id) renderNodeVideo('Video removed from this idea.');
    changed();
  }

  function loadVideo(value) {
    if (!current) return;
    try {
      const video = parseYouTubeUrl(value);
      if (current.video?.url !== video.url) { current.video=video; changed(); }
      renderVideo();
      el.youtubeUrl.value=video.url; el.youtubeUrl.removeAttribute('aria-invalid');
      el.youtubeStatus.textContent='Video linked. Press play in the player.';
    } catch (error) { el.youtubeUrl.setAttribute('aria-invalid','true'); el.youtubeStatus.textContent=error.message; }
  }

  el.newMap.addEventListener('click', () => withSavedMap(async () => { const map=await saveMap(createMap(nextMapTitle(maps))); maps=await listMaps(); openMap(map); requestAnimationFrame(()=>{el.mapTitle.focus(); el.mapTitle.select();}); }));
  el.mapTitle.addEventListener('input', () => { current.title=el.mapTitle.value; changed(); });
  el.saveMap.addEventListener('click', () => persist().then(()=>message('')).catch(report));
  el.nodeLabel.addEventListener('input', () => { const node=selected(); node.label=el.nodeLabel.value; const button=[...el.mapNodes.children].find(item=>item.dataset.id===node.id); nodeText(button,node); ideaRecorder.setIdea({mapId:current.id,nodeId:node.id,label:node.label || 'Untitled idea'}); renderNodePlayer(); changed(); });
  el.nodeNotes.addEventListener('input', () => { const node=selected(); node.notes=el.nodeNotes.value; const button=[...el.mapNodes.children].find(item=>item.dataset.id===node.id); nodeText(button,node); changed(); });
  el.nodeParent.addEventListener('change', () => { const node=selected(), id=el.nodeParent.value; if(node.parentId===null||descendants(node.id).has(id)||!current.nodes.some(item=>item.id===id))return; node.parentId=id; renderMap(); changed(); });
  el.addChild.addEventListener('click',()=>addBranch()); el.addSibling.addEventListener('click',()=>addBranch(true));
  el.removeNode.addEventListener('click',()=>{
    const node=selected(); if(!node?.parentId)return;
    const ids=descendants(node.id);
    if(!confirm(`Delete this idea${ids.size>1?` and its ${ids.size-1} descendant ideas`:''}, including their recorded videos? Download any recordings you want to keep first.`))return;
    ideaRecorder.discardIdeas(current.id, ids);
    selectedId=node.parentId;current.nodes=current.nodes.filter(item=>!ids.has(item.id));
    renderMap();renderInspector();changed();persist().catch(report);
  });
  el.arrangeMap.addEventListener('click',arrangeMap);
  el.zoomOut.addEventListener('click',()=>{scale=Math.max(.08,scale/1.25);applyZoom();});
  el.zoomIn.addEventListener('click',()=>{scale=Math.min(1.75,scale*1.25);applyZoom();}); el.fitMap.addEventListener('click',fitMap);
  el.youtubeForm.addEventListener('submit',event=>{event.preventDefault();loadVideo(el.youtubeUrl.value);});
  function bindVideoInput(input, panel, load) {
    input.addEventListener('paste', event => { const text=event.clipboardData?.getData('text/plain'); if(text){event.preventDefault();input.value=text;load(text);} });
    panel.addEventListener('dragover', event => { if([...event.dataTransfer.types].some(type=>['text/plain','text/uri-list'].includes(type))){event.preventDefault();event.dataTransfer.dropEffect='copy';} });
    panel.addEventListener('drop', event => {
      event.preventDefault();
      const uri=event.dataTransfer.getData('text/uri-list').split(/\r?\n/).find(line=>line&&!line.startsWith('#'));
      const value=uri||event.dataTransfer.getData('text/plain');
      input.value=value;load(value);
    });
  }
  bindVideoInput(el.youtubeUrl, el.videoDropZone, loadVideo);
  bindVideoInput(el.nodeYoutubeUrl, el.nodeVideoPanel, loadNodeVideo);
  el.nodeYoutubeForm.addEventListener('submit',event=>{event.preventDefault();loadNodeVideo(el.nodeYoutubeUrl.value);});
  el.removeNodeVideo.addEventListener('click',()=>removeBranchVideo(selected()));
  el.removeVideo.addEventListener('click',()=>{
    current.video=null;el.youtubeUrl.value='';el.youtubeUrl.removeAttribute('aria-invalid');el.youtubeStatus.textContent='Map video removed.';renderVideo();changed();
  });
  el.deleteMap.addEventListener('click',()=>{if(!confirm(`Delete “${current.title || 'Untitled mind map'}” and all its idea recordings from this browser? Export the map and download any recordings you want to keep first.`))return;withSavedMap(async()=>{const id=current.id;ideaRecorder.discardIdeas(id);await deleteMap(id);maps=maps.filter(map=>map.id!==id);openMap(maps[0]||null);},false);});
  el.exportMap.addEventListener('click',()=>{
    try { const blob=new Blob([serializeMap(current)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`${(current.title||'mind-map').replace(/[^\p{L}\p{N}_-]+/gu,'-').slice(0,80)||'mind-map'}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000); }
    catch(error){report(error);}
  });
  el.importMap.addEventListener('click',()=>el.mapFile.click());
  el.mapFile.addEventListener('change',()=>withSavedMap(async()=>{
    const file=el.mapFile.files[0];el.mapFile.value='';if(!file)return;
    if(file.size>8*1024*1024)throw new Error('This file is too large. Choose a mind-map JSON backup under 8 MB.');
    const map=await saveMap(importMap(await file.text()));maps=await listMaps();openMap(map);
  }));
  // Backgrounding saves text only. Do not pause, hide, remount or reload media here.
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')persist().catch(report);});
  window.addEventListener('pageshow',event=>{if(event.persisted)renderInspector();});
  window.addEventListener('beforeunload',event=>{if((current&&revision!==savedRevision)||ideaRecorder.hasUnfinished()){persist().catch(()=>{});event.preventDefault();event.returnValue='';}});
  el.newMap.disabled = el.importMap.disabled = true;
  library.setBusy(true);
  listMaps().then(saved=>{maps=saved;openMap(maps[0]||null);}).catch(error=>{report(error);library.setError();}).finally(()=>{el.newMap.disabled = el.importMap.disabled = false;library.setBusy(false);});
}
