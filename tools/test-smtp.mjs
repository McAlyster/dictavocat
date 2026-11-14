#!/usr/bin/env node
// Vérifie la configuration SMTP du .env et envoie un e-mail de test à SECRETARY_EMAIL.
// Sur le VPS (l'image contient nodemailer) :
//   docker compose run --rm -v ./tools:/app/tools:ro dictavocat node tools/test-smtp.mjs
import nodemailer from 'nodemailer';

const env = process.env;
for (const key of ['SMTP_HOST', 'MAIL_FROM', 'SECRETARY_EMAIL']) {
  if (!env[key]) { console.error(`${key} manque dans .env`); process.exit(1); }
}
const transporter = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: Number(env.SMTP_PORT || 587),
  secure: env.SMTP_SECURE === 'true',
  auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD || '' } : undefined,
  tls: { minVersion: 'TLSv1.2' },
  connectionTimeout: 10_000
});
try {
  await transporter.verify();
  console.log(`Connexion et authentification OK (${env.SMTP_HOST}:${env.SMTP_PORT || 587})`);
  const info = await transporter.sendMail({
    from: env.MAIL_FROM,
    to: env.SECRETARY_EMAIL,
    subject: 'Dictavocat : e-mail de test',
    text: 'Si vous lisez ce message, les notifications de Dictavocat fonctionnent.\nVérifiez qu’il n’est pas arrivé dans les indésirables.'
  });
  console.log(`E-mail envoyé à ${env.SECRETARY_EMAIL} (réponse du serveur : ${info.response})`);
} catch (error) {
  console.error('Échec :', error.code || '', error.message);
  if (error.code === 'ETIMEDOUT' || error.code === 'ECONNREFUSED') console.error('→ port bloqué ou mauvais hôte/port (essayez 587 ou 465).');
  if (/wrong version number/i.test(error.message)) console.error('→ SMTP_SECURE ne correspond pas au port : 465 → SMTP_SECURE=true ; 587 → SMTP_SECURE=false.');
  if (error.code === 'EAUTH') console.error('→ identifiant ou mot de passe refusé.');
  process.exit(1);
}
