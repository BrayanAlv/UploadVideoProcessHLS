// models/Contenido.js

import mongoose from 'mongoose';

// Un evento por reproceso: registra cuándo, quién/qué lo disparó, el motivo y
// el resultado. Se agrupan por batchId para ver un lote completo.
const reprocessEventSchema = new mongoose.Schema({
    eventId: String,
    at: Date,
    finishedAt: Date,
    source: String,            // 'manual-ui' | 'script'
    reason: String,            // motivo libre (opcional)
    mode: String,              // 'full' (video+preview) | 'preview'
    batchId: String,
    status: {
        type: String,
        enum: ['queued', 'processing', 'completed', 'failed'],
        default: 'queued'
    },
    errorMessage: String,
    fromResolution: String,
    toResolution: String,
    orientation: String,       // 'vertical' | 'horizontal'
    availableQualities: [String],
    durationMs: Number
}, { _id: false });

const videoProcessingSchema = new mongoose.Schema({
    status: {
        type: String,
        enum: ['uploaded', 'queued', 'processing', 'completed', 'failed', 'error'],
        default: 'uploaded'
    },

    progress: {
        type: Number,
        default: 0
    },

    originalFileName: String,
    originalPath: String,
    originalSize: Number,

    duration: Number,
    originalResolution: String,

    availableQualities: {
        type: [String],
        default: []
    },

    hlsFolder: String,

    masterPlaylist: {
        type: String,
        default: 'master.m3u8'
    },

    thumbnailPath: String,

    // Preview optimizada (WebP) para las cards del home. Deriva de la custom
    // previewKey si existe; si no, del thumbnail.
    cardPreviewPath: String,

    // Info de la preview generada (para mostrar en el panel).
    cardPreviewInfo: {
        source: String,        // 'custom' (previewKey) | 'frame' (thumbnail)
        width: Number,
        height: Number,
        bytes: Number,
        format: String,        // 'webp'
        previewKeyUsed: String,
        updatedAt: Date
    },

    previewVttPath: String,

    is720pReady: {
        type: Boolean,
        default: false
    },

    is1080pReady: {
        type: Boolean,
        default: false
    },

    errorMessage: String,

    // Historial de reprocesos (manual desde el panel o script). No lo toca el
    // flujo de producción normal.
    reprocessHistory: {
        type: [reprocessEventSchema],
        default: []
    }

}, {
    _id: false
});

const contenidoSchema = new mongoose.Schema({

    nombre: String,

    carpeta: String,

    fileKey: String,

    previewKey: String,

    compressedFileKey: String,

    adminId: mongoose.Schema.Types.ObjectId,

    adminNombre: String,

    videoProcessing: {
        type: videoProcessingSchema,
        default: () => ({})
    }

}, {
    timestamps: true,
    collection: 'Contenido'
});

export default mongoose.model(
    'Contenido',
    contenidoSchema
);