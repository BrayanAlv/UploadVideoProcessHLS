// scripts/reprocess.js
//
// Script de USO ÚNICO para reprocesar videos que quedaron mal orientados
// (verticales procesados como horizontales) o que quieras regenerar con la
// nueva escalera de bitrate. Corre en CPU/libx264, igual que producción.
//
// Uso:
//   node scripts/reprocess.js --ids 6a53c30c...,6a53c30d...
//   node scripts/reprocess.js --file ids.txt          (un id por línea)
//   node scripts/reprocess.js --ids <id> --dry-run     (solo muestra, no procesa)
//   node scripts/reprocess.js --ids <id> --reason "vertical mal orientado"
//
// - Descarga SIEMPRE la última versión del fileKey (streamFile sin fileId).
// - Con replaceExisting: borra el HLS/thumbnails viejo en B2 antes de subir.
// - Procesa secuencial (uno a uno), no usa la cola ni el reconciler.
//
// npm run reprocess -- --ids <id>

import 'dotenv/config';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { connectDB } from '../src/config/db.js';
import Contenido from '../src/models/Contenido.js';
import { processVideoJob, videoQueue } from '../src/workers/videoWorker.js';
import { startReprocessEvent } from '../src/services/reprocessHistory.service.js';

function parseArgs(argv) {
    const args = { ids: [], file: null, dryRun: false, reason: '' };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry-run' || a === '--dry') {
            args.dryRun = true;
        } else if (a === '--ids') {
            args.ids.push(...String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean));
        } else if (a === '--file') {
            args.file = argv[++i];
        } else if (a === '--reason') {
            args.reason = String(argv[++i] || '').trim();
        }
    }
    return args;
}

function orientacionDe(originalResolution) {
    if (!originalResolution || !originalResolution.includes('x')) return 'desconocida';
    const [w, h] = originalResolution.split('x').map(Number);
    if (!w || !h) return 'desconocida';
    return h > w ? 'vertical' : (w > h ? 'horizontal' : 'cuadrada');
}

async function main() {
    const args = parseArgs(process.argv.slice(2));

    let ids = [...args.ids];
    if (args.file) {
        const fs = await import('fs');
        const contenidoArchivo = fs.readFileSync(args.file, 'utf8');
        ids.push(...contenidoArchivo.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
    }
    ids = [...new Set(ids)];

    if (!ids.length) {
        console.error('No se pasaron IDs. Usa --ids a,b,c o --file ids.txt');
        process.exit(1);
    }

    await connectDB();

    console.log(`\n=== Reproceso ${args.dryRun ? '(DRY-RUN) ' : ''}de ${ids.length} video(s) ===\n`);

    // Vista previa de lo que se hará.
    for (const id of ids) {
        const doc = await Contenido.findById(id).lean();
        if (!doc) {
            console.log(`  [!] ${id} — NO ENCONTRADO en Contenido`);
            continue;
        }
        const res = doc.videoProcessing?.originalResolution || 'n/d';
        console.log(`  - ${id} | ${doc.nombre || '(sin nombre)'} | carpeta=${doc.carpeta} | res=${res} | orient=${orientacionDe(res)} | status=${doc.videoProcessing?.status || 'n/d'} | fileKey=${doc.fileKey || 'n/d'}`);
    }

    if (args.dryRun) {
        console.log('\nDRY-RUN: no se procesó nada. Quita --dry-run para ejecutar.\n');
        await cerrar();
        return;
    }

    // Un lote compartido para toda la corrida del script (para verlo agrupado).
    const batchId = `lote-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    console.log(`Lote: ${batchId}${args.reason ? ` | motivo: ${args.reason}` : ''}\n`);

    let ok = 0;
    let fail = 0;
    for (const id of ids) {
        const doc = await Contenido.findById(id).lean();
        if (!doc) {
            console.log(`\n[SKIP] ${id} no existe.`);
            fail++;
            continue;
        }
        if (!doc.fileKey) {
            console.log(`\n[SKIP] ${id} sin fileKey.`);
            fail++;
            continue;
        }
        console.log(`\n>>> Procesando ${id} (${doc.nombre || ''})...`);
        try {
            const reprocessEventId = await startReprocessEvent(id, { source: 'script', reason: args.reason, batchId });
            await processVideoJob(
                { videoId: id, s3Key: doc.fileKey, fileID: null, reprocessEventId, batchId },
                { replaceExisting: true }
            );
            console.log(`<<< OK ${id}`);
            ok++;
        } catch (err) {
            console.error(`<<< ERROR ${id}: ${err.message}`);
            fail++;
        }
    }

    console.log(`\n=== Terminado. OK: ${ok} | Fallidos: ${fail} ===\n`);
    await cerrar();
}

async function cerrar() {
    try { await videoQueue.close(); } catch { /* ignore */ }
    try { await mongoose.disconnect(); } catch { /* ignore */ }
    process.exit(0);
}

main().catch(async (err) => {
    console.error('Error fatal:', err);
    await cerrar();
});
