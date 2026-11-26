'use strict';

const { mergeConfig, validateAndApplyPatch, redactConfig } = require('./lib/config');
const { DedupCache } = require('./lib/normalizer');
const { OneCommeClient } = require('./lib/onecommeClient');
const { BridgeServer } = require('./lib/server');

const STORE_KEY = 'xInstagramBridgeConfig';

const plugin = {
  name: 'X & Instagram Live コメント連携プラグイン',
  uid: 'com.custom.onecomment-x-instagram',
  version: '1.0.0',
  author: 'ゲレの工房',
  url: 'https://www.gelehrte.com/',
  permissions: ['comments'],

  _store: null,
  _config: null,
  _dedupCache: null,
  _onecommeClient: null,
  _bridgeServer: null,

  _getConfig() {
    return this._config;
  },

  _saveConfig(nextConfig) {
    this._config = mergeConfig(nextConfig);
    if (this._store && typeof this._store.set === 'function') {
      try {
        this._store.set(STORE_KEY, this._config);
      } catch (err) {
        console.error('[X-IG-Bridge] 設定の保存に失敗しました:', err.message);
      }
    }
  },

  init({ store } = {}) {
    this._store = store || null;
    const saved =
      this._store && typeof this._store.get === 'function' ? this._store.get(STORE_KEY) : null;
    this._config = mergeConfig(saved);

    if (this._store && typeof this._store.set === 'function' && !saved) {
      this._store.set(STORE_KEY, this._config);
    }

    this._dedupCache = new DedupCache({
      ttlMs: this._config.dedupTtlMs,
      maxEntries: this._config.dedupMaxEntries,
    });

    this._onecommeClient = new OneCommeClient({
      getConfig: () => this._getConfig(),
      saveConfig: (cfg) => this._saveConfig(cfg),
      logger: console,
    });

    this._bridgeServer = new BridgeServer({
      pluginInfo: {
        name: this.name,
        uid: this.uid,
        version: this.version,
      },
      getConfig: () => this._getConfig(),
      saveConfig: (cfg) => this._saveConfig(cfg),
      onecommeClient: this._onecommeClient,
      dedupCache: this._dedupCache,
      logger: console,
    });

    return this._bridgeServer.start().catch((err) => {
      console.error('[X-IG-Bridge] 初期化時のブリッジ起動に失敗しました:', err.message);
    });
  },

  async request(req) {
    if (!this._config) {
      return { code: 503, response: { ok: false, error: 'プラグインが初期化されていません。' } };
    }

    switch (req.method) {
      case 'GET': {
        const onecommeReachable = this._onecommeClient
          ? await this._onecommeClient.checkReachable()
          : false;
        return {
          code: 200,
          response: {
            ok: true,
            config: redactConfig(this._config),
            onecommeReachable,
            stats: this._bridgeServer ? { ...this._bridgeServer.stats } : null,
          },
        };
      }
      case 'POST':
      case 'PUT': {
        const result = validateAndApplyPatch(this._config, req.body);
        if (result.error) {
          return { code: 400, response: { ok: false, error: result.error } };
        }
        this._saveConfig(result.config);
        if (this._dedupCache) {
          this._dedupCache.updateLimits({
            ttlMs: result.config.dedupTtlMs,
            maxEntries: result.config.dedupMaxEntries,
          });
        }
        if (this._onecommeClient) {
          this._onecommeClient.invalidateServicesCache();
        }
        if (result.portChanged && this._bridgeServer) {
          await this._bridgeServer.restart();
        }
        return {
          code: 200,
          response: {
            ok: true,
            config: redactConfig(this._config),
          },
        };
      }
      default:
        return { code: 405, response: { ok: false, error: 'Method Not Allowed' } };
    }
  },

  async destroy() {
    if (this._bridgeServer) {
      await this._bridgeServer.stop();
      this._bridgeServer = null;
    }
    if (this._dedupCache) {
      this._dedupCache.clear();
      this._dedupCache = null;
    }
    this._onecommeClient = null;
  },
};

module.exports = plugin;
