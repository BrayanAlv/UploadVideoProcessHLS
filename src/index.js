import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import path from 'path';
import { connectDB } from './config/db.js';
import videoRoutes from './routes/videoRoutes.js';
import { errorHandler } from './middlewares/errorHandler.js';
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
  const { createWorker, startReconciler, enqueueVideoProcessing } = await import('./workers/videoWorker.js');
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

  // Rutas
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
  app.use('/api/videos', videoRoutes);

  // Middleware de error global
  app.use(errorHandler);

  // Iniciar servidor
  app.listen(PORT, () => {
    console.log(` Servidor corriendo en http://localhost:${PORT}`);
    console.log(' Escuchando cola de procesamiento de videos en BullMQ...');
  });
})();