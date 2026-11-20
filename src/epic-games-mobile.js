// following https://github.com/vogler/free-games-claimer/issues/474
// - platforms from EG_MOBILE_PLATFORMS (comma-separated: android, ios; default android)
// - country from EG_COUNTRY (default DE)
// - looks through the paged response (start=0,4,8): the free-game module is not always in the first part
// - only offers that cost 0
// - reads the API with fetch() inside the open store page, so no tab with raw JSON appears; Cloudflare blocks plain
//   requests from node, so the JSON opened in a tab stays as the fallback
// - writes each free offer's direct checkout link (purchase?offers=1-<sandboxId>-<offerId>) to the file in FGC_OFFERS, if set
import { writeFileSync } from 'node:fs';

const country = process.env.EG_COUNTRY || 'DE';
const apiUrl = (platform, start) => `https://egs-platform-service.store.epicgames.com/api/v2/public/discover/home?count=10&country=${country}&locale=en&platform=${platform}&start=${start}&store=EGS`;
const url = s => `https://store.epicgames.com/en-US/p/${s}`;
export const checkoutUrl = (ns, id) => `https://store.epicgames.com/purchase?offers=1-${ns}-${id}#/purchase/payment-methods`;

const viaStorePage = async (store, u) => {
  for (const credentials of ['include', 'omit']) {
    const json = await store.evaluate(async ([u, c]) => {
      const res = await fetch(u, { credentials: c });
      return res.ok ? res.json() : null;
    }, [u, credentials]).catch(_ => null);
    if (json) return json;
  }
  return null;
};

export const getPlatformGames = async (context, platform) => {
  const store = context.pages().find(p => p.url().startsWith('https://store.epicgames.com'));
  let tab;
  try {
    for (const start of [0, 4, 8]) {
      let json = store && await viaStorePage(store, apiUrl(platform, start));
      if (!json) { // fallback: the JSON in a tab
        tab ??= await context.newPage();
        await tab.goto(apiUrl(platform, start));
        json = JSON.parse(await tab.innerText('body'));
      }
      const free_game = (json.data || []).filter(x => x.type == 'freeGame')[0];
      if (!free_game) continue;
      return free_game.offers
        .filter(offer => offer.content?.purchase?.some(p => p.price?.decimalPrice == 0))
        .map(offer => {
          const c = offer.content;
          const pay = c.purchase?.find(p => p.price?.decimalPrice == 0)?.purchasePayload || {};
          const ns = pay.sandboxId || offer.sandboxId, id = pay.offerId || offer.offerId;
          return { title: c.title, url: url(c.mapping.slug), platform, checkout: ns && id ? checkoutUrl(ns, id) : undefined };
        });
    }
    console.error(`No free ${platform} games module found.`);
    return [];
  } finally {
    if (tab) await tab.close();
  }
};

export const getMobileGames = async (context) => {
  const platforms = (process.env.EG_MOBILE_PLATFORMS || 'android').split(',').map(s => s.trim()).filter(Boolean);
  const r = [];
  for (const platform of platforms) r.push(...await getPlatformGames(context, platform));
  if (process.env.FGC_OFFERS) {
    try { writeFileSync(process.env.FGC_OFFERS, JSON.stringify(r.filter(g => g.checkout))); } catch (e) { console.error('offers file:', e.message); }
  }
  return r;
};
