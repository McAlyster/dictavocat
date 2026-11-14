# Dépôt sécurisé de dictées

MVP auto-hébergé : les fichiers sont archivés et chiffrés dans le navigateur avec la clé publique `age` de la secrétaire. Le serveur ne conserve que le fichier `.age` chiffré et des métadonnées minimales. Le lien reçu par la secrétaire est un jeton temporaire de téléchargement, distinct de la clé privée.

## Avant mise en service

Ce MVP n'a pas encore fait l'objet d'une revue de sécurité ni d'essais d'intégration. Ne l'exposez pas à des dossiers réels avant revue, vérification sur le navigateur Windows cible et configuration de TLS, SMTP, permissions et rétention. Le code de chiffrement est livré par le VPS : l'administrateur et la sécurité du VPS font donc partie de la chaîne de confiance.

## Préparer la clé de la secrétaire

`node tools/generer-cle.mjs` crée `cles/cle-dictavocat.age`, une identité age protégée par une phrase secrète, et affiche la clé publique à mettre dans `AGE_RECIPIENT`. Transmettre le fichier et la phrase par deux canaux distincts. Une identité créée avec `age-keygen` (non protégée) est aussi acceptée.

Le fichier et sa phrase sont irrécupérables s'ils sont perdus. Conserver une sauvegarde et la tester avant d'utiliser le service.

## Configuration

1. Copier `.env.example` vers `.env` et remplacer les valeurs.
2. Générer `UPLOAD_TOKEN` avec `openssl rand -hex 32`. Le lien communiqué à l'avocate est `https://votre-domaine/#upload=VALEUR_DU_TOKEN` ; elle peut le conserver en favori.
3. Renseigner `AGE_RECIPIENT` avec la clé publique age de la secrétaire.
4. Renseigner le relais SMTP. Le courriel ne contiendra aucun nom de fichier, contenu ou pièce jointe.
5. Adapter `PUBLIC_BASE_URL`, `SECRETARY_EMAIL`, `MAIL_FROM` et le nom de domaine dans `Caddyfile.example`.
6. Vérifier que le volume `/data` est sur un disque chiffré si cela fait partie du modèle de menace souhaité. L'application ne configure aucune sauvegarde.

## Lancement

```sh
cp .env.example .env
# Modifier .env avec un éditeur local.
docker compose up -d --build
```

Configurer le reverse proxy TLS (exemple Caddy dans `Caddyfile.example`) et limiter l'accès réseau au port 8080, qui est publié uniquement sur localhost. Pour Caddy, la limite du corps doit être supérieure à `MAX_UPLOAD_BYTES` : Caddy compte en unités décimales (`130MB` = 130 000 000 octets) alors que la valeur par défaut de `MAX_UPLOAD_BYTES` est 120 Mio (125 829 120 octets).

Le jeton de dépôt est transmis dans l'en-tête `Authorization`. Si vous utilisez un autre proxy que Caddy, vérifiez qu'il ne journalise pas cet en-tête.

## Fonctionnement et limites du MVP

- L'avocate choisit les MP3/PDF, puis le navigateur fabrique une archive ZIP sans compression et la chiffre au format `age`.
- Taille maximale par dépôt : 120 Mio par défaut. La création ZIP lit les fichiers côté navigateur et peut temporairement utiliser plusieurs fois leur taille en mémoire.
- Le navigateur vérifie la taille finale (après ZIP et chiffrement) avant l'envoi. Le serveur vérifie l'en-tête age, stocke sous un identifiant aléatoire et envoie le courriel seulement après l'enregistrement.
- En cas d'échec SMTP, le dépôt reste enregistré et l'interface le signale, mais la notification n'est pas automatiquement renvoyée.
- Le lien secrétaire expire après 72 h par défaut et autorise deux téléchargements terminés. Une ouverture du lien ne consomme pas d'usage ; seul le clic sur « Télécharger » envoie le jeton au serveur.
- Une suppression automatique purge les dépôts expirés chaque minute, ainsi que les envois interrompus (`.part` de plus d'une heure) et les fichiers chiffrés orphelins. À la seconde utilisation, le dépôt est supprimé.
- Les métadonnées et l'adresse IP peuvent apparaître dans les journaux du proxy/VPS. Ne pas activer de journaux contenant les URL complètes ou les corps de requête.
- Le jeton de dépôt est mémorisé dans le navigateur de l'avocate (`localStorage`) après la première ouverture du lien, pour qu'une actualisation ou un favori sans jeton fonctionne. À n'utiliser que sur son propre poste.
- Limites anti-abus : blocage d'une IP après 5 jetons invalides (15 min), 20 dépôts par heure et 100 par jour au total, 2 envois simultanés, 2 Gio et 50 dépôts en attente au maximum, 30 demandes de téléchargement par heure et par IP, délais de connexion. Tout est réglable dans `.env`. Les échecs sont journalisés (`auth_failed <route> <ip>`), ce qui permet d'ajouter fail2ban.
- L'IP du visiteur est lue dans `X-Forwarded-For` (entrée la plus à droite) selon `TRUST_PROXY`. L'image Docker utilise `always`, car son port n'est publié que sur `127.0.0.1`, derrière le proxy.
- Aucun compte secrétaire, antivirus, reprise d'envoi interrompu, tableau de bord ou sauvegarde n'est inclus dans ce MVP.

## Déchiffrer

Par défaut, la page de téléchargement déchiffre le dépôt dans le navigateur de la secrétaire : elle choisit son fichier clé et saisit sa phrase secrète. La phrase est vérifiée **avant** le téléchargement, donc une faute de frappe ne consomme pas d'usage. Le ZIP en clair est ensuite enregistré dans *Téléchargements*. Ni la clé ni la phrase ne quittent le navigateur, mais le code de la page est servi par le VPS (voir « Avant mise en service »).

Option avancée, avec l'outil `age` :

```sh
age -d -i cle-dictavocat.age -o depot.zip depot.age   # demande la phrase secrète
```
