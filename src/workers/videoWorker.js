import { Queue, Worker } from 'bullmq';
import { redisConfig } from '../config/db.js';
import Video from '../models/Video.js';
import { ffmpegService } from '../services/ffmpegService.js';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const queueName = 'video-processing';

// export const videoQueue = new Queue(queueName, {
//   connection: redisConfig
// });

export const videoWorker = new Worker(queueName, async (job) => {
  const { videoId } = job.data;
  const video = await Video.findById(videoId);

  if (!video) {
    throw new Error(`Video ${videoId} no encontrado`);
  }

  console.log(`[Worker] Iniciando procesamiento para: ${video.title}`);
  
  try {
    let savePromise = Promise.resolve();
    const safeSave = async (updates) => {
      savePromise = savePromise.then(async () => {
        try {
          const v = await Video.findById(videoId);
          if (v) {
            Object.assign(v, updates);
            await v.save();
          }
        } catch (err) {
          console.error(`[Worker] Error saving video ${videoId}: ${err.message}`);
        }
      });
      return savePromise;
    };

    video.status = 'processing';
    await safeSave({ status: 'processing' });

    const videoDir = path.join('storage', 'videos', videoId.toString());
    const rawDir = path.join(videoDir, 'raw');
    const hlsDir = path.join(videoDir, 'hls');
    const thumbDir = path.join(videoDir, 'thumbnails');

    if (!fs.existsSync(rawDir)) fs.mkdirSync(rawDir, { recursive: true });
    if (!fs.existsSync(hlsDir)) fs.mkdirSync(hlsDir, { recursive: true });
    if (!fs.existsSync(thumbDir)) fs.mkdirSync(thumbDir, { recursive: true });

    // 1. Mover el archivo original a la carpeta raw/ y actualizar path
    const originalExt = path.extname(video.originalPath);
    const newRawPath = path.resolve(rawDir, `original${originalExt}`);
    
    if (fs.existsSync(video.originalPath) && path.resolve(video.originalPath) !== newRawPath) {
      console.log(`[Worker] Moving file from ${video.originalPath} to ${newRawPath}`);
      fs.renameSync(video.originalPath, newRawPath);
      video.originalPath = newRawPath;
      await safeSave({ originalPath: newRawPath });
    } else if (!fs.existsSync(video.originalPath) && fs.existsSync(newRawPath)) {
      console.log(`[Worker] File already moved to ${newRawPath}`);
      video.originalPath = newRawPath;
      await safeSave({ originalPath: newRawPath });
    } else if (!fs.existsSync(video.originalPath) && !fs.existsSync(newRawPath)) {
      throw new Error(`Archivo original no encontrado en ${video.originalPath} ni en ${newRawPath}`);
    }

    // 2. Obtener metadatos
    const metadata = await ffmpegService.getVideoMetadata(video.originalPath);
    video.duration = metadata.duration;
    video.originalResolution = `${metadata.width}x${metadata.height}`;
    
    const availableQualities = ['original'];
    const height = metadata.height;

    // 3. Generar Miniaturas y VTT
    const thumbnailPath = await ffmpegService.generateThumbnail(video.originalPath, thumbDir, 'thumbnail.jpg');
    const previewVttPath = await ffmpegService.generatePreviewVtt(video.originalPath, thumbDir, videoId);
    await safeSave({ 
      duration: metadata.duration,
      originalResolution: `${metadata.width}x${metadata.height}`,
      thumbnailPath, 
      previewVttPath 
    });

    // 4. Determinar qué resoluciones generar (720p y 1080p máximo, sin upscale)
    // El flujo ahora es primero 720p y después 1080p
    const tasks = [];
    if (height >= 720) {
      tasks.push({ label: '720p', resolution: '1280x720', readyFlag: 'is720pReady' });
    }
    if (height >= 1080) {
      tasks.push({ label: '1080p', resolution: '1920x1080', readyFlag: 'is1080pReady' });
    }

    // 5. Generar variantes HLS
    const masterPlaylistLines = ['#EXTM3U', '#EXT-X-VERSION:3'];

    let isSavingProgress = false;
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      console.log(`[Worker] Generando HLS para ${task.label}...`);
      const variantDir = path.join(hlsDir, task.label);
      
      await ffmpegService.generateHLS(
        video.originalPath,
        variantDir,
        task.resolution,
        async (percent) => {
          const totalProgress = Math.min(99, Math.round(((i + (percent / 100)) / tasks.length) * 100));
          if (totalProgress !== video.progress && !isSavingProgress) {
            isSavingProgress = true;
            try {
              video.progress = totalProgress;
              console.log(`[Worker] Progress for ${videoId}: ${totalProgress}%`);
              await safeSave({ progress: totalProgress });
            } finally {
              isSavingProgress = false;
            }
          }
        }
      );
      
      availableQualities.push(task.label);
      
      // Actualizar que la calidad específica ya está lista
      const updates = { availableQualities };
      if (task.readyFlag) {
        updates[task.readyFlag] = true;
      }
      await safeSave(updates);
      
      // Añadir a la master playlist (aproximación simplificada de ancho de banda)
      const bandwidth = task.label === '1080p' ? 5000000 : 2500000;
      masterPlaylistLines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${task.resolution}`);
      masterPlaylistLines.push(`${task.label}/playlist.m3u8`);
    }

    // Guardar master.m3u8
    const masterPath = path.join(hlsDir, 'master.m3u8');
    fs.writeFileSync(masterPath, masterPlaylistLines.join('\n'));
    
    await safeSave({
      hlsMasterPath: masterPath,
      availableQualities,
      status: 'completed',
      progress: 100
    });
    
    // Esperar a que terminen todos los guardados
    await savePromise;
    console.log(`[Worker] Procesamiento completado para: ${video.title}`);

  } catch (error) {
    console.error(`[Worker] Error procesando video ${videoId}:`, error.message);
    await safeSave({
      status: 'failed',
      errorMessage: error.message
    });
    await savePromise;
    throw error;
  }
}, {
  connection: redisConfig,
  concurrency: 1
});

videoWorker.on('failed', (job, err) => {
  console.error(`[Worker] Job ${job.id} falló: ${err.message}`);
});
