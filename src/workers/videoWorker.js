// videoWorker.js
import {Worker, Queue} from 'bullmq';
import {redisConfig} from '../config/db.js';
import Contenido from "../models/Contenido.js";
import {ffmpegService} from '../services/ffmpegService.js';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import {streamFile, uploadFile, deleteFolder} from '../services/b2Service.js';
import {updateReprocessEvent} from '../services/reprocessHistory.service.js';

dotenv.config();

const queueName = 'video-processing';
export const videoQueue = new Queue(queueName, {connection: redisConfig});

// Cuántos videos se procesan a la vez. Configurable por env, default 1.
export const WORKER_CONCURRENCY = Math.max(1, Number(process.env.WORKER_CONCURRENCY || 1));

export const VIDEO_STATUS = Object.freeze({
    UPLOADED: 'uploaded',
    QUEUED: 'queued',
    PROCESSING: 'processing',
    COMPLETED: 'completed',
    FAILED: 'failed',
    ERROR: 'error',
});

const STORAGE_PATHS = Object.freeze({
    Videos: {
        hls: 'Videos/HLS',
        thumbnails: 'Videos/Thumbnails',
    },
    FormacionVendedores: {
        hls: 'FormacionVendedores/HLS',
        thumbnails: 'FormacionVendedores/Thumbnails',
    },
});

function getStoragePaths(carpeta) {
    if (carpeta && STORAGE_PATHS[carpeta]) return STORAGE_PATHS[carpeta];
    throw new Error(`Carpeta "${carpeta}" sin rutas HLS configuradas`);
}

async function uploadFolderToB2(localDirPath, b2FolderPath) {
    const entries = fs.readdirSync(localDirPath, {withFileTypes: true});

    for (const entry of entries) {
        const fullLocalPath = path.join(localDirPath, entry.name);

        if (entry.isDirectory()) {
            await uploadFolderToB2(fullLocalPath, `${b2FolderPath}/${entry.name}`);
        } else {
            const fileBuffer = fs.readFileSync(fullLocalPath);

            let mimeType = 'application/octet-stream';
            if (entry.name.endsWith('.m3u8')) mimeType = 'application/vnd.apple.mpegurl';
            else if (entry.name.endsWith('.ts')) mimeType = 'video/MP2T';
            else if (entry.name.endsWith('.jpg') || entry.name.endsWith('.jpeg')) mimeType = 'image/jpeg';
            else if (entry.name.endsWith('.webp')) mimeType = 'image/webp';
            else if (entry.name.endsWith('.vtt')) mimeType = 'text/vtt';

            await uploadFile(fileBuffer, b2FolderPath, entry.name, mimeType);
        }
    }
}

function jobIdFor(videoId) {
    return `video-${videoId}`;
}

// Arma la info de la preview generada (dimensiones + tamaño) para mostrarla en
// el panel. Nunca lanza: si algo falla, devuelve lo que pudo.
async function buildCardPreviewInfo(cardPath, source, previewKeyUsed) {
    let width = null, height = null, bytes = null;
    try { const m = await ffmpegService.getVideoMetadata(cardPath); width = m.width || null; height = m.height || null; } catch { /* ignore */ }
    try { bytes = fs.statSync(cardPath).size; } catch { /* ignore */ }
    return { source, width, height, bytes, format: 'webp', previewKeyUsed: previewKeyUsed || null, updatedAt: new Date() };
}

// Núcleo de procesamiento compartido entre el Worker de BullMQ (producción) y el
// script/endpoint de reproceso manual. `options.replaceExisting` borra el HLS y
// thumbnails viejos en B2 antes de subir los nuevos (evita segmentos huérfanos).
export async function processVideoJob(data, options = {}) {
        const {videoId, s3Key} = data;
        const fileID = data.fileID ?? data.fileId ?? null;
        const replaceExisting = options.replaceExisting ?? data.replaceExisting ?? false;
        // 'full' = video (HLS) + preview; 'preview' = solo regenerar la card preview.
        const mode = options.mode ?? data.mode ?? 'full';
        // Historial: solo se registra si viene reprocessEventId (reproceso manual/script).
        const reprocessEventId = data.reprocessEventId ?? null;
        const startedAt = Date.now();
        const logEvent = (patch) =>
            reprocessEventId ? updateReprocessEvent(videoId, reprocessEventId, patch).catch(() => {}) : Promise.resolve();
        console.log(`[Worker] Buscando Contenido con _id: ${videoId}`);
        const contenido = await Contenido.findById(videoId);
        console.log(`[Worker] Resultado findById: ${contenido ? 'ENCONTRADO' : 'NO ENCONTRADO'}`);
        if (!contenido) {
            console.error(`[Worker] Contenido ${videoId} no existe en colección Contenido`);
            throw new Error(`Contenido ${videoId} no encontrado`);
        }

        let paths;
        try {
            paths = getStoragePaths(contenido.carpeta);
        } catch (pathErr) {
            await Contenido.updateOne(
                {_id: videoId},
                {$set: {'videoProcessing.status': VIDEO_STATUS.ERROR, 'videoProcessing.errorMessage': pathErr.message}}
            );
            throw pathErr;
        }

        const updateVideoProcessing = async (updates) => {
            const setData = {};
            Object.entries(updates).forEach(([key, value]) => {
                setData[`videoProcessing.${key}`] = value;
            });
            await Contenido.updateOne({_id: videoId}, {
                $set: setData
            });
        };

        // ── Modo "solo preview": regenera únicamente la card.webp, sin descargar
        //    el video ni rehacer el HLS. Rápido y barato (ideal al cambiar la
        //    previewKey). No toca videoProcessing.status del HLS.
        if (mode === 'preview') {
            const thumbnailFolder = `${paths.thumbnails}/${videoId}`;
            const tmpDir = path.join(process.cwd(), 'storage', 'temp-processing', `${videoId}-preview`);
            try {
                if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, {recursive: true});
                await logEvent({status: 'processing', mode: 'preview'});

                const sourceKey = contenido.previewKey || contenido.videoProcessing?.thumbnailPath;
                if (!sourceKey) throw new Error('No hay previewKey ni thumbnail para generar la preview');

                const srcExt = path.extname(sourceKey) || '.img';
                const srcPath = path.resolve(tmpDir, `src${srcExt}`);
                const srcStream = await streamFile(sourceKey);
                await new Promise((resolve, reject) => {
                    const w = fs.createWriteStream(srcPath);
                    srcStream.body.pipe(w);
                    w.on('finish', resolve);
                    w.on('error', reject);
                });

                const cardPath = await ffmpegService.generateCardPreview(srcPath, tmpDir, 'card.webp');
                await uploadFile(fs.readFileSync(cardPath), thumbnailFolder, 'card.webp', 'image/webp');

                const info = await buildCardPreviewInfo(cardPath, contenido.previewKey ? 'custom' : 'frame', contenido.previewKey || null);
                await updateVideoProcessing({ cardPreviewPath: `${thumbnailFolder}/card.webp`, cardPreviewInfo: info });
                await logEvent({ status: 'completed', finishedAt: new Date(), durationMs: Date.now() - startedAt, mode: 'preview' });
                console.log(`[Worker] Preview regenerada (solo preview) para ${contenido.nombre || videoId}`);
                return;
            } catch (error) {
                console.error(`[Worker] Error preview-only ${videoId}:`, error.message);
                await logEvent({ status: 'failed', finishedAt: new Date(), errorMessage: error.message, durationMs: Date.now() - startedAt, mode: 'preview' });
                throw error;
            } finally {
                if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, {recursive: true, force: true});
            }
        }

        console.log(`[Worker] Iniciando procesamiento para: ${contenido.nombre || videoId}`);
        // Resolución previa (para el historial: "de X a Y").
        const fromResolution = contenido.videoProcessing?.originalResolution || null;
        const videoDir = path.join(process.cwd(), 'storage', 'temp-processing', videoId.toString());

        const rawDir = path.join(videoDir, 'raw');
        const hlsDir = path.join(videoDir, 'hls');
        const thumbDir = path.join(videoDir, 'thumbnails');

        try {
            if (!fs.existsSync(rawDir)) fs.mkdirSync(rawDir, {recursive: true});
            if (!fs.existsSync(hlsDir)) fs.mkdirSync(hlsDir, {recursive: true});
            if (!fs.existsSync(thumbDir)) fs.mkdirSync(thumbDir, {recursive: true});

            await updateVideoProcessing({
                status: VIDEO_STATUS.PROCESSING, progress: 0
            });
            await logEvent({ status: 'processing', fromResolution, mode: 'full' });

            console.log(`[Worker] s3Key del job: "${s3Key}", contenido.fileKey: "${contenido.fileKey}"`);
            let s3KeySegura = s3Key || contenido.fileKey || 'video.mp4';
            console.log(`[Worker] Usando s3Key: "${s3KeySegura}"`);
            const originalExt = path.extname(s3KeySegura);
            const newRawPath = path.resolve(rawDir, `original${originalExt}`);
            console.log(`[Worker] Descargando video original desde B2 Key: ${s3KeySegura}`);

            const b2Stream = await streamFile(s3KeySegura, {
                fileId: fileID
            });

            const localFileWriter = fs.createWriteStream(newRawPath);

            await new Promise((resolve, reject) => {
                b2Stream.body.pipe(localFileWriter);
                localFileWriter.on('finish', resolve);
                localFileWriter.on('error', reject);
            });

            console.log('[Worker] Descarga completada.');

            const metadata = await ffmpegService.getVideoMetadata(newRawPath);

            const height = metadata.height || 0;
            const width = metadata.width || 0;

            await ffmpegService.generateThumbnail(newRawPath, thumbDir, 'thumbnail.jpg');

            await ffmpegService.generatePreviewVtt(newRawPath, thumbDir, videoId);

            // Preview para las cards del home (WebP proporcional). Si el video
            // tiene una previewKey custom, se usa esa imagen; si no, el thumbnail.
            // Nunca rompe el job: ante cualquier error cae al thumbnail o se omite.
            let cardPreviewGenerated = false;
            let cardPreviewInfo = null;
            let cardPreviewSource = 'frame';
            const thumbnailLocalPath = path.join(thumbDir, 'thumbnail.jpg');
            const cardLocalPath = path.join(thumbDir, 'card.webp');
            try {
                let cardSource = thumbnailLocalPath;
                if (contenido.previewKey) {
                    try {
                        const previewExt = path.extname(contenido.previewKey) || '.img';
                        const previewSrcPath = path.resolve(rawDir, `preview-src${previewExt}`);
                        const previewStream = await streamFile(contenido.previewKey);
                        await new Promise((resolve, reject) => {
                            const w = fs.createWriteStream(previewSrcPath);
                            previewStream.body.pipe(w);
                            w.on('finish', resolve);
                            w.on('error', reject);
                        });
                        cardSource = previewSrcPath;
                        cardPreviewSource = 'custom';
                        console.log(`[Worker] Preview custom descargada: ${contenido.previewKey}`);
                    } catch (dlErr) {
                        console.warn(`[Worker] No se pudo bajar la previewKey (${contenido.previewKey}): ${dlErr.message}. Uso el thumbnail.`);
                        cardSource = thumbnailLocalPath;
                        cardPreviewSource = 'frame';
                    }
                }
                await ffmpegService.generateCardPreview(cardSource, thumbDir, 'card.webp');
                cardPreviewGenerated = true;
            } catch (cardErr) {
                // Segundo intento desde el thumbnail por si falló con la imagen custom.
                try {
                    await ffmpegService.generateCardPreview(thumbnailLocalPath, thumbDir, 'card.webp');
                    cardPreviewGenerated = true;
                    cardPreviewSource = 'frame';
                } catch (card2Err) {
                    console.warn(`[Worker] No se pudo generar card.webp: ${card2Err.message}. Se omite.`);
                }
            }
            if (cardPreviewGenerated) {
                cardPreviewInfo = await buildCardPreviewInfo(cardLocalPath, cardPreviewSource, cardPreviewSource === 'custom' ? contenido.previewKey : null);
            }

            await updateVideoProcessing({
                duration: metadata.duration,
                originalResolution: `${width}x${height}`,
                originalSize: fs.statSync(newRawPath).size,
            });

            const tasks = [];

            // Los perfiles "720p"/"1080p" hacen referencia al lado corto del
            // frame. En un video horizontal el lado corto es la altura; en uno
            // vertical es el ancho. Sin esto, un video vertical se escalaba y
            // rellenaba (pillarbox) dentro de un cuadro horizontal fijo.
            const isVertical = height > width;
            const shortSide = isVertical ? width : height;

            // Escalera de bitrate por resolución (CPU/libx264). Antes todas las
            // calidades se capaban a 2000k, dejando el 1080p con baja calidad.
            if (shortSide >= 720) {
                tasks.push({
                    label: '720p',
                    resolution: isVertical ? '720x1280' : '1280x720',
                    maxrate: '3000k',
                    bufsize: '6000k',
                    bandwidth: 3300000,
                    readyFlag: 'is720pReady'
                });
            }

            if (shortSide >= 1080) {
                tasks.push({
                    label: '1080p',
                    resolution: isVertical ? '1080x1920' : '1920x1080',
                    maxrate: '6000k',
                    bufsize: '12000k',
                    bandwidth: 6600000,
                    readyFlag: 'is1080pReady'
                });
            }

            if (tasks.length === 0 && height > 0) {
                const minShortSide = 240;
                const minLongSide = 426;
                const safeHeight = Math.max(Math.floor(height / 2) * 2, isVertical ? minLongSide : minShortSide);
                const safeWidth = Math.max(Math.floor(width / 2) * 2, isVertical ? minShortSide : minLongSide);
                tasks.push({
                    label: `${isVertical ? safeWidth : safeHeight}p`,
                    resolution: `${safeWidth}x${safeHeight}`,
                    maxrate: '1500k',
                    bufsize: '3000k',
                    bandwidth: 1650000,
                    readyFlag: null
                });
            }

            const availableQualities = ['original'];
            const masterPlaylistLines = ['#EXTM3U', '#EXT-X-VERSION:3'];

            let lastProgress = -1;
            let isSavingProgress = false;

            for (let i = 0; i < tasks.length; i++) {
                const task = tasks[i];
                console.log(`[Worker] FFmpeg -> ${task.label}`);
                const variantDir = path.join(hlsDir, task.label);
                if (!fs.existsSync(variantDir)) {
                    fs.mkdirSync(variantDir, {recursive: true});
                }

                await ffmpegService.generateHLS(newRawPath, variantDir, task.resolution, async (percent) => {
                    const totalProgress = Math.min(99, Math.round(((i + (percent / 100)) / tasks.length) * 100));
                    if (totalProgress !== lastProgress && !isSavingProgress) {
                        lastProgress = totalProgress;
                        isSavingProgress = true;
                        try {
                            await updateVideoProcessing({
                                progress: totalProgress
                            });
                        } finally {
                            isSavingProgress = false;
                        }
                    }
                }, {maxrate: task.maxrate, bufsize: task.bufsize});

                availableQualities.push(task.label);

                const updates = {
                    availableQualities
                };

                if (task.readyFlag) {
                    updates[task.readyFlag] = true;
                }

                await updateVideoProcessing(updates);
                const bandwidth = task.bandwidth || 2500000;
                masterPlaylistLines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${task.resolution}`);
                masterPlaylistLines.push(`${task.label}/playlist.m3u8`);
            }

            const masterPath = path.join(hlsDir, 'master.m3u8');
            fs.writeFileSync(masterPath, masterPlaylistLines.join('\n'));
            const folderDestinoB2 = `${paths.hls}/${videoId}`;
            const thumbnailFolder = `${paths.thumbnails}/${videoId}`;

            // Reproceso: borrar el HLS/thumbnails viejos en B2 antes de subir los
            // nuevos, para no dejar segmentos huérfanos (ej. los .ts landscape del
            // procesamiento anterior) ocupando espacio.
            if (replaceExisting) {
                console.log(`[Worker] replaceExisting: limpiando B2 ${folderDestinoB2} y ${thumbnailFolder}`);
                const removed = (await deleteFolder(folderDestinoB2)) + (await deleteFolder(thumbnailFolder));
                console.log(`[Worker] Objetos viejos borrados en B2: ${removed}`);
            }

            console.log(`[Worker] Subiendo HLS a ${folderDestinoB2}`);
            await uploadFolderToB2(hlsDir, folderDestinoB2);
            await uploadFolderToB2(thumbDir, thumbnailFolder);
            await updateVideoProcessing({
                status: VIDEO_STATUS.COMPLETED,
                progress: 100,
                hlsFolder: folderDestinoB2,
                masterPlaylist: 'master.m3u8',
                thumbnailPath: `${thumbnailFolder}/thumbnail.jpg`,
                cardPreviewPath: cardPreviewGenerated ? `${thumbnailFolder}/card.webp` : null,
                cardPreviewInfo: cardPreviewInfo,
                previewVttPath: `${thumbnailFolder}/preview_${videoId}.vtt`,
                availableQualities,
                is720pReady: availableQualities.includes('720p'),
                is1080pReady: availableQualities.includes('1080p')
            });
            await logEvent({
                status: 'completed',
                finishedAt: new Date(),
                toResolution: `${width}x${height}`,
                orientation: isVertical ? 'vertical' : 'horizontal',
                availableQualities,
                durationMs: Date.now() - startedAt,
                mode: 'full',
            });
            console.log(`[Worker] Procesamiento finalizado para ${contenido.nombre || videoId}`);
        } catch (error) {
            console.error(`[Worker] Error procesando ${videoId}:`, error.message);
            await updateVideoProcessing({
                status: VIDEO_STATUS.FAILED, errorMessage: error.message
            });
            await logEvent({
                status: 'failed',
                finishedAt: new Date(),
                errorMessage: error.message,
                durationMs: Date.now() - startedAt,
                mode: 'full',
            });
            throw error;
        } finally {
            if (fs.existsSync(videoDir)) {
                console.log(`[Worker] Limpiando ${videoDir}`);
                fs.rmSync(videoDir, {
                    recursive: true, force: true
                });
            }
        }
}

export function createWorker() {
    return new Worker(queueName, async (job) => {
        console.log(`[Worker] Job ${job.id} recibido. Data:`, JSON.stringify(job.data));
        return processVideoJob(job.data, {replaceExisting: job.data?.replaceExisting, mode: job.data?.mode});
    }, {
        connection: redisConfig,
        concurrency: WORKER_CONCURRENCY
    });
}

export async function enqueueVideoProcessing({videoId, s3Key, fileId}) {
    return videoQueue.add(
        'process-video',
        {videoId, s3Key, fileId: fileId ?? null},
        {jobId: jobIdFor(videoId)}
    );
}

export function startReconciler(model, enqueueFn) {
    const SUPPORTED_FOLDERS = ['Videos', 'FormacionVendedores'];
    const INTERVAL_MS = Number(process.env.RECONCILER_INTERVAL_MS || 5 * 60 * 1000);
    const STALE_QUEUED_MS = Number(process.env.RECONCILER_STALE_MS || 2 * 60 * 1000);

    async function reconcileOnce() {
        try {
            const cutoff = new Date(Date.now() - STALE_QUEUED_MS);
            const docs = await model.find({
                carpeta: { $in: SUPPORTED_FOLDERS },
                fileKey: { $exists: true, $nin: ['', null] },
                $or: [
                    { 'videoProcessing.status': 'queued' },
                    {
                        'videoProcessing.status': { $exists: false },
                        videoProcessing: { $exists: false }
                    },
                    {
                        'videoProcessing.status': 'processing',
                        'videoProcessing.progress': { $lt: 100 },
                        creadoEn: { $lt: cutoff }
                    }
                ]
            }).limit(50);

            if (!docs.length) return;

            console.log(`[Reconciler] Encontrados ${docs.length} videos pendientes`);
            for (const doc of docs) {
                const id = String(doc._id);
                try {
                    await enqueueFn({
                        videoId: id,
                        s3Key: doc.fileKey,
                        fileId: doc.fileId ?? null,
                    });
                    console.log(`[Reconciler] Reencolado video ${id} (carpeta ${doc.carpeta})`);
                } catch (err) {
                    console.warn(`[Reconciler] No se pudo reencolar video ${id}: ${err.message}`);
                }
            }
        } catch (err) {
            console.error('[Reconciler] Error durante la reconciliación:', err.message);
        }
    }

    setTimeout(reconcileOnce, 10 * 1000);
    setInterval(reconcileOnce, INTERVAL_MS);
    console.log(`[Reconciler] Activo cada ${INTERVAL_MS}ms (corte ${STALE_QUEUED_MS}ms)`);
}
