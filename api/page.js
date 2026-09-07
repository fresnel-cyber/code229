// Sert index.html avec les balises <title>/<meta description>/Open Graph
// réécrites pour chaque route publique (voir vercel.json pour les
// réécritures /entrainement, /fiches, /progression → ici). Nécessaire car
// CODE 229 est un fichier statique unique sans framework : sans ça, Google
// et les aperçus de lien (partage sur les réseaux) verraient le même
// <title>/<meta> sur toutes les pages, quelle que soit l'URL réellement
// visitée — mauvais pour le référencement et pour les aperçus de partage.
const fs = require('fs');
const path = require('path');
const { SITE_URL, ROUTES } = require('./_lib/pages');

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = function handler(req, res) {
  const route = req.query.route || '/';
  const meta = ROUTES[route] || ROUTES['/'];
  const canonical = SITE_URL + route;

  try {
    let html = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
    html = html
      .replace(/<title>.*?<\/title>/, '<title>' + escapeHtml(meta.title) + '</title>')
      .replace(/<meta name="description" content="[^"]*">/, '<meta name="description" content="' + escapeHtml(meta.description) + '">')
      .replace(/<meta property="og:url" content="[^"]*">/, '<meta property="og:url" content="' + canonical + '">')
      .replace(/<meta property="og:title" content="[^"]*">/, '<meta property="og:title" content="' + escapeHtml(meta.title) + '">')
      .replace(/<meta property="og:description" content="[^"]*">/, '<meta property="og:description" content="' + escapeHtml(meta.description) + '">')
      .replace(/<meta name="twitter:title" content="[^"]*">/, '<meta name="twitter:title" content="' + escapeHtml(meta.title) + '">')
      .replace(/<meta name="twitter:description" content="[^"]*">/, '<meta name="twitter:description" content="' + escapeHtml(meta.description) + '">')
      .replace(/<link rel="canonical" href="[^"]*">/, '<link rel="canonical" href="' + canonical + '">');

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    res.status(200).send(html);
  } catch (e) {
    console.error('page render error:', e);
    // Repli défensif : jamais de 500 sur une route publique. Pire cas, cette
    // page précise perd ses balises personnalisées mais rien ne casse pour
    // l'utilisateur, qui atterrit sur l'app normale.
    res.writeHead(302, { Location: '/' });
    res.end();
  }
};
