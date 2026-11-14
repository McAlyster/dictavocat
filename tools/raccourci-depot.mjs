#!/usr/bin/env node
// Écrit sur le dictaphone (ou tout autre dossier) un raccourci Windows « Envoyer mes dictées.url »
// qui ouvre la page de dépôt avec le jeton de l'avocate.
//
//   node tools/raccourci-depot.mjs /Volumes/<NOM_DU_DICTAPHONE> [--env .env.test]
//
// Lit PUBLIC_BASE_URL et UPLOAD_TOKEN dans le .env du projet (ou le fichier passé avec --env) : le jeton n'est jamais affiché.
// Le jeton ne permet que de déposer. En cas de perte du dictaphone, changez UPLOAD_TOKEN
// sur le serveur puis réécrivez le raccourci.
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const envIdx = args.indexOf('--env');
const envFile = envIdx >= 0 ? args.splice(envIdx, 2)[1] : '.env';
const target = args[0];
if (!target || !existsSync(target) || !statSync(target).isDirectory()) {
  console.error('Usage : node tools/raccourci-depot.mjs /Volumes/<NOM_DU_DICTAPHONE> [--env .env.test]');
  process.exit(1);
}
const env = Object.fromEntries(readFileSync(envFile, 'utf8').split(/\r?\n/)
  .filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const base = (env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const token = env.UPLOAD_TOKEN || '';
if (!/^https:\/\//.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base) || token.length < 32 || /replace/.test(token)) {
  console.error(`Renseignez d’abord PUBLIC_BASE_URL (https) et le vrai UPLOAD_TOKEN dans ${envFile}.`);
  process.exit(1);
}
if (/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(base)) {
  console.warn(`Attention : PUBLIC_BASE_URL vaut ${base}. Ce raccourci ne marchera que sur l'ordinateur qui fait tourner le serveur,`);
  console.warn('pas chez l\'avocate. Pour le kit, mettez dans .env l\'adresse publique et le jeton du serveur, puis relancez.');
}
const file = join(target, 'Envoyer mes dictées.url');
// Format « Internet Shortcut » de Windows, lignes en CRLF.
writeFileSync(file, `[InternetShortcut]\r\nURL=${base}/#upload=${token}\r\n`);
console.log(`Raccourci écrit : ${file}`);
console.log('Sur Mac, lancez ensuite : dot_clean ' + target + '  (supprime les fichiers « ._ » visibles sous Windows)');
