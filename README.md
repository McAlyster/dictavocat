# Dépôt sécurisé de dictées

MVP auto-hébergé : les fichiers sont archivés et chiffrés dans le navigateur avec la clé publique `age` de la secrétaire. Le serveur ne conserve que le fichier `.age` chiffré et des métadonnées minimales. Le lien reçu par la secrétaire est un jeton temporaire de téléchargement, distinct de la clé privée.

## Avant mise en service

Ce MVP n'a pas encore fait l'objet d'une revue de sécurité ni d'essais d'intégration. Ne l'exposez pas à des dossiers réels avant revue, vérification sur le navigateur Windows cible et configuration de TLS, SMTP, permissions et rétention. Le code de chiffrement est livré par le VPS : l'administrateur et la sécurité du VPS font donc partie de la chaîne de confiance.

## Préparer la clé de la secrétaire

Sur le poste de la secrétaire, installer le client `age`, puis créer la clé privée avec `age-keygen`. Conserver le fichier d'identité uniquement sur ce poste et dans une sauvegarde protégée hors du VPS. Transmettre à l'administrateur uniquement la ligne `Public key: age1...`.

Le fichier privé est irrécupérable s'il est perdu. Tester une sauvegarde de la clé avant d'utiliser le service.

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

Configurer le reverse proxy TLS (exemple Caddy dans `Caddyfile.example`) et limiter l'accès réseau au port 8080, qui est publié uniquement sur localhost. Pour Caddy, la limite du corps doit correspondre à `MAX_UPLOAD_BYTES` plus une marge pour les en-têtes.

## Fonctionnement et limites du MVP

- L'avocate choisit les MP3/PDF, puis le navigateur fabrique une archive ZIP sans compression et la chiffre au format `age`.
- Taille maximale par dépôt : 120 Mio par défaut. La création ZIP lit les fichiers côté navigateur et peut temporairement utiliser plusieurs fois leur taille en mémoire.
- Le serveur vérifie l'en-tête age, stocke sous un identifiant aléatoire et envoie le courriel seulement après l'enregistrement.
- En cas d'échec SMTP, le dépôt reste enregistré et l'interface le signale, mais la notification n'est pas automatiquement renvoyée.
- Le lien secrétaire expire après 72 h par défaut et autorise deux téléchargements terminés. Une ouverture du lien ne consomme pas d'usage ; seul le clic sur « Télécharger » envoie le jeton au serveur.
- Une suppression automatique purge les dépôts expirés chaque minute. À la seconde utilisation, le dépôt est supprimé.
- Les métadonnées et l'adresse IP peuvent apparaître dans les journaux du proxy/VPS. Ne pas activer de journaux contenant les URL complètes ou les corps de requête.
- Aucun compte secrétaire, antivirus, reprise d'envoi interrompu, tableau de bord ou sauvegarde n'est inclus dans ce MVP.

## Déchiffrer

Télécharger le fichier `.age`, puis utiliser la clé privée sur le poste de la secrétaire :

```sh
age -d -i chemin/vers/identite.txt -o depot.zip depot.age
```

Ouvrir ensuite l'archive ZIP localement.
