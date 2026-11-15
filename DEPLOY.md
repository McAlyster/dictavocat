# Déploiement et exploitation de Dictavocat

Installation en production : **https://dict.leataieb-avocat.fr**, sur un VPS Debian (OVHcloud, Gravelines) avec Docker, nginx système et Let's Encrypt. Les e-mails partent par le SMTP OVH.

```
Avocate (Windows) ──HTTPS──▶ nginx :443 ──▶ 127.0.0.1:8090 ──▶ conteneur dictavocat :8080 ──▶ volume dictavocat-data
                                                                   └──SMTP 465──▶ smtp.mail.ovh.net ──▶ secrétaire
```

Les commandes `VPS$` se lancent dans le dossier du projet sur le VPS, et `Mac$` dans celui du Mac.

---

## Trois `.env`, trois rôles

C'est la source de confusion la plus fréquente. Chaque fichier sert à autre chose :

| Fichier | Où | Sert à | Doit correspondre à |
|---|---|---|---|
| `.env` | VPS | faire tourner le service | (référence) |
| `.env` | Mac | écrire le raccourci du dictaphone (`PUBLIC_BASE_URL`, `UPLOAD_TOKEN`) | `PUBLIC_BASE_URL` et `UPLOAD_TOKEN` du VPS |
| `.env.test` | Mac | tester en local (`npm run test:local`) | rien, valeurs à part |

`AGE_RECIPIENT` doit être la clé publique **du fichier clé que la secrétaire possède**. Si elle ne correspond pas, elle obtient « Ces dictées ne s’ouvrent pas avec cette clé d’accès ».

Pour comparer deux jetons sans les afficher, il suffit de regarder les 8 premiers caractères :

```sh
grep ^UPLOAD_TOKEN .env | cut -d= -f2 | cut -c1-8
```

---

## 1. Première installation

### 1.1 DNS

Dans la zone OVH de `leataieb-avocat.fr`, ajouter un enregistrement `A` : `dict` → IP du VPS (et un `AAAA` si le VPS a de l'IPv6).

### 1.2 Clé de la secrétaire (sur le Mac)

```sh
Mac$ npm install
Mac$ node tools/generer-cle.mjs
```

Le script crée `cles/cle-dictavocat.age`. Ce dossier est exclu de git et de Docker. Le script affiche :

- la ligne `AGE_RECIPIENT=age1…` à recopier dans le `.env` du VPS ;
- le mot de passe : 7 mots séparés par des tirets.

Le script refuse d'écraser une clé existante. Pour en refaire une, déplacez d'abord l'ancienne (voir § 3.3).

Remise à la secrétaire :

- **le fichier** `cle-dictavocat.age` par e-mail : il est inutilisable sans le mot de passe ;
- **le mot de passe** par un autre canal (SMS ou téléphone), jamais dans le même message.

Le texte prêt à envoyer se trouve dans `documents/message-remise-secretaire.md`.

Rangez le fichier et le mot de passe dans votre coffre de mots de passe. Sans eux, les dictées sont illisibles et personne ne peut les récupérer.

### 1.3 Code sur le VPS

Le dépôt GitHub est lu avec une clé de déploiement. Dans `~/.ssh/config`, l'alias s'appelle `github-dictavocat` :

```sh
VPS$ git clone git@github-dictavocat:<compte>/dictavocat.git ~/dictavocat && cd ~/dictavocat
```

### 1.4 `.env` du VPS

```sh
VPS$ cp .env.example .env && chmod 600 .env
VPS$ openssl rand -hex 32          # → UPLOAD_TOKEN
VPS$ vim .env
```

Valeurs de production :

```ini
PUBLIC_BASE_URL=https://dict.leataieb-avocat.fr
UPLOAD_TOKEN=<64 caractères hexadécimaux>
AGE_RECIPIENT=age1…                 # sortie de generer-cle.mjs
OFFICE_NAME=Maître Léa Hadad Taïeb
SUPPORT_CONTACT=Olivier Capra · 06 87 84 54 34

SECRETARY_EMAIL=<adresse de la secrétaire>
MAIL_FROM=Dictavocat <adresse-de-la-boite-ovh>
SMTP_HOST=smtp.mail.ovh.net
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=<adresse-de-la-boite-ovh>
SMTP_PASSWORD=<mot de passe de la boîte>

HOST_PORT=8090                      # 8080 est déjà pris sur ce VPS
```

Ne modifiez pas `HOST=0.0.0.0` et `PORT=8080` : ce sont les valeurs à l'intérieur du conteneur. Chez OVH, l'adresse de `MAIL_FROM` doit être celle de `SMTP_USER`, sinon l'envoi est refusé.

Vérifier qu'aucune variable n'apparaît deux fois (la dernière l'emporte sans prévenir) :

```sh
VPS$ grep -oE '^[A-Z_]+=' .env | sort | uniq -d     # doit ne rien afficher
```

### 1.5 Test du SMTP, avant tout le reste

```sh
VPS$ docker compose run --rm -v ./tools:/app/tools:ro dictavocat node tools/test-smtp.mjs
```

Messages attendus : « Connexion et authentification OK », puis « E-mail envoyé ». Diagnostics courants :

| Message | Cause |
|---|---|
| `wrong version number` | `SMTP_PORT` et `SMTP_SECURE` ne vont pas ensemble : 465 va avec `true`, 587 avec `false` |
| `EAUTH` | identifiant ou mot de passe de la boîte erroné |
| `ETIMEDOUT` | port sortant bloqué ou mauvais `SMTP_HOST` |

Délivrabilité : le domaine d'envoi (`studio-beta.org`) a SPF, DKIM et un enregistrement DMARC (`_dmarc` TXT `v=DMARC1; p=none; rua=mailto:contact@studio-beta.org`). Vérifiez `spf=pass dkim=pass dmarc=pass` dans l'« original » du message. Si Gmail classe quand même le message en spam, la secrétaire peut créer un filtre « Ne jamais envoyer dans le spam » sur l'expéditeur.

### 1.6 Lancer le conteneur

```sh
VPS$ docker compose up -d --build
VPS$ docker compose logs --tail 20        # attendu : "dictavocat listening on 0.0.0.0:8080"
VPS$ curl -s http://127.0.0.1:8090/api/config
```

Le serveur refuse de démarrer si `UPLOAD_TOKEN`, `AGE_RECIPIENT`, `PUBLIC_BASE_URL` (en https) ou le SMTP sont mal configurés. Le message d'erreur apparaît dans les journaux. Le conteneur redémarre tout seul après un redémarrage du VPS (`restart: unless-stopped`).

### 1.7 nginx et le certificat

`/etc/nginx/sites-available/dict.leataieb-avocat.fr` :

```nginx
server {
    listen 80;
    server_name dict.leataieb-avocat.fr;
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl http2;
    server_name dict.leataieb-avocat.fr;
    # lignes ssl_certificate ajoutées par certbot

    client_max_body_size 130m;     # > MAX_UPLOAD_BYTES (120 Mio)
    proxy_request_buffering off;   # pas de copie des dictées sur le disque de nginx
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
    access_log off;                # le jeton passe par Authorization ; ne rien journaliser

    location / {
        proxy_pass http://127.0.0.1:8090;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;   # IP réelle, pour les limites anti-abus
    }
}
```

```sh
VPS$ sudo ln -s /etc/nginx/sites-available/dict.leataieb-avocat.fr /etc/nginx/sites-enabled/
VPS$ sudo nginx -t && sudo systemctl reload nginx
VPS$ sudo certbot --nginx -d dict.leataieb-avocat.fr
VPS$ curl -sI https://dict.leataieb-avocat.fr/ | head -1      # HTTP/2 200
```

Un `502` juste après un `docker compose up` signifie seulement que le conteneur démarre encore. Attendez quelques secondes.

Le renouvellement du certificat est automatique (timer certbot). Pour le vérifier : `sudo certbot renew --dry-run`.

**nginx toujours via systemd.** Ne lancez jamais `sudo nginx` à la main. Un processus maître lancé hors de systemd occupe les ports 80 et 443, et `systemctl` échoue ensuite (`nginx.service failed`). Pour réparer :

```sh
VPS$ ps -ef | grep "nginx: master"          # repérer le PID
VPS$ sudo kill -QUIT <PID>
VPS$ sudo systemctl reset-failed nginx && sudo systemctl start nginx
```

### 1.8 Raccourci sur le dictaphone (sur le Mac)

Le `.env` du Mac doit contenir le `PUBLIC_BASE_URL` et l'`UPLOAD_TOKEN` du VPS (comparez les 8 premiers caractères). Branchez le dictaphone, puis :

```sh
Mac$ node tools/raccourci-depot.mjs /Volumes/WS-882
Mac$ dot_clean /Volumes/WS-882        # retire les fichiers « ._ » de macOS
Mac$ cat "/Volumes/WS-882/Envoyer mes dictées.url" | cut -c1-60   # vérifier l'adresse, pas localhost
```

Le script avertit s'il écrit une adresse `localhost`. Le raccourci se trouve à la racine, à côté du dossier `RECORDER`. Un formatage du dictaphone (menu « Format ») l'efface.

À tester sur un PC Windows : un double-clic doit ouvrir la page « Envoyer des dictées ». Le navigateur retient ensuite le jeton, et un favori vers `https://dict.leataieb-avocat.fr/` suffit.

### 1.9 Recette (avec des fichiers factices)

1. Poste de l'avocate : double-clic sur le raccourci, envoi d'un MP3 et d'un PDF factices. Attendu : « C'est envoyé ».
2. La secrétaire reçoit « Nouvelles dictées à récupérer ». Elle ouvre le lien, choisit `cle-dictavocat.age`, tape le mot de passe et clique sur « Récupérer les dictées ». Un `dictees-….zip` arrive dans *Téléchargements*.
3. Deuxième envoi, récupéré cette fois **avec la copie de la clé rangée dans le coffre**.
4. Mot de passe erroné : un message d'erreur s'affiche, et le lien reste utilisable (aucun téléchargement consommé).
5. Un 3ᵉ téléchargement doit être refusé, de même qu'un envoi de plus de 120 Mio.
6. Le jeton ne doit apparaître dans aucun journal :
   ```sh
   VPS$ T=$(grep ^UPLOAD_TOKEN .env | cut -d= -f2)
   VPS$ docker compose logs 2>&1 | grep -c "$T"
   VPS$ sudo grep -rc "$T" /var/log/nginx/ 2>/dev/null | grep -v ':0$'
   ```
   La première commande doit afficher 0 et la seconde ne rien afficher.

---

## 2. Mise à jour

```sh
Mac$ git push
VPS$ git pull && docker compose up -d --build && docker image prune -f
```

Les dictées en attente sont conservées dans le volume `dictavocat-data`.

---

## 3. Exploitation

### 3.1 Consulter l'état et les journaux

```sh
VPS$ docker compose ps
VPS$ docker compose logs --tail 100 -f
VPS$ docker compose logs | grep auth_failed          # jetons invalides (route, IP)
VPS$ docker compose exec dictavocat ls -la /data/uploads /data/metadata
```

Les journaux ne contiennent ni nom de fichier ni contenu.

### 3.2 Dictaphone perdu, ou accès à retirer : changer le jeton

Le jeton permet seulement d'envoyer. Personne ne peut lire les dictées avec, mais il faut le changer :

```sh
VPS$ openssl rand -hex 32
VPS$ vim .env                          # UPLOAD_TOKEN=<nouvelle valeur>
VPS$ docker compose up -d --force-recreate
```

Ensuite, reportez la même valeur dans le `.env` du Mac et réécrivez le raccourci du nouveau dictaphone (§ 1.8). Sur le PC de l'avocate, l'ancien jeton mémorisé affiche « Ce raccourci ne fonctionne plus ». Un double-clic sur le nouveau raccourci règle le problème.

### 3.3 Clé de la secrétaire perdue ou divulguée : changer de clé

1. Si possible, faites d'abord récupérer les dictées en attente : elles sont chiffrées pour l'ancienne clé.
2. Sur le Mac :
   ```sh
   Mac$ mv cles cles-ancienne-$(date +%Y%m%d)
   Mac$ node tools/generer-cle.mjs
   ```
3. Sur le VPS, remplacez `AGE_RECIPIENT` par la nouvelle clé publique, puis lancez `docker compose up -d --force-recreate`.
4. Envoyez le nouveau fichier et le nouveau mot de passe, chacun par son canal (`documents/message-remise-secretaire.md`). Mettez le coffre à jour.

Si la clé a été **divulguée** (et pas seulement perdue), videz aussi les dictées en attente (§ 3.5) : quelqu'un qui détient l'ancienne clé et le mot de passe pourrait les lire.

### 3.4 Notification non reçue

- Si l'envoi a échoué côté SMTP, l'avocate l'a vu à l'écran. La dictée est enregistrée, mais l'e-mail n'est pas renvoyé automatiquement. Le plus simple : renvoyer les fichiers.
- Si l'e-mail est parti, vérifiez les spams de la secrétaire et lancez `tools/test-smtp.mjs` (§ 1.5).
- Un lien reste valable 72 h et sert 2 fois (`LINK_TTL_HOURS` et `MAX_DOWNLOADS`). Passé ce délai, la dictée est supprimée : il faut la renvoyer.

### 3.5 Vider les dictées en attente

```sh
VPS$ docker compose exec dictavocat sh -c 'rm -f /data/uploads/* /data/metadata/*'
```

Les liens déjà envoyés afficheront « Ce lien a expiré ».

### 3.6 Limites anti-abus

Les valeurs par défaut sont décrites dans `README.md`, et toutes se règlent dans `.env`. Si l'avocate est bloquée après plusieurs essais avec un ancien raccourci, le blocage de son IP dure 15 minutes (`AUTH_BLOCK_MINUTES`). Le blocage est gardé en mémoire : un redémarrage du conteneur le lève immédiatement.

```sh
VPS$ docker compose restart
```

### 3.7 Sauvegardes

L'application ne sauvegarde rien, et c'est voulu : les dictées sont éphémères. Les seuls éléments à conserver sont :

- dans le coffre : `cle-dictavocat.age` et son mot de passe ;
- le `.env` du VPS (jeton, mot de passe SMTP), dans le coffre lui aussi.
