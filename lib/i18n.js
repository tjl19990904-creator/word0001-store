// ============================================================================
// Lightweight i18n for the storefront.
//
// Design:
//  - UI copy lives in locales/<locale>.json (never in the database).
//  - Catalog content (product names, descriptions, settings text) stays in the
//    database and uses optional `_zh` companion fields with English fallback.
//  - Locale is resolved per request: URL prefix (/zh) > ?lang= > cookie >
//    Accept-Language > default (en).
// ============================================================================
const fs = require('fs');
const path = require('path');

const DEFAULT_LOCALE = 'en';
const SUPPORTED_LOCALES = ['en', 'zh-CN'];
const COOKIE_NAME = 'lang';
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60 * 1000;
const PREFIX = '/zh';

const dictionaries = {};

function loadDictionary(locale) {
  if (dictionaries[locale]) return dictionaries[locale];
  const file = path.join(__dirname, '..', 'locales', `${locale}.json`);
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`[i18n] Unable to load locale "${locale}":`, error.message);
  }
  dictionaries[locale] = data;
  return data;
}

// Accepts "zh", "zh-cn", "zh_CN", "zh-Hans", "en-US" ... and returns a
// supported locale tag, or null when the value is unknown.
function normalizeLocale(value) {
  if (!value) return null;
  const raw = String(value).trim().toLowerCase().replace(/_/g, '-');
  if (!raw) return null;
  if (raw === 'zh' || raw.startsWith('zh-')) return 'zh-CN';
  if (raw === 'en' || raw.startsWith('en-')) return 'en';
  return null;
}

function lookup(dictionary, key) {
  return String(key)
    .split('.')
    .reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), dictionary);
}

// Translate a dotted key. Falls back to English, then to the key itself so a
// missing entry never renders an empty block.
function t(locale, key, vars) {
  const dict = loadDictionary(locale);
  let value = lookup(dict, key);
  if (value === undefined || value === null) value = lookup(loadDictionary(DEFAULT_LOCALE), key);
  if (value === undefined || value === null) return String(key);
  let text = String(value);
  if (vars && typeof vars === 'object') {
    text = text.replace(/\{(\w+)\}/g, (match, name) => (vars[name] !== undefined ? String(vars[name]) : match));
  }
  return text;
}

function htmlLang(locale) {
  return locale === 'zh-CN' ? 'zh-CN' : 'en';
}

function flattenDictionary(dictionary, prefix, out) {
  Object.keys(dictionary).forEach(key => {
    const value = dictionary[key];
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') flattenDictionary(value, full, out);
    else out[full] = value;
  });
  return out;
}

// Flat "dotted.key" -> text map for the browser. English fills any gap so the
// client never has to fall back to hardcoded strings.
function flatten(locale) {
  const english = flattenDictionary(loadDictionary(DEFAULT_LOCALE), '', {});
  if (locale === DEFAULT_LOCALE) return english;
  return { ...english, ...flattenDictionary(loadDictionary(locale), '', {}) };
}

function isZh(locale) {
  return locale === 'zh-CN';
}

// Pick the Chinese variant of a catalog field when it exists, otherwise the
// original English value. Empty strings count as "not translated".
function localizeField(locale, localizedValue, fallbackValue) {
  if (isZh(locale) && typeof localizedValue === 'string' && localizedValue.trim() !== '') {
    return localizedValue;
  }
  return fallbackValue === undefined || fallbackValue === null ? '' : fallbackValue;
}

// Settings rows keep English in `foo` and an optional Chinese override in
// `foo_zh`. Localize by copying every `*_zh` value onto its base key.
function localizeSettings(settings, locale) {
  if (!settings || !isZh(locale)) return settings || {};
  const localized = { ...settings };
  Object.keys(settings).forEach(key => {
    if (!key.endsWith('_zh')) return;
    const baseKey = key.slice(0, -3);
    const value = settings[key];
    if (typeof value === 'string' && value.trim() !== '') localized[baseKey] = value;
  });
  return localized;
}

// Canonical path for a locale: English has no prefix, Chinese lives under /zh.
function pathForLocale(locale, pathname) {
  let clean = String(pathname || '/');
  const hashIndex = clean.indexOf('#');
  if (hashIndex !== -1) clean = clean.slice(0, hashIndex);
  const queryIndex = clean.indexOf('?');
  if (queryIndex !== -1) clean = clean.slice(0, queryIndex);
  clean = clean.replace(/^\/zh(?=\/|$)/, '');
  if (!clean.startsWith('/')) clean = '/' + clean;
  if (clean === '') clean = '/';
  if (locale === DEFAULT_LOCALE) return clean;
  return clean === '/' ? PREFIX : PREFIX + clean;
}

function getBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  if (process.env.NODE_ENV === 'production') return 'https://word0001.com';
  return `${req.protocol}://${req.get('host')}`;
}

// The project does not depend on cookie-parser, so read the one cookie we need.
function readCookie(req, name) {
  if (req.cookies && req.cookies[name] !== undefined) return req.cookies[name];
  const header = req.headers && req.headers.cookie;
  if (!header) return undefined;
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return part.slice(index + 1).trim();
    }
  }
  return undefined;
}

// Only an explicit choice (cookie) changes the default. Content language is
// never sniffed from Accept-Language: "/" must always answer in English so
// crawlers and hreflang stay consistent, and /zh is the single Chinese URL.
function detectFromRequest(req) {
  const cookieLocale = normalizeLocale(readCookie(req, COOKIE_NAME));
  if (cookieLocale) return cookieLocale;
  return DEFAULT_LOCALE;
}

// Express middleware: normalises /zh prefix, persists ?lang= switches and
// exposes req.locale / req.t to every route.
function middleware(req, res, next) {
  // 1) Explicit ?lang=xx wins and is persisted, then redirect to the clean URL
  //    so a single page never has two indexed addresses.
  const queryLang = req.query && req.query.lang;
  const explicit = normalizeLocale(queryLang);
  if (explicit) {
    res.cookie(COOKIE_NAME, explicit, {
      maxAge: COOKIE_MAX_AGE,
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production'
    });
    const parsed = new URL(req.originalUrl, 'http://internal.local');
    parsed.searchParams.delete('lang');
    const target = pathForLocale(explicit, parsed.pathname) + parsed.search;
    return res.redirect(302, target || '/');
  }

  // 2) A returning visitor who picked Chinese gets sent to the Chinese URL.
  //    Only the bare English homepage redirects, so deep links and crawlers
  //    (which never send cookies) always resolve to the URL they requested.
  const prefixMatch = req.path.match(/^\/zh(?=\/|$)/);
  if (!prefixMatch && req.method === 'GET') {
    const barePath = req.path === '/' || req.path === '';
    const preferred = normalizeLocale(readCookie(req, COOKIE_NAME));
    if (barePath && preferred === 'zh-CN') return res.redirect(302, PREFIX);
  }

  // 3) /zh prefix wins for this request and remembers the choice, so follow-up
  //    form posts (which target unprefixed routes) keep rendering in Chinese.
  if (prefixMatch) {
    req.locale = 'zh-CN';
    req.localePrefix = PREFIX;
    if (normalizeLocale(readCookie(req, COOKIE_NAME)) !== 'zh-CN') {
      res.cookie(COOKIE_NAME, 'zh-CN', {
        maxAge: COOKIE_MAX_AGE,
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production'
      });
    }
    const stripped = req.url.replace(/^\/zh(?=\/|$)/, '');
    req.url = stripped === '' || stripped === '/' ? '/' : stripped;
    if (!req.url.startsWith('/')) req.url = '/' + req.url;
  } else {
    req.locale = detectFromRequest(req);
    req.localePrefix = '';
  }

  req.t = (key, vars) => t(req.locale, key, vars);
  res.locals.locale = req.locale;
  res.locals.t = req.t;
  next();
}

module.exports = {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  COOKIE_NAME,
  COOKIE_MAX_AGE,
  PREFIX,
  middleware,
  t,
  normalizeLocale,
  htmlLang,
  flatten,
  isZh,
  localizeField,
  localizeSettings,
  pathForLocale,
  getBaseUrl,
  readCookie
};
