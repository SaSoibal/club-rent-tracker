'use strict';
// OTP delivery. No SMS provider is connected yet.
// Production login stays disabled (HTTP 503) until an adapter is added to `adapters`
// and SMS_PROVIDER is set to its name. Each adapter is: async (phone, code) => void.
const adapters = {};

function smsReady() {
  return !!process.env.SMS_PROVIDER && typeof adapters[process.env.SMS_PROVIDER] === 'function';
}

async function sendOtp(phone, code) {
  return adapters[process.env.SMS_PROVIDER](phone, code);
}

module.exports = { adapters, smsReady, sendOtp };
