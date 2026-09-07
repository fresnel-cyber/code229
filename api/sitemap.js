// GET /sitemap.xml (réécrit vers /api/sitemap, voir vercel.json)
// Généré dynamiquement à partir du registre partagé api/_lib/pages.js :
// ajouter une page là-bas suffit à la faire apparaître ici automatiquement,
// sans dupliquer la liste des URLs.
const { SITE_URL, ROUTES } = require('./_lib/pages');

module.exports = function handler(req, res) {
  const urls = Object.keys(ROUTES).map(function (route) {
    const r = ROUTES[route];
    return (
      '  <url>\n' +
      '    <loc>' + SITE_URL + route + '</loc>\n' +
      '    <changefreq>' + r.changefreq + '</changefreq>\n' +
      '    <priority>' + r.priority + '</priority>\n' +
      '  </url>'
    );
  }).join('\n');

  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls + '\n' +
    '</urlset>\n';

  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.status(200).send(xml);
};
