# Clip : flow métier, UX et UI

Clip est un Grain / SuperCut minimaliste, 100 % Cloudflare. On dépose une vidéo, on reçoit un lien. La vidéo devient un stream avec transcription, résumé, chapitres, miniatures, commentaires horodatés en direct, questions-réponses, et réponses aux commentaires par email. Pas de compte : l'accès repose sur des liens secrets.

Principe de démo : l'IA est une couche (transcription, résumé, suggestions, Q&R) qu'on peut couper d'un flag ; le produit tient sans elle. La plateforme doit être visible : pipeline en direct, présence, commentaires temps réel.

## 1. Acteurs

| Acteur           | Accès                                                                  | Peut                                                                          |
| ---------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Propriétaire** | lien d'admin secret (`/v/:id?k=<admin>`), reçu à l'upload et par email | tout : titre, miniature, extraits, partage, expiration, suppression, répondre |
| **Spectateur**   | lien de partage (`/v/:id`)                                             | regarder, commenter (avec un pseudo), réagir, poser des questions             |
| **Système**      | —                                                                      | encoder, transcrire, résumer, notifier, expirer                               |

Le propriétaire n'a pas de compte. Son email (optionnel, demandé à l'upload) sert aux notifications et à la boucle de réponse par email. Le lien d'admin est stocké haché ; le perdre, c'est perdre les droits d'admin (on peut le renvoyer par email).

## 2. Cycle de vie d'une vidéo

```
          upload terminé         encodage OK
Uploading ───────────▶ Encoding ───────────▶ Ready ──── enrichissements en parallèle
    │                     │                    │        (chacun : Pending → Running → Done | Failed | Disabled)
    │                     └── échec ──▶ Failed │
    └── « prête » reçue avant la fin d'upload ─┘
                                               ▼
                                 date atteinte / suppression
                                       Expired / Deleted
```

- **Ready dès que la vidéo est lisible.** Les enrichissements (transcription, résumé, chapitres, suggestions de miniatures, planche de vignettes) arrivent ensuite, chacun avec son propre état : `pending → running → done | failed | disabled`.
- Une vidéo `Ready` reste regardable même si l'IA est coupée ou en panne.
- `Expired` et `Deleted` sont terminaux : fichiers Stream/R2 supprimés, page « Cette vidéo n'est plus disponible ».

### Enrichissements (pipeline, un Workflow par vidéo)

```
encodage prêt ─┬─ miniature auto
               ├─ audio → transcription (par morceaux, horodatée) ─┬─ titre + résumé + chapitres
               │                                                  └─ indexation (Q&R)
               ├─ extraction de 12 images → suggestions de miniatures
               ├─ planche de vignettes (aperçu au survol)
               └─ carte de partage
                                       ⇣ tout terminé (ou en échec définitif)
                         email « ta vidéo est prête » au propriétaire
```

Chaque étape émet ses événements (début, fin, échec, nouvelle tentative) vers la page, qui les affiche en direct.

## 3. Flows

### F1 · Déposer

1. Page d'accueil : une seule zone « Dépose une vidéo » (ou bouton). Turnstile invisible.
2. Pendant l'upload : barre de progression, vitesse, temps restant. En parallèle, champ optionnel « Ton email (pour être prévenu des commentaires) ».
3. Fin d'upload : redirection immédiate vers la page de la vidéo en mode propriétaire. On affiche les deux liens (partage / admin) avec un bouton copier.
4. Erreurs : format non vidéo, taille > limite, upload interrompu (reprise automatique).

### F2 · Suivre le traitement

1. La page vidéo s'ouvre avant que la vidéo soit prête : à la place du lecteur, la **carte pipeline** (les étapes s'allument une à une, durées, retries).
2. Dès `Ready`, le lecteur remplace la carte ; les enrichissements continuent dans un panneau latéral discret qui se remplit (la transcription arrive au fil de l'eau, le titre s'écrit en streaming).
3. Le mode **Coulisses** (bouton) ré-ouvre la carte pipeline à tout moment : c'est l'écran projeté pendant la démo.

### F3 · Personnaliser (propriétaire)

- **Titre** : proposé par l'IA, éditable en place.
- **Miniature** : choix parmi 3 suggestions, ou défilement de la timeline pour choisir une image précise, ou image importée. La carte de partage se met à jour en direct.
- **Extrait** : sélectionner une plage sur la timeline → « Partager cet extrait » → nouveau lien.
- **Expiration** : jamais / 24 h / 7 jours / 30 jours.
- **Supprimer** : confirmation, suppression immédiate.

### F4 · Partager

- Bouton « Copier le lien ». Option « à partir de 1:20 » (case à cocher, prend la position courante).
- Le lien déplié dans Slack / iMessage montre la carte de partage (miniature + titre + durée).

### F5 · Regarder

- Lecteur, titre, résumé repliable, chapitres cliquables, transcription synchronisée (la phrase en cours est surlignée, clic = saut).
- Présence : « 4 personnes regardent », avec la position de chacun sur la timeline.
- Aperçu au survol de la barre de lecture.

### F6 · Commenter

1. Pseudo demandé une seule fois (mémorisé localement).
2. Le commentaire est **horodaté** sur la position courante ; il apparaît en direct chez tous les spectateurs et comme un repère sur la timeline.
3. Réactions rapides (emoji) horodatées aussi.
4. Réponses en fil sous un commentaire.

### F7 · Répondre par email

1. Nouveau commentaire → email au propriétaire (regroupés si plusieurs en moins de 2 minutes) avec l'extrait, le timecode et un lien.
2. L'adresse de réponse est unique par commentaire (`reply+<jeton>@clip.bonjour.pizza`, grâce au sous-adressage d'Email Routing).
3. Le propriétaire répond depuis sa messagerie : la réponse (citations et signature retirées) est publiée sous le commentaire, en direct dans la page, marquée « répondu par email ».
4. Optionnel : un spectateur qui a laissé son email est prévenu des réponses à son commentaire, et peut répondre de la même façon.

### F8 · Poser une question à la vidéo

1. Champ « Pose une question sur cette vidéo ».
2. Réponse en streaming, avec des timecodes cliquables qui font sauter le lecteur.
3. « Je ne trouve pas ça dans la vidéo » plutôt qu'une invention.
4. Désactivable par flag (le champ disparaît en direct).

### F9 · Expiration

Le Workflow dort jusqu'à la date d'expiration, puis supprime la vidéo, les fichiers et l'index. Le propriétaire est prévenu 24 h avant (lien pour prolonger).

## 4. Architecture d'information

```
/                     Accueil = dépôt (une seule action)
/v/:id                Page vidéo (spectateur)
/v/:id?k=<admin>      Page vidéo (propriétaire) : mêmes zones + contrôles d'édition
/v/:id?t=80           Lecture à partir de 1:20
/c/:clipId            Extrait (page vidéo restreinte à la plage)
/v/:id/coulisses      Pipeline et traces en plein écran (démo)
```

Pas de liste « mes vidéos » (pas de compte). Le propriétaire retrouve ses vidéos via ses emails, ou via un historique local au navigateur.

Emails : « Ta vidéo est prête », « Nouveau commentaire » (répondable), « Réponse à ton commentaire » (répondable), « Ta vidéo expire demain ».

## 5. UI

Trois surfaces seulement. Style : sobre, sombre par défaut, la vidéo au centre ; la couleur sert uniquement aux états (pipeline, présence, commentaires).

### Accueil (dépôt)

```
┌──────────────────────────────────────────────────────────────┐
│ Clip                                                          │
│                                                               │
│        ┌──────────────────────────────────────────────┐      │
│        │                                              │      │
│        │        Dépose une vidéo ici                  │      │
│        │        ou  [ Choisir un fichier ]            │      │
│        │                                              │      │
│        └──────────────────────────────────────────────┘      │
│        Pas de compte. Le lien expire quand tu veux.           │
└──────────────────────────────────────────────────────────────┘
Pendant l'upload : la zone devient une barre de progression + champ email.
```

### Page vidéo (desktop)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Clip   Démo produit Q4 ✎            ● 4 regardent   [Coulisses] [Partager]│
├──────────────────────────────────────────────┬───────────────────────────┤
│                                              │ [Résumé] [Transcription]  │
│                                              │ [Commentaires 12] [Q&R]   │
│                 LECTEUR                      │                           │
│        (ou carte pipeline si pas prêt)       │  0:42  Alice              │
│                                              │  « Le graphique est faux »│
│                                              │   ↳ Toi (par email) : …   │
│  ▶ ───●──────◆────◆──────────── 1:20 / 4:05  │                           │
│      ▲ avatars des spectateurs  ◆ commentaires│  1:20  Bob  👍            │
├──────────────────────────────────────────────┤                           │
│ Chapitres : Intro · Démo · Budget · Q&R      │ ┌───────────────────────┐ │
│                                              │ │ Commenter à 1:20…     │ │
│ (propriétaire) Miniature [◻][◻][◻] [Choisir] │ └───────────────────────┘ │
│                Extrait  Expiration  Supprimer│                           │
└──────────────────────────────────────────────┴───────────────────────────┘
```

- Panneau de droite à onglets : **Résumé** (titre, résumé, chapitres), **Transcription** (synchronisée), **Commentaires** (fil horodaté + saisie), **Q&R** (questions à la vidéo).
- La timeline porte les repères : commentaires (◆), réactions, position des autres spectateurs (avatars).
- Contrôles propriétaire sous le lecteur, absents pour un spectateur.
- Mobile : lecteur en haut, onglets en dessous, saisie de commentaire collée en bas.

### Coulisses (écran de démo)

```
┌──────────────────────────────────────────────────────────────┐
│ Coulisses · Démo produit Q4                                   │
│                                                               │
│  [Upload ✓ 4,2 s] → [Encodage ✓ 18 s] → [Miniature ✓]         │
│                         ├→ [Transcription ⟳ 2/5 morceaux]     │
│                         │      └→ [Titre/Résumé ◌] → [Index ◌]│
│                         ├→ [Suggestions ✓ 3/12]               │
│                         ├→ [Vignettes ✗ retry 2/3 · 1,4 s]    │
│                         └→ [Carte de partage ✓]               │
│                                                               │
│  Temps réel : 4 WebSockets · 12 commentaires · 31 msg/s       │
│  12:04:02.010  ai.summary  llama · 380 tok/s · cache MISS     │
│  12:04:02.420  email.send  ready → owner                      │
└──────────────────────────────────────────────────────────────┘
```

Les tuiles reprennent le langage de Visual Effect : attente, en cours (animé), succès, échec, nouvelle tentative avec délai, désactivée par flag. Elles sont alimentées par les vraies traces Effect du Workflow et du Worker.

## 6. Hors périmètre de la démo

Comptes, équipes, dossiers, édition vidéo (au-delà de l'extrait), sous-titres multilingues, analytics détaillés, live (bonus éventuel via Stream WebRTC).
