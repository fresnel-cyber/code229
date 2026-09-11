// Registre unique des pages publiques indexables — source de vérité pour le
// rendu des balises SEO par route (api/page.js) ET pour le sitemap dynamique
// (api/sitemap.js) : ajouter une entrée ici suffit à faire apparaître la
// page aux deux endroits d'un coup. Garder en phase avec la petite copie
// dupliquée côté client dans index.html (ROUTE_META) qui met à jour
// document.title lors d'une navigation en SPA sans recharger la page.
const SITE_URL = 'https://www.code229.online';

const ROUTES = {
  '/': {
    title: 'CODE 229 — Révise le code de la route (Bénin)',
    description: "Révise le code de la route béninois avec les vrais panneaux et schémas du Manuel du candidat (DGTT) : diagnostic gratuit, répétition espacée, examen blanc en conditions.",
    priority: '1.0',
    changefreq: 'weekly'
  },
  '/entrainement': {
    title: 'Entraînement au code de la route | CODE 229',
    description: "Choisis ton mode de révision : session du jour, examen blanc chronométré, révision par chapitre ou reconnaissance des panneaux. Adapté à l'Afrique francophone.",
    priority: '0.8',
    changefreq: 'monthly'
  },
  '/fiches': {
    title: 'Fiches de révision du code de la route | CODE 229',
    description: "Toutes les fiches de révision du code de la route béninois : signalisation, priorités, vitesses, infractions... L'essentiel à connaître, chapitre par chapitre.",
    priority: '0.9',
    changefreq: 'monthly'
  },
  '/progression': {
    title: 'Suivi de progression | CODE 229',
    description: "Suis ta progression, tes badges et ton taux de réussite estimé pour l'examen du code de la route.",
    priority: '0.3',
    changefreq: 'monthly'
  }
};

module.exports = { SITE_URL, ROUTES };
