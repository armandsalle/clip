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
} as const;
