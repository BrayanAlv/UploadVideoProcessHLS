// stress-test.js
import { Queue } from 'bullmq';
import fs from 'fs';
import path from 'path';

const queue = new Queue('video-processing', {
    connection: { host: '127.0.0.1', port: 6379 }
});

// 4 IDs de prueba simulados (puedes cambiarlos por IDs reales de tu MongoDB si quieres)
const fakesVideoIds = [
    '6a2b78f22865ac525a24d6b8', // Tu ID real actual
    '6a2b78f22865ac525a24d6b9',
    '6a2b78f22865ac525a24d6c0',
    '6a2b78f22865ac525a24d6c1'
];

async function simular4SubidasReales() {
    console.log('⏳ Preparando archivos de entorno...');

    const baseDir = path.join(process.cwd(), 'storage', 'uploads');
    const srcFile = path.join(baseDir, 'video_prueba.mp4');

    if (!fs.existsSync(srcFile)) {
        console.error(`❌ Error: Asegúrate de que exista el archivo en: ${srcFile}`);
        process.exit(1);
    }

    console.log('🚀 Inyectando 4 trabajos independientes en ráfaga...');

    for (let i = 0; i < 1; i++) {
        const vId = fakesVideoIds[i];
        const tempFileName = `video_usuario_${i + 1}.mp4`;
        const finalTempPath = path.join(baseDir, tempFileName);

        // Clonamos el video base para que cada job tenga su propio archivo físico independiente
        fs.copyFileSync(srcFile, finalTempPath);

        // Lo agregamos a la cola de Redis
        await queue.add('process-video', {
            videoId: vId,
            tempPath: `storage/uploads/${tempFileName}` // Cada uno procesa su propio archivo
        });

        console.log(`📦 [Video ${i + 1}] Encolado con éxito. ID: ${vId}`);
    }

    console.log('\n¡Listo! Mira la consola de Docker Compose para ver cómo se procesan uno por uno sin destruirse.');
    process.exit(0);
}

simular4SubidasReales().catch(console.error);