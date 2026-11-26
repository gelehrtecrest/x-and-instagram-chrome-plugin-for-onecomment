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
    : state.mappedServiceName || 'X Live コメント';

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

function isXOriginUrl(urlString) {
  if (typeof urlString !== 'string' || !urlString) return false;
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const host = parsed.hostname.toLowerCase();
    return host === 'x.com' || host === 'www.x.com' || host === 'twitter.com' || host === 'www.twitter.com';
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

    if (tab.url && !isXOriginUrl(tab.url)) {
      setBadge(tabStatus, 'Xページ以外', 'badge-muted');
      return;
    }

    const res = await queryTabStatusWithAutoInject(tab.id);
    if (res && res.wsConnected) {
      setBadge(tabStatus, 'チャット監視中 (WS)', 'badge-ok');
    } else if (res && res.historyFetchCount > 0) {
      setBadge(tabStatus, 'チャット監視中 (API)', 'badge-ok');
    } else if (res && res.domFound) {
      setBadge(tabStatus, 'チャット監視中 (DOM)', 'badge-ok');
    } else if (res && res.isLivePage && !res.hookAlive) {
      setBadge(tabStatus, '要ページ再読込', 'badge-warn');
      showTabHint('X Liveのタブを F5 で再読み込みしてください（通信フックを有効化します）。');
    } else if (res && res.isLivePage) {
      setBadge(tabStatus, 'チャット欄待機中', 'badge-warn');
      if (Array.isArray(res.wsSeenUrls) && res.wsSeenUrls.length > 0) {
        showTabHint(`チャット通信待機中（検出WS: ${res.wsSeenUrls.join(', ')}）`);
      }
    } else {
      setBadge(tabStatus, 'X Live以外', 'badge-muted');
    }
  } catch (err) {
    setBadge(tabStatus, 'タブ未接続', 'badge-err');
    showTabHint(`タブとの通信に失敗しました: ${(err && err.message) || '不明なエラー'}（XタブをF5で再読み込みしてください）`);
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

if (copyDiagBtn) {
  copyDiagBtn.addEventListener('click', async () => {
    const orig = copyDiagBtn.textContent;
    copyDiagBtn.textContent = '取得中...';
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) throw new Error('タブ未検出');
      const diag = await chrome.tabs.sendMessage(tab.id, { type: 'GET_DIAGNOSTICS' });
      await navigator.clipboard.writeText(JSON.stringify(diag, null, 2));
      copyDiagBtn.textContent = 'コピー完了';
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
