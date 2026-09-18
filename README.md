# Dream Unity journals

A static GitHub Pages site with three portals:

| Portal | URL |
| --- | --- |
| Video Journal | `journal.html?world=machine` |
| Mind-Mapping Videos | `journal.html?world=maker` |
| World Perspectives | `journal.html?world=reality` |

## Mind-Mapping Videos

Choose **New map**, name it, and select an idea to edit its text and notes. **Add branch** connects a new idea to the selected idea; **Add sibling** connects it to the same parent. Drag ideas, use Alt + arrow keys, or choose **Arrange**. The **Connect to** field moves an idea's branch under another idea while preventing cycles. Zoom and **Fit map** help navigate larger maps.

Paste or drag a YouTube video link into the video panel. Standard watch, Share, Shorts, Live and embed links are supported, including start timestamps. The video link is saved with its map. Playback needs internet access and connects to YouTube; unavailable or embed-restricted videos can be opened using **Open on YouTube**.

Maps save automatically in IndexedDB in the same browser profile and device. They are **not cloud-synced**. Clearing site data or using a temporary/private browser session may remove them. Use **Export map** for a JSON backup and **Import backup** to restore or transfer a map. Import creates a separate copy, never overwriting an existing map. Storage failures are shown explicitly; save status changes to saved only after the database transaction commits.

Existing video recordings and reflections remain in the unchanged `dream-unity-video-journal` database, with their original `machine`, `maker` and `reality` identifiers. The maker portal's local recordings are accessible in **Record or revisit your local videos**. Mind maps use the separate `dream-unity-mind-maps` database.

## Development

No build step or dependencies are required. Serve the repository over HTTP, for example `python3 -m http.server 8765`.

Run parser, map validation, import/export and storage transaction tests with:

```sh
node --test tests/*.mjs
```

YouTube embeds use privacy-enhanced URLs with a strict host allowlist, an explicit referrer policy, inline playback, and a fallback watch link. User-entered map text is rendered as text, never HTML.
