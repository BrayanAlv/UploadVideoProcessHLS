// routes/adminRoutes.js
import express from 'express';
import {
    listVideosAdmin,
    reprocessVideos,
    getVideoHistory,
    getPreviewImage,
    listHistory,
    listBatches,
} from '../controllers/adminController.js';

const router = express.Router();

// Lista de videos con filtros para la UI de administración.
router.get('/videos', listVideosAdmin);

// Imagen de preview para las cards.
router.get('/preview/:id', getPreviewImage);

// Historial de reprocesos de un video puntual.
router.get('/videos/:id/history', getVideoHistory);

// Historial global de eventos y resumen por lote.
router.get('/history', listHistory);
router.get('/batches', listBatches);

// Reprocesar los ids seleccionados manualmente.
router.post('/reprocess', reprocessVideos);

export default router;
