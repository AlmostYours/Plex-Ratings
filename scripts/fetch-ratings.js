const fs = require('fs');

const PLEX_URL   = process.env.PLEX_URL;
const PLEX_TOKEN = process.env.PLEX_TOKEN;
const TMDB_API_KEY = process.env.TMDB_API_KEY;

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

// Extract TMDB ID from Plex's Guid array
function extractTmdbId(item) {
  if (Array.isArray(item.Guid)) {
    const g = item.Guid.find(g => g.id?.startsWith('tmdb://'));
    if (g) return g.id.replace('tmdb://', '');
  }
  return null;
}

// Fetch JustWatch link and provider logos from TMDB
async function getWatchProviders(tmdbId, imdbId, type, title) {
  // Debug: Check if the key made it into the environment
  if (!TMDB_API_KEY) {
    console.log(`[${title}] ⚠️ TMDB_API_KEY is missing from environment!`);
    return null;
  }
  if (!tmdbId && !imdbId) {
    console.log(`[${title}] ⚠️ No TMDB or IMDB ID available in Plex.`);
    return null;
  }

  try {
    const tmdbType = type === 'movie' ? 'movie' : 'tv';
    let finalTmdbId = tmdbId;

    // Fallback: If Plex didn't give us a TMDB ID, use IMDB ID to search TMDB for it
    if (!finalTmdbId && imdbId) {
      const findRes = await fetch(`https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`);
      if (findRes.ok) {
        const findData = await findRes.json();
        const results = tmdbType === 'movie' ? findData.movie_results : findData.tv_results;
        if (results && results.length > 0) {
          finalTmdbId = results[0].id;
        }
      }
    }

    if (!finalTmdbId) {
      console.log(`[${title}] ⚠️ Could not resolve TMDB ID.`);
      return null;
    }

    // Fetch the streaming providers
    const provRes = await fetch(`https://api.themoviedb.org/3/${tmdbType}/${finalTmdbId}/watch/providers?api_key=${TMDB_API_KEY}`);
    if (!provRes.ok) {
      console.log(`[${title}] ⚠️ TMDB API Error: ${provRes.status}`);
      return null;
    }
    
    const provData = await provRes.json();
    const usData = provData.results?.US;
    if (!usData) return null;

    const streams = [...(usData.flatrate || []), ...(usData.free || []), ...(usData.ads || [])];
    
    const uniqueStreams = [];
    const seen = new Set();
    for (const s of streams) {
      if (!seen.has(s.provider_id)) {
        seen.add(s.provider_id);
        uniqueStreams.push({
          name: s.provider_name,
          logo: `https://image.tmdb.org/t/p/original${s.logo_path}`
        });
      }
    }

    return uniqueStreams.length > 0 ? {
      link: usData.link,
      providers: uniqueStreams
    } : null;

  } catch (e) {
    console.log(`[${title}] ⚠️ Failed to fetch TMDB providers: ${e.message}`);
    return null;
  }
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
      // Fetch detailed metadata for this specific item to bypass Plex's 2-genre summary limit
      let detailedItem = item;
      try {
        const detailData = await plexGet(`/library/metadata/${item.ratingKey}`);
        if (detailData.MediaContainer && detailData.MediaContainer.Metadata) {
          detailedItem = detailData.MediaContainer.Metadata[0];
        }
      } catch (e) {
        console.warn(`Could not fetch details for ${item.ratingKey}, using basic data.`);
      }

      const poster = await downloadPoster(detailedItem.thumb || item.thumb, item.ratingKey);
      
      // Grab all genres and cap at 5
      const allGenres = (detailedItem.Genre || []).map(g => g.tag);
      const imdbId = extractImdbId(detailedItem) || extractImdbId(item);

      // Grab TMDB ID and fetch Where to Watch data
      const tmdbId = extractTmdbId(detailedItem) || extractTmdbId(item);
      const watchData = await getWatchProviders(tmdbId, imdbId, item.type, detailedItem.title || item.title);

      const entry  = {
        ratingKey:  item.ratingKey,
        title:      detailedItem.title              || 'Untitled',
        year:       detailedItem.year               || null,
        summary:    detailedItem.summary            || '',
        userRating: parseFloat(item.userRating),
        studio:     detailedItem.studio             || null,
        contentRating: detailedItem.contentRating   || null,
        duration:   detailedItem.duration           || null,
        genres:     allGenres.slice(0, 5),
        imdbId:     extractImdbId(detailedItem),
        type:       item.type,
        poster,
        whereToWatch: watchData
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
