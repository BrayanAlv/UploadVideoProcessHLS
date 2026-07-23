# Graph Report - .  (2026-07-23)

## Corpus Check
- Corpus is ~16,671 words - fits in a single context window. You may not need a graph.

## Summary
- 149 nodes · 199 edges · 11 communities (8 shown, 3 thin omitted)
- Extraction: 95% EXTRACTED · 5% INFERRED · 0% AMBIGUOUS · INFERRED: 9 edges (avg confidence: 0.79)
- Token cost: 0 input · 32,476 output

## Community Hubs (Navigation)
- B2 Storage Service
- CLAUDE.md Architecture Notes
- Video Worker & FFmpeg Pipeline
- App Boot & Data Model
- Runtime Dependencies
- Video API Controller & Upload
- Package Metadata & Scripts
- S3Service (Unused Legacy)
- LocalStorageService (Unused Legacy)
- Video.js Model (Unused Legacy)

## God Nodes (most connected - your core abstractions)
1. `withB2Retry()` - 13 edges
2. `BullMQ Video Worker (createWorker)` - 10 edges
3. `streamFile()` - 7 edges
4. `FFmpegService` - 6 edges
5. `S3Service` - 6 edges
6. `uploadFile()` - 5 edges
7. `Reconciler (startReconciler)` - 5 edges
8. `Contenido Mongoose Model` - 5 edges
9. `scripts` - 4 edges
10. `LocalStorageService` - 4 edges

## Surprising Connections (you probably didn't know these)
- `Video Processing System MVP` --semantically_similar_to--> `Async Video to HLS Transcoding Worker`  [INFERRED] [semantically similar]
  README.md → CLAUDE.md
- `Upload Workflow (Upload to Queue to Worker)` --semantically_similar_to--> `Upload API (videoRoutes/videoController, legacy)`  [INFERRED] [semantically similar]
  README.md → CLAUDE.md
- `Local Storage Structure (uploads/processed/thumbnails/temp)` --semantically_similar_to--> `HLS Variant Transcoding`  [INFERRED] [semantically similar]
  README.md → CLAUDE.md
- `docker-compose.test.yml (isolated test env)` --semantically_similar_to--> `docker-compose worker service`  [INFERRED] [semantically similar]
  documentacion.md → docker-compose.yml
- `docker-compose worker service` --references--> `BullMQ Video Worker (createWorker)`  [INFERRED]
  docker-compose.yml → CLAUDE.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Production Video Processing Pipeline** — claude_reconciler, claude_bullmq_worker, claude_b2service, claude_ffmpegservice, claude_contenido_model [EXTRACTED 0.85]
- **Storage Layer Alternatives** — claude_b2service, claude_s3service_unused, claude_storageservice_unused [INFERRED 0.75]
- **Isolated Worker Docker Test Flow** — documentacion_test_compose, documentacion_trigger_script, documentacion_dockerfile_worker, claude_bullmq_worker [EXTRACTED 0.85]

## Communities (11 total, 3 thin omitted)

### Community 0 - "B2 Storage Service"
Cohesion: 0.11
Nodes (27): abortMultipartUpload(), B2_APP_RETRIES, B2_CONNECTION_TIMEOUT_MS, B2_MAX_ATTEMPTS, B2_REQUEST_TIMEOUT_MS, B2_RETRY_BASE_DELAY_MS, _cache, _cacheDelete() (+19 more)

### Community 1 - "CLAUDE.md Architecture Notes"
Cohesion: 0.12
Nodes (24): b2Service (Backblaze B2 Storage Layer), BullMQ Video Worker (createWorker), Contenido Mongoose Model, ffmpegService (metadata/transcode helper), HLS Variant Transcoding, src/index.js Boot Sequence, Deterministic jobId Deduplication, Reconciler (startReconciler) (+16 more)

### Community 2 - "Video Worker & FFmpeg Pipeline"
Cohesion: 0.13
Nodes (12): FFmpegService, createWorker(), enqueueVideoProcessing(), getStoragePaths(), jobIdFor(), STORAGE_PATHS, uploadFolderToB2(), VIDEO_STATUS (+4 more)

### Community 3 - "App Boot & Data Model"
Cohesion: 0.15
Nodes (9): connectDB(), redisConfig, options, swaggerSpec, app, errorHandler(), contenidoSchema, videoProcessingSchema (+1 more)

### Community 4 - "Runtime Dependencies"
Cohesion: 0.13
Nodes (15): dependencies, @aws-sdk/client-s3, @aws-sdk/s3-request-presigner, bullmq, cors, dotenv, express, fluent-ffmpeg (+7 more)

### Community 5 - "Video API Controller & Upload"
Cohesion: 0.22
Nodes (10): getHLSMaster(), getHLSPlaylist(), getHLSSegment(), getVideoDetail(), getVideoStatus(), listVideos(), streamVideo(), uploadVideo() (+2 more)

### Community 6 - "Package Metadata & Scripts"
Cohesion: 0.17
Nodes (11): description, devDependencies, nodemon, main, name, scripts, dev, start (+3 more)

## Knowledge Gaps
- **46 isolated node(s):** `name`, `version`, `description`, `main`, `type` (+41 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **3 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `upload` connect `Video API Controller & Upload` to `S3Service (Unused Legacy)`?**
  _High betweenness centrality (0.051) - this node is a cross-community bridge._
- **What connects `name`, `version`, `description` to the rest of the system?**
  _48 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `B2 Storage Service` be split into smaller, more focused modules?**
  _Cohesion score 0.10574712643678161 - nodes in this community are weakly interconnected._
- **Should `CLAUDE.md Architecture Notes` be split into smaller, more focused modules?**
  _Cohesion score 0.11594202898550725 - nodes in this community are weakly interconnected._
- **Should `Video Worker & FFmpeg Pipeline` be split into smaller, more focused modules?**
  _Cohesion score 0.12631578947368421 - nodes in this community are weakly interconnected._
- **Should `Runtime Dependencies` be split into smaller, more focused modules?**
  _Cohesion score 0.13333333333333333 - nodes in this community are weakly interconnected._