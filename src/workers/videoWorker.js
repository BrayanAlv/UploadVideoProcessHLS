// videoWorker.js
import {Worker, Queue} from 'bullmq';
import {redisConfig} from '../config/db.js';
import Contenido from "../models/Contenido.js";
import {ffmpegService} from '../services/ffmpegService.js';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import {streamFile, uploadFile} from '../services/b2Service.js';

dotenv.config();

const queueName = 'video-processing';
export const videoQueue = new Queue(queueName, {connection: redisConfig});

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
            else if (entry.name.endsWith('.vtt')) mimeType = 'text/vtt';

            await uploadFile(fileBuffer, b2FolderPath, entry.name, mimeType);
        }
    }
}

function jobIdFor(videoId) {
    return `video-${videoId}`;
}

export function createWorker() {
    return new Worker(queueName, async (job) => {
        console.log(`[Worker] Job ${job.id} recibido. Data:`, JSON.stringify(job.data));
        const {videoId, s3Key, fileID} = job.data;
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

        console.log(`[Worker] Iniciando procesamiento para: ${contenido.nombre || videoId}`);
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

            await updateVideoProcessing({
                duration: metadata.duration,
                originalResolution: `${width}x${height}`,
                originalSize: fs.statSync(newRawPath).size,
            });

            const tasks = [];

            if (height >= 720) {
                tasks.push({
                    label: '720p', resolution: '1280x720', readyFlag: 'is720pReady'
                });
            }

            if (height >= 1080) {
                tasks.push({
                    label: '1080p', resolution: '1920x1080', readyFlag: 'is1080pReady'
                });
            }

            if (tasks.length === 0 && height > 0) {
                const safeHeight = Math.max(Math.floor(height / 2) * 2, 240);
                const safeWidth = Math.max(Math.floor(width / 2) * 2, 426);
                tasks.push({
                    label: `${safeHeight}p`,
                    resolution: `${safeWidth}x${safeHeight}`,
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
                });

                availableQualities.push(task.label);

                const updates = {
                    availableQualities
                };

                if (task.readyFlag) {
                    updates[task.readyFlag] = true;
                }

                await updateVideoProcessing(updates);
                const bandwidth = task.label === '1080p' ? 5000000 : 2500000;
                masterPlaylistLines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${task.resolution}`);
                masterPlaylistLines.push(`${task.label}/playlist.m3u8`);
            }

            const masterPath = path.join(hlsDir, 'master.m3u8');
            fs.writeFileSync(masterPath, masterPlaylistLines.join('\n'));
            const folderDestinoB2 = `${paths.hls}/${videoId}`;
            const thumbnailFolder = `${paths.thumbnails}/${videoId}`;
            console.log(`[Worker] Subiendo HLS a ${folderDestinoB2}`);
            await uploadFolderToB2(hlsDir, folderDestinoB2);
            await uploadFolderToB2(thumbDir, thumbnailFolder);
            await updateVideoProcessing({
                status: VIDEO_STATUS.COMPLETED,
                progress: 100,
                hlsFolder: folderDestinoB2,
                masterPlaylist: 'master.m3u8',
                thumbnailPath: `${thumbnailFolder}/thumbnail.jpg`,
                previewVttPath: `${thumbnailFolder}/preview_${videoId}.vtt`,
                availableQualities,
                is720pReady: availableQualities.includes('720p'),
                is1080pReady: availableQualities.includes('1080p')
            });
            console.log(`[Worker] Procesamiento finalizado para ${contenido.nombre || videoId}`);
        } catch (error) {
            console.error(`[Worker] Error Job ${job.id}:`, error.message);
            await updateVideoProcessing({
                status: VIDEO_STATUS.FAILED, errorMessage: error.message
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
    }, {
        connection: redisConfig,
        concurrency: 1
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
