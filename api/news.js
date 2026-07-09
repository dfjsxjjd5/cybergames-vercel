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

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "User-Agent": "Mozilla/5.0 CyberGames Steam News API",
      "Accept": "application/json",
      ...(options.headers || {})
    }
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function fetchAppNews(appId, maxItems = 4) {
  const url = `https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=${encodeURIComponent(appId)}&count=${maxItems}&maxlength=420&format=json`;
  const data = await fetchJson(url);
  const items = data?.appnews?.newsitems || [];

  return items.map((item) => ({
    appId: Number(appId),
    gid: item.gid,
    title: item.title || "Steam News",
    url: item.url || `https://store.steampowered.com/news/app/${appId}`,
    author: item.author || "Steam",
    date: Number(item.date) || 0,
    contents: stripHtml(item.contents || ""),
    feedlabel: item.feedlabel || "Steam News"
  }));
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  const raw = String(req.query.appIds || req.query.appids || "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => /^\d+$/.test(id));

  const appIds = [...new Set(raw)].slice(0, 60);

  if (!appIds.length) {
    res.status(400).json({ ok: false, error: "Передай appIds через запятую" });
    return;
  }

  const since = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;

  try {
    const chunks = [];
    const workers = 6;
    const queue = [...appIds];

    async function worker() {
      while (queue.length) {
        const appId = queue.shift();
        try {
          const news = await fetchAppNews(appId, 5);
          chunks.push(...news);
        } catch {
          // Некоторые appId не отдают новости, это не должно ломать общий блок.
        }
      }
    }

    await Promise.all(Array.from({ length: workers }, worker));

    const items = chunks
      .filter((item) => item.date >= since)
      .sort((a, b) => b.date - a.date)
      .filter((item, index, arr) => arr.findIndex((other) => other.gid === item.gid) === index)
      .slice(0, 24);

    res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=7200");
    res.status(200).json({ ok: true, since, count: items.length, items });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "Ошибка Steam News API" });
  }
};
