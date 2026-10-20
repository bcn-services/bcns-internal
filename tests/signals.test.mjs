import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PLATFORMS, SIGNAL_KEYS, evidence, detectSignals, countSignals } from '../lib/signals.mjs'

// One real-looking snippet per platform. The coverage test below fails when a
// platform is added to the table without a sample here.
const SAMPLES = {
  store: {
    shopify: '<script src="https://cdn.shopify.com/s/files/1/0001/theme.js"></script>',
    woocommerce: '<link href="/wp-content/plugins/woocommerce/assets/css/woocommerce.css">',
    bigcommerce: '<script src="https://cdn11.bigcommerce.com/s-abc/stencil/app.js"></script>',
    squareOnline: '<a href="https://acme.square.site/product/widget">Order</a>',
    toast: '<a href="https://order.toasttab.com/online/acme">Order online</a>',
    squarespaceCommerce: '<div class="sqs-add-to-cart-button">Add to cart</div>',
    wixStores: '<script>window.wixStores = {}</script><div data-hook="wixstores-product"></div>',
  },
  booking: {
    calendly: '<iframe src="https://calendly.com/acme/30min"></iframe>',
    acuity: '<iframe src="https://app.acuityscheduling.com/schedule.php?owner=1"></iframe>',
    jane: '<a href="https://acme.janeapp.com/">Book</a>',
    mindbody: '<script src="https://widgets.mindbodyonline.com/javascripts/healcode.js"></script>',
    squareAppointments: '<a href="https://squareup.com/appointments/book/abc">Book</a>',
    housecall: '<a href="https://book.housecallpro.com/book/acme">Book</a>',
    clientPortal: '<a href="/login">Client Login</a>',
  },
  payments: {
    quickbooks: '<a href="https://quickbooks.intuit.com/pay/abc">Pay</a>',
    stripe: '<script src="https://js.stripe.com/v3/"></script>',
    squareInvoices: '<a href="https://squareup.com/pay-invoice/abc">Pay</a>',
    billcom: '<a href="https://app.bill.com/pay/abc">Pay</a>',
    payOnline: '<a href="/pay">Pay online</a>',
  },
  marketing: {
    metaPixel: "<script>fbq('init','123');fbq('track','PageView')</script>",
    googleTag: '<script async src="https://www.googletagmanager.com/gtag/js?id=G-1"></script>',
    hubspot: '<script src="//js.hs-scripts.com/123.js"></script>',
    mailchimp: '<script src="https://chimpstatic.com/mcjs-connected/js/users/x.js"></script>',
    klaviyo: '<script src="https://static.klaviyo.com/onsite/js/klaviyo.js"></script>',
    social: '<a href="https://www.instagram.com/acmeroofing">IG</a>',
  },
}

for (const key of SIGNAL_KEYS) {
  for (const name of Object.keys(PLATFORMS[key])) {
    test(`${key}/${name} is fingerprinted from raw html and sets only its own signal`, () => {
      const html = `<html><body>${SAMPLES[key][name]}</body></html>`
      assert.ok(evidence(html)[key].includes(name), `${name} not detected`)
      assert.equal(detectSignals(html)[key], true)
      for (const other of SIGNAL_KEYS.filter((k) => k !== key)) {
        assert.equal(detectSignals(html)[other], false, `${name} also set ${other}`)
      }
    })
  }
}

test('every platform in the table has a sample, and no sample is orphaned', () => {
  for (const key of SIGNAL_KEYS) {
    assert.deepEqual(Object.keys(SAMPLES[key]).sort(), Object.keys(PLATFORMS[key]).sort(), key)
  }
})

test('a plain brochure page has no signals; a pixel in a script is seen because the html is raw', () => {
  const plain = '<html><body><h1>Acme</h1><p>We fix roofs. Call us.</p></body></html>'
  assert.deepEqual(detectSignals(plain), { store: false, booking: false, payments: false, marketing: false })
  assert.equal(countSignals(detectSignals(plain)), 0)
  assert.equal(detectSignals('<script>fbq("init","1")</script>').marketing, true)
  assert.deepEqual(detectSignals(undefined), { store: false, booking: false, payments: false, marketing: false })
})

test('countSignals counts true values only', () => {
  assert.equal(countSignals({ store: true, booking: true, payments: false, marketing: 'yes' }), 2)
  assert.equal(countSignals(null), 0)
})
