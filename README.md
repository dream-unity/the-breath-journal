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

Every idea can also have its own video. Select a branch and use **Video for this idea**, directly below its notes, to paste, drop or enter a YouTube link. **Has video** marks linked branches. Selecting one shows its video in the centred player at the top; **Watch video** takes you to that player. **Watch map video** returns to the map's main video. Regular (the default), Large and Very large sizes apply to both map and branch playback. Branch links are saved automatically and included in exported backups; older maps still load normally.

Maps save automatically in IndexedDB in the same browser profile and device. They are **not cloud-synced**. Clearing site data or using a temporary/private browser session may remove them. Use **Export map** for a JSON backup and **Import backup** to restore or transfer a map. Import creates a separate copy, never overwriting an existing map. Storage failures are shown explicitly; save status changes to saved only after the database transaction commits.

Existing video recordings and reflections remain in the unchanged `dream-unity-video-journal` database, with their original `machine`, `maker` and `reality` identifiers. The maker portal's local recordings are accessible in **Record or revisit your local videos**. Mind maps use the separate `dream-unity-mind-maps` database.

## Development

No build step or dependencies are required. Serve the repository over HTTP, for example `python3 -m http.server 8765`.

Run parser, map validation, import/export and storage transaction tests with:

```sh
node --test tests/*.mjs
```

YouTube embeds use privacy-enhanced URLs with a strict host allowlist, an explicit referrer policy, inline playback, and a fallback watch link. User-entered map text is rendered as text, never HTML.
