const REGIONS = [
  { code: "USD", label: "Доллары", cc: "us" },
  { code: "RUB", label: "Рубли", cc: "ru" },
  { code: "KZT", label: "Тенге", cc: "kz" },
  { code: "UAH", label: "Гривны", cc: "ua" }
];

function normalizeTitle(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[™®©]/g, "")
    .replace(/['’`]/g, "")
    .replace(/[^a-zа-яё0-9]+/gi, " ")
    .replace(/\bthe\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 CyberGames Vercel API"
    }
  });

  if (!response.ok) {
    throw new Error(`Steam HTTP ${response.status}`);
  }

  return response.json();
}

async function searchSteam(title) {
  const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(title)}&l=english&cc=us`;
  const data = await fetchJson(url);
  const items = Array.isArray(data.items) ? data.items : [];

  if (!items.length) return null;

  const target = normalizeTitle(title);

  const exact = items.find((item) => normalizeTitle(item.name) === target);
  if (exact) return exact;

  const close = items.find((item) => {
    const name = normalizeTitle(item.name);
    return name.includes(target) || target.includes(name);
  });

  return close || items[0];
}

function pickAppDetails(appId, data) {
  const row = data && data[String(appId)];
  if (!row || !row.success || !row.data) return null;
  return row.data;
}

async function fetchAppDetails(appId, cc = "us") {
  const filters = "basic,genres,categories,screenshots,price_overview,release_date";
  const url = `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=${cc}&l=russian&filters=${encodeURIComponent(filters)}`;
  const data = await fetchJson(url);
  return pickAppDetails(appId, data);
}

async function fetchPrices(appId) {
  const result = {};

  await Promise.all(REGIONS.map(async (region) => {
    try {
      const details = await fetchAppDetails(appId, region.cc);

      if (!details) {
        result[region.code] = { label: "Недоступно", free: false, unavailable: true };
        return;
      }

      if (details.is_free) {
        result[region.code] = { label: "Бесплатно", free: true, unavailable: false };
        return;
      }

      const price = details.price_overview;

      if (price && price.final_formatted) {
        result[region.code] = {
          label: price.final_formatted,
          free: false,
          unavailable: false,
          discount: price.discount_percent || 0
        };
        return;
      }

      result[region.code] = { label: "Уточнить", free: false, unavailable: true };
    } catch {
      result[region.code] = { label: "Уточнить", free: false, unavailable: true };
    }
  }));

  return result;
}

function steamPortrait(appId) {
  return `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/library_600x900.jpg`;
}

function steamHero(appId) {
  return `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/library_hero.jpg`;
}

function storeLinks(title, appId) {
  return {
    steam: appId
      ? `https://store.steampowered.com/app/${appId}/`
      : `https://store.steampowered.com/search/?term=${encodeURIComponent(title)}`,
    gog: `https://www.gog.com/en/games?query=${encodeURIComponent(title)}`,
    epic: `https://store.epicgames.com/ru/browse?q=${encodeURIComponent(title)}&sortBy=relevancy&sortDir=DESC&count=40`
  };
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  const title = String(req.query.title || "").trim();
  const rawAppId = req.query.appId ? String(req.query.appId).trim() : "";
  const appIdFromQuery = /^\d+$/.test(rawAppId) ? Number(rawAppId) : null;

  if (!title && !appIdFromQuery) {
    res.status(400).json({ ok: false, error: "Передай title или appId" });
    return;
  }

  try {
    let appId = appIdFromQuery;
    let searchResult = null;

    if (!appId) {
      searchResult = await searchSteam(title);

      if (!searchResult || !searchResult.id) {
        res.status(404).json({
          ok: false,
          status: "not_found",
          title,
          reason: "Steam не нашёл игру",
          stores: storeLinks(title, null)
        });
        return;
      }

      appId = Number(searchResult.id);
    }

    const details = await fetchAppDetails(appId, "us");

    if (!details) {
      res.status(404).json({
        ok: false,
        status: "not_found",
        title,
        appId,
        reason: "Steam не отдал данные по appId",
        stores: storeLinks(title, appId)
      });
      return;
    }

    const resolvedTitle = details.name || searchResult?.name || title;
    const prices = await fetchPrices(appId);

    const screenshots = Array.isArray(details.screenshots)
      ? details.screenshots
          .map((screen) => screen.path_full || screen.path_thumbnail)
          .filter(Boolean)
          .slice(0, 8)
      : [];

    const genres = Array.isArray(details.genres)
      ? details.genres.map((genre) => genre.description).filter(Boolean)
      : [];

    const categories = Array.isArray(details.categories)
      ? details.categories.map((category) => category.description).filter(Boolean)
      : [];

    const response = {
      ok: true,
      status: "found",
      appId,
      title: resolvedTitle,
      originalTitle: title || resolvedTitle,
      type: details.type || "game",
      isFree: Boolean(details.is_free),
      releaseDate: details.release_date?.date || "—",
      description: stripHtml(details.short_description || details.about_the_game || "Описание не найдено в Steam."),
      cover: details.capsule_imagev5 || details.capsule_image || details.header_image || "",
      header: details.header_image || "",
      portrait: steamPortrait(appId),
      hero: steamHero(appId),
      screenshots,
      genres,
      categories,
      prices,
      stores: storeLinks(resolvedTitle, appId)
    };

    res.setHeader("Cache-Control", "s-maxage=21600, stale-while-revalidate=86400");
    res.status(200).json(response);
  } catch (error) {
    res.status(500).json({
      ok: false,
      status: "error",
      title,
      appId: appIdFromQuery,
      error: error.message || "Ошибка Steam API",
      stores: storeLinks(title, appIdFromQuery)
    });
  }
};
