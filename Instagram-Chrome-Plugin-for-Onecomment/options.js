'use strict';

const bridgeUrlEl = document.getElementById('bridgeUrl');
const tokenEl = document.getElementById('token');
const serviceIdEl = document.getElementById('serviceId');
const loadServicesBtn = document.getElementById('loadServicesBtn');
const skipSystemEl = document.getElementById('skipSystemMessages');
const skipInitialEl = document.getElementById('skipInitialComments');
const batchIntervalEl = document.getElementById('batchIntervalMs');
const selContainerEl = document.getElementById('selContainer');
const selItemEl = document.getElementById('selItem');
const selAuthorEl = document.getElementById('selAuthor');
const selMessageEl = document.getElementById('selMessage');
const saveBtn = document.getElementById('saveBtn');
const testConnBtn = document.getElementById('testConnBtn');
const statusMsg = document.getElementById('statusMsg');

let currentEnabled = true;

function showStatus(text, isError = false) {
  statusMsg.textContent = text;
  statusMsg.className = isError ? 'error' : '';
}

function collectSettings() {
  return {
    enabled: currentEnabled,
    bridgeUrl: bridgeUrlEl.value.trim() || 'http://127.0.0.1:11185',
    token: tokenEl.value.trim(),
    serviceId: serviceIdEl.value,
    skipSystemMessages: skipSystemEl.checked,
    skipInitialComments: skipInitialEl.checked,
    batchIntervalMs: Math.max(100, Math.min(2000, Number(batchIntervalEl.value) || 300)),
    customSelectors: {
      container: selContainerEl.value.trim(),
      item: selItemEl.value.trim(),
      author: selAuthorEl.value.trim(),
      message: selMessageEl.value.trim(),
    },
  };
}

function populateServices(services, selectedId) {
  serviceIdEl.textContent = '';
  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = '自動（プラグイン側の「Instagram Live コメント」枠を使用）';
  serviceIdEl.appendChild(defaultOpt);

  let foundSelected = selectedId === '';
  for (const svc of services) {
    const opt = document.createElement('option');
    opt.value = svc.id;
    opt.textContent = `${svc.name} (${svc.id.slice(0, 8)}...)`;
    if (svc.id === selectedId) foundSelected = true;
    serviceIdEl.appendChild(opt);
  }

  if (selectedId && !foundSelected) {
    const customOpt = document.createElement('option');
    customOpt.value = selectedId;
    customOpt.textContent = `保存済み枠ID (${selectedId})`;
    serviceIdEl.appendChild(customOpt);
  }
  serviceIdEl.value = selectedId || '';
}

async function fetchServicesList(selectedId) {
  const res = await chrome.runtime.sendMessage({
    type: 'FETCH_SERVICES',
    settingsOverride: collectSettings(),
  });
  if (res && res.ok) {
    populateServices(res.services || [], selectedId);
    showStatus(`枠一覧を ${res.services.length} 件取得しました。`);
  } else {
    showStatus(`枠一覧の取得に失敗しました: ${(res && res.error) || '不明なエラー'}`, true);
  }
}

async function loadSettings() {
  const res = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  const settings = (res && res.settings) || {};
  currentEnabled = settings.enabled !== false;

  bridgeUrlEl.value = settings.bridgeUrl || 'http://127.0.0.1:11185';
  tokenEl.value = settings.token || '';
  skipSystemEl.checked = settings.skipSystemMessages !== false;
  skipInitialEl.checked = settings.skipInitialComments !== false;
  batchIntervalEl.value = String(settings.batchIntervalMs || 300);

  const custom = settings.customSelectors || {};
  selContainerEl.value = custom.container || '';
  selItemEl.value = custom.item || '';
  selAuthorEl.value = custom.author || '';
  selMessageEl.value = custom.message || '';

  populateServices([], settings.serviceId || '');
  await fetchServicesList(settings.serviceId || '');
}

loadServicesBtn.addEventListener('click', () => {
  fetchServicesList(serviceIdEl.value);
});

saveBtn.addEventListener('click', async () => {
  const nextSettings = collectSettings();
  await chrome.storage.local.set({ settings: nextSettings });
  await chrome.runtime.sendMessage({ type: 'CHECK_HEALTH' });
  showStatus('設定を保存しました。');
});

testConnBtn.addEventListener('click', async () => {
  showStatus('接続確認中...');
  const res = await chrome.runtime.sendMessage({
    type: 'CHECK_HEALTH',
    settingsOverride: collectSettings(),
  });
  if (res && res.ok) {
    const reachText = res.health && res.health.onecommeReachable ? 'わんコメ疎通OK' : 'わんコメ本体未応答';
    showStatus(`接続成功（${reachText}）`);
  } else {
    showStatus(`接続失敗: ${(res && res.error) || '不明なエラー'}`, true);
  }
});

loadSettings();
