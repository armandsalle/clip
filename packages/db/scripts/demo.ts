// Vidéos de démo pour le dev local (`vp run db:seed`) : identifiants fixes, pour que
// le seed soit rejouable (les anciennes versions sont supprimées puis recréées).

export interface DemoSegment {
  readonly start: number;
  readonly end: number;
  readonly speaker: number;
  readonly text: string;
}

export interface DemoComment {
  readonly id: string;
  readonly parentId: string | null;
  readonly author: string;
  readonly body: string;
  readonly time: number;
  readonly via: "web" | "email";
}

export interface DemoVideo {
  readonly id: string;
  /** Faux Stream : `dev-<uuid>`, servi par clip-api sur /dev/stream/<uid>. */
  readonly streamUid: string;
  readonly title: string;
  readonly duration: number;
  readonly expiry: "never" | "7d";
  /** Ancienneté, pour étaler la galerie. */
  readonly hoursAgo: number;
  /** Teinte de la mire générée par ffmpeg. */
  readonly color: string;
  readonly ownerEmail: string;
  readonly summary: string;
  readonly chapters: ReadonlyArray<{ readonly time: number; readonly title: string }>;
  readonly segments: ReadonlyArray<DemoSegment>;
  readonly comments: ReadonlyArray<DemoComment>;
}

export const demoVideos: ReadonlyArray<DemoVideo> = [
  {
    id: "5eed0000-0000-4000-8000-000000000001",
    streamUid: "dev-5eed0000-0000-4000-8000-0000000000a1",
    title: "Démo : déposer une vidéo en trente secondes",
    duration: 48,
    expiry: "never",
    hoursAgo: 2,
    color: "0x8fb3ff",
    ownerEmail: "camille@example.com",
    summary:
      "Camille montre le parcours de dépôt de Clip : glisser un fichier, saisir son email, obtenir un lien. La transcription, les chapitres et les commentaires arrivent pendant que la vidéo est déjà lisible.",
    chapters: [
      { time: 0, title: "Le dépôt" },
      { time: 18, title: "Le lien de partage" },
      { time: 34, title: "Ce que fait l'IA" },
    ],
    segments: [
      {
        start: 0,
        end: 6,
        speaker: 0,
        text: "Bonjour, je vais vous montrer comment on dépose une vidéo dans Clip.",
      },
      {
        start: 6,
        end: 12,
        speaker: 0,
        text: "On glisse le fichier, on saisit son email, et c'est tout : pas de compte.",
      },
      {
        start: 12,
        end: 18,
        speaker: 0,
        text: "Pendant l'envoi, on voit la progression morceau par morceau.",
      },
      {
        start: 18,
        end: 25,
        speaker: 1,
        text: "Et le lien, je peux le partager tout de suite, avant la fin de l'encodage ?",
      },
      {
        start: 25,
        end: 34,
        speaker: 0,
        text: "Oui, la page s'ouvre et la vidéo devient lisible dès que Stream a fini la première qualité.",
      },
      {
        start: 34,
        end: 41,
        speaker: 0,
        text: "Ensuite la transcription, le résumé et les chapitres s'ajoutent en direct.",
      },
      {
        start: 41,
        end: 48,
        speaker: 1,
        text: "Parfait, on peut commenter à un moment précis de la vidéo, c'est noté.",
      },
    ],
    comments: [
      {
        id: "5eed0000-0000-4000-8000-0000000c0001",
        parentId: null,
        author: "Léa",
        body: "Très clair. On pourrait afficher la taille maximale avant le dépôt ?",
        time: 9.5,
        via: "web",
      },
      {
        id: "5eed0000-0000-4000-8000-0000000c0002",
        parentId: "5eed0000-0000-4000-8000-0000000c0001",
        author: "Propriétaire",
        body: "Bonne idée, c'est 2 Go : je l'ajoute sous la zone de dépôt.",
        time: 9.5,
        via: "email",
      },
      {
        id: "5eed0000-0000-4000-8000-0000000c0003",
        parentId: null,
        author: "Hugo",
        body: "Le lien qui marche avant la fin de l'encodage, c'est le vrai plus.",
        time: 27,
        via: "web",
      },
    ],
  },
  {
    id: "5eed0000-0000-4000-8000-000000000002",
    streamUid: "dev-5eed0000-0000-4000-8000-0000000000a2",
    title: "Rétro de sprint : ce qui a marché, ce qu'on change",
    duration: 64,
    expiry: "7d",
    hoursAgo: 26,
    color: "0xc9a2ff",
    ownerEmail: "nadia@example.com",
    summary:
      "Rétrospective d'équipe : le découpage en trois Workers a simplifié les déploiements, les environnements de PR arrivent, et l'équipe veut des données de démo dès le premier lancement.",
    chapters: [
      { time: 0, title: "Ce qui a marché" },
      { time: 22, title: "Ce qui a coincé" },
      { time: 44, title: "Décisions" },
    ],
    segments: [
      {
        start: 0,
        end: 8,
        speaker: 0,
        text: "On commence par ce qui a marché pendant ce sprint.",
      },
      {
        start: 8,
        end: 15,
        speaker: 1,
        text: "Le découpage en trois Workers : chacun se déploie seul, et les erreurs sont plus faciles à isoler.",
      },
      {
        start: 15,
        end: 22,
        speaker: 0,
        text: "Et la RPC interne typée entre jobs et api, plus aucun appel HTTP fait à la main.",
      },
      {
        start: 22,
        end: 31,
        speaker: 1,
        text: "Ce qui a coincé : en local, on n'avait aucune donnée, il fallait déposer une vidéo à chaque fois.",
      },
      {
        start: 31,
        end: 44,
        speaker: 0,
        text: "Et on testait parfois contre la base de production, ce qui n'est pas acceptable.",
      },
      {
        start: 44,
        end: 54,
        speaker: 1,
        text: "Décision : une base Docker par développeur, un seed, et un environnement complet par pull request.",
      },
      {
        start: 54,
        end: 64,
        speaker: 0,
        text: "Je m'occupe de la CI, et on fait le point jeudi.",
      },
    ],
    comments: [
      {
        id: "5eed0000-0000-4000-8000-0000000c0011",
        parentId: null,
        author: "Thomas",
        body: "D'accord pour la base Docker, à condition que le seed soit rejouable.",
        time: 47,
        via: "web",
      },
      {
        id: "5eed0000-0000-4000-8000-0000000c0012",
        parentId: "5eed0000-0000-4000-8000-0000000c0011",
        author: "Nadia",
        body: "Oui : identifiants fixes, il remplace les vidéos de démo à chaque lancement.",
        time: 47,
        via: "web",
      },
      {
        id: "5eed0000-0000-4000-8000-0000000c0013",
        parentId: null,
        author: "Inès",
        body: "Plus jamais la prod en local, merci 🙏",
        time: 35,
        via: "web",
      },
    ],
  },
  {
    id: "5eed0000-0000-4000-8000-000000000003",
    streamUid: "dev-5eed0000-0000-4000-8000-0000000000a3",
    title: "Onboarding : l'architecture de Clip en trois Workers",
    duration: 72,
    expiry: "never",
    hoursAgo: 72,
    color: "0x8fe0c0",
    ownerEmail: "samuel@example.com",
    summary:
      "Tour de l'architecture pour les nouveaux : clip-web sert le front et relaie l'API, clip-api est le seul écrivain des vidéos et des commentaires, clip-jobs fait tourner le pipeline, la file de notifications et les emails.",
    chapters: [
      { time: 0, title: "clip-web" },
      { time: 20, title: "clip-api" },
      { time: 44, title: "clip-jobs" },
    ],
    segments: [
      {
        start: 0,
        end: 10,
        speaker: 0,
        text: "Bienvenue ! Clip, ce sont trois Workers, et un seul est exposé : clip-web.",
      },
      {
        start: 10,
        end: 20,
        speaker: 0,
        text: "Il sert le front et relaie tout ce qui commence par barre oblique api vers clip-api.",
      },
      {
        start: 20,
        end: 32,
        speaker: 0,
        text: "clip-api, c'est le seul écrivain des vidéos et des commentaires, avec un Durable Object par vidéo pour le direct.",
      },
      {
        start: 32,
        end: 44,
        speaker: 1,
        text: "Et si jobs veut changer l'état d'une vidéo ?",
      },
      {
        start: 44,
        end: 58,
        speaker: 0,
        text: "Il le demande à api par la RPC interne. Jobs n'écrit que les enrichissements : transcription, résumé, miniatures.",
      },
      {
        start: 58,
        end: 72,
        speaker: 0,
        text: "Jobs porte aussi le Workflow, la file de notifications, les emails entrants et le Cron d'expiration.",
      },
    ],
    comments: [
      {
        id: "5eed0000-0000-4000-8000-0000000c0021",
        parentId: null,
        author: "Zoé",
        body: "Le schéma du flux est dans docs/ARCHITECTURE.md ?",
        time: 15,
        via: "web",
      },
      {
        id: "5eed0000-0000-4000-8000-0000000c0022",
        parentId: "5eed0000-0000-4000-8000-0000000c0021",
        author: "Propriétaire",
        body: "Oui, section « Flux d'une vidéo ».",
        time: 15,
        via: "email",
      },
      {
        id: "5eed0000-0000-4000-8000-0000000c0023",
        parentId: null,
        author: "Malik",
        body: "La règle « jobs n'écrit que les enrichissements » mérite d'être rappelée en revue.",
        time: 50,
        via: "web",
      },
      {
        id: "5eed0000-0000-4000-8000-0000000c0024",
        parentId: null,
        author: "Zoé",
        body: "Quel Worker reçoit les réponses par email ?",
        time: 64,
        via: "web",
      },
    ],
  },
];
