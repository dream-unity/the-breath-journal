# Hosted video and MP3 downloads

This is the replacement for the visitor-installed desktop helper. A visitor clicks **Download video** or **Download MP3** beneath a player; the server prepares the file and the browser starts an attachment download. No visitor installation, account, connection code, or local-network permission is involved.

**Status: prepared for deployment, not activated on the public site.** The existing public entry points remain unchanged until this service passes the live checks below. Local tests cannot establish that YouTube will accept requests from the hosting network.

## Components

- `api/jobs.mjs` is the small Vercel gateway. It validates requests from the Dream Unity site and starts jobs on a shared Sandbox worker using a private server credential.
- `bootstrap.py` installs the pinned downloader packages and native FFmpeg, then starts `service.py` inside the Sandbox. Visitors never run this script.
- `service.py` processes downloads and streams completed files from the Sandbox's public port. File bytes bypass the Vercel Function.
- `worker/helper.py` is an exact copy of the existing, tested download engine. Keep it synchronized with `../downloads/dream-unity-helper.py`; the gateway tests check this.
- `../hosted-youtube-downloads.js` provides the two-button interface. Jobs remain associated with their original map or idea; it does not modify either YouTube player.

The gateway uses Vercel's deployment identity for Sandbox access. A private service credential is generated inside the worker. Each accepted job gets a separate random capability for progress, cancellation, and its completed file. Neither the service credential nor deployment identity is sent to the browser. Visitor job capabilities stay in page memory.

## Deploy and activate

1. Create a dedicated Vercel project from this repository with **Root Directory: `server-downloads`**. Use the committed Node version, dependency lockfile, and `vercel.json`. The project is self-contained; access to files outside its root is unnecessary. Confirm Sandbox access and account quotas before deploying; no account upgrade is required by this code.
2. Verify that the deployed gateway can create or resume the shared Sandbox through Vercel OIDC. Ensure the public API and worker URLs are reachable from the GitHub Pages origin without a Vercel login.
3. Complete every live check below. If extraction fails from the hosting network, resolve the hosting limitation before changing the public buttons. Do not substitute unverified external converters or claim an unavailable file was downloaded.
4. In `../mindmap.js`, replace the `youtube-downloads.js` import with `hosted-youtube-downloads.js` and pass the verified production gateway origin as `serviceUrl` to both `createYouTubeDownloads` calls. Keep the existing `setVideo(video, owner)` calls and player containers. Update the script cache version in the page and the root README to reflect the hosted behavior.
5. Recheck the actual GitHub Pages page after publishing. Visitors should see two buttons and job progress, with no helper setup section.

The gateway origin is public configuration, not a secret. Use the stable production project domain, not an expiring preview URL. Rollback consists of restoring the previous frontend import; existing map and recording data do not need migration.

## Required live verification

- Download a permitted, publicly available YouTube video as MP4 from the deployed service. Inspect the saved file's video and audio streams and play it.
- Convert the same online source to MP3. Inspect the saved file and play it. Do not substitute a generated local fixture for this check.
- Download a completed file larger than 4.5 MB through the worker's public URL to check the actual serving path.
- From the GitHub Pages origin, click once and verify that the browser saves the completed file. Check the user's desktop/ChromeOS browser; automatic download behavior remains subject to browser settings.
- Start a job under one idea, select another idea, and confirm it neither retargets the job nor resets either YouTube iframe. Return to the original idea to see its result.
- Verify cancellation, rejected sources, expired links, and a fresh request after the Sandbox resumes. Check a near-timeout worker as well as a cold start.

## Limits and maintenance

The worker processes one job at a time, with limits of three accepted starts per client per hour and ten globally per hour. It allows up to 512 MiB of working media and 15 minutes of processing per job. Completed files expire after 15 minutes; an active file stream is protected from cleanup. Transfers are limited to one at a time per file, two globally, and three attempts per file. The whole linked video is downloaded; a playback timestamp does not trim it.

These are public-service resource limits, not a guarantee of unlimited availability. Sandbox session, compute, and transfer quotas also apply. The gateway refuses new work when it cannot obtain enough remaining session time to finish processing and retain the file; a plan's session cap can cause temporary unavailability until the worker resumes. Verify this behavior against the actual account before activation. YouTube may reject extraction from particular hosting networks or for particular sources. Private, protected, live, or otherwise unavailable videos are not bypassed; no browser cookies, account credentials, or proxy services are imported. Update the pinned downloader deliberately when YouTube changes its delivery system, then repeat the live checks.

## Local verification

From the repository root:

```sh
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p 'test_*.py'
python3 -m unittest discover -s server-downloads -p 'test_*.py'
cd server-downloads
npm ci
npm test
npm run build
```

Automated tests exercise request validation, ownership, cancellation, expiry, streamed attachments, and the browser component with controlled responses. They do not establish live YouTube availability or create cloud resources.
