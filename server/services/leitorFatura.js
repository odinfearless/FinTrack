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
import { normalizar, sugerirCategoria } from './categorias.js';

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
 * Refaz as linhas a partir da posição das palavras na imagem.
 *
 * O reconhecimento faz análise de layout antes de ler, e numa tela de app ele
 * às vezes enxerga duas colunas — nomes de um lado, valores do outro. Quando
 * isso acontece, o texto corrido sai com todos os nomes primeiro e todos os
 * valores depois, e nenhum lançamento fica junto do seu valor.
 *
 * As coordenadas de cada palavra não têm esse problema: palavras cujo centro
 * está na mesma altura são a mesma linha, e dentro dela a ordem é a do X — o
 * mesmo raciocínio que já monta as linhas de um PDF.
 */
function linhasPorPosicao(dados) {
  const palavras = [];
  for (const bloco of dados.blocks || []) {
    for (const paragrafo of bloco.paragraphs || []) {
      for (const linha of paragrafo.lines || []) {
        for (const palavra of linha.words || []) {
          const texto = (palavra.text || '').trim();
          if (texto && palavra.bbox) palavras.push({ texto, ...palavra.bbox });
        }
      }
    }
  }
  if (palavras.length < 4) return null;

  // A tolerância sai da própria imagem: print de celular e foto de fatura têm
  // escalas muito diferentes, e um número fixo de pixels serviria só a uma.
  const alturas = palavras.map((p) => p.y1 - p.y0).sort((a, b) => a - b);
  const tolerancia = Math.max((alturas[Math.floor(alturas.length / 2)] || 10) * 0.6, 4);

  const linhas = [];
  for (const p of palavras.sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1))) {
    const centro = (p.y0 + p.y1) / 2;
    const atual = linhas[linhas.length - 1];
    if (atual && centro - atual.centro <= tolerancia) atual.palavras.push(p);
    else linhas.push({ centro, palavras: [p] });
  }

  return linhas
    .map((l) => l.palavras.sort((a, b) => a.x0 - b.x0).map((p) => p.texto).join(' ').trim())
    .filter(Boolean);
}

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

  let worker;
  try {
    worker = await Tesseract.createWorker('por');
    // A posição das palavras vem em `blocks`, e só quando é pedida — o atalho
    // `Tesseract.recognize` devolve o texto corrido e mais nada.
    const { data } = await worker.recognize(buffer, {}, { text: true, blocks: true });

    const doTexto = emLinhas(data.text);
    const porPosicao = linhasPorPosicao(data);

    // Entre as duas leituras vence a que reconhece mais lançamentos. É o único
    // critério que não depende de adivinhar o layout: quando o texto corrido já
    // vinha certo — foto de fatura impressa —, é ele que ganha; quando o app foi
    // lido em duas colunas e nenhum valor ficou junto do seu nome, ganha a
    // reconstrução por posição.
    const contar = (linhas) => (linhas ? analisar(linhas, { mes: '2000-01' }).itens.length : -1);
    const linhas = contar(porPosicao) > contar(doTexto) ? porPosicao : doTexto;

    return { linhas, paginas: 1 };
  } catch (causa) {
    const erro = new Error(
      'Não foi possível ler a imagem. O reconhecimento de texto baixa um pacote de idioma '
      + 'na primeira execução e precisa de internet nesse momento. '
      + `Detalhe: ${causa.message}`,
    );
    erro.status = 502;
    throw erro;
  } finally {
    // O worker é um processo à parte: sem encerrá-lo, cada leitura deixaria um
    // para trás e o servidor iria acumulando memória a cada importação.
    await worker?.terminate();
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

// Mesma coisa, aceitando o ponto como separador decimal — só para o print de
// app, onde o reconhecimento troca a vírgula por ponto com frequência e um
// valor não lido faz a compra inteira se fundir na de cima. Na fatura em PDF
// esta versão não entra: lá "05.08" é data, e ela viraria R$ 5,08.
//
// A folga é segura porque grupo de milhar tem sempre três dígitos: "60.00" só
// pode ser decimal, e "1.234" continua não sendo valor nenhum.
const RX_VALOR_PONTO = /(-)?(?:R\$)?\s?(\d{1,3}(?:\.\d{3})*|\d+)[.,](\d{2})(?!\d)(-)?/g;

const RX_DATA_BARRA = /^(\d{2})[/.](\d{2})(?:[/.](\d{2,4}))?\b/;
const RX_DATA_TEXTO = /^(\d{1,2})\s*(?:de\s*)?(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)/i;

// "PARC 03/10", "3/10", "PARCELA 3 DE 10", "03 DE 10"
const RX_PARCELA = /(?:parc(?:ela)?\.?\s*)?(\d{1,2})\s*(?:\/|\s+de\s+)\s*(\d{1,2})\b/i;

function lerValor(bruto, sinalNegativo) {
  const n = Number(`${bruto.inteiro.replace(/\./g, '')}.${bruto.centavos}`);
  return sinalNegativo ? -n : n;
}

/**
 * Todos os valores monetários da linha, na ordem em que aparecem.
 * `aceitarPonto` só é usado na leitura de print de app — ver RX_VALOR_PONTO.
 */
function acharValores(linha, { aceitarPonto = false } = {}) {
  const rx = aceitarPonto ? RX_VALOR_PONTO : RX_VALOR;
  rx.lastIndex = 0;
  const negativo = /\b(cr[ée]dito|estorno|pagamento)\b/i.test(linha);

  return [...linha.matchAll(rx)].map((m) => ({
    valor: lerValor({ inteiro: m[2], centavos: m[3] }, Boolean(m[1] || m[4]) || negativo),
    inicio: m.index,
    fim: m.index + m[0].length,
  }));
}

/** Último valor monetário da linha — em fatura, o valor mora à direita. */
function acharValor(linha) {
  const achados = acharValores(linha);
  return achados.length > 0 ? achados[achados.length - 1] : null;
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

/* ----------------------- extrato em lista de aplicativo ------------------- */

/**
 * Print de app de banco não tem a estrutura de uma fatura em PDF.
 *
 * Na fatura, cada lançamento é uma linha inteira: "05/08 MERCADO 45,90". No app
 * a mesma informação vem espalhada — a data é um cabeçalho de dia que vale para
 * todos os lançamentos abaixo dele, o nome do estabelecimento quebra em duas ou
 * três linhas, o valor fica à direita da linha em que o nome termina, e embaixo
 * de cada compra ainda vem uma legenda ("Cartão físico").
 *
 * O que este bloco faz é traduzir um formato no outro: cada lançamento vira uma
 * linha "dd/mm descrição valor" e daí para frente vale a análise que já existe
 * — ruído, parcela, categoria, duplicata, tudo igual para os dois casos.
 */

// "2 de agosto", "12 de dezembro de 2025", "Domingo, 2 de ago" — o dia da
// semana na frente é como o Inter escreve, e o mês tanto faz vir por extenso
// como abreviado. O ano quase nunca aparece: o app o omite dentro do ano
// corrente, e quem o completa depois é o mês da fatura.
//
// O espaço entre o dia e o "de" é opcional porque o reconhecimento o perde com
// frequência — "1 de agosto" sai "1de agosto". Sem essa folga o cabeçalho deixa
// de ser cabeçalho: a data para de avançar e o dia inteiro vai para a
// competência errada, colado na descrição da compra seguinte. Já o espaço
// depois do "de" continua obrigatório, senão "1demais" viraria 1º de maio.
const RX_CABECALHO_DIA = new RegExp(
  '^(?:(?:segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo)(?:[-\\s]?feira)?,?\\s+)?'
  + '(\\d{1,2})\\s*de\\s+([a-zà-ú]{3,9})\\.?(?:\\s+de\\s+(\\d{4}))?\\b',
  'i',
);

function lerCabecalhoDeDia(linha) {
  const m = linha.match(RX_CABECALHO_DIA);
  if (!m) return null;

  const dia = Number(m[1]);
  // O nome do mês por extenso tem sempre a mesma abreviação de três letras que
  // a fatura usa ("agosto" → "ago", "março" → "mar"), então a tabela é a mesma.
  const mes = MESES_CURTOS[normalizar(m[2]).slice(0, 3)];
  if (!mes || dia < 1 || dia > 31) return null;

  return {
    data: `${String(dia).padStart(2, '0')}/${String(mes).padStart(2, '0')}${m[3] ? `/${m[3]}` : ''}`,
    resto: linha.slice(m[0].length).trim(),
  };
}

// Legendas que o app escreve embaixo do lançamento. Além de não serem compras,
// elas marcam o fim do lançamento de cima — é por isso que valem de delimitador.
const LEGENDAS_DO_APP = [
  /^cart[ãa]o\s+(f[íi]sico|virtual|adicional|digital)/i,
  /^compra\s+(parcelada|internacional|no\s+exterior|aprovada)/i,
  /^(pagamento|compra)\s+(no\s+)?(cr[ée]dito|d[ée]bito)/i,
  /^(em\s+processamento|pendente|aprovad[ao])\b/i,
];

const ehLegendaDoApp = (linha) => LEGENDAS_DO_APP.some((rx) => rx.test(linha));

// "Parcela 2 de 10", "2 de 10" ou "2/10" sozinhos, embaixo do nome da compra.
const RX_LINHA_DE_PARCELA = /^(?:parcela\s*)?\d{1,2}\s*(?:\/|\s+de\s+)\s*\d{1,2}$/i;

// Botões do rodapé da tela. Merecem regra própria porque caem exatamente onde
// o nome do estabelecimento cairia — logo abaixo do último lançamento — e sem
// isso "Parcelar fatura" viraria parte do nome da última compra.
const RX_BOTAO_DO_APP = /^(pagar|parcelar|antecipar|ver\s+(mais|fatura|todos))\b/i;

/**
 * É um extrato de app, e não uma fatura?
 *
 * O sinal é a combinação de duas coisas: existe cabeçalho de dia sozinho numa
 * linha, e as linhas de valor **não** trazem data própria. Na fatura em PDF é o
 * contrário — toda linha de valor começa pela data da compra —, e é isso que
 * impede esta tradução de atropelar o formato que já funciona.
 */
function pareceListaDeApp(linhas, mes) {
  const cabecalhos = linhas.filter((l) => lerCabecalhoDeDia(l.trim())?.resto === '');
  if (cabecalhos.length === 0) return false;

  const comValor = linhas.filter((l) => acharValor(l));
  if (comValor.length < 2) return false;

  const semDataPropria = comValor.filter((l) => !acharData(l.trim(), mes));
  return semDataPropria.length >= comValor.length * 0.7;
}

/**
 * Limpa um pedaço de descrição.
 *
 * A limpeza é por pedaço, e não na descrição já montada: o "R$" que o OCR leu
 * como "RS" fica no fim da linha de onde o valor saiu, que nem sempre é a
 * última — quando o valor vem alinhado com a primeira linha do nome, esse
 * resto acabaria no meio da descrição.
 */
const limparPedaco = (texto) => texto
  // A seta que o app põe no fim da linha vira ">" ou "›" no reconhecimento.
  .replace(/[>›»]+/g, ' ')
  .replace(/\s+/g, ' ')
  .replace(/\s+R[$S]?$/i, '')
  .trim();

// A linha traduzida é lida pela análise da fatura, que só entende vírgula
// decimal — o ponto aceito na leitura do print para aqui.
const comVirgulaDecimal = (valor) => valor.replace(/\.(\d{2})(-?)$/, ',$1$2');

/** Tem nome de gente ou de loja aqui, ou é sobra de ícone ("O", "WD", "Vi)")? */
const temTextoUtil = (texto) => /\p{L}{3}/u.test(texto);

/**
 * Conserta a vírgula do valor lida como barra: "-R$ 24/13".
 *
 * Só vale com o "R$" na frente. Solto, "4/10" é parcela — e trocar a barra por
 * vírgula ali transformaria a parcela de uma compra em R$ 4,10.
 */
const consertarSeparador = (linha) => linha.replace(
  /(R[$S]\s?(?:\d{1,3}(?:\.\d{3})*|\d+))\/(\d{2})(?!\d)/gi,
  '$1,$2',
);

/**
 * De que lado do valor mora o nome do estabelecimento.
 *
 * Há dois desenhos de lista por aí, e a diferença não é cosmética:
 *
 *   Itaú   NOME DA LOJA          R$ 45,90     ← valor à direita, mesma linha
 *   Inter  Restaurantes                       ← categoria
 *          -R$ 21,00                          ← valor sozinho na linha
 *          FRUTAH SIMPLESMENT SAO             ← nome, embaixo
 *
 * É isso que decide para onde vai um trecho solto entre duas compras: no
 * primeiro desenho ele é o nome da compra de baixo; no segundo, o fim do nome
 * da compra de cima. Errar o lado funde as duas.
 *
 * O sinal é a própria linha do valor: quando ela carrega texto de verdade, o
 * nome está nela; quando vem só com o valor e sobra de ícone, o nome está fora.
 */
function nomeDepoisDoValor(linhas) {
  const primeiro = linhas.findIndex((l) => lerCabecalhoDeDia(l.trim()));
  const daLista = primeiro < 0 ? linhas : linhas.slice(primeiro + 1);

  const comValor = daLista
    .map((l) => ({ texto: l.trim(), valores: acharValores(l.trim(), { aceitarPonto: true }) }))
    .filter((l) => l.valores.length > 0);
  if (comValor.length < 2) return false;

  const comNome = comValor.filter((l) => temTextoUtil(l.texto.slice(0, l.valores[0].inicio)));
  return comNome.length * 2 < comValor.length;
}

// Quantas linhas o nome ocupa depois do valor. Duas cobrem o
// "ESTABELECIMENTO / CIDADE BRA" desses aplicativos — o que passar disso é
// rodapé de tela ("Parcelar fatura"), e não nome de loja.
const MAX_LINHAS_DE_NOME = 2;

/**
 * Converte as linhas de um print de app em linhas no formato da fatura.
 *
 * Os pedaços de descrição ficam pendentes até aparecer um valor, porque é o
 * valor que fecha o lançamento. O que decide o destino de um pedaço que ficou
 * pendente quando chega a legenda é se **já saiu um lançamento desde a legenda
 * anterior** — porque a legenda é o rodapé de uma compra, e entre duas delas há
 * exatamente uma:
 *
 *   saiu   → o valor estava na primeira linha do nome e o pedaço é o resto do
 *            nome: ele completa esse lançamento.
 *   não saiu → o bloco é uma compra inteira cujo valor o reconhecimento não
 *            leu. Grudá-la na compra de cima fundiria duas em uma e apagaria um
 *            valor sem avisar; ela sai como linha ignorada, que o usuário vê.
 */
function normalizarListaDeApp(linhas) {
  const nomeDepois = nomeDepoisDoValor(linhas);
  const lancamentos = [];
  const ignoradas = [];
  let dia = null;
  let pendentes = [];
  let desdeALegenda = 0;

  const largar = (texto, motivo, indice) => ignoradas.push({ linha: indice + 1, texto, motivo });
  const ultimo = () => lancamentos[lancamentos.length - 1];

  /**
   * Completa o nome da compra de cima com o que veio depois do valor dela.
   * Sem compra nenhuma ainda, o bloco é a moldura do topo; passando do tamanho
   * de um nome, o excedente é rodapé de tela.
   */
  const completarAnterior = (blocos, indice) => {
    const alvo = ultimo();
    if (!alvo) { largar(blocos.join(' '), 'topo da tela do aplicativo', indice); return; }
    alvo.partes.push(...blocos.slice(0, MAX_LINHAS_DE_NOME));
    const sobra = blocos.slice(MAX_LINHAS_DE_NOME);
    if (sobra.length > 0) largar(sobra.join(' '), 'rodapé da tela do aplicativo', indice);
  };

  const despejarPendentes = ({ anexar, motivo, indice }) => {
    if (pendentes.length === 0) return;
    if (nomeDepois) completarAnterior(pendentes, indice);
    else if (anexar && ultimo()) ultimo().partes.push(...pendentes);
    else largar(pendentes.join(' '), motivo, indice);
    pendentes = [];
  };

  linhas.forEach((bruta, indice) => {
    const linha = consertarSeparador(bruta.trim());
    if (!linha) return;

    const cabecalho = lerCabecalhoDeDia(linha);
    if (cabecalho) {
      despejarPendentes({
        anexar: desdeALegenda > 0, motivo: 'compra sem valor reconhecido', indice,
      });
      desdeALegenda = 0;
      dia = cabecalho.data;
      if (cabecalho.resto) pendentes.push(cabecalho.resto);
      return;
    }

    if (ehLegendaDoApp(linha) || RX_BOTAO_DO_APP.test(linha)) {
      despejarPendentes({
        anexar: desdeALegenda > 0, motivo: 'compra sem valor reconhecido', indice,
      });
      desdeALegenda = 0;
      largar(linha, ehLegendaDoApp(linha) ? 'legenda do aplicativo' : 'botão da tela', indice);
      return;
    }

    // A parcela vem numa linha própria, embaixo do nome; grudada na descrição
    // ela é lida pelo mesmo caminho que lê "PARC 03/10" na fatura.
    if (RX_LINHA_DE_PARCELA.test(linha) && pendentes.length === 0 && ultimo()) {
      ultimo().partes.push(linha);
      return;
    }

    // Numa lista de app cada linha tem um valor só. Dois ou mais significam que
    // o reconhecimento juntou compras numa linha — e ler só o último, como se
    // faz na fatura, apagaria as de cima. Aqui cada valor fecha o seu próprio
    // lançamento.
    const valores = acharValores(linha, { aceitarPonto: true });
    if (valores.length === 0) { pendentes.push(linha); return; }

    // Acima do primeiro cabeçalho de dia mora a moldura do app — relógio, nome
    // do cartão, abas de mês —, mas também as compras de um print que começou
    // com a lista já rolada. Quem separa os dois é a quantidade de valores: a
    // faixa de abas traz o total de vários meses numa linha só, e compra tem um
    // valor só. As compras dali entram sem data, para o usuário preencher; a
    // faixa cai fora, senão "R$ 11.339,84" viraria um gasto de cinco dígitos.
    if (dia === null && valores.length > 1) {
      if (pendentes.length > 0) {
        largar(pendentes.join(' '), 'topo da tela do aplicativo', indice);
        pendentes = [];
      }
      largar(linha, 'topo da tela do aplicativo', indice);
      return;
    }

    // Onde o nome fica embaixo do valor, o que sobrou pendente é o fim do nome
    // da compra anterior — menos a última linha, que é a categoria escrita em
    // cima desta compra. Onde o nome fica na mesma linha do valor, tudo o que
    // estava pendente é o começo do nome desta compra.
    let antes = pendentes;
    if (nomeDepois) {
      antes = pendentes.slice(-1);
      completarAnterior(pendentes.slice(0, -1), indice);
    }
    pendentes = [];

    let inicio = 0;
    valores.forEach((valor, ordem) => {
      // Sobra de ícone ("O", "WD", "Vi)") não é nome de loja. Só é descartada
      // no desenho em que o nome mora fora da linha do valor; no outro, o texto
      // à esquerda do valor é justamente o nome.
      const naLinha = linha.slice(inicio, valor.inicio);
      lancamentos.push({
        data: dia,
        partes: [
          ...(ordem === 0 ? antes : []),
          ...(nomeDepois && !temTextoUtil(naLinha) ? [] : [naLinha]),
        ],
        valor: comVirgulaDecimal(linha.slice(valor.inicio, valor.fim).trim()),
      });
      desdeALegenda += 1;
      inicio = valor.fim;
    });
  });

  despejarPendentes({ anexar: false, motivo: 'rodapé da tela do aplicativo', indice: linhas.length });

  // Alguns apps escrevem toda despesa com sinal de menos ("-R$ 78,98"): ali o
  // menos quer dizer saída de dinheiro, e não crédito. Quando é assim, a
  // convenção inteira está invertida em relação à fatura, e o conserto é
  // inverter o sinal de todos — não só apagar o menos das compras. Numa lista
  // com um estorno no meio, apagar deixaria a compra certa e o estorno errado.
  //
  // O que denuncia a inversão é a maioria: fatura tem uma compra atrás da outra
  // e um crédito de vez em quando, então uma lista majoritariamente negativa só
  // pode estar escrevendo saída com menos.
  const negativos = lancamentos.filter((l) => l.valor.startsWith('-')).length;
  const menosEhSaida = lancamentos.length >= 2 && negativos * 2 > lancamentos.length;
  const comSinalDaFatura = (valor) => {
    if (!menosEhSaida) return valor;
    return valor.startsWith('-') ? valor.replace(/^-\s*/, '') : `-${valor}`;
  };

  return {
    // Sem data, a linha sai só com descrição e valor: a análise adiante não
    // acha data nenhuma e o lançamento chega à tela de revisão com o campo em
    // branco, para ser preenchido antes de entrar no banco.
    linhas: lancamentos.map((l) => [
      l.data,
      ...l.partes.map(limparPedaco).filter(Boolean),
      comSinalDaFatura(l.valor),
    ].filter(Boolean).join(' ')),
    ignoradas,
  };
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

  // Print de app tem outra estrutura, e traduzi-la aqui em cima é o que deixa
  // todo o resto desta função valer igual para os dois formatos.
  const ehApp = pareceListaDeApp(linhas, mes);
  const traduzido = ehApp ? normalizarListaDeApp(linhas) : { linhas, ignoradas: [] };
  const uteis = traduzido.linhas;
  descartadas.push(...traduzido.ignoradas);

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
  const corte = uteis.findIndex((l) => RX_FUTURAS.test(l));
  const atuais = corte >= 0 ? uteis.slice(0, corte) : uteis;
  if (corte >= 0) {
    uteis.slice(corte).forEach((l, i) => descartadas.push({
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

  return {
    itens,
    descartadas,
    formato: ehApp ? 'lista' : 'fatura',
    // O print mostra um pedaço da lista, e o número grande da aba de mês é o
    // total da fatura inteira. Declará-lo faria a tela de revisão acusar uma
    // diferença enorme que não é erro nenhum — é só o resto da fatura.
    total_fatura: ehApp ? null : acharTotalDaFatura(linhas),
  };
}
