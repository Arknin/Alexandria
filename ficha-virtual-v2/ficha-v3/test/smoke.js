'use strict';
// Teste de ponta a ponta da API: contas, permissões, privacidade, tempo real e concorrência.
const { spawn } = require('child_process'), assert = require('assert'), path = require('path');
const PORT = 3900 + Math.floor(Math.random() * 90), B = `http://localhost:${PORT}`;
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, SQLITE_PATH: ':memory:', DATABASE_URL: '' }, stdio: ['ignore', 'pipe', 'inherit'] });
const sleep = ms => new Promise(r => setTimeout(r, ms));
class Cli {
  constructor(n) { this.n = n; this.c = ''; }
  async req(m, u, body) {
    const r = await fetch(B + u, { method: m, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', Cookie: this.c }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) this.c = sc.split(';')[0];
    let j = {}; try { j = await r.json(); } catch {} return { s: r.status, j };
  }
}
let ok = 0; const t = (name, cond) => { assert.ok(cond, 'FALHOU: ' + name); ok++; console.log('  ✓', name); };
(async () => {
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/healthz'); break; } catch { await sleep(100); } }
  const A = new Cli('mestre'), P = new Cli('jogador'), C = new Cli('intruso');
  console.log('Contas');
  t('senha curta é recusada', (await A.req('POST', '/api/register', { username: 'mestre', password: '123' })).s === 400);
  t('registro do mestre', (await A.req('POST', '/api/register', { username: 'mestre', password: 'senha-forte-1' })).s === 201);
  t('usuário duplicado (sem diferenciar maiúsculas)', (await C.req('POST', '/api/register', { username: 'MESTRE', password: 'senha-forte-1' })).s === 409);
  t('registro do jogador', (await P.req('POST', '/api/register', { username: 'jogador', password: 'senha-forte-2' })).s === 201);
  t('registro do intruso', (await C.req('POST', '/api/register', { username: 'intruso', password: 'senha-forte-3' })).s === 201);
  t('login com senha errada', (await new Cli().req('POST', '/api/login', { username: 'mestre', password: 'errada-errada' })).s === 401);
  t('API exige login', (await new Cli().req('GET', '/api/campaigns')).s === 401);
  const me = (await A.req('GET', '/api/me')).j.user, pme = (await P.req('GET', '/api/me')).j.user;

  console.log('Campanhas');
  const cid = (await A.req('POST', '/api/campaigns', { name: 'Campanha Teste' })).j.id; t('mestre cria campanha', !!cid);
  const cv = (await A.req('GET', '/api/campaigns/' + cid)).j; t('mestre vê o código de convite', !!cv.campaign.join_code && cv.role === 'master');
  t('código inválido', (await P.req('POST', '/api/campaigns/join', { code: 'ZZZZZZZZ' })).s === 404);
  t('jogador entra com o código', (await P.req('POST', '/api/campaigns/join', { code: cv.campaign.join_code })).s === 200);
  const pv = (await P.req('GET', '/api/campaigns/' + cid)).j; t('jogador NÃO recebe o código de convite', pv.campaign.join_code === undefined && pv.role === 'player');
  t('intruso não enxerga a campanha', (await C.req('GET', '/api/campaigns/' + cid)).s === 404);
  t('jogador não altera configurações', (await P.req('PATCH', '/api/campaigns/' + cid, { allow_layers: true })).s === 403);

  console.log('Fichas e privacidade');
  const full = { name: 'Rhiona', apt: 'Erudito', camada: 8, free: false, attrs: { combate: 1, fisico: 5, agilidade: 1, percepcao: 1, inteligencia: 1, vontade: 1, carisma: 1 }, skills: [], tals: [{ t: 'SEGREDO', d: 'texto privado' }], img: '', path: 'arbitro', toff: {}, ten: 2, sn: 1 };
  const sP = (await A.req('POST', `/api/campaigns/${cid}/sheets`, { owner_id: pme.id, data: full })).j.id; t('mestre cria ficha para o jogador', !!sP);
  const sM = (await A.req('POST', `/api/campaigns/${cid}/sheets`, { data: { ...full, name: 'PJ do Mestre', tals: [{ t: 'PRIVADO-MESTRE', d: 'x' }] } })).j.id;
  t('jogador não cria ficha para outro', (await P.req('POST', `/api/campaigns/${cid}/sheets`, { owner_id: me.id, data: full })).s === 403);
  const own = (await P.req('GET', '/api/sheets/' + sP)).j; t('dono vê a ficha completa', own.data && own.data.tals[0].t === 'SEGREDO');
  const other = (await P.req('GET', '/api/sheets/' + sM)).j; const raw = JSON.stringify(other);
  t('outro jogador recebe só o resumo', other.summaryOnly === true && Object.keys(other.summary).sort().join() === 'attrs,img,name');
  t('nenhum dado privado vaza na resposta', !/PRIVADO-MESTRE|tals|skills|toff|"ten"|"sn"|camada|path/.test(raw));
  t('lista da campanha só traz o resumo', !/PRIVADO-MESTRE|SEGREDO|"tals"|"skills"/.test(JSON.stringify(pv.sheets)));
  t('intruso não lê ficha', (await C.req('GET', '/api/sheets/' + sP)).s === 404);
  t('jogador não edita ficha alheia', (await P.req('PATCH', '/api/sheets/' + sM, { patch: { name: 'hack' } })).s === 403);
  t('jogador não apaga ficha alheia', (await P.req('DELETE', '/api/sheets/' + sM)).s === 403);
  t('mestre vê ficha do jogador inteira', (await A.req('GET', '/api/sheets/' + sP)).j.data.tals[0].t === 'SEGREDO');
  t('dados inválidos são recusados', (await P.req('PATCH', '/api/sheets/' + sP, { patch: { ten: 99 } })).s === 400 && (await P.req('PATCH', '/api/sheets/' + sP, { patch: { img: 'javascript:alert(1)' } })).s === 400);
  t('jogador edita a própria ficha', (await P.req('PATCH', '/api/sheets/' + sP, { patch: { name: 'Rhiona Mac' } })).s === 200);

  console.log('Camadas e poções');
  t('jogador NÃO sobe camada sem permissão', (await P.req('PATCH', '/api/sheets/' + sP, { patch: { camada: 7 } })).s === 403);
  t('mestre altera camada do jogador', (await A.req('PATCH', '/api/sheets/' + sP, { patch: { camada: 8 } })).s === 200);
  const pot = (await P.req('GET', '/api/campaigns/' + cid)).j.potions;
  t('jogador na camada 8 recebe as camadas 9 e 8, mas não a 7', pot.pd.arbitro['9'] && pot.pd.arbitro['8'] && !pot.pd.arbitro['7']);
  t('jogador não edita poções', (await P.req('PUT', `/api/campaigns/${cid}/potions`, { potions: { pd: {}, pimgs: {}, paths: {} } })).s === 403);
  const mp = (await A.req('GET', '/api/campaigns/' + cid)).j.potions; mp.paths.novo1 = { name: 'Caminho Novo' };
  t('mestre edita poções', (await A.req('PUT', `/api/campaigns/${cid}/potions`, { potions: mp })).s === 200);
  t('mestre vê todas as camadas', Object.keys((await A.req('GET', '/api/campaigns/' + cid)).j.potions.pd.arbitro).length === 3);
  t('mestre libera subir camadas', (await A.req('PATCH', '/api/campaigns/' + cid, { allow_layers: true })).s === 200);
  t('jogador sobe camada após liberação', (await P.req('PATCH', '/api/sheets/' + sP, { patch: { camada: 7 } })).s === 200);
  t('jogador agora recebe a camada 7', !!(await P.req('GET', '/api/campaigns/' + cid)).j.potions.pd.arbitro['7']);

  console.log('Tempo real e concorrência');
  const ctl = new AbortController(); const ev = await fetch(`${B}/api/events?campaign=${cid}`, { headers: { Cookie: P.c }, signal: ctl.signal }); let got = '';
  (async () => { try { for await (const ch of ev.body) got += Buffer.from(ch).toString(); } catch {} })();
  await sleep(200); await A.req('PATCH', '/api/sheets/' + sP, { patch: { name: 'Alterado pelo mestre' } }); await sleep(300);
  t('jogador recebe evento em tempo real', got.includes('event: changed') && got.includes(sP));
  t('intruso não assina eventos', (await fetch(`${B}/api/events?campaign=${cid}`, { headers: { Cookie: C.c } })).status === 404);
  const r0 = (await A.req('GET', '/api/sheets/' + sP)).j.rev;
  await Promise.all([A.req('PATCH', '/api/sheets/' + sP, { patch: { ten: 3 } }), P.req('PATCH', '/api/sheets/' + sP, { patch: { sn: 4 } }), A.req('PATCH', '/api/sheets/' + sP, { patch: { free: true } })]);
  const f = (await A.req('GET', '/api/sheets/' + sP)).j; t('edições simultâneas em campos diferentes são todas preservadas', f.data.ten === 3 && f.data.sn === 4 && f.data.free === true && f.rev === r0 + 3);

  console.log('Gestão de jogadores');
  t('mestre transfere ficha', (await A.req('PATCH', `/api/sheets/${sM}/owner`, { owner_id: pme.id })).s === 200);
  t('novo dono vê a ficha inteira', (await P.req('GET', '/api/sheets/' + sM)).j.data.tals[0].t === 'PRIVADO-MESTRE');
  t('mestre remove jogador', (await A.req('DELETE', `/api/campaigns/${cid}/members/${pme.id}`)).s === 200);
  t('jogador removido perde o acesso', (await P.req('GET', '/api/sheets/' + sP)).s === 404 && (await P.req('GET', '/api/campaigns/' + cid)).s === 404);
  t('mestre exclui ficha', (await A.req('DELETE', '/api/sheets/' + sM)).s === 200);
  console.log(`\n${ok} verificações OK`); ctl.abort();
})().then(() => { srv.kill(); process.exit(0); }).catch(e => { console.error('\n' + e.message); srv.kill(); process.exit(1); });
