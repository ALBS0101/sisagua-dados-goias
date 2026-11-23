/*
 * API de Dados Abertos do SISAGUA (Ministério da Saúde): as regras num lugar só. A ponte
 * (ferramentas/sisagua-ws, rota /dados) usa este arquivo para montar o endereço e limpar as linhas;
 * o Painel SISAGUA do programa usa o mesmo arquivo para saber o que pode pedir.
 *
 * Verificado em 21/11/2026 contra a API real:
 * - Pública, sem senha. Sem CORS: o navegador não lê a resposta direto, por isso passa pela ponte.
 * - `offset` é o NÚMERO DA PÁGINA (0, 1, 2…); `limit` tem teto de 1000. Acaba quando a página vem
 *   com menos de 1000 linhas.
 * - A resposta é { <chave que muda por endpoint>: [linhas] }.
 * - Na vigilância o codigo_ibge vem quase sempre nulo (e o filtro por ele devolve nada): filtra-se por
 *   uf/ano/mês e depois pelo município tirado do código da forma de abastecimento (S/C + IBGE de 6
 *   dígitos + sequencial). No controle mensal o filtro por codigo_ibge funciona.
 *
 * Não acessa a rede: só monta endereços e limpa linhas. Funciona no Node e no navegador.
 */
(function (root) {
  'use strict';

  const HOST = 'apidadosabertos.saude.gov.br';
  const BASE = 'https://' + HOST + '/sisagua/';
  const PAGINA = 1000; // teto real da API, mesmo pedindo mais
  const MAX_PAGINAS = 60; // um pedido do painel nunca passa disso (60 mil linhas)

  /* Só os conjuntos cujo filtro a API respeita: os demais ignoram os filtros em silêncio e trariam a
     base nacional inteira. `filtros`: os parâmetros aceitos, além da página. */
  const ENDPOINTS = {
    'controle-mensal-parametros-basicos': { titulo: 'Controle mensal — parâmetros básicos', filtros: ['uf', 'codigo_ibge', 'cnpj_da_instituicao', 'ano_de_referencia', 'mes_de_referencia', 'parametro', 'tipo_da_forma_de_abastecimento'] },
    'vigilancia-parametros-basicos': { titulo: 'Vigilância — parâmetros básicos', filtros: ['uf', 'ano', 'mes', 'parametro', 'motivo_da_coleta', 'tipo_da_forma_de_abastecimento', 'procedencia_da_coleta'] },
    'controle-semestral': { titulo: 'Controle semestral', filtros: ['uf', 'codigo_ibge', 'cnpj_da_instituicao', 'ano_de_referencia', 'semestre_de_referencia', 'grupo_de_parametros', 'tipo_da_forma_de_abastecimento'] },
    'pontos-de-captacao': { titulo: 'Pontos de captação', filtros: ['uf', 'codigo_ibge'] },
  };

  /* Campos que saem de toda linha antes de chegar ao programa (LGPD): nome, contato e registro de
     pessoas, e o local exato da coleta (endereço, descrição livre, coordenadas) — muitas amostras são
     em casas. As mesmas regras do extrato (nucleo.js: PESSOAIS e LOCAL_DA_COLETA), com os nomes da API. */
  const RETIRAR = new Set([
    'responsavel_tecnico', 'email', 'telefone', 'ddd', 'numero_do_conselho_de_classe', 'formacao', 'art',
    'nome_do_responsavel_pelo_carro_pipa', 'responsavel_pelas_informacoes', 'placa',
    'descricao_do_local', 'local', 'endereco', 'numero', 'cep', 'latitude', 'longitude',
  ]);
  const RX_PESSOAL = /respons[aá]vel|e-?mail|telefone|celular|cpf|conselho_de_classe|latitude|longitude|endere[cç]o|descricao_do_local/i;

  const VALOR_OK = /^[\p{L}\p{N} .,()/º°ª%<>=+_-]{1,80}$/u;

  /** Endereço de uma página. Recusa conjunto e filtro fora da lista e valor estranho. */
  /* `o` é do robô (sisagua-publicador): páginas menores, para isolar a linha que a API não entrega, e mais páginas. */
  function montarUrl(endpoint, params, pagina, o) {
    const limite = (o && o.limite) || PAGINA, max = (o && o.maxPaginas) || MAX_PAGINAS;
    const ep = ENDPOINTS[endpoint];
    if (!ep) throw new Error('Conjunto de dados não permitido: ' + endpoint);
    const p = parseInt(pagina, 10);
    if (!(p >= 0 && p < max)) throw new Error('Página fora do limite (0 a ' + (max - 1) + ').');
    const q = [];
    for (const [k, v] of Object.entries(params || {})) {
      if (v === undefined || v === null || v === '') continue;
      if (!ep.filtros.includes(k)) throw new Error('Filtro não permitido em ' + endpoint + ': ' + k);
      const s = String(v).trim();
      if (!VALOR_OK.test(s)) throw new Error('Valor inválido no filtro ' + k + '.');
      q.push(encodeURIComponent(k) + '=' + encodeURIComponent(s));
    }
    q.push('limit=' + limite, 'offset=' + p);
    return BASE + endpoint + '?' + q.join('&');
  }

  /** Linhas de uma resposta: a primeira chave que for uma lista (o nome muda por conjunto). */
  function linhasDe(json) {
    if (!json || typeof json !== 'object') return null;
    for (const v of Object.values(json)) if (Array.isArray(v)) return v;
    return null;
  }

  /** Cópia da linha sem os campos de pessoa e de local exato. */
  function limparLinha(l) {
    const o = {};
    if (!l || typeof l !== 'object') return o;
    for (const [k, v] of Object.entries(l)) {
      if (RETIRAR.has(k) || RX_PESSOAL.test(k)) continue;
      if (v !== null && typeof v === 'object') continue; // só valores simples
      o[k] = v;
    }
    return o;
  }

  /** Código IBGE de 6 dígitos: do campo, se vier, ou do código da forma de abastecimento. */
  function ibge6(l) {
    const c = l && (l.codigo_ibge != null ? l.codigo_ibge : l.codigo_do_ibge);
    if (c != null && String(c).trim() !== '') return String(c).trim().slice(0, 6);
    const f = String((l && l.codigo_forma_de_abastecimento) || '');
    return /^[SC]\d{12}$/.test(f) ? f.slice(1, 7) : null;
  }

  /** "2,79" → 2.79; "8880.0" → 8880; "1.234,5" → 1234.5; "Ausente" → null. */
  function num(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    let s = String(v).trim().replace(/^[<>]=?\s*/, '');
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  /** CNPJ com 14 dígitos (a API manda número, às vezes com ".0"). */
  const cnpj = v => (v == null ? '' : String(v).replace(/\.0+$/, '').replace(/\D/g, '').padStart(14, '0'));

  const api = { HOST, BASE, PAGINA, MAX_PAGINAS, ENDPOINTS, RETIRAR, montarUrl, linhasDe, limparLinha, ibge6, num, cnpj };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SisaguaApiAberta = api;
})(typeof window !== 'undefined' ? window : globalThis);
