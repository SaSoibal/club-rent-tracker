'use strict';
// OTP delivery through an SMS provider. Selected with SMS_PROVIDER.
// If the provider is not configured, sign-in is refused (HTTP 503) instead of failing silently.

// BulkSMS BD single-message API: https://bulksmsbd.net/api/smsapi
// Parameters: api_key, senderid, number (880XXXXXXXXXX), message.
const providers = {
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
      // Treat the send as failed on a non-2xx status or a provider error code.
      if (!r.ok || (json && json.response_code !== undefined && Number(json.response_code) !== 202)) {
        throw new Error('SMS provider rejected the message: ' + text.slice(0, 200));
      }
    }
  }
};

// 01XXXXXXXXX -> 8801XXXXXXXXX
function toMsisdn(phone) {
  return '880' + String(phone).replace(/^0/, '');
}

function activeProvider() {
  return providers[process.env.SMS_PROVIDER] || null;
}

function smsReady() {
  const p = activeProvider();
  return !!p && p.ready();
}

async function sendOtp(phone, code) {
  const p = activeProvider();
  if (!p || !p.ready()) throw new Error('SMS provider is not configured');
  return p.send(phone, code);
}

module.exports = { smsReady, sendOtp, toMsisdn };
