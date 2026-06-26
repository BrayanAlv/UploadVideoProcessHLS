import Contenido from '../models/Contenido.js';
import { videoQueue } from '../workers/videoWorker.js';
import fs from 'fs';
import path from 'path';
import { spawn, execSync } from 'child_process';

const getVideoCodec = (filePath) => {
  try {
    const output = execSync(
        `ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
        { encoding: 'utf8', timeout: 10000 }
    );
    return output.trim().toLowerCase();
  } catch {
    return null;
  }
};

export const uploadVideo = async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se subió ningún video' });

    const { title } = req.body;
    if (!title) {
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'El título es obligatorio' });
    }

    console.log(`[Controller] Creando contenido con nombre: ${title}, archivo: ${req.file.originalname}`);

    const contenido = new Contenido({
      nombre: title,
      fileKey: req.file.path,
      carpeta: 'Videos',
      videoProcessing: {
        status: 'uploaded',
        originalFileName: req.file.originalname,
        originalPath: req.file.path,
        originalSize: req.file.size
      }
    });

    await contenido.save();
    console.log(`[Controller] Contenido creado con _id: ${contenido._id}`);

    // Agrega el trabajo a BullMQ pasándole el ID del contenido
    const jobData = {
      videoId: contenido._id,
      s3Key: req.file.path,
      fileID: null
    };
    console.log(`[Controller] Agregando job a queue con data:`, JSON.stringify(jobData));
    await videoQueue.add('process-video', jobData);

    res.status(201).json({ success: true, videoId: contenido._id });
  } catch (error) {
    next(error);
  }
};

// export const uploadVideo = async (req, res, next) => {
//   try {
//     if (!req.file) return res.status(400).json({ error: 'No se subió ningún video' });
//
//     const { title } = req.body;
//     if (!title) {
//       fs.unlinkSync(req.file.path);
//       return res.status(400).json({ error: 'El título es obligatorio' });
//     }
//
//     const video = new Video({
//       title,
//       originalFileName: req.file.originalname,
//       originalPath: req.file.path,
//       originalSize: req.file.size,
//       status: 'uploaded'
//     });
//
//     await video.save();
//     await videoQueue.add('process-video', { videoId: video._id });
//
//     res.status(201).json({ success: true, videoId: video._id });
//   } catch (error) {
//     next(error);
//   }
// };

export const getVideoStatus = async (req, res, next) => {
  try {
    const contenido = await Contenido.findById(req.params.id);
    if (!contenido) return res.status(404).json({ error: 'Video no encontrado' });
    res.json({ status: contenido.videoProcessing?.status, progress: contenido.videoProcessing?.progress });
  } catch (error) {
    next(error);
  }
};

export const getVideoDetail = async (req, res, next) => {
  try {
    const contenido = await Contenido.findById(req.params.id);
    if (!contenido) return res.status(404).json({ error: 'Video no encontrado' });
    console.log(`[Controller] getVideoDetail: ${contenido._id}, nombre: ${contenido.nombre}`);

    const vp = contenido.videoProcessing || {};

    res.json({
      id: contenido._id,
      title: contenido.nombre,
      status: vp.status,
      thumbnailPath: vp.thumbnailPath,
      previewVttPath: vp.previewVttPath,
      hlsMasterPath: vp.masterPlaylist,
      availableQualities: vp.availableQualities,
      originalResolution: vp.originalResolution,
      duration: vp.duration,
      size: vp.originalSize,
      errorMessage: vp.errorMessage
    });
  } catch (error) {
    next(error);
  }
};

export const listVideos = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const contenidos = await Contenido.find()
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);
    const total = await Contenido.countDocuments();

    const videos = contenidos.map(c => ({
      id: c._id,
      title: c.nombre,
      status: c.videoProcessing?.status,
      progress: c.videoProcessing?.progress,
      thumbnailPath: c.videoProcessing?.thumbnailPath,
      previewVttPath: c.videoProcessing?.previewVttPath,
      availableQualities: c.videoProcessing?.availableQualities,
      originalResolution: c.videoProcessing?.originalResolution,
      duration: c.videoProcessing?.duration,
      size: c.videoProcessing?.originalSize,
      createdAt: c.createdAt
    }));

    res.json({ videos, pagination: { total, page, pages: Math.ceil(total / limit) } });
  } catch (error) {
    next(error);
  }
};

export const streamVideo = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { download } = req.query;

    const contenido = await Contenido.findById(id);
    if (!contenido) return res.status(404).json({ error: 'Video no encontrado' });
    console.log(`[Controller] streamVideo: ${id}`);

    // Ruta estática dentro del volumen compartido
    const videoPath = path.join(process.cwd(), 'storage', 'videos', id, 'raw', 'original.mp4');

    if (!fs.existsSync(videoPath)) {
      return res.status(404).json({ error: 'Archivo original no encontrado' });
    }

    // FIX: Se eliminó la transcodificación "on-the-fly" con spawn('ffmpeg').
    // Todo video original se sirve directamente mediante Range Requests estándar.
    const stat = fs.statSync(videoPath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (download === 'true') {
      res.setHeader('Content-Disposition', `attachment; filename="${contenido.nombre}_original.mp4"`);
    }

    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start = parseInt(startStr, 10);
      const end = endStr ? parseInt(endStr, 10) : fileSize - 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': 'video/mp4',
      });
      fs.createReadStream(videoPath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Accept-Ranges': 'bytes',
        'Content-Type': 'video/mp4',
      });
      fs.createReadStream(videoPath).pipe(res);
    }
  } catch (error) {
    next(error);
  }
};
// export const streamVideo = async (req, res, next) => {
//   try {
//     const { id } = req.params;
//     const { download } = req.query;
//
//     const video = await Video.findById(id);
//     if (!video) return res.status(404).json({ error: 'Video no encontrado' });
//
//     // El original está en raw/original.mp4
//     const videoPath = path.join(process.cwd(), 'storage', 'videos', id, 'raw', 'original.mp4');
//
//     if (!fs.existsSync(videoPath)) {
//       return res.status(404).json({ error: 'Archivo original no encontrado' });
//     }
//
//     const codec = getVideoCodec(videoPath);
//     console.log(`[Stream] Codec: ${codec} | Video: ${id}`);
//
//     const needsTranscode = codec === 'hevc' || codec === 'h265';
//
//     if (needsTranscode) {
//       console.log(`[Stream] Transcodificando HEVC → H.264 para video ${id}`);
//
//       res.setHeader('Content-Type', 'video/mp4');
//       res.setHeader('Cache-Control', 'no-cache');
//
//       if (download === 'true') {
//         res.setHeader('Content-Disposition', `attachment; filename="${video.title}_original.mp4"`);
//       }
//
//       const ffmpeg = spawn('ffmpeg', [
//         '-i', videoPath,
//         '-c:v', 'libx264',
//         '-preset', 'ultrafast',
//         '-crf', '18',
//         '-c:a', 'aac',
//         '-b:a', '192k',
//         '-movflags', 'frag_keyframe+empty_moov+faststart',
//         '-f', 'mp4',
//         'pipe:1'
//       ]);
//
//       ffmpeg.stdout.pipe(res);
//       ffmpeg.stderr.on('data', (d) => console.log(`[ffmpeg] ${d.toString().split('\n')[0]}`));
//       ffmpeg.on('error', (err) => {
//         console.error('[Stream] Error ffmpeg:', err);
//         if (!res.headersSent) res.status(500).json({ error: 'Error al transcodificar' });
//       });
//       req.on('close', () => ffmpeg.kill('SIGKILL'));
//
//     } else {
//       // H.264: servir con range requests (seeking funciona)
//       const stat = fs.statSync(videoPath);
//       const fileSize = stat.size;
//       const range = req.headers.range;
//
//       if (download === 'true') {
//         res.setHeader('Content-Disposition', `attachment; filename="${video.title}_original.mp4"`);
//       }
//
//       if (range) {
//         const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
//         const start = parseInt(startStr, 10);
//         const end = endStr ? parseInt(endStr, 10) : fileSize - 1;
//         res.writeHead(206, {
//           'Content-Range': `bytes ${start}-${end}/${fileSize}`,
//           'Accept-Ranges': 'bytes',
//           'Content-Length': end - start + 1,
//           'Content-Type': 'video/mp4',
//         });
//         fs.createReadStream(videoPath, { start, end }).pipe(res);
//       } else {
//         res.writeHead(200, {
//           'Content-Length': fileSize,
//           'Accept-Ranges': 'bytes',
//           'Content-Type': 'video/mp4',
//         });
//         fs.createReadStream(videoPath).pipe(res);
//       }
//     }
//   } catch (error) {
//     next(error);
//   }
// };

// ─── NUEVO: sirve el master.m3u8 ──────────────────────────────────────────────
export const getHLSMaster = async (req, res) => {
  try {
    const { id } = req.params;

    const masterPath = path.join(
        process.cwd(), 'storage', 'videos', id, 'hls', 'master.m3u8'
    );

    if (!fs.existsSync(masterPath)) {
      return res.status(404).json({ error: 'Master playlist no encontrada' });
    }

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache');

    const stream = fs.createReadStream(masterPath);
    stream.on('error', () => res.status(500).json({ error: 'Error leyendo master.m3u8' }));
    stream.pipe(res);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ─── Playlist de calidad específica (720p, 1080p…) ───────────────────────────
export const getHLSPlaylist = async (req, res) => {
  try {
    const { id, quality } = req.params;

    const playlistPath = path.join(
        process.cwd(), 'storage', 'videos', id, 'hls', quality, 'playlist.m3u8'
    );

    if (!fs.existsSync(playlistPath)) {
      return res.status(404).json({ error: 'Playlist no encontrada' });
    }

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache');

    const stream = fs.createReadStream(playlistPath);
    stream.on('error', () => res.status(500).json({ error: 'Error leyendo playlist' }));
    stream.pipe(res);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ─── Segmentos .ts ────────────────────────────────────────────────────────────
export const getHLSSegment = async (req, res) => {
  try {
    const { id, quality, segment } = req.params;

    const segmentPath = path.join(
        process.cwd(), 'storage', 'videos', id, 'hls', quality, path.basename(segment)
    );

    if (!fs.existsSync(segmentPath)) return res.status(404).end();

    res.setHeader('Content-Type', 'video/MP2T');
    res.setHeader('Cache-Control', 'public, max-age=31536000');

    const stream = fs.createReadStream(segmentPath);
    stream.on('error', () => res.status(500).end());
    stream.pipe(res);

  } catch (err) {
    res.status(500).end();
  }
};



