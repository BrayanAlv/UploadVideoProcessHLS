import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import path from 'path';
import { connectDB } from './config/db.js';
import videoRoutes from './routes/videoRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import { errorHandler } from './middlewares/errorHandler.js';
import { adminAuth, getAdminCredentials } from './middlewares/adminAuth.js';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './config/swagger.js';
import Contenido from './models/Contenido.js';

// Cargar variables de entorno
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Conectar a MongoDB ANTES de crear el worker y arrancar el servidor
(async () => {
  await connectDB();

  // Crear el Worker SOLO después de que la conexión esté establecida
  const { createWorker, startReconciler, enqueueVideoProcessing, WORKER_CONCURRENCY } = await import('./workers/videoWorker.js');
  const videoWorker = createWorker();
  videoWorker.on('failed', (job, err) => {
    console.error(`[Worker] Error crítico persistente en Job ${job.id}: ${err.message}`);
  });

  startReconciler(Contenido, enqueueVideoProcessing);

  // Middlewares
  app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
  }));
  app.use(morgan('dev'));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Servir archivos estáticos para reproducción web
  app.use('/storage', express.static(path.join(process.cwd(), 'storage'), {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.m3u8')) {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      }
      if (filePath.endsWith('.ts')) {
        res.setHeader('Content-Type', 'video/MP2T');
      }
    }
  }));

  // Mini UI de administración de reproceso (selección manual) — protegida con Basic Auth
  app.use('/admin', adminAuth, express.static(path.join(process.cwd(), 'public')));
  app.get('/admin', adminAuth, (_req, res) => {
    res.sendFile(path.join(process.cwd(), 'public', 'admin.html'));
  });

  // Rutas
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
  app.use('/api/videos', videoRoutes);
  app.use('/api/admin', adminAuth, adminRoutes);

  // Middleware de error global
  app.use(errorHandler);

  // Iniciar servidor
  app.listen(PORT, () => {
    const { user, password } = getAdminCredentials();
    const reconcilerMs = Number(process.env.RECONCILER_INTERVAL_MS || 5 * 60 * 1000);
    const linea = '─'.repeat(48);
    console.log(`
┌${linea}┐
  UploadVideoProcessHLS — worker + API
${linea}
  Puerto:               http://localhost:${PORT}
  Concurrencia worker:  ${WORKER_CONCURRENCY}  (WORKER_CONCURRENCY, videos a la vez)
  Redis:                ${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}
  Mongo DB:             ${process.env.DB_NAME || '(sin DB_NAME)'}
  Reconciler:           cada ${reconcilerMs} ms
  Panel admin:          http://localhost:${PORT}/admin
  Admin usuario:        ${user}
  Admin password:       ${password}
└${linea}┘
`);
    console.log(' Escuchando cola de procesamiento de videos en BullMQ...');
  });
})();