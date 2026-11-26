'use strict';

const crypto = require('crypto');
const http = require('http');
const https = require('https');

const DEFAULT_PLATFORM_COLORS = {
  x: { r: 29, g: 155, b: 240 },
  instagram: { r: 225, g: 48, b: 108 },
};

class OneCommeClient {
  constructor({ getConfig, saveConfig, logger }) {
    this.getConfig = getConfig;
    this.saveConfig = saveConfig;
    this.logger = logger || console;
    this.servicesCache = {
      fetchedAt: 0,
      items: [],
    };
    this.queue = Promise.resolve();
  }

  invalidateServicesCache() {
    this.servicesCache.fetchedAt = 0;
  }

  requestJson(method, pathname, body = null, timeoutMs = 4000) {
    const config = this.getConfig();
    const baseUrl = config.onecommeUrl || 'http://localhost:11180';

    return new Promise((resolve, reject) => {
      let targetUrl;
      try {
        targetUrl = new URL(pathname, `${baseUrl}/`);
      } catch (err) {
        reject(new Error(`わんコメURLが不正です: ${baseUrl}${pathname}`));
        return;
      }

      const client = targetUrl.protocol === 'https:' ? https : http;
      const payload = body !== null ? JSON.stringify(body) : null;

      const headers = {
        Accept: 'application/json',
      };
      if (payload !== null) {
        headers['Content-Type'] = 'application/json; charset=utf-8';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }

      const req = client.request(
        targetUrl,
        {
          method,
          headers,
          timeout: timeoutMs,
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const rawText = Buffer.concat(chunks).toString('utf8');
            let parsed = null;
            if (rawText) {
              try {
                parsed = JSON.parse(rawText);
              } catch {
                parsed = rawText;
              }
            }

            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ statusCode: res.statusCode, data: parsed });
            } else {
              const err = new Error(
                `わんコメAPIエラー (${res.statusCode} ${method} ${pathname}): ${
                  typeof parsed === 'string' ? parsed : JSON.stringify(parsed)
                }`
              );
              err.statusCode = res.statusCode;
              err.data = parsed;
              reject(err);
            }
          });
        }
      );

      req.on('timeout', () => {
        req.destroy(new Error(`わんコメAPIがタイムアウトしました (${method} ${pathname})`));
      });

      req.on('error', (err) => {
        reject(err);
      });

      if (payload !== null) {
        req.write(payload);
      }
      req.end();
    });
  }

  extractServicesArray(data) {
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.services)) return data.services;
    if (data && Array.isArray(data.data)) return data.data;
    return [];
  }

  async getServices({ forceRefresh = false } = {}) {
    const now = Date.now();
    if (!forceRefresh && now - this.servicesCache.fetchedAt < 10000 && this.servicesCache.items.length > 0) {
      return this.servicesCache.items;
    }

    const res = await this.requestJson('GET', '/api/services');
    const items = this.extractServicesArray(res.data)
      .filter((item) => item && typeof item.id === 'string')
      .map((item) => ({
        id: item.id,
        name: typeof item.name === 'string' ? item.name : item.id,
        enabled: item.enabled !== false,
      }));

    this.servicesCache = {
      fetchedAt: now,
      items,
    };
    return items;
  }

  async checkReachable() {
    try {
      await this.getServices({ forceRefresh: true });
      return true;
    } catch {
      return false;
    }
  }

  async createService(name, platform = '') {
    const newId = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
    const color = DEFAULT_PLATFORM_COLORS[platform] || { r: 120, g: 120, b: 255 };

    const res = await this.requestJson('POST', '/api/services', {
      id: newId,
      name,
      url: '',
      write: true,
      speech: true,
      enabled: false,
      color,
    });
    this.invalidateServicesCache();

    const created = res.data;
    if (created && typeof created.id === 'string' && created.id) {
      return { id: created.id, name: created.name || name };
    }
    if (created && created.service && typeof created.service.id === 'string' && created.service.id) {
      return { id: created.service.id, name: created.service.name || name };
    }

    const services = await this.getServices({ forceRefresh: true });
    const matched = services.find((svc) => svc.id === newId || svc.name === name);
    if (matched) {
      return matched;
    }

    throw new Error(`わんコメ枠「${name}」を作成しましたがIDを取得できませんでした。`);
  }

  async resolveServiceId(platform, requestedServiceId = '') {
    const requested = typeof requestedServiceId === 'string' ? requestedServiceId.trim() : '';
    if (requested) {
      return requested;
    }

    const config = this.getConfig();
    const platformCfg = config.services && config.services[platform];
    if (!platformCfg) {
      throw new Error(`未対応プラットフォームの枠設定です: ${platform}`);
    }

    const services = await this.getServices();

    if (platformCfg.id) {
      const exists = services.some((svc) => svc.id === platformCfg.id);
      if (exists) {
        return platformCfg.id;
      }
      const refreshed = await this.getServices({ forceRefresh: true });
      if (refreshed.some((svc) => svc.id === platformCfg.id)) {
        return platformCfg.id;
      }
    }

    const byName = services.find((svc) => svc.name === platformCfg.name);
    if (byName) {
      const nextConfig = {
        ...config,
        services: {
          ...config.services,
          [platform]: {
            ...platformCfg,
            id: byName.id,
          },
        },
      };
      this.saveConfig(nextConfig);
      return byName.id;
    }

    if (config.autoCreateService) {
      this.logger.info(`[X-IG-Bridge] わんコメ枠「${platformCfg.name}」を自動作成します。`);
      const created = await this.createService(platformCfg.name, platform);
      const nextConfig = {
        ...config,
        services: {
          ...config.services,
          [platform]: {
            ...platformCfg,
            id: created.id,
          },
        },
      };
      this.saveConfig(nextConfig);
      return created.id;
    }

    throw new Error(
      `わんコメ上に「${platformCfg.name}」の枠が見つかりません。枠を作成するか設定でサービスIDを指定してください。`
    );
  }

  enqueueComment(serviceId, commentObj) {
    const task = this.queue.then(() =>
      this.requestJson('POST', '/api/comments', {
        service: { id: serviceId },
        comment: commentObj,
      })
    );
    // キューが失敗で止まらないようにエラーを握りつぶした参照を保持
    this.queue = task.catch(() => {});
    return task;
  }
}

module.exports = {
  OneCommeClient,
};
