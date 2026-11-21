'use strict';
/*
 * Client-side v3 checks (jsdom): loads the real public/index.html with
 * public/app.js inlined, a stub WebSocket and a stub fetch. Covers:
 *  1. a fresh wallet starts at 500 coins
 *  2. the Daily Gift claims +200 exactly once per day (idempotent)
 *  3. Quick Match tiers are blocked when the balance is too low
 *  4. the free rescue refill fires when broke (gift already claimed),
 *     then the cheapest tier can start
 *  5. the leaderboard panel renders fetched rows, medals and my highlight
 *  6. the avatar picker persists the chosen character
 * No server needed. Exits non-zero on the first failed check.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const pageHtml = html.replace('<script src="app.js"></script>', () => '<script>\n' + appJs + '\n</script>');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!cond) failures++;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const todayStr = () => { const d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); };

function makePage(seed) {
  const dom = new JSDOM(pageHtml, {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.WebSocket = class FakeWebSocket {
        constructor() { this.readyState = 0; window.__lastWs = this; }
        send() { /* never opens: no server in jsdom */ }
        close() { this.readyState = 3; }
      };
      if (seed) {
        for (const [k, v] of Object.entries(seed)) window.localStorage.setItem(k, v);
      }
    },
  });
  return dom;
}

async function main() {
  // 1 + 2: fresh wallet and the daily gift
  {
    const dom = makePage();
    const { document, localStorage } = dom.window;
    const balance = () => document.querySelector('.coin-balance').textContent;
    check('fresh wallet starts at 500 coins', balance() === '500', 'balance=' + balance());
    const gift = document.getElementById('btn-gift');
    check('daily gift starts claimable', !gift.disabled);
    gift.click();
    check('daily gift adds 200 coins', balance() === '700', 'balance=' + balance());
    check('gift button locks after claiming', gift.disabled === true);
    gift.click(); // disabled: must be a no-op
    check('daily gift is idempotent per day', balance() === '700', 'balance=' + balance());
    const w = JSON.parse(localStorage.getItem('uno-adda-wallet'));
    check('gift date persisted', w.lastGiftDate === todayStr(), w.lastGiftDate);
    dom.window.close();
  }

  // 3: tier gating when broke (gift + rescue both already used today)
  {
    const seed = { 'uno-adda-wallet': JSON.stringify({ balance: 30, lastGiftDate: todayStr(), lastRescueDate: todayStr() }) };
    const dom = makePage(seed);
    const { document } = dom.window;
    document.querySelector('.tier[data-tier="master"]').click();
    check('master tier blocked when balance < bet', document.getElementById('mm-modal').classList.contains('hidden'));
    check('gating explains itself', /Not enough coins/.test(document.getElementById('home-error').textContent),
      document.getElementById('home-error').textContent);
    check('blocked attempt does not touch the balance',
      document.querySelector('.coin-balance').textContent === '30',
      'balance=' + document.querySelector('.coin-balance').textContent);
    dom.window.close();
  }

  // 4: rescue refill, then Casual can start
  {
    const seed = { 'uno-adda-wallet': JSON.stringify({ balance: 0, lastGiftDate: todayStr(), lastRescueDate: '' }) };
    const dom = makePage(seed);
    const { document, localStorage } = dom.window;
    document.querySelector('.tier[data-tier="casual"]').click();
    const w = JSON.parse(localStorage.getItem('uno-adda-wallet'));
    check('rescue refill granted once (+100, then -20 stake)', w.balance === 80, 'balance=' + w.balance);
    check('rescue date persisted', w.lastRescueDate === todayStr(), w.lastRescueDate);
    check('matchmaking opens after rescue', !document.getElementById('mm-modal').classList.contains('hidden'));
    dom.window.close();
  }

  // 5: leaderboard rendering from a mocked fetch
  {
    const dom = makePage({ 'uno-adda-name': 'Player' });
    const { document } = dom.window;
    dom.window.fetch = async () => ({
      ok: true,
      json: async () => ({
        entries: [
          { name: 'Zed', avatar: 1, wins: 5, coinsWon: 900 },
          { name: 'Player', avatar: 2, wins: 1, coinsWon: 300 },
        ],
      }),
    });
    document.getElementById('btn-board').click();
    await sleep(60);
    const rows = document.querySelectorAll('.board-row');
    check('leaderboard renders fetched rows', rows.length === 2, 'rows=' + rows.length);
    check('top row carries the gold medal', rows.length > 0 && rows[0].textContent.includes('🥇') && rows[0].textContent.includes('Zed'));
    check('my row is highlighted', rows.length > 1 && rows[1].classList.contains('mine'));
    dom.window.close();
  }

  // 5b: leaderboard failure is graceful
  {
    const dom = makePage();
    const { document } = dom.window;
    dom.window.fetch = async () => { throw new Error('offline'); };
    document.getElementById('btn-board').click();
    await sleep(60);
    check('leaderboard failure shows a graceful empty state',
      /unavailable/i.test(document.getElementById('board-rows').textContent),
      document.getElementById('board-rows').textContent.trim());
    dom.window.close();
  }

  // 6: avatar picker persists
  {
    const dom = makePage();
    const { document, localStorage } = dom.window;
    document.getElementById('name-avatar').click();
    check('avatar picker opens from the home chip', !document.getElementById('avatar-modal').classList.contains('hidden'));
    document.querySelector('.pick-av[data-av="2"]').click();
    const p = JSON.parse(localStorage.getItem('uno-adda-profile'));
    check('chosen avatar persisted', p.avatar === 2, 'avatar=' + p.avatar);
    check('home chip shows the chosen character', document.getElementById('name-avatar').classList.contains('av2'),
      document.getElementById('name-avatar').className);
    dom.window.close();
  }

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
