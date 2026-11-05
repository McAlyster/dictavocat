import { Encrypter } from 'age-encryption';
import { zipSync } from 'fflate';
import './style.css';

const app = document.querySelector('#app');
const path = window.location.pathname;
const params = new URLSearchParams(window.location.hash.slice(1));
const uploadToken = params.get('upload');
const downloadToken = params.get('t');
const downloadId = path.startsWith('/download/') ? path.split('/').pop() : null;

// Remove bearer tokens from the address bar and browser history immediately.
if (uploadToken || downloadToken) history.replaceState(null, '', path);

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

function shell(title, content) {
  app.innerHTML = `<main class="card"><div class="brand">Dépôt sécurisé</div><h1>${title}</h1>${content}<p class="foot">Les fichiers sont chiffrés dans votre navigateur avant leur envoi.</p></main>`;
}

async function loadConfig() {
  const response = await fetch('/api/config', { cache: 'no-store' });
  if (!response.ok) throw new Error('Le service est temporairement indisponible.');
  return response.json();
}

async function uploadPage() {
  if (!uploadToken) {
    shell('Dépôt de fichiers', '<p class="muted">Utilisez le lien de dépôt qui vous a été communiqué.</p>');
    return;
  }
  let config;
  try { config = await loadConfig(); }
  catch (e) { shell('Service indisponible', `<p class="error">${escapeHtml(e.message)}</p>`); return; }

  shell('Envoyer des notes', `
    <p class="muted">Sélectionnez les notes audio et les documents PDF à transmettre. Ils seront regroupés dans une archive chiffrée.</p>
    <form id="upload-form">
      <label class="file-picker">Choisir des fichiers<input id="files" type="file" multiple accept=".mp3,.m4a,.wav,.aiff,.pdf,audio/*,application/pdf" required></label>
      <div id="file-list" class="file-list">Aucun fichier sélectionné</div>
      <button id="submit" type="submit">Chiffrer et envoyer</button>
      <div id="status" role="status" aria-live="polite"></div>
    </form>`);

  const picker = document.querySelector('#files');
  const list = document.querySelector('#file-list');
  picker.addEventListener('change', () => {
    const files = [...picker.files];
    list.textContent = files.length ? `${files.length} fichier(s) · ${formatBytes(files.reduce((n, f) => n + f.size, 0))}` : 'Aucun fichier sélectionné';
  });

  document.querySelector('#upload-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const files = [...picker.files];
    const status = document.querySelector('#status');
    const button = document.querySelector('#submit');
    if (!files.length) return;
    const total = files.reduce((n, f) => n + f.size, 0);
    if (total > config.maxUploadBytes) {
      status.className = 'error';
      status.textContent = `La sélection dépasse la limite de ${formatBytes(config.maxUploadBytes)}.`;
      return;
    }
    button.disabled = true;
    status.className = 'muted';
    status.textContent = 'Préparation de l’archive…';
    try {
      // Read local files and create an uncompressed ZIP. Encryption remains in this browser.
      const entries = {};
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const safeName = file.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 180) || `fichier-${i + 1}`;
        entries[`${String(i + 1).padStart(3, '0')}_${safeName}`] = new Uint8Array(await file.arrayBuffer());
        status.textContent = `Préparation de l’archive… (${i + 1}/${files.length})`;
      }
      const archive = zipSync(entries, { level: 0 });
      status.textContent = 'Chiffrement de l’archive…';
      const encrypter = new Encrypter();
      encrypter.addRecipient(config.recipient);
      const encrypted = await encrypter.encrypt(new Blob([archive]).stream());
      status.textContent = 'Envoi du dépôt chiffré…';
      const response = await fetch('/api/uploads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Upload-Token': uploadToken },
        body: encrypted,
        duplex: 'half'
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Le dépôt a échoué.');
      if (result.notificationSent) {
        shell('Dépôt envoyé', '<p>Le dépôt chiffré a bien été transmis. La secrétaire a reçu une notification.</p>');
      } else {
        shell('Dépôt enregistré', '<p>Le dépôt chiffré est enregistré, mais la notification e-mail n’a pas pu être envoyée. Prévenez l’administrateur.</p>');
      }
    } catch (error) {
      status.className = 'error';
      status.textContent = error.message || 'Le dépôt a échoué. Réessayez.';
      button.disabled = false;
    }
  });
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} Mo`;
}

async function downloadPage() {
  if (!downloadId || !downloadToken) {
    shell('Lien de téléchargement', '<p class="muted">Ouvrez le lien reçu par e-mail pour télécharger le dépôt.</p>');
    return;
  }
  shell('Votre dépôt est prêt', '<p class="muted">Le fichier téléchargé reste chiffré. Déchiffrez-le ensuite avec la clé privée de la secrétaire.</p><button id="download">Télécharger le fichier chiffré</button><div id="status" role="status" aria-live="polite"></div>');
  document.querySelector('#download').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const status = document.querySelector('#status');
    button.disabled = true;
    status.textContent = 'Téléchargement…';
    try {
      const response = await fetch('/api/download', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: downloadId, token: downloadToken }), cache: 'no-store'
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || 'Lien expiré ou inutilisable.');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'depot.age';
      anchor.click();
      URL.revokeObjectURL(url);
      status.className = 'success';
      status.textContent = 'Téléchargement terminé. Le fichier est chiffré.';
    } catch (error) {
      status.className = 'error';
      status.textContent = error.message;
      button.disabled = false;
    }
  });
}

if (path.startsWith('/download/')) downloadPage();
else uploadPage();
