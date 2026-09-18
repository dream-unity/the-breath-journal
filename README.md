# Dream Unity journals

A static GitHub Pages site with three portals:

| Portal | URL |
| --- | --- |
| Video Journal | `journal.html?world=machine` |
| Mind-Mapping Videos | `journal.html?world=maker` |
| World Perspectives | `journal.html?world=reality` |

## Artwork front page

The home page uses the approved graphite artwork in `assets/dream-unity-portals.webp`, encoded at its original 1254 × 1254 dimensions. Each entire portal ring is a native circular link, including its inner title area. Image and click areas share one square container, so their alignment survives viewport changes. The side links take precedence where their rings overlap the central ring, matching the drawing. The surrounding large ring and the square corners of each hit area's bounding box are inactive.

The landing page needs no JavaScript, preserves normal browser zoom, and supports keyboard navigation in left-to-right order with a visible focus ring. Existing journal routes and browser-local data are unchanged.

## Mind-Mapping Videos

Choose **New map**, name it, and select an idea to edit its text and notes. **Add branch** connects a new idea to the selected idea; **Add sibling** connects it to the same parent. Drag ideas, use Alt + arrow keys, or choose **Arrange**. The **Connect to** field moves an idea's branch under another idea while preventing cycles. Zoom and **Fit map** help navigate larger maps.

Paste or drag a YouTube video link into the video panel. Standard watch, Share, Shorts, Live and embed links are supported, including start timestamps. The video link is saved with its map. Playback needs internet access and connects to YouTube; unavailable or embed-restricted videos can be opened using **Open on YouTube**.

Every idea can also have its own YouTube link. Select a branch and use **YouTube video for this idea**, below its recording controls, to paste, drop or enter a link. **Has video** marks linked branches. Its player appears directly beneath that idea's link field. The main map player at the top remains independent: selecting or editing ideas, and adding, replacing or removing a branch link, never replaces or reloads the main video. Both players have independent Regular (the default), Large and Very large sizes. Branch links are saved automatically and included in exported backups; older maps still load normally.

Switching browser tabs or applications does not cause the app to pause or rebuild its media players. Saving and refreshing recording lists also preserve unchanged players. Browser, operating-system and YouTube restrictions may still limit background playback; the site cannot override those restrictions. Changing the selected idea removes that idea's inline players; navigating to another map or page also ends its scoped playback.

**Record video for this idea**, immediately beneath the selected idea's notes, records your camera and microphone. Enable the camera, start recording, then finish to save. Recordings are attached to the exact map and idea, and can be played, downloaded or deleted only from that idea's inspector. They never appear in the shared YouTube player or the general video journal. Switching ideas stops the camera, removes the previous idea's players, and saves any active recording to its original idea. Camera permission requests and delayed saves cannot transfer recordings to another idea.

Idea recordings are stored locally in a separate store within the mind-map database. Map JSON exports contain text and YouTube links, **not recorded video files**; download recordings from their owning idea for separate video backups. Imported maps are independent copies and do not gain access to the original map's recordings. Deleting an idea (including descendant ideas) or a map also deletes its recordings. If saving fails, the recording remains available for retry or download in its original idea while the page stays open.

Maps save automatically in IndexedDB in the same browser profile and device. They are **not cloud-synced**. Clearing site data or using a temporary/private browser session may remove them. Use **Export map** for a JSON backup and **Import backup** to restore or transfer a map. Import creates a separate copy, never overwriting an existing map. Storage failures are shown explicitly; save status changes to saved only after the database transaction commits.

Existing video recordings and reflections remain in the unchanged `dream-unity-video-journal` database, with their original `machine`, `maker` and `reality` identifiers. Mind-Mapping Videos uses only the recorder attached to each idea; its former general recording section is no longer displayed, and existing stored data is retained. Mind maps use the separate `dream-unity-mind-maps` database.

## Development

No build step or runtime dependencies are required. Serve the repository over HTTP, for example `python3 -m http.server 8765`. The test suite uses a development-only IndexedDB implementation.

Run parser, map validation, import/export, recording lifecycle and storage transaction tests with:

```sh
npm ci
npm test
```

YouTube embeds use privacy-enhanced URLs with a strict host allowlist, an explicit referrer policy, inline playback, and a fallback watch link. User-entered map text is rendered as text, never HTML.
