'use strict';

const crypto = require('crypto');

const SUPPORTED_PLATFORMS = new Set(['x', 'instagram']);

class DedupCache {
  constructor({ ttlMs = 600000, maxEntries = 2000 } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.map = new Map();
  }

  updateLimits({ ttlMs, maxEntries }) {
    if (typeof ttlMs === 'number' && ttlMs > 0) this.ttlMs = ttlMs;
    if (typeof maxEntries === 'number' && maxEntries > 0) this.maxEntries = maxEntries;
    this.prune();
  }

  prune(now = Date.now()) {
    for (const [key, expiresAt] of this.map.entries()) {
      if (expiresAt <= now) {
        this.map.delete(key);
      }
    }
    while (this.map.size > this.maxEntries) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) break;
      this.map.delete(oldestKey);
    }
  }

  has(key, now = Date.now()) {
    const expiresAt = this.map.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt <= now) {
      this.map.delete(key);
      return false;
    }
    return true;
  }

  add(key, now = Date.now()) {
    this.map.delete(key);
    this.map.set(key, now + this.ttlMs);
    if (this.map.size > this.maxEntries) {
      this.prune(now);
    }
  }

  clear() {
    this.map.clear();
  }
}

function sanitizeText(value, maxLength = 500) {
  if (value === null || value === undefined) return '';
  const cleaned = String(value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  return `${cleaned.slice(0, Math.max(1, maxLength - 1))}…`;
}

function sanitizeUrl(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return parsed.toString();
    }
  } catch {
    return '';
  }
  return '';
}

function sanitizeBadges(badges) {
  if (!Array.isArray(badges)) return [];
  const result = [];
  for (const badge of badges.slice(0, 8)) {
    if (!badge || typeof badge !== 'object') continue;
    const url = sanitizeUrl(badge.url);
    const label = sanitizeText(badge.label, 40);
    const type = sanitizeText(badge.type, 30);
    if (!url && !label) continue;
    result.push({
      url,
      label,
      ...(type ? { type } : {}),
    });
  }
  return result;
}

function buildFallbackId(platform, userId, commentText, timestamp) {
  const bucket = Math.floor(timestamp / 5000);
  const hash = crypto
    .createHash('sha256')
    .update(`${platform}|${userId}|${commentText}|${bucket}`)
    .digest('hex')
    .slice(0, 16);
  return `${platform}_live_${hash}`;
}

function normalizeComment(raw, platform, config) {
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    return { error: `未対応のプラットフォームです: ${platform}` };
  }
  if (!raw || typeof raw !== 'object') {
    return { error: 'コメント項目がオブジェクトではありません。' };
  }

  const isSystem = Boolean(raw.isSystem);
  if (isSystem && config.skipSystemMessages) {
    return { filtered: true, reason: 'system_message' };
  }

  const commentText = sanitizeText(raw.comment, config.maxCommentLength);
  if (!commentText) {
    return { filtered: true, reason: 'empty_comment' };
  }

  const rawName = sanitizeText(raw.name || raw.displayName || raw.screenName || raw.userId, 80);
  const name = rawName || (platform === 'x' ? 'Xユーザー' : 'Instagramユーザー');

  const rawUserId = sanitizeText(raw.userId || raw.screenName || name, 80).replace(/^@/, '');
  const userId = `${platform}:${rawUserId || 'anonymous'}`;

  const timestamp =
    typeof raw.timestamp === 'number' && Number.isFinite(raw.timestamp) && raw.timestamp > 0
      ? Math.floor(raw.timestamp)
      : Date.now();

  const rawId = sanitizeText(raw.id, 128);
  const id = rawId || buildFallbackId(platform, userId, commentText, timestamp);
  const profileImage = sanitizeUrl(raw.profileImage);

  const normalized = {
    id,
    userId,
    liveId: `${platform}-live`,
    name,
    displayName: name,
    comment: commentText,
    profileImage,
    originalProfileImage: profileImage,
    isOwner: Boolean(raw.isOwner),
    hasGift: Boolean(raw.hasGift),
    timestamp,
    badges: sanitizeBadges(raw.badges),
  };

  return { comment: normalized, dedupKey: `${platform}:${id}` };
}

module.exports = {
  SUPPORTED_PLATFORMS,
  DedupCache,
  sanitizeText,
  sanitizeUrl,
  sanitizeBadges,
  normalizeComment,
};
