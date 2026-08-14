const { initializeApp, cert } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const config = require('./config');
const serviceAccount = require('./bed-exit-alert-firebase-adminsdk-fbsvc-b909edf899.json');

const firebaseApp = initializeApp({
  credential: cert(serviceAccount),
  databaseURL: config.FIREBASE_DATABASE_URL
});

module.exports = { db: getDatabase(firebaseApp) };
