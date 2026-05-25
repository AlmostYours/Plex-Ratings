const fs = require('fs');

const PLEX_URL   = process.env.PLEX_URL;
const PLEX_TOKEN = process.env.PLEX_TOKEN;

if (!PLEX_URL || !PLEX_TOKEN) {
  console.error('Missing PLEX_URL or PLEX_TOKEN environment variables.');
  process.exit(1);
}

// ── Config ───────────────────────────────────────────────────────────────────
const config = {
  ownerName:          process.env.OWNER_NAME           || 'My',
  showsTabLabel:      process.env.SHOWS_TAB_LABEL      || 'TV Shows',
  showsSectionLabel:  process.env.SHOWS_SECTION_LABEL  || 'TV Shows',
  moviesTabLabel:     process.env.MOVIES_TAB_LABEL     || 'Movies',
  moviesSectionLabel: process.env.MOVIES_SECTION_LABEL || 'Cinema',
  defaultTheme:       process.env.DEFAULT_THEME        || 'system',
};
fs.writeFileSync('config.json', JSON.stringify(config, null, 2));
console.log('config.json written:', config);

// ── Plex helpers ─────────────────────────────────────────────────────────────
async function plexGet(p) {
  const sep = p.includes('?') ? '&' : '?';
  const url = `${PLEX_URL}${p}${sep}X-Plex-Token=${PLEX_TOKEN}&X-Plex-Container-Start=0&X-Plex-Container-Size=5000`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Plex returned HTTP ${res.status} for ${p}`);
  return res.json();
}

async function downloadPoster(thumb, ratingKey) {
  if (!thumb) return null;
  const sep = thumb.includes('?') ? '&' : '?';
  const url = `${PLEX_URL}${thumb}${sep}X-Plex-Token=${PLEX_TOKEN}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buffer = await res.arrayBuffer();
    fs.mkdirSync('posters', { recursive: true });
    const filename = `posters/${ratingKey}.jpg`;
    fs.writeFileSync(filename, Buffer.from(buffer));
    return filename;
  } catch (e) {
    console.warn(`Failed to download poster for ${ratingKey}:`, e.message);
    return null;
  }
}

// Extract IMDb ID from either the new Guid array or legacy guid string
function extractImdbId(item) {
  if (Array.isArray(item.Guid)) {
    const g = item.Guid.find(g => g.id?.startsWith('imdb://'));
    if (g) return g.id.replace('imdb://', '');
  }
  if (item.guid) {
    const m = item.guid.match(/imdb:\/\/(tt\d+)/);
    if (m) return m[1];
  }
  return null;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Connecting to Plex...');
  const libData  = await plexGet('/library/sections');
  const sections = libData.MediaContainer?.Directory || [];
  console.log(`Found ${sections.length} library sections.`);

  const shows  = [];
  const movies = [];

  for (const sec of sections) {
    if (sec.type !== 'show' && sec.type !== 'movie') continue;

    console.log(`Scanning section: ${sec.title} (${sec.type})`);

    // Fetch with Guid data included
    const data  = await plexGet(`/library/sections/${sec.key}/all?includeGuids=1`);
    const items = data.MediaContainer?.Metadata || [];
    const rated = items.filter(i => i.userRating != null && i.userRating !== '');
    console.log(`  ${rated.length} rated items found.`);

    for (const item of rated) {
      const poster = await downloadPoster(item.thumb, item.ratingKey);
      const entry  = {
        ratingKey:  item.ratingKey,
        title:      item.title              || 'Untitled',
        year:       item.year               || null,
        summary:    item.summary            || '',
        userRating: parseFloat(item.userRating),
        studio:     item.studio             || null,
        contentRating: item.contentRating   || null,
        duration:   item.duration           || null,
        genres:     (item.Genre || []).map(g => g.tag),
        imdbId:     extractImdbId(item),
        type:       item.type,
        poster,
      };
      if (sec.type === 'show')  shows.push(entry);
      else                      movies.push(entry);
    }
  }

  const output = { shows, movies, updatedAt: new Date().toISOString() };
  fs.writeFileSync('data.json', JSON.stringify(output, null, 2));
  console.log(`Done. ${shows.length} shows, ${movies.length} movies written.`);
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
