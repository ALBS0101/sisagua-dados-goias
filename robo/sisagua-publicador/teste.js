// Testes do robô com uma API falsa. Nada vai à internet.  node --test ferramentas/sisagua-publicador/teste.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('./atualizar.js');
const A = require('../sisagua-dados/api.js');
const F = require('../sisagua-dados/formato.js');

const resp = (obj, status = 200) => ({ ok: status === 200, status, json: async () => obj });
const base = { uf: 'GO', codigo_ibge: '521250', municipio: 'LUZIANIA', codigo_forma_de_abastecimento: 'S521250000004', nome_da_forma_de_abastecimento: 'ETA  LUZIANIA', tipo_da_forma_de_abastecimento: 'SAA', cnpj_da_instituicao: '1616929000102.0', sigla_da_instituicao: 'SANEAGO' };
const PESSOAL = { responsavel_tecnico: 'FULANO DE TAL', email: 'f@exemplo.invalid', telefone: '99', descricao_do_local: 'CASA DA DONA MARIA', local: 'RUA X 10', latitude: '-16', longitude: '-47', providencia: 'texto livre', hora_da_coleta: '10:00' };

function apiFalsa(dados) {
  return async url => {
    const u = new URL(url);
    if (u.hostname !== A.HOST) return resp({}, 404);
    const ep = u.pathname.split('/').pop(), q = u.searchParams, lim = +q.get('limit'), p = +q.get('offset');
    return resp({ x: (dados(ep, q) || []).slice(p * lim, (p + 1) * lim) });
  };
}

test('formato: ida e volta, colunas permitidas e arquivo estranho recusado', () => {
  const ls = [{ ...base, ...PESSOAL, parametro: 'Turbidez', valor: 0 }, { ...base, parametro: 'Cor', valor: 5 }, { ...base, parametro: null }].map(l => F.enxugar('mensal', l));
  assert.equal(ls[0].nome_da_forma_de_abastecimento, 'ETA LUZIANIA');
  const t = F.empacotar('mensal', ls);
  assert.ok(!/FULANO|DONA MARIA|f@x|texto livre|-16/.test(JSON.stringify(t)));
  const v = F.desempacotar('mensal', JSON.parse(JSON.stringify(t)));
  assert.equal(v[0].valor, 0); assert.equal(v[1].valor, 5); assert.equal(v[2].valor, null); assert.equal(v[1].municipio, 'LUZIANIA');
  assert.deepEqual(F.desempacotar('mensal', F.empacotar('mensal', [])), []);
  assert.throws(() => F.desempacotar('mensal', { n: 2, c: { valor: ['a', 'b'] }, v: { valor: [0] } }));
  assert.throws(() => F.desempacotar('mensal', { n: 1, c: { valor: ['a', 'b'] }, v: { valor: [7] } }));
  assert.throws(() => F.abrirArquivo({ formato: 1, ibge: '520000', ano: 2025 }, { ibge: '521250', ano: 2025 }), /trocado/);
  assert.throws(() => F.abrirArquivo({ formato: 9 }, { ibge: '521250' }), /formato/);
  for (const ok of ['indice.json', '521250/2025.json', '521250/cadastro.json']) assert.ok(F.RX_CAMINHO.test(ok));
  for (const ruim of ['../x.json', '521250/2025.json?x=1', '52125/2025.json', 'https://a/indice.json', '521250/outro.json']) assert.ok(!F.RX_CAMINHO.test(ruim));
});

test('nenhuma coluna publicada é de pessoa, contato ou local exato', () => {
  for (const [c, cols] of Object.entries(F.COLUNAS)) for (const k of cols) {
    assert.ok(!A.RETIRAR.has(k), c + '.' + k);
    assert.ok(!/respons|mail|telef|celular|cpf|conselho|latit|longit|endere|logradouro|cep|descri|provid|local$/i.test(k.replace('nome_do_escritorio_regional_local', '').replace('RECEBE', '')), c + '.' + k);
  }
});

test('página com linha que a API não entrega: perde só o pedaço e registra', async () => {
  const ls = Array.from({ length: 1500 }, (_, i) => ({ id: i }));
  const B = P.criarBaixador({ esperaMs: 0, log() {}, fetchImpl: async url => {
    const q = new URL(url).searchParams, lim = +q.get('limit'), p = +q.get('offset'), ini = p * lim;
    if (ini <= 1234 && 1234 < ini + lim) return resp({}, 500);
    return resp({ x: ls.slice(ini, ini + lim) });
  } });
  const got = [];
  await B.tudo('pontos-de-captacao', { uf: 'GO' }, 'teste', l => got.push(l.id));
  assert.equal(got.length, 1490); assert.equal(new Set(got).size, 1490); assert.ok(!got.includes(1234));
  assert.equal(B.falhas.length, 1);
});

test('fonte fora do ar vira erro, e 429 é tentado de novo', async () => {
  const B = P.criarBaixador({ esperaMs: 0, log() {}, fetchImpl: async () => resp({}, 503) });
  await assert.rejects(B.tudo('pontos-de-captacao', { uf: 'GO' }, 't', () => {}), /503/);
  let n = 0;
  const C = P.criarBaixador({ esperaMs: 0, paralelas: 1, log() {}, fetchImpl: async () => (++n < 3 ? resp({}, 429) : resp({ x: [] })) });
  assert.equal(await C.tudo('pontos-de-captacao', { uf: 'GO' }, 't', () => {}), 0);
});

test('execução completa: só Saneago e Goiás, vigilância pelo código, sem SAI, e reaproveita o ano publicado', async () => {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-'));
  const dados = (ep, q) => {
    if (ep === 'controle-mensal-parametros-basicos') return q.get('mes_de_referencia') === '1' ? [{ ...base, ...PESSOAL, ano_de_referencia: q.get('ano_de_referencia'), mes_de_referencia: '1', parametro: 'Turbidez (uT)', campo: 'Número de amostras analisadas', valor: 10 }, { ...base, cnpj_da_instituicao: '99', parametro: 'OUTRA EMPRESA' }] : [];
    if (ep === 'vigilancia-parametros-basicos') return q.get('mes') === '2' ? [{ ...base, ...PESSOAL, codigo_ibge: null, parametro: 'Escherichia coli', resultado: 'AUSENTE', ano: 2026, mes: 2 }, { ...base, codigo_ibge: null, tipo_da_forma_de_abastecimento: 'SAI', parametro: 'CASA' }, { ...base, codigo_ibge: null, tipo_da_forma_de_abastecimento: 'SAC', codigo_forma_de_abastecimento: 'C521250000099', nome_da_forma_de_abastecimento: 'FAZENDA DO BELTRANO', area: 'SITIO BELTRANO', parametro: 'pH', resultado: '7' }, { ...base, codigo_ibge: null, codigo_forma_de_abastecimento: 'S310000000001', parametro: 'MINAS' }] : [];
    if (ep === 'controle-semestral') return q.get('semestre_de_referencia') === '1' ? [{ ...base, parametro: 'Bário', resultado: '0,1', vmp: '0,7' }] : [];
    if (ep === 'pontos-de-captacao') return [{ ...base, codigo_ibge: undefined, codigo_do_ibge: '521250', tipo_de_captacao: 'SUPERFICIAL', ano_de_referencia: 2025 }];
  };
  const api = apiFalsa(dados);
  const velho = { formato: 1, ibge: '521250', ano: 2025, gerado: 'antes', mensal: F.empacotar('mensal', [{ parametro: 'VELHO' }]), vigilancia: F.empacotar('vigilancia', []), semestral: F.empacotar('semestral', []) };
  const fetchImpl = async url => {
    if (url.endsWith('/indice.json')) return resp({ formato: 1, municipios: [{ i: '521250', n: 'LUZIANIA', anos: [2025] }] });
    if (url.endsWith('/521250/2025.json')) return resp(velho);
    return api(url);
  };
  const env = { SAIDA: raiz, ANOS: '2026', ANOS_SITE: '2', SITE_ANTERIOR: 'https://conta.github.io/rep/dados/', SEM_CADASTRO: '1' };
  const r = await P.principal(env, { fetchImpl, log() {}, hoje: new Date('2026-03-10T12:00:00Z'), opcoesBaixador: { esperaMs: 0 } });
  assert.deepEqual(r.municipios, [{ i: '521250', n: 'LUZIANIA', anos: [2026, 2025] }]);
  const ler = n => JSON.parse(fs.readFileSync(path.join(raiz, n), 'utf8'));
  const a = F.abrirArquivo(ler('521250/2026.json'), { ibge: '521250', ano: 2026 });
  assert.deepEqual([a.mensal.length, a.vigilancia.length, a.semestral.length], [1, 2, 1]);
  assert.equal(F.abrirArquivo(ler('521250/2025.json'), { ibge: '521250', ano: 2025 }).mensal[0].parametro, 'VELHO');
  assert.equal(F.abrirArquivo(ler('521250/cadastro.json'), { ibge: '521250' }).captacao.length, 1);
  assert.equal(F.abrirIndice(ler('indice.json')).municipios.length, 1);
  const tudo = fs.readdirSync(path.join(raiz, '521250')).map(n => fs.readFileSync(path.join(raiz, '521250', n), 'utf8')).join('');
  assert.ok(!/BELTRANO|FULANO|DONA MARIA|RUA X|f@x|OUTRA EMPRESA|MINAS|"CASA"/.test(tudo));
  // nada atualizado: falha sem publicar
  await assert.rejects(P.principal({ ...env, SAIDA: raiz + '-x' }, { fetchImpl: async u => (u.includes('github.io') ? fetchImpl(u) : resp({}, 503)), log() {}, hoje: new Date('2026-03-10T12:00:00Z'), opcoesBaixador: { esperaMs: 0 } }), /nenhum ano/);
  fs.rmSync(raiz, { recursive: true, force: true }); fs.rmSync(raiz + '-x', { recursive: true, force: true });
});

test('arquivo grande: a conexão cai no meio e a tentativa seguinte continua de onde parou', async () => {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-')), dest = path.join(pasta, 'a.zip'), cheio = Buffer.from('0123456789'.repeat(10));
  const pedidos = [];
  const fetchImpl = async (url, o) => {
    pedidos.push(o.headers.Range || '');
    const de = o.headers.Range ? Number(/bytes=(\d+)-/.exec(o.headers.Range)[1]) : 0, parte = cheio.subarray(de);
    const corpo = pedidos.length === 1
      ? new ReadableStream({ start(c) { c.enqueue(parte.subarray(0, 40)); setTimeout(() => c.error(new Error('terminated')), 30); } })
      : new ReadableStream({ start(c) { c.enqueue(parte); c.close(); } });
    return { ok: true, status: de ? 206 : 200, headers: new Headers({ 'content-length': String(parte.length), etag: '"v1"' }), body: corpo };
  };
  await P.baixarZipOficial('a.zip', dest, { fetchImpl, esperaMs: 0, log() {} });
  assert.equal(fs.readFileSync(dest).toString(), cheio.toString());
  assert.deepEqual(pedidos.length, 2); assert.match(pedidos[1], /^(|bytes=40-)$/);
  await assert.rejects(P.baixarZipOficial('b.zip', path.join(pasta, 'b.zip'), { fetchImpl: async () => ({ ok: false, status: 503 }), esperaMs: 0, tentativas: 2, log() {} }), /b\.zip: HTTP 503/);
  await assert.rejects(P.baixarZipOficial('../x.zip', dest, { fetchImpl }), /inesperado/);
  fs.rmSync(pasta, { recursive: true, force: true });
});

test('cadastro: se os arquivos grandes falham, a captação não se perde e o aviso diz o que faltou', async () => {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-'));
  const api = apiFalsa(ep => (ep === 'pontos-de-captacao' ? [{ ...base, codigo_ibge: undefined, codigo_do_ibge: '521250', tipo_de_captacao: 'SUPERFICIAL', ano_de_referencia: 2025 }] : ep === 'controle-semestral' ? [{ ...base, parametro: 'Bário' }] : []));
  const r = await P.principal({ SAIDA: raiz, ANOS: '2026', ANOS_SITE: '1' }, { fetchImpl: api, log() {}, hoje: new Date('2026-01-10T12:00:00Z'), baixarZip: async () => { throw new Error('terminated'); }, opcoesBaixador: { esperaMs: 0 } });
  assert.ok(r.falhas.some(f => /população e tratamento não foram atualizados \(terminated\)/.test(f)));
  assert.equal(F.abrirArquivo(JSON.parse(fs.readFileSync(path.join(raiz, '521250/cadastro.json'), 'utf8')), { ibge: '521250' }).captacao.length, 1);
  fs.rmSync(raiz, { recursive: true, force: true });
});
