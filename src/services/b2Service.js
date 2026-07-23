import {
    S3Client,
    ListObjectsV2Command,
    GetObjectCommand,
    PutObjectCommand,
    HeadObjectCommand,
    CopyObjectCommand,
    DeleteObjectCommand,
    DeleteObjectsCommand,
    CreateMultipartUploadCommand,
    UploadPartCommand,
    CompleteMultipartUploadCommand,
    AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { Agent as HttpsAgent } from "https";
import { Readable } from "stream";
import "dotenv/config";

// In-memory LRU cache — skips B2 for repeated requests (reduces bandwidth costs).
// Only caches files ≤ 2 MB. Total cap: 150 MB. TTL: 1 hour.
const CACHE_MAX_FILE = 2 * 1024 * 1024;
const CACHE_MAX_TOTAL = 150 * 1024 * 1024;
const CACHE_TTL = 60 * 60 * 1000;
const _cache = new Map(); // key → { buf, contentType, addedAt }
let _cacheBytes = 0;

function _cacheGet(key) {
    const e = _cache.get(key);
    if (!e) return null;
    if (Date.now() - e.addedAt > CACHE_TTL) {
        _cache.delete(key);
        _cacheBytes -= e.buf.length;
        return null;
    }
    _cache.delete(key);
    _cache.set(key, e); // move to end (LRU)
    return e;
}

function _cacheSet(key, buf, contentType) {
    if (_cache.has(key)) return; // already cached
    while (_cacheBytes + buf.length > CACHE_MAX_TOTAL && _cache.size > 0) {
        const [k, old] = _cache.entries().next().value;
        _cache.delete(k);
        _cacheBytes -= old.buf.length;
    }
    _cache.set(key, { buf, contentType, addedAt: Date.now() });
    _cacheBytes += buf.length;
}

function _cacheDelete(key) {
    const existing = _cache.get(key);
    if (!existing) return;
    _cache.delete(key);
    _cacheBytes -= existing.buf.length;
}

const B2_CONNECTION_TIMEOUT_MS = Number(process.env.B2_CONNECTION_TIMEOUT_MS || 15000);
const B2_REQUEST_TIMEOUT_MS = Number(process.env.B2_REQUEST_TIMEOUT_MS || 120000);
const B2_MAX_ATTEMPTS = Number(process.env.B2_MAX_ATTEMPTS || 4);
const B2_APP_RETRIES = Number(process.env.B2_APP_RETRIES || 2);
const B2_RETRY_BASE_DELAY_MS = Number(process.env.B2_RETRY_BASE_DELAY_MS || 350);

const httpsAgent = new HttpsAgent({
    keepAlive: true,
    maxSockets: Number(process.env.B2_MAX_SOCKETS || 80),
    maxFreeSockets: Number(process.env.B2_MAX_FREE_SOCKETS || 20),
    timeout: B2_REQUEST_TIMEOUT_MS,
});

const s3 = new S3Client({
    endpoint: process.env.B2_ENDPOINT,
    region: "us-east-005",
    maxAttempts: B2_MAX_ATTEMPTS,
    requestHandler: new NodeHttpHandler({
        connectionTimeout: B2_CONNECTION_TIMEOUT_MS,
        requestTimeout: B2_REQUEST_TIMEOUT_MS,
        httpsAgent,
    }),
    credentials: {
        accessKeyId: process.env.B2_KEY_ID,
        secretAccessKey: process.env.B2_APPLICATION_KEY,
    },
});

const BUCKET = process.env.B2_BUCKET_NAME;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isRetriableB2Error(error) {
    const status = Number(error?.$metadata?.httpStatusCode || error?.statusCode || error?.status || 0);
    const name = String(error?.name || error?.Code || error?.code || "");
    const message = String(error?.message || "").toLowerCase();
    return (
        status === 429 ||
        status === 500 ||
        status === 502 ||
        status === 503 ||
        status === 504 ||
        name === "TimeoutError" ||
        name === "ECONNRESET" ||
        name === "ETIMEDOUT" ||
        name === "EAI_AGAIN" ||
        message.includes("timeout") ||
        message.includes("socket timed out") ||
        message.includes("network socket disconnected")
    );
}

async function withB2Retry(operation, { retries = B2_APP_RETRIES } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            if (attempt >= retries || !isRetriableB2Error(error)) break;
            const delay = B2_RETRY_BASE_DELAY_MS * 2 ** attempt + Math.floor(Math.random() * 120);
            await sleep(delay);
        }
    }
    throw lastError;
}

export const VALID_FOLDERS = [
    "Videos/HLS",
];

export function isValidFolder(folder) {
    return VALID_FOLDERS.includes(folder);
}

export async function listFiles(folder) {
    const allContents = [];
    let continuationToken = undefined;

    do {
        const command = new ListObjectsV2Command({
            Bucket: BUCKET,
            Prefix: `${folder}/`,
            ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
        });
        const response = await withB2Retry(() => s3.send(command));
        allContents.push(...(response.Contents || []));
        continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);

    return allContents
        .filter((item) => item.Key !== `${folder}/` && !item.Key.endsWith(".bzEmpty"))
        .map((item) => ({
            key: item.Key,
            name: item.Key.replace(`${folder}/`, ""),
            size: item.Size,
            lastModified: item.LastModified,
        }));
}

export async function getFileUrl(key) {
    const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
    return getSignedUrl(s3, command, { expiresIn: 3600 });
}

export async function uploadFile(fileBuffer, folder, fileName, mimeType, metadata = {}) {
    const key = `${folder}/${fileName}`;
    const command = new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: fileBuffer,
        ContentType: mimeType,
        Metadata: metadata,
    });
    await withB2Retry(() => s3.send(command));
    _cacheDelete(key);
    return key;
}

export async function initMultipartUpload(folder, fileName, mimeType, metadata = {}) {
    const key = `${folder}/${fileName}`;
    const command = new CreateMultipartUploadCommand({
        Bucket: BUCKET,
        Key: key,
        ContentType: mimeType || "application/octet-stream",
        Metadata: metadata,
    });
    const response = await withB2Retry(() => s3.send(command));
    if (!response.UploadId) throw new Error("No se pudo iniciar multipart upload");
    return { key, uploadId: response.UploadId };
}

export async function getUploadPartSignedUrl(key, uploadId, partNumber) {
    const command = new UploadPartCommand({
        Bucket: BUCKET,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
    });
    return getSignedUrl(s3, command, { expiresIn: 3600 });
}

export async function completeMultipartUpload(key, uploadId, parts) {
    const command = new CompleteMultipartUploadCommand({
        Bucket: BUCKET,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
            Parts: parts.map((part) => ({
                ETag: part.ETag,
                PartNumber: part.PartNumber,
            })),
        },
    });
    await withB2Retry(() => s3.send(command));
    return key;
}

export async function abortMultipartUpload(key, uploadId) {
    const command = new AbortMultipartUploadCommand({
        Bucket: BUCKET,
        Key: key,
        UploadId: uploadId,
    });
    await withB2Retry(() => s3.send(command));
}

export async function downloadBuffer(key) {
    const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
    const response = await withB2Retry(() => s3.send(command));
    const chunks = [];
    for await (const chunk of response.Body) chunks.push(chunk);
    return Buffer.concat(chunks);
}

export async function deleteFile(key) {
    const command = new DeleteObjectCommand({ Bucket: BUCKET, Key: key });
    await withB2Retry(() => s3.send(command));
    _cacheDelete(key);
}

// Borra recursivamente todos los objetos bajo un prefijo (una "carpeta").
// Usado al reprocesar para eliminar el HLS viejo y no dejar segmentos huérfanos
// que ocupen espacio. Devuelve la cantidad de objetos borrados.
export async function deleteFolder(prefix) {
    // Normalizamos: sin barra final para no perder objetos y luego listamos por prefijo.
    const normalized = String(prefix).replace(/\/+$/, "");
    let continuationToken = undefined;
    let deleted = 0;

    do {
        const listCommand = new ListObjectsV2Command({
            Bucket: BUCKET,
            Prefix: `${normalized}/`,
            ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
        });
        const response = await withB2Retry(() => s3.send(listCommand));
        const contents = response.Contents || [];

        if (contents.length) {
            // DeleteObjects acepta hasta 1000 llaves por lote.
            for (let i = 0; i < contents.length; i += 1000) {
                const batch = contents.slice(i, i + 1000);
                const deleteCommand = new DeleteObjectsCommand({
                    Bucket: BUCKET,
                    Delete: {
                        Objects: batch.map((item) => ({ Key: item.Key })),
                        Quiet: true,
                    },
                });
                await withB2Retry(() => s3.send(deleteCommand));
                batch.forEach((item) => _cacheDelete(item.Key));
                deleted += batch.length;
            }
        }

        continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);

    return deleted;
}

export async function updateFileMetadata(key, newMetadata) {
    const command = new CopyObjectCommand({
        Bucket: BUCKET,
        CopySource: `${BUCKET}/${key}`,
        Key: key,
        Metadata: newMetadata,
        MetadataDirective: "REPLACE",
    });
    await withB2Retry(() => s3.send(command));
}

export async function getFileMetadata(key) {
    const command = new HeadObjectCommand({ Bucket: BUCKET, Key: key });
    const response = await withB2Retry(() => s3.send(command));
    return {
        key,
        size: response.ContentLength,
        contentType: response.ContentType,
        lastModified: response.LastModified,
        metadata: response.Metadata || {},
    };
}

// Stream a B2 file through the backend (browser never contacts Backblaze directly).
// Files ≤ 2 MB are cached in memory so subsequent requests skip B2 entirely.
function parseByteRange(rangeHeader, totalLength) {
    if (!rangeHeader || !String(rangeHeader).startsWith("bytes=")) return null;
    if (!Number.isFinite(totalLength) || totalLength <= 0) return null;

    const [startRaw, endRaw] = String(rangeHeader).replace("bytes=", "").split("-");
    let start;
    let end;

    if (startRaw === "") {
        const suffixLength = Number(endRaw);
        if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
        start = Math.max(totalLength - suffixLength, 0);
        end = totalLength - 1;
    } else {
        start = Number(startRaw);
        end = endRaw ? Number(endRaw) : totalLength - 1;
    }

    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    if (start < 0 || end < start || start >= totalLength) return null;

    return {
        start,
        end: Math.min(end, totalLength - 1),
    };
}

export async function streamFile(key, options = {}) {
    const requestedRange = options.range || null;

    // Extraemos fileId o versionId de las opciones (Backblaze B2 usa esto como VersionId en S3)
    const versionId = options.fileId || null;

    // Actualizamos la clave de caché para que sea única por versión
    const cacheKey = versionId ? `${key}?versionId=${versionId}` : key;

    const cached = _cacheGet(cacheKey);

    if (cached) {
        const range = parseByteRange(requestedRange, cached.buf.length);
        if (range) {
            const chunk = cached.buf.subarray(range.start, range.end + 1);
            return {
                body: Readable.from(chunk),
                contentType: cached.contentType,
                contentLength: chunk.length,
                contentRange: `bytes ${range.start}-${range.end}/${cached.buf.length}`,
                statusCode: 206,
            };
        }
        return {
            body: Readable.from(cached.buf),
            contentType: cached.contentType,
            contentLength: cached.buf.length,
            statusCode: 200,
            fromCache: true,
        };
    }

    // Preparamos los parámetros del comando dinámicamente
    const commandParams = {
        Bucket: BUCKET,
        Key: key, // El Key SIEMPRE es requerido por el SDK de S3
        ...(requestedRange ? { Range: requestedRange } : {}),
        ...(versionId ? { VersionId: versionId } : {}), // Inyectamos el fileID/versionID aquí
    };

    const command = new GetObjectCommand(commandParams);

    const response = await withB2Retry(async () => {
        const result = await s3.send(command);

        if (!requestedRange) {
            const contentLength = result.ContentLength;
            if (options.bufferResponse || (contentLength && contentLength <= CACHE_MAX_FILE)) {
                const chunks = [];
                for await (const chunk of result.Body) chunks.push(chunk);
                return {
                    ...result,
                    Body: Buffer.concat(chunks),
                    __buffered: true,
                };
            }
        }

        return result;
    });

    const contentType = response.ContentType || "application/octet-stream";
    const contentLength = response.ContentLength;

    if (response.__buffered) {
        const buf = response.Body;
        // Guardamos en caché usando el cacheKey que incluye la versión
        if (buf.length <= CACHE_MAX_FILE) _cacheSet(cacheKey, buf, contentType);
        return {
            body: Readable.from(buf),
            contentType,
            contentLength: buf.length,
            statusCode: 200,
            fromCache: buf.length <= CACHE_MAX_FILE,
        };
    }

    return {
        body: response.Body,
        contentType,
        contentLength,
        contentRange: response.ContentRange,
        statusCode: response.ContentRange ? 206 : 200,
    };
}