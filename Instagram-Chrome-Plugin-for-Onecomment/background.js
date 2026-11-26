'use strict';

const DEFAULT_SETTINGS = {
  enabled: true,
  bridgeUrl: 'http://127.0.0.1:11185',
  token: '',
  serviceId: '',
  skipSystemMessages: true,
  skipInitialComments: true,
  batchIntervalMs: 300,
  customSelectors: {
    container: '',
    item: '',
    author: '',
    message: '',
  },
};

const DEFAULT_RUNTIME_STATE = {
  connected: false,
  onecommeReachable: false,
  lastError: '',
  sentCount: 0,
  skippedCount: 0,
  recentComments: [],
  mappedServiceName: 'Instagram Live コメント',
  mappedServiceId: '',
  lastCheckedAt: 0,
};

async function getSettings() {
  const result = await chrome.storage.local.get('settings');
  const stored = result && result.settings ? result.settings : {};
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    customSelectors: {
      ...DEFAULT_SETTINGS.customSelectors,
      ...(stored.customSelectors || {}),
    },
  };
}

async function getRuntimeState() {
  const result = await chrome.storage.local.get('runtimeState');
  return {
    ...DEFAULT_RUNTIME_STATE,
    ...(result && result.runtimeState ? result.runtimeState : {}),
  };
}

async function updateRuntimeState(patch) {
  const current = await getRuntimeState();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ runtimeState: next });
  await updateBadge(next);
  return next;
}

async function updateBadge(state) {
  const settings = await getSettings();
  if (!settings.enabled) {
    await chrome.action.setBadgeText({ text: 'OFF' });
    await chrome.action.setBadgeBackgroundColor({ color: '#6b7280' });
    return;
  }
  if (state.lastError || !state.connected) {
    await chrome.action.setBadgeText({ text: 'ERR' });
    await chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
    return;
  }
  await chrome.action.setBadgeText({ text: 'ON' });
  await chrome.action.setBadgeBackgroundColor({ color: '#e1306c' });
}

function buildHeaders(settings) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (settings.token && settings.token.trim()) {
    headers['X-Bridge-Token'] = settings.token.trim();
  }
  return headers;
}

function normalizeBaseUrl(url) {
  return String(url || DEFAULT_SETTINGS.bridgeUrl).trim().replace(/\/+$/, '');
}

async function fetchBridge(pathname, { method = 'GET', body = null, settingsOverride = null } = {}) {
  const settings = settingsOverride || (await getSettings());
  const baseUrl = normalizeBaseUrl(settings.bridgeUrl);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: buildHeaders(settings),
      body: body !== null ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    return data;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function checkHealth(settingsOverride = null) {
  try {
    const data = await fetchBridge('/health', { settingsOverride });
    const igMapping = data.mapping && data.mapping.instagram ? data.mapping.instagram : {};
    const state = await updateRuntimeState({
      connected: true,
      onecommeReachable: Boolean(data.onecommeReachable),
      lastError: data.onecommeReachable ? '' : 'わんコメ本体(11180)へ接続できません',
      mappedServiceName: igMapping.serviceName || 'Instagram Live コメント',
      mappedServiceId: igMapping.serviceId || '',
      lastCheckedAt: Date.now(),
    });
    return { ok: true, health: data, state };
  } catch (err) {
    const state = await updateRuntimeState({
      connected: false,
      onecommeReachable: false,
      lastError: `わんコメプラグインに接続できません: ${err.message}`,
      lastCheckedAt: Date.now(),
    });
    return { ok: false, error: err.message, state };
  }
}

async function sendCommentsWithRetry(payload) {
  const settings = await getSettings();
  if (!settings.enabled) {
    return { ok: true, skipped: true };
  }

  const requestBody = {
    platform: 'instagram',
    sourceType: 'live',
    sourceUrl: payload.sourceUrl || '',
    serviceId: settings.serviceId || '',
    comments: payload.comments || [],
  };

  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const data = await fetchBridge('/comments', { method: 'POST', body: requestBody });
      const current = await getRuntimeState();
      const addedPreview = (payload.comments || []).map((c) => ({
        name: c.name,
        comment: c.comment,
        timestamp: c.timestamp || Date.now(),
      }));
      const recentComments = [...addedPreview.reverse(), ...(current.recentComments || [])].slice(0, 5);

      await updateRuntimeState({
        connected: true,
        onecommeReachable: true,
        lastError: data.ok ? '' : (data.errors && data.errors[0]) || '一部コメントの送信に失敗しました',
        sentCount: (current.sentCount || 0) + (data.accepted || 0),
        skippedCount:
          (current.skippedCount || 0) + (data.skippedDuplicate || 0) + (data.skippedFiltered || 0),
        recentComments,
        lastCheckedAt: Date.now(),
      });
      return { ok: true, data };
    } catch (err) {
      lastErr = err;
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
    }
  }

  await updateRuntimeState({
    connected: false,
    lastError: `送信失敗: ${lastErr ? lastErr.message : '不明なエラー'}`,
    lastCheckedAt: Date.now(),
  });
  return { ok: false, error: lastErr ? lastErr.message : '不明なエラー' };
}

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  await chrome.storage.local.set({ settings });
  await checkHealth();
});

chrome.runtime.onStartup.addListener(async () => {
  await checkHealth();
});

chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName === 'local' && changes.settings) {
    const state = await getRuntimeState();
    await updateBadge(state);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (!message || !message.type) {
      sendResponse({ ok: false, error: 'Invalid message' });
      return;
    }

    switch (message.type) {
      case 'SEND_COMMENTS': {
        const res = await sendCommentsWithRetry(message.payload || {});
        sendResponse(res);
        break;
      }
      case 'CHECK_HEALTH': {
        const res = await checkHealth(message.settingsOverride || null);
        sendResponse(res);
        break;
      }
      case 'FETCH_SERVICES': {
        try {
          const data = await fetchBridge('/services', {
            settingsOverride: message.settingsOverride || null,
          });
          sendResponse({ ok: true, services: data.services || [] });
        } catch (err) {
          sendResponse({ ok: false, error: err.message, services: [] });
        }
        break;
      }
      case 'SEND_TEST_COMMENT': {
        const testComment = {
          id: `ig_live_test_${Date.now()}`,
          userId: 'ig_test_user',
          name: 'Instagramテストユーザー',
          screenName: '@ig_test_user',
          comment: 'Instagram Live 連携テストコメントです！',
          profileImage: '',
          timestamp: Date.now(),
          isOwner: false,
          isSystem: false,
          badges: [],
        };
        const settings = await getSettings();
        const requestBody = {
          platform: 'instagram',
          sourceType: 'live',
          sourceUrl: 'https://www.instagram.com/sample/live/',
          serviceId: settings.serviceId || '',
          comments: [testComment],
        };
        try {
          const data = await fetchBridge('/comments', { method: 'POST', body: requestBody });
          const current = await getRuntimeState();
          const recentComments = [
            { name: testComment.name, comment: testComment.comment, timestamp: testComment.timestamp },
            ...(current.recentComments || []),
          ].slice(0, 5);
          await updateRuntimeState({
            connected: true,
            onecommeReachable: true,
            lastError: '',
            sentCount: (current.sentCount || 0) + (data.accepted || 0),
            recentComments,
          });
          sendResponse({ ok: true, data });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
        break;
      }
      case 'GET_STATE': {
        const settings = await getSettings();
        const state = await getRuntimeState();
        sendResponse({ ok: true, settings, state });
        break;
      }
      case 'RESET_STATS': {
        const state = await updateRuntimeState({
          sentCount: 0,
          skippedCount: 0,
          recentComments: [],
        });
        sendResponse({ ok: true, state });
        break;
      }
      default:
        sendResponse({ ok: false, error: `Unknown type: ${message.type}` });
    }
  })();
  return true;
});
