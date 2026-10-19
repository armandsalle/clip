// Textes de l'interface, au vous. Un seul endroit pour les relire.

export const copy = {
  nav: { gallery: "Galerie", upload: "Déposer" },
  gallery: {
    title: "Galerie",
    subtitle: (total: number) =>
      `Toutes les vidéos de la démo · ${total} ${total > 1 ? "vidéos" : "vidéo"}`,
    subtitleShort: (total: number) => `${total} ${total > 1 ? "vidéos" : "vidéo"} de la démo`,
    results: (total: number) =>
      total === 0 ? "Aucun résultat" : `${total} ${total > 1 ? "résultats" : "résultat"}`,
    search: "Rechercher un titre, un mot dit…",
    searchShort: "Rechercher…",
    more: "Afficher plus de vidéos",
    loadingMore: "Chargement…",
    untitled: "Sans titre",
    empty: {
      title: "Aucune vidéo pour l'instant",
      text: "Déposez la première, elle apparaîtra ici.",
      action: "Déposer une vidéo",
    },
    noResult: (q: string) => `Aucune vidéo ne correspond à « ${q} ».`,
    clearSearch: "Effacer la recherche",
    error: {
      title: "La galerie n'a pas pu se charger",
      text: "Le service ne répond pas pour le moment.",
      retry: "Réessayer",
    },
  },
  upload: {
    hero: ["Déposez.", "Partagez.", "C'est tout."],
    intro:
      "Pas de compte. Votre email sert uniquement à vous envoyer les commentaires, auxquels vous pourrez répondre par email.",
    perks: ["jusqu'à 2 Go", "reprise automatique", "expire quand vous voulez"],
    steps: ["Fichier", "Email", "Envoi"],
    drop: {
      title: "Glissez une vidéo ici",
      text: "ou choisissez un fichier · MP4, MOV, WebM",
      footer: "2 Go maximum · aucun compte",
    },
    notVideo: "Ce fichier n'est pas une vidéo",
    tooBig: "Cette vidéo dépasse 2 Go",
    tooBigHint: "Exportez-la en 1080p ou coupez-la en deux parties.",
    otherFile: "Choisir un autre fichier",
    checkedLocally: "Vérifié dans le navigateur, rien n'a été envoyé.",
    change: "Changer",
    emailLabel: "Votre email · obligatoire",
    emailHint:
      "Vous y recevez l'avis « vidéo prête », puis les commentaires, auxquels vous pourrez répondre par email.",
    send: "Envoyer la vidéo",
    creating: "Préparation…",
    sentOf: (sent: string, total: string) => `${sent} sur ${total}`,
    eta: (s: string) => `environ ${s}`,
    resumed: (at: string) => `Connexion rétablie, envoi repris à ${at}`,
    resumedHint: (chunk: string) =>
      `Le fichier part par morceaux de ${chunk} (tus) : rien n'est renvoyé deux fois.`,
    shareTitle: "Lien de partage, déjà actif",
    copy: "Copier",
    copied: "Copié",
    keepOpen: "Gardez cet onglet ouvert. À la fin, vous arrivez sur la page de la vidéo.",
    pause: "Mettre en pause",
    resume: "Reprendre",
    paused: "En pause",
    lost: "Connexion perdue",
    lostHint: (sent: string) =>
      `Les ${sent} déjà envoyés sont conservés. L'envoi reprendra tout seul, même après avoir rechargé la page.`,
    retryIn: (s: number) => `nouvel essai dans ${s} s`,
    retryNow: "Reprendre maintenant",
    cancel: "Annuler",
    pendingTitle: "Un envoi n'est pas terminé",
    pendingText: (name: string, pct: number) =>
      `${name} s'est arrêté à ${pct} %. Sélectionnez à nouveau le même fichier pour continuer.`,
    pendingResume: "Reprendre l'envoi",
    pendingRestart: "Recommencer",
    pendingNote: "URL tus mémorisée dans ce navigateur",
    wrongFile: "Ce n'est pas le même fichier : choisissez celui de l'envoi interrompu.",
    done: "Vidéo reçue",
    doneText:
      "Ouverture de la page de la vidéo… L'encodage et la transcription continuent pendant que vous partagez le lien.",
    doneNote: (path: string, email: string) => `→ ${path} · notifications envoyées à ${email}`,
    failed: "L'envoi a échoué. Réessayez dans un instant.",
  },
} as const;
