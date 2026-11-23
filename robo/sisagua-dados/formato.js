/*
 * Formato dos arquivos publicados (dados abertos do SISAGUA já limpos), usado pelo robô que publica
 * (ferramentas/sisagua-publicador) e pelo Painel SISAGUA que lê. Não acessa a rede.
 *
 * - indice.json            { formato, estado, atualizado, anos, municipios: [{ i, n, anos }], falhas }
 * - <ibge>/<ano>.json      { formato, ibge, ano, gerado, mensal, vigilancia, semestral }
 * - <ibge>/cadastro.json   { formato, ibge, gerado, captacao, populacao, tratamento }
 *
 * Cada conjunto é uma tabela por coluna com dicionário: { n: linhas, c: { coluna: [valores distintos] },
 * v: { coluna: [índice por linha] } }. Desempacotada, volta a ser linhas com os nomes da API.
 *
 * COLUNAS é a lista do que pode ser publicado. O que não está nela não sai (LGPD): nem nome, contato e
 * registro de pessoas, nem o local exato da coleta, nem texto livre.
 */
(function (root) {
  'use strict';

  const FORMATO = 1;
  const COLUNAS = {
    mensal: ['codigo_ibge', 'municipio', 'regional_de_saude', 'sigla_da_instituicao', 'cnpj_da_instituicao', 'nome_do_escritorio_regional_local',
      'tipo_da_forma_de_abastecimento', 'codigo_forma_de_abastecimento', 'nome_da_forma_de_abastecimento', 'nome_da_eta_uta', 'tipo_de_filtracao',
      'ano_de_referencia', 'mes_de_referencia', 'ponto_de_monitoramento', 'parametro', 'campo', 'valor'],
    semestral: ['codigo_ibge', 'municipio', 'sigla_da_instituicao', 'cnpj_da_instituicao', 'tipo_da_forma_de_abastecimento', 'codigo_forma_de_abastecimento',
      'nome_da_forma_de_abastecimento', 'nome_da_eta_uta', 'ano_de_referencia', 'semestre_de_referencia', 'data_da_coleta', 'ponto_de_monitoramento',
      'grupo_de_parametros', 'parametro', 'ld', 'lq', 'resultado', 'unidade', 'vmp'],
    vigilancia: ['codigo_ibge', 'municipio', 'numero_da_amostra', 'motivo_da_coleta', 'tipo_da_forma_de_abastecimento', 'codigo_forma_de_abastecimento',
      'nome_da_forma_de_abastecimento', 'ano', 'mes', 'data_da_coleta', 'procedencia_da_coleta', 'ponto_de_coleta', 'zona', 'area', 'parametro', 'resultado'],
    captacao: ['codigo_do_ibge', 'municipio', 'sigla_da_instituicao', 'codigo_forma_de_abastecimento', 'nome_da_forma_de_abastecimento', 'nome_da_eta_uta', 'ano_de_referencia',
      'tipo_de_captacao', 'nome_do_manancial_superficial', 'nome_do_ponto_de_captacao_subterraneo', 'categoria_do_manancial_superficial',
      'categoria_do_ponto_de_captacao_subterraneo', 'vazao', 'outorga'],
    // cadastro: nomes das colunas dos arquivos oficiais (nucleo.js), que são bem mais rápidos que a API
    populacao: ['CO_MUNICIPIO_IBGE', 'TP_ABASTECIMENTO', 'NU_SOLUCAO_ABASTECIMENTO', 'NO_SOLUCAO_ABASTECIMENTO', 'NU_ANO', 'NU_VALOR_POPULACAO_ESTIMADA',
      'NU_VALOR_RURAL', 'NU_VALOR_URBANA', 'NU_ECONOMIA_DOMICILIO_PERMAN', 'FILTRACAO', 'DESINFECCAO', 'CAPTACAO_SUPERFICIAL', 'CAPTACAO_SUBTERRANEA'],
    tratamento: ['CO_MUNICIPIO_IBGE', 'NU_SOLUCAO_ABASTECIMENTO', 'NO_SOLUCAO_ABASTECIMENTO', 'NO_ETA', 'NU_ANO', 'HR_TEMPO_MEDIO_DIARIO', 'ST_PRE_OXIDACAO',
      'ST_MISTURA_RAPIDA_COAGULACAO', 'ST_FLOCULACAO', 'ST_DECANTACAO', 'ST_FLOTACAO', 'TP_FILTRACAO', 'NU_FILTROS', 'ST_POSSUI_DESINFECCAO',
      'ST_CLORO_GAS_HIPOCLORITO', 'ST_ISOCIANURATOS_CLORADOS', 'ST_CLORAMINA', 'ST_DIOXIDO_DE_CLORO', 'ST_OZONIO', 'ST_UV', 'ST_FLUORETACAO', 'NU_VAZAO_TRATAMENTO'],
  };
  const DO_ANO = ['mensal', 'vigilancia', 'semestral'], DO_CADASTRO = ['captacao', 'populacao', 'tratamento'];
  const RX_CAMINHO = /^(indice|\d{6}\/(20\d\d|cadastro))\.json$/;

  // na vigilância, o nome e a área de uma solução coletiva (SAC) podem identificar uma propriedade particular: não saem
  const SEM_EM_SAC = ['nome_da_forma_de_abastecimento', 'area'];

  /** Só as colunas permitidas, com espaços normalizados. */
  function enxugar(conjunto, l) {
    const cols = COLUNAS[conjunto];
    if (!cols) throw new Error('Conjunto desconhecido: ' + conjunto);
    const o = {};
    const sac = conjunto === 'vigilancia' && l.tipo_da_forma_de_abastecimento !== 'SAA';
    for (const k of cols) {
      if (sac && SEM_EM_SAC.includes(k)) continue;
      const v = l[k];
      if (v === undefined || v === null || typeof v === 'object') continue;
      o[k] = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : v;
    }
    return o;
  }

  function empacotar(conjunto, linhas) {
    const c = {}, v = {};
    for (const k of COLUNAS[conjunto]) {
      const pos = new Map(), vals = [], idx = [];
      for (const l of linhas) {
        const x = l[k] === undefined || l[k] === '' ? null : l[k];
        if (!pos.has(x)) { pos.set(x, vals.length); vals.push(x); }
        idx.push(pos.get(x));
      }
      if (!vals.length || (vals.length === 1 && vals[0] === null)) continue; // coluna toda vazia
      c[k] = vals;
      if (vals.length > 1) v[k] = idx; // um valor só: não repete o índice
    }
    return { n: linhas.length, c, v };
  }

  /** Linhas de uma tabela empacotada. Arquivo estranho vira erro, nunca linha torta. */
  function desempacotar(conjunto, t) {
    if (!t || !Number.isInteger(t.n) || t.n < 0 || t.n > 2000000 || typeof t.c !== 'object' || typeof t.v !== 'object') throw new Error('arquivo publicado ilegível (' + conjunto + ')');
    const permitidas = new Set(COLUNAS[conjunto] || []);
    const linhas = Array.from({ length: t.n }, () => ({}));
    for (const k of Object.keys(t.c)) {
      if (!permitidas.has(k)) continue;
      const vals = t.c[k], idx = t.v[k];
      if (!Array.isArray(vals) || !vals.length || vals.some(x => x !== null && typeof x === 'object') || (idx && (!Array.isArray(idx) || idx.length !== t.n)) || (!idx && vals.length > 1)) throw new Error('arquivo publicado ilegível (' + conjunto + '.' + k + ')');
      for (let i = 0; i < t.n; i++) {
        const x = vals[idx ? idx[i] : 0];
        if (x === undefined) throw new Error('arquivo publicado ilegível (' + conjunto + '.' + k + ')');
        linhas[i][k] = x;
      }
    }
    return linhas;
  }

  /** { mensal: [linhas], … } de um arquivo do ano ou do cadastro, conferindo de quem ele é. */
  function abrirArquivo(j, { ibge, ano }) {
    if (!j || j.formato !== FORMATO) throw new Error('arquivo publicado de outro formato: atualize o programa');
    if (String(j.ibge) !== String(ibge) || (ano !== undefined && Number(j.ano) !== Number(ano))) throw new Error('arquivo publicado trocado');
    const r = { gerado: typeof j.gerado === 'string' ? j.gerado : '' };
    for (const k of ano !== undefined ? DO_ANO : DO_CADASTRO) r[k] = j[k] ? desempacotar(k, j[k]) : [];
    return r;
  }

  /** Índice conferido: só o que o Painel usa, com tipos certos. */
  function abrirIndice(j) {
    if (!j || j.formato !== FORMATO || !Array.isArray(j.municipios)) throw new Error('índice publicado ilegível ou de outro formato');
    const anos = a => (Array.isArray(a) ? a.map(Number).filter(x => x >= 2014 && x <= 2100) : []);
    return {
      estado: String(j.estado || ''), atualizado: String(j.atualizado || ''), anos: anos(j.anos),
      municipios: j.municipios.filter(m => m && /^\d{6}$/.test(String(m.i))).map(m => ({ ibge: String(m.i), nome: String(m.n || '').toUpperCase(), anos: anos(m.anos) })),
      falhas: Array.isArray(j.falhas) ? j.falhas.map(x => String(x).slice(0, 200)).slice(0, 50) : [],
    };
  }

  const api = { FORMATO, COLUNAS, DO_ANO, DO_CADASTRO, RX_CAMINHO, enxugar, empacotar, desempacotar, abrirArquivo, abrirIndice };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SisaguaFormato = api;
})(typeof window !== 'undefined' ? window : globalThis);
