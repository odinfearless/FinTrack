/**
 * Leitura de faturas de cartão em PDF ou imagem.
 *
 * Duas etapas independentes, de propósito:
 *   1. extrair()  — tira texto do arquivo (pdf.js para PDF, Tesseract para imagem)
 *   2. analisar() — transforma linhas de texto em lançamentos candidatos
 *
 * Nada aqui grava no banco. O usuário revisa antes, porque OCR e heurística
 * erram, e um erro silencioso numa fatura vira dívida errada no painel.
 */

import { detectarRegioesMarcadas } from './marcacaoColorida.js';

/* ------------------------------ extração --------------------------------- */

// O fragmento pode vir só com a data ("05/08") ou já colado na descrição
// ("05/08 MERCADO"): o que interessa é o X onde a data começa. Exigir o
// fragmento inteiro igual à data fazia a detecção de colunas falhar em faturas
// que não quebram esse pedaço — e sem colunas, os lançamentos da esquerda e da
// direita viram uma linha só.
const RX_COMECA_COM_DATA = /^\d{1,2}[/.]\d{1,2}([/.]\d{2,4})?\b/;

/**
 * Descobre em que X começa cada coluna de lançamentos.
 *
 * Fatura de cartão costuma trazer os lançamentos em duas colunas, e agrupar só
 * por Y funde a linha da esquerda com a da direita.
 *
 * Duas abordagens que parecem óbvias não funcionam. Separar por distância entre
 * fragmentos falha porque nesta fatura o vão ENTRE colunas (25pt) é menor que o
 * vão entre descrição e valor DENTRO de uma coluna (até 80pt). Procurar faixas
 * verticais vazias também falha: o vão descrição→valor forma um corredor de
 * 45pt, mais largo que o corredor real entre colunas (22pt).
 *
 * O sinal confiável é semântico: todo lançamento começa por uma data, e as datas
 * de uma coluna se alinham num mesmo X. Agrupar essas posições revela as colunas.
 */
function acharColunas(itens) {
  const posicoes = itens
    .filter((it) => RX_COMECA_COM_DATA.test((it.str || '').trim()))
    .map((it) => it.transform[4])
    .sort((a, b) => a - b);

  if (posicoes.length < 6) return [];

  // Datas a menos de 12pt de distância são a mesma coluna.
  const grupos = [];
  for (const x of posicoes) {
    const ultimo = grupos[grupos.length - 1];
    if (ultimo && x - ultimo.fim <= 12) { ultimo.fim = x; ultimo.n += 1; }
    else grupos.push({ inicio: x, fim: x, n: 1 });
  }

  // Coluna de verdade tem várias datas; uma data solta é ruído de outra seção.
  const colunas = grupos.filter((g) => g.n >= 3).map((g) => g.inicio);
  if (colunas.length < 2) return [];

  // O corte é o próprio início da coluna seguinte, e não o meio do caminho: o
  // valor da coluna da esquerda fica bem à direita do centro (x≈318 de um corte
  // que cairia em 251) e seria arrastado para a coluna vizinha.
  return colunas.slice(1);
}

/**
 * Junta os fragmentos de texto do pdf.js em linhas.
 * O PDF não tem "linhas": tem pedaços de texto com coordenadas. Fragmentos com
 * Y parecido e na mesma coluna são a mesma linha; dentro dela, a ordem é a do X.
 */
function agruparEmLinhas(itens, tolerancia = 3) {
  const cortes = acharColunas(itens);
  const coluna = (x) => cortes.filter((c) => x >= c).length;

  const linhas = [];
  for (const item of itens) {
    const texto = item.str;
    if (!texto || !texto.trim()) continue;
    const x = item.transform[4];
    const y = item.transform[5];
    const col = coluna(x);

    const existente = linhas.find((l) => l.col === col && Math.abs(l.y - y) <= tolerancia);
    if (existente) existente.pedacos.push({ x, texto });
    else linhas.push({ y, col, pedacos: [{ x, texto }] });
  }

  return linhas
    // Coluna da esquerda inteira, depois a da direita: é a ordem de leitura da
    // fatura, e é o que mantém cada lançamento junto do seu próprio valor.
    .sort((a, b) => a.col - b.col || b.y - a.y)
    .map((l) => l.pedacos
      .sort((a, b) => a.x - b.x)
      .map((p) => p.texto)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim())
    .filter(Boolean);
}

/**
 * Regiões marcadas pelo usuário, em coordenadas normalizadas (0 a 1) com origem
 * no canto superior esquerdo da página — o mesmo referencial da tela.
 * `{ pagina, x, y, largura, altura }`
 */
function regioesDaPagina(regioes, pagina) {
  if (!Array.isArray(regioes) || regioes.length === 0) return null;
  const daPagina = regioes.filter((r) => Number(r.pagina) === pagina);
  return daPagina.length > 0 ? daPagina : [];
}

function dentroDeAlguma(regioes, nx, ny) {
  return regioes.some((r) => nx >= r.x && nx <= r.x + r.largura
    && ny >= r.y && ny <= r.y + r.altura);
}

async function extrairDePdf(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // O pdf.js exige um workerSrc mesmo em Node; apontar para o arquivo do
  // próprio pacote evita depender de CDN e mantém a leitura offline.
  pdfjs.GlobalWorkerOptions.workerSrc = import.meta.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');

  const tarefa = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    useSystemFonts: true,
  });

  const linhas = [];
  let paginas = 0;
  const dimensoes = [];
  let regioes = [];
  let origemDaMarcacao = 'nenhuma';

  try {
    const documento = await tarefa.promise;
    paginas = documento.numPages;

    // A marcação vem do próprio arquivo: quem circula os lançamentos num editor
    // de PDF já disse o que quer, e o app segue essa indicação. Sem marca
    // nenhuma, lê o documento inteiro.
    const detectadas = await detectarRegioesMarcadas(documento, pdfjs);
    if (detectadas.length > 0) {
      regioes = detectadas;
      origemDaMarcacao = 'arquivo';
    }

    for (let n = 1; n <= paginas; n += 1) {
      const pagina = await documento.getPage(n);
      const vista = pagina.getViewport({ scale: 1 });
      dimensoes.push({ pagina: n, largura: vista.width, altura: vista.height });

      const daPagina = regioesDaPagina(regioes, n);
      // Havendo marcação em qualquer página, as páginas sem marca são ignoradas
      // — é isso que dá ao usuário o controle de o que entra e o que não entra.
      if (daPagina && daPagina.length === 0) {
        pagina.cleanup();
        continue;
      }

      const conteudo = await pagina.getTextContent();
      const itens = daPagina
        ? conteudo.items.filter((item) => {
          // O PDF conta o Y de baixo para cima; a tela, de cima para baixo.
          const x = item.transform[4] / vista.width;
          const y = (vista.height - item.transform[5]) / vista.height;
          return dentroDeAlguma(daPagina, x, y);
        })
        : conteudo.items;

      linhas.push(...agruparEmLinhas(itens));
      pagina.cleanup();
    }
  } finally {
    await tarefa.destroy();
  }

  return { linhas, paginas, dimensoes, regioes, origemDaMarcacao };
}

const emLinhas = (texto) => texto.split('\n')
  .map((l) => l.replace(/\s+/g, ' ').trim())
  .filter(Boolean);

/**
 * Imagem é sempre lida por inteiro: a marcação vermelha é reconhecida no traço
 * vetorial do PDF, e numa foto ela seria só pixels — detectá-la exigiria varrer
 * a imagem, o que é outro problema.
 */
async function extrairDeImagem(buffer) {
  let Tesseract;
  try {
    Tesseract = (await import('tesseract.js')).default;
  } catch {
    const erro = new Error('O leitor de imagens não está disponível nesta instalação.');
    erro.status = 501;
    throw erro;
  }

  try {
    const { data } = await Tesseract.recognize(buffer, 'por');
    return { linhas: emLinhas(data.text), paginas: 1 };
  } catch (causa) {
    const erro = new Error(
      'Não foi possível ler a imagem. O reconhecimento de texto baixa um pacote de idioma '
      + 'na primeira execução e precisa de internet nesse momento. '
      + `Detalhe: ${causa.message}`,
    );
    erro.status = 502;
    throw erro;
  }
}

export async function extrair(buffer, nomeArquivo, tipoMime = '') {
  const ehPdf = /\.pdf$/i.test(nomeArquivo) || tipoMime.includes('pdf');

  if (ehPdf) {
    const resultado = await extrairDePdf(buffer);

    if (resultado.linhas.join('').length < 40) {
      // Com marcação, pouco texto quase sempre significa região no lugar errado;
      // sem marcação, significa PDF escaneado. Mensagens diferentes, porque a
      // saída para cada caso é diferente.
      const erro = new Error(resultado.origemDaMarcacao !== 'nenhuma'
        ? 'Não foi encontrado texto dentro do que está marcado. Confira se a marcação '
          + 'envolve as linhas de lançamento.'
        : 'Este PDF parece ser uma imagem escaneada, sem texto selecionável. '
          + 'Salve as páginas como PNG ou JPG e envie a imagem — aí o reconhecimento de texto entra em ação.');
      erro.status = 422;
      throw erro;
    }
    return { ...resultado, origem: 'pdf' };
  }

  return { ...(await extrairDeImagem(buffer)), origem: 'imagem' };
}

/* ------------------------------- análise --------------------------------- */

const MESES_CURTOS = {
  jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6,
  jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12,
};

// Linhas de resumo da fatura: não são compras e não devem virar lançamento.
const RUIDO = [
  /^(sub)?total/i,
  /saldo\s+(anterior|atual|devedor)/i,
  /^pagamento(s)?\b/i,
  // Sem âncora: a linha do pagamento vem com a data na frente ("10/07 Pagamento
  // via conta -10.912,72") e escapava do padrão acima. Ela não é lançamento da
  // fatura — é a quitação da anterior, e entraria como um crédito gigante.
  /pagamento\s+(via|efetuado|recebido|de\s+fatura)/i,
  /fatura\s+anterior/i,
  /limite\s+(de\s+cr[ée]dito|dispon[íi]vel|total)/i,
  /vencimento/i,
  /^(data|descri[çc][ãa]o|valor|hist[óo]rico|lan[çc]amentos?)\b.{0,30}$/i,
  /encargos?\s+(do\s+)?(m[êe]s|rotativo)/i,
  /^juros\b/i,
  /^encargos\b/i,
  /^iof\b/i,
  /^multa/i,
  /^anuidade.*(gr[áa]tis|isen)/i,
  /d[ée]bito\s+autom[áa]tico/i,
  /^p[áa]gina\s+\d/i,
  /central\s+de\s+atendimento/i,
  /^cnpj|^cpf\b/i,
  /ouvidoria|sac\b/i,
  // Detalhamento de compra internacional: são desdobramentos da mesma cobrança,
  // não compras novas. Somá-los contaria o gasto duas ou três vezes.
  /d[óo]lar\s+de\s+convers[ãa]o/i,
  /^principal\s*\(/i,
  /^[\d.,]+\s+BRL\b/i,
  // Caixa de oferta de parcelamento da fatura: valores altíssimos (o total, o
  // limite, simulações de financiamento) que entravam como se fossem compras e
  // faziam a soma do mês estourar.
  /valor\s+(total\s+financiado|solicitado)/i,
  /entrada\s*\+\s*parcelas/i,
  /\d+\s*x\s*R\$/i,
  /\d,\d{2}\s*%/,
  /lan[çc]amentos\s+atuais/i,
  // Cabeçalho de seção ("Lançamentos: compras e saques"), que às vezes chega
  // grudado na primeira compra da seção.
  /lan[çc]amentos\s*:/i,
  /demais\s+faturas/i,
  /nome\s+do\s+pagador/i,
  // Linha de "total da fatura + vencimento + limite", que abre o documento.
  /^R\$\s*[\d.,]+\s+\d{2}\/\d{2}\/\d{4}/i,
  // Blocos de resumo do extrato do Itaú.
  /\btotal\s+d(os|as|o|a)\s/i,
  /pr[óo]xima\s+fatura/i,
  /lan[çc]amentos?\s+(no\s+cart[ãa]o|produtos\s+e\s+servi)/i,
];

// Compras em cartão têm centavos; exige a vírgula decimal para não confundir
// número de cartão, CEP ou código de autorização com valor.
// O "R$" precisa ser casado inteiro: com R opcional sozinho, o R final de
// "BR 45,90" era consumido como se fosse o símbolo da moeda e sumia da descrição.
const RX_VALOR = /(-)?(?:R\$)?\s?(\d{1,3}(?:\.\d{3})*|\d+),(\d{2})(-)?/g;

const RX_DATA_BARRA = /^(\d{2})[/.](\d{2})(?:[/.](\d{2,4}))?\b/;
const RX_DATA_TEXTO = /^(\d{1,2})\s*(?:de\s*)?(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)/i;

// "PARC 03/10", "3/10", "PARCELA 3 DE 10", "03 DE 10"
const RX_PARCELA = /(?:parc(?:ela)?\.?\s*)?(\d{1,2})\s*(?:\/|\s+de\s+)\s*(\d{1,2})\b/i;

const normalizar = (v) => String(v ?? '')
  .normalize('NFD').replace(/\p{Diacritic}/gu, '')
  .toLowerCase().replace(/\s+/g, ' ').trim();

function lerValor(bruto, sinalNegativo) {
  const n = Number(`${bruto.inteiro.replace(/\./g, '')}.${bruto.centavos}`);
  return sinalNegativo ? -n : n;
}

/** Último valor monetário da linha — em fatura, o valor mora à direita. */
function acharValor(linha) {
  RX_VALOR.lastIndex = 0;
  const achados = [...linha.matchAll(RX_VALOR)];
  if (achados.length === 0) return null;

  const m = achados[achados.length - 1];
  const negativo = Boolean(m[1] || m[4]) || /\b(cr[ée]dito|estorno|pagamento)\b/i.test(linha);
  return {
    valor: lerValor({ inteiro: m[2], centavos: m[3] }, negativo),
    inicio: m.index,
    fim: m.index + m[0].length,
  };
}

function acharData(linha, mesReferencia) {
  const [anoRef, mesRef] = mesReferencia.split('-').map(Number);

  const barra = linha.match(RX_DATA_BARRA);
  if (barra) {
    const dia = Number(barra[1]);
    const mes = Number(barra[2]);
    if (dia >= 1 && dia <= 31 && mes >= 1 && mes <= 12) {
      let ano = barra[3] ? Number(barra[3]) : anoRef;
      if (ano < 100) ano += 2000;
      // Fatura de janeiro costuma trazer compras de dezembro do ano anterior.
      if (!barra[3] && mes > mesRef + 1) ano -= 1;
      return {
        data: `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`,
        fim: barra[0].length,
      };
    }
  }

  const texto = linha.match(RX_DATA_TEXTO);
  if (texto) {
    const dia = Number(texto[1]);
    const mes = MESES_CURTOS[normalizar(texto[2]).slice(0, 3)];
    if (dia >= 1 && dia <= 31 && mes) {
      let ano = anoRef;
      if (mes > mesRef + 1) ano -= 1;
      return {
        data: `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`,
        fim: texto[0].length,
      };
    }
  }

  return null;
}

/**
 * Onde está o ruído dentro do trecho — `null` se não houver.
 *
 * Devolver a posição, e não só "tem ou não tem", é o que permite salvar a
 * compra de uma linha que veio grudada num pedaço de resumo: corta-se no
 * resumo em vez de jogar a linha inteira fora.
 */
function acharRuido(trecho) {
  let achado = null;
  for (const rx of RUIDO) {
    const m = rx.exec(trecho);
    if (m && (!achado || m.index < achado.index)) achado = { index: m.index, fim: m.index + m[0].length };
  }
  return achado;
}

// Data no início de um trecho — o sinal de que ali começa outro lançamento.
// Vale a forma numérica ("05/08", "05.08.2026") e a por extenso ("12 ago").
const RX_MARCA_DATA = new RegExp(
  `(?<=^|\\s)(?:\\d{1,2}[/.]\\d{1,2}(?:[/.]\\d{2,4})?|\\d{1,2}\\s+(?:${Object.keys(MESES_CURTOS).join('|')}))(?=\\s)`,
  'gi',
);

/** O que sobra de um trecho depois de tirar a data da frente e o valor do fim. */
function descricaoDe(trecho, valor, mes) {
  const data = acharData(trecho, mes);
  return limparDescricao(trecho.slice(data ? data.fim : 0, valor.inicio));
}

/**
 * Separa uma linha que carrega mais de um lançamento.
 *
 * Fatura de cartão vem em duas colunas, e quando a detecção de coluna não pega
 * (fatura de layout diferente, região marcada cortando a coluna, OCR de imagem)
 * a linha da esquerda chega grudada na da direita. Lendo só o último valor da
 * linha, o lançamento da esquerda sumia — some um gasto sem ninguém avisar.
 *
 * O corte é sempre numa data, nunca num valor: "PARC 03/10" e "45,90 USD 12,00"
 * têm cara de dois lançamentos e são um só. Depois de cortar, dois remendos
 * desfazem os cortes indevidos — e cada um vai para um lado, o que importa:
 *
 *   sem valor  → junta com o TRECHO SEGUINTE, porque todo lançamento termina no
 *                seu valor. É o que salva "17/11 AMAZON PRIME B 10/12 13,90",
 *                partido no meio porque a parcela "10/12" tem cara de data.
 *   sem descrição → junta com o ANTERIOR, de quem o valor solto se soltou.
 */
function partirEmLancamentos(texto, mes) {
  const marcas = [...texto.matchAll(RX_MARCA_DATA)].map((m) => m.index);
  if (marcas.length < 2) return [texto];

  const inicios = marcas[0] === 0 ? marcas : [0, ...marcas];
  const trechos = inicios
    .map((inicio, i) => texto.slice(inicio, inicios[i + 1] ?? texto.length).trim())
    .filter(Boolean);

  const saida = [];
  let pendente = '';

  for (const trecho of trechos) {
    const atual = pendente ? `${pendente} ${trecho}` : trecho;
    pendente = '';

    const valor = acharValor(atual);
    if (!valor) { pendente = atual; continue; }

    if (descricaoDe(atual, valor, mes).length < 3 && saida.length > 0) {
      saida[saida.length - 1] += ` ${atual}`;
    } else saida.push(atual);
  }

  if (pendente) {
    if (saida.length > 0) saida[saida.length - 1] += ` ${pendente}`;
    else saida.push(pendente);
  }

  return saida;
}

function limparDescricao(bruta) {
  return bruta
    .replace(/\s+/g, ' ')
    // Sobra de linha do tipo "Repasse de IOF em R$ 5,56": a moeda solta no fim
    // é do valor que já foi separado, não faz parte do nome.
    .replace(/\s*(em\s+)?(R\$|US\$)?\s*$/i, '')
    .replace(/\s+em$/i, '')
    .replace(/^[\s\-–—•|:*]+/, '')
    .replace(/[\s\-–—•|:*]+$/, '')
    .trim();
}

/**
 * Sugere categoria comparando a descrição com o nome das categorias
 * cadastradas e com apelidos comuns de estabelecimento.
 */
const APELIDOS = {
  ifood: ['ifood', 'rappi', 'ze delivery'],
  mercado: ['supermerc', 'atacad', 'carrefour', 'assai', 'pao de acucar', 'hortifruti'],
  combustivel: ['posto', 'shell', 'ipiranga', 'petrobras', 'br distrib', 'combusti'],
  uber: ['uber', '99app', '99 tecnologia', 'cabify', 'taxi'],
  saude: ['farmac', 'drogaria', 'droga raia', 'panvel', 'laborat', 'clinica', 'hospital', 'odonto'],
  'compras online': ['mercado livre', 'mercadolivre', 'mercpago', 'amazon', 'magazine', 'shopee', 'aliexpress', 'americanas'],
  assinaturas: ['spotify', 'netflix', 'disney', 'hbo max', 'youtube', 'apple.com', 'prime video'],
  lazer: ['cinema', 'ingresso', 'teatro', 'restaurante', 'lanchonete', 'padaria'],
};

function sugerirCategoria(descricao, categorias) {
  const alvo = normalizar(descricao);
  if (!alvo) return null;

  // Todos os candidatos disputam, e vence o termo mais longo — assim
  // "mercado livre" ganha de "mercado" e a compra não cai em supermercado.
  const candidatos = [];

  for (const c of categorias) {
    const nome = normalizar(c.nome);
    if (nome.length >= 3 && alvo.includes(nome)) candidatos.push({ id: c.id, peso: nome.length });
  }

  for (const [nomeCategoria, termos] of Object.entries(APELIDOS)) {
    const chave = normalizar(nomeCategoria);
    const categoria = categorias.find((c) => normalizar(c.nome).startsWith(chave.slice(0, 6)));
    if (!categoria) continue;
    for (const termo of termos) {
      if (alvo.includes(termo)) candidatos.push({ id: categoria.id, peso: termo.length });
    }
  }

  if (candidatos.length === 0) return null;
  return candidatos.sort((a, b) => b.peso - a.peso)[0].id;
}

// O total da fatura, quando o documento o declara. Não vira lançamento: serve
// para a tela de revisão dizer se o que foi lido fecha com a fatura.
const RX_TOTAL_FATURA = [
  /total\s+d(?:esta|a)\s+fatura\D{0,25}(\d{1,3}(?:\.\d{3})*,\d{2})/i,
  /valor\s+total\s+da\s+fatura\D{0,25}(\d{1,3}(?:\.\d{3})*,\d{2})/i,
  // Itaú fecha a seção com "Total dos lançamentos atuais".
  /total\s+dos\s+lan[çc]amentos\D{0,25}(\d{1,3}(?:\.\d{3})*,\d{2})/i,
  // Cabeçalho do Itaú: "R$ 11.339,84  11/08/2026  R$ 84.190,00" é total,
  // vencimento e limite, nessa ordem.
  /^R\$\s*(\d{1,3}(?:\.\d{3})*,\d{2})\s+\d{2}\/\d{2}\/\d{4}/,
];

function acharTotalDaFatura(linhas) {
  for (const linha of linhas) {
    for (const rx of RX_TOTAL_FATURA) {
      const achado = rx.exec(linha.trim());
      if (achado) return Number(achado[1].replace(/\./g, '').replace(',', '.'));
    }
  }
  return null;
}

/**
 * Converte linhas de texto em lançamentos candidatos.
 * `categorias` é opcional e serve só para sugerir a classificação.
 */
export function analisar(linhas, { mes, categorias = [] } = {}) {
  const itens = [];
  const descartadas = [];

  /** Monta o candidato de um trecho que já contém um único lançamento. */
  const interpretar = (trecho, id) => {
    const achadoValor = acharValor(trecho);
    if (!achadoValor) return null;

    const achadoData = acharData(trecho, mes);
    let descricao = descricaoDe(trecho, achadoValor, mes);

    // Sem data e sem descrição sobrando, é linha de tabela ou rodapé. E toda
    // compra traz o nome de um estabelecimento: descrição que é só cifrão e
    // número ("R$ 1.133,98 R$ 1.080,91 +") é simulação de financiamento.
    if (descricao.length < 3 || !/\p{L}{3}/u.test(descricao)) {
      return { motivo: 'sem descrição identificável' };
    }

    let parcelaAtual = null;
    let parcelas = null;
    const parcela = descricao.match(RX_PARCELA);
    if (parcela) {
      const atual = Number(parcela[1]);
      const total = Number(parcela[2]);
      if (total > 1 && atual >= 1 && atual <= total) {
        parcelaAtual = atual;
        parcelas = total;
        descricao = limparDescricao(descricao.replace(parcela[0], ' '));
      }
    }

    if (!descricao) descricao = '(sem descrição)';

    return {
      item: {
        id,
        linha_original: trecho,
        data: achadoData?.data || null,
        descricao,
        // O sinal do que foi lido é preservado: crédito e estorno abatem a
        // fatura, e importá-los como valor positivo somaria a devolução à
        // dívida — o contrário do que a linha diz.
        valor: achadoValor.valor,
        credito: achadoValor.valor < 0,
        tipo: parcelas ? 'parcelamento' : 'avulso',
        parcela_atual: parcelaAtual,
        parcelas,
        categoria_id: sugerirCategoria(descricao, categorias),
        // Crédito e estorno vêm marcados como qualquer outra linha: com valor
        // negativo eles abatem a fatura, que é o que o documento faz. O que não
        // pode entrar — pagamento da fatura anterior — já foi barrado no ruído.
        selecionado: true,
      },
    };
  };

  // "Compras parceladas - próximas faturas" abre o bloco das parcelas que ainda
  // vão vencer. Elas repetem compras que a fatura já cobrou e não entram neste
  // mês; como o bloco fecha o documento, o corte é daí em diante.
  const RX_FUTURAS = /(pr[óo]ximas?\s+faturas|lan[çc]amentos?\s+futuros)/i;
  const corte = linhas.findIndex((l) => RX_FUTURAS.test(l));
  const atuais = corte >= 0 ? linhas.slice(0, corte) : linhas;
  if (corte >= 0) {
    linhas.slice(corte).forEach((l, i) => descartadas.push({
      linha: corte + i + 1, texto: l.trim(), motivo: 'parcela de fatura futura',
    }));
  }

  atuais.forEach((linha, indice) => {
    const texto = linha.trim();
    if (texto.length < 6) return;

    // Uma linha pode trazer mais de um lançamento — duas colunas da fatura que
    // chegaram grudadas. Cada trecho vira um candidato próprio.
    //
    // O descarte de ruído é por trecho, e não pela linha inteira: numa linha
    // grudada em que só o lado direito é resumo da fatura, jogar a linha fora
    // levaria junto a compra que estava do lado esquerdo.
    const trechos = partirEmLancamentos(texto, mes);

    trechos.forEach((trecho, parte) => {
      const ruido = acharRuido(trecho);
      let util = trecho;

      if (ruido && ruido.index > 0) {
        // Ruído no fim: fica a compra, sai o resumo.
        util = trecho.slice(0, ruido.index).trim();
        descartadas.push({ linha: indice + 1, texto: trecho.slice(ruido.index).trim(), motivo: 'resumo da fatura' });
      } else if (ruido) {
        // Ruído na frente: é cabeçalho de seção ("Lançamentos: compras e
        // saques"). Se vier uma data depois dele, a compra começa ali.
        RX_MARCA_DATA.lastIndex = 0;
        const proxima = [...trecho.matchAll(RX_MARCA_DATA)].find((m) => m.index >= ruido.fim);
        descartadas.push({
          linha: indice + 1,
          texto: trecho.slice(0, proxima ? proxima.index : undefined).trim(),
          motivo: 'resumo da fatura',
        });
        if (!proxima) return;
        util = trecho.slice(proxima.index).trim();
      }

      const lido = interpretar(util, trechos.length > 1 ? `l${indice}p${parte}` : `l${indice}`);
      if (!lido) return;
      if (lido.motivo) {
        descartadas.push({ linha: indice + 1, texto: util, motivo: lido.motivo });
        return;
      }
      itens.push(lido.item);
    });
  });

  // Mesma data, mesma descrição e mesmo valor duas vezes é quase sempre a
  // mesma linha lida em duplicidade (texto sobreposto no PDF, região marcada
  // que se cruza). A repetida vem desmarcada, mas continua na lista: se a
  // compra aconteceu mesmo duas vezes, é um clique para trazê-la de volta.
  const vistos = new Set();
  for (const item of itens) {
    const chave = `${item.data}|${item.descricao.toLowerCase()}|${Math.round(item.valor * 100)}`;
    if (vistos.has(chave)) {
      item.repetida = true;
      item.selecionado = false;
    }
    vistos.add(chave);
  }

  return { itens, descartadas, total_fatura: acharTotalDaFatura(linhas) };
}
