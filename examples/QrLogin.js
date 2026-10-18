'use strict';

// Log in by scanning a QR code with the Discord mobile app.
// No token required: the session is authorised from the phone.

const { DiscordAuthWebsocket } = require('../src/index');

const auth = new DiscordAuthWebsocket();

auth.on('ready', () => {
  console.log('Scan this QR code with your Discord mobile app:');
  // Prints the QR code directly in the terminal.
  auth.generateQR();
});

auth.on('pending', user => {
  console.log(`Login requested by ${user.username} (${user.id})`);
});

auth.on('finish', token => {
  // NEVER log the token itself — it is the full account credential.
  process.env.DISCORD_TOKEN = token;
  // The token can now be used with Client#login, for example:
  // client.login(process.env.DISCORD_TOKEN);
});

auth.on('cancel', () => {
  console.log('Login cancelled from the phone.');
});

auth.on('error', error => {
  console.error('QR login error:', error);
});

auth.connect();
