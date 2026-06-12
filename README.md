# Sistema de Procesamiento de Video (MVP)

Este proyecto es un sistema de procesamiento de video asíncrono construido con Node.js, Express, MongoDB, Redis, BullMQ y FFmpeg.

## Requisitos Previos

Asegúrate de tener instalados los siguientes servicios en tu servidor Ubuntu:

1. **Node.js** (v18 o superior recomendado)
2. **MongoDB**
3. **Redis**
4. **FFmpeg**

### Instalación de FFmpeg en Ubuntu

```bash
sudo apt update
sudo apt install ffmpeg
```

## Instalación del Proyecto

1. Clonar el repositorio o copiar los archivos al servidor.
2. Instalar las dependencias:
   ```bash
   npm install
   ```
3. Configurar las variables de entorno:
   - Crear un archivo `.env` en la raíz del proyecto (puedes basarte en el `.env` proporcionado).
   - Asegúrate de que las rutas de almacenamiento existan o el sistema las creará automáticamente.

## Configuración de Recursos (Optimización para VPS)

El sistema está configurado para operar en un VPS con recursos limitados (2 vCPU, 4GB RAM):

- **Memoria RAM**: Se ha limitado el proceso de Node.js a **2GB** (usando `--max-old-space-size=2048`) para asegurar que el sistema operativo y otros servicios tengan memoria disponible.
- **CPU**: FFmpeg está limitado a **2 hilos** (`-threads 2`) por tarea para evitar saturar los núcleos del servidor.
- **Concurrencia**: El Worker procesa **un video a la vez** (`concurrency: 1`) para mantener un consumo predecible.

## Ejecución

### Modo Producción
```bash
npm start
```

### Modo Desarrollo
```bash
npm run dev
```

## Documentación de la API

La documentación interactiva de la API está disponible (cuando el servidor está corriendo) en:

`http://localhost:3000/api-docs`

Utiliza Swagger UI para probar los endpoints directamente desde el navegador.

## Endpoints de la API

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/api/videos/upload` | Sube un video original (form-data: `video` y `title`) |
| GET | `/api/videos` | Lista todos los videos procesados o en proceso (paginado) |
| GET | `/api/videos/:id` | Obtiene el detalle de un video específico |
| GET | `/api/videos/:id/status` | Obtiene el estado actual y el progreso del procesamiento |
| GET | `/api/videos/:id/stream` | Reproduce el video mediante streaming (soporta `quality` query param) |

## Flujo de Trabajo

1. **Upload**: El usuario envía un video al endpoint `/upload`. `multer` guarda el archivo en `storage/uploads`.
2. **Registro**: Se crea un documento en MongoDB con estado `uploaded`.
3. **Cola (Queue)**: Se añade un trabajo a la cola de BullMQ con el ID del video.
4. **Respuesta**: La API responde inmediatamente al usuario con el `videoId`.
5. **Procesamiento (Worker)**:
   - El Worker toma el trabajo de la cola (concurrencia: 1).
   - Actualiza el estado a `processing`.
   - Genera un thumbnail al segundo 1 usando FFmpeg.
   - Transcodifica el video a 720p (H.264/AAC) en `storage/temp`.
   - Reporta el progreso a la base de datos durante la transcodificación.
   - Al finalizar, mueve el video procesado a `storage/processed` y actualiza el estado a `completed`.
   - Si ocurre un error, limpia archivos temporales y marca el video como `failed`.

## Estructura de Almacenamiento

- `storage/uploads/`: Videos originales subidos.
- `storage/processed/`: Videos optimizados a 720p.
- `storage/thumbnails/`: Miniaturas generadas.
- `storage/temp/`: Archivos temporales durante el procesamiento.

## Escalabilidad Futura

El sistema está diseñado para:
- Cambiar fácilmente a almacenamiento en la nube (ej. Backblaze B2) reemplazando la implementación en `src/services/storageService.js`.
- Escalar horizontalmente añadiendo más Workers en servidores con mayor capacidad.
