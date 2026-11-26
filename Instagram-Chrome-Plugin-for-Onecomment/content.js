(() => {
  'use strict';

  if (globalThis.__IG_LIVE_ONECOMME_CONTENT_LOADED__) return;
  globalThis.__IG_LIVE_ONECOMME_CONTENT_LOADED__ = true;

  const Selectors = globalThis.InstagramLiveSelectors;
  if (!Selectors) return;

  const HOOK_SOURCE = 'ig-live-onecomme-hook';
  const CONTENT_SOURCE = 'ig-live-onecomme-content';

  const DEFAULT_SETTINGS = {
    enabled: true,
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

  let settings = { ...DEFAULT_SETTINGS, customSelectors: { ...DEFAULT_SETTINGS.customSelectors } };
  let activeContainer = null;
  let activeContainerSelector = '';
  let observer = null;
  let rescanTimer = null;
  let flushTimer = null;
  let lastUrl = location.href;

  // MAIN world (page_hook.js) のAPIフック状態
  let hookAlive = false;
  let pollFetchCount = 0;
  let postCommentCount = 0;
  let apiLastPollAt = 0;
  let apiCommentCount = 0;
  let wsSeenUrls = [];
  let seenNetUrls = [];

  // DOM監視の診断カウンタ
  let domMutationCount = 0;
  let domScanCount = 0;
  let domParsedCount = 0;
  let domEnqueuedCount = 0;
  let domScanTimer = null;
  const recentDomSamples = [];

  function pushDomSample(sample) {
    recentDomSamples.push(sample);
    if (recentDomSamples.length > 5) {
      recentDomSamples.shift();
    }
  }

  const seenOrder = [];
  const seenSet = new Set();
  const recentApiContentMap = new Map();
  const seenDomContentCounts = new Map();
  const elementParseCache = new WeakMap();
  const MAX_SEEN = 1000;
  const MAX_DOM_KEYS = 2000;
  const API_DEDUP_WINDOW_MS = 30000;
  const pendingComments = [];

  function makeContentKey(parsed) {
    return `${String((parsed && parsed.userId) || '').toLowerCase()}|${(parsed && parsed.comment) || ''}`;
  }

  function recordDomContentCount(contentKey, nextCount) {
    const prev = seenDomContentCounts.get(contentKey) || 0;
    const updated = Math.max(prev, nextCount);
    seenDomContentCounts.delete(contentKey);
    seenDomContentCounts.set(contentKey, updated);
    while (seenDomContentCounts.size > MAX_DOM_KEYS) {
      const oldestKey = seenDomContentCounts.keys().next().value;
      if (oldestKey === undefined) break;
      seenDomContentCounts.delete(oldestKey);
    }
  }

  function rememberComment(parsed, { fromDom = false } = {}) {
    if (!parsed || !parsed.id) return false;
    if (seenSet.has(parsed.id)) return false;

    const now = Date.now();
    const contentKey = makeContentKey(parsed);
    const prevApiTs = recentApiContentMap.get(contentKey);
    if (prevApiTs && now - prevApiTs < API_DEDUP_WINDOW_MS) {
      return false;
    }

    seenSet.add(parsed.id);
    seenOrder.push(parsed.id);
    while (seenOrder.length > MAX_SEEN) {
      const oldest = seenOrder.shift();
      seenSet.delete(oldest);
    }

    if (!fromDom) {
      recentApiContentMap.set(contentKey, now);
      if (recentApiContentMap.size > MAX_SEEN) {
        for (const [key, ts] of recentApiContentMap.entries()) {
          if (now - ts >= API_DEDUP_WINDOW_MS) {
            recentApiContentMap.delete(key);
          }
        }
      }
      // APIで既に受信したコメントが直後に DOM に描画されても二重送信しないように記録
      recordDomContentCount(contentKey, (seenDomContentCounts.get(contentKey) || 0) + 1);
    }
    return true;
  }

  let disposed = false;

  function isExtensionContextValid() {
    try {
      return !disposed && typeof chrome !== 'undefined' && Boolean(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  function cleanup() {
    if (disposed) return;
    disposed = true;
    if (rescanTimer) {
      clearInterval(rescanTimer);
      rescanTimer = null;
    }
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (domScanTimer) {
      clearTimeout(domScanTimer);
      domScanTimer = null;
    }
    pendingComments.length = 0;
    detachObserver();
    window.removeEventListener('message', onWindowMessage);
  }

  function flushPending() {
    flushTimer = null;
    if (!isExtensionContextValid()) {
      cleanup();
      return;
    }
    if (!settings.enabled || pendingComments.length === 0) {
      pendingComments.length = 0;
      return;
    }

    const batch = pendingComments.splice(0, 20);
    try {
      const maybePromise = chrome.runtime.sendMessage({
        type: 'SEND_COMMENTS',
        payload: {
          platform: 'instagram',
          sourceType: 'live',
          sourceUrl: location.href,
          comments: batch,
        },
      });
      if (maybePromise && typeof maybePromise.catch === 'function') {
        maybePromise.catch(() => {
          // 拡張機能リロード直後などは無視
        });
      }
    } catch {
      cleanup();
      return;
    }

    if (pendingComments.length > 0) {
      scheduleFlush();
    }
  }

  function scheduleFlush() {
    if (flushTimer !== null) return;
    const delay = Math.max(100, Math.min(2000, Number(settings.batchIntervalMs) || 300));
    flushTimer = setTimeout(flushPending, delay);
  }

  function enqueueParsedComment(parsed, { initialSeed = false, fromDom = false } = {}) {
    if (!parsed) return false;
    if (parsed.isSystem && settings.skipSystemMessages) {
      return false;
    }
    const isNew = rememberComment(parsed, { fromDom });
    if (!isNew) return false;
    if (initialSeed && settings.skipInitialComments) return false;
    if (!settings.enabled) return false;

    pendingComments.push(parsed);
    scheduleFlush();
    return true;
  }

  function isApiPrimaryActive() {
    return pollFetchCount > 0 && apiLastPollAt > 0 && Date.now() - apiLastPollAt < 60000;
  }

  function isApiDeliveringComments() {
    return apiCommentCount > 0 && isApiPrimaryActive();
  }

  function collectFlatMessageElements(container) {
    const customItem = settings.customSelectors && settings.customSelectors.item;
    const initial = Selectors.findMessageElements(container, customItem);
    const out = [];
    for (const el of initial) {
      if (!el || el.nodeType !== 1) continue;
      if (typeof Selectors.countAvatarImages === 'function' && Selectors.countAvatarImages(el) >= 2) {
        const nested = Selectors.findMessageElements(el, customItem);
        for (const child of nested) {
          if (child && child.nodeType === 1 && child !== el) {
            out.push(child);
          }
        }
      } else {
        out.push(el);
      }
    }
    return out;
  }

  function parseElementCached(el) {
    if (!el || el.nodeType !== 1) return null;
    const textSnapshot = el.textContent || '';
    const cached = elementParseCache.get(el);
    if (cached && cached.textSnapshot === textSnapshot) {
      return cached.parsed;
    }
    const parsed = Selectors.parseLiveCommentElement(el, {
      customSelectors: settings.customSelectors,
    });
    elementParseCache.set(el, {
      textSnapshot,
      parsed,
    });
    return parsed;
  }

  function scanActiveContainer({ initialSeed = false } = {}) {
    if (!activeContainer || !document.contains(activeContainer)) return;

    // APIポーリングで実際にコメントを取得できている場合のみ、ヒューリスティックDOM側の誤爆を抑制
    const hasCustomContainer = Boolean(settings.customSelectors && settings.customSelectors.container);
    if (!initialSeed && isApiDeliveringComments() && !hasCustomContainer && activeContainerSelector.startsWith('heuristic:')) {
      return;
    }

    if (!initialSeed) domScanCount += 1;

    const rows = collectFlatMessageElements(activeContainer);
    const grouped = new Map();

    for (const row of rows) {
      const parsed = parseElementCached(row);
      if (!parsed) continue;
      if (parsed.isSystem && settings.skipSystemMessages) continue;
      const contentKey = makeContentKey(parsed);
      let list = grouped.get(contentKey);
      if (!list) {
        list = [];
        grouped.set(contentKey, list);
      }
      list.push(parsed);
    }

    for (const [contentKey, list] of grouped.entries()) {
      const curCount = list.length;
      const prevCount = seenDomContentCounts.get(contentKey) || 0;
      if (curCount <= prevCount) {
        continue;
      }

      recordDomContentCount(contentKey, curCount);

      if (initialSeed && settings.skipInitialComments) {
        continue;
      }

      const addedCount = curCount - prevCount;
      const newItems = list.slice(curCount - addedCount);
      for (let i = 0; i < newItems.length; i += 1) {
        const occ = prevCount + i + 1;
        const base = newItems[i];
        const stableId =
          typeof Selectors.fnv1aHash === 'function'
            ? `ig_live_dom_${Selectors.fnv1aHash(`${contentKey}|${occ}`)}`
            : `${base.id}_occ${occ}`;
        const item = {
          ...base,
          id: stableId,
          timestamp: Date.now(),
        };
        if (!initialSeed) domParsedCount += 1;
        const enqueued = enqueueParsedComment(item, { initialSeed, fromDom: true });
        if (!initialSeed && enqueued) {
          domEnqueuedCount += 1;
          pushDomSample({
            name: item.name,
            comment: item.comment.slice(0, 60),
            occ,
            result: 'enqueued',
          });
        }
      }
    }
  }

  function scheduleDomScan() {
    if (domScanTimer !== null) return;
    domScanTimer = setTimeout(() => {
      domScanTimer = null;
      if (!isExtensionContextValid()) {
        cleanup();
        return;
      }
      if (!settings.enabled) return;
      scanActiveContainer({ initialSeed: false });
    }, 80);
  }

  function detachObserver() {
    if (domScanTimer) {
      clearTimeout(domScanTimer);
      domScanTimer = null;
    }
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    activeContainer = null;
    activeContainerSelector = '';
  }

  function attachToContainer(container, selector) {
    detachObserver();
    activeContainer = container;
    activeContainerSelector = selector;

    scanActiveContainer({ initialSeed: true });

    observer = new MutationObserver(() => {
      domMutationCount += 1;
      if (!settings.enabled) return;
      scheduleDomScan();
    });

    observer.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  function pingPageHook() {
    try {
      window.postMessage({ source: CONTENT_SOURCE, type: 'PING' }, '*');
    } catch {
      // ignore
    }
  }

  function checkAndAttach() {
    if (!isExtensionContextValid()) {
      cleanup();
      return;
    }

    if (location.href !== lastUrl) {
      lastUrl = location.href;
      detachObserver();
      pollFetchCount = 0;
      postCommentCount = 0;
      apiLastPollAt = 0;
      apiCommentCount = 0;
      domMutationCount = 0;
      domScanCount = 0;
      domParsedCount = 0;
      domEnqueuedCount = 0;
      recentDomSamples.length = 0;
      seenSet.clear();
      seenOrder.length = 0;
      recentApiContentMap.clear();
      seenDomContentCounts.clear();
      try {
        window.postMessage({ source: CONTENT_SOURCE, type: 'RESET_NAV' }, '*');
      } catch {
        // ignore
      }
    }

    if (!Selectors.isInstagramLivePage(location.href)) {
      if (activeContainer) detachObserver();
      return;
    }

    pingPageHook();

    if (activeContainer && document.contains(activeContainer)) {
      return;
    }

    const customContainer = settings.customSelectors && settings.customSelectors.container;
    const found = Selectors.findChatContainer(document, customContainer);
    if (found.element) {
      attachToContainer(found.element, found.selector);
    }
  }

  function applySettings(stored) {
    if (!stored || typeof stored !== 'object') return;
    const prevContainerCustom = settings.customSelectors.container;
    settings = {
      ...DEFAULT_SETTINGS,
      ...stored,
      customSelectors: {
        ...DEFAULT_SETTINGS.customSelectors,
        ...(stored.customSelectors || {}),
      },
    };
    if (prevContainerCustom !== settings.customSelectors.container) {
      detachObserver();
      checkAndAttach();
    }
  }

  // MAIN world (page_hook.js) からの API 通信イベントを受信
  function onWindowMessage(event) {
    if (!isExtensionContextValid()) {
      cleanup();
      return;
    }
    if (event.source !== window || !event.data) return;
    if (event.data.source !== HOOK_SOURCE) return;

    const { type, payload } = event.data;
    if (type === 'HOOK_STATUS') {
      hookAlive = true;
      if (payload && typeof payload.pollFetchCount === 'number') {
        pollFetchCount = payload.pollFetchCount;
      }
      if (payload && typeof payload.postCommentCount === 'number') {
        postCommentCount = payload.postCommentCount;
      }
      if (payload && Array.isArray(payload.seenUrls)) {
        wsSeenUrls = payload.seenUrls;
      }
      if (payload && Array.isArray(payload.seenNetUrls)) {
        seenNetUrls = payload.seenNetUrls;
      }
      return;
    }

    if (type === 'LIVE_COMMENTS' && payload && payload.data) {
      hookAlive = true;
      if (payload.kind === 'poll') {
        pollFetchCount = Number(payload.fetchIndex) || pollFetchCount + 1;
        apiLastPollAt = Date.now();
      } else if (payload.kind === 'post') {
        postCommentCount = Number(payload.fetchIndex) || postCommentCount + 1;
      }

      if (!Selectors.isInstagramLivePage(location.href)) return;
      const items = Selectors.parseLiveCommentsApiResponse(payload.data);
      const isInitialPoll = payload.kind === 'poll' && pollFetchCount <= 1;
      for (const item of items) {
        apiCommentCount += 1;
        enqueueParsedComment(item, { initialSeed: isInitialPoll });
      }
    }
  }

  window.addEventListener('message', onWindowMessage);

  if (isExtensionContextValid()) {
    try {
      chrome.storage.local.get('settings', (result) => {
        if (!isExtensionContextValid()) {
          cleanup();
          return;
        }
        if (result && result.settings) {
          applySettings(result.settings);
        }
        checkAndAttach();
      });

      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (!isExtensionContextValid()) {
          cleanup();
          return;
        }
        if (areaName === 'local' && changes.settings && changes.settings.newValue) {
          applySettings(changes.settings.newValue);
        }
      });

      chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (message && message.type === 'GET_TAB_STATUS') {
          try {
            pingPageHook();
            const domFound = Boolean(activeContainer && document.contains(activeContainer));
            const apiActive = isApiPrimaryActive();
            sendResponse({
              url: location.href,
              isLivePage: Selectors.isInstagramLivePage(location.href),
              containerFound: domFound || apiActive || pollFetchCount > 0,
              domFound,
              apiActive,
              hookAlive,
              pollFetchCount,
              postCommentCount,
              apiCommentCount,
              wsSeenUrls,
              seenNetUrls,
              containerSelector: activeContainerSelector,
              enabled: settings.enabled,
            });
          } catch (err) {
            sendResponse({
              url: location.href,
              error: (err && (err.stack || err.message)) || String(err),
            });
          }
          return true;
        }
        if (message && message.type === 'GET_DIAGNOSTICS') {
          try {
            pingPageHook();
            const domFound = Boolean(activeContainer && document.contains(activeContainer));
            let domDiag = {};
            try {
              domDiag =
                typeof Selectors.collectDomDiagnostics === 'function'
                  ? Selectors.collectDomDiagnostics(document)
                  : { note: 'collectDomDiagnostics unavailable' };
            } catch (diagErr) {
              domDiag = {
                error: (diagErr && (diagErr.stack || diagErr.message)) || String(diagErr),
              };
            }
            sendResponse({
              url: location.href,
              isLivePage: Selectors.isInstagramLivePage(location.href),
              enabled: settings.enabled,
              skipInitialComments: settings.skipInitialComments,
              hookAlive,
              apiActive: isApiPrimaryActive(),
              pollFetchCount,
              postCommentCount,
              apiCommentCount,
              wsSeenUrls,
              seenNetUrls,
              domFound,
              containerSelector: activeContainerSelector,
              domStats: {
                mutationCount: domMutationCount,
                scanCount: domScanCount,
                trackedDomKeys: seenDomContentCounts.size,
                parsedCount: domParsedCount,
                enqueuedCount: domEnqueuedCount,
                recentSamples: [...recentDomSamples],
              },
              domDiag,
            });
          } catch (err) {
            sendResponse({
              url: location.href,
              error: (err && (err.stack || err.message)) || String(err),
            });
          }
          return true;
        }
        return false;
      });
    } catch {
      cleanup();
    }
  }

  rescanTimer = setInterval(checkAndAttach, 2000);
  window.addEventListener('beforeunload', cleanup);
})();
