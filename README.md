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

### YouTube video and MP3 downloads

**Download video** and **Download MP3** appear immediately below every main and idea YouTube player. These use the optional **Dream Unity Download Helper**, running on the same Windows, macOS or Linux computer as the browser. The GitHub Pages site cannot extract media from a YouTube iframe by itself. Follow [the setup guide](downloads/setup.html) to install Python, yt-dlp, FFmpeg/ffprobe and Deno, run [the helper](downloads/dream-unity-helper.py), and enter its connection code beneath a player. No hosted conversion service is used.

The helper saves complete MP4 videos (up to 1080p, when available) or 192 kbps MP3 audio to the home folder's `Downloads/Dream Unity` directory. A link's playback timestamp does not trim a download. Progress, cancellation and the completed filename stay attached to the exact player/idea that requested the job; **Open downloads folder** opens the completed files on the computer. Switching ideas does not retarget a job or interrupt the main player. The helper handles one job at a time and continues independently of the page; reloading the page clears its in-memory connection and progress display, but saved files remain in the Downloads folder.

Connections are explicit and use a temporary pairing code kept only in page memory. Requests send only a YouTube video ID, output format and random request ID; map titles, notes, recordings and browser cookies are not sent. The helper binds only to `127.0.0.1`, validates the website origin and host, and requires its bearer code. Request IDs make a retry after an uncertain response idempotent. Download commands ignore external yt-dlp configuration and plugins; the web API cannot supply arbitrary URLs, commands or output paths. The browser may ask for local-network permission. Phones and tablets cannot connect to a helper on another computer.

Download only content you own or have permission to save. YouTube can restrict downloads even when a video plays in an embed. Protected, private, live, unavailable and over-limit sources fail with an explanation; the helper does not sign in or import cookies. It limits jobs to one hour, sources to three hours and working files to 2 GiB, removes unfinished files on cancellation/failure, and publishes completed files without overwriting existing downloads. Keep yt-dlp updated if YouTube changes its delivery system.

**Record video for this idea**, immediately beneath the selected idea's notes, records your camera and microphone. Enable the camera, start recording, then finish to save. Recordings are attached to the exact map and idea, and can be played, downloaded or deleted only from that idea's inspector. They never appear in the shared YouTube player or the general video journal. Switching ideas stops the camera, removes the previous idea's players, and saves any active recording to its original idea. Camera permission requests and delayed saves cannot transfer recordings to another idea.

Idea recordings are stored locally in a separate store within the mind-map database. Map JSON exports contain text and YouTube links, **not recorded video files**; download recordings from their owning idea for separate video backups. Imported maps are independent copies and do not gain access to the original map's recordings. Deleting an idea (including descendant ideas) or a map also deletes its recordings. If saving fails, the recording remains available for retry or download in its original idea while the page stays open.

Maps save automatically in IndexedDB in the same browser profile and device. They are **not cloud-synced**. Clearing site data or using a temporary/private browser session may remove them. Use **Export map** for a JSON backup and **Import backup** to restore or transfer a map. Import creates a separate copy, never overwriting an existing map. Storage failures are shown explicitly; save status changes to saved only after the database transaction commits.

Existing video recordings and reflections remain in the unchanged `dream-unity-video-journal` database, with their original `machine`, `maker` and `reality` identifiers. The maker portal's local recordings are accessible in **Record or revisit your local videos**. Mind maps use the separate `dream-unity-mind-maps` database.

## Development

No build step or runtime dependencies are required. Serve the repository over HTTP, for example `python3 -m http.server 8765`. The test suite uses a development-only IndexedDB implementation.

Run parser, map validation, import/export, recording lifecycle and storage transaction tests with:

```sh
npm ci
npm test
python3 -m unittest discover -s tests -p 'test_*.py'
```

The Python helper tests use isolated temporary folders and fake download processes; they do not download YouTube content. See [helper development notes](downloads/README.md) for the API and dependency details. Use `--dev` only when testing the helper with a site served at `http://localhost:8765`.

YouTube embeds use privacy-enhanced URLs with a strict host allowlist, an explicit referrer policy, inline playback, and a fallback watch link. User-entered map text is rendered as text, never HTML.
