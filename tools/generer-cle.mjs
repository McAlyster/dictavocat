#!/usr/bin/env node
// Génère la clé de la secrétaire, protégée par une phrase secrète.
//
//   node tools/generer-cle.mjs
//
// Produit cles/cle-dictavocat.age (clé privée chiffrée par la phrase secrète) et affiche :
//   - la ligne AGE_RECIPIENT=… à copier dans le .env du serveur ;
//   - la phrase secrète à transmettre à la secrétaire par un AUTRE canal que le fichier.
// Le fichier produit fonctionne aussi avec l'outil officiel : age -d -i cle-dictavocat.age …
import { Encrypter, generateX25519Identity, identityToRecipient } from 'age-encryption';
import { randomInt } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

// Mots courts, sans accents ni homophones évidents, faciles à dicter au téléphone.
const WORDS = `abeille abricot agneau aigle algue ananas ancre anguille arbre argile armoire asperge avion avocat
badge bague baleine balle bambou banane banc barque bateau bercail biche bijou biscuit bison bocal bol bonnet
bougie boussole branche brique brosse bureau cabane cactus cadre caillou camion canard canne carotte carte
castor cerise chalet chameau champ chapeau chariot chaton chemin cheval chevre chocolat citron clavier cloche
clou coffre colline comete concombre coquille corde cornet coton couleur coussin crabe crayon cristal cygne
dauphin domino dragon drapeau ecureuil emeraude encre epice escargot etoile falaise farine fenetre feuille
figue flamant flocon fontaine forge fourmi fraise framboise fromage fusee gazelle girafe glacier gland gomme
gorille goudron grenier grenouille griffe guitare hamac hamster harpe herisson hibou hirondelle horloge
igloo iris jardin jasmin jonquille journal kayak kiwi lagune lampe lanterne lapin laurier lavande legume
lezard licorne lilas lion livre loutre lune lynx macaron magnolia maison mammouth mandarine marmotte marteau
melon menthe meuble miel miroir moineau montagne moulin mouton muguet myrtille navire neige noisette nuage
oasis olive orange orchidee ours outil pagaie palmier panda papillon parapluie pastel pelican perle phare
piano pinceau pingouin pirate plage plume poire poisson pomme pont potiron poulpe prairie prune puzzle
quartz radeau radis raisin renard requin rivage robot rocher roseau ruban ruche sable sapin sardine saule
sentier serpent singe sirop soleil sorbet source spatule stylo sucre tambour tapis taupe theiere tigre
tomate tonneau torrent tortue toupie tracteur train trefle trompette tulipe vague valise vanille velo
verger violon volcan wagon yaourt zebre`.split(/\s+/).filter(Boolean);

const unique = [...new Set(WORDS)];
const count = 7; // 7 mots parmi ~240 ≈ 55 bits, renforcés par scrypt (dérivation lente).
const passphrase = Array.from({ length: count }, () => unique[randomInt(unique.length)]).join('-');

const identity = await generateX25519Identity();
const recipient = await identityToRecipient(identity);

const encrypter = new Encrypter();
encrypter.setPassphrase(passphrase);
const now = new Date().toISOString().slice(0, 10);
const keyFile = await encrypter.encrypt(`# Clé privée Dictavocat, créée le ${now}\n# Clé publique : ${recipient}\n${identity}\n`);

await mkdir('cles', { recursive: true, mode: 0o700 });
const out = 'cles/cle-dictavocat.age';
if (existsSync(out)) {
  console.error(`${out} existe déjà : déplacez-le ou supprimez-le avant d'en générer une nouvelle.`);
  process.exit(1);
}
await writeFile(out, keyFile, { mode: 0o600, flag: 'wx' });

console.log(`
Clé créée : ${out}

1) Dans le .env du serveur :
   AGE_RECIPIENT=${recipient}

2) Phrase secrète (à dicter ou envoyer par SMS, JAMAIS avec le fichier) :
   ${passphrase}

3) Envoyer ${out} à la secrétaire (e-mail possible : il est inutilisable sans la phrase).
   Elle l'enregistre dans Documents et en garde une copie (clé USB ou sa messagerie).

4) Gardez vous-même une copie de ce fichier et de la phrase dans un coffre de mots de passe :
   c'est la seule sauvegarde possible.
`);
