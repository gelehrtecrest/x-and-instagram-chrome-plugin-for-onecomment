'use strict';

const http = require('http');
const crypto = require('crypto');
const { redactConfig, validateAndApplyPatch } = require('./config');
const { SUPPORTED_PLATFORMS, normalizeComment } = require('./normalizer');

const MAX_BODY_BYTES = 256 * 1024;
const MAX_COMMENTS_PER_REQUEST = 50;

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (origin.startsWith('chrome-extension://')) return true;
  if (origin === 'http://localhost' || origin.startsWith('http://localhost:')) return true;
  if (origin === 'http://127.0.0.1' || origin.startsWith('http://127.0.0.1:')) return true;
  return false;
}

function timingSafeCompare(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;

    req.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        const err = new Error('リクエストボディが大きすぎます（上限 256KB）。');
        err.statusCode = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(JSON.parse(text));
      } catch {
        const err = new Error('JSONの構文が不正です。');
        err.statusCode = 400;
        reject(err);
      }
    });

    req.on('error', (err) => reject(err));
  });
}

class BridgeServer {
  constructor({ pluginInfo, getConfig, saveConfig, onecommeClient, dedupCache, logger }) {
    this.pluginInfo = pluginInfo;
    this.getConfig = getConfig;
    this.saveConfig = saveConfig;
    this.onecommeClient = onecommeClient;
    this.dedupCache = dedupCache;
    this.logger = logger || console;
    this.server = null;
    this.sockets = new Set();
    this.stats = {
      startedAt: null,
      received: 0,
      accepted: 0,
      skippedDuplicate: 0,
      skippedFiltered: 0,
      failed: 0,
    };
  }

  sendJson(res, statusCode, body, origin) {
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    };
    if (origin && isAllowedOrigin(origin)) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Vary'] = 'Origin';
    }
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, X-Bridge-Token';

    res.writeHead(statusCode, headers);
    res.end(JSON.stringify(body));
  }

  checkAuth(req) {
    const config = this.getConfig();
    if (!config.token) return true;
    const provided = req.headers['x-bridge-token'];
    if (typeof provided !== 'string' || !provided) return false;
    return timingSafeCompare(provided, config.token);
  }

  async handleRequest(req, res) {
    const origin = req.headers.origin;
    if (origin && !isAllowedOrigin(origin)) {
      this.sendJson(res, 403, { ok: false, error: '許可されていないオリジンからのリクエストです。' });
      return;
    }

    if (req.method === 'OPTIONS') {
      const headers = {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Bridge-Token',
        'Access-Control-Max-Age': '600',
      };
      if (origin) {
        headers['Access-Control-Allow-Origin'] = origin;
        headers['Vary'] = 'Origin';
      }
      res.writeHead(204, headers);
      res.end();
      return;
    }

    let pathname = '/';
    try {
      const parsedUrl = new URL(req.url, 'http://127.0.0.1');
      pathname = parsedUrl.pathname;
    } catch {
      this.sendJson(res, 400, { ok: false, error: 'URLが不正です。' }, origin);
      return;
    }

    if (!this.checkAuth(req)) {
      this.sendJson(res, 401, { ok: false, error: 'X-Bridge-Token が一致しません。' }, origin);
      return;
    }

    try {
      if (req.method === 'GET' && pathname === '/health') {
        await this.handleHealth(res, origin);
        return;
      }
      if (req.method === 'GET' && pathname === '/services') {
        await this.handleServices(res, origin);
        return;
      }
      if (req.method === 'GET' && pathname === '/config') {
        this.sendJson(res, 200, { ok: true, config: redactConfig(this.getConfig()) }, origin);
        return;
      }
      if (req.method === 'POST' && pathname === '/config') {
        await this.handleConfigUpdate(req, res, origin);
        return;
      }
      if (req.method === 'POST' && pathname === '/comments') {
        await this.handleComments(req, res, origin);
        return;
      }

      this.sendJson(res, 404, { ok: false, error: 'Not Found' }, origin);
    } catch (err) {
      const statusCode = err && err.statusCode ? err.statusCode : 500;
      this.logger.error(`[X-IG-Bridge] リクエスト処理エラー (${req.method} ${pathname}):`, err.message);
      this.sendJson(res, statusCode, { ok: false, error: err.message || 'Internal Server Error' }, origin);
    }
  }

  async handleHealth(res, origin) {
    const config = this.getConfig();
    const onecommeReachable = await this.onecommeClient.checkReachable();
    this.sendJson(
      res,
      200,
      {
        status: 'ok',
        plugin: this.pluginInfo.name,
        uid: this.pluginInfo.uid,
        version: this.pluginInfo.version,
        onecommeReachable,
        mapping: {
          x: {
            serviceId: config.services.x.id,
            serviceName: config.services.x.name,
          },
          instagram: {
            serviceId: config.services.instagram.id,
            serviceName: config.services.instagram.name,
          },
        },
        stats: { ...this.stats },
      },
      origin
    );
  }

  async handleServices(res, origin) {
    try {
      const services = await this.onecommeClient.getServices({ forceRefresh: true });
      this.sendJson(res, 200, { ok: true, services }, origin);
    } catch (err) {
      this.sendJson(
        res,
        502,
        {
          ok: false,
          error: `わんコメから枠一覧を取得できませんでした: ${err.message}`,
          services: [],
        },
        origin
      );
    }
  }

  async handleConfigUpdate(req, res, origin) {
    const body = await readJsonBody(req);
    const result = validateAndApplyPatch(this.getConfig(), body);
    if (result.error) {
      this.sendJson(res, 400, { ok: false, error: result.error }, origin);
      return;
    }

    this.saveConfig(result.config);
    this.dedupCache.updateLimits({
      ttlMs: result.config.dedupTtlMs,
      maxEntries: result.config.dedupMaxEntries,
    });
    this.onecommeClient.invalidateServicesCache();

    this.sendJson(
      res,
      200,
      {
        ok: true,
        config: redactConfig(result.config),
        restarting: result.portChanged,
      },
      origin
    );

    if (result.portChanged) {
      setTimeout(() => {
        this.restart().catch((err) => {
          this.logger.error('[X-IG-Bridge] ポート変更後の再起動に失敗しました:', err.message);
        });
      }, 150);
    }
  }

  async handleComments(req, res, origin) {
    const body = await readJsonBody(req);
    const platform = typeof body.platform === 'string' ? body.platform.toLowerCase().trim() : '';
    if (!SUPPORTED_PLATFORMS.has(platform)) {
      this.sendJson(
        res,
        400,
        { ok: false, error: 'platform は "x" または "instagram" を指定してください。' },
        origin
      );
      return;
    }

    const sourceType = typeof body.sourceType === 'string' ? body.sourceType.toLowerCase().trim() : 'live';
    if (sourceType !== 'live') {
      this.sendJson(
        res,
        400,
        { ok: false, error: '本システムは live コメント専用です（sourceType は "live" を指定してください）。' },
        origin
      );
      return;
    }

    if (!Array.isArray(body.comments) || body.comments.length === 0) {
      this.sendJson(res, 400, { ok: false, error: 'comments は1件以上の配列で指定してください。' }, origin);
      return;
    }

    if (body.comments.length > MAX_COMMENTS_PER_REQUEST) {
      this.sendJson(
        res,
        400,
        { ok: false, error: `1リクエストあたりの最大コメント数は ${MAX_COMMENTS_PER_REQUEST} 件です。` },
        origin
      );
      return;
    }

    const config = this.getConfig();
    let serviceId;
    try {
      serviceId = await this.onecommeClient.resolveServiceId(platform, body.serviceId);
    } catch (err) {
      this.stats.failed += body.comments.length;
      this.sendJson(
        res,
        502,
        {
          ok: false,
          accepted: 0,
          skippedDuplicate: 0,
          skippedFiltered: 0,
          failed: body.comments.length,
          errors: [err.message],
        },
        origin
      );
      return;
    }

    let accepted = 0;
    let skippedDuplicate = 0;
    let skippedFiltered = 0;
    let failed = 0;
    const errors = [];

    for (const rawItem of body.comments) {
      this.stats.received += 1;
      const normalized = normalizeComment(rawItem, platform, config);

      if (normalized.error) {
        failed += 1;
        this.stats.failed += 1;
        errors.push(normalized.error);
        continue;
      }

      if (normalized.filtered) {
        skippedFiltered += 1;
        this.stats.skippedFiltered += 1;
        continue;
      }

      if (this.dedupCache.has(normalized.dedupKey)) {
        skippedDuplicate += 1;
        this.stats.skippedDuplicate += 1;
        continue;
      }

      try {
        await this.onecommeClient.enqueueComment(serviceId, normalized.comment);
        this.dedupCache.add(normalized.dedupKey);
        accepted += 1;
        this.stats.accepted += 1;
        if (config.debug) {
          this.logger.info(
            `[X-IG-Bridge] [${platform}] ${normalized.comment.name}: ${normalized.comment.comment}`
          );
        }
      } catch (err) {
        failed += 1;
        this.stats.failed += 1;
        errors.push(err.message);
      }
    }

    this.sendJson(
      res,
      200,
      {
        ok: failed === 0,
        serviceId,
        accepted,
        skippedDuplicate,
        skippedFiltered,
        failed,
        errors,
      },
      origin
    );
  }

  start() {
    if (this.server) {
      return Promise.resolve();
    }

    const config = this.getConfig();
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          this.logger.error('[X-IG-Bridge] 予期しないサーバーエラー:', err);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'Internal Server Error' }));
          }
        });
      });

      server.on('connection', (socket) => {
        this.sockets.add(socket);
        socket.on('close', () => this.sockets.delete(socket));
      });

      server.once('error', (err) => {
        this.logger.error(
          `[X-IG-Bridge] ローカルブリッジ起動失敗 (${config.host}:${config.port}):`,
          err.message
        );
        reject(err);
      });

      server.listen(config.port, config.host, () => {
        this.server = server;
        this.stats.startedAt = new Date().toISOString();
        this.logger.info(
          `[X-IG-Bridge] ローカルブリッジを起動しました: http://${config.host}:${config.port}`
        );
        resolve();
      });
    });
  }

  stop() {
    if (!this.server) {
      return Promise.resolve();
    }
    const server = this.server;
    this.server = null;

    return new Promise((resolve) => {
      for (const socket of this.sockets) {
        socket.destroy();
      }
      this.sockets.clear();
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      server.close(() => {
        this.logger.info('[X-IG-Bridge] ローカルブリッジを停止しました。');
        resolve();
      });
    });
  }

  async restart() {
    await this.stop();
    await this.start();
  }
}

module.exports = {
  BridgeServer,
  isAllowedOrigin,
};
