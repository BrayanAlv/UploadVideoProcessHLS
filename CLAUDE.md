# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install            # install dependencies
npm start              # production: node src/index.js
npm run dev            # development with nodemon auto-reload
```

- **No test suite exists.** `npm test` intentionally exits 1. `test-db.js` (verifies a MongoDB URI) and `trigger.js` (injects a fake job into the BullMQ queue via a local Redis on 127.0.0.1:6379) are ad-hoc dev scripts, run with `node test-db.js` / `node trigger.js`.
- **Docker (worker):** `docker-compose up --build`. `Dockerfile.worker` is `node:22-alpine` + `apk add ffmpeg` — FFmpeg/FFprobe come from the image, not npm. The compose file expects an external Redis reachable at host `redis-studio` on the `proxy` network.
- **FFmpeg is a hard system dependency** for local (non-Docker) runs. Install with `sudo apt install ffmpeg`.
- Swagger UI is served at `http://localhost:3000/api-docs` when running.

## Environment variables

There is no committed `.env` or `.env.example`; `/storage/` and `.env` are gitignored. Required vars, gathered from the code:

- **Mongo:** `MONGO_URI`, `DB_NAME` (note: `test-db.js` reads `MONGODB_URI` — a different name — so keep both if using that script)
- **Redis:** `REDIS_HOST` (default `localhost`), `REDIS_PORT` (default `6379`)
- **Backblaze B2 (S3-compatible), used by `b2Service.js`:** `B2_ENDPOINT`, `B2_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BUCKET_NAME` — plus many optional tuning vars (`B2_MAX_ATTEMPTS`, `B2_REQUEST_TIMEOUT_MS`, `B2_MAX_SOCKETS`, etc.)
- **Reconciler:** `RECONCILER_INTERVAL_MS` (default 5 min), `RECONCILER_STALE_MS` (default 2 min)
- `s3Service.js` uses different credential var names (`B2_APPLICATION_KEY_ID`, `B2_REGION`) but that file is unused (see below).

## Architecture

This is an **asynchronous video → HLS transcoding worker** that plugs into an existing CRM. It is not a standalone app: it operates on a shared MongoDB `Contenido` collection that an external CRM populates, and stores media in Backblaze B2.

`src/index.js` boots everything in one process: connects to MongoDB *first*, then dynamically imports and starts the BullMQ worker + reconciler, then starts the Express API. The worker must not be created before the Mongo connection exists (`bufferCommands` is disabled, so premature queries throw immediately).

### The real processing pipeline (production path)

The primary way videos enter processing is **not** the upload endpoint — it's the **reconciler** (`startReconciler` in `src/workers/videoWorker.js`). It polls the `Contenido` collection on an interval and enqueues any doc that (a) is in a supported `carpeta` (`Videos`, `FormacionVendedores`), (b) has a `fileKey`, and (c) is `queued`, has no `videoProcessing` sub-doc yet, or is `processing` but stale. This makes the system self-healing: the CRM just writes a `Contenido` doc with a `fileKey` and the worker eventually picks it up. Jobs use a deterministic `jobId` (`video-<id>`) to dedupe.

The worker (`createWorker`, `concurrency: 1`) per job:
1. Loads the `Contenido` doc; resolves B2 destination folders from `carpeta` via the `STORAGE_PATHS` map.
2. **Downloads** the original from B2 (`streamFile` by `fileKey`/`s3Key`, optionally a `fileId` version) into `storage/temp-processing/<videoId>/raw/`.
3. Probes metadata (`ffmpegService.getVideoMetadata`), generates a thumbnail and a VTT preview sprite.
4. Transcodes to HLS variants based on source height: `720p` if ≥720, `1080p` if ≥1080, otherwise a single downscaled-to-even-dimensions variant. Writes per-variant `playlist.m3u8` + `.ts` segments and a `master.m3u8`.
5. **Uploads** the whole HLS + thumbnail tree back to B2 (`uploadFolderToB2`, recursive).
6. Writes results/progress back onto the doc's `videoProcessing` sub-document (`status`, `progress`, `availableQualities`, `is720pReady`, `hlsFolder`, etc.), then **deletes the local temp dir** in `finally`.

All DB writes go through dotted `$set` on `videoProcessing.<key>` so they never clobber sibling fields. `src/services/videoProcessing.service.js` is a standalone helper for this, but the worker inlines its own `updateVideoProcessing` closure — the two do the same thing.

### The upload API (secondary / partially legacy path)

`src/routes/videoRoutes.js` + `videoController.js` expose a self-contained flow: `POST /api/videos/upload` (multer saves to local `storage/uploads`, then enqueues) plus list/status/detail endpoints. **Caveat:** this path and several stream endpoints predate the B2 pipeline and are inconsistent with it:
- The upload path sets `s3Key` to a *local disk path*, not a B2 key.
- `streamVideo`, `getHLSMaster`, `getHLSPlaylist`, `getHLSSegment` read from `storage/videos/<id>/...` on local disk — a layout the current B2 worker never produces (it writes to `storage/temp-processing` and then deletes it). Treat these stream endpoints as legacy; real playback is served from B2.
- Job payload keys are inconsistent across producers: the controller emits `fileID` (capital D), `enqueueVideoProcessing` emits `fileId`, and the worker reads `fileID`. Check the exact casing before relying on it.

### Data model

One Mongoose model matters: `src/models/Contenido.js` (collection `Contenido`, shared with the CRM). Its `videoProcessing` embedded sub-schema (`_id: false`) holds all pipeline state. `src/models/Video.js` is an **unused** standalone model kept only for its large commented-out reference of the real `Contenido` document shape (useful when you need to know what other CRM fields exist).

### B2 service (`src/services/b2Service.js`)

The substantive storage layer. Wraps the AWS S3 SDK against B2, adds: an in-memory LRU cache for files ≤2 MB (150 MB cap, 1 h TTL), retry-with-backoff on retriable errors (`withB2Retry`), HTTP keep-alive agent, byte-range streaming (`streamFile` supports `Range` and B2 `VersionId` via `fileId`), and multipart-upload helpers. `src/services/s3Service.js` and `src/services/storageService.js` are older/unused alternatives — prefer `b2Service.js`.

### Dead code note

The codebase carries substantial commented-out blocks (old `streamVideo` with on-the-fly HEVC→H.264 transcoding, alternate route wiring, the `Video.js` schema dump). These are historical; don't treat them as active behavior.

## Language / conventions

- ES modules (`"type": "module"`) on Express 5, Mongoose 9, BullMQ 5. Node 18+ (Docker uses Node 22).
- Logs and user-facing strings are in **Spanish**; match that when adding them.
- Resource limits are deliberate for a small VPS: worker `concurrency: 1`, `--max-old-space-size` tuning, FFmpeg thread limits. Preserve these constraints unless explicitly scaling up.
