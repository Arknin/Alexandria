'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), { promisify } = require('util');
const db = require('./db');
const scrypt = promisify(crypto.scrypt);
const PUB = path.join(__dirname, 'public');
const SEED = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed-potions.json'), 'utf8'));
const PROD = process.env.NODE_ENV === 'production';
const now = () => Date.now(), uid = () => crypto.randomUUID();
const Q = (sql, p) => db.query(sql, p);

class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
const bad = m => new HttpError(400, m), forbid = (m = 'Sem permissão') => new HttpError(403, m), nf = (m = 'Não encontrado') => new HttpError(404, m);

// ---------- validação (servidor é a fonte da verdade) ----------
const ATT = ['combate', 'fisico', 'agilidade', 'percepcao', 'inteligencia', 'vontade', 'carisma'];
const ID = /^[a-z0-9]{1,20}$/, IMG = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const str = (v, max, k) => { if (typeof v !== 'string' || v.length > max) throw bad('Campo inválido: ' + k); return v; };
const int = (v, a, b, k) => { if (!Number.isInteger(v) || v < a || v > b) throw bad('Campo inválido: ' + k); return v; };
const arr = (v, max, k) => { if (!Array.isArray(v) || v.length > max) throw bad('Campo inválido: ' + k); return v; };
const obj = (v, k) => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad('Campo inválido: ' + k); return v; };
const V = {
  name: v => str(v, 80, 'name'), apt: v => str(v, 30, 'apt'), camada: v => int(v, 0, 9, 'camada'), free: v => !!v,
  attrs: v => { obj(v, 'attrs'); const o = {}; for (const k of ATT) o[k] = int(v[k], 0, 20, 'attrs'); return o; },
  skills: v => arr(v, 150, 'skills').map(s => { obj(s, 'skills'); if (!ATT.includes(s.a)) throw bad('Campo inválido: skills'); return { n: str(s.n, 60, 'skills'), a: s.a, sp: s.sp ? 1 : 0, l: int(s.l ?? 0, 0, 4, 'skills'), c: s.c ? 1 : 0 }; }),
  tals: v => arr(v, 60, 'tals').map(t => { obj(t, 'tals'); const o = { t: str(t.t ?? '', 100, 'tals'), d: str(t.d ?? '', 4000, 'tals') }; if (t.bon) o.bon = str(t.bon, 80, 'tals'); if (t.off) o.off = 1; return o; }),
  img: v => { if (v === '') return ''; if (typeof v !== 'string' || v.length > 1.5e6 || !IMG.test(v)) throw bad('Campo inválido: img'); return v; },
  path: v => { if (typeof v !== 'string' || !/^[a-z0-9]{0,20}$/.test(v)) throw bad('Campo inválido: path'); return v; },
  toff: v => { obj(v, 'toff'); const e = Object.entries(v); if (e.length > 80) throw bad('Campo inválido: toff'); return Object.fromEntries(e.map(([k, x]) => [str(k, 60, 'toff'), !!x])); },
  ten: v => int(v, 0, 5, 'ten'), sn: v => int(v, 0, 5, 'sn'),
};
const cleanSheet = d => { obj(d, 'dados'); const o = {}; for (const k of Object.keys(V)) if (d[k] !== undefined) o[k] = V[k](d[k]); return o; };
function cleanPotions(p) {
  obj(p, 'potions'); const out = { pd: {}, pimgs: {}, paths: {} };
  for (const [pid, x] of Object.entries(p.paths || {})) { if (ID.test(pid) && Object.keys(out.paths).length < 19) out.paths[pid] = { name: str(String((x && x.name) || ''), 60, 'paths') }; }
  for (const [pid, ls] of Object.entries(p.pd || {})) {
    if (!ID.test(pid)) continue; out.pd[pid] = {};
    for (const [n, ly] of Object.entries(ls || {})) {
      if (!/^[0-9]$/.test(n) || !ly || typeof ly !== 'object') continue;
      const y = { n: str(String(ly.n || ''), 80, 'potions'), bon: str(String(ly.bon || ''), 300, 'potions') };
      for (const k of ['ch', 'hab', 'mel']) {
        y[k] = arr(Array.isArray(ly[k]) ? ly[k] : [], 60, 'potions').map(it => {
          const o = { t: str(String(it.t || ''), 120, 'potions'), d: str(String(it.d || ''), 5000, 'potions'), h: str(String(it.h || ''), 10000, 'potions'), bon: str(String(it.bon || ''), 80, 'potions') };
          if (it.hoff) o.hoff = 1; return o;
        });
      }
      out.pd[pid][n] = y;
    }
  }
  for (const [pid, im] of Object.entries(p.pimgs || {})) if (ID.test(pid) && typeof im === 'string' && im.length <= 1.5e6 && IMG.test(im)) out.pimgs[pid] = im;
  return out;
}
// Jogadores só recebem camadas que já alcançaram e nunca textos ocultos desativados.
function filterPotions(p, min) {
  const pd = {};
  for (const [pid, ls] of Object.entries(p.pd || {})) {
    pd[pid] = {};
    for (const [n, ly] of Object.entries(ls)) {
      if (+n < min) continue; const y = { ...ly };
      for (const k of ['ch', 'hab', 'mel']) y[k] = (ly[k] || []).map(it => { const o = { ...it }; if (o.hoff) delete o.h; return o; });
      pd[pid][n] = y;
    }
  }
  return { ...p, pd };
}
const summary = d => ({ name: d.name || '', img: d.img || '', attrs: d.attrs || {} }); // única parte visível a outros jogadores

// ---------- contas e sessões ----------
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
async function hashPw(pw) { const salt = crypto.randomBytes(16); const h = await scrypt(pw, salt, 64); return `s1$${salt.toString('hex')}$${h.toString('hex')}`; }
async function checkPw(pw, st) { const [v, s, h] = st.split('$'); if (v !== 's1') return false; const x = await scrypt(pw, Buffer.from(s, 'hex'), 64), y = Buffer.from(h, 'hex'); return x.length === y.length && crypto.timingSafeEqual(x, y); }
const secure = req => PROD || req.headers['x-forwarded-proto'] === 'https';
const setCookie = (res, req, val, age) => res.setHeader('Set-Cookie', `sid=${val}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${secure(req) ? '; Secure' : ''}`);
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split(/=(.*)/s).slice(0, 2)).filter(a => a[0] && a[1]));
async function startSession(req, res, userId) {
  const tok = crypto.randomBytes(32).toString('hex');
  await Q('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)', [sha(tok), userId, now() + 30 * 864e5]);
  setCookie(res, req, tok, 30 * 86400);
}
async function authUser(req) {
  const t = cookies(req).sid; if (!t) return null;
  return (await Q('SELECT u.id,u.username FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>$2', [sha(t), now()]))[0] || null;
}
const hits = new Map();
function limit(req, key, max, win) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(), k = key + ip, t = now();
  const h = (hits.get(k) || []).filter(x => t - x < win); if (h.length >= max) throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos.');
  h.push(t); hits.set(k, h);
}

// ---------- tempo real (Server-Sent Events) ----------
const clients = new Map(); // campaignId -> Set<{res,uid}>
function broadcast(cid, data) { const s = clients.get(cid); if (!s) return; const m = `event: changed\ndata: ${JSON.stringify(data)}\n\n`; for (const c of s) c.res.write(m); }
function kick(cid, userId) { const s = clients.get(cid); if (!s) return; for (const c of [...s]) if (c.uid === userId) { c.res.write('event: kicked\ndata: {}\n\n'); c.res.end(); s.delete(c); } }
setInterval(() => { for (const s of clients.values()) for (const c of s) c.res.write(': ping\n\n'); }, 25000).unref();

// ---------- helpers ----------
const roleOf = async (cid, u, q = Q) => ((await q('SELECT role FROM members WHERE campaign_id=$1 AND user_id=$2', [cid, u]))[0] || {}).role || null;
const needMember = async (cid, u, q) => { const r = await roleOf(cid, u, q); if (!r) throw nf(); return r; }; // 404 para não revelar existência
const needMaster = async (cid, u, q) => { if ((await needMember(cid, u, q)) !== 'master') throw forbid('Apenas o mestre pode fazer isso'); };
const getSheet = async (sid, q = Q, lock = '') => { const s = (await q('SELECT * FROM sheets WHERE id=$1' + lock, [sid]))[0]; if (!s) throw nf(); return s; };
const CODE = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from(crypto.randomBytes(8), b => CODE[b % CODE.length]).join('');

async function campaignView(cid, user) {
  const c = (await Q('SELECT * FROM campaigns WHERE id=$1', [cid]))[0]; if (!c) throw nf();
  const role = await needMember(cid, user.id);
  const members = await Q('SELECT m.user_id,m.role,u.username FROM members m JOIN users u ON u.id=m.user_id WHERE m.campaign_id=$1 ORDER BY m.role,u.username', [cid]);
  const rows = await Q('SELECT s.id,s.owner_id,s.rev,s.updated_at,s.data,u.username AS owner_name FROM sheets s JOIN users u ON u.id=s.owner_id WHERE s.campaign_id=$1 ORDER BY s.created_at', [cid]);
  const parsed = rows.map(r => ({ r, d: JSON.parse(r.data) }));
  const sheets = parsed.map(({ r, d }) => ({ id: r.id, owner_id: r.owner_id, owner_name: r.owner_name, rev: r.rev, updated_at: r.updated_at, ...summary(d) }));
  let potions = JSON.parse(c.potions);
  if (role !== 'master') { const mine = parsed.filter(x => x.r.owner_id === user.id).map(x => Number.isInteger(x.d.camada) ? x.d.camada : 9); potions = filterPotions(potions, mine.length ? Math.min(...mine) : 10); }
  return { campaign: { id: c.id, name: c.name, owner_id: c.owner_id, allow_layers: !!c.allow_layers, rev: c.rev, join_code: role === 'master' ? c.join_code : undefined }, role, me: user.id, members, sheets, potions };
}

// ---------- API ----------
async function api(req, res, url) {
  const m = req.method, P = url.pathname.split('/').filter(Boolean).slice(1); // sem 'api'
  if (m !== 'GET') {
    const o = req.headers.origin; if (o && new URL(o).host !== req.headers.host) throw forbid('Origem não permitida');
    if (req.headers['x-requested-with'] !== 'fetch') throw forbid('Cabeçalho obrigatório ausente');
  }
  const body = ['POST', 'PUT', 'PATCH'].includes(m) ? await readBody(req) : {};

  // contas
  if (m === 'POST' && P[0] === 'register') {
    limit(req, 'reg', 10, 3600e3);
    const u = str(body.username || '', 24, 'usuário').trim(), pw = str(body.password || '', 200, 'senha');
    if (!/^[A-Za-z0-9_.-]{3,24}$/.test(u)) throw bad('Usuário: 3 a 24 caracteres (letras, números, _ . -)');
    if (pw.length < 8) throw bad('A senha precisa ter ao menos 8 caracteres');
    if ((await Q('SELECT 1 AS x FROM users WHERE username_lc=$1', [u.toLowerCase()])).length) throw new HttpError(409, 'Este usuário já existe');
    const id = uid(); await Q('INSERT INTO users(id,username,username_lc,pass_hash,created_at) VALUES($1,$2,$3,$4,$5)', [id, u, u.toLowerCase(), await hashPw(pw), now()]);
    await startSession(req, res, id); return [201, { user: { id, username: u } }];
  }
  if (m === 'POST' && P[0] === 'login') {
    limit(req, 'login', 20, 600e3);
    const u = String(body.username || '').toLowerCase(), r = (await Q('SELECT * FROM users WHERE username_lc=$1', [u]))[0];
    if (!r || !(await checkPw(String(body.password || ''), r.pass_hash))) throw new HttpError(401, 'Usuário ou senha incorretos');
    await startSession(req, res, r.id); return [200, { user: { id: r.id, username: r.username } }];
  }
  if (m === 'POST' && P[0] === 'logout') { const t = cookies(req).sid; if (t) await Q('DELETE FROM sessions WHERE token_hash=$1', [sha(t)]); setCookie(res, req, '', 0); return [200, {}]; }
  const user = await authUser(req); if (!user) throw new HttpError(401, 'Faça login');
  if (m === 'GET' && P[0] === 'me') return [200, { user }];

  // eventos em tempo real
  if (m === 'GET' && P[0] === 'events') {
    const cid = url.searchParams.get('campaign') || ''; await needMember(cid, user.id);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    const c = { res, uid: user.id }; if (!clients.has(cid)) clients.set(cid, new Set()); clients.get(cid).add(c);
    req.on('close', () => { const s = clients.get(cid); if (s) { s.delete(c); if (!s.size) clients.delete(cid); } });
    return null;
  }

  // campanhas
  if (P[0] === 'campaigns') {
    if (m === 'GET' && P.length === 1) {
      const rows = await Q(`SELECT c.id,c.name,m.role,c.join_code,(SELECT COUNT(*) FROM members x WHERE x.campaign_id=c.id) AS players FROM members m JOIN campaigns c ON c.id=m.campaign_id WHERE m.user_id=$1 ORDER BY c.created_at`, [user.id]);
      return [200, { campaigns: rows.map(r => ({ id: r.id, name: r.name, role: r.role, players: r.players, join_code: r.role === 'master' ? r.join_code : undefined })) }];
    }
    if (m === 'POST' && P.length === 1) {
      const name = str(String(body.name || '').trim(), 60, 'nome'); if (!name) throw bad('Informe o nome da campanha');
      if ((await Q(`SELECT COUNT(*) AS n FROM members WHERE user_id=$1 AND role='master'`, [user.id]))[0].n >= 30) throw bad('Limite de campanhas atingido');
      const id = uid(); let code; do { code = newCode(); } while ((await Q('SELECT 1 AS x FROM campaigns WHERE join_code=$1', [code])).length);
      await db.tx(async q => {
        await q('INSERT INTO campaigns(id,name,owner_id,join_code,allow_layers,potions,rev,created_at) VALUES($1,$2,$3,$4,0,$5,1,$6)', [id, name, user.id, code, JSON.stringify({ pd: SEED, pimgs: {}, paths: {} }), now()]);
        await q(`INSERT INTO members(campaign_id,user_id,role,joined_at) VALUES($1,$2,'master',$3)`, [id, user.id, now()]);
      });
      return [201, { id }];
    }
    if (m === 'POST' && P[1] === 'join') {
      limit(req, 'join', 30, 600e3);
      const c = (await Q('SELECT id FROM campaigns WHERE join_code=$1', [String(body.code || '').trim().toUpperCase()]))[0]; if (!c) throw nf('Código de campanha inválido');
      if (!(await roleOf(c.id, user.id))) await Q(`INSERT INTO members(campaign_id,user_id,role,joined_at) VALUES($1,$2,'player',$3)`, [c.id, user.id, now()]);
      broadcast(c.id, { t: 'members' }); return [200, { id: c.id }];
    }
    const cid = P[1];
    if (m === 'GET' && P.length === 2) return [200, await campaignView(cid, user)];
    if (m === 'PATCH' && P.length === 2) {
      await needMaster(cid, user.id); const sets = [], p = [];
      if (body.name !== undefined) { const n = str(String(body.name).trim(), 60, 'nome'); if (!n) throw bad('Nome vazio'); p.push(n); sets.push(`name=$${p.length}`); }
      if (body.allow_layers !== undefined) { p.push(body.allow_layers ? 1 : 0); sets.push(`allow_layers=$${p.length}`); }
      if (!sets.length) throw bad('Nada para alterar'); p.push(cid);
      await Q(`UPDATE campaigns SET ${sets.join(',')}, rev=rev+1 WHERE id=$${p.length}`, p); broadcast(cid, { t: 'campaign' }); return [200, {}];
    }
    if (m === 'DELETE' && P.length === 2) { await needMaster(cid, user.id); await Q('DELETE FROM campaigns WHERE id=$1', [cid]); const s = clients.get(cid); if (s) for (const c of [...s]) kick(cid, c.uid); return [200, {}]; }
    if (m === 'PUT' && P[2] === 'potions') {
      await needMaster(cid, user.id); const pot = cleanPotions(body.potions);
      await Q('UPDATE campaigns SET potions=$1, rev=rev+1 WHERE id=$2', [JSON.stringify(pot), cid]); broadcast(cid, { t: 'potions' }); return [200, {}];
    }
    if (m === 'DELETE' && P[2] === 'members') {
      const target = P[3], role = await needMember(cid, user.id);
      if (target !== user.id && role !== 'master') throw forbid();
      const tr = await roleOf(cid, target); if (!tr) throw nf(); if (tr === 'master') throw bad('O mestre não pode ser removido');
      await Q('DELETE FROM members WHERE campaign_id=$1 AND user_id=$2', [cid, target]); kick(cid, target); broadcast(cid, { t: 'members' }); return [200, {}];
    }
    if (m === 'POST' && P[2] === 'sheets') {
      const role = await needMember(cid, user.id); let owner = user.id;
      if (body.owner_id && body.owner_id !== user.id) { if (role !== 'master') throw forbid('Você só pode criar fichas para si mesmo'); if (!(await roleOf(cid, body.owner_id))) throw bad('O dono precisa participar da campanha'); owner = body.owner_id; }
      if ((await Q('SELECT COUNT(*) AS n FROM sheets WHERE campaign_id=$1', [cid]))[0].n >= 200) throw bad('Limite de fichas atingido');
      const data = body.data === undefined ? {} : cleanSheet(body.data), id = uid(), t = now();
      await Q('INSERT INTO sheets(id,campaign_id,owner_id,data,rev,created_at,updated_at) VALUES($1,$2,$3,$4,1,$5,$5)', [id, cid, owner, JSON.stringify(data), t]);
      broadcast(cid, { t: 'sheets' }); return [201, { id }];
    }
  }

  // fichas
  if (P[0] === 'sheets' && P[1]) {
    const sid = P[1];
    if (m === 'GET' && P.length === 2) {
      const s = await getSheet(sid), role = await needMember(s.campaign_id, user.id), d = JSON.parse(s.data);
      const base = { id: s.id, campaign_id: s.campaign_id, owner_id: s.owner_id, rev: s.rev };
      if (role === 'master' || s.owner_id === user.id) return [200, { ...base, data: d }];
      return [200, { ...base, summaryOnly: true, summary: summary(d) }]; // versão resumida: nome, retrato e atributos
    }
    if (m === 'PATCH' && P.length === 2) {
      const patch = cleanSheet(obj(body.patch, 'patch')), out = await db.tx(async q => {
        const s = await getSheet(sid, q, db.fu), role = await needMember(s.campaign_id, user.id, q);
        if (role !== 'master' && s.owner_id !== user.id) throw forbid('Esta ficha pertence a outro jogador');
        if (role !== 'master' && patch.camada !== undefined) {
          const c = (await q('SELECT allow_layers FROM campaigns WHERE id=$1', [s.campaign_id]))[0];
          if (!c.allow_layers) throw forbid('O mestre não permitiu alterar as camadas');
        }
        const data = { ...JSON.parse(s.data), ...patch }, rev = s.rev + 1;
        await q('UPDATE sheets SET data=$1, rev=$2, updated_at=$3 WHERE id=$4', [JSON.stringify(data), rev, now(), sid]);
        return { rev, cid: s.campaign_id };
      });
      broadcast(out.cid, { t: 'sheet', id: sid, rev: out.rev }); return [200, { rev: out.rev }];
    }
    if (m === 'DELETE' && P.length === 2) {
      const s = await getSheet(sid), role = await needMember(s.campaign_id, user.id);
      if (role !== 'master' && s.owner_id !== user.id) throw forbid();
      await Q('DELETE FROM sheets WHERE id=$1', [sid]); broadcast(s.campaign_id, { t: 'sheets' }); return [200, {}];
    }
    if (m === 'PATCH' && P[2] === 'owner') {
      const s = await getSheet(sid); await needMaster(s.campaign_id, user.id);
      if (!(await roleOf(s.campaign_id, String(body.owner_id || '')))) throw bad('O dono precisa participar da campanha');
      await Q('UPDATE sheets SET owner_id=$1, rev=rev+1 WHERE id=$2', [body.owner_id, sid]); broadcast(s.campaign_id, { t: 'sheets' }); return [200, {}];
    }
  }
  throw nf('Rota não encontrada');
}

function readBody(req, max = 6e6) {
  return new Promise((ok, no) => {
    let n = 0; const a = [];
    req.on('data', c => { n += c.length; if (n > max) { no(new HttpError(413, 'Requisição grande demais')); req.destroy(); return; } a.push(c); });
    req.on('end', () => { try { ok(a.length ? JSON.parse(Buffer.concat(a).toString()) : {}); } catch { no(bad('JSON inválido')); } });
    req.on('error', no);
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };
function serveStatic(res, pathname) {
  let p; try { p = decodeURIComponent(pathname === '/' ? '/index.html' : pathname); } catch { res.writeHead(400); return res.end(); }
  const f = path.normalize(path.join(PUB, p));
  if (!f.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, b) => {
    if (e) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Não encontrado'); }
    const ext = path.extname(f); res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400' }); res.end(b);
  });
}
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'same-origin'); res.setHeader('Content-Security-Policy', CSP);
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }
    if (url.pathname.startsWith('/api/')) {
      const out = await api(req, res, url); if (out === null) return;
      res.writeHead(out[0], { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify(out[1]));
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    serveStatic(res, url.pathname);
  } catch (e) {
    const s = e.status || 500; if (s === 500) console.error(e);
    if (!res.headersSent) { res.writeHead(s, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ error: s === 500 ? 'Erro interno' : e.message })); } else res.end();
  }
});
db.init().then(() => {
  setInterval(() => Q('DELETE FROM sessions WHERE expires_at<$1', [now()]).catch(() => {}), 3600e3).unref();
  server.listen(process.env.PORT || 3000, () => console.log(`Servidor em http://localhost:${server.address().port} (${db.kind})`));
}).catch(e => { console.error('Falha ao iniciar o banco:', e); process.exit(1); });
