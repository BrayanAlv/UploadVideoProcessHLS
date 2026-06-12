import express from 'express';
import {
  uploadVideo,
  getVideoStatus,
  getVideoDetail,
  listVideos,
  streamVideo, getHLSPlaylist, getHLSSegment, getHLSMaster
} from '../controllers/videoController.js';
import { upload } from '../middlewares/upload.js';

const router = express.Router();

/**
 * @swagger
 * /api/videos/upload:
 *   post:
 *     summary: Subir un video original
 *     tags: [Videos]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               title:
 *                 type: string
 *               video:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Video subido exitosamente y en cola para procesamiento
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 videoId:
 *                   type: string
 */
router.post('/upload', upload.single('video'), uploadVideo);

/**
 * @swagger
 * /api/videos:
 *   get:
 *     summary: Listar todos los videos (paginado)
 *     tags: [Videos]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *     responses:
 *       200:
 *         description: Lista de videos
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 videos:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Video'
 *                 totalPages:
 *                   type: integer
 *                 currentPage:
 *                   type: integer
 *                 totalVideos:
 *                   type: integer
 */
router.get('/', listVideos);

/**
 * @swagger
 * /api/videos/{id}:
 *   get:
 *     summary: Obtener detalle de un video
 *     tags: [Videos]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Detalle del video
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Video'
 *       404:
 *         description: Video no encontrado
 */
router.get('/:id', getVideoDetail);

/**
 * @swagger
 * /api/videos/{id}/status:
 *   get:
 *     summary: Obtener el estado y progreso de procesamiento
 *     tags: [Videos]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Estado del video
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                 progress:
 *                   type: number
 *       404:
 *         description: Video no encontrado
 */
router.get('/:id/status', getVideoStatus);

/**
 * @swagger
 * /api/videos/{id}/stream:
 *   get:
 *     summary: Reproducir video por streaming
 *     description: Permite la reproducción de video mediante streaming con soporte para peticiones de rango (seeking).
 *     tags: [Videos]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: ID del video
 *       - in: query
 *         name: quality
 *         schema:
 *           type: string
 *           enum: [720p, 1080p, 2K, 4K]
 *         description: Calidad del video a reproducir (por defecto 720p)
 *     responses:
 *       200:
 *         description: Video stream (completo)
 *         content:
 *           video/mp4:
 *             schema:
 *               type: string
 *               format: binary
 *       206:
 *         description: Video stream (parcial - Range request)
 *         content:
 *           video/mp4:
 *             schema:
 *               type: string
 *               format: binary
 *       404:
 *         description: Video o calidad no encontrados
 */
router.get('/:id/stream', streamVideo);

/**
 * @swagger
 * /api/videos/{id}/hls/{quality}/playlist.m3u8:
 *   get:
 *     summary: Obtener playlist HLS de una calidad específica
 *     description: Retorna el archivo playlist.m3u8 correspondiente a una calidad determinada.
 *     tags: [Video Streaming (HLS)]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         description: ID del video
 *         schema:
 *           type: string
 *       - in: path
 *         name: quality
 *         required: true
 *         description: Calidad del video
 *         schema:
 *           type: string
 *           enum:
 *             - 720p
 *             - 1080p
 *     responses:
 *       200:
 *         description: Playlist HLS entregada correctamente
 *         content:
 *           application/vnd.apple.mpegurl:
 *             schema:
 *               type: string
 *       404:
 *         description: Playlist no encontrada
 */
router.get('/:id/hls/:quality/playlist.m3u8', getHLSPlaylist);

/**
 * @swagger
 * /api/videos/{id}/hls/{quality}/{segment}:
 *   get:
 *     summary: Obtener segmento HLS
 *     description: Retorna un segmento .ts perteneciente a una playlist HLS.
 *     tags: [Video Streaming (HLS)]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         description: ID del video
 *         schema:
 *           type: string
 *
 *       - in: path
 *         name: quality
 *         required: true
 *         description: Calidad del video
 *         schema:
 *           type: string
 *
 *       - in: path
 *         name: segment
 *         required: true
 *         description: Nombre del segmento TS
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Segmento entregado correctamente
 *         content:
 *           video/mp2t:
 *             schema:
 *               type: string
 *               format: binary
 *       404:
 *         description: Segmento no encontrado
 */
router.get('/:id/hls/:quality/:segment', getHLSSegment);

/**
 * @swagger
 * /api/videos/{id}/hls/master.m3u8:
 *   get:
 *     summary: Obtener playlist maestro HLS
 *     description: Retorna el master playlist con todas las calidades disponibles.
 *     tags: [Video Streaming (HLS)]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         description: ID del video
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Master playlist entregada correctamente
 *         content:
 *           application/vnd.apple.mpegurl:
 *             schema:
 *               type: string
 *       404:
 *         description: Playlist no encontrada
 */
router.get('/:id/hls/master.m3u8', getHLSMaster);

/*
import express from 'express';
import {
  uploadVideo,
  getVideoStatus,
  getVideoDetail,
  listVideos,
  streamVideo,
  getHLSMaster,      // ← nuevo
  getHLSPlaylist,
  getHLSSegment
} from '../controllers/videoController.js';
import { upload } from '../middlewares/upload.js';

const router = express.Router();

router.post('/upload', upload.single('video'), uploadVideo);
router.get('/', listVideos);
router.get('/:id', getVideoDetail);
router.get('/:id/status', getVideoStatus);
router.get('/:id/stream', streamVideo);

// HLS — orden importante: master antes que :quality para que no colisionen
router.get('/:id/hls/master.m3u8', getHLSMaster);                      // ← nuevo
router.get('/:id/hls/:quality/playlist.m3u8', getHLSPlaylist);
router.get('/:id/hls/:quality/:segment', getHLSSegment);

export default router;// ← nuevo
 */
router.get("/videos/:id/hls/:quality/playlist.m3u8", getHLSPlaylist);
router.get("/videos/:id/hls/:quality/:segment", getHLSSegment);


export default router;


