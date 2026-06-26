```python
markdown_content = """# Guía de Pruebas: Aislamiento del Video-Worker en Docker

Este documento detalla el procedimiento técnico para levantar, validar y forzar el procesamiento de videos en el contenedor independiente `video-worker` de manera aislada, sin necesidad de ejecutar la API principal (CRM).

---

## 1. Arquitectura del Entorno de Pruebas

Durante esta prueba, simularemos la infraestructura mínima requerida por el procesador. El entorno consta de:
* **`test-redis-worker`**: Instancia limpia de Redis para actuar como el bus de la cola de BullMQ. Expone el puerto `6379` al host local para permitir la inyección de datos externa.
* **`test-worker-app`**: El contenedor construido mediante tu `Dockerfile.worker` con los binarios de FFmpeg/FFprobe inyectados nativamente bajo la distribución Alpine.
* **`test-storage`**: Un volumen de Docker que emula el sistema de almacenamiento compartido en disco del VPS.


```

[Tu Máquina Local (Script)] ──(Puerto 6379)──► [ test-redis-worker ]
▲
│ (Cola: video-processing)
▼
[ Volumen: test-storage ] ◄──(Lee/Escribe)─────── [ test-worker-app ]

```

---

## 2. Preparación del Entorno

### Paso 1: Configurar el archivo de orquestación
Asegúrate de tener el archivo `docker-compose.test.yml` en la raíz del proyecto (`~/WebstormProjects/demo_video_upload`) con la siguiente estructura limpia:

```yaml
networks:
  worker-test-net:
    driver: bridge

volumes:
  test-storage:
    driver: local

services:
  test-redis:
    image: redis:7-alpine
    container_name: test-redis-worker
    ports:
      - "6379:6379"
    networks:
      - worker-test-net

  test-worker:
    build:
      context: .
      dockerfile: Dockerfile.worker
    container_name: test-worker-app
    environment:
      - NODE_ENV=development
      - REDIS_HOST=test-redis
      - REDIS_PORT=6379
      - MONGO_URI=mongodb+srv://tu_usuario:tu_password@cluster.mongodb.net/tu_db_test
    volumes:
      - test-storage:/app/storage
    networks:
      - worker-test-net
    depends_on:
      - test-redis

```

### Paso 2: Desplegar los contenedores

Ejecuta el comando en tu terminal para compilar la imagen e iniciar los servicios en primer plano (foreground) para auditar los logs en tiempo real:

```bash
docker-compose -f docker-compose.test.yml up --build

```

**Resultado esperado en consola:**

* Descarga e instalación de la paquetería de `ffmpeg` mediante el gestor `apk`.
* Logs de Redis indicando la inicialización del servidor en el puerto `6379`.
* Log del worker confirmando conexión exitosa:
  `🤖 Escuchando cola de procesamiento de videos en BullMQ...`

---

## 3. Simulación de Carga y Ejecución de Tareas

Al estar aislada la API, no disponemos del cargador `multer`. Sigue estos tres pasos para simular una carga de producción real.

### Paso A: Inyectar físicamente el video en el volumen compartido

Docker almacena los volúmenes en un directorio del sistema protegido. Debes localizarlo y mover un video allí.

1. Identifica la ruta del punto de montaje en tu sistema operativo:
```bash
docker volume inspect demo_video_upload_test-storage

```


Busca la propiedad `"Mountpoint"`. En sistemas Linux nativos, usualmente se encuentra en: `/var/lib/docker/volumes/demo_video_upload_test-storage/_data`.
2. Crea la carpeta temporal simulada y copia un archivo de video (`.mp4` o `.mkv`) utilizando permisos de superusuario:
```bash
sudo mkdir -p /var/lib/docker/volumes/demo_video_upload_test-storage/_data/uploads
sudo cp /ruta/de/tu/video_prueba.mp4 /var/lib/docker/volumes/demo_video_upload_test-storage/_data/uploads/

```



### Paso B: Crear el Script Disparador (`trigger.js`)

Crea un script efímero en la raíz de tu proyecto local para conectarte al puerto `6379` de Redis expuesto en el host y enviar un payload con la estructura idéntica que el CRM generaría:

```javascript
// trigger.js
import { Queue } from 'bullmq';

const queue = new Queue('video-processing', {
  connection: { host: '127.0.0.1', port: 6379 }
});

async function lanzarTrabajo() {
  console.log('Enviando payload de prueba a Redis...');
  
  // NOTA: Reemplaza el videoId con un ID real de tu MongoDB Atlas de pruebas
  await queue.add('process-video', { 
    videoId: '60d5ec49f83c5123456789ab', 
    tempPath: 'storage/uploads/video_prueba.mp4' 
  });
  
  console.log('¡Trabajo indexado exitosamente!');
  process.exit(0);
}

lanzarTrabajo().catch(console.error);

```

Ejecuta el script desde otra terminal en tu máquina local:

```bash
node trigger.js

```

---

## 4. Verificación de Resultados

Una vez disparado el script, regresa a la terminal donde se ejecutan los logs de `docker-compose`. Deberías visualizar el siguiente comportamiento secuencial:

1. **Captura del Job:** El contenedor `test-worker-app` imprime en consola:
   `[Worker] Iniciando procesamiento para: <Título del Video>`
2. **Ubicación del archivo:** El log mostrará la reubicación del binario en la estructura interna:
   `[Worker] Moviendo archivo de storage/uploads/video_prueba.mp4 a /app/storage/videos/.../raw/original.mp4`
3. **Picos de procesamiento:** Verás logs progresivos generados por los callbacks de `ffmpegService.js` (Progreso de transcodificación del 0% al 100%).
4. **Validación en disco:** Si inspeccionas la carpeta del volumen una vez terminado el flujo, verás creadas las subcarpetas de reproducción segmentada:
```bash
sudo ls -l /var/lib/docker/volumes/demo_video_upload_test-storage/_data/videos/60d5ec49f83c5123456789ab/hls/

```


Deberán listarse los directorios de variantes (`720p/`, `1080p/`) junto al manifiesto global estático `master.m3u8`.
"""

with open("guia_pruebas_worker.md", "w", encoding="utf-8") as file:
file.write(markdown_content)

```
Tu archivo Markdown está listo para descargar.
[file-tag: code-generated-file-0-1781306655058870406]

He generado la guía técnica detallada en el archivo `guia_pruebas_worker.md`. Contiene toda la arquitectura de testing, la configuración limpia de Docker Compose para desarrollo local sin advertencias de atributos obsoletos, las instrucciones precisas para localizar los volúmenes en caliente e inyectar muestras y el script disparador de eventos con BullMQ.

¿Pudiste ejecutar el script inyector y comprobar el progreso de FFmpeg en la consola?

```