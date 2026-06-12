import fs from 'fs/promises';
import path from 'path';

class LocalStorageService {
  async saveFile(tempPath, targetDir, fileName) {
    const finalPath = path.join(targetDir, fileName);
    await fs.mkdir(targetDir, { recursive: true });
    await fs.rename(tempPath, finalPath);
    return finalPath;
  }

  async deleteFile(filePath) {
    try {
      await fs.unlink(filePath);
    } catch (error) {
      console.error(`Error eliminando archivo ${filePath}:`, error.message);
    }
  }

  getFilePath(directory, fileName) {
    return path.join(directory, fileName);
  }
}

export const storageService = new LocalStorageService();
