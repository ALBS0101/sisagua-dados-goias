/*
 * Robô dos dados publicados: baixa os dados abertos do SISAGUA (Goiás: controle da Saneago e vigilância),
 * limpa e grava site/dados/<ibge>/<ano>.json, site/dados/<ibge>/cadastro.json e site/dados/indice.json,
 * que o Painel SISAGUA lê. Roda no GitHub Actions (.github/workflows/atualizar.yml) ou no computador:
 *
 *   node atualizar.js                    ano atual e anterior; os demais vêm do site já publicado
 *   ANOS=2024,2025 IBGES=521250 node atualizar.js      só esses anos e municípios (teste)
 *
 * SITE_ANTERIOR: endereço já publicado (…/dados/), de onde vêm os anos que não são refeitos e o que falhar.
 * ANOS_SITE: quantos anos o site guarda (padrão 5). SEM_CADASTRO=1 não baixa os arquivos do cadastro (160 MB).
 *
 * Regras: da API em sisagua-dados/api.js; do cadastro em sisagua-dados/nucleo.js; o que pode ser publicado em
 * sisagua-dados/formato.js (lista de colunas). Nenhuma regra dessas mora aqui.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../sisagua-dados/api.js');
const F = require('../sisagua-dados/formato.js');
const N = require('../sisagua-dados/nucleo.js');

const UF = 'GO', UF_IBGE = '52', MAX_PAGINAS = 2000;
const espera = ms => new Promise(r => setTimeout(r, ms));

/** Uma página, com novas tentativas. HTTP 500 persistente numa página (linha com problema na fonte): pede em
    pedaços de 100 e de 10, para perder só a linha que a API não entrega. */
function criarBaixador({ fetchImpl = globalThis.fetch, log = console.log, esperaMs = 3000, paralelas = 3, prazoMs = 120000 } = {}) {
  const falhas = [];
  let pedidos = 0;
  async function um(url) {
    let ultimo;
    for (let t = 1; t <= 4; t++) {
      pedidos++;
      try {
        const r = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(prazoMs), headers: { Accept: 'application/json' } });
        if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status), { status: r.status });
        const l = A.linhasDe(await r.json());
        if (!l) throw new Error('resposta sem lista');
        return l;
      } catch (e) {
        ultimo = e;
        if (e.status && e.status < 500 && e.status !== 429) break;
        if (e.status === 500 && t >= 2) break;
        await espera(esperaMs * t);
      }
    }
    throw ultimo;
  }
  /** { linhas, fim }: fim quando a fonte não tem mais linhas depois desta página. */
  async function pagina(ep, params, p, limite, rotulo) {
    try {
      const linhas = await um(A.montarUrl(ep, params, p, { limite, maxPaginas: MAX_PAGINAS * (A.PAGINA / limite) }));
      return { linhas, fim: linhas.length < limite };
    } catch (e) {
      if (e.status !== 500) throw e; // fonte fora do ar ou lenta: quem chamou decide
      if (limite <= 10) { falhas.push(`${rotulo}: até ${limite} linha(s) que a API não entrega`); return { linhas: [], fim: false }; }
      const linhas = [];
      for (let k = p * 10; k < p * 10 + 10; k++) {
        const r = await pagina(ep, params, k, limite / 10, rotulo);
        linhas.push(...r.linhas);
        if (r.fim) return { linhas, fim: true };
      }
      return { linhas, fim: false };
    }
  }
  /** Todas as páginas de uma consulta; cada linha passa por `guardar` (que a limpa e guarda). */
  async function tudo(ep, params, rotulo, guardar) {
    let n = 0;
    for (let p = 0; p < MAX_PAGINAS; p += paralelas) {
      const lote = await Promise.all(Array.from({ length: paralelas }, (_, i) => pagina(ep, params, p + i, A.PAGINA, rotulo)));
      for (const r of lote) {
        for (const l of r.linhas) guardar(A.limparLinha(l));
        n += r.linhas.length;
        if (r.fim) return n;
      }
      if (falhas.length > 200) throw new Error('falhas demais na fonte');
    }
    throw new Error(`${rotulo}: paginação sem fim`);
  }
  return { tudo, falhas, pedidos: () => pedidos, log };
}

const ehGoias = ibge => new RegExp('^' + UF_IBGE + '\\d{4}$').test(String(ibge || ''));

/** Guarda linhas por município: { ibge: { conjunto: [linhas] } }, só as que podem ser publicadas. */
function criarDeposito(ibges) {
  const m = new Map();
  const so = ibges && ibges.length ? new Set(ibges) : null;
  return {
    mapa: m,
    por(conjunto, ibge, linha) {
      if (!ehGoias(ibge) || (so && !so.has(ibge))) return;
      if (!m.has(ibge)) m.set(ibge, {});
      const x = m.get(ibge);
      (x[conjunto] = x[conjunto] || []).push(F.enxugar(conjunto, linha));
    },
  };
}

/** Os três conjuntos de um ano. `hoje`: não pede meses e semestres que ainda não começaram. */
async function baixarAno(B, ano, ibges, hoje = new Date()) {
  const D = criarDeposito(ibges);
  const um = ibges && ibges.length === 1 ? { codigo_ibge: ibges[0] } : {};
  const meses = ano < hoje.getFullYear() ? 12 : hoje.getMonth() + 1;
  const cont = { mensal: 0, vigilancia: 0, semestral: 0 };
  for (let mes = 1; mes <= meses; mes++) {
    cont.mensal += await B.tudo('controle-mensal-parametros-basicos', { uf: UF, ...um, cnpj_da_instituicao: N.SANEAGO.cnpj, ano_de_referencia: ano, mes_de_referencia: mes }, `controle mensal ${mes}/${ano}`,
      l => { if (A.cnpj(l.cnpj_da_instituicao) === N.SANEAGO.cnpj) D.por('mensal', A.ibge6(l), l); });
    // a vigilância traz codigo_ibge quase sempre nulo: o município sai do código do sistema. SAI (casas) não é publicada
    cont.vigilancia += await B.tudo('vigilancia-parametros-basicos', { uf: UF, ano, mes }, `vigilância ${mes}/${ano}`,
      l => { if (/^S(AA|AC)$/.test(String(l.tipo_da_forma_de_abastecimento || ''))) D.por('vigilancia', A.ibge6(l), l); });
    B.log(`  ${ano}/${String(mes).padStart(2, '0')}: ${cont.mensal} do controle mensal, ${cont.vigilancia} da vigilância até aqui (${B.pedidos()} pedidos)`);
  }
  for (const sem of meses >= 7 ? [1, 2] : [1]) {
    cont.semestral += await B.tudo('controle-semestral', { uf: UF, ...um, cnpj_da_instituicao: N.SANEAGO.cnpj, ano_de_referencia: ano, semestre_de_referencia: sem }, `controle semestral ${sem}º/${ano}`,
      l => { if (A.cnpj(l.cnpj_da_instituicao) === N.SANEAGO.cnpj) D.por('semestral', A.ibge6(l), l); });
  }
  return { mapa: D.mapa, cont };
}

/** Captação (API) e cadastro de população e tratamento (arquivos oficiais, pelo núcleo do sisagua-dados). */
async function baixarCadastro(B, ibges, { semArquivos, baixarZip, anos = N.anosPadrao(), log = console.log } = {}) {
  const D = criarDeposito(ibges);
  await B.tudo('pontos-de-captacao', { uf: UF, ...(ibges && ibges.length === 1 ? { codigo_ibge: ibges[0] } : {}) }, 'pontos de captação',
    l => { if (/saneago/i.test(String(l.sigla_da_instituicao || ''))) D.por('captacao', A.ibge6(l), l); });
  let erro = '';
  if (!semArquivos) {
    const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'sisagua-cadastro-'));
    try {
      const { extrato } = await N.montarExtrato({
        anos, conjuntos: ['cadastro', 'tratamento'], log,
        antes: nome => baixarZip(nome, path.join(pasta, nome)),
        obter: async nome => (fs.existsSync(path.join(pasta, nome)) ? { blob: await fs.openAsBlob(path.join(pasta, nome)), modificado: '' } : null),
        depois: nome => fs.unlinkSync(path.join(pasta, nome)),
      });
      for (const [conj, para] of [['cadastro', 'populacao'], ['tratamento', 'tratamento']]) {
        const t = extrato.conjuntos[conj];
        if (!t) continue;
        for (const v of t.linhas) {
          const l = Object.assign({}, t.constantes);
          t.colunas.forEach((c, i) => { l[c] = v[i]; });
          D.por(para, String(l.CO_MUNICIPIO_IBGE || '').slice(0, 6), l);
        }
      }
    } catch (e) { erro = e.message; } finally { fs.rmSync(pasta, { recursive: true, force: true }); }
  }
  return { mapa: D.mapa, erro };
}

const arquivoDoAno = (ibge, ano, x, gerado) => ({ formato: F.FORMATO, ibge, ano, gerado, ...Object.fromEntries(F.DO_ANO.map(k => [k, F.empacotar(k, x[k] || [])])) });
const arquivoDoCadastro = (ibge, x, gerado) => ({ formato: F.FORMATO, ibge, gerado, ...Object.fromEntries(F.DO_CADASTRO.map(k => [k, F.empacotar(k, x[k] || [])])) });

function gravarJson(raiz, rel, obj) {
  if (!F.RX_CAMINHO.test(rel)) throw new Error('caminho não publicável: ' + rel);
  const arq = path.join(raiz, rel);
  fs.mkdirSync(path.dirname(arq), { recursive: true });
  fs.writeFileSync(arq, JSON.stringify(obj));
}

/** Cópia do que já está publicado (anos que não são refeitos, ou que falharam). false: não há. */
async function reaproveitar(site, raiz, rel, conferir, fetchImpl = globalThis.fetch) {
  if (!site) return false;
  try {
    const r = await fetchImpl(site + rel, { redirect: 'error', signal: AbortSignal.timeout(60000) });
    if (!r.ok) return false;
    const j = await r.json();
    conferir(j); // só reaproveita arquivo do formato atual
    gravarJson(raiz, rel, j);
    return true;
  } catch (e) { return false; }
}

async function principal(env = process.env, { fetchImpl = globalThis.fetch, log = console.log, hoje = new Date(), baixarZip, opcoesBaixador = {} } = {}) {
  const raiz = path.resolve(env.SAIDA || path.join(__dirname, 'site', 'dados'));
  const anoAtual = hoje.getFullYear();
  const guardar = Math.max(1, Math.min(15, Number(env.ANOS_SITE) || 5));
  const refazer = (env.ANOS ? String(env.ANOS).split(',').map(Number) : [anoAtual, anoAtual - 1]).filter(a => a >= 2014 && a <= anoAtual);
  const ibges = String(env.IBGES || '').split(/[\s,]+/).filter(x => /^\d{6}$/.test(x));
  const site = /^https:\/\//.test(env.SITE_ANTERIOR || '') ? String(env.SITE_ANTERIOR).replace(/\/?$/, '/') : '';
  const gerado = hoje.toISOString();
  const B = criarBaixador({ fetchImpl, log, ...opcoesBaixador });
  const anosSite = Array.from({ length: guardar }, (_, i) => anoAtual - i).concat(refazer).filter((a, i, l) => l.indexOf(a) === i).sort((a, b) => b - a);
  let anterior = null;
  if (site) { try { const r = await fetchImpl(site + 'indice.json', { redirect: 'error', signal: AbortSignal.timeout(60000) }); if (r.ok) anterior = F.abrirIndice(await r.json()); } catch (e) { log('  (sem índice anterior: ' + e.message + ')'); } }
  const anosDe = new Map(), nomeDe = new Map(), falhas = [];
  const temAno = (ibge, ano) => { if (!anosDe.has(ibge)) anosDe.set(ibge, new Set()); anosDe.get(ibge).add(ano); };
  for (const m of anterior ? anterior.municipios : []) nomeDe.set(m.ibge, m.nome);

  let refeitos = 0;
  for (const ano of anosSite) {
    let novo = null;
    // o ano que falta no site (primeira vez) também é baixado
    const falta = !anterior || !anterior.municipios.some(m => m.anos.includes(ano));
    if (refazer.includes(ano) || (falta && !env.ANOS)) {
      try {
        log(`Ano ${ano}:`);
        novo = await baixarAno(B, ano, ibges, hoje);
        log(`  pronto: ${novo.cont.mensal} do controle mensal, ${novo.cont.vigilancia} da vigilância, ${novo.cont.semestral} do semestral`);
        if (!novo.mapa.size) throw new Error('a fonte não trouxe nenhuma linha');
      } catch (e) { novo = null; falhas.push(`${ano}: não foi atualizado (${e.message})`); log(`  ERRO em ${ano}: ${e.message}`); }
    }
    if (novo) {
      refeitos++;
      for (const [ibge, x] of novo.mapa) {
        gravarJson(raiz, `${ibge}/${ano}.json`, arquivoDoAno(ibge, ano, x, gerado));
        temAno(ibge, ano);
        for (const k of F.DO_ANO) for (const l of x[k] || []) if (!nomeDe.get(ibge) && l.municipio) nomeDe.set(ibge, String(l.municipio).toUpperCase());
      }
      continue;
    }
    for (const m of anterior ? anterior.municipios : []) {
      if (!m.anos.includes(ano) || (ibges.length && !ibges.includes(m.ibge))) continue;
      if (await reaproveitar(site, raiz, `${m.ibge}/${ano}.json`, j => F.abrirArquivo(j, { ibge: m.ibge, ano }), fetchImpl)) temAno(m.ibge, ano);
      else falhas.push(`${m.ibge}/${ano}: não deu para manter o arquivo publicado`);
    }
  }
  if (!refeitos) throw new Error('nenhum ano foi atualizado; o site publicado continua como está. ' + falhas.join('; '));

  let cad = null, semPop = false; // semPop: veio a captação, mas não os arquivos de população e tratamento
  try { const c = await baixarCadastro(B, ibges, { semArquivos: !!env.SEM_CADASTRO, baixarZip: baixarZip || baixarZipOficial, anos: anosSite.map(String), log }); cad = c.mapa; semPop = !!c.erro; if (c.erro) { falhas.push(`cadastro: população e tratamento não foram atualizados (${c.erro})`); log('  ERRO no cadastro: ' + c.erro); } } catch (e) { falhas.push(`cadastro: não foi atualizado (${e.message})`); log('  ERRO no cadastro: ' + e.message); }
  for (const ibge of anosDe.keys()) {
    const x = cad && cad.get(ibge);
    // faltou parte do cadastro: o publicado antes (inteiro) vale mais
    if (semPop && await reaproveitar(site, raiz, `${ibge}/cadastro.json`, j => F.abrirArquivo(j, { ibge }), fetchImpl)) continue;
    if (x) gravarJson(raiz, `${ibge}/cadastro.json`, arquivoDoCadastro(ibge, x, gerado));
    else if (cad || !(await reaproveitar(site, raiz, `${ibge}/cadastro.json`, j => F.abrirArquivo(j, { ibge }), fetchImpl))) gravarJson(raiz, `${ibge}/cadastro.json`, arquivoDoCadastro(ibge, {}, gerado));
  }
  falhas.push(...B.falhas);
  const municipios = [...anosDe].map(([i, anos]) => ({ i, n: nomeDe.get(i) || 'IBGE ' + i, anos: [...anos].sort((a, b) => b - a) })).sort((a, b) => a.n.localeCompare(b.n, 'pt-BR'));
  gravarJson(raiz, 'indice.json', { formato: F.FORMATO, estado: UF, atualizado: gerado, anos: anosSite.filter(a => municipios.some(m => m.anos.includes(a))), municipios, falhas });
  log(`Pronto: ${municipios.length} município(s), ${B.pedidos()} pedidos à API${falhas.length ? `; ${falhas.length} aviso(s): ${falhas.slice(0, 10).join('; ')}` : ''}`);
  return { municipios, falhas };
}

/** Baixa um arquivo oficial (só da BASE do núcleo) para o disco. */
async function baixarZipOficial(nome, destino, { fetchImpl = globalThis.fetch, tentativas = 5, esperaMs = 5000, log = console.log } = {}) {
  if (!/^[a-z0-9_]+\.zip$/.test(nome)) throw new Error('arquivo inesperado: ' + nome);
  // são 80 MB por arquivo: a conexão cai no meio, e a próxima tentativa continua de onde parou
  let total = 0, etag = '';
  for (let t = 1; ; t++) {
    try {
      const tem = fs.existsSync(destino) ? fs.statSync(destino).size : 0;
      const r = await fetchImpl(N.BASE + nome, { redirect: 'error', signal: AbortSignal.timeout(20 * 60000), headers: tem && etag ? { Range: `bytes=${tem}-`, 'If-Range': etag } : {} });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const continua = r.status === 206;
      total = (continua ? tem : 0) + Number(r.headers.get('content-length') || 0);
      etag = r.headers.get('etag') || '';
      await require('stream/promises').pipeline(require('stream').Readable.fromWeb(r.body), fs.createWriteStream(destino, { flags: continua ? 'a' : 'w' }));
      const veio = fs.statSync(destino).size;
      if (total && veio !== total) throw new Error(`veio ${veio} de ${total} bytes`);
      return;
    } catch (e) {
      if (t >= tentativas) throw new Error(`${nome}: ${e.message}`);
      log(`  ${nome}: ${e.message}; tentativa ${t + 1}`);
      await espera(esperaMs * t);
    }
  }
}

module.exports = { baixarZipOficial, criarBaixador, criarDeposito, baixarAno, baixarCadastro, arquivoDoAno, arquivoDoCadastro, principal };

if (require.main === module) principal().catch(e => { console.error('ERRO: ' + e.message); process.exitCode = 1; });
