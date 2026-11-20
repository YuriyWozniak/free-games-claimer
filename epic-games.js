// import { chromium } from 'playwright-chromium';
import { chromium } from 'patchright';
import { authenticator } from 'otplib';
import chalk from 'chalk';
import path from 'path';
import { existsSync, writeFileSync } from 'fs';
import { resolve, jsonDb, datetime, dateFromStr, filenamify, prompt, confirm, notify, html_game_list, handleSIGINT } from './src/util.js';
import { cfg } from './src/config.js';
import { getMobileGames } from './src/epic-games-mobile.js';

const getGameUrls = async () => {
  // const params = new URLSearchParams({ locale: 'en-US', country: 'US', allowCountries: 'US' });
  // const body = await (await fetch(`https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions?${params}`)).json();
  const body = await (await fetch('https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions')).json();
  const now = new Date();
  const slug = ({ catalogNs, offerMappings, productSlug, urlSlug }) =>
    catalogNs?.mappings?.find(m => m.pageType === 'productHome')?.pageSlug ?? catalogNs?.mappings?.[0]?.pageSlug
    ?? offerMappings?.find(m => m.pageType === 'productHome')?.pageSlug ?? offerMappings?.[0]?.pageSlug
    ?? productSlug?.replace(/\/home$/, '')
    ?? urlSlug;
  return (body.data?.Catalog?.searchStore?.elements ?? [])
    .filter(e => e.promotions?.promotionalOffers?.some(({ promotionalOffers }) =>
      promotionalOffers?.some(({ startDate, endDate, discountSetting }) =>
        discountSetting?.discountPercentage === 0 && new Date(startDate) <= now && now <= new Date(endDate)
      )
    ))
    .map(slug)
    .filter(Boolean)
    .map(s => `https://store.epicgames.com/en-US/p/${s}`);
};

const screenshot = (...a) => resolve(cfg.dir.screenshots, 'epic-games', ...a);

const URL_CLAIM = 'https://store.epicgames.com/en-US/free-games';
const URL_LOGIN = 'https://www.epicgames.com/id/login?lang=en-US&noHostRedirect=true&redirectUrl=' + URL_CLAIM;
const BUY_BUTTON_SELECTOR = 'button[data-testid="purchase-cta-button"], button[class*="_sidebarBuyButton"]';
const CHECKOUT_IFRAME_SELECTOR = 'iframe[title="Checkout"], iframe[src*="checkout"], #webPurchaseContainer iframe';

console.log(datetime(), 'started checking epic-games');

const db = await jsonDb('epic-games.json', {});

if (cfg.time) console.time('startup');

// https://playwright.dev/docs/auth#multi-factor-authentication
const context = await chromium.launchPersistentContext(cfg.dir.browser, {
  // channel: 'chrome', // recommended, but `npx patchright install chrome` clashes with system Chrome - https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-nodejs#best-practice----use-chrome-without-fingerprint-injection
  headless: false, // don't use cfg.headless headless here since SHOW=0 will lead to captcha
  viewport: { width: cfg.width, height: cfg.height },
  locale: 'en-US', // ignore OS locale to be sure to have english text for locators
  recordVideo: cfg.record ? { dir: 'data/record/', size: { width: cfg.width, height: cfg.height } } : undefined, // will record a .webm video for each page navigated; without size, video would be scaled down to fit 800x800
  recordHar: cfg.record ? { path: `data/record/eg-${filenamify(datetime())}.har` } : undefined, // will record a HAR file with network requests and responses; can be imported in Chrome devtools
  handleSIGINT: false, // have to handle ourselves and call context.close(), otherwise recordings from above won't be saved
  // https://peter.sh/experiments/chromium-command-line-switches/
  chromiumSandbox: true, // keep Chromium's sandbox (Playwright otherwise adds --no-sandbox); fails only in Docker
  args: [
    '--hide-crash-restore-bubble',
    '--force-device-scale-factor=1', '--window-position=0,0', // page 1:1 with screen pixels, also with Windows display scaling
    '--test-type', // no "unsupported command-line flag" bar for Patchright's AutomationControlled flag
    '--ignore-gpu-blocklist', // required for OpenGL: Disabled -> Enabled & WebGL: Software only -> Hardware accelerated
    '--enable-unsafe-webgpu', // required for WebGPU: Disabled -> Hardware accelerated
  ],
  // The following makes the browser crash in docker with 'Chromium sandboxing failed!':
  // chromiumSandbox: true, // https://github.com/Kaliiiiiiiiii-Vinyzu/patchright/issues/52
});

// console.log(context.browser().browserType()); // browser is null...
if (cfg.debug) console.log(chromium.executablePath());

handleSIGINT(context);

if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);

const page = context.pages().length ? context.pages()[0] : await context.newPage(); // should always exist
await context.newCDPSession(page).then(async s => { const { windowId } = await s.send('Browser.getWindowForTarget'); await s.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } }); }).catch(e => console.error('maximize:', e.message)); // maximized window (--start-maximized is ignored)
// await page.setViewportSize({ width: cfg.width, height: cfg.height }); // TODO workaround for https://github.com/vogler/free-games-claimer/issues/277 until Playwright fixes it

// some debug info about the page (screen dimensions, user agent, platform)
if (cfg.debug) console.debug(await page.evaluate(() => [(({ width, height, availWidth, availHeight }) => ({ width, height, availWidth, availHeight }))(window.screen), navigator.userAgent, navigator.platform, navigator.vendor])); // deconstruct screen needed since `window.screen` prints {}, `window.screen.toString()` '[object Screen]', and can't use some pick function without defining it on `page`
if (cfg.debug_network) {
  // const filter = _ => true;
  const filter = r => r.url().includes('store.epicgames.com');
  page.on('request', request => filter(request) && console.log('>>', request.method(), request.url()));
  page.on('response', response => filter(response) && console.log('<<', response.status(), response.url()));
}

const notify_games = [];
let user;

try {
  await context.addCookies([
    { name: 'OptanonAlertBoxClosed', value: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(), domain: '.epicgames.com', path: '/' }, // Accept cookies to get rid of banner to save space on screen. Set accept time to 5 days ago.
    { name: 'HasAcceptedAgeGates', value: 'USK:9007199254740991,general:18,EPIC SUGGESTED RATING:18', domain: 'store.epicgames.com', path: '/' }, // gets rid of 'To continue, please provide your date of birth', https://github.com/vogler/free-games-claimer/issues/275, USK number doesn't seem to matter, cookie from 'Fallout 3: Game of the Year Edition'
  ]);

  await page.goto(URL_CLAIM, { waitUntil: 'domcontentloaded' }); // 'domcontentloaded' faster than default 'load' https://playwright.dev/docs/api/class-page#page-goto

  if (cfg.time) console.timeEnd('startup');
  if (cfg.time) console.time('login');

  // page.click('button:has-text("Accept All Cookies")').catch(_ => { }); // Not needed anymore since we set the cookie above. Clicking this did not always work since the message was animated in too slowly.
  page.locator('button:has-text("Continue")').click().catch(_ => { }); // already logged in, but need to accept updated "Epic Games Privacy Policy"

  while (await page.locator('egs-navigation').getAttribute('isloggedin') != 'true') {
    console.error('Not signed in anymore. Please login in the browser or here in the terminal.');
    if (cfg.nowait) process.exit(1);
    if (cfg.novnc_port) console.info(`Open http://localhost:${cfg.novnc_port} to login inside the docker container.`);
    if (!cfg.debug) context.setDefaultTimeout(cfg.login_timeout); // give user some extra time to log in
    console.info(`Login timeout is ${cfg.login_timeout / 1000} seconds!`);
    await page.goto(URL_LOGIN, { waitUntil: 'domcontentloaded' });
    if (cfg.eg_email && cfg.eg_password) console.info('Using email and password from environment.');
    else console.info('Press ESC to skip the prompts if you want to login in the browser (not possible in headless mode).');
    const notifyBrowserLogin = async () => {
      console.log('Waiting for you to login in the browser.');
      await notify('epic-games: no longer signed in and not enough options set for automatic login.');
      if (cfg.headless) {
        console.log('Run `SHOW=1 node epic-games` to login in the opened browser.');
        await context.close(); // finishes potential recording
        process.exit(1);
      }
    };
    const email = cfg.eg_email || await prompt({ message: 'Enter email' });
    if (!email) await notifyBrowserLogin();
    else {
      // await page.click('text=Sign in with Epic Games');
      page.waitForSelector('.h_captcha_challenge iframe').then(async () => {
        console.error('Got a captcha during login (likely due to too many attempts)! You may solve it in the browser, get a new IP or try again in a few hours.');
        await notify('epic-games: got captcha during login. Please check.');
      }).catch(_ => { });
      page.waitForSelector('p:has-text("Incorrect response.")').then(async () => {
        console.error('Incorrect response for captcha!');
      }).catch(_ => { });
      await page.fill('#email', email);
      await page.click('button#continue'); // login was split in two steps for some time, then email and password on the same form, now two steps again...
      const password = email && (cfg.eg_password || await prompt({ type: 'password', message: 'Enter password' }));
      if (!password) await notifyBrowserLogin();
      else {
        await page.fill('#password', password);
        await page.click('button#sign-in');
      }
      const error = page.locator('#form-error-message');
      error.waitFor().then(async () => {
        console.error('Login error:', await error.innerText());
        console.log('Please login in the browser!');
      }).catch(_ => { });
      // handle MFA, but don't await it
      page.waitForURL('**/id/login/mfa**').then(async () => {
        console.log('Enter the security code to continue - This appears to be a new device, browser or location. A security code has been sent to your email address at ...');
        // TODO locator for text (email or app?)
        const otp = cfg.eg_otpkey && authenticator.generate(cfg.eg_otpkey) || await prompt({ type: 'text', message: 'Enter two-factor sign in code', validate: n => n.toString().length == 6 || 'The code must be 6 digits!' }); // can't use type: 'number' since it strips away leading zeros and codes sometimes have them
        await page.locator('input[name="code-input-0"]').pressSequentially(otp.toString());
        await page.click('button[type="submit"]');
      }).catch(_ => { });
    }
    await page.waitForURL(URL_CLAIM);
    if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);
  }
  user = await page.locator('egs-navigation').getAttribute('displayname'); // 'null' if !isloggedin
  console.log(`Signed in as ${user}`);
  db.data[user] ||= {};
  if (cfg.time) console.timeEnd('login');
  if (cfg.time) console.time('claim all games');

  const urls = await getGameUrls();
  if (!urls.length) console.error('Seems like currently there are no free games available in your region...'); // see https://github.com/vogler/free-games-claimer/issues/210#issuecomment-1727420943

  // Free mobile games - https://github.com/vogler/free-games-claimer/issues/474
  // https://egs-platform-service.store.epicgames.com/api/v2/public/discover/home?count=10&country=DE&locale=en&platform=android&start=0&store=EGS
  if (cfg.eg_mobile) {
    console.log('Including mobile games...');
    const mobileGames = await getMobileGames(context);
    urls.push(...mobileGames.map(x => x.url));
  }

  console.log('Free games:', urls);

  for (const url of urls) {
    if (cfg.time) console.time('claim game');
    const game_id = url.split('/').pop();
    let game = db.data[user][game_id]; // undefined for new game, updated below

    // If game already existed in db and the date is more than a week in the past, add current datetime to existed list
    if (game?.time) {
      // Use the last entry in existed array if it exists, otherwise fall back to game.time
      const timeToCheck = game.existed?.slice(-1)[0] ?? game.time;
      const storedDate = dateFromStr(timeToCheck);
      const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      if (storedDate < oneWeekAgo) {
        game.existed ??= [];
        game.existed.push(datetime());
      }
    }
    if (game?.status == 'claimed') {
      console.log('Already claimed, skipping:', url);
      if (cfg.time) console.timeEnd('claim game');
      continue;
    }
    // random pauses between page loads and clicks (instant clicks triggered hCaptcha challenges)
    const pause = (min, max) => page.waitForTimeout(min + Math.random() * (max - min));
    // move the pointer like a hand: curved path in small steps, ease in/out, then press and release
    const mouseAt = globalThis.fgcMouse ??= { x: 300 + Math.random() * 500, y: 200 + Math.random() * 300 };
    const humanMove = async (x, y) => {
      const f = { ...mouseAt }, steps = 20 + Math.floor(Math.random() * 15);
      const cx = (f.x + x) / 2 + (Math.random() - 0.5) * 200, cy = (f.y + y) / 2 + (Math.random() - 0.5) * 150;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps, e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
        await page.mouse.move((1 - e) ** 2 * f.x + 2 * (1 - e) * e * cx + e * e * x, (1 - e) ** 2 * f.y + 2 * (1 - e) * e * cy + e * e * y);
        await page.waitForTimeout(8 + Math.random() * 25);
      }
      Object.assign(mouseAt, { x, y });
    };
    const scroll = async dy => { // wheel in small notches, like a mouse wheel
      for (let left = Math.abs(dy); left > 0; left -= 100) { await page.mouse.wheel(0, Math.sign(dy) * Math.min(100, left)); await page.waitForTimeout(40 + Math.random() * 120); }
    };
    const wander = async (n, scrolls = 0) => { // look around the page while "reading"
      const vp = page.viewportSize() || { width: 1280, height: 800 };
      for (let i = 0; i < n; i++) { await humanMove(100 + Math.random() * (vp.width - 200), 120 + Math.random() * (vp.height - 240)); await pause(400, 1500); }
      if (scrolls) { // read a bit further down, then come back to the button
        const dy = 300 + Math.floor(Math.random() * 500);
        await scroll(dy); await pause(1200, 3500); await scroll(-dy); await pause(500, 1200);
      }
    };
    const humanClick = async loc => {
      await loc.scrollIntoViewIfNeeded().catch(_ => { });
      const b = await loc.boundingBox().catch(_ => null); // page coordinates, also for elements inside the checkout iframe
      if (!b) return loc.click({ delay: 60 + Math.random() * 120 });
      await humanMove(b.x + b.width * (0.3 + Math.random() * 0.4), b.y + b.height * (0.3 + Math.random() * 0.4));
      await pause(250, 700);
      await page.mouse.down();
      await page.waitForTimeout(60 + Math.random() * 120);
      await page.mouse.up();
    };
    // watch for a captcha challenge a person has to solve (upstream only watches one selector in the checkout).
    // hCaptcha loads its challenge frame in advance and often passes without showing it, so it only counts when the
    // frame is really shown: at least 100x100, inside the viewport, not hidden/transparent, and on top at its centre.
    // While one is shown: log it once per game, save a screenshot (FGC_CAPTCHA_DIR, else the screenshots folder) and,
    // if FGC_LIVE is set, write a JSON note to that file (for outside notifications); the waits below go on for up to
    // CAPTCHA_WAIT after it was last seen, so it can be solved by hand. When it goes away, log after how long.
    // unref: the timer never keeps node running.
    const CAPTCHA_WAIT = 10 * 60 * 1000;
    const captchaRecent = () => Date.now() - (globalThis.fgcCaptchaAt || 0) < CAPTCHA_WAIT;
    globalThis.fgcGame = url; globalThis.fgcCaptchaAt = 0; globalThis.fgcCaptchaFrom = 0;
    const captchaShown = async () => {
      for (const f of page.frames()) {
        if (!/hcaptcha\.com.*frame=challenge|arkoselabs|funcaptcha/i.test(f.url())) continue;
        const el = await f.frameElement().catch(_ => null);
        if (el && await el.evaluate(e => {
          const r = e.getBoundingClientRect(), w = e.ownerDocument.defaultView;
          if (r.width < 100 || r.height < 100) return false;
          if (r.right <= 0 || r.bottom <= 0 || r.left >= w.innerWidth || r.top >= w.innerHeight) return false;
          for (let n = e; n && n.nodeType === 1; n = n.parentElement) {
            const st = w.getComputedStyle(n);
            if (st.display === 'none' || st.visibility === 'hidden' || +st.opacity < 0.1) return false;
          }
          const x = Math.min(Math.max(r.left + r.width / 2, 0), w.innerWidth - 1);
          const y = Math.min(Math.max(r.top + r.height / 2, 0), w.innerHeight - 1);
          const top = e.ownerDocument.elementFromPoint(x, y);
          return top === e || e.contains(top);
        }).catch(_ => false)) return true;
      }
      return false;
    };
    globalThis.fgcCaptcha ??= setInterval(async () => {
      if (globalThis.fgcCaptchaBusy) return;
      globalThis.fgcCaptchaBusy = true;
      try {
        if (!await captchaShown()) {
          if (globalThis.fgcCaptchaFrom) {
            console.error('  Captcha gone after ' + Math.round((Date.now() - globalThis.fgcCaptchaFrom) / 1000) + ' s.');
            globalThis.fgcCaptchaFrom = 0;
          }
          return;
        }
        globalThis.fgcCaptchaAt = Date.now();
        globalThis.fgcCaptchaFrom ||= Date.now();
        const seen = globalThis.fgcCaptchaSeen ??= new Set();
        if (seen.has(globalThis.fgcGame)) return;
        seen.add(globalThis.fgcGame);
        const title = (await page.title().catch(_ => '')).split(' | ')[0];
        console.error('  Got captcha challenge! Solve it in the browser window within 10 minutes; the claim continues after that.');
        if (process.env.FGC_LIVE) writeFileSync(process.env.FGC_LIVE, JSON.stringify({ captcha: globalThis.fgcGame, title, at: new Date().toISOString() }));
        const shot = 'captcha-' + new Date().toISOString().replace(/[:.]/g, '-') + '.png';
        await page.screenshot({ path: process.env.FGC_CAPTCHA_DIR ? resolve(process.env.FGC_CAPTCHA_DIR, shot) : screenshot(shot) }).catch(_ => {});
      } finally {
        globalThis.fgcCaptchaBusy = false;
      }
    }, 2000).unref();
    await pause(6000, 15000); // a person takes a while between games
    await page.goto(url); // , { waitUntil: 'domcontentloaded' });
    // when loading, the button text is empty -> need to wait for some text {'get', 'in library', 'requires base game'} -> just wait for e or i to not be too specific; :text-matches("\w+") somehow didn't work - https://github.com/vogler/free-games-claimer/issues/375
    // was using locator('...').first().waitFor(), but that at some point led to exception locator.waitFor: Error: Can't query n-th element
    // the redesign dropped data-testid="purchase-cta-button": find the purchase button by its label and mark it
    await page.waitForFunction(() => {
      const labels = /^(get|in library|owned|requires base game|add to library|claim)$/i;
      const btn = document.querySelector('button[data-testid="purchase-cta-button"]')
        || [...document.querySelectorAll('button')].find(b => b.offsetParent !== null && labels.test(b.textContent.trim()));
      if (!btn || !/[ei]/i.test(btn.textContent) || btn.textContent == 'Loading') return false;
      document.querySelectorAll('[data-fgc-cta]').forEach(e => e.removeAttribute('data-fgc-cta'));
      btn.setAttribute('data-fgc-cta', '1');
      return true;
    });
    const purchaseBtn = page.locator('button[data-fgc-cta]');
    const btnText = (await purchaseBtn.innerText()).toLowerCase(); // barrier to block until page is loaded

    // click Continue if 'This game contains mature content recommended only for ages 18+'
    if (await page.locator('button:has-text("Continue")').count() > 0) {
      console.log('  This game contains mature content recommended only for ages 18+');
      if (await page.locator('[data-testid="AgeSelect"]').count()) {
        console.error('  Got "To continue, please provide your date of birth" - This shouldn\'t happen due to cookie set above. Please report to https://github.com/vogler/free-games-claimer/issues/275');
        await page.locator('#month_toggle').click();
        await page.locator('#month_menu li:has-text("01")').click();
        await page.locator('#day_toggle').click();
        await page.locator('#day_menu li:has-text("01")').click();
        await page.locator('#year_toggle').click();
        await page.locator('#year_menu li:has-text("1987")').click();
      }
      await page.click('button:has-text("Continue")', { delay: 111 });
      await page.waitForTimeout(2000);
    }

    let title;
    let bundle_includes;
    if (await page.locator('span:text-is("About Bundle")').count()) {
      title = (await page.locator('span:has-text("Buy"):left-of(button[data-fgc-cta])').first().innerText()).replace('Buy ', '');
      // h1 first didn't exist for bundles but now it does... However h1 would e.g. be 'Fallout® Classic Collection' instead of 'Fallout Classic Collection'
      try {
        bundle_includes = await Promise.all((await page.locator('.product-card-top-row h5').all()).map(b => b.innerText()));
      } catch (e) {
        console.error('Failed to get "Bundle Includes":', e);
      }
    } else {
      title = await page.locator('h1').first().innerText();
    }
    game = db.data[user][game_id] ??= { title, time: datetime(), url: page.url() }; // this will be set on the initial run only!

    console.log('Current free game:', chalk.blue(title));
    if (bundle_includes) console.log('  This bundle includes:', bundle_includes);
    const notify_game = { title, url, status: 'failed' };
    notify_games.push(notify_game); // status is updated below

    if (btnText == 'in library') {
      console.log('  Already in library! Nothing to claim.');
      if (!game) await notify(`Game already in library: ${url}`);
      notify_game.status = 'existed';
      game.status ??= 'existed'; // does not overwrite claimed or failed
      if (game.status.startsWith('failed')) game.status = 'manual'; // was failed but now it's claimed
    } else if (btnText == 'requires base game') {
      console.log('  Requires base game! Nothing to claim.');
      notify_game.status = 'requires base game';
      game.status ??= 'failed:requires-base-game';
      // TODO claim base game if it is free
      const baseUrl = 'https://store.epicgames.com' + await page.locator('a:has-text("Overview")').getAttribute('href');
      console.log('  Base game:', baseUrl);
      // await page.click('a:has-text("Overview")');
      // TODO handle this via function call for base game above since this will never terminate if DRYRUN=1
      urls.push(baseUrl); // add base game to the list of games to claim
      urls.push(url); // add add-on itself again
    } else { // GET
      console.log('  Not in library yet! Click', btnText);
      await wander(2 + Math.floor(Math.random() * 2), 1); // read the page (and scroll) first, then move to Get and click
      await humanClick(purchaseBtn); // got stuck here without delay (or mouse move), see #75, 1ms was also enough

      // click Continue if 'Device not supported. This product is not compatible with your current device.' - avoided by Windows userAgent?
      // "Device not supported - This product is not compatible with your current device" (mobile items): click its visible Continue
      // "Welcome back" account picker (page, popup or login iframe): continue as the signed-in account
      const welcomeBack = async () => {
        for (const p of context.pages()) for (const f of p.frames()) {
          const r = await f.evaluate(name => {
            const text = document.body?.innerText || '';
            const vis = e => e.offsetParent !== null;
            if (/Welcome back/i.test(text)) {
              const card = [...document.querySelectorAll('button, a, [role=button], li')]
                .find(e => vis(e) && name && e.textContent.includes(name) && !/another account/i.test(e.textContent));
              if (card) { card.click(); return 'clicked'; }
            }
            if (/epicgames\.com\/id\//.test(location.href) && [...document.querySelectorAll('input[type=password]')].some(vis)) return 'password';
            return '';
          }, user).catch(_ => '');
          if (r) return r;
        }
        return '';
      };
      let wbClicks = 0, wbAt = -1;
      for (let i = 0; i < 90 || captchaRecent(); i++) { // a captcha on screen keeps the wait going
        const done = await page.evaluate(() => {
          if (document.querySelector('iframe[src*="/checkout?"], iframe[title="Checkout"]')) return true;
          const dlg = [...document.querySelectorAll('[role=dialog], section')].find(d => d.offsetParent !== null && /Device not supported/i.test(d.innerText));
          const btn = dlg && [...dlg.querySelectorAll('button')].find(b => /^continue$/i.test(b.textContent.trim()));
          if (btn) { btn.click(); return true; }
          return false;
        }).catch(_ => false);
        if (done) break;
        const wb = await welcomeBack();
        if (wb == 'password') {
          console.error('  Not signed in anymore: Epic asks for the password before the checkout. Sign in again.');
          if (cfg.nowait) process.exit(1);
        }
        if (wb == 'clicked' && wbClicks < 3) {
          wbClicks++; wbAt = i;
          console.log('  Epic asked to confirm the account ("Welcome back"): continued as', user);
          await page.waitForTimeout(3000);
          continue;
        }
        // back on the store page without a checkout: click Get once more
        if (wbAt >= 0 && i - wbAt == 16) {
          const again = await page.evaluate(() => {
            const b = [...document.querySelectorAll('button')].find(b => b.offsetParent !== null && /^get$/i.test(b.textContent.trim()));
            if (b) { b.click(); return true; }
            return false;
          }).catch(_ => false);
          if (again) console.log('  Clicked Get again after the account confirmation');
        }
        await page.waitForTimeout(500);
      }

      // click 'Yes, buy now' if 'This edition contains something you already have. Still interested?'
      page.click('button:has-text("Yes, buy now")').catch(_ => { });

      // Accept End User License Agreement (only needed once)
      page.locator(':has-text("end user license agreement")').waitFor().then(async () => {
        console.log('  Accept End User License Agreement (only needed once)');
        console.log(page.innerHTML);
        console.log('Please report the HTML above here: https://github.com/vogler/free-games-claimer/issues/371');
        await page.locator('input#agree').check(); // TODO Bundle: got stuck here; likely unrelated to bundle and locator just changed: https://github.com/vogler/free-games-claimer/issues/371
        await page.locator('button:has-text("Accept")').click();
      }).catch(_ => { });

      // it then creates an iframe for the purchase
      await page.waitForSelector(CHECKOUT_IFRAME_SELECTOR); // TODO needed?
      const iframe = page.frameLocator(CHECKOUT_IFRAME_SELECTOR);
      // skip game if unavailable in region, https://github.com/vogler/free-games-claimer/issues/46 TODO check games for account's region
      if (await iframe.locator(':has-text("unavailable in your region")').count() > 0) {
        console.error('  This product is unavailable in your region!');
        game.status = notify_game.status = 'unavailable-in-region';
        if (cfg.time) console.timeEnd('claim game');
        continue;
      }

      iframe.locator('.payment-pin-code').waitFor().then(async () => {
        if (!cfg.eg_parentalpin) {
          console.error('  EG_PARENTALPIN not set. Need to enter Parental Control PIN manually.');
          notify('epic-games: EG_PARENTALPIN not set. Need to enter Parental Control PIN manually.');
        }
        await iframe.locator('input.payment-pin-code__input').first().pressSequentially(cfg.eg_parentalpin);
        await iframe.locator('button:has-text("Continue")').click({ delay: 11 });
      }).catch(_ => { });

      if (cfg.debug) await page.pause();
      if (cfg.dryrun) {
        console.log('  DRYRUN=1 -> Skip order!');
        console.log('  DRYRUN check: checkout order button found:', await iframe.locator('button:has-text("Add to library"), button:has-text("Place Order")').first().waitFor({ timeout: 30000 }).then(() => true, () => false));
        await page.goto('about:blank').catch(_ => { }); // close the unused checkout before the next game
        notify_game.status = 'skipped';
        if (cfg.time) console.timeEnd('claim game');
        continue;
      }
      if (cfg.interactive && !await confirm()) {
        if (cfg.time) console.timeEnd('claim game');
        continue;
      }

      // Playwright clicked before button was ready to handle event, https://github.com/vogler/free-games-claimer/issues/84#issuecomment-1474346591
      // wait until the checkout's order button is ready, pause, move to it, click
      const orderBtn = iframe.locator('button:has-text("Add to library"):not(:has(.payment-loading--loading)), button:has-text("Place Order"):not(:has(.payment-loading--loading))').first();
      for (const t0 = Date.now(); !await orderBtn.isVisible().catch(_ => false); await page.waitForTimeout(1000))
        if (Date.now() - t0 > cfg.timeout && !captchaRecent()) throw new Error('checkout: no "Add to library" / "Place Order" button');
      await pause(2000, 4000);
      await wander(1);
      await humanClick(orderBtn);

      // I Agree button is only shown for EU accounts! https://github.com/vogler/free-games-claimer/pull/7#issuecomment-1038964872
      const btnAgree = iframe.locator('button:has-text("I Accept")');
      btnAgree.waitFor().then(() => btnAgree.click()).catch(_ => { }); // EU: wait for and click 'I Agree'
      try {
        // context.setDefaultTimeout(100 * 1000); // give time to solve captcha, iframe goes blank after 60s?
        const captcha = iframe.locator('#h_captcha_challenge_checkout_free_prod iframe');
        captcha.waitFor().then(async () => { // don't await, since element may not be shown
          // console.info('  Got hcaptcha challenge! NopeCHA extension will likely solve it.')
          console.error('  Got hcaptcha challenge! Lost trust due to too many login attempts? You can solve the captcha in the browser or get a new IP address.');
          // await notify(`epic-games: got captcha challenge right before claim of <a href="${url}">${title}</a>. Use VNC to solve it manually.`); // TODO not all apprise services understand HTML: https://github.com/vogler/free-games-claimer/pull/417
          await notify(`epic-games: got captcha challenge for.\nGame link: ${url}`);
          // TODO could even create purchase URL, see https://github.com/vogler/free-games-claimer/pull/130
          // await page.waitForTimeout(2000);
          // const p = path.resolve(cfg.dir.screenshots, 'epic-games', 'captcha', `${filenamify(datetime())}.png`);
          // await captcha.screenshot({ path: p });
          // console.info('  Saved a screenshot of hcaptcha challenge to', p);
          // console.error('  Got hcaptcha challenge. To avoid it, get a link from https://www.hcaptcha.com/accessibility'); // TODO save this link in config and visit it daily to set accessibility cookie to avoid captcha challenge?
        }).catch(_ => { }); // may time out if not shown
        iframe.locator('.payment__errors:has-text("Failed to challenge captcha, please try again later.")').waitFor().then(async () => {
          console.error('  Failed to challenge captcha, please try again later.');
          await notify('epic-games: failed to challenge captcha. Please check.');
        }).catch(_ => { });
        // poll for the confirmation; a captcha on screen extends the wait (solve it by hand).
        // Upstream's signals except 'text=Thank you' (too generic), plus any visible "In library" button.
        const confirmed = async () => (await Promise.all([
          '#launcher-onboard-install-prompt-title',
          'button:has-text("Yes, it\'s installed")',
          'text=It\'s all yours', // TODO Bundle: got stuck here, but normal game now as well
          'text=Download the Epic Games Launcher to play',
          'text=Is Epic Games Launcher installed?',
        ].map(sel => page.locator(sel).count().catch(_ => 0)))).some(n => n > 0)
          || await page.locator(BUY_BUTTON_SELECTOR).filter({ hasText: /in library/i }).count().catch(_ => 0) > 0
          || await page.evaluate(() => [...document.querySelectorAll('button')].some(b => b.offsetParent !== null && /^in library$/i.test(b.textContent.trim()))).catch(_ => false);
        for (const t0 = Date.now(); !await confirmed(); await page.waitForTimeout(1000))
          if (Date.now() - t0 > cfg.timeout && !captchaRecent()) throw new Error('no claim confirmation (timeout)');
        game.status = 'claimed';
        game.time = datetime(); // claimed time overwrites failed/dryrun time
        console.log('  Claimed successfully!');
        // context.setDefaultTimeout(cfg.timeout);
      } catch (e) {
        console.log(e);
        // console.error('  Failed to claim! Try again if NopeCHA timed out. Click the extension to see if you ran out of credits (refill after 24h). To avoid captchas try to get a new IP or set a cookie from https://www.hcaptcha.com/accessibility');
        console.error('  Failed to claim! To avoid captchas try to get a new IP address.');
        const p = screenshot('failed', `${game_id}_${filenamify(datetime())}.png`);
        await page.screenshot({ path: p, fullPage: true });
        game.status = 'failed';
      }
      notify_game.status = game.status; // claimed or failed

      const p = screenshot(`${game_id}.png`);
      if (!existsSync(p)) await page.screenshot({ path: p, fullPage: false }); // fullPage is quite long...
      await page.keyboard.press('Escape').catch(_ => { }); // close the launcher prompt
      await page.goto('about:blank').catch(_ => { });
    }
    if (cfg.time) console.timeEnd('claim game');
  }
} catch (error) {
  process.exitCode ||= 1;
  console.error('--- Exception:');
  console.error(error); // .toString()?
  if (error.message && process.exitCode != 130) notify(`epic-games failed: ${error.message.split('\n')[0]}`);
} finally {
  if (cfg.time) console.timeEnd('claim all games');
  await db.write(); // write out json db
  if (notify_games.filter(g => g.status == 'claimed' || g.status == 'failed').length) { // don't notify if all have status 'existed', 'manual', 'requires base game', 'unavailable-in-region', 'skipped'
    notify(`epic-games (${user}):<br>${html_game_list(notify_games)}`);
  }
}
if (cfg.debug) writeFileSync(path.resolve(cfg.dir.browser, 'cookies.json'), JSON.stringify(await context.cookies()));
if (page.video()) console.log('Recorded video:', await page.video().path());
await context.close();
