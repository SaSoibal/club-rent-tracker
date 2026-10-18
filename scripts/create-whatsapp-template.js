#!/usr/bin/env node
'use strict';
// One-time setup: create the WhatsApp "Authentication" template used for login codes.
// Run once, then wait for Meta to approve it (Business Manager → WhatsApp Manager → Message templates).
//
// Needs:
//   WHATSAPP_TOKEN                  access token with whatsapp_business_messaging / manage permissions
//   WHATSAPP_BUSINESS_ACCOUNT_ID    the WhatsApp Business Account ID (WABA), not the phone number ID
// Optional:
//   WHATSAPP_OTP_TEMPLATE (default club_login_otp), WHATSAPP_API_VERSION (default v26.0)
//
// Usage:  WHATSAPP_TOKEN=... WHATSAPP_BUSINESS_ACCOUNT_ID=... node scripts/create-whatsapp-template.js

const version = process.env.WHATSAPP_API_VERSION || 'v26.0';
const waba = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
const token = process.env.WHATSAPP_TOKEN;
if (!waba || !token) {
  console.error('Set WHATSAPP_TOKEN and WHATSAPP_BUSINESS_ACCOUNT_ID first.');
  process.exit(1);
}

// Meta writes the body text ("{{1}} is your verification code.") for authentication templates.
// We only choose the security line, the expiry footer and the copy-code button.
const template = {
  name: process.env.WHATSAPP_OTP_TEMPLATE || 'club_login_otp',
  language: process.env.WHATSAPP_OTP_LANGUAGE || 'en',
  category: 'authentication',
  components: [
    { type: 'body', add_security_recommendation: true },
    { type: 'footer', code_expiration_minutes: 5 },
    { type: 'buttons', buttons: [{ type: 'otp', otp_type: 'copy_code', text: 'Copy code' }] }
  ]
};

(async () => {
  const r = await fetch(`https://graph.facebook.com/${version}/${waba}/message_templates`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(template)
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error('Meta rejected the template:', JSON.stringify(json.error || json));
    process.exit(1);
  }
  console.log(`Template "${template.name}" submitted (id ${json.id}, status ${json.status || 'PENDING'}).`);
  console.log('Wait for approval, then set WHATSAPP_OTP_TEMPLATE to the same name in Render.');
})();
