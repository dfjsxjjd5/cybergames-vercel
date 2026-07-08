const STEAM_REGIONS = [
  { code: "USD", label: "Доллары", cc: "us" },
  { code: "RUB", label: "Рубли", cc: "ru" },
  { code: "KZT", label: "Тенге", cc: "kz" },
  { code: "UAH", label: "Гривны", cc: "ua" }
];

const EPIC_REGIONS = [
  { code: "USD", label: "Доллары", country: "US", locale: "en-US" },
  { code: "RUB", label: "Рубли", country: "RU", locale: "ru-RU" },
  { code: "KZT", label: "Тенге", country: "KZ", locale: "ru-RU" },
  { code: "UAH", label: "Гривны", country: "UA", locale: "ru-RU" }
];

const EPIC_GRAPHQL_ENDPOINTS = [
  "https://www.epicgames.com/graphql",
  "https://store.epicgames.com/graphql"
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

function scoreTitleMatch(query, candidate) {
  const q = normalizeTitle(query);
  const c = normalizeTitle(candidate);

  if (!q || !c) return 0;
  if (q === c) return 1;
  if (c.includes(q) || q.includes(c)) return 0.82;

  const qWords = q.split(" ").filter((word) => word.length > 2);
  const cWords = new Set(c.split(" ").filter((word) => word.length > 2));
  if (!qWords.length) return 0;

  const matched = qWords.filter((word) => cWords.has(word)).length;
  return matched / qWords.length;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "User-Agent": "Mozilla/5.0 CyberGames Vercel API",
      "Accept": "application/json",
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

async function searchSteam(title) {
  const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(title)}&l=english&cc=us`;
  const data = await fetchJson(url);
  const items = Array.isArray(data.items) ? data.items : [];

  if (!items.length) return null;

  let best = null;
  let bestScore = 0;

  for (const item of items) {
    const score = scoreTitleMatch(title, item.name);
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }

  // Не принимаем совсем левые совпадения. Да, лучше меньше, но честнее.
  if (best && bestScore >= 0.58) return best;
  return null;
}

function pickSteamDetails(appId, data) {
  const row = data && data[String(appId)];
  if (!row || !row.success || !row.data) return null;
  return row.data;
}

async function fetchSteamDetails(appId, cc = "us") {
  const filters = "basic,genres,categories,screenshots,price_overview,release_date";
  const url = `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=${cc}&l=russian&filters=${encodeURIComponent(filters)}`;
  const data = await fetchJson(url);
  return pickSteamDetails(appId, data);
}

async function fetchSteamPrices(appId) {
  const result = {};

  await Promise.all(STEAM_REGIONS.map(async (region) => {
    try {
      const details = await fetchSteamDetails(appId, region.cc);

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

function steamHeader(appId) {
  return `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/header.jpg`;
}

function normalizeSteamGame(originalTitle, appId, details, prices) {
  const title = details.name || originalTitle;
  const screenshots = Array.isArray(details.screenshots)
    ? details.screenshots.map((screen) => screen.path_full || screen.path_thumbnail).filter(Boolean).slice(0, 8)
    : [];

  const genres = Array.isArray(details.genres)
    ? details.genres.map((genre) => genre.description).filter(Boolean)
    : [];

  const categories = Array.isArray(details.categories)
    ? details.categories.map((category) => category.description).filter(Boolean)
    : [];

  return {
    provider: "steam",
    appId,
    title,
    type: details.type || "game",
    isFree: Boolean(details.is_free),
    releaseDate: details.release_date?.date || "—",
    description: stripHtml(details.short_description || details.about_the_game || "Описание не найдено в Steam."),
    cover: details.capsule_imagev5 || details.capsule_image || details.header_image || steamHeader(appId),
    cardImage: details.header_image || steamHeader(appId),
    header: details.header_image || steamHeader(appId),
    portrait: steamPortrait(appId),
    hero: steamHero(appId),
    screenshots,
    genres,
    categories,
    prices,
    storeUrl: `https://store.steampowered.com/app/${appId}/`
  };
}

const EPIC_SEARCH_QUERY = `
  query searchStoreQuery($country: String!, $keywords: String, $locale: String, $count: Int, $start: Int, $withPrice: Boolean = true) {
    Catalog {
      searchStore(
        count: $count
        country: $country
        keywords: $keywords
        locale: $locale
        start: $start
        withPrice: $withPrice
      ) {
        elements {
          title
          id
          namespace
          description
          effectiveDate
          keyImages {
            type
            url
          }
          seller {
            id
            name
          }
          productSlug
          urlSlug
          url
          developerDisplayName
          publisherDisplayName
          categories {
            path
          }
          catalogNs {
            mappings(pageType: "productHome") {
              pageSlug
              pageType
            }
          }
          offerMappings {
            pageSlug
            pageType
          }
          price(country: $country) @include(if: $withPrice) {
            totalPrice {
              discountPrice
              originalPrice
              discount
              currencyCode
              fmtPrice(locale: $locale) {
                originalPrice
                discountPrice
                intermediatePrice
              }
            }
          }
          releaseDate
          pcReleaseDate
        }
      }
    }
  }
`;

async function fetchEpicGraphQL(query, variables) {
  let lastError;

  for (const endpoint of EPIC_GRAPHQL_ENDPOINTS) {
    try {
      const data = await fetchJson(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Origin": "https://store.epicgames.com",
          "Referer": "https://store.epicgames.com/"
        },
        body: JSON.stringify({ query, variables })
      });

      if (data.errors && data.errors.length) {
        throw new Error(data.errors[0]?.message || "Epic GraphQL error");
      }

      return data;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

async function searchEpic(title, country = "US", locale = "ru-RU") {
  const variables = {
    country,
    locale,
    keywords: title,
    count: 12,
    start: 0,
    withPrice: true
  };

  const data = await fetchEpicGraphQL(EPIC_SEARCH_QUERY, variables);
  const elements = data?.data?.Catalog?.searchStore?.elements || [];

  if (!elements.length) return null;

  let best = null;
  let bestScore = 0;

  for (const item of elements) {
    const score = scoreTitleMatch(title, item.title);
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }

  if (best && bestScore >= 0.58) return best;
  return null;
}

function pickEpicImage(images, types) {
  if (!Array.isArray(images)) return "";
  const lowerTypes = types.map((type) => type.toLowerCase());

  const found = images.find((image) => {
    const type = String(image.type || "").toLowerCase();
    return lowerTypes.some((wanted) => type.includes(wanted));
  });

  return found?.url || "";
}

function epicStoreUrl(item, title) {
  const slug =
    item?.productSlug ||
    item?.urlSlug ||
    item?.catalogNs?.mappings?.find((mapping) => mapping.pageSlug)?.pageSlug ||
    item?.offerMappings?.find((mapping) => mapping.pageSlug)?.pageSlug ||
    "";

  if (item?.url && /^https?:\/\//i.test(item.url)) return item.url;
  if (slug) return `https://store.epicgames.com/ru/p/${slug}`;
  return `https://store.epicgames.com/ru/browse?q=${encodeURIComponent(title)}&sortBy=relevancy&sortDir=DESC&count=40`;
}

function epicPriceFromItem(item) {
  const total = item?.price?.totalPrice;

  if (!total) {
    return { label: "Уточнить", free: false, unavailable: true };
  }

  const finalPrice = Number(total.discountPrice);
  const originalPrice = Number(total.originalPrice);
  const formatted = total.fmtPrice?.discountPrice || total.fmtPrice?.intermediatePrice || total.fmtPrice?.originalPrice;
  const discount = Number(total.discount) || 0;

  if (Number.isFinite(finalPrice) && finalPrice === 0) {
    return { label: "Бесплатно", free: true, unavailable: false, discount };
  }

  if (formatted) {
    return { label: formatted, free: false, unavailable: false, discount };
  }

  if (Number.isFinite(finalPrice)) {
    const decimals = total.currencyCode === "JPY" ? 0 : 2;
    return {
      label: `${(finalPrice / 100).toFixed(decimals)} ${total.currencyCode || ""}`.trim(),
      free: false,
      unavailable: false,
      discount
    };
  }

  if (Number.isFinite(originalPrice) && originalPrice === 0) {
    return { label: "Бесплатно", free: true, unavailable: false, discount };
  }

  return { label: "Уточнить", free: false, unavailable: true };
}

async function fetchEpicPrices(title) {
  const result = {};

  await Promise.all(EPIC_REGIONS.map(async (region) => {
    try {
      const item = await searchEpic(title, region.country, region.locale);
      result[region.code] = item ? epicPriceFromItem(item) : { label: "Недоступно", free: false, unavailable: true };
    } catch {
      result[region.code] = { label: "Уточнить", free: false, unavailable: true };
    }
  }));

  return result;
}

function cleanEpicCategory(path) {
  const raw = String(path || "")
    .split("/")
    .filter(Boolean)
    .pop() || "";

  if (!raw) return "";

  const map = {
    games: "Игры",
    editions: "Издания",
    applications: "Приложения",
    addons: "Дополнения",
    bundles: "Наборы",
    editors: "Редакторы"
  };

  const key = raw.toLowerCase();
  if (map[key]) return map[key];

  return raw
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function uniqueList(values) {
  const seen = new Set();
  const result = [];

  values
    .filter(Boolean)
    .map((item) => String(item).trim())
    .filter(Boolean)
    .forEach((item) => {
      const key = normalizeTitle(item);
      if (!key || seen.has(key)) return;
      seen.add(key);
      result.push(item);
    });

  return result;
}

function normalizeEpicGame(originalTitle, item, prices) {
  const images = item.keyImages || [];
  const wide =
    pickEpicImage(images, ["OfferImageWide", "DieselStoreFrontWide", "DieselGameBoxLogo", "Thumbnail"]) ||
    images[0]?.url ||
    "";

  const tall =
    pickEpicImage(images, ["DieselStoreFrontTall", "OfferImageTall", "DieselGameBox", "VaultClosed"]) ||
    wide;

  const screenshots = images
    .filter((image) => {
      const type = String(image.type || "").toLowerCase();
      return type.includes("screenshot") || type.includes("wide") || type.includes("featured");
    })
    .map((image) => image.url)
    .filter(Boolean)
    .slice(0, 8);

  const categories = Array.isArray(item.categories)
    ? uniqueList(item.categories.map((category) => cleanEpicCategory(category.path)).filter(Boolean)).slice(0, 8)
    : [];

  const epicGenres = categories.length ? categories : ["Epic Games Store"];

  const releaseDate = item.pcReleaseDate || item.releaseDate || item.effectiveDate || "—";
  const title = item.title || originalTitle;

  return {
    provider: "epic",
    epicId: item.id,
    namespace: item.namespace,
    title,
    type: "game",
    isFree: Object.values(prices || {}).some((price) => price.free),
    releaseDate,
    description: stripHtml(item.description || "Описание найдено в Epic Games Store."),
    cover: tall || wide,
    cardImage: wide || tall,
    header: wide || tall,
    portrait: tall || wide,
    hero: wide || tall,
    screenshots,
    genres: epicGenres,
    categories,
    prices,
    storeUrl: epicStoreUrl(item, title),
    developer: item.developerDisplayName || "",
    publisher: item.publisherDisplayName || ""
  };
}

function mergeGames(originalTitle, steamGame, epicGame, appId) {
  const primary = steamGame || epicGame;

  if (!primary) return null;

  const prices = {};
  const sources = {};

  if (steamGame) {
    prices.steam = steamGame.prices;
    sources.steam = {
      ok: true,
      appId: steamGame.appId,
      title: steamGame.title,
      url: steamGame.storeUrl
    };
  }

  if (epicGame) {
    prices.epic = epicGame.prices;
    sources.epic = {
      ok: true,
      epicId: epicGame.epicId,
      namespace: epicGame.namespace,
      title: epicGame.title,
      url: epicGame.storeUrl
    };
  }

  const screenshots = [
    ...(steamGame?.screenshots || []),
    ...(epicGame?.screenshots || [])
  ].filter((url, index, arr) => url && arr.indexOf(url) === index).slice(0, 10);

  const genres = uniqueList([
    ...(steamGame?.genres || []),
    ...(epicGame?.genres || [])
  ]).slice(0, 12);

  const categories = uniqueList([
    ...(steamGame?.categories || []),
    ...(epicGame?.categories || [])
  ]).slice(0, 16);

  return {
    ok: true,
    status: "found",
    provider: steamGame && epicGame ? "steam+epic" : primary.provider,
    primarySource: primary.provider,
    sources,
    originalTitle,
    appId: steamGame?.appId || appId || null,
    epicId: epicGame?.epicId || null,
    title: primary.title || originalTitle,
    type: primary.type || "game",
    isFree: Boolean(steamGame?.isFree || epicGame?.isFree),
    releaseDate: primary.releaseDate || "—",
    description: primary.description || "Описание не найдено.",
    cover: primary.cover || "",
    cardImage: steamGame?.cardImage || epicGame?.cardImage || primary.cardImage || primary.header || primary.cover || "",
    header: steamGame?.header || epicGame?.header || primary.header || "",
    portrait: primary.portrait || primary.cover || "",
    hero: steamGame?.hero || epicGame?.hero || primary.hero || primary.header || "",
    screenshots,
    genres,
    categories,
    prices,
    stores: {
      steam: steamGame?.storeUrl || `https://store.steampowered.com/search/?term=${encodeURIComponent(originalTitle)}`,
      epic: epicGame?.storeUrl || `https://store.epicgames.com/ru/browse?q=${encodeURIComponent(originalTitle)}&sortBy=relevancy&sortDir=DESC&count=40`,
      gog: `https://www.gog.com/en/games?query=${encodeURIComponent(primary.title || originalTitle)}`
    }
  };
}

async function getSteamGame(title, appIdFromQuery) {
  try {
    let appId = appIdFromQuery;

    if (!appId) {
      const searchResult = await searchSteam(title);
      appId = searchResult?.id ? Number(searchResult.id) : null;
    }

    if (!appId) return null;

    const details = await fetchSteamDetails(appId, "us");
    if (!details) return null;

    const prices = await fetchSteamPrices(appId);
    return normalizeSteamGame(title, appId, details, prices);
  } catch {
    return null;
  }
}

async function getEpicGame(title) {
  try {
    const item = await searchEpic(title, "US", "ru-RU");
    if (!item) return null;

    const prices = await fetchEpicPrices(item.title || title);
    return normalizeEpicGame(title, item, prices);
  } catch {
    return null;
  }
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

  const originalTitle = title || String(appIdFromQuery);

  try {
    const [steamGame, epicGame] = await Promise.all([
      getSteamGame(originalTitle, appIdFromQuery),
      getEpicGame(originalTitle)
    ]);

    const merged = mergeGames(originalTitle, steamGame, epicGame, appIdFromQuery);

    if (!merged) {
      res.status(404).json({
        ok: false,
        status: "not_found",
        provider: "none",
        title: originalTitle,
        appId: appIdFromQuery,
        reason: "Steam и Epic Games Store не нашли игру или не отдали данные",
        stores: {
          steam: `https://store.steampowered.com/search/?term=${encodeURIComponent(originalTitle)}`,
          epic: `https://store.epicgames.com/ru/browse?q=${encodeURIComponent(originalTitle)}&sortBy=relevancy&sortDir=DESC&count=40`,
          gog: `https://www.gog.com/en/games?query=${encodeURIComponent(originalTitle)}`
        }
      });
      return;
    }

    res.setHeader("Cache-Control", "s-maxage=21600, stale-while-revalidate=86400");
    res.status(200).json(merged);
  } catch (error) {
    res.status(500).json({
      ok: false,
      status: "error",
      title: originalTitle,
      appId: appIdFromQuery,
      error: error.message || "Ошибка API",
      stores: {
        steam: `https://store.steampowered.com/search/?term=${encodeURIComponent(originalTitle)}`,
        epic: `https://store.epicgames.com/ru/browse?q=${encodeURIComponent(originalTitle)}&sortBy=relevancy&sortDir=DESC&count=40`,
        gog: `https://www.gog.com/en/games?query=${encodeURIComponent(originalTitle)}`
      }
    });
  }
};
