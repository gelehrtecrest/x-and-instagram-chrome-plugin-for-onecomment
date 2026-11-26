(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.XLiveSelectors = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_CONTAINER_SELECTORS = [
    '[data-testid="liveChatMessages"]',
    '[data-testid="chatMessages"]',
    '[data-testid="broadcastChat"]',
    '[aria-label*="ライブチャット" i]',
    '[aria-label*="Live chat" i]',
    '[aria-label*="チャット" i][role="region"]',
    '[aria-label*="Chat" i][role="region"]',
    '[role="log"]',
  ];

  const DEFAULT_ITEM_SELECTORS = [
    '[data-testid="liveChatMessage"]',
    '[data-testid="chatMessage"]',
    '[data-testid="broadcastChatMessage"]',
    '[role="listitem"]',
  ];

  const DEFAULT_AUTHOR_SELECTORS = [
    '[data-testid="User-Name"]',
    '[data-testid="chatMessageAuthor"]',
    'a[href^="/"] span',
    'a[role="link"] span',
    'strong',
  ];

  const DEFAULT_MESSAGE_SELECTORS = [
    '[data-testid="chatMessageText"]',
    '[data-testid="liveChatMessageText"]',
    '[data-testid="tweetText"]',
    '[dir="auto"]',
  ];

  const SYSTEM_PATTERNS = [
    /^.+?(?:さんが)?参加しました[。!！]?$/,
    /^.+? joined(?:\s+the\s+broadcast)?[.!]?$/i,
    /^.+?(?:さんが)?シェアしました[。!！]?$/,
    /^.+? shared(?:\s+the\s+broadcast)?[.!]?$/i,
    /^.+?(?:さんが)?(?:この配信を)?リポストしました[。!！]?$/,
    /^.+? reposted this stream[!.]?$/i,
    /^.+? invited .+$/i,
  ];

  const UI_NOISE_PATTERNS = [
    /^\d[\d,.\s万億kKmM]*\s*(?:件の表示|views?|watching|viewers?|人が視聴中|人視聴中|件の返信|件のリポスト|件のいいね)$/i,
    /^(?:ライブ|LIVE|配信中|チャット|Chat|トップチャット|Top chat|ライブチャット|Live chat|リプレイ|Replay|チャットのリプレイ|配信終了|フォローする|フォロー中|Follow|Following|送信|Send)$/i,
  ];

  const CHAT_INPUT_HINT_PATTERN = /チャット|コメント|メッセージ|返信|chat|comment|say something|message|reply/i;
  const CHAT_HEADER_PATTERN = /^(?:ライブチャット|チャット|トップチャット|Live chat|Top chat|Chat|チャットのリプレイ|Chat replay)$/i;

  function isXLivePage(urlString) {
    if (typeof urlString !== 'string') return false;
    try {
      const url = new URL(urlString);
      const host = url.hostname.toLowerCase();
      if (host !== 'x.com' && host !== 'www.x.com' && host !== 'twitter.com' && host !== 'www.twitter.com') {
        return false;
      }
      const path = url.pathname;
      return (
        path.startsWith('/i/broadcasts/') ||
        path.startsWith('/i/events/') ||
        path.startsWith('/i/spaces/') ||
        path.includes('/status/') ||
        path.includes('/live')
      );
    } catch {
      return false;
    }
  }

  function isDedicatedBroadcastUrl(urlString) {
    if (typeof urlString !== 'string') return false;
    try {
      const url = new URL(urlString);
      const path = url.pathname;
      return (
        path.startsWith('/i/broadcasts/') ||
        path.startsWith('/i/events/') ||
        path.startsWith('/i/spaces/') ||
        path.includes('/live')
      );
    } catch {
      return false;
    }
  }

  function fnv1aHash(str) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i += 1) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function safeJsonParse(value) {
    if (value && typeof value === 'object') return value;
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  function normalizeTimestamp(value, fallbackNow) {
    if (typeof value === 'string' && value.includes('T') && value.includes('-')) {
      const parsedDate = Date.parse(value);
      if (Number.isFinite(parsedDate) && parsedDate > 0) return Math.floor(parsedDate);
    }
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return fallbackNow;
    if (num > 1e15) {
      return Math.floor(num / 1e6);
    }
    if (num > 1e12) {
      return num > 1e14 ? Math.floor(num / 1e3) : Math.floor(num);
    }
    if (num > 1e9) {
      return Math.floor(num * 1000);
    }
    return fallbackNow;
  }

  function sanitizeHttpUrl(url) {
    if (typeof url !== 'string') return '';
    const trimmed = url.trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('https://') || trimmed.startsWith('http://')) {
      return trimmed;
    }
    return '';
  }

  function extractTextWithEmoji(node) {
    if (!node) return '';
    if (node.nodeType === 3) {
      return node.nodeValue || '';
    }
    if (node.nodeType !== 1) return '';

    const tag = node.tagName ? node.tagName.toUpperCase() : '';
    if (tag === 'IMG') {
      const alt = node.getAttribute ? node.getAttribute('alt') : '';
      return alt || '';
    }
    if (tag === 'BR') {
      return ' ';
    }
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'SVG') {
      return '';
    }

    let out = '';
    const children = node.childNodes || [];
    for (let i = 0; i < children.length; i += 1) {
      out += extractTextWithEmoji(children[i]);
    }
    return out;
  }

  function normalizeWhitespace(text) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isUiNoiseText(text) {
    const trimmed = normalizeWhitespace(text);
    if (!trimmed) return true;
    return UI_NOISE_PATTERNS.some((pattern) => pattern.test(trimmed));
  }

  function isScrollableElement(el) {
    if (!el || el.nodeType !== 1 || typeof getComputedStyle !== 'function') return false;
    try {
      const style = getComputedStyle(el);
      if (!style) return false;
      const oy = style.overflowY;
      return oy === 'auto' || oy === 'scroll' || oy === 'overlay';
    } catch {
      return false;
    }
  }

  function isExcludedContainer(el) {
    if (!el || el.nodeType !== 1) return true;
    const tag = el.tagName ? el.tagName.toUpperCase() : '';
    if (tag === 'BODY' || tag === 'HTML' || tag === 'MAIN' || tag === 'HEADER' || tag === 'NAV') {
      return true;
    }
    if (typeof el.closest === 'function' && el.closest('[data-testid="sidebarColumn"] nav')) {
      return true;
    }
    if (typeof el.querySelector === 'function') {
      if (el.querySelector('video')) return true;
      if (el.querySelector('article[data-testid="tweet"]')) return true;
      if (el.querySelector('[data-testid="videoPlayer"]')) return true;
    }
    return false;
  }

  function pickBestChatListInside(parent, excludeEl) {
    if (!parent || typeof parent.querySelectorAll !== 'function') return null;
    const candidates = parent.querySelectorAll('div, ul, section');
    let best = null;
    let bestScore = 0;

    for (const el of candidates) {
      if (excludeEl && (el === excludeEl || el.contains(excludeEl) || excludeEl.contains(el))) {
        continue;
      }
      if (isExcludedContainer(el)) continue;

      const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
      if (rect && (rect.height < 110 || rect.width < 160)) continue;

      const scrollable = isScrollableElement(el);
      const childCount = el.children ? el.children.length : 0;
      const profileImgs = el.querySelectorAll ? el.querySelectorAll('img[src*="profile_images"]').length : 0;
      const hasInputInside = el.querySelector ? Boolean(el.querySelector('textarea, input, [contenteditable="true"]')) : false;
      if (hasInputInside) continue;

      let score = 0;
      if (scrollable) score += 15;
      if (profileImgs > 0) score += Math.min(12, profileImgs * 4);
      if (childCount > 0) score += Math.min(6, childCount);
      if (rect && rect.height >= 160) score += 5;
      if (el.getAttribute && el.getAttribute('role') === 'list') score += 8;

      // より内側の具体的なリストコンテナを優先（同点なら深い要素）
      if (score > bestScore || (score === bestScore && best && best.contains(el))) {
        bestScore = score;
        best = el;
      }
    }

    return best && bestScore >= 8 ? { element: best, score: bestScore } : null;
  }

  function findChatContainerByInputHeuristic(doc, isDedicated) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return null;

    const inputs = doc.querySelectorAll(
      'textarea, input[type="text"], input:not([type]), [contenteditable="true"]'
    );
    for (const input of inputs) {
      const testId = input.getAttribute('data-testid') || '';
      if (testId === 'dmComposerTextInput' || testId === 'SearchBox_Search_Input') {
        continue;
      }
      if (!isDedicated && testId.startsWith('tweetTextarea')) {
        continue;
      }

      const placeholder = input.getAttribute('placeholder') || '';
      const ariaLabel = input.getAttribute('aria-label') || '';
      const combinedHint = `${placeholder} ${ariaLabel}`;
      if (!CHAT_INPUT_HINT_PATTERN.test(combinedHint) && !isDedicated) {
        continue;
      }

      // React Native Web の深いラッパーに対応するため最大14階層まで探索（videoを含む親で即停止）
      let parent = input.parentElement;
      for (let depth = 0; depth < 14 && parent; depth += 1) {
        if (isExcludedContainer(parent)) break;
        const picked = pickBestChatListInside(parent, input);
        if (picked) {
          return { element: picked.element, selector: 'heuristic:input-sibling' };
        }
        parent = parent.parentElement;
      }
    }

    return null;
  }

  function findChatContainerByChatHeaderHeuristic(doc) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return null;

    const nodes = doc.querySelectorAll('h1, h2, h3, span, div');
    for (const node of nodes) {
      if (node.children && node.children.length > 0) continue;
      const text = normalizeWhitespace(node.textContent || '');
      if (!text || text.length > 30) continue;
      if (!CHAT_HEADER_PATTERN.test(text)) continue;

      let parent = node.parentElement;
      for (let depth = 0; depth < 10 && parent; depth += 1) {
        if (isExcludedContainer(parent)) break;
        const picked = pickBestChatListInside(parent, node);
        if (picked) {
          return { element: picked.element, selector: 'heuristic:chat-header' };
        }
        parent = parent.parentElement;
      }
    }

    return null;
  }

  function findChatContainer(doc, customContainerSelector, urlString = '') {
    if (!doc || typeof doc.querySelector !== 'function') {
      return { element: null, selector: '' };
    }

    const candidates = [];
    if (customContainerSelector && customContainerSelector.trim()) {
      candidates.push(customContainerSelector.trim());
    }
    candidates.push(...DEFAULT_CONTAINER_SELECTORS);

    for (const selector of candidates) {
      try {
        const el = doc.querySelector(selector);
        if (el && !isExcludedContainer(el)) {
          return { element: el, selector };
        }
      } catch {
        // 無効なカスタムセレクタは無視
      }
    }

    const currentUrl = urlString || (doc.location && doc.location.href) || '';
    const isDedicated = isDedicatedBroadcastUrl(currentUrl);

    const byInput = findChatContainerByInputHeuristic(doc, isDedicated);
    if (byInput) return byInput;

    const byHeader = findChatContainerByChatHeaderHeuristic(doc);
    if (byHeader) return byHeader;

    return { element: null, selector: '' };
  }

  function findMessageElements(rootEl, customItemSelector) {
    if (!rootEl || typeof rootEl.querySelectorAll !== 'function') return [];

    const candidates = [];
    if (customItemSelector && customItemSelector.trim()) {
      candidates.push(customItemSelector.trim());
    }
    candidates.push(...DEFAULT_ITEM_SELECTORS);

    for (const selector of candidates) {
      try {
        const matches = rootEl.querySelectorAll(selector);
        if (matches && matches.length > 0) {
          return Array.from(matches);
        }
      } catch {
        // ignore invalid selector
      }
    }

    return Array.from(rootEl.children || []).filter((child) => child && child.nodeType === 1);
  }

  function extractHandlesFromElement(itemEl) {
    if (!itemEl || typeof itemEl.querySelectorAll !== 'function') return [];
    const links = itemEl.querySelectorAll('a[href^="/"]');
    const handles = [];
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      const match = href.match(/^\/([A-Za-z0-9_]{1,30})(?:\/|$|\?)/);
      if (match) {
        const candidate = match[1];
        if (!['i', 'home', 'explore', 'search', 'messages', 'notifications', 'settings'].includes(candidate)) {
          if (!handles.includes(candidate)) {
            handles.push(candidate);
          }
        }
      }
    }
    return handles;
  }

  function extractProfileImage(itemEl) {
    if (!itemEl || typeof itemEl.querySelectorAll !== 'function') return '';
    const imgs = itemEl.querySelectorAll('img[src]');
    for (const img of imgs) {
      const src = img.getAttribute('src') || '';
      if (src.includes('profile_images') || src.includes('pbs.twimg.com')) {
        if (!src.includes('/emoji/')) {
          return src;
        }
      }
    }
    return '';
  }

  function collectLeafTextSegments(rootEl) {
    const segments = [];
    const walk = (node) => {
      if (!node) return;
      if (node.nodeType === 3) {
        const t = normalizeWhitespace(node.nodeValue || '');
        if (t) segments.push(t);
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = node.tagName ? node.tagName.toUpperCase() : '';
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'SVG' || tag === 'BUTTON') return;
      if (tag === 'IMG') {
        const alt = node.getAttribute ? node.getAttribute('alt') : '';
        if (alt && !alt.includes('プロフィール') && !alt.toLowerCase().includes('avatar')) {
          segments.push(alt);
        }
        return;
      }
      const children = node.childNodes || [];
      // テキストと絵文字imgだけで構成されたspanは1つのセグメントとしてまとめる
      const hasBlockChild = Array.from(children).some(
        (c) => c.nodeType === 1 && c.tagName && !['IMG', 'BR'].includes(c.tagName.toUpperCase())
      );
      if (!hasBlockChild) {
        const t = normalizeWhitespace(extractTextWithEmoji(node));
        if (t) segments.push(t);
        return;
      }
      for (let i = 0; i < children.length; i += 1) {
        walk(children[i]);
      }
    };
    walk(rootEl);
    return segments;
  }

  function escapeRegExp(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function stripAuthorPrefix(text, displayName, handle) {
    let out = normalizeWhitespace(text);
    if (!out) return '';

    const cleanName = String(displayName || '')
      .replace(/\s*@[A-Za-z0-9_]+$/, '')
      .trim();
    const cleanHandle = String(handle || '')
      .replace(/^@/, '')
      .trim();

    for (let pass = 0; pass < 2; pass += 1) {
      const before = out;
      if (cleanName && out.startsWith(cleanName)) {
        const afterName = out.slice(cleanName.length);
        if (
          !afterName ||
          /^[\s:：·・@]/.test(afterName) ||
          (cleanHandle && afterName.toLowerCase().startsWith(`@${cleanHandle.toLowerCase()}`))
        ) {
          out = normalizeWhitespace(afterName.replace(/^[\s:：·・]+/, ''));
        }
      }
      if (cleanHandle) {
        const handleRe = new RegExp(`^@${escapeRegExp(cleanHandle)}(?:[\\s:：·・]+)?`, 'i');
        if (handleRe.test(out)) {
          out = normalizeWhitespace(out.replace(handleRe, ''));
        }
      }
      if (out === before) break;
    }

    return out;
  }

  function isSystemMessage(text) {
    const trimmed = normalizeWhitespace(text);
    if (!trimmed) return false;
    return SYSTEM_PATTERNS.some((pattern) => pattern.test(trimmed));
  }

  function buildFormattedName(displayName, handle, nameFormat) {
    const cleanDisplayName =
      String(displayName || '')
        .replace(/\s*@[A-Za-z0-9_]+$/, '')
        .trim() ||
      handle ||
      'Xユーザー';
    const screenName = handle ? `@${handle}` : '';
    const formattedName =
      nameFormat === 'both' && screenName && cleanDisplayName !== handle
        ? `${cleanDisplayName} (${screenName})`
        : cleanDisplayName;
    return { cleanDisplayName, screenName, formattedName };
  }

  function parseChatmanPayload(rawData, options = {}) {
    const outer = safeJsonParse(rawData);
    if (!outer || typeof outer !== 'object') return null;

    if (typeof outer.kind === 'number' && outer.kind !== 1) {
      return null;
    }

    const payload = safeJsonParse(outer.payload) || outer;
    if (!payload || typeof payload !== 'object') return null;

    const parsedBody = safeJsonParse(payload.body);
    const hasInnerObj = Boolean(parsedBody && typeof parsedBody === 'object');
    const bodyObj = hasInnerObj ? parsedBody : {};

    const msgType =
      typeof bodyObj.type === 'number'
        ? bodyObj.type
        : typeof payload.type === 'number'
          ? payload.type
          : undefined;

    if (msgType !== undefined && msgType !== 1) {
      return null;
    }

    const rawComment =
      typeof bodyObj.body === 'string'
        ? bodyObj.body
        : typeof bodyObj.message === 'string'
          ? bodyObj.message
          : typeof bodyObj.text === 'string'
            ? bodyObj.text
            : !hasInnerObj && typeof payload.body === 'string'
              ? payload.body
              : typeof payload.message === 'string'
                ? payload.message
                : '';

    const commentText = normalizeWhitespace(rawComment);
    if (!commentText) return null;

    const sender =
      (payload.sender && typeof payload.sender === 'object' ? payload.sender : null) ||
      (outer.sender && typeof outer.sender === 'object' ? outer.sender : null) ||
      (bodyObj.sender && typeof bodyObj.sender === 'object' ? bodyObj.sender : null) ||
      {};

    const handle = String(
      bodyObj.username ||
        payload.username ||
        sender.username ||
        sender.twitter_screen_name ||
        sender.screen_name ||
        ''
    )
      .replace(/^@/, '')
      .trim();

    const rawDisplayName = String(
      bodyObj.displayName ||
        bodyObj.display_name ||
        payload.displayName ||
        payload.display_name ||
        sender.display_name ||
        sender.displayName ||
        handle ||
        ''
    ).trim();

    if (!rawDisplayName && !handle) {
      return null;
    }

    const nameFormat = options.nameFormat || 'display';
    const { cleanDisplayName, screenName, formattedName } = buildFormattedName(
      rawDisplayName,
      handle,
      nameFormat
    );

    const userId = String(
      handle ||
        sender.twitter_id ||
        sender.user_id ||
        bodyObj.user_id ||
        cleanDisplayName
    ).trim();

    const profileImage = sanitizeHttpUrl(
      bodyObj.profileImageURL ||
        bodyObj.profileImageUrl ||
        bodyObj.profile_image_url ||
        payload.profileImageURL ||
        payload.profileImageUrl ||
        payload.profile_image_url ||
        sender.profile_image_url ||
        sender.profileImageUrl ||
        ''
    );

    const now = typeof options.now === 'number' ? options.now : Date.now();
    const timestamp = normalizeTimestamp(
      bodyObj.timestamp || bodyObj.programDateTime || payload.timestamp || outer.timestamp,
      now
    );

    const uuid = String(bodyObj.uuid || payload.uuid || outer.uuid || '').trim();
    const bucket = Math.floor(timestamp / 15000);
    const id = uuid
      ? `x_live_ws_${uuid}`
      : `x_live_${fnv1aHash(`${userId}|${commentText}|${bucket}`)}`;

    const isOwner = Boolean(
      bodyObj.isBroadcaster ||
        bodyObj.is_broadcaster ||
        payload.isBroadcaster ||
        sender.is_broadcaster ||
        sender.isOwner
    );
    const isSystem = isSystemMessage(commentText);

    return {
      id,
      userId,
      name: formattedName,
      screenName,
      comment: commentText,
      profileImage,
      timestamp,
      isOwner,
      isModerator: Boolean(bodyObj.isModerator || sender.is_moderator),
      hasGift: false,
      isSystem,
      badges: isOwner ? [{ url: '', label: '配信者', type: 'owner' }] : [],
    };
  }

  function parseHistoryResponse(rawData, options = {}) {
    const parsed = safeJsonParse(rawData);
    if (!parsed || typeof parsed !== 'object') return [];
    const messages = Array.isArray(parsed.messages)
      ? parsed.messages
      : Array.isArray(parsed)
        ? parsed
        : [];
    const results = [];
    for (const msg of messages) {
      const item = parseChatmanPayload(msg, options);
      if (item) results.push(item);
    }
    return results;
  }

  function parseChatMessageElement(itemEl, options = {}) {
    if (!itemEl || itemEl.nodeType !== 1) return null;

    if (typeof itemEl.querySelector === 'function') {
      if (itemEl.querySelector('video, textarea, input, article[data-testid="tweet"]')) {
        return null;
      }
    }

    const custom = options.customSelectors || {};
    const nameFormat = options.nameFormat || 'display';

    const handles = extractHandlesFromElement(itemEl);
    if (handles.length > 2) {
      return null;
    }
    let handle = handles[0] || '';
    const profileImage = extractProfileImage(itemEl);

    // 1. ユーザー名抽出（標準セレクタ）
    let displayName = '';
    const authorSelectors = [];
    if (custom.author && custom.author.trim()) {
      authorSelectors.push(custom.author.trim());
    }
    authorSelectors.push(...DEFAULT_AUTHOR_SELECTORS);

    let authorEl = null;
    for (const selector of authorSelectors) {
      try {
        const el = itemEl.querySelector(selector);
        if (el) {
          const text = normalizeWhitespace(extractTextWithEmoji(el));
          if (text && !isUiNoiseText(text)) {
            displayName = text;
            authorEl = el;
            break;
          }
        }
      } catch {
        // ignore invalid selector
      }
    }

    if (!displayName && handle) {
      displayName = handle;
    }

    let commentText = '';

    // 2. 本文抽出（標準セレクタ）
    if (displayName) {
      const messageSelectors = [];
      if (custom.message && custom.message.trim()) {
        messageSelectors.push(custom.message.trim());
      }
      messageSelectors.push(...DEFAULT_MESSAGE_SELECTORS);

      for (const selector of messageSelectors) {
        try {
          const els = itemEl.querySelectorAll(selector);
          for (const el of els) {
            if (authorEl && (el === authorEl || authorEl.contains(el) || el.contains(authorEl))) {
              continue;
            }
            const rawText = normalizeWhitespace(extractTextWithEmoji(el));
            if (!rawText) continue;
            if (rawText === displayName || rawText === `@${handle}`) continue;
            const cleanedText = stripAuthorPrefix(rawText, displayName, handle);
            if (!cleanedText) continue;
            if (isUiNoiseText(cleanedText)) continue;
            commentText = cleanedText;
            break;
          }
          if (commentText) break;
        } catch {
          // ignore invalid selector
        }
      }
    }

    // 3. フォールバック: <a>タグを使わないX Liveチャット行（[プロフィール画像 + ユーザー名span + 本文span] 構造）
    if (!displayName || !commentText) {
      const segments = collectLeafTextSegments(itemEl).filter((s) => !isUiNoiseText(s));
      const nonHandleSegments = [];
      for (const seg of segments) {
        if (/^@[A-Za-z0-9_]{1,30}$/.test(seg)) {
          if (!handle) handle = seg.slice(1);
          continue;
        }
        nonHandleSegments.push(seg);
      }

      if (!displayName && nonHandleSegments.length >= 2) {
        const candidateAuthor = nonHandleSegments[0];
        const candidateBody = nonHandleSegments.slice(1).join(' ').trim();
        if (
          candidateAuthor.length <= 40 &&
          candidateBody.length > 0 &&
          candidateBody.length <= 500 &&
          (profileImage || handle)
        ) {
          displayName = candidateAuthor;
          commentText = candidateBody;
        }
      } else if (displayName && !commentText) {
        const fullText = normalizeWhitespace(extractTextWithEmoji(itemEl));
        if (fullText.length <= 600) {
          let rest = stripAuthorPrefix(fullText, displayName, handle);
          if (rest === fullText && fullText.startsWith(displayName)) {
            rest = stripAuthorPrefix(fullText.slice(displayName.length), displayName, handle);
          }
          if (rest && rest !== fullText && rest !== `@${handle}` && !isUiNoiseText(rest)) {
            commentText = rest;
          }
        }
      }
    }

    if (commentText) {
      commentText = stripAuthorPrefix(commentText, displayName, handle);
    }

    if (!displayName && !handle) return null;
    if (!commentText || isUiNoiseText(commentText)) return null;
    if (commentText === displayName || commentText === `@${handle}`) return null;

    const { cleanDisplayName, screenName, formattedName } = buildFormattedName(
      displayName,
      handle,
      nameFormat
    );

    const userId = handle || cleanDisplayName;
    const itemText = normalizeWhitespace(itemEl.textContent || '');
    const isOwner = Boolean(
      itemEl.querySelector('[data-testid="broadcasterBadge"], [aria-label*="Host" i], [aria-label*="ホスト" i]')
    );
    const isSystem = isSystemMessage(commentText) || isSystemMessage(itemText);

    const domId =
      itemEl.getAttribute('data-message-id') ||
      itemEl.getAttribute('data-id') ||
      itemEl.id ||
      '';

    const now = typeof options.now === 'number' ? options.now : Date.now();
    const bucket = Math.floor(now / 15000);
    const id = domId
      ? `x_live_${domId}`
      : `x_live_${fnv1aHash(`${userId}|${commentText}|${bucket}`)}`;

    return {
      id,
      userId,
      name: formattedName,
      screenName,
      comment: commentText,
      profileImage,
      timestamp: now,
      isOwner,
      isModerator: false,
      hasGift: false,
      isSystem,
      badges: isOwner ? [{ url: '', label: '配信者', type: 'owner' }] : [],
    };
  }

  function collectDomDiagnostics(doc, urlString = '') {
    if (!doc || typeof doc.querySelectorAll !== 'function') return {};

    const inputs = Array.from(
      doc.querySelectorAll('textarea, input[type="text"], input:not([type]), [contenteditable="true"]')
    )
      .slice(0, 8)
      .map((el) => ({
        tag: el.tagName,
        testid: el.getAttribute('data-testid') || '',
        placeholder: (el.getAttribute('placeholder') || '').slice(0, 40),
        aria: (el.getAttribute('aria-label') || '').slice(0, 40),
      }));

    const chatHeaders = [];
    const nodes = doc.querySelectorAll('h1, h2, h3, span, div');
    for (const node of nodes) {
      if (chatHeaders.length >= 5) break;
      if (node.children && node.children.length > 0) continue;
      const text = normalizeWhitespace(node.textContent || '');
      if (text && text.length <= 30 && CHAT_HEADER_PATTERN.test(text)) {
        chatHeaders.push({
          tag: node.tagName,
          text,
          testid: node.getAttribute('data-testid') || '',
        });
      }
    }

    const iframes = Array.from(doc.querySelectorAll('iframe'))
      .slice(0, 5)
      .map((f) => (f.getAttribute('src') || '').split('?')[0]);

    const found = findChatContainer(doc, '', urlString);
    let containerInfo = null;
    if (found.element) {
      const rect =
        typeof found.element.getBoundingClientRect === 'function'
          ? found.element.getBoundingClientRect()
          : null;
      const sampleChildren = Array.from(found.element.children || [])
        .slice(-3)
        .map((c) => ({
          tag: c.tagName,
          testid: c.getAttribute('data-testid') || '',
          text: normalizeWhitespace(extractTextWithEmoji(c)).slice(0, 80),
          hasImg: Boolean(c.querySelector && c.querySelector('img[src*="profile_images"]')),
          hasLink: Boolean(c.querySelector && c.querySelector('a[href^="/"]')),
        }));
      containerInfo = {
        selector: found.selector,
        tag: found.element.tagName,
        testid: found.element.getAttribute('data-testid') || '',
        childCount: found.element.children ? found.element.children.length : 0,
        size: rect ? `${Math.round(rect.width)}x${Math.round(rect.height)}` : '',
        sampleChildren,
      };
    }

    return {
      inputs,
      chatHeaders,
      iframes,
      containerInfo,
    };
  }

  return {
    DEFAULT_CONTAINER_SELECTORS,
    DEFAULT_ITEM_SELECTORS,
    isXLivePage,
    isUiNoiseText,
    extractTextWithEmoji,
    findChatContainer,
    findMessageElements,
    parseChatMessageElement,
    parseChatmanPayload,
    parseHistoryResponse,
    stripAuthorPrefix,
    collectDomDiagnostics,
    isSystemMessage,
    fnv1aHash,
  };
});
