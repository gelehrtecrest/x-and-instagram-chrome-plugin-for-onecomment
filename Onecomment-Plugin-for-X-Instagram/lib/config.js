'use strict';

const DEFAULT_CONFIG = Object.freeze({
  host: '127.0.0.1',
  port: 11185,
  onecommeUrl: 'http://localhost:11180',
  token: '',
  autoCreateService: true,
  services: {
    x: {
      id: '',
      name: 'X Live コメント',
    },
    instagram: {
      id: '',
      name: 'Instagram Live コメント',
    },
  },
  skipSystemMessages: true,
  maxCommentLength: 500,
  dedupTtlMs: 600000,
  dedupMaxEntries: 2000,
  debug: false,
});

function cloneDefaultConfig() {
  return {
    ...DEFAULT_CONFIG,
    services: {
      x: { ...DEFAULT_CONFIG.services.x },
      instagram: { ...DEFAULT_CONFIG.services.instagram },
    },
  };
}

function isValidPort(port) {
  return Number.isInteger(port) && port >= 1024 && port <= 65535;
}

function isValidLocalUrl(urlString) {
  if (typeof urlString !== 'string' || !urlString.trim()) return false;
  try {
    const parsed = new URL(urlString);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function mergeConfig(stored) {
  const base = cloneDefaultConfig();
  if (!stored || typeof stored !== 'object') {
    return base;
  }

  if (typeof stored.port === 'number' && isValidPort(stored.port)) {
    base.port = stored.port;
  }
  if (typeof stored.onecommeUrl === 'string' && isValidLocalUrl(stored.onecommeUrl)) {
    base.onecommeUrl = stored.onecommeUrl.replace(/\/+$/, '');
  }
  if (typeof stored.token === 'string') {
    base.token = stored.token.trim();
  }
  if (typeof stored.autoCreateService === 'boolean') {
    base.autoCreateService = stored.autoCreateService;
  }
  if (typeof stored.skipSystemMessages === 'boolean') {
    base.skipSystemMessages = stored.skipSystemMessages;
  }
  if (
    typeof stored.maxCommentLength === 'number' &&
    Number.isInteger(stored.maxCommentLength) &&
    stored.maxCommentLength >= 20 &&
    stored.maxCommentLength <= 2000
  ) {
    base.maxCommentLength = stored.maxCommentLength;
  }
  if (
    typeof stored.dedupTtlMs === 'number' &&
    Number.isInteger(stored.dedupTtlMs) &&
    stored.dedupTtlMs >= 5000 &&
    stored.dedupTtlMs <= 3600000
  ) {
    base.dedupTtlMs = stored.dedupTtlMs;
  }
  if (
    typeof stored.dedupMaxEntries === 'number' &&
    Number.isInteger(stored.dedupMaxEntries) &&
    stored.dedupMaxEntries >= 100 &&
    stored.dedupMaxEntries <= 20000
  ) {
    base.dedupMaxEntries = stored.dedupMaxEntries;
  }
  if (typeof stored.debug === 'boolean') {
    base.debug = stored.debug;
  }

  if (stored.services && typeof stored.services === 'object') {
    for (const platform of ['x', 'instagram']) {
      const incoming = stored.services[platform];
      if (incoming && typeof incoming === 'object') {
        if (typeof incoming.id === 'string') {
          base.services[platform].id = incoming.id.trim();
        }
        if (typeof incoming.name === 'string' && incoming.name.trim()) {
          base.services[platform].name = incoming.name.trim();
        }
      }
    }
  }

  return base;
}

function validateAndApplyPatch(currentConfig, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { error: '設定データ(JSONオブジェクト)が不正です。' };
  }

  const next = mergeConfig(currentConfig);
  let portChanged = false;

  if (patch.port !== undefined) {
    const portNum = Number(patch.port);
    if (!isValidPort(portNum)) {
      return { error: 'port は 1024〜65535 の整数を指定してください。' };
    }
    if (portNum !== next.port) {
      portChanged = true;
    }
    next.port = portNum;
  }

  if (patch.onecommeUrl !== undefined) {
    if (!isValidLocalUrl(patch.onecommeUrl)) {
      return { error: 'onecommeUrl のURL形式が不正です。' };
    }
    next.onecommeUrl = patch.onecommeUrl.trim().replace(/\/+$/, '');
  }

  if (patch.token !== undefined) {
    if (typeof patch.token !== 'string') {
      return { error: 'token は文字列で指定してください。' };
    }
    next.token = patch.token.trim();
  }

  if (patch.autoCreateService !== undefined) {
    next.autoCreateService = Boolean(patch.autoCreateService);
  }

  if (patch.skipSystemMessages !== undefined) {
    next.skipSystemMessages = Boolean(patch.skipSystemMessages);
  }

  if (patch.maxCommentLength !== undefined) {
    const len = Number(patch.maxCommentLength);
    if (!Number.isInteger(len) || len < 20 || len > 2000) {
      return { error: 'maxCommentLength は 20〜2000 の整数を指定してください。' };
    }
    next.maxCommentLength = len;
  }

  if (patch.debug !== undefined) {
    next.debug = Boolean(patch.debug);
  }

  if (patch.services && typeof patch.services === 'object') {
    for (const platform of ['x', 'instagram']) {
      const incoming = patch.services[platform];
      if (incoming && typeof incoming === 'object') {
        if (incoming.id !== undefined) {
          if (typeof incoming.id !== 'string') {
            return { error: `services.${platform}.id は文字列で指定してください。` };
          }
          next.services[platform].id = incoming.id.trim();
        }
        if (incoming.name !== undefined) {
          if (typeof incoming.name !== 'string' || !incoming.name.trim()) {
            return { error: `services.${platform}.name は空でない文字列で指定してください。` };
          }
          next.services[platform].name = incoming.name.trim();
        }
      }
    }
  }

  return { config: next, portChanged };
}

function redactConfig(config) {
  return {
    ...config,
    tokenSet: Boolean(config.token),
    token: config.token ? '********' : '',
  };
}

module.exports = {
  DEFAULT_CONFIG,
  cloneDefaultConfig,
  mergeConfig,
  validateAndApplyPatch,
  redactConfig,
};
