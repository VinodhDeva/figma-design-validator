import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const hashKey = (...parts: unknown[]) =>
  createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 16);

/** JSON file cache with TTL, used for Figma metadata and exported images. */
export class FileCache {
  private dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  path(key: string, ext = 'json') {
    return join(this.dir, `${key}.${ext}`);
  }

  async fresh(key: string, ttlMs: number, ext = 'json') {
    try {
      const s = await stat(this.path(key, ext));
      return Date.now() - s.mtimeMs < ttlMs;
    } catch {
      return false;
    }
  }

  async getJson<T>(key: string, ttlMs: number): Promise<T | undefined> {
    if (!(await this.fresh(key, ttlMs))) return undefined;
    try {
      return JSON.parse(await readFile(this.path(key), 'utf8')) as T;
    } catch {
      return undefined;
    }
  }

  async put(key: string, data: unknown, ext = 'json') {
    await mkdir(this.dir, { recursive: true });
    const p = this.path(key, ext);
    await writeFile(p, ext === 'json' ? JSON.stringify(data) : (data as Buffer));
    return p;
  }
}

/** Short-lived in-process memo for browser inspection results (avoids re-launching pages on repeat calls). */
export class MemoryCache<T> {
  private m = new Map<string, { at: number; v: T }>();
  private ttlMs: number;
  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }
  get(k: string) {
    const e = this.m.get(k);
    if (e && Date.now() - e.at < this.ttlMs) return e.v;
    this.m.delete(k);
    return undefined;
  }
  set(k: string, v: T) {
    this.m.set(k, { at: Date.now(), v });
  }
  clear() {
    this.m.clear();
  }
}
