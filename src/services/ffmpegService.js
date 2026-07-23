import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';

class FFmpegService {
  async getVideoMetadata(filePath) {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) return reject(err);

        const videoStream = metadata.streams.find(s => s.codec_type === 'video');
        let width = videoStream ? videoStream.width : 0;
        let height = videoStream ? videoStream.height : 0;

        // Muchos celulares (ej. iPhone) graban con dimensiones "acostadas" y
        // marcan la rotación real en metadata en vez de reescribir width/height.
        // Si no se corrige, un video vertical se detecta como horizontal.
        const rotation = this._getRotation(videoStream);
        if (Math.abs(rotation) === 90 || Math.abs(rotation) === 270) {
          [width, height] = [height, width];
        }

        resolve({
          duration: metadata.format.duration,
          width,
          height,
          format: metadata.format.format_name
        });
      });
    });
  }

  _getRotation(videoStream) {
    if (!videoStream) return 0;

    if (videoStream.tags && videoStream.tags.rotate) {
      return parseInt(videoStream.tags.rotate, 10) || 0;
    }

    if (Array.isArray(videoStream.side_data_list)) {
      const displayMatrix = videoStream.side_data_list.find(
        (d) => typeof d.rotation === 'number'
      );
      if (displayMatrix) return displayMatrix.rotation;
    }

    return 0;
  }

  async generateHLS(inputPath, outputDir, resolution, onProgress, opts = {}) {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // El bitrate se ajusta por resolución (escalera). Se mantienen los valores
    // históricos como default para no cambiar el comportamiento de llamadas que
    // no pasen opts (ej. rutas legacy).
    const maxrate = opts.maxrate || '2000k';
    const bufsize = opts.bufsize || '4000k';

    return new Promise((resolve, reject) => {
      let command = ffmpeg(inputPath)
        .videoCodec('libx264')
        .audioCodec('aac')
        .outputOptions([
          '-preset fast',
          '-crf 23',
          `-maxrate ${maxrate}`,
          `-bufsize ${bufsize}`,
          '-hls_time 10',
          '-hls_playlist_type vod',
          '-hls_segment_filename', path.join(outputDir, 'segment_%03d.ts')
        ]);

      if (resolution) {
        // El resolution recibido ya trae la orientación correcta (horizontal o
        // vertical); el pad usa el aspecto de ese tamaño fijo, así que no debe
        // forzarse un 16:9 aquí (eso "acostaría" los videos verticales).
        command.size(resolution).autoPad();
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

  // Genera una preview para las cards del home en formato web (WebP),
  // redimensionada de forma PROPORCIONAL a la imagen original (escala por
  // ancho manteniendo la relación de aspecto; sin recorte ni pad). Si el
  // ancho original es menor a `width`, no la agranda. Sirve tanto para la
  // imagen custom (previewKey PNG/JPG) como para el thumbnail generado.
  async generateCardPreview(inputPath, outputDir, fileName, { width = 640 } = {}) {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const outputPath = path.join(outputDir, fileName);

    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions([
          '-vf', `scale='min(${width},iw)':-2`,
          '-frames:v', '1',
          '-c:v', 'libwebp',
          '-q:v', '80',
          '-compression_level', '6'
        ])
        .output(outputPath)
        .on('end', () => resolve(outputPath))
        .on('error', (err) => reject(err))
        .run();
    });
  }
}

export const ffmpegService = new FFmpegService();
