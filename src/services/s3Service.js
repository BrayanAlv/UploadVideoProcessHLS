import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

class S3Service {
  constructor() {
    this.client = new S3Client({
      endpoint: process.env.B2_ENDPOINT, // e.g., https://s3.us-east-005.backblazeb2.com
      region: process.env.B2_REGION || 'us-east-005',
      credentials: {
        accessKeyId: process.env.B2_APPLICATION_KEY_ID,
        secretAccessKey: process.env.B2_APPLICATION_KEY,
      },
    });
    this.bucket = process.env.B2_BUCKET_NAME;
  }

  async uploadFile(filePath, remotePath, contentType) {
    const fileStream = fs.createReadStream(filePath);
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: remotePath,
        Body: fileStream,
        ContentType: contentType,
      },
    });

    try {
      await upload.done();
      console.log(`[S3] Cargado: ${remotePath}`);
      return `https://${this.bucket}.${new URL(process.env.B2_ENDPOINT).host}/${remotePath}`;
    } catch (error) {
      console.error(`[S3] Error cargando ${remotePath}:`, error);
      throw error;
    }
  }

  async uploadDirectory(localDir, remoteDirPrefix) {
    const files = await this.getFiles(localDir);
    for (const file of files) {
      const relativePath = path.relative(localDir, file);
      const remotePath = path.join(remoteDirPrefix, relativePath).replace(/\\/g, '/');
      const contentType = this.getContentType(file);
      await this.uploadFile(file, remotePath, contentType);
    }
  }

  async getFiles(dir) {
    const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
    const files = await Promise.all(dirents.map((dirent) => {
      const res = path.resolve(dir, dirent.name);
      return dirent.isDirectory() ? this.getFiles(res) : res;
    }));
    return Array.prototype.concat(...files);
  }

  getContentType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
      case '.m3u8': return 'application/vnd.apple.mpegurl';
      case '.ts': return 'video/MP2T';
      case '.mp4': return 'video/mp4';
      case '.jpg':
      case '.jpeg': return 'image/jpeg';
      case '.png': return 'image/png';
      case '.vtt': return 'text/vtt';
      default: return 'application/octet-stream';
    }
  }
}

export const s3Service = new S3Service();
