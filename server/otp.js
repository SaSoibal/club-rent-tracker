'use strict';
// OTP delivery. The provider is selected with OTP_PROVIDER:
//   whatsapp   (default, recommended) WhatsApp Cloud API, Authentication template
//   bulksmsbd  SMS through BulkSMS BD
// If the provider is not configured, sign-in is refused (HTTP 503) instead of failing silently.

const GRAPH_VERSION = () => process.env.WHATSAPP_API_VERSION || 'v26.0';

const providers = {
  whatsapp: {
    ready: () => !!process.env.WHATSAPP_TOKEN && !!process.env.WHATSAPP_PHONE_NUMBER_ID && !!process.env.WHATSAPP_OTP_TEMPLATE,
    send: async (phone, code) => {
      const url = `https://graph.facebook.com/${GRAPH_VERSION()}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
      const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: toDigits(phone),
        type: 'template',
        template: {
          name: process.env.WHATSAPP_OTP_TEMPLATE,
          language: { code: process.env.WHATSAPP_OTP_LANGUAGE || 'en' },
          components: [
            // Authentication templates: the code goes in the body and in the copy-code button.
            { type: 'body', parameters: [{ type: 'text', text: code }] },
            { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] }
          ]
        }
      };
      const r = await fetch(url, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + process.env.WHATSAPP_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error('WhatsApp rejected the message: ' + ((json.error && json.error.message) || r.status));
      return (json.messages && json.messages[0] && json.messages[0].id) || null;
    }
  },

  bulksmsbd: {
    ready: () => !!process.env.BULKSMS_API_KEY && !!process.env.BULKSMS_SENDER_ID,
    send: async (phone, code) => {
      const body = new URLSearchParams({
        api_key: process.env.BULKSMS_API_KEY,
        senderid: process.env.BULKSMS_SENDER_ID,
        number: toMsisdn(phone),
        message: `Your Club Rent code is ${code}. It expires in 5 minutes. Do not share it.`
      });
      const r = await fetch('https://bulksmsbd.net/api/smsapi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
      });
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch (e) { /* plain text reply */ }
      if (!r.ok || (json && json.response_code !== undefined && Number(json.response_code) !== 202)) {
        throw new Error('SMS provider rejected the message: ' + text.slice(0, 200));
      }
    }
  }
};

// 01XXXXXXXXX -> 8801XXXXXXXXX (digits only, as WhatsApp and BulkSMS expect)
function toDigits(phone) { return '880' + String(phone).replace(/^0/, ''); }
const toMsisdn = toDigits;

function activeProvider() {
  return providers[process.env.OTP_PROVIDER || 'whatsapp'] || null;
}

function otpReady() {
  const p = activeProvider();
  return !!p && p.ready();
}

async function sendOtp(phone, code) {
  const p = activeProvider();
  if (!p || !p.ready()) throw new Error('OTP provider is not configured');
  return p.send(phone, code);
}

module.exports = { otpReady, sendOtp, toDigits, toMsisdn, providers };
