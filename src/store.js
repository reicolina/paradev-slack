import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** AES-256-GCM with a 32-byte key given as base64 or hex. */
export class Cipher {
  constructor(key) {
    const buf = /^[0-9a-f]{64}$/i.test(key) ? Buffer.from(key, 'hex') : Buffer.from(key || '', 'base64');
    if (buf.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes (generate one with: openssl rand -base64 32)');
    this.key = buf;
  }

  encrypt(value) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
    return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join('.');
  }

  decrypt(blob) {
    const [v, iv, tag, data] = blob.split('.');
    if (v !== 'v1') throw new Error('unknown ciphertext version');
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8'));
  }
}

/**
 * Small persistent key-value store: one JSON file, every value encrypted, written atomically.
 * Fine for the handful of users one Slack workspace brings; swap for a database if that grows.
 */
export class FileStore {
  constructor({ file, cipher }) {
    this.file = file;
    this.cipher = cipher;
    this.data = null;
    this.writing = Promise.resolve();
  }

  async load() {
    if (this.data) return this.data;
    try {
      this.data = JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.data = {};
    }
    return this.data;
  }

  async get(key) {
    const data = await this.load();
    return data[key] === undefined ? undefined : this.cipher.decrypt(data[key]);
  }

  async set(key, value) {
    const data = await this.load();
    data[key] = this.cipher.encrypt(value);
    await this.flush();
  }

  async delete(key) {
    const data = await this.load();
    delete data[key];
    await this.flush();
  }

  flush() {
    // Serialize writes; each writes the whole map to a temp file and renames it into place.
    this.writing = this.writing.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(this.data), { mode: 0o600 });
      await fs.rename(tmp, this.file);
    });
    return this.writing;
  }
}

/** Same interface, kept in memory. For tests. */
export class MemoryStore {
  constructor() {
    this.map = new Map();
  }
  async get(key) {
    return this.map.get(key);
  }
  async set(key, value) {
    this.map.set(key, structuredClone(value));
  }
  async delete(key) {
    this.map.delete(key);
  }
}
