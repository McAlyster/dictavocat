import { Encrypter, Decrypter } from 'age-encryption';
import { zipSync, unzipSync } from 'fflate';
import './style.css';

const app = document.querySelector('#app');
const path = window.location.pathname;
const params = new URLSearchParams(window.location.hash.slice(1));
const isDownload = path.startsWith('/download/');
const downloadId = isDownload ? path.split('/').pop() : null;
const UPLOAD_KEY = 'dictavocat-upload-token';

// The upload link is remembered on this computer, so that a refresh or a bookmark made
// after the address bar is cleaned keeps working. The download token survives a refresh
// for this tab only.
let uploadToken = params.get('upload');
let downloadToken = params.get('t');
try {
  if (!isDownload) {
    if (uploadToken) localStorage.setItem(UPLOAD_KEY, uploadToken);
    else uploadToken = localStorage.getItem(UPLOAD_KEY);
  } else if (downloadId) {
    if (downloadToken) sessionStorage.setItem(`dl-${downloadId}`, downloadToken);
    else downloadToken = sessionStorage.getItem(`dl-${downloadId}`);
  }
} catch { /* storage unavailable: the link still works for this page view */ }
// Remove bearer tokens from the address bar and browser history immediately.
if (params.has('upload') || params.has('t')) history.replaceState(null, '', path);

// Without this, a file dropped next to the drop zone makes the browser leave the page.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

let officeName = 'Dictées du cabinet';
let supportContact = '';
const help = () => (supportContact ? `Appelez l’assistance : ${escapeHtml(supportContact)}.` : 'Appelez l’assistance.');

// ---------- small helpers ----------

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

const icons = {
  lock: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10V7a5 5 0 0 1 10 0v3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><rect x="4.5" y="10" width="15" height="11" rx="2.5" fill="currentColor"/></svg>',
  upload: '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M24 31V9m0 0-9 9m9-9 9 9" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 30v6a4 4 0 0 0 4 4h22a4 4 0 0 0 4-4v-6" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"/></svg>',
  audio: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="2.5" width="8" height="12" rx="4" fill="currentColor"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  doc: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2.5h8l5 5V20a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 20V4a1.5 1.5 0 0 1 1-1.5Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M14 2.5V8h5M8.5 13h7M8.5 17h7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  check: '<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="30" fill="currentColor"/><path d="m19 33 9 9 17-19" fill="none" stroke="#fff" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  warn: '<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="30" fill="currentColor"/><path d="M32 17v20" stroke="#fff" stroke-width="6" stroke-linecap="round"/><circle cx="32" cy="47" r="3.6" fill="#fff"/></svg>',
  key: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="15" r="4.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="m11.5 12 8-8m-3 3 2.5 2.5M14 9.5l2 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
};

const AUDIO_EXT = /\.(mp3|m4a|wav|aiff?|aac|ogg|opus|wma|amr|dss|ds2|flac)$/i;
function fileIcon(name) { return AUDIO_EXT.test(name) ? `<span class="file-icon audio">${icons.audio}</span>` : `<span class="file-icon doc">${icons.doc}</span>`; }

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.ceil(bytes / 1024))} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} Mo`;
}
function plural(n, word) { return `${n} ${word}${n > 1 ? 's' : ''}`; }

function page(kind, content, foot) {
  document.body.className = kind;
  document.body.ondrop = null;
  app.innerHTML = `
    <main class="page">
      <header class="top">
        <span class="brand">${escapeHtml(officeName)}</span>
        <span class="secure">${icons.lock}Confidentiel</span>
      </header>
      <section class="card">${content}</section>
      ${foot ? `<p class="foot">${foot}</p>` : ''}
    </main>`;
  const heading = app.querySelector('h1');
  if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function stamp(date = new Date()) {
  return date.toLocaleString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}

function guardLeaving(on) {
  window.onbeforeunload = on ? (e) => { e.preventDefault(); e.returnValue = ''; } : null;
}

async function loadConfig() {
  // The support contact is only sent back to a visitor holding a valid link.
  const token = isDownload ? downloadToken : uploadToken;
  const query = isDownload && downloadId ? `?id=${encodeURIComponent(downloadId)}` : '';
  const response = await fetch(`/api/config${query}`, { cache: 'no-store', headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!response.ok) throw new Error('Le service est momentanément indisponible. Réessayez dans quelques minutes.');
  const config = await response.json();
  if (config.officeName) officeName = config.officeName;
  if (config.supportContact) supportContact = config.supportContact;
  document.title = officeName;
  return config;
}

// ---------- lawyer side: sending files ----------

const ACCEPT = '.mp3,.m4a,.wav,.aif,.aiff,.aac,.ogg,.opus,.wma,.amr,.dss,.ds2,.flac,.pdf,.jpg,.jpeg,.png,audio/*,application/pdf';

async function uploadPage() {
  let config;
  try { config = await loadConfig(); }
  catch (e) { page('upload', `<div class="result">${icons.warn}<h1>Service indisponible</h1><p class="lead">${escapeHtml(e.message)}</p></div>`); return; }

  if (!uploadToken) {
    page('upload', `<h1>Bienvenue</h1><p class="lead">Pour envoyer vos dictées, branchez le dictaphone et double-cliquez sur « Envoyer mes dictées ».</p>`);
    return;
  }

  let files = [];

  function addFiles(list) {
    for (const file of list) {
      if (!file.size) continue;
      if (!files.some((f) => f.name === file.name && f.size === file.size && f.lastModified === file.lastModified)) files.push(file);
    }
    renderPick();
  }

  function renderPick(message = '') {
    const total = files.reduce((n, f) => n + f.size, 0);
    const tooBig = total > config.maxUploadBytes;
    const list = files.map((f, i) => `
      <li class="file">${fileIcon(f.name)}
        <span class="file-name">${escapeHtml(f.name)}</span>
        <span class="file-size">${formatBytes(f.size)}</span>
        <button type="button" class="remove" data-i="${i}" aria-label="Retirer ${escapeHtml(f.name)}">Retirer</button>
      </li>`).join('');

    page('upload', `
      <h1>Envoyer des dictées</h1>
      <p class="lead">${files.length ? 'Vérifiez la liste, puis appuyez sur le bouton vert.' : 'Ajoutez vos enregistrements et vos documents.'}</p>
      <div class="drop ${files.length ? 'compact' : ''}" id="drop">
        ${files.length ? '' : `<span class="drop-icon">${icons.upload}</span><p class="drop-title">Glissez vos fichiers ici</p><p class="drop-or">ou</p>`}
        <button type="button" class="btn ${files.length ? 'btn-ghost' : 'btn-secondary btn-big'}" id="choose">${files.length ? '+ Ajouter d’autres fichiers' : 'Choisir les fichiers'}</button>
        <input id="files" type="file" multiple accept="${ACCEPT}" hidden>
      </div>
      ${files.length ? `<ul class="files" aria-label="Fichiers à envoyer">${list}</ul>
        <p class="total ${tooBig ? 'error' : ''}">${tooBig
          ? `C’est trop volumineux pour un seul envoi (${formatBytes(total)}, maximum ${formatBytes(config.maxUploadBytes)}). Retirez des fichiers et envoyez-les en deux fois.`
          : `${plural(files.length, 'fichier')} · ${formatBytes(total)}`}</p>
        <button type="button" class="btn btn-primary btn-big" id="send" ${tooBig ? 'disabled' : ''}>Envoyer ${files.length > 1 ? `les ${files.length} fichiers` : 'le fichier'}</button>` : ''}
      <div id="status" class="status error" role="alert">${escapeHtml(message)}</div>`,
      'Confidentiel : seule votre secrétaire pourra ouvrir ces fichiers.');

    const input = document.querySelector('#files');
    document.querySelector('#choose').addEventListener('click', () => input.click());
    input.addEventListener('change', () => addFiles(input.files));
    const drop = document.querySelector('#drop');
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    document.body.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files); };
    for (const btn of document.querySelectorAll('.remove')) {
      btn.addEventListener('click', () => { files.splice(Number(btn.dataset.i), 1); renderPick(); });
    }
    document.querySelector('#send')?.addEventListener('click', send);
  }

  function renderProgress(step, value) {
    if (!document.querySelector('#progress')) {
      page('upload', `
        <h1>Envoi en cours…</h1>
        <p class="lead">Ne fermez pas cette page.</p>
        <progress id="progress" max="100" value="0"></progress>
        <p id="step" class="step" aria-live="polite"></p>`);
    }
    document.querySelector('#progress').value = value;
    document.querySelector('#step').textContent = step;
  }

  function post(body, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/uploads');
      xhr.setRequestHeader('Authorization', `Bearer ${uploadToken}`);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        let result = {};
        try { result = JSON.parse(xhr.responseText); } catch { /* not JSON (proxy error page) */ }
        resolve({ status: xhr.status, result });
      };
      xhr.onerror = () => reject(new Error('NETWORK'));
      xhr.send(body);
    });
  }

  async function send() {
    const names = files.map((f) => f.name);
    guardLeaving(true);
    try {
      renderProgress('Préparation des fichiers…', 2);
      // Read local files and build an uncompressed ZIP; encryption stays in this browser.
      const entries = {};
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const safeName = file.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 180) || `fichier-${i + 1}`;
        entries[`${String(i + 1).padStart(3, '0')}_${safeName}`] = new Uint8Array(await file.arrayBuffer());
        renderProgress('Préparation des fichiers…', 2 + Math.round(8 * (i + 1) / files.length));
      }
      const archive = zipSync(entries, { level: 0 });
      renderProgress('Protection des fichiers…', 12);
      const encrypter = new Encrypter();
      encrypter.addRecipient(config.recipient);
      const encrypted = await encrypter.encrypt(archive);
      if (encrypted.byteLength > config.maxUploadBytes) throw new Error('TOO_BIG');
      renderProgress('Envoi…', 15);
      const { status, result } = await post(encrypted, (ratio) => {
        renderProgress(ratio < 1 ? `Envoi… ${Math.round(ratio * 100)} %` : 'Finalisation…', 15 + Math.round(ratio * 83));
      });
      if (status === 401) throw new Error('BAD_LINK');
      if (status === 413) throw new Error('TOO_BIG');
      if (status < 200 || status >= 300) throw new Error(result.error || 'SERVER');
      guardLeaving(false);
      renderDone(names, result.notificationSent);
    } catch (error) {
      guardLeaving(false);
      if (error.message === 'BAD_LINK') {
        try { localStorage.removeItem(UPLOAD_KEY); } catch { /* ignore */ }
        page('upload', `<div class="result">${icons.warn}<h1>Ce raccourci ne fonctionne plus</h1><p class="lead">Vos dictées n’ont pas été envoyées. ${help()}</p></div>`);
        return;
      }
      const message = error.message === 'NETWORK' ? 'La connexion Internet semble interrompue. Vérifiez-la, puis appuyez de nouveau sur « Envoyer ». Vos fichiers sont toujours dans la liste.'
        : error.message === 'TOO_BIG' ? 'L’envoi est trop volumineux. Retirez un ou deux fichiers et envoyez-les séparément.'
        : error.message === 'SERVER' ? `L’envoi n’a pas abouti. Appuyez de nouveau sur « Envoyer ». Si cela se reproduit : ${help()}`
        : `${error.message} Appuyez de nouveau sur « Envoyer ».`;
      renderPick(message);
    }
  }

  function renderDone(names, notified) {
    const list = names.map((n) => `<li class="file">${fileIcon(n)}<span class="file-name">${escapeHtml(n)}</span></li>`).join('');
    page('upload', `
      <div class="result ${notified ? 'ok' : 'warn'}">
        ${notified ? icons.check : icons.warn}
        <h1>${notified ? 'C’est envoyé' : 'Fichiers bien reçus'}</h1>
        <p class="lead">${notified
          ? 'Votre secrétaire a été prévenue.'
          : 'Vos dictées sont bien arrivées, mais le message pour votre secrétaire n’est pas parti. <strong>Prévenez-la par téléphone.</strong>'}</p>
        <p class="when">Le ${escapeHtml(stamp())}</p>
      </div>
      <ul class="files done" aria-label="Fichiers envoyés">${list}</ul>
      <button type="button" class="btn btn-secondary btn-big" id="again">Envoyer d’autres fichiers</button>`);
    document.querySelector('#again').addEventListener('click', () => { files = []; renderPick(); });
  }

  renderPick();
}

// ---------- secretary side: opening a deposit ----------

// Reads the secretary's key file: either a passphrase-protected identity (made by
// tools/generer-cle.mjs) or a plain age-keygen identity. Nothing leaves the browser.
async function readIdentity(file, passphrase) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text;
  if (new TextDecoder().decode(bytes.subarray(0, 21)) === 'age-encryption.org/v1') {
    if (!passphrase) throw new Error('Tapez votre mot de passe.');
    // Tolerate the usual typing slips: capital letters, spaces instead of dashes.
    const typed = passphrase.trim();
    const variants = [...new Set([typed, typed.toLowerCase(), typed.toLowerCase().replace(/[\s_]+/g, '-')])];
    for (const candidate of variants) {
      const decrypter = new Decrypter();
      decrypter.addPassphrase(candidate);
      try { text = await decrypter.decrypt(bytes, 'text'); break; } catch { /* try next variant */ }
    }
    if (!text) throw new Error('Mot de passe incorrect. Vérifiez-le (les mots sont séparés par des tirets) et réessayez.');
  } else {
    text = new TextDecoder().decode(bytes);
  }
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith('AGE-SECRET-KEY-'));
  if (!line) throw new Error('Ce fichier n’est pas votre clé d’accès. Choisissez « cle-dictavocat.age ».');
  return line;
}

const MIME = { pdf: 'application/pdf', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };

async function downloadPage() {
  await loadConfig().catch(() => {});
  if (!downloadId || !downloadToken) {
    page('download', `<h1>Lien incomplet</h1><p class="lead">Ouvrez le lien de l’e-mail « Nouvelles dictées à récupérer » en cliquant directement dessus.</p>`);
    return;
  }
  let keyFile = null;

  page('download', `
    <h1>De nouvelles dictées vous attendent</h1>
    <p class="lead">Pour les récupérer :</p>
    <form id="open-form" novalidate>
      <ol class="steps">
        <li>
          <span class="num">1</span>
          <div class="step-body">
            <p class="step-title">Votre clé d’accès</p>
            <button type="button" class="btn btn-secondary" id="pick-key">${icons.key}Choisir la clé d’accès</button>
            <input id="key" type="file" hidden>
            <p class="hint" id="key-name">Il s’appelle « cle-dictavocat.age » et se trouve dans vos Documents.</p>
          </div>
        </li>
        <li>
          <span class="num">2</span>
          <div class="step-body">
            <label class="step-title" for="pass">Votre mot de passe</label>
            <div class="pass-row">
              <input id="pass" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="mot-mot-mot-…">
              <button type="button" class="btn-ghost" id="toggle" aria-pressed="false">Afficher</button>
            </div>
          </div>
        </li>
        <li>
          <span class="num">3</span>
          <div class="step-body"><button type="submit" class="btn btn-primary btn-big" id="open">Récupérer les dictées</button></div>
        </li>
      </ol>
      <div id="status" class="status" role="alert"></div>
    </form>
    <details class="advanced"><summary>Réservé à l’assistance</summary>
      <p>Télécharger le fichier encore verrouillé, pour l’ouvrir avec l’outil <code>age</code>.</p>
      <button id="raw" type="button" class="btn btn-ghost">Télécharger le fichier verrouillé</button>
    </details>`,
    'Votre clé d’accès et votre mot de passe ne quittent pas cet ordinateur.');

  const status = document.querySelector('#status');
  const setStatus = (cls, html) => { status.className = `status ${cls}`; status.innerHTML = html; };
  const keyInput = document.querySelector('#key');
  const pass = document.querySelector('#pass');
  const lock = (on) => document.querySelectorAll('#open, #raw, #pick-key').forEach((b) => { b.disabled = on; });

  document.querySelector('#pick-key').addEventListener('click', () => keyInput.click());
  keyInput.addEventListener('change', () => {
    keyFile = keyInput.files[0] || null;
    const label = document.querySelector('#key-name');
    label.className = keyFile ? 'hint chosen' : 'hint';
    label.textContent = keyFile ? `✓ ${keyFile.name}` : 'Il s’appelle « cle-dictavocat.age » et se trouve dans vos Documents.';
    if (keyFile) pass.focus();
  });
  document.querySelector('#toggle').addEventListener('click', (e) => {
    const show = pass.type === 'password';
    pass.type = show ? 'text' : 'password';
    e.currentTarget.textContent = show ? 'Masquer' : 'Afficher';
    e.currentTarget.setAttribute('aria-pressed', String(show));
  });

  async function fetchDeposit(onProgress) {
    const response = await fetch('/api/download', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: downloadId, token: downloadToken }), cache: 'no-store'
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || 'Ce lien a expiré ou n’est plus utilisable. Demandez un nouvel envoi des dictées.');
    }
    const total = Number(response.headers.get('content-length')) || 0;
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (total) onProgress(received / total);
    }
    const out = new Uint8Array(received);
    let offset = 0;
    for (const c of chunks) { out.set(c, offset); offset += c.length; }
    return out;
  }

  function progressUI(text, value) {
    setStatus('muted', `<progress max="100" value="${value}"></progress><span>${escapeHtml(text)}</span>`);
  }

  document.querySelector('#open-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!keyFile) { setStatus('error', 'Commencez par choisir votre clé d’accès (étape 1).'); return; }
    if (!pass.value.trim()) { setStatus('error', 'Tapez votre mot de passe (étape 2).'); pass.focus(); return; }
    lock(true);
    let encrypted = null;
    try {
      // Check the key and passphrase BEFORE downloading, so a typo does not use up a download.
      progressUI('Vérification du mot de passe… (quelques secondes)', 5);
      const identity = await readIdentity(keyFile, pass.value);
      progressUI('Téléchargement…', 15);
      encrypted = await fetchDeposit((r) => progressUI(`Téléchargement… ${Math.round(r * 100)} %`, 15 + Math.round(r * 75)));
      progressUI('Ouverture…', 95);
      const decrypter = new Decrypter();
      decrypter.addIdentity(identity);
      let archive;
      try { archive = await decrypter.decrypt(encrypted); }
      catch { throw new Error('WRONG_KEY'); }
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const zipName = `dictees-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}h${pad(d.getMinutes())}.zip`;
      saveBlob(new Blob([archive], { type: 'application/zip' }), zipName);
      let contents = [];
      try { contents = Object.entries(unzipSync(archive)).filter(([n]) => !n.endsWith('/')); } catch { /* keep the ZIP only */ }
      renderOpened(zipName, contents);
    } catch (error) {
      if (error.message === 'WRONG_KEY' && encrypted) {
        saveBlob(new Blob([encrypted]), 'dictees.age');
        setStatus('error', `Ces dictées ne s’ouvrent pas avec cette clé d’accès. Le fichier verrouillé « dictees.age » a été enregistré dans Téléchargements. ${help()}`);
      } else {
        setStatus('error', escapeHtml(error.message));
        lock(false);
      }
    }
  });

  document.querySelector('#raw').addEventListener('click', async () => {
    lock(true);
    try {
      saveBlob(new Blob([await fetchDeposit((r) => progressUI(`Téléchargement… ${Math.round(r * 100)} %`, Math.round(r * 100)))]), 'dictees.age');
      setStatus('success', 'Téléchargement terminé. Le fichier est encore verrouillé.');
    } catch (error) {
      setStatus('error', escapeHtml(error.message));
      lock(false);
    }
  });

  function renderOpened(zipName, contents) {
    const items = contents.map(([name, data], i) => {
      const clean = name.replace(/^\d{3}_/, '');
      return `<li class="file">${fileIcon(clean)}<span class="file-name">${escapeHtml(clean)}</span><span class="file-size">${formatBytes(data.length)}</span><button type="button" class="save" data-i="${i}">Enregistrer</button></li>`;
    }).join('');
    page('download', `
      <div class="result ok">${icons.check}
        <h1>Dictées récupérées</h1>
        <p class="lead">${contents.length ? `${plural(contents.length, 'fichier')}. ` : ''}Une copie complète a été enregistrée dans <strong>Téléchargements</strong>&nbsp;: <strong>${escapeHtml(zipName)}</strong>.</p>
      </div>
      ${contents.length ? `<p class="sub">Vous pouvez aussi enregistrer les fichiers un par un&nbsp;:</p><ul class="files">${items}</ul>` : ''}`,
      'Gardez l’e-mail jusqu’à avoir vérifié les fichiers : son lien peut servir deux fois.');
    for (const btn of document.querySelectorAll('.save')) {
      btn.addEventListener('click', () => {
        const [name, data] = contents[Number(btn.dataset.i)];
        const clean = name.replace(/^\d{3}_/, '');
        saveBlob(new Blob([data], { type: MIME[clean.split('.').pop().toLowerCase()] || 'application/octet-stream' }), clean);
        btn.textContent = 'Enregistré ✓';
      });
    }
  }
}

if (isDownload) downloadPage();
else uploadPage();
