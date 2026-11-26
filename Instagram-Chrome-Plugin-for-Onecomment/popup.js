'use strict';

const enabledToggle = document.getElementById('enabledToggle');
const bridgeStatus = document.getElementById('bridgeStatus');
const tabStatus = document.getElementById('tabStatus');
const serviceName = document.getElementById('serviceName');
const errorBox = document.getElementById('errorBox');
const sentCount = document.getElementById('sentCount');
const skippedCount = document.getElementById('skippedCount');
const recentList = document.getElementById('recentList');
const testSendBtn = document.getElementById('testSendBtn');
const refreshBtn = document.getElementById('refreshBtn');
const openOptionsBtn = document.getElementById('openOptionsBtn');
const resetStatsBtn = document.getElementById('resetStatsBtn');
const copyDiagBtn = document.getElementById('copyDiagBtn');

function setBadge(el, text, cls) {
  el.textContent = text;
  el.className = `badge ${cls}`;
}

function renderState(settings, state) {
  enabledToggle.checked = Boolean(settings.enabled);

  if (state.connected && state.onecommeReachable) {
    setBadge(bridgeStatus, '接続OK', 'badge-ok');
  } else if (state.connected) {
    setBadge(bridgeStatus, 'わんコメ未応答', 'badge-warn');
  } else {
    setBadge(bridgeStatus, '未接続', 'badge-err');
  }

  serviceName.textContent = settings.serviceId
    ? `枠ID指定 (${settings.serviceId.slice(0, 8)}...)`
    : state.mappedServiceName || 'Instagram Live コメント';

  if (state.lastError) {
    errorBox.textContent = state.lastError;
    errorBox.classList.remove('hidden');
  } else {
    errorBox.classList.add('hidden');
  }

  sentCount.textContent = String(state.sentCount || 0);
  skippedCount.textContent = String(state.skippedCount || 0);

  recentList.textContent = '';
  const items = state.recentComments || [];
  if (items.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'まだ送信されたコメントはありません';
    recentList.appendChild(li);
    return;
  }

  for (const item of items) {
    const li = document.createElement('li');
    const author = document.createElement('span');
    author.className = 'comment-author';
    author.textContent = `${item.name}:`;
    const body = document.createElement('span');
    body.textContent = item.comment;
    li.appendChild(author);
    li.appendChild(body);
    recentList.appendChild(li);
  }
}

function isInstagramOriginUrl(urlString) {
  if (typeof urlString !== 'string' || !urlString) return false;
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const host = parsed.hostname.toLowerCase();
    return host === 'www.instagram.com' || host === 'instagram.com';
  } catch {
    return false;
  }
}

function showTabHint(message) {
  if (!message) return;
  if (errorBox.classList.contains('hidden') || !errorBox.textContent.trim()) {
    errorBox.textContent = message;
    errorBox.classList.remove('hidden');
  }
}

async function queryTabStatusWithAutoInject(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'GET_TAB_STATUS' });
  } catch (firstErr) {
    if (!chrome.scripting || typeof chrome.scripting.executeScript !== 'function') {
      throw firstErr;
    }
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['selectors.js', 'content.js'],
    });
    await new Promise((r) => setTimeout(r, 150));
    return await chrome.tabs.sendMessage(tabId, { type: 'GET_TAB_STATUS' });
  }
}

async function checkActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      setBadge(tabStatus, '対象外', 'badge-muted');
      return;
    }

    if (tab.url && !isInstagramOriginUrl(tab.url)) {
      setBadge(tabStatus, 'Instagramページ以外', 'badge-muted');
      return;
    }

    const res = await queryTabStatusWithAutoInject(tab.id);
    if (res && (res.apiActive || res.pollFetchCount > 0)) {
      setBadge(tabStatus, 'ライブ監視中 (API)', 'badge-ok');
    } else if (res && res.domFound) {
      setBadge(tabStatus, 'ライブ監視中 (DOM)', 'badge-ok');
    } else if (res && res.isLivePage && !res.hookAlive) {
      setBadge(tabStatus, '要ページ再読込', 'badge-warn');
      showTabHint('Instagram Liveのタブを F5 で再読み込みしてください（通信フックを有効化します）。');
    } else if (res && res.isLivePage) {
      setBadge(tabStatus, 'コメント欄待機中', 'badge-warn');
    } else {
      setBadge(tabStatus, 'Instagram Live以外', 'badge-muted');
    }
  } catch (err) {
    setBadge(tabStatus, 'タブ未接続', 'badge-err');
    showTabHint(
      `タブとの通信に失敗しました: ${(err && err.message) || '不明なエラー'}（InstagramタブをF5で再読み込みしてください）`
    );
  }
}

async function loadAll({ recheckHealth = false } = {}) {
  if (recheckHealth) {
    await chrome.runtime.sendMessage({ type: 'CHECK_HEALTH' });
  }
  const res = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  if (res && res.ok) {
    renderState(res.settings, res.state);
  }
  await checkActiveTab();
}

enabledToggle.addEventListener('change', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  const nextSettings = {
    ...(res && res.settings ? res.settings : {}),
    enabled: enabledToggle.checked,
  };
  await chrome.storage.local.set({ settings: nextSettings });
  await loadAll();
});

testSendBtn.addEventListener('click', async () => {
  testSendBtn.disabled = true;
  testSendBtn.textContent = '送信中...';
  const res = await chrome.runtime.sendMessage({ type: 'SEND_TEST_COMMENT' });
  testSendBtn.disabled = false;
  testSendBtn.textContent = res && res.ok ? '送信完了' : '送信失敗';
  setTimeout(() => {
    testSendBtn.textContent = 'テスト送信';
  }, 1500);
  await loadAll();
});

refreshBtn.addEventListener('click', async () => {
  setBadge(bridgeStatus, '確認中...', 'badge-muted');
  await loadAll({ recheckHealth: true });
});

openOptionsBtn.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

resetStatsBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'RESET_STATS' });
  await loadAll();
});

async function queryDiagnosticsWithFallback(tab) {
  let diag = null;
  let sendError = '';
  try {
    diag = await chrome.tabs.sendMessage(tab.id, { type: 'GET_DIAGNOSTICS' });
  } catch (err) {
    sendError = (err && err.message) || String(err);
  }

  // 応答が undefined / 失敗の場合、Instagramタブなら自動注入してリトライ
  if (!diag && isInstagramOriginUrl(tab.url || '') && chrome.scripting && typeof chrome.scripting.executeScript === 'function') {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['selectors.js', 'content.js'],
      });
      await new Promise((r) => setTimeout(r, 150));
      diag = await chrome.tabs.sendMessage(tab.id, { type: 'GET_DIAGNOSTICS' });
      sendError = '';
    } catch (retryErr) {
      sendError = (retryErr && retryErr.message) || String(retryErr);
    }
  }

  // それでも取れない場合はページ状態を直接プローブしてフォールバック情報を返す
  if (!diag) {
    let pageProbe = null;
    if (isInstagramOriginUrl(tab.url || '') && chrome.scripting && typeof chrome.scripting.executeScript === 'function') {
      try {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => ({
            href: location.href,
            hasSelectors: Boolean(globalThis.InstagramLiveSelectors),
            hasCollectDiag: Boolean(
              globalThis.InstagramLiveSelectors &&
                typeof globalThis.InstagramLiveSelectors.collectDomDiagnostics === 'function'
            ),
            contentLoaded: Boolean(globalThis.__IG_LIVE_ONECOMME_CONTENT_LOADED__),
            videoCount: document.querySelectorAll('video').length,
            inputCount: document.querySelectorAll('textarea, input, [contenteditable="true"]').length,
          }),
        });
        pageProbe = result || null;
      } catch (probeErr) {
        pageProbe = { probeError: (probeErr && probeErr.message) || String(probeErr) };
      }
    }
    diag = {
      fallback: true,
      tabUrl: tab.url || '',
      tabStatusText: tabStatus.textContent || '',
      sendError: sendError || 'GET_DIAGNOSTICS returned empty response (reload Instagram tab with F5)',
      pageProbe,
    };
  }

  return diag;
}

if (copyDiagBtn) {
  copyDiagBtn.addEventListener('click', async () => {
    const orig = copyDiagBtn.textContent;
    copyDiagBtn.textContent = '取得中...';
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) throw new Error('タブ未検出');
      const diag = await queryDiagnosticsWithFallback(tab);
      const text = JSON.stringify(diag, null, 2) || '{"error":"empty_diag"}';
      await navigator.clipboard.writeText(text);
      copyDiagBtn.textContent = diag && diag.fallback ? '簡易コピー完了' : 'コピー完了';
    } catch (err) {
      copyDiagBtn.textContent = '取得失敗';
      showTabHint(`診断取得失敗: ${(err && err.message) || '不明なエラー'}`);
    }
    setTimeout(() => {
      copyDiagBtn.textContent = orig;
    }, 1800);
  });
}

loadAll({ recheckHealth: true });
