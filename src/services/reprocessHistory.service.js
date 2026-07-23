// services/reprocessHistory.service.js
//
// Registro del historial de reprocesos, embebido en videoProcessing.reprocessHistory
// de cada Contenido. Un evento por reproceso, identificado por eventId, que
// transiciona queued -> processing -> completed/failed.

import crypto from 'crypto';
import Contenido from '../models/Contenido.js';

// Crea un evento nuevo (status 'queued') y devuelve su eventId.
export async function startReprocessEvent(videoId, { source, reason, batchId, mode } = {}) {
    const eventId = crypto.randomUUID();
    const evento = {
        eventId,
        at: new Date(),
        source: source || 'manual-ui',
        reason: reason || '',
        mode: mode || 'full',
        batchId: batchId || null,
        status: 'queued',
    };
    await Contenido.updateOne(
        { _id: videoId },
        { $push: { 'videoProcessing.reprocessHistory': evento } }
    );
    return eventId;
}

// Actualiza campos de un evento existente por eventId (usa arrayFilters).
export async function updateReprocessEvent(videoId, eventId, patch = {}) {
    if (!eventId) return;
    const setData = {};
    Object.entries(patch).forEach(([key, value]) => {
        setData[`videoProcessing.reprocessHistory.$[e].${key}`] = value;
    });
    if (!Object.keys(setData).length) return;
    await Contenido.updateOne(
        { _id: videoId },
        { $set: setData },
        { arrayFilters: [{ 'e.eventId': eventId }] }
    );
}

// Registra directamente un evento ya terminado (ej. omitidos "sin fileKey").
export async function logFinishedEvent(videoId, { source, reason, batchId, status, errorMessage, mode } = {}) {
    const evento = {
        eventId: crypto.randomUUID(),
        at: new Date(),
        finishedAt: new Date(),
        source: source || 'manual-ui',
        reason: reason || '',
        mode: mode || 'full',
        batchId: batchId || null,
        status: status || 'failed',
        errorMessage: errorMessage || '',
    };
    await Contenido.updateOne(
        { _id: videoId },
        { $push: { 'videoProcessing.reprocessHistory': evento } }
    );
}
