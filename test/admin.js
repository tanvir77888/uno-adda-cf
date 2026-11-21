'use strict';
/*
 * Admin control center + notifications + Web Push tests
 * (Additions 8 + 9). Expects wrangler dev at BASE_URL started with
 * --var ADMIN_PHONE:01711111111 (see run-local.sh), so the account
 * with that phone bootstraps as admin.
 * Covers: bootstrap + isAdmin in /me; 403 for non-admins on every
 * admin route; users list/detail; notify broadcast + direct with
 * unread counts and read flow; push subscribe replace-by-endpoint;
 * history; adjust-coins / grant-all math; reset-password session
 * kill; ban blocks login + unban restores; delete removes login;
 * leaderboard control; room registry + admin close (room_closed);
 * announcement via /api/settings; maintenance blocks normal login
 * and find_match but not the admin; audit rows per action type.
 */
import http from 'node:http';
import WebSocket from 'ws';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
const WS_BASE = BASE.replace(/^http/, 'ws');
const ADMIN_PHONE = '01711111111';
let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!cond) failures++;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (token) headers.Authorization = 'Bearer ' + token;
    const req = http.request(BASE + path, { method, headers }, (res) => {
      let out = '';
      res.on('data', (d) => out += d);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(out); } catch { /* not json */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function signup(phone, name) {
  const res = await request('POST', '/api/auth/signup', { phone, password: 'secret1', name });
  if (res.status !== 200) throw new Error('signup failed for ' + phone + ': ' + JSON.stringify(res.body));
  return { phone, token: res.body.token, profile: res.body.profile };
}
async function login(phone, password) {
  return request('POST', '/api/auth/login', { phone, password });
}

class Client {
  constructor() { this.states = []; this.msgs = []; this.latest = null; }
  open(path = '/ws') {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(WS_BASE + path);
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        this.msgs.push(msg);
        if (msg.type === 'state') { this.states.push(msg); this.latest = msg; }
      });
      this.ws.on('open', res);
      this.ws.on('error', rej);
    });
  }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
  close() { try { this.ws.close(); } catch { /* gone */ } }
  async waitFor(pred, timeoutMs, label) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (pred(this)) return;
      await sleep(60);
    }
    throw new Error('timeout waiting for: ' + label);
  }
}

async function main() {
  const admin = await signup(ADMIN_PHONE, 'AdminBoss');
  const u2 = await signup('01722222222', 'UserTwo');
  const u3 = await signup('01733333333', 'UserThree');
  const u4 = await signup('01744444444', 'UserFour');

  // ------------------------------------------------ bootstrap
  const meAdmin = await request('GET', '/api/auth/me', null, admin.token);
  check('admin: bootstrap phone is admin in /me', meAdmin.body.isAdmin === true);
  const meU2 = await request('GET', '/api/auth/me', null, u2.token);
  check('admin: normal user is not admin', meU2.body.isAdmin === false);

  // ------------------------------------------------ 403 wall
  const adminRoutes = [
    ['GET', '/api/admin/users'], ['GET', '/api/admin/stats'],
    ['POST', '/api/admin/notify'], ['GET', '/api/admin/history'],
    ['POST', '/api/admin/users/adjust-coins'], ['POST', '/api/admin/users/grant-all'],
    ['POST', '/api/admin/users/reset-password'], ['POST', '/api/admin/users/ban'],
    ['POST', '/api/admin/users/delete'], ['GET', '/api/admin/leaderboard'],
    ['POST', '/api/admin/leaderboard/remove'], ['POST', '/api/admin/leaderboard/reset'],
    ['GET', '/api/admin/rooms'], ['POST', '/api/admin/rooms/close'],
    ['GET', '/api/admin/settings'], ['POST', '/api/admin/settings'],
    ['GET', '/api/admin/audit'], ['GET', '/api/admin/users/' + u2.phone],
  ];
  let allForbidden = true;
  for (const [m, p] of adminRoutes) {
    const r = await request(m, p, m === 'POST' ? {} : null, u2.token);
    if (r.status !== 403) { allForbidden = false; console.log('  not 403: ' + m + ' ' + p + ' -> ' + r.status); }
  }
  check('admin: non-admin gets 403 on EVERY admin route', allForbidden);

  // ------------------------------------------------ users + stats
  const list = await request('GET', '/api/admin/users', null, admin.token);
  check('admin: user list returns everyone', list.status === 200 && list.body.users.length >= 4,
    'users=' + (list.body.users || []).length);
  const search = await request('GET', '/api/admin/users?q=UserThree', null, admin.token);
  check('admin: user search filters', search.body.users.length === 1 && search.body.users[0].phone === u3.phone);
  const detail = await request('GET', '/api/admin/users/' + u2.phone, null, admin.token);
  check('admin: user detail has profile + push flag', detail.status === 200 && detail.body.user.phone === u2.phone && detail.body.pushSubscribed === false);
  const stats = await request('GET', '/api/admin/stats', null, admin.token);
  check('admin: stats count users', stats.body.users >= 4 && typeof stats.body.coins === 'number');

  // ------------------------------------------------ push subscribe (replace by endpoint)
  const sub = { endpoint: 'https://push.example.test/abc', keys: { p256dh: 'BPx', auth: 'auth1' } };
  const s1 = await request('POST', '/api/push/subscribe', { subscription: sub }, u2.token);
  check('push: subscribe stores', s1.status === 200 && s1.body.ok === true);
  const sub2 = { endpoint: 'https://push.example.test/abc', keys: { p256dh: 'BPy', auth: 'auth2' } };
  const s2 = await request('POST', '/api/push/subscribe', { subscription: sub2 }, u2.token);
  check('push: re-subscribe with same endpoint replaces', s2.status === 200);
  const detail2 = await request('GET', '/api/admin/users/' + u2.phone, null, admin.token);
  check('push: detail now reports push subscribed', detail2.body.pushSubscribed === true);
  const vapid = await request('GET', '/api/push/vapid-public-key');
  check('push: vapid public key is served', vapid.status === 200 && typeof vapid.body.publicKey === 'string' && vapid.body.publicKey.length > 20);

  // ------------------------------------------------ notify: broadcast + direct
  const bc = await request('POST', '/api/admin/notify', { title: 'Hello all', body: 'Broadcast one' }, admin.token);
  check('notify: broadcast stored', bc.status === 200 && bc.body.stored === true);
  check('notify: push fan-out attempted for stored subs', bc.body.pushAttempted >= 1, 'attempted=' + bc.body.pushAttempted);
  const direct = await request('POST', '/api/admin/notify', { title: 'Just you', body: 'Direct one', phone: u3.phone }, admin.token);
  check('notify: direct stored', direct.status === 200 && direct.body.stored === true);

  const inboxAdmin = await request('GET', '/api/notifications', null, admin.token);
  check('notify: admin sees the broadcast', inboxAdmin.body.notifications.some(n => n.title === 'Hello all'));
  check('notify: admin does NOT see the direct one', !inboxAdmin.body.notifications.some(n => n.title === 'Just you'));
  const inboxU3 = await request('GET', '/api/notifications', null, u3.token);
  check('notify: target sees broadcast + direct', inboxU3.body.notifications.filter(n => ['Hello all', 'Just you'].includes(n.title)).length === 2);
  const unreadU2 = await request('GET', '/api/notifications/unread-count', null, u2.token);
  check('notify: unread count for broadcast-only user is 1', unreadU2.body.count === 1, 'count=' + unreadU2.body.count);
  const bcId = inboxU3.body.notifications.find(n => n.title === 'Hello all').id;
  await request('POST', '/api/notifications/read', { id: bcId }, u3.token);
  const unreadU3 = await request('GET', '/api/notifications/unread-count', null, u3.token);
  check('notify: marking one read drops the count to 1 (direct remains)', unreadU3.body.count === 1, 'count=' + unreadU3.body.count);
  await request('POST', '/api/notifications/read', { all: true }, u3.token);
  const unreadU3b = await request('GET', '/api/notifications/unread-count', null, u3.token);
  check('notify: read-all clears the count', unreadU3b.body.count === 0);
  const hist = await request('GET', '/api/admin/history', null, admin.token);
  check('notify: history records both sends', hist.body.history.filter(h => ['Hello all', 'Just you'].includes(h.title)).length === 2);

  // ------------------------------------------------ coins math
  const adj = await request('POST', '/api/admin/users/adjust-coins', { phone: u2.phone, amount: 50 }, admin.token);
  check('coins: adjust +50 -> 550', adj.body.coins === 550, 'coins=' + adj.body.coins);
  const adjNeg = await request('POST', '/api/admin/users/adjust-coins', { phone: u2.phone, amount: -10000 }, admin.token);
  check('coins: adjust floors at 0', adjNeg.body.coins === 0);
  const grant = await request('POST', '/api/admin/users/grant-all', { amount: 10 }, admin.token);
  check('coins: grant-all affects everyone', grant.body.affected >= 4, 'affected=' + grant.body.affected);
  const meU3 = await request('GET', '/api/auth/me', null, u3.token);
  check('coins: grant-all landed (+10)', meU3.body.coins === 510, 'coins=' + meU3.body.coins);

  // ------------------------------------------------ leaderboard control
  await request('POST', '/api/leaderboard', { name: 'BoardTest', avatar: 1, wins: 5, coinsWon: 100 });
  const board = await request('GET', '/api/admin/leaderboard', null, admin.token);
  check('board: admin list sees the entry', board.body.entries.some(e => e.name === 'BoardTest'));
  await request('POST', '/api/admin/leaderboard/remove', { name: 'BoardTest' }, admin.token);
  const board2 = await request('GET', '/api/admin/leaderboard', null, admin.token);
  check('board: remove works', !board2.body.entries.some(e => e.name === 'BoardTest'));

  // ------------------------------------------------ room registry + admin close
  const roomClient = new Client(); await roomClient.open('/ws');
  roomClient.send({ type: 'create_room', name: 'UserFour', session: u4.token, avatar: 0, mode: 'classic', maxSeats: 4, rules: { stacking: true, challenge: true, allWild: false } });
  await roomClient.waitFor(c => c.latest && c.latest.room.status === 'waiting', 5000, 'u4 room created');
  const roomCode = roomClient.latest.room.code;
  await sleep(400); // registry event is fire-and-forget
  const rooms = await request('GET', '/api/admin/rooms', null, admin.token);
  check('rooms: registry lists the created room', rooms.body.rooms.some(r => r.code === roomCode),
    JSON.stringify(rooms.body.rooms.map(r => r.code)));
  const close = await request('POST', '/api/admin/rooms/close', { code: roomCode }, admin.token);
  check('rooms: close accepted', close.status === 200);
  await roomClient.waitFor(c => c.msgs.some(m => m.type === 'room_closed'), 5000, 'client gets room_closed');
  check('rooms: connected client received room_closed with the Bengali message',
    roomClient.msgs.some(m => m.type === 'room_closed' && /অ্যাডমিন/.test(m.message || '')));
  roomClient.close();

  // ------------------------------------------------ settings: announcement + maintenance
  const setAnn = await request('POST', '/api/admin/settings', { announcement: 'আজ রাত ৯টায় টুর্নামেন্ট!' }, admin.token);
  check('settings: announcement saved', setAnn.status === 200 && setAnn.body.announcement.includes('টুর্নামেন্ট'));
  const pub = await request('GET', '/api/settings');
  check('settings: public endpoint returns the announcement', pub.body.announcement.includes('টুর্নামেন্ট') && pub.body.maintenance === false);

  await request('POST', '/api/admin/settings', { maintenance: true }, admin.token);
  const blockedLogin = await login(u2.phone, 'secret1');
  check('maintenance: normal login is blocked (503)', blockedLogin.status === 503 && /রক্ষণাবেক্ষণ/.test(blockedLogin.body.error || ''),
    blockedLogin.status + ' ' + JSON.stringify(blockedLogin.body));
  const adminLogin = await login(ADMIN_PHONE, 'secret1');
  check('maintenance: admin login still works', adminLogin.status === 200);
  // find_match is blocked too (u4's session predates maintenance).
  const mm = new Client(); await mm.open('/ws-match');
  mm.send({ type: 'find_match', pool: 'wild', session: u4.token, avatar: 0 });
  await mm.waitFor(c => c.msgs.some(m => m.type === 'error'), 5000, 'find_match maintenance error');
  check('maintenance: find_match blocked with the message',
    mm.msgs.some(m => m.type === 'error' && /রক্ষণাবেক্ষণ/.test(m.message || '')));
  mm.close();
  const unSet = await request('POST', '/api/admin/settings', { maintenance: false, announcement: '' }, admin.token);
  check('settings: maintenance can be turned back off', unSet.body.maintenance === false);

  // ------------------------------------------------ about_text round-trip (Addition 12)
  const pubDefault = await request('GET', '/api/settings');
  check('about: public settings serve the seeded default text', /সম্পূর্ণ ফ্রি অনলাইন কার্ড গেম/.test(pubDefault.body.aboutText || ''),
    (pubDefault.body.aboutText || '').slice(0, 40));
  const setAbout = await request('POST', '/api/admin/settings', { aboutText: 'কাস্টম অ্যাবাউট লেখা — টেস্ট' }, admin.token);
  check('about: admin save returns the custom text', (setAbout.body.aboutText || '') === 'কাস্টম অ্যাবাউট লেখা — টেস্ট');
  const pubCustom = await request('GET', '/api/settings');
  check('about: public settings now serve the custom text', pubCustom.body.aboutText === 'কাস্টম অ্যাবাউট লেখা — টেস্ট');
  await request('POST', '/api/admin/settings', { aboutText: '' }, admin.token);
  const pubReset = await request('GET', '/api/settings');
  check('about: clearing falls back to the seeded default', /ভালোবাসা দিয়ে বানানো/.test(pubReset.body.aboutText || ''));
  const okLogin = await login(u2.phone, 'secret1');
  check('maintenance: logins work again after off', okLogin.status === 200);

  // ------------------------------------------------ reset password
  const rp = await request('POST', '/api/admin/users/reset-password', { phone: u3.phone, newPassword: 'newpass99' }, admin.token);
  check('resetpw: accepted', rp.status === 200);
  const oldMe = await request('GET', '/api/auth/me', null, u3.token);
  check('resetpw: old sessions are killed', oldMe.status === 401);
  const oldLogin = await login(u3.phone, 'secret1');
  check('resetpw: old password no longer works', oldLogin.status === 401);
  const newLogin = await login(u3.phone, 'newpass99');
  check('resetpw: new password logs in', newLogin.status === 200);
  u3.token = newLogin.body.token;

  // ------------------------------------------------ ban / unban
  const ban = await request('POST', '/api/admin/users/ban', { phone: u3.phone, banned: true }, admin.token);
  check('ban: accepted', ban.status === 200 && ban.body.banned === true);
  const bannedLogin = await login(u3.phone, 'newpass99');
  check('ban: login returns 403 with the Bengali message', bannedLogin.status === 403 && /বন্ধ করা হয়েছে/.test(bannedLogin.body.error || ''),
    bannedLogin.status + ' ' + JSON.stringify(bannedLogin.body));
  const selfBan = await request('POST', '/api/admin/users/ban', { phone: ADMIN_PHONE, banned: true }, admin.token);
  check('ban: admin cannot ban himself', selfBan.status === 400);
  await request('POST', '/api/admin/users/ban', { phone: u3.phone, banned: false }, admin.token);
  const unbannedLogin = await login(u3.phone, 'newpass99');
  check('ban: unban restores login', unbannedLogin.status === 200);

  // ------------------------------------------------ delete
  const del = await request('POST', '/api/admin/users/delete', { phone: u2.phone }, admin.token);
  check('delete: accepted', del.status === 200);
  const goneLogin = await login(u2.phone, 'secret1');
  check('delete: login no longer possible', goneLogin.status === 401);
  const listAfter = await request('GET', '/api/admin/users', null, admin.token);
  check('delete: user gone from the list', !listAfter.body.users.some(u => u.phone === u2.phone));

  // ------------------------------------------------ audit trail
  const audit = await request('GET', '/api/admin/audit', null, admin.token);
  const actions = new Set(audit.body.audit.map(a => a.action));
  for (const want of ['notify', 'adjust-coins', 'grant-all', 'reset-password', 'ban', 'unban', 'delete-user', 'room-close', 'leaderboard-remove', 'settings']) {
    check('audit: row exists for ' + want, actions.has(want));
  }

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
