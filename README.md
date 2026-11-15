# Dictavocat : envoi chiffré de dictées

L'avocate envoie ses dictées (MP3, PDF) depuis son navigateur. Avant l'envoi, le navigateur les regroupe et les chiffre au format [age](https://age-encryption.org) avec la clé publique de la secrétaire. Le serveur ne stocke que le fichier chiffré `.age` et quelques métadonnées. La secrétaire reçoit un e-mail avec un lien temporaire, et c'est son propre navigateur qui déchiffre les dictées grâce à sa clé d'accès et à son mot de passe.

Production : https://dict.leataieb-avocat.fr. L'installation et l'exploitation sont décrites dans **[DEPLOY.md](DEPLOY.md)**.

## Vocabulaire de l'interface

| Dans le code | À l'écran |
|---|---|
| dépôt, upload | « Envoyer des dictées », « C'est envoyé » |
| jeton de dépôt (`UPLOAD_TOKEN`) | caché dans le raccourci « Envoyer mes dictées » du dictaphone |
| identité age (`cle-dictavocat.age`) | « Votre clé d'accès » |
| phrase de passe de l'identité | « Votre mot de passe » |
| téléchargement + déchiffrement | « Récupérer les dictées », « Dictées récupérées » |

## Chaîne de confiance

Le code de chiffrement est servi par le VPS. L'administrateur et la sécurité du VPS font donc partie de la chaîne de confiance. Le serveur ne voit jamais les fichiers en clair, ni la clé d'accès, ni le mot de passe.

Les secrets passent dans le fragment de l'URL (`#upload=…`, `#t=…`). Le navigateur n'envoie jamais ce fragment au serveur : la page le lit, puis l'efface de la barre d'adresse. Le jeton n'est ensuite transmis que dans l'en-tête `Authorization`.

## Clé de la secrétaire

`node tools/generer-cle.mjs` crée `cles/cle-dictavocat.age` : une identité age protégée par un mot de passe de 7 mots. Le script affiche aussi la clé publique à mettre dans `AGE_RECIPIENT`. Le fichier et le mot de passe doivent partir par deux canaux distincts. Une identité non protégée créée avec `age-keygen` fonctionne aussi.

Si le fichier ou le mot de passe est perdu, rien ne peut être récupéré. Gardez-en une copie dans un coffre, et testez-la avant la mise en service.

## Outils

| Commande | Rôle |
|---|---|
| `node tools/generer-cle.mjs` | crée la clé d'accès de la secrétaire |
| `node tools/raccourci-depot.mjs /Volumes/WS-882 [--env .env.test]` | écrit le raccourci `Envoyer mes dictées.url` sur le dictaphone |
| `docker compose run --rm -v ./tools:/app/tools:ro dictavocat node tools/test-smtp.mjs` | vérifie le SMTP et envoie un e-mail de test |
| `npm run test:local` | build et serveur local avec `.env.test` |

## Configuration

Toutes les variables sont décrites dans `.env.example`. Les plus importantes :

- `PUBLIC_BASE_URL`, `UPLOAD_TOKEN` (`openssl rand -hex 32`) et `AGE_RECIPIENT` ;
- `OFFICE_NAME` : nom affiché en haut des pages et dans l'e-mail ;
- `SUPPORT_CONTACT` : contact affiché dans les messages d'erreur et l'e-mail ;
- `SECRETARY_EMAIL`, `MAIL_FROM` et `SMTP_*` : l'e-mail ne contient aucun nom de fichier, aucun contenu, aucune pièce jointe ;
- `HOST_PORT` : port local de l'hôte vers lequel le proxy transmet les requêtes.

Le conteneur publie son port uniquement sur `127.0.0.1`. Un reverse proxy TLS se place devant : nginx en production (configuration dans `DEPLOY.md`), ou Caddy (`Caddyfile.example`). La limite de taille des requêtes du proxy doit dépasser `MAX_UPLOAD_BYTES`. Attention, Caddy compte en unités décimales : `130MB` font 130 000 000 octets, alors que la valeur par défaut de `MAX_UPLOAD_BYTES` est de 120 Mio, soit 125 829 120 octets. Aucun proxy ne doit journaliser l'en-tête `Authorization` ni les URL complètes.

## Fonctionnement et limites

- Le navigateur de l'avocate fabrique une archive ZIP sans compression, puis la chiffre. La taille est limitée à 120 Mio par envoi. Le navigateur peut utiliser temporairement plusieurs fois cette taille en mémoire. L'avancement s'affiche pendant l'envoi.
- Le serveur vérifie la taille et l'en-tête age pendant la réception, enregistre le fichier sous un identifiant aléatoire, puis envoie l'e-mail.
- Si l'envoi de l'e-mail échoue, la dictée reste enregistrée et l'interface le signale. L'e-mail n'est pas renvoyé automatiquement.
- Le lien de la secrétaire expire au bout de 72 h et sert deux fois. Ouvrir le lien ne compte pas comme un usage. Le mot de passe est vérifié **avant** le téléchargement, donc une faute de frappe ne consomme rien.
- Une purge tourne chaque minute : elle supprime les dictées expirées, les envois interrompus (fichiers `.part` de plus d'une heure) et les fichiers orphelins. Une dictée est supprimée dès son dernier téléchargement.
- Le jeton est mémorisé dans le navigateur de l'avocate (`localStorage`). Une actualisation de la page ou un favori sans jeton fonctionnent donc. À réserver à son propre poste.
- Limites anti-abus :
  - blocage d'une IP après 5 jetons invalides, pendant 15 min ;
  - 20 envois par heure et 100 par jour au total, 2 envois simultanés au maximum ;
  - au plus 2 Gio stockés et 50 dictées en attente ;
  - 30 demandes de téléchargement par heure et par IP ;
  - délais maximaux de connexion.

  Tout se règle dans `.env`. Les échecs sont journalisés (`auth_failed <route> <ip>`), ce qui permet d'ajouter fail2ban.
- L'IP du visiteur est lue dans `X-Forwarded-For` (entrée la plus à droite), selon `TRUST_PROXY`. L'image Docker utilise `always` : son port n'est publié que sur `127.0.0.1`, derrière le proxy.
- Ce MVP n'a ni comptes utilisateurs, ni antivirus, ni reprise d'un envoi interrompu, ni tableau de bord, ni sauvegarde.

## Déchiffrer sans la page

Si la page ne parvient pas à ouvrir les dictées, elle enregistre le fichier verrouillé `dictees.age`. On peut alors l'ouvrir avec l'outil `age` :

```sh
age -d -i cle-dictavocat.age -o dictees.zip dictees.age   # demande le mot de passe
```
