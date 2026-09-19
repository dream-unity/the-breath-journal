/** Visible navigation for saved maps. This component never edits or deletes a map. */
export function createMapLibrary(root, { onOpen } = {}) {
  const doc = root.ownerDocument;
  const list = root.querySelector('[data-map-list]');
  const search = root.querySelector('[data-map-search]');
  const clear = root.querySelector('[data-map-clear]');
  const count = root.querySelector('[data-map-count]');
  const status = root.querySelector('[data-map-results]');
  const empty = root.querySelector('[data-map-empty]');
  const cards = new Map();
  const dates = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  let maps = [], currentId = null, busy = false, state = 'loading';

  function render() {
    const query = search.value.trim().toLocaleLowerCase();
    const ordered = [...maps].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id));
    const ids = new Set(ordered.map(map => map.id));
    for (const [id, card] of cards) {
      if (!ids.has(id)) { card.item.remove(); cards.delete(id); }
    }
    let visible = 0;
    ordered.forEach((map, index) => {
      let card = cards.get(map.id);
      if (!card) {
        const item = doc.createElement('li');
        const button = doc.createElement('button');
        button.type = 'button'; button.className = 'map-library-card';
        const title = doc.createElement('strong'); title.className = 'map-library-title';
        const meta = doc.createElement('span'); meta.className = 'map-library-meta';
        const action = doc.createElement('span'); action.className = 'map-library-open';
        button.append(title, meta, action); item.append(button);
        button.addEventListener('click', () => {
          if (!busy && map.id !== currentId) onOpen?.(map.id);
        });
        card = { item, button, title, meta, action }; cards.set(map.id, card);
      }
      const title = map.title?.trim() || 'Untitled mind map';
      const isCurrent = map.id === currentId;
      card.title.textContent = title;
      card.meta.textContent = `${map.nodes.length} ${map.nodes.length === 1 ? 'idea' : 'ideas'} · Saved ${dates.format(new Date(map.updatedAt))}`;
      card.action.textContent = isCurrent ? 'Currently open' : 'Open map →';
      card.button.setAttribute('aria-label', `${isCurrent ? 'Currently open' : 'Open map'}: ${title}`);
      if (isCurrent) card.button.setAttribute('aria-current', 'true');
      else card.button.removeAttribute('aria-current');
      card.button.disabled = busy;
      card.item.hidden = !title.toLocaleLowerCase().includes(query);
      if (!card.item.hidden) visible++;
      // Keep existing buttons mounted through autosaves and searches.
      if (list.children[index] !== card.item) list.insertBefore(card.item, list.children[index] || null);
    });
    count.textContent = state === 'loading' ? 'Loading…' : `${maps.length} saved ${maps.length === 1 ? 'map' : 'maps'}`;
    search.disabled = busy || state === 'loading' || (!maps.length && !query);
    clear.hidden = !query;
    clear.disabled = busy;
    status.textContent = query ? `${visible} of ${maps.length} saved maps shown.` : '';
    empty.hidden = visible > 0;
    empty.textContent = state === 'loading' ? 'Loading your saved mind maps…'
      : query ? 'No titles match your search. Clear the search to see all saved maps.'
      : state === 'error' ? 'Your saved maps could not be loaded. Reload this page to try again.'
      : 'No saved maps yet. Choose New map to begin.';
    if (state === 'error' && !maps.length) count.textContent = 'Unable to load';
  }

  search.addEventListener('input', render);
  clear.addEventListener('click', () => { search.value = ''; render(); search.focus(); });
  render();
  return {
    update(nextMaps, nextCurrentId) { maps = nextMaps; currentId = nextCurrentId; state = 'ready'; render(); },
    setBusy(value) { busy = value; render(); },
    setError() { state = 'error'; render(); },
    clearSearch() { search.value = ''; render(); },
  };
}

/** Distinguish new maps before the user gives them their own titles. */
export function nextMapTitle(maps) {
  const titles = new Set(maps.map(map => map.title?.trim().toLocaleLowerCase()));
  let number = 1;
  while (titles.has(`mind map ${number}`)) number++;
  return `Mind map ${number}`;
}
