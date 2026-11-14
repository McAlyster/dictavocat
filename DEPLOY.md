# Déploiement de Dictavocat sur le VPS (podman)

## 0. Pré-requis

- Un sous-domaine (ex. `depot.example.fr`) avec un enregistrement A/AAAA pointant vers le VPS.
- Un relais SMTP utilisable (boîte d'envoi dédiée, ex. `depot@…`).
- `podman` et `podman-compose` (ou `podman compose`) sur le VPS.
- Un port local libre pour l'application (8080 par défaut ; voir étape 4 s'il est déjà pris).

## 1. Clé de la secrétaire (générée par vous, sur le Mac)

Depuis le dossier du projet (`npm install` fait au préalable) :

```sh
node tools/generer-cle.mjs
```

Le script crée `cles/cle-dictavocat.age` (clé privée **protégée par une phrase secrète**, dossier exclu de git et de Docker) et affiche :

- la ligne `AGE_RECIPIENT=age1…` à mettre dans le `.env` (étape 3) ;
- la phrase secrète (7 mots séparés par des tirets).

Transmission :

- **le fichier** `cle-dictavocat.age` par e-mail (il est inutilisable sans la phrase) ;
- **la phrase** par un autre canal : SMS ou téléphone. Jamais dans le même message que le fichier.

Sauvegarde : rangez le fichier et la phrase dans votre coffre de mots de passe. Sans eux, les dépôts sont illisibles. Ensuite, vous pouvez effacer le dossier `cles/` du Mac.

Côté secrétaire, il n'y a rien à installer : elle enregistre le fichier dans *Documents*, et c'est tout.

## 2. Publier le code

Sur le Mac, depuis le dossier du projet :

```sh
git add -A
git commit -m "Corrections sécurité/compatibilité + lockfile + DEPLOY.md"
git push   # vers votre GitLab
```

Sur le VPS :

```sh
git clone <url-du-depot> ~/dictavocat && cd ~/dictavocat
```

## 3. Configurer `.env` (sur le VPS uniquement)

```sh
cp .env.example .env && chmod 600 .env
openssl rand -hex 32        # -> UPLOAD_TOKEN
```

Renseigner : `PUBLIC_BASE_URL=https://depot.example.fr`, `UPLOAD_TOKEN`, `AGE_RECIPIENT` (clé publique de l'étape 1), `SECRETARY_EMAIL`, `MAIL_FROM`, `SMTP_*`.
Laisser `HOST=0.0.0.0` et `PORT=8080` (ce sont les valeurs *dans* le conteneur).

## 4. Lancer le conteneur

Si le port 8080 est déjà utilisé sur le VPS (`ss -ltnp | grep 8080`), changer seulement la partie gauche dans `compose.yaml`, ex. `"127.0.0.1:8090:8080"`, et utiliser ce port à l'étape 5.

```sh
podman-compose up -d --build
podman logs -f dictavocat_dictavocat_1   # attendu : "dictavocat listening on 0.0.0.0:8080"
curl -s http://127.0.0.1:8080/api/config  # doit renvoyer la clé publique
```

Au démarrage, le serveur refuse de se lancer si `UPLOAD_TOKEN`, `AGE_RECIPIENT`, `PUBLIC_BASE_URL` (https) ou le SMTP sont mal configurés : lire le message d'erreur dans les logs.

Redémarrage automatique après reboot (podman rootless) :

```sh
loginctl enable-linger "$USER"
systemctl --user enable --now podman-restart.service
```

## 5. Reverse proxy TLS

### Variante A : Caddy

Adapter `Caddyfile.example` (domaine, port) et l'inclure dans la configuration Caddy, puis `caddy reload`. Il supprime déjà des journaux l'URL et l'en-tête `Authorization`.

### Variante B : nginx déjà en place (pour Taiga/Snipe-IT)

```nginx
server {
    listen 443 ssl http2;
    server_name depot.example.fr;
    # ssl_certificate … (certbot --nginx -d depot.example.fr)

    client_max_body_size 130m;     # > MAX_UPLOAD_BYTES (120 Mio)
    proxy_request_buffering off;   # ne pas copier les dépôts sur le disque de nginx
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
    access_log off;                # ou un format sans $request_uri ni en-têtes

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
    }
}
```

`nginx -t && systemctl reload nginx`.

Sous Rocky Linux avec SELinux, autoriser nginx à joindre l'application : `setsebool -P httpd_can_network_connect 1`.

## 6. Lien de l'avocate

`https://depot.example.fr/#upload=<UPLOAD_TOKEN>` : à lui transmettre par un canal sûr (en main propre, SMS). Ne pas l'envoyer par e-mail en clair.

Une fois ce lien ouvert, l'ordinateur s'en souvient : un favori vers `https://depot.example.fr/` (même sans le jeton) ou une actualisation de la page suffisent ensuite. Pour retirer l'accès d'un poste, changez `UPLOAD_TOKEN` et redémarrez : la page affichera « Ce lien n'est plus valable ».

Pour afficher le nom du cabinet en haut des pages, renseignez `OFFICE_NAME` dans `.env`.

## 7. Recette avant usage réel (avec des fichiers factices)

1. Depuis le navigateur de l'avocate : déposer un MP3 et un PDF factices → message « Dépôt envoyé ».
2. La secrétaire reçoit l'e-mail, ouvre le lien, choisit `cle-dictavocat.age`, tape la phrase, clique sur « Ouvrir le dépôt » → un fichier `depot-….zip` arrive dans *Téléchargements* ; double-clic pour voir les fichiers.
3. Faire un 2ᵉ dépôt et l'ouvrir **avec la copie de sauvegarde** de la clé (celle de votre coffre).
4. Tester une phrase erronée : message d'erreur, et le lien reste utilisable (aucun téléchargement consommé).
5. Vérifier qu'un 3ᵉ téléchargement est refusé, et qu'un dépôt trop gros (> 120 Mio) est refusé proprement.
6. Vérifier que le jeton n'apparaît dans aucun journal :
   ```sh
   TOKEN=$(grep ^UPLOAD_TOKEN .env | cut -d= -f2)
   podman logs dictavocat_dictavocat_1 2>&1 | grep -c "$TOKEN"
   sudo grep -rc "$TOKEN" /var/log/nginx/ /var/log/caddy/ 2>/dev/null
   ```
   Tous les compteurs doivent être à 0.

## Mise à jour

```sh
cd ~/dictavocat && git pull && podman-compose up -d --build
```

Les dépôts en attente sont conservés dans le volume `dictavocat-data`.
