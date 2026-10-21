// Fit signals, fingerprinted from RAW HTML (not trimmed text: pixels, widgets
// and checkout links live in <script>/<iframe>/<a href>, which `trim` removes).
// Code is the authority on a signal; whatever the model claims about the same
// four signals is recorded for debugging but never counts toward the gate.
//
// One regex per platform, grouped under the four signals of the bcns Connect
// niche: a business that sells online, books online, takes payment online and
// markets online has the manual back-office work Connect replaces.

export const PLATFORMS = {
  // (1) store / ordering platform
  store: {
    shopify: /cdn\.shopify\.com|\.myshopify\.com|Shopify\.theme/i,
    woocommerce: /woocommerce/i,
    bigcommerce: /bigcommerce\.com|mybigcommerce\.com/i,
    squareOnline: /square\.site|squareup\.com\/store|weeblycloud\.com/i,
    toast: /toasttab\.com|toast-order/i,
    squarespaceCommerce: /sqs-add-to-cart|squarespace-commerce|commerce\.squarespace\.com|sqs-money-native/i,
    wixStores: /wixstores|stores\.wix|ecom\.wix|wix-ecommerce/i,
  },
  // (2) booking / scheduling widget or client portal
  booking: {
    calendly: /calendly\.com/i,
    acuity: /acuityscheduling\.com|as\.me\//i,
    jane: /janeapp\.com/i,
    mindbody: /mindbodyonline\.com|healcode\.com/i,
    squareAppointments: /squareup\.com\/appointments|square\.site\/appointments/i,
    housecall: /housecallpro\.com/i,
    clientPortal: /\b(client|customer|patient|member)\s*[- ]?(log\s?in|login|portal)\b|\bportal\s+log\s?in\b/i,
  },
  // (3) accounting / payments
  payments: {
    quickbooks: /quickbooks\.intuit\.com|intuit\.com\/pay|qbo\.intuit\.com/i,
    stripe: /js\.stripe\.com|buy\.stripe\.com|checkout\.stripe\.com|stripe\.com\/b\//i,
    squareInvoices: /squareup\.com\/(pay-invoice|pay|checkout)|squareup\.com\/invoice/i,
    billcom: /bill\.com\/(pay|login)|app\.bill\.com/i,
    payOnline: /\bpay\s+(your\s+)?(invoice\s+|bill\s+)?online\b|\bpay\s+now\b|\bonline\s+payments?\b/i,
  },
  // (4) marketing tooling
  marketing: {
    metaPixel: /connect\.facebook\.net\/[^"']*fbevents|\bfbq\s*\(/i,
    googleTag: /googletagmanager\.com|google-analytics\.com|\bgtag\s*\(|googleadservices\.com/i,
    hubspot: /hs-scripts\.com|hsforms\.(net|com)|js\.hs-analytics\.net/i,
    mailchimp: /list-manage\.com|chimpstatic\.com|mailchimp\.com/i,
    klaviyo: /klaviyo\.com/i,
    social: /(instagram|facebook)\.com\/(?!tr\b|sharer|plugins|dialog)[a-z0-9._-]{2,}/i,
  },
}

export const SIGNAL_KEYS = Object.keys(PLATFORMS)

// { store: ['shopify'], booking: [], ... } — the platforms that matched.
export function evidence(html) {
  const text = typeof html === 'string' ? html : ''
  return Object.fromEntries(
    SIGNAL_KEYS.map((key) => [
      key,
      Object.entries(PLATFORMS[key]).filter(([, re]) => re.test(text)).map(([name]) => name),
    ])
  )
}

// { store: true, booking: false, payments: false, marketing: true }
export function detectSignals(html) {
  return Object.fromEntries(Object.entries(evidence(html)).map(([key, hits]) => [key, hits.length > 0]))
}

export const countSignals = (signals) => SIGNAL_KEYS.filter((k) => signals?.[k] === true).length
