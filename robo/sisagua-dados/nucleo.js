/*
 * Núcleo do sisagua-dados: quais arquivos dos dados abertos do SISAGUA entram, como se reconhece a
 * Saneago, quais colunas saem (LGPD) e a leitura dos zips e CSVs. Um lugar só para as regras do
 * extrato: a ferramenta de linha de comando (sisagua-dados.js) e a Busca SISAGUA do programa
 * (busca/, no navegador) usam este mesmo arquivo.
 *
 * Só usa o que o Node (20+) e o Edge/Chrome têm em comum: Blob (slice, stream, arrayBuffer),
 * DecompressionStream('deflate-raw') e TextDecoder. Não acessa a rede nem o disco: recebe os
 * arquivos já abertos (Blob/File). Os arquivos têm centenas de MB (alguns GB descompactados):
 * nada é lido inteiro na memória.
 */
(function (root) {
  'use strict';

  const HOST = 's3.sa-east-1.amazonaws.com';
  const BASE = 'https://' + HOST + '/ckan.saude.gov.br/SISAGUA/';
  const SANEAGO = { cnpj: '01616929000102', raiz: '01616929', sigla: 'SANEAGO', nome: 'SANEAMENTO DE GOIAS SA' };
  const FORMATO = 1;

  // Colunas com nome de pessoa ou contato: não entram no extrato (LGPD).
  const PESSOAIS = ['NO_RESPONSAVEL_TECNICO', 'TP_FORMACAO', 'CO_CONSELHO_CLASSE', 'ART', 'DS_EMAIL', 'NU_TELEFONE', 'NU_DDD'];
  // Local exato da coleta (endereço, descrição livre, coordenadas): muitas amostras são em casas e a
  // descrição às vezes traz telefone ou nome do morador. Fica só o tipo de local, a zona e a área.
  const LOCAL_DA_COLETA = ['DS_LOCAL', 'NO_LOCAL', 'NO_ENDERECO', 'NU_LATITUDE', 'NU_LONGITUDE', 'Descrição do Local', 'Local', 'Latitude', 'Longitude'];
  const RETIRAR = new Set([...PESSOAIS, ...LOCAL_DA_COLETA]);

  /*
   * Os conjuntos. "porAno": um arquivo por ano ({ano} no nome). Filtro pela instituição (cnpj) ou,
   * na vigilância, que não traz a empresa, pelo código da forma de abastecimento (os códigos da
   * Saneago no cadastro). "ano": coluna do ano, para os arquivos com todos os anos juntos.
   * O cadastro vem primeiro: os códigos dele filtram a vigilância.
   */
  const CONJUNTOS = [
    { id: 'cadastro', titulo: 'Cadastro — população abastecida', arquivo: 'cadastro_populacao_abastecida_csv', cnpj: 'NU_CNPJ', codigo: 'NU_SOLUCAO_ABASTECIMENTO', ano: 'NU_ANO', todosOsAnos: true },
    { id: 'tratamento', titulo: 'Cadastro — tratamento de água', arquivo: 'cadastro_tratamento_de_agua_csv', cnpj: 'NU_CNPJ_INSTITUICAO', codigo: 'NU_SOLUCAO_ABASTECIMENTO', ano: 'NU_ANO', todosOsAnos: true },
    { id: 'controleMensalBasicos', titulo: 'Controle mensal — parâmetros básicos', arquivo: 'controle_mensal_parametros_basicos_{ano}_csv', porAno: true, cnpj: 'CNPJ da Instituição', codigo: 'Código Forma de abastecimento' },
    { id: 'controleMensalDemais', titulo: 'Controle mensal — demais parâmetros', arquivo: 'controle_mensal_demais_parametros_csv', cnpj: 'NU_CNPJ_INSTITUICAO', codigo: 'NU_SOLUCAO_ABASTECIMENTO', ano: 'NU_ANO' },
    { id: 'controleMensalForaPadrao', titulo: 'Controle mensal — amostras fora do padrão', arquivo: 'controle_mensal_amostras_fora_padrao_csv', cnpj: 'NU_CNPJ_INSTITUICAO', codigo: 'NU_SOLUCAO_ABASTECIMENTO', ano: 'NU_ANO' },
    { id: 'controleSemestral', titulo: 'Controle semestral', arquivo: 'controle_semestral_{ano}_csv', porAno: true, cnpj: 'NU_CNPJ_INSTITUICAO', codigo: 'NU_SOLUCAO_ABASTECIMENTO' },
    { id: 'vigilanciaBasicos', titulo: 'Vigilância — parâmetros básicos', arquivo: 'vigilancia_parametros_basicos_{ano}_csv', porAno: true, codigo: 'NU_SOLUCAO_ABASTECIMENTO' },
    { id: 'vigilanciaDemais', titulo: 'Vigilância — demais parâmetros', arquivo: 'vigilancia_demais_parametros_csv', codigo: 'Código Forma de abastecimento', ano: 'Ano' },
  ];

  // "1616929000102.0" (número decimal da planilha de origem) ou com pontuação "01.616.929/0001-02"
  const normCNPJ = v => { let t = String(v || '').trim(); if (/^\d+\.\d+$/.test(t)) t = t.split('.')[0]; return t.replace(/\D/g, '').padStart(14, '0'); };
  const ehSaneago = v => normCNPJ(v).startsWith(SANEAGO.raiz);
  const RX_COD = /[SC]52\d{10}/;

  function arquivosDo(conj, anos) {
    if (!conj.porAno) return [{ nome: conj.arquivo + '.zip', ano: null }];
    return anos.map(a => ({ nome: conj.arquivo.replace('{ano}', a) + '.zip', ano: a }));
  }
  /** Todos os arquivos de uma atualização, na ordem (o cadastro primeiro). */
  function arquivosNecessarios(anos, ids) {
    const lista = [];
    for (const c of CONJUNTOS) if (!ids || ids.includes(c.id) || c.id === 'cadastro') for (const a of arquivosDo(c, anos)) lista.push(a.nome);
    return lista;
  }
  /** O navegador renomeia o segundo download igual: "x (1).zip". Devolve o nome da fonte. */
  const nomeDaFonte = n => String(n || '').replace(/ \(\d+\)(\.zip)$/i, '$1');
  /** Nome do arquivo do extrato, com a data local (geradoEm é UTC: à noite já seria o dia seguinte). */
  function nomeDoExtrato(d) { const z = n => String(n).padStart(2, '0'); return `sisagua-saneago-${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}.json.gz`; }
  function anosPadrao(hoje) { const y = (hoje || new Date()).getFullYear(); return [String(y - 1), String(y)]; }
  function conferirAnos(anos) { for (const a of anos) if (!/^20\d\d$/.test(a)) throw new Error('ano inválido: ' + a); return anos; }

  // ---------------------------------------------------------------- zip

  const bytes = async (blob, ini, fim) => new DataView(await blob.slice(ini, fim).arrayBuffer());
  const u64 = (dv, p) => Number(dv.getBigUint64(p, true));

  /** Lista as entradas de um zip (Blob/File): [{ nome, metodo, tamanhoComprimido, tamanho, inicioDados }]. */
  async function entradasZip(blob, rotulo) {
    const nomeZip = rotulo || blob.name || 'zip';
    const total = blob.size;
    // fim do diretório central: nos últimos 64 KB + 22 bytes
    const n = Math.min(total, 65557);
    const cauda = await bytes(blob, total - n, total);
    let eocd = -1;
    for (let i = cauda.byteLength - 22; i >= 0; i--) if (cauda.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error(`${nomeZip}: não é um arquivo zip (fim do diretório não encontrado) — o download terminou?`);
    let qtd = cauda.getUint16(eocd + 10, true);
    let tamDir = cauda.getUint32(eocd + 12, true);
    let iniDir = cauda.getUint32(eocd + 16, true);
    if (iniDir === 0xffffffff || qtd === 0xffff || tamDir === 0xffffffff) {
      // zip64: localizador logo antes do EOCD
      const loc = eocd - 20;
      if (loc < 0 || cauda.getUint32(loc, true) !== 0x07064b50) throw new Error(`${nomeZip}: zip64 sem localizador`);
      const pos64 = u64(cauda, loc + 8);
      const e64 = await bytes(blob, pos64, pos64 + 56);
      if (e64.getUint32(0, true) !== 0x06064b50) throw new Error(`${nomeZip}: zip64 inválido`);
      qtd = u64(e64, 32); tamDir = u64(e64, 40); iniDir = u64(e64, 48);
    }
    const dir = await bytes(blob, iniDir, iniDir + tamDir);
    const dec = new TextDecoder('utf-8');
    const lista = [];
    let p = 0;
    for (let k = 0; k < qtd; k++) {
      if (dir.getUint32(p, true) !== 0x02014b50) throw new Error(`${nomeZip}: diretório central inválido`);
      const metodo = dir.getUint16(p + 10, true);
      let comp = dir.getUint32(p + 20, true), tam = dir.getUint32(p + 24, true);
      const nNome = dir.getUint16(p + 28, true), nExtra = dir.getUint16(p + 30, true), nCom = dir.getUint16(p + 32, true);
      let local = dir.getUint32(p + 42, true);
      const nome = dec.decode(new Uint8Array(dir.buffer, dir.byteOffset + p + 46, nNome));
      // campos de 64 bits no extra 0x0001, na ordem: tamanho, comprimido, deslocamento
      let e = p + 46 + nNome;
      const fimExtra = e + nExtra;
      while (e + 4 <= fimExtra) {
        const id = dir.getUint16(e, true), len = dir.getUint16(e + 2, true);
        if (id === 0x0001) {
          let q = e + 4;
          if (tam === 0xffffffff) { tam = u64(dir, q); q += 8; }
          if (comp === 0xffffffff) { comp = u64(dir, q); q += 8; }
          if (local === 0xffffffff) { local = u64(dir, q); q += 8; }
        }
        e += 4 + len;
      }
      const cab = await bytes(blob, local, local + 30);
      if (cab.getUint32(0, true) !== 0x04034b50) throw new Error(`${nomeZip}: cabeçalho local inválido em ${nome}`);
      const inicioDados = local + 30 + cab.getUint16(26, true) + cab.getUint16(28, true);
      if (inicioDados + comp > total) throw new Error(`${nomeZip}: arquivo cortado — o download terminou?`);
      lista.push({ nome, metodo, tamanhoComprimido: comp, tamanho: tam, inicioDados });
      p += 46 + nNome + nExtra + nCom;
    }
    return lista;
  }

  /** Fluxo (ReadableStream) com o conteúdo descompactado de uma entrada do zip. */
  function fluxoEntrada(blob, entrada) {
    const bruto = blob.slice(entrada.inicioDados, entrada.inicioDados + entrada.tamanhoComprimido).stream();
    if (entrada.metodo === 0) return bruto;
    if (entrada.metodo !== 8) throw new Error(`${entrada.nome}: compressão ${entrada.metodo} não suportada`);
    return bruto.pipeThrough(new DecompressionStream('deflate-raw'));
  }

  // ---------------------------------------------------------------- CSV

  /** Divide uma linha (sem a quebra) em campos, com aspas duplas e "" dentro. */
  function camposDaLinha(linha, sep = ';') {
    if (linha.indexOf('"') < 0) return linha.split(sep);
    const out = []; let campo = '', aspas = false;
    for (let i = 0; i < linha.length; i++) {
      const c = linha[i];
      if (aspas) {
        if (c === '"') { if (linha[i + 1] === '"') { campo += '"'; i++; } else aspas = false; }
        else campo += c;
      } else if (c === '"' && campo === '') aspas = true;
      else if (c === sep) { out.push(campo); campo = ''; }
      else campo += c;
    }
    out.push(campo);
    return out;
  }

  /**
   * Lê um CSV (ReadableStream de bytes) separando as linhas e só divide em campos as que passam em
   * talvez(linhaCrua) — um teste barato de texto, como a raiz do CNPJ. O cabeçalho (1ª linha) vai
   * sempre para aoCabecalho. Linha com número ímpar de aspas continua na seguinte (quebra dentro de
   * campo entre aspas). ISO-8859-1 (lido como windows-1252); um BOM UTF-8 troca para UTF-8.
   * progresso(linhas) é chamado de tempos em tempos. Devolve { linhas, passaram }.
   */
  async function filtrarCSV(fluxo, { talvez, aoCabecalho, aoLinha, progresso, separador = ';' }) {
    const NL = '\n', CR = 13;
    let dec = null, resto = '', n = 0, passaram = 0, cab = null, pendente = '', proximo = 200000;
    const impar = s => { let k = 0; for (let i = s.indexOf('"'); i >= 0; i = s.indexOf('"', i + 1)) k++; return k % 2 === 1; };
    const linha = l => {
      if (pendente) { l = pendente + NL + l; pendente = ''; }
      if (impar(l)) { pendente = l; return; }
      n++;
      if (!cab) { cab = camposDaLinha(l, separador).map(s => s.trim()); aoCabecalho(cab); return; }
      if (l === '' || (talvez && !talvez(l))) return;
      passaram++;
      aoLinha(camposDaLinha(l, separador));
    };
    const leitor = fluxo.getReader();
    let inicio = new Uint8Array(0); // os primeiros bytes, até dar para ver se há BOM
    const escolher = buf => {
      const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
      dec = new TextDecoder(bom ? 'utf-8' : 'windows-1252');
      return bom ? buf.subarray(3) : buf;
    };
    try {
      for (;;) {
        const { done, value } = await leitor.read();
        if (done) break;
        let buf = value;
        if (!dec) {
          const junto = new Uint8Array(inicio.length + buf.length);
          junto.set(inicio); junto.set(buf, inicio.length);
          if (junto.length < 3) { inicio = junto; continue; }
          buf = escolher(junto);
        }
        const s = resto + dec.decode(buf, { stream: true });
        let ini = 0, i;
        while ((i = s.indexOf(NL, ini)) >= 0) {
          linha(s.charCodeAt(i - 1) === CR ? s.slice(ini, i - 1) : s.slice(ini, i));
          ini = i + 1;
        }
        resto = s.slice(ini);
        if (progresso && n >= proximo) { proximo = n + 200000; progresso(n); }
      }
    } catch (e) {
      try { await leitor.cancel(); } catch (e2) { /* já fechado */ }
      throw e;
    }
    if (!dec) resto = new TextDecoder('windows-1252').decode(escolher(inicio)); // arquivo de 1 ou 2 bytes
    let s = resto + dec.decode();
    if (s.charCodeAt(s.length - 1) === CR) s = s.slice(0, -1);
    if (s) linha(s);
    if (pendente) { const p = pendente; pendente = ''; n++; if (cab && (!talvez || talvez(p))) { passaram++; aoLinha(camposDaLinha(p, separador)); } }
    return { linhas: n, passaram };
  }

  // ---------------------------------------------------------------- filtro

  /**
   * Filtra um zip (Blob/File) de um conjunto. codigos: Set dos códigos da Saneago no cadastro (para
   * a vigilância). Devolve { colunas, linhas, lidas }.
   */
  async function filtrarZip(blob, nomeZip, conj, { anos, codigos, progresso }) {
    const entradas = (await entradasZip(blob, nomeZip)).filter(e => /\.csv$/i.test(e.nome));
    if (!entradas.length) throw new Error(`${nomeZip}: nenhum CSV dentro do zip`);
    let colunas = null, iCnpj = -1, iCod = -1, iAno = -1, manter = [];
    const linhas = [];
    let lidas = 0;
    const anosSet = new Set(anos.map(String));
    for (const ent of entradas) {
      const r = await filtrarCSV(fluxoEntrada(blob, ent), {
        // teste barato no texto cru; o certo vem depois, campo a campo
        talvez: conj.cnpj ? l => l.includes('1616929') : l => RX_COD.test(l),
        progresso: progresso ? k => progresso(lidas + k) : null,
        aoCabecalho: cab => {
          if (colunas && cab.join(';') !== colunas.join(';')) throw new Error(`${ent.nome}: cabeçalho diferente do primeiro CSV do zip`);
          if (colunas) return;
          colunas = cab;
          iCnpj = conj.cnpj ? cab.indexOf(conj.cnpj) : -1;
          iCod = cab.indexOf(conj.codigo);
          iAno = conj.ano ? cab.indexOf(conj.ano) : -1;
          if (conj.cnpj && iCnpj < 0) throw new Error(`${ent.nome}: sem a coluna ${conj.cnpj}`);
          if (iCod < 0) throw new Error(`${ent.nome}: sem a coluna ${conj.codigo}`);
          if (conj.ano && iAno < 0) throw new Error(`${ent.nome}: sem a coluna ${conj.ano}`);
          manter = cab.map((c, i) => [c, i]).filter(([c]) => !RETIRAR.has(c)).map(([, i]) => i);
        },
        aoLinha: c => {
          if (conj.cnpj ? !ehSaneago(c[iCnpj]) : !codigos.has(String(c[iCod]).trim())) return;
          if (iAno >= 0 && !conj.todosOsAnos && !anosSet.has(String(c[iAno]).trim().split('.')[0])) return;
          linhas.push(manter.map(i => (c[i] === undefined ? '' : String(c[i]).trim())));
        },
      });
      lidas += r.linhas;
    }
    return { colunas: manter.map(i => colunas[i]), linhas, lidas };
  }

  /** Tira as colunas com o mesmo valor em todas as linhas (região, UF, nome da empresa…) e as guarda à parte. */
  function compactar(colunas, linhas) {
    if (!linhas.length) return { colunas, linhas, constantes: {} };
    const constantes = {}, ficam = [];
    colunas.forEach((c, i) => {
      const v = linhas[0][i];
      if (linhas.every(l => l[i] === v)) constantes[c] = v; else ficam.push(i);
    });
    return { colunas: ficam.map(i => colunas[i]), linhas: linhas.map(l => ficam.map(i => l[i])), constantes };
  }

  /**
   * Monta o extrato. obter(nomeDoArquivo) devolve { blob, modificado } ou null (arquivo que não
   * veio: o conjunto é pulado, com aviso no log). antes(nome) é chamado antes de cada arquivo
   * (a ferramenta baixa ali) e depois(nome) ao terminar (a ferramenta apaga o zip).
   */
  async function montarExtrato({ anos, conjuntos = null, obter, antes, depois, log = () => {}, progresso, agora = new Date() }) {
    conferirAnos(anos);
    const escolhidos = CONJUNTOS.filter(c => !conjuntos || conjuntos.includes(c.id) || c.id === 'cadastro');
    const extrato = { formato: FORMATO, ferramenta: 'sisagua-dados', geradoEm: agora.toISOString(), fonte: BASE, empresa: SANEAGO, anos, conjuntos: {} };
    const codigos = new Set();
    for (const conj of escolhidos) {
      const t0 = Date.now();
      const partes = [];
      for (const arq of arquivosDo(conj, anos)) {
        if (antes) await antes(arq.nome);
        const a = await obter(arq.nome);
        if (!a) { log(`  (sem ${arq.nome}: pulado)`); continue; }
        if (progresso) progresso({ arquivo: arq.nome, conjunto: conj.titulo, linhas: 0 });
        const r = await filtrarZip(a.blob, arq.nome, conj, { anos, codigos, progresso: progresso ? k => progresso({ arquivo: arq.nome, conjunto: conj.titulo, linhas: k }) : null });
        partes.push({ arquivo: arq.nome, modificado: a.modificado || '', ...r });
        if (depois) await depois(arq.nome);
      }
      if (!partes.length) continue;
      const colunas = partes[0].colunas;
      for (const p of partes) if (p.colunas.join(';') !== colunas.join(';')) throw new Error(`${conj.id}: colunas diferentes entre ${partes[0].arquivo} e ${p.arquivo}`);
      const todas = [].concat(...partes.map(p => p.linhas));
      if (conj.id === 'cadastro') { const i = colunas.indexOf(conj.codigo); for (const l of todas) codigos.add(l[i]); }
      const c = compactar(colunas, todas);
      extrato.conjuntos[conj.id] = { titulo: conj.titulo, arquivos: partes.map(p => ({ nome: p.arquivo, modificado: p.modificado, linhasLidas: p.lidas, linhasSaneago: p.linhas.length })), colunaCodigo: conj.codigo, ...c };
      log(`  ${conj.titulo}: ${todas.length} linha(s) da Saneago de ${partes.reduce((s, p) => s + p.lidas, 0)} lidas (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    }
    if (!extrato.conjuntos.cadastro) throw new Error('faltou o cadastro (cadastro_populacao_abastecida_csv.zip): sem ele não se sabe quais sistemas são da Saneago');
    return { extrato, codigos: codigos.size };
  }

  const api = { HOST, BASE, SANEAGO, FORMATO, PESSOAIS, LOCAL_DA_COLETA, RETIRAR, CONJUNTOS, normCNPJ, ehSaneago, RX_COD, arquivosDo, arquivosNecessarios, nomeDaFonte, nomeDoExtrato, anosPadrao, conferirAnos, entradasZip, fluxoEntrada, camposDaLinha, filtrarCSV, filtrarZip, compactar, montarExtrato };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SisaguaDadosNucleo = api;
})(typeof window !== 'undefined' ? window : globalThis);
