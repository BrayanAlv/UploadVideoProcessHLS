import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';

class FFmpegService {
  async getVideoMetadata(filePath) {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) return reject(err);
        
        const videoStream = metadata.streams.find(s => s.codec_type === 'video');
        resolve({
          duration: metadata.format.duration,
          width: videoStream ? videoStream.width : 0,
          height: videoStream ? videoStream.height : 0,
          format: metadata.format.format_name
        });
      });
    });
  }

  async generateHLS(inputPath, outputDir, resolution, onProgress) {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    return new Promise((resolve, reject) => {
      let command = ffmpeg(inputPath)
        .videoCodec('libx264')
        .audioCodec('aac')
        .outputOptions([
          '-preset fast',
          '-crf 23',
          '-maxrate 2000k',
          '-bufsize 4000k',
          '-hls_time 10',
          '-hls_playlist_type vod',
          '-hls_segment_filename', path.join(outputDir, 'segment_%03d.ts')
        ]);

      if (resolution) {
        // Aseguramos que el filtro de escalado mantenga la relación de aspecto y sea divisible por 2
        command.size(resolution).aspect('16:9').autoPad();
      }

      command
        .output(path.join(outputDir, 'playlist.m3u8'))
        .on('start', (commandLine) => {
          console.log('[FFmpeg] Spawned with command: ' + commandLine);
        })
        .on('progress', (progress) => {
          if (onProgress && typeof progress.percent === 'number' && !isNaN(progress.percent)) {
            onProgress(Math.round(progress.percent));
          }
        })
        .on('end', () => resolve(path.join(outputDir, 'playlist.m3u8')))
        .on('error', (err) => reject(err))
        .run();
    });
  }

  async generateThumbnail(inputPath, outputDir, fileName) {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .screenshots({
          timestamps: ['10%'],
          filename: fileName,
          folder: outputDir,
          size: '640x360'
        })
        .on('end', () => resolve(path.join(outputDir, fileName)))
        .on('error', (err) => reject(err));
    });
  }

  async generatePreviewVtt(inputPath, outputDir, videoId) {
    // Implementación simplificada para generar un sprite de miniaturas y un archivo VTT
    // Para cumplir con el tiempo, generaremos al menos una miniatura representativa y un VTT básico
    // En una implementación real se usaría algo como:
    // ffmpeg -i input.mp4 -vf "fps=1/10,scale=160:90,tile=5x5" preview.jpg
    
    const spriteName = `sprite_${videoId}.jpg`;
    const vttName = `preview_${videoId}.vtt`;
    const spritePath = path.join(outputDir, spriteName);
    const vttPath = path.join(outputDir, vttName);

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions([
          '-vf', 'fps=1/10,scale=160:90,tile=5x5',
          '-frames:v', '1'
        ])
        .output(spritePath)
        .on('end', () => {
          const vttContent = `WEBVTT\n\n00:00:00.000 --> 00:00:10.000\n${spriteName}#xywh=0,0,160,90`;
          fs.writeFileSync(vttPath, vttContent);
          resolve(vttPath);
        })
        .on('error', (err) => reject(err))
        .run();
    });
  }
}

export const ffmpegService = new FFmpegService();
