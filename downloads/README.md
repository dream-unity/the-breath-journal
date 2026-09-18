# Dream Unity desktop download helper

The website stays on GitHub Pages. This optional helper runs on **your computer**,
downloads a public YouTube video you are entitled to save, and produces either an
MP4 video or a real MP3 audio file. Files save directly into
`Downloads/Dream Unity` in your home folder. Journal text and mind maps are never
sent to the helper. This is a desktop workflow; it does not run inside an Android
or iPhone browser.

## Setup

1. Install Python 3.10 or later from [python.org](https://www.python.org/downloads/).
2. Install the current yt-dlp package and its default dependencies **using the
   same Python interpreter you will use to start the helper**:

   ```sh
   python -m pip install --upgrade "yt-dlp[default]"
   ```

   On systems that name Python `python3`, use `python3` in both commands. A virtual
   environment is also supported; activate it before installation and startup.
3. Install [FFmpeg and ffprobe](https://ffmpeg.org/download.html), and add their
   executable folder to your PATH. Installing a Python package named `ffmpeg`
   does not provide these programs.
4. Install [Deno](https://docs.deno.com/runtime/getting_started/installation/) 2.3
   or newer, the runtime recommended by yt-dlp. Node.js 22 or newer also works.
   The helper checks the version and enables a supported Deno or Node runtime
   and checks for the `yt-dlp-ejs` package included by `yt-dlp[default]`.
5. Save `dream-unity-helper.py`, then run:

   ```sh
   python dream-unity-helper.py
   ```

6. Keep the terminal open. Beneath the map or idea's YouTube player, choose
   **Download setup**, paste the connection token printed in the
   terminal, and choose **Connect helper**. Allow your browser's local-network permission if requested. Then
   choose the video or MP3 download action. **Open downloads folder** opens the
   fixed output folder in your computer's file manager.

The token is regenerated each time the helper starts. Treat it as a password to
this helper session. Nothing installs automatically. Press Ctrl+C to stop the
helper and cancel unfinished work.

## Output and limits

- Video: MP4 with audio, up to 1080p, when YouTube offers compatible streams. The
  helper does not silently substitute another file type when MP4 is unavailable.
- Audio: FFmpeg encodes a 192 kbit/s MP3 from the available audio stream. MP3
  conversion does not improve the source audio quality.
- Each request downloads the **whole video**; a mind map's playback timestamp
  does not trim the output.
- One download/conversion runs at a time. Maximum source duration: three hours.
  Live videos are excluded. Maximum working files and final file: 2 GiB;
  merging/conversion can require more than the final file's size, so a download
  may reach the working-file limit before its final file would reach 2 GiB.
  Each job has a one-hour timeout and limited network retries.
- Completed files receive a unique video-ID/date/job-ID filename. Existing files
  are never overwritten. Unfinished files remain in temporary staging and are
  removed after completion, failure or cancellation. Force-killing the computer
  or process can leave a hidden `.dream-unity-*` temporary folder; it is safe to
  remove it after stopping the helper.
- The destination must support hard links (normal NTFS, APFS and Linux local
  filesystems do). This lets the helper publish a completed file atomically;
  unsupported filesystems produce an error instead of exposing a partial file.
- Job status is kept only in memory, for the last 30 jobs. Restarting the helper
  clears its job history, but does not remove finished files.
- YouTube can restrict availability or change its delivery mechanisms. There is
  no guarantee that every video will download. Update yt-dlp when needed. The
  helper does not read browser cookies, sign into accounts, bypass access checks,
  use proxies, or fetch executable runtime components.

See [yt-dlp dependencies](https://github.com/yt-dlp/yt-dlp#dependencies),
[JavaScript runtime requirements](https://github.com/yt-dlp/yt-dlp/wiki/EJS), and
[YouTube extractor notes](https://github.com/yt-dlp/yt-dlp/wiki/Extractors#youtube).

## Local API

The helper binds only to `127.0.0.1:8766`. It requires the exact Host header and a
`Bearer` token for every API request. Write requests also require the origin
`https://dream-unity.github.io`; CORS preflights are checked separately. To allow
the development site at `http://localhost:8765`, start with `--dev` explicitly.
The helper never binds to the public network. Browser local-network permission
or an incompatible browser policy can still block a connection.

| Endpoint | Response or request |
| --- | --- |
| `GET /health` | `{version:1, ready, missing:[], folder}` |
| `POST /jobs` | `{videoId, format:"video" or "mp3", clientRequestId}`; returns HTTP 202 and job status |
| `GET /jobs/<id>` | `{id, videoId, format, state, message, filename?}` |
| `DELETE /jobs/<id>` | Requests cancellation and returns current job status |
| `POST /open-folder` | Requires exactly `{}`; opens the fixed output folder |

States are `queued`, `running`, `complete`, `error` and `cancelled`. API errors
return `{message}` with an appropriate HTTP error status. `clientRequestId` must
contain 16–128 ASCII letters, digits, underscores or hyphens. Repeating the same
ID and payload returns the existing job while it remains in history; changing
the payload for that ID is rejected. Poll until cancellation reaches a terminal
state before starting another job. File contents are not served by the API.

Run the helper tests from the repository root:

```sh
python -m unittest discover -s tests -p 'test_download_helper.py' -v
```

These tests use a controlled fake extractor process. They test authorization,
request validation, argument isolation, real process cancellation, staging,
errors, limits and duplicate requests; they do not claim that a live YouTube
download succeeded.
