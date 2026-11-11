// ============================================================================
// Stripe account configuration lookup.
//
// Live credentials are only ever read from Render environment variables; the
// JSON database never stores secret keys. Everything in this module returns a
// server-side copy of the config and must never be serialized to a browser.
// ============================================================================
const db = require('../db/init');

function getStripeMode() {
  if (process.env.STRIPE_MODE === 'test' || process.env.STRIPE_MODE === 'live') return process.env.STRIPE_MODE;
  return process.env.NODE_ENV === 'production' ? 'live' : 'test';
}

function hasExpectedStripeKeys(config) {
  const mode = getStripeMode();
  const secretPrefix = mode === 'live' ? 'sk_live_' : 'sk_test_';
  const publishablePrefix = mode === 'live' ? 'pk_live_' : 'pk_test_';
  return Boolean(config.secret_key && config.secret_key.startsWith(secretPrefix) &&
    config.publishable_key && config.publishable_key.startsWith(publishablePrefix));
}

function parseConfig(account) {
  if (!account) return {};
  let config = {};
  if (typeof account.config === 'string') {
    try { config = JSON.parse(account.config || '{}'); } catch { config = {}; }
  } else if (account.config_data && typeof account.config_data === 'object') {
    config = account.config_data;
  }
  if (account.type === 'stripe') {
    config = {
      ...config,
      publishable_key: process.env.STRIPE_PUBLISHABLE_KEY || config.publishable_key || '',
      secret_key: process.env.STRIPE_SECRET_KEY || config.secret_key || '',
      webhook_secret: process.env.STRIPE_WEBHOOK_SECRET || config.webhook_secret || ''
    };
  }
  return config;
}

function getStripeAccounts(includeInactive = false) {
  // Keep the environment-managed Live Stripe default account available before
  // any payment, confirmation or webhook lookup.
  if (typeof db.ensureLiveStripeDefaultAccount === 'function') db.ensureLiveStripeDefaultAccount();
  const accounts = db.findAll('payment_accounts');
  return accounts.filter(account => {
    if (account.type !== 'stripe' || (!includeInactive && account.status !== 'active')) return false;
    const config = parseConfig(account);
    if (!hasExpectedStripeKeys(config)) return false;
    if (getStripeMode() === 'live' && !config.webhook_secret) return false;
    return true;
  }).map(account => ({ ...account, config_data: parseConfig(account) }));
}

function getStripeAccount(accountId, includeInactive = false) {
  const accounts = getStripeAccounts(includeInactive);
  if (accountId !== undefined && accountId !== null && accountId !== '') {
    return accounts.find(account => String(account.id) === String(accountId)) || null;
  }
  return accounts[0] || null;
}

module.exports = {
  getStripeMode,
  hasExpectedStripeKeys,
  parseConfig,
  getStripeAccounts,
  getStripeAccount
};
