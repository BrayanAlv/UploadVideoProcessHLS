// controllers/adminController.js
//
// Endpoints para la mini web UI de administración de reproceso (selección manual).
// NO forma parte del flujo automático (reconciler); solo se dispara desde la UI.

import crypto from 'crypto';
import mongoose from 'mongoose';
import Contenido from '../models/Contenido.js';
import { videoQueue } from '../workers/videoWorker.js';
import { startReprocessEvent, logFinishedEvent } from '../services/reprocessHistory.service.js';
import { streamFile } from '../services/b2Service.js';

function orientacionDe(originalResolution) {
    if (!originalResolution || !String(originalResolution).includes('x')) return 'desconocida';
    const [w, h] = String(originalResolution).split('x').map(Number);
    if (!w || !h) return 'desconocida';
    if (h > w) return 'vertical';
    if (w > h) return 'horizontal';
    return 'cuadrada';
}

// GET /api/admin/videos?carpeta=&status=&q=&orientacion=&page=&limit=
export const listVideosAdmin = async (req, res, next) => {
    try {
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
        const skip = (page - 1) * limit;

        const filter = {};
        if (req.query.carpeta) filter.carpeta = req.query.carpeta;
        if (req.query.status) filter['videoProcessing.status'] = req.query.status;
        if (req.query.q) filter.nombre = { $regex: String(req.query.q).trim(), $options: 'i' };
        // Filtro por orientación usando el campo `orientacion` del CRM (cuando existe).
        if (req.query.orientacion) filter.orientacion = req.query.orientacion;

        const [docs, total] = await Promise.all([
            Contenido.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
            Contenido.countDocuments(filter),
        ]);

        const videos = docs.map((d) => {
            const vp = d.videoProcessing || {};
            const hist = Array.isArray(vp.reprocessHistory) ? vp.reprocessHistory : [];
            const ultimo = hist.length ? hist[hist.length - 1] : null;
            return {
                id: String(d._id),
                nombre: d.nombre || '(sin nombre)',
                carpeta: d.carpeta || null,
                fileKey: d.fileKey || null,
                // Orientación declarada por el CRM y la calculada desde la resolución real.
                orientacionCRM: d.orientacion || null,
                orientacionCalculada: orientacionDe(vp.originalResolution),
                originalResolution: vp.originalResolution || null,
                status: vp.status || null,
                progress: vp.progress ?? null,
                availableQualities: vp.availableQualities || [],
                hlsFolder: vp.hlsFolder || null,
                updatedAt: d.updatedAt || null,
                reprocessCount: hist.length,
                ultimoReproceso: ultimo
                    ? { at: ultimo.at, status: ultimo.status, reason: ultimo.reason, batchId: ultimo.batchId }
                    : null,
                previewUrl: `/api/admin/preview/${String(d._id)}`,
                tienePreview: !!(vp.cardPreviewPath || d.previewKey || vp.thumbnailPath),
                tieneCustomPreview: !!d.previewKey,
                cardPreviewInfo: vp.cardPreviewInfo || null,
            };
        });

        res.json({ videos, pagination: { total, page, pages: Math.ceil(total / limit), limit } });
    } catch (error) {
        next(error);
    }
};

// POST /api/admin/reprocess  { ids: [...] }
// Encola los videos seleccionados manualmente en la cola existente, con
// replaceExisting=true para que se borre el HLS viejo. El worker (concurrency 1)
// los procesa uno a uno con el pipeline ya corregido de orientación.
export const reprocessVideos = async (req, res, next) => {
    try {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).filter(Boolean) : [];
        if (!ids.length) {
            return res.status(400).json({ error: 'Debes enviar un arreglo "ids" con al menos un id' });
        }

        const docs = await Contenido.find({ _id: { $in: ids } }).lean();
        const porId = new Map(docs.map((d) => [String(d._id), d]));

        const reason = (req.body?.reason ? String(req.body.reason) : '').trim();
        // 'full' = video (HLS) + preview ; 'preview' = solo regenerar la card preview.
        const mode = req.body?.mode === 'preview' ? 'preview' : 'full';
        const batchId = `lote-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

        const encolados = [];
        const omitidos = [];

        for (const id of ids) {
            const doc = porId.get(id);
            if (!doc) { omitidos.push({ id, motivo: 'no encontrado' }); continue; }

            const vp = doc.videoProcessing || {};
            if (mode === 'full' && !doc.fileKey) {
                omitidos.push({ id, motivo: 'sin fileKey' });
                await logFinishedEvent(id, { source: 'manual-ui', reason, batchId, mode, status: 'failed', errorMessage: 'sin fileKey' });
                continue;
            }
            if (mode === 'preview' && !doc.previewKey && !vp.thumbnailPath) {
                omitidos.push({ id, motivo: 'sin previewKey ni thumbnail' });
                await logFinishedEvent(id, { source: 'manual-ui', reason, batchId, mode, status: 'failed', errorMessage: 'sin previewKey ni thumbnail' });
                continue;
            }

            const jobId = `video-${id}`;
            // Quitamos cualquier job previo con ese id (ej. uno "completed" que
            // impediría re-encolar por dedupe) para forzar un reproceso fresco.
            try { await videoQueue.remove(jobId); } catch { /* puede estar activo o no existir */ }

            // Registramos el evento de historial (queued) y pasamos su id al job.
            const reprocessEventId = await startReprocessEvent(id, { source: 'manual-ui', reason, batchId, mode });

            await videoQueue.add(
                'process-video',
                { videoId: id, s3Key: doc.fileKey || null, fileID: null, replaceExisting: true, mode, reprocessEventId, batchId },
                { jobId }
            );
            // Solo el modo full toca el estado del HLS; en preview no cambiamos el status del video.
            if (mode === 'full') {
                await Contenido.updateOne({ _id: id }, { $set: { 'videoProcessing.status': 'queued', 'videoProcessing.progress': 0 } });
            }
            encolados.push(id);
        }

        res.json({ ok: true, batchId, reason, mode, encolados, omitidos, total: encolados.length });
    } catch (error) {
        next(error);
    }
};

// GET /api/admin/videos/:id/history — historial de reprocesos de un video (desc).
export const getVideoHistory = async (req, res, next) => {
    try {
        const doc = await Contenido.findById(req.params.id).lean();
        if (!doc) return res.status(404).json({ error: 'Video no encontrado' });
        const vp = doc.videoProcessing || {};
        const historial = (vp.reprocessHistory || []).slice().reverse();
        res.json({
            id: String(doc._id),
            nombre: doc.nombre || null,
            statusActual: vp.status || null,
            historial,
        });
    } catch (error) {
        next(error);
    }
};

// GET /api/admin/preview/:id — imagen de preview para la card (stream desde B2).
// Orden de preferencia: cardPreviewPath (WebP) -> previewKey custom -> thumbnail.
export const getPreviewImage = async (req, res, next) => {
    try {
        const doc = await Contenido.findById(req.params.id).lean();
        if (!doc) return res.status(404).json({ error: 'Video no encontrado' });
        const vp = doc.videoProcessing || {};
        const key = vp.cardPreviewPath || doc.previewKey || vp.thumbnailPath || null;
        if (!key) return res.status(404).json({ error: 'Sin preview' });

        const file = await streamFile(key);
        res.setHeader('Content-Type', file.contentType || 'image/webp');
        if (file.contentLength != null) res.setHeader('Content-Length', file.contentLength);
        res.setHeader('Cache-Control', 'public, max-age=300');
        file.body.pipe(res);
    } catch (error) {
        // Evitamos romper la card: 404 silencioso para que la UI muestre placeholder.
        if (!res.headersSent) res.status(404).json({ error: 'No se pudo obtener la preview' });
    }
};

// GET /api/admin/history?batchId=&status=&videoId=&page=&limit=
// Lista aplanada de eventos de reproceso a través de todos los Contenido.
export const listHistory = async (req, res, next) => {
    try {
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 30, 1), 200);
        const skip = (page - 1) * limit;

        const match = { 'videoProcessing.reprocessHistory.0': { $exists: true } };
        if (req.query.videoId) {
            try { match._id = new mongoose.Types.ObjectId(String(req.query.videoId)); } catch { /* id inválido */ }
        }

        const eventMatch = {};
        if (req.query.batchId) eventMatch['evento.batchId'] = String(req.query.batchId);
        if (req.query.status) eventMatch['evento.status'] = String(req.query.status);

        const pipeline = [
            { $match: match },
            { $project: { nombre: 1, evento: '$videoProcessing.reprocessHistory' } },
            { $unwind: '$evento' },
            ...(Object.keys(eventMatch).length ? [{ $match: eventMatch }] : []),
            { $sort: { 'evento.at': -1 } },
            { $facet: {
                data: [{ $skip: skip }, { $limit: limit }],
                total: [{ $count: 'n' }],
            } },
        ];

        const [agg] = await Contenido.aggregate(pipeline);
        const total = agg?.total?.[0]?.n || 0;
        const eventos = (agg?.data || []).map((row) => ({
            videoId: String(row._id),
            nombre: row.nombre || null,
            ...row.evento,
        }));

        res.json({ eventos, pagination: { total, page, pages: Math.ceil(total / limit), limit } });
    } catch (error) {
        next(error);
    }
};

// GET /api/admin/batches?limit= — resumen agrupado por lote.
export const listBatches = async (req, res, next) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 30, 1), 200);
        const pipeline = [
            { $match: { 'videoProcessing.reprocessHistory.0': { $exists: true } } },
            { $project: { evento: '$videoProcessing.reprocessHistory' } },
            { $unwind: '$evento' },
            { $match: { 'evento.batchId': { $ne: null } } },
            { $group: {
                _id: '$evento.batchId',
                total: { $sum: 1 },
                completados: { $sum: { $cond: [{ $eq: ['$evento.status', 'completed'] }, 1, 0] } },
                fallidos: { $sum: { $cond: [{ $eq: ['$evento.status', 'failed'] }, 1, 0] } },
                enProceso: { $sum: { $cond: [{ $in: ['$evento.status', ['queued', 'processing']] }, 1, 0] } },
                firstAt: { $min: '$evento.at' },
                lastAt: { $max: '$evento.at' },
                source: { $first: '$evento.source' },
                reason: { $first: '$evento.reason' },
            } },
            { $sort: { firstAt: -1 } },
            { $limit: limit },
        ];
        const rows = await Contenido.aggregate(pipeline);
        const lotes = rows.map((r) => ({ batchId: r._id, ...r, _id: undefined }));
        res.json({ lotes });
    } catch (error) {
        next(error);
    }
};
