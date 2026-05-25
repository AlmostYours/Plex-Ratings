const fs   = require('fs');
const path = require('path');

const PLEX_URL   = process.env.PLEX_URL;
const PLEX_TOKEN = process.env.PLEX_TOKEN;

if (!PLEX_URL || !PLEX_TOKEN) {
  console.error('Missing PLEX_URL or PLEX_TOKEN environment variables.');
  process.exit(1);
}

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
    const data  = await plexGet(`/library/sections/${sec.key}/all`);
    const items = data.MediaContainer?.Metadata || [];
    const rated = items.filter(i => i.userRating != null && i.userRating !== '');
    console.log(`  ${rated.length} rated items found.`);

    for (const item of rated) {
      const poster = await downloadPoster(item.thumb, item.ratingKey);
      const entry  = {
        ratingKey:  item.ratingKey,
        title:      item.title      || 'Untitled',
        year:       item.year       || null,
        summary:    item.summary    || '',
        userRating: parseFloat(item.userRating),
        studio:     item.studio     || null,
        type:       item.type,
        poster,
      };

      if (sec.type === 'show')  shows.push(entry);
      else                      movies.push(entry);
    }
  }

  const output = {
    shows,
    movies,
    updatedAt: new Date().toISOString(),
  };

  fs.writeFileSync('data.json', JSON.stringify(output, null, 2));
  console.log(`Done. ${shows.length} shows and ${movies.length} movies written to data.json.`);
  console.log(`${shows.length + movies.length} posters saved to /posters.`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
