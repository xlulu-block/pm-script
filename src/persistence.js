import { appendFile, rename, stat, unlink } from "node:fs/promises";

const fileSizeCache = new Map();

async function unlinkIfExists(path) {
  try {
    await unlink(path);
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
}

async function renameIfExists(fromPath, toPath) {
  try {
    await rename(fromPath, toPath);
    return true;
  } catch (err) {
    if (err?.code === "ENOENT") return false;
    throw err;
  }
}

async function getFileSize(path) {
  if (fileSizeCache.has(path)) {
    return fileSizeCache.get(path);
  }

  try {
    const details = await stat(path);
    fileSizeCache.set(path, details.size);
    return details.size;
  } catch (err) {
    if (err?.code === "ENOENT") {
      fileSizeCache.set(path, 0);
      return 0;
    }
    throw err;
  }
}

async function rotateFile(path, keepFiles) {
  const normalizedKeepFiles = Math.max(0, Number(keepFiles) || 0);
  if (normalizedKeepFiles <= 0) {
    await unlinkIfExists(path);
    fileSizeCache.set(path, 0);
    return;
  }

  await unlinkIfExists(`${path}.${normalizedKeepFiles}`);

  for (let index = normalizedKeepFiles - 1; index >= 1; index--) {
    await renameIfExists(`${path}.${index}`, `${path}.${index + 1}`);
  }

  await renameIfExists(path, `${path}.1`);
  fileSizeCache.set(path, 0);
}

export async function appendJsonlWithRotation(path, entry, options = {}) {
  const line = `${JSON.stringify(entry)}\n`;
  const lineBytes = Buffer.byteLength(line, "utf8");
  const maxBytes = Math.max(0, Number(options.maxBytes) || 0);
  const keepFiles = Math.max(0, Number(options.keepFiles) || 0);

  if (maxBytes > 0) {
    const currentSize = await getFileSize(path);
    if (currentSize > 0 && currentSize + lineBytes > maxBytes) {
      await rotateFile(path, keepFiles);
    }
  }

  await appendFile(path, line, "utf8");
  const currentSize = fileSizeCache.get(path) || 0;
  fileSizeCache.set(path, currentSize + lineBytes);
}
