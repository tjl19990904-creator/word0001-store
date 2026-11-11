// ============================================================================
// Shared template renderer used by every storefront route.
//
// Placeholders:
//   {{data:json:key}}   JSON payload for client-side rendering
//   {{settings.key}}    site settings (Chinese overrides applied automatically)
//   {{data.key}}        dotted access into the render payload
//   {{t:section.key}}   localized UI copy from locales/<locale>.json
//   {{> partial-name}}  server-side include from views/partials/
//   {{key}}             flat value from the render payload (locale, lang, ...)
// ============================================================================
const fs = require('fs');
const path = require('path');
const db = require('../db/init');
const i18n = require('./i18n');

function renderPage(res, templateName, data = {}) {
  const req = res.req;
  const locale = (req && req.locale) || i18n.DEFAULT_LOCALE;
  const settings = i18n.localizeSettings(db.getAllSettings(), locale);
  const t = (key, vars) => i18n.t(locale, key, vars);

  const currentPath = req ? String(req.originalUrl || '/').split('?')[0] : '/';
  const baseUrl = req ? i18n.getBaseUrl(req) : '';
  const urlFor = targetLocale => baseUrl + i18n.pathForLocale(targetLocale, currentPath);

  const merged = {
    ...data,
    settings,
    locale,
    lang: i18n.htmlLang(locale),
    langEnActive: locale === 'en' ? 'active' : '',
    langZhActive: locale === 'zh-CN' ? 'active' : '',
    // Switch links carry ?lang= so the choice is persisted in a cookie; the
    // middleware then redirects to the canonical clean URL for that locale.
    switchToEn: '?lang=en',
    switchToZh: '?lang=zh-CN',
    homeUrl: i18n.pathForLocale(locale, '/'),
    // Flat key -> text map for client-side rendering (window.I18N).
    clientDictionary: i18n.flatten(locale),
    canonicalUrl: urlFor(locale),
    altEnUrl: urlFor('en'),
    altZhUrl: urlFor('zh-CN')
  };

  const templatePath = path.join(__dirname, '..', 'views', templateName);
  if (!fs.existsSync(templatePath)) {
    return res.status(404).send('Template not found: ' + templateName);
  }

  let html = fs.readFileSync(templatePath, 'utf8');

  // Server-side includes: {{> lang-switcher}}
  html = html.replace(/\{\{>\s*([\w-]+)\s*\}\}/g, (match, name) => {
    const partialPath = path.join(__dirname, '..', 'views', 'partials', name + '.html');
    try {
      return fs.readFileSync(partialPath, 'utf8');
    } catch (error) {
      console.error('[render] Missing partial:', name);
      return '';
    }
  });

  // Localized UI copy: {{t:home.featured.title}}
  html = html.replace(/\{\{t:([\w.\-]+)\}\}/g, (match, key) => t(key));

  // Replace {{data:json:xxx}} with JSON stringified data
  html = html.replace(/\{\{data:json:(\w+)\}\}/g, (match, key) => {
    const val = merged[key];
    return val !== undefined ? JSON.stringify(val) : 'null';
  });

  // Replace {{settings.xxx}}
  html = html.replace(/\{\{settings\.(\w+)\}\}/g, (match, key) => {
    return settings[key] !== undefined ? String(settings[key]) : '';
  });

  // Replace {{data.xxx}}
  html = html.replace(/\{\{data\.(\w+(?:\.\w+)*)\}\}/g, (match, key) => {
    const parts = key.split('.');
    let val = merged;
    for (const part of parts) { val = val ? val[part] : undefined; }
    return val !== undefined && val !== null ? String(val) : '';
  });

  // Replace {{xxx}}
  html = html.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return merged[key] !== undefined ? String(merged[key]) : '';
  });

  res.send(html);
}

module.exports = renderPage;
