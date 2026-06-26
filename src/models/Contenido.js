// models/Contenido.js

import mongoose from 'mongoose';

const videoProcessingSchema = new mongoose.Schema({
    status: {
        type: String,
        enum: ['uploaded', 'processing', 'completed', 'failed'],
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

    previewVttPath: String,

    is720pReady: {
        type: Boolean,
        default: false
    },

    is1080pReady: {
        type: Boolean,
        default: false
    },

    errorMessage: String

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