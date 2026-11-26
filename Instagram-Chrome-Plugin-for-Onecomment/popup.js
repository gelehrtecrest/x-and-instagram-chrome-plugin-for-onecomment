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

async function checkActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      setBadge(tabStatus, '対象外', 'badge-muted');
      return;
    }
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'GET_TAB_STATUS' });
    if (res && res.containerFound) {
      setBadge(tabStatus, 'ライブ監視中', 'badge-ok');
    } else if (res && res.isLivePage) {
      setBadge(tabStatus, 'コメント欄待機中', 'badge-warn');
    } else {
      setBadge(tabStatus, 'Instagram Live以外', 'badge-muted');
    }
  } catch {
    setBadge(tabStatus, 'Instagram以外', 'badge-muted');
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

loadAll({ recheckHealth: true });
