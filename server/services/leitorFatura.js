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

import { fileURLToPath } from 'node:url';
import { detectarRegioesMarcadas } from './marcacaoColorida.js';
import {
  renderizarPagina, pngDe, regioesDeTinta, pareceMarcacao, comRotulos, recortar, enquadrar,
  ESCALA_OCR, formaDaMarca, dentroDaForma, faixaDaCor,
} from './rasterizador.js';
import { escolherMarcacao } from './iaLocal.js';
import { normalizar, sugerirCategoria } from './categorias.js';

// O pdf.js exige barra final e recusa a barra invertida do Windows, então o
// caminho do pacote é normalizado uma vez aqui.
const PASTA_DE_FONTES = `${fileURLToPath(import.meta.resolve('pdfjs-dist/standard_fonts/'))
  .replaceAll('\\', '/')
  .replace(/\/+$/, '')}/`;

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
 *
 * Devolve as linhas com a posição de cada pedaço, e não só o texto, porque é
 * pela posição que se decide se a linha está dentro do que foi circulado.
 */
function montarLinhas(itens, tolerancia = 3) {
  const cortes = acharColunas(itens);
  const coluna = (x) => cortes.filter((c) => x >= c).length;

  const linhas = [];
  for (const item of itens) {
    const texto = item.str;
    if (!texto || !texto.trim()) continue;
    const x = item.transform[4];
    const y = item.transform[5];
    const col = coluna(x);
    const pedaco = {
      x, y, texto, largura: Math.abs(item.width || 0), altura: Math.abs(item.height || 0), meio: item.meio,
    };

    const existente = linhas.find((l) => l.col === col && Math.abs(l.y - y) <= tolerancia);
    if (existente) existente.pedacos.push(pedaco);
    else linhas.push({ y, col, pedacos: [pedaco] });
  }

  // Coluna da esquerda inteira, depois a da direita: é a ordem de leitura da
  // fatura, e é o que mantém cada lançamento junto do seu próprio valor.
  return linhas.sort((a, b) => a.col - b.col || b.y - a.y);
}

/**
 * O texto da linha, com espaço só onde há espaço de verdade.
 *
 * O PDF quebra uma palavra em dois pedaços quando ajusta o espaçamento entre
 * duas letras: na fatura do Inter, o "P" de "PAGAMENTO" é um pedaço e
 * "AGAMENTO ON LINE" é outro, começando 1pt *antes* do fim do primeiro. Juntar
 * sempre com espaço dava "P AGAMENTO" — e assim o pagamento da fatura anterior
 * escapava do filtro de resumo e entrava como compra de R$ 1.915,73. Pedaços
 * que se encostam (vão menor que um décimo da altura da letra) são a mesma
 * palavra.
 *
 * Só vale para o texto do próprio PDF. A palavra reconhecida na imagem (que
 * traz `meio`) já vem separada pelo reconhecimento, e a caixa dela é justa na
 * tinta — medir vão ali colaria palavras de verdade.
 */
const textoDaLinha = (linha) => {
  let texto = '';
  let anterior = null;
  for (const p of [...linha.pedacos].sort((a, b) => a.x - b.x)) {
    const vao = anterior ? p.x - (anterior.x + anterior.largura) : Infinity;
    const encosta = anterior && p.meio === undefined && anterior.largura > 0
      && vao < (p.altura || anterior.altura || 6) * 0.1;
    texto += (encosta ? '' : ' ') + p.texto;
    anterior = p;
  }
  return texto.replace(/\s+/g, ' ').trim();
};

/**
 * Regiões marcadas pelo usuário, em coordenadas normalizadas (0 a 1) com origem
 * no canto superior esquerdo da página — o mesmo referencial da tela.
 * `{ pagina, x, y, largura, altura, forma? }`
 */
function regioesDaPagina(regioes, pagina) {
  if (!Array.isArray(regioes) || regioes.length === 0) return null;
  const daPagina = regioes.filter((r) => Number(r.pagina) === pagina);
  return daPagina.length > 0 ? daPagina : [];
}

/**
 * Com o contorno medido, vale o contorno: o que está na caixa mas fora do laço
 * fica de fora. Sem ele — traço que não deixou tinta na página renderizada —,
 * vale a caixa, como sempre valeu.
 */
function dentroDeAlguma(regioes, nx, ny) {
  return regioes.some((r) => (r.forma
    ? dentroDaForma(r.forma, nx, ny)
    : nx >= r.x && nx <= r.x + r.largura && ny >= r.y && ny <= r.y + r.altura));
}

/**
 * O pedaço abre um lançamento? Começa com data **e** vem nome de loja junto ou
 * logo depois. A segunda condição é o que separa a data da compra da parcela:
 * "04/10" seguido de "171,43" é a parcela 4 de 10 no fim da descrição, e cortar
 * ali separaria a compra do próprio valor.
 */
function abreLancamento(pedaco, seguinte) {
  const texto = pedaco.texto.trim();
  // Data numérica ("05/08") ou por extenso ("15 de jul. 2026", do Inter).
  const data = texto.match(RX_COMECA_COM_DATA) || texto.match(RX_DATA_TEXTO);
  if (!data) return false;
  if (/\p{L}{3}/u.test(texto.slice(data[0].length))) return true;
  return Boolean(seguinte && /\p{L}{3}/u.test(seguinte.texto));
}

/** Quanto do texto destes pedaços está dentro da marcação, de 0 a 1. */
function fracaoDentro(pedacos, regioes, vista) {
  let dentro = 0;
  let total = 0;
  for (const p of pedacos) {
    // Um ponto a cada 3pt de texto, na altura do meio das letras. No PDF a
    // posição do pedaço é a linha de base; na palavra reconhecida, já é o meio.
    const n = Math.max(1, Math.round(p.largura / 3));
    const meio = p.meio ?? p.y + (p.altura || 8) * 0.35;
    const ny = (vista.height - meio) / vista.height;
    for (let k = 0; k < n; k += 1) {
      const nx = (p.x + (p.largura * (k + 0.5)) / n) / vista.width;
      total += 1;
      if (dentroDeAlguma(regioes, nx, ny)) dentro += 1;
    }
  }
  return total ? dentro / total : 0;
}

const ehValor = (texto) => /\d,\d{2}(?!\d)/.test(texto);

// Até onde o traço pode ter cortado um pedaço que ainda é da linha marcada.
const ALCANCE_DO_RESGATE = 15;

/**
 * O pedaço encosta na marcação pelo lado indicado? Anda até 15pt a partir da
 * borda dele, na altura do meio do texto, procurando o lado de dentro.
 *
 * É o que limita o resgate ao que o traço cortou rente. Sem isto, na fatura
 * digitalizada, uma linha cujo valor o reconhecimento leu errado ("29200") ia
 * buscar o primeiro valor à direita — e achava o total da coluna vizinha,
 * fora da marca, a 200pt dali.
 */
function encostaNaMarca(p, lado, regioes, vista) {
  const meio = p.meio ?? p.y + (p.altura || 8) * 0.35;
  const ny = (vista.height - meio) / vista.height;
  const borda = lado === 'esquerda' ? p.x : p.x + p.largura;
  const sentido = lado === 'esquerda' ? -1 : 1;
  for (let d = 0; d <= ALCANCE_DO_RESGATE; d += 3) {
    if (dentroDeAlguma(regioes, (borda + sentido * d) / vista.width, ny)) return true;
  }
  return false;
}

/**
 * Fica com o que está dentro da marcação.
 *
 * Cada pedaço de texto entra ou sai pela própria posição — e a linha não decide
 * nada em bloco, porque ela junta o que não deveria: na fatura de novembro a
 * compra da Uber, dentro do laço, vinha na mesma linha do título "Novo teto de
 * juros do cartão de crédito", fora dele, e mais largo. Decidindo pela maior
 * parte da linha, a compra saía junto com o título.
 *
 * Mas pedaço a pedaço sozinho perde o que o traço feito à mão corta: ele passa
 * raspando o fim da linha, deixa a descrição dentro e o valor fora, e o
 * lançamento chegava à análise sem valor — e sumia sem aviso. Por isso há um
 * resgate, e só dentro do mesmo lançamento (do pedaço que abre com a data até o
 * próximo): se a descrição ficou dentro, voltam a data que abriu o lançamento e,
 * quando nenhum valor ficou, o primeiro valor à direita — desde que encostem no
 * traço (`encostaNaMarca`). Texto solto do lado de fora — título, legenda, a
 * coluna vizinha — não volta nunca.
 */
function filtrarPelaMarca(linhas, regioes, vista) {
  const saida = [];
  for (const linha of linhas) {
    const pedacos = [...linha.pedacos].sort((a, b) => a.x - b.x);
    const trechos = [];
    pedacos.forEach((p, i) => {
      if (trechos.length === 0 || abreLancamento(p, pedacos[i + 1])) trechos.push([]);
      trechos[trechos.length - 1].push(p);
    });

    const ficam = [];
    for (const trecho of trechos) {
      const dentro = trecho.filter((p) => fracaoDentro([p], regioes, vista) >= 0.5);
      if (dentro.length === 0) continue;
      ficam.push(...dentro);

      if (!/\p{L}{3}/u.test(dentro.map((p) => p.texto).join(' '))) continue;
      const [primeiro] = trecho;
      if (!dentro.includes(primeiro) && abreLancamento(primeiro, trecho[1])
        && encostaNaMarca(primeiro, 'direita', regioes, vista)) ficam.push(primeiro);
      if (!dentro.some((p) => ehValor(p.texto))) {
        const ultimoX = Math.max(...dentro.map((p) => p.x));
        const valor = trecho.find((p) => p.x > ultimoX && ehValor(p.texto));
        if (valor && encostaNaMarca(valor, 'esquerda', regioes, vista)) ficam.push(valor);
      }
    }
    if (ficam.length > 0) saida.push({ ...linha, pedacos: ficam.sort((a, b) => a.x - b.x) });
  }
  return saida;
}

// Mais de quatro manchas coloridas numa página não é alguém marcando
// lançamentos — é o desenho da fatura. Perguntar sobre todas custaria caro para
// escolher entre listras de tabela.
const LIMITE_CANDIDATAS = 4;

// Quantas manchas têm o contorno medido antes da escolha. Mais que o limite da
// pergunta ao modelo, porque numa fatura colorida a tarja e o rodapé são
// maiores que um círculo em volta de uma linha só, e o círculo ficaria de fora
// da lista se ela fosse cortada antes.
const LIMITE_CONTORNOS = 8;

/**
 * Procura a marcação nos pixels da página, quando o arquivo não trouxe traço
 * vetorial nenhum.
 *
 * A varredura de tinta mede; o contorno separa; o modelo só desempata.
 *
 * Laço fechado em volta de texto é caneta — tarja, listra e logotipo são
 * manchas cheias, e o contorno sabe a diferença (`formaDaMarca`). Então quando
 * há laços na página, todos entram, sem pergunta: antes, com dois círculos e uma
 * tarja colorida, o modelo era chamado para escolher **um**, levava um minuto,
 * não escolhia nenhum, e a página era lida inteira — inclusive o que estava fora
 * dos dois círculos. O modelo segue entrando onde a forma não decide: várias
 * manchas e nenhuma delas um laço (um marca-texto, por exemplo).
 */
async function marcacaoNaImagem(documento, paginas) {
  const encontradas = [];

  for (let n = 1; n <= paginas; n += 1) {
    const canvas = await renderizarPagina(documento, n);

    const medidas = regioesDeTinta(canvas).regioes
      .filter(pareceMarcacao)
      .slice(0, LIMITE_CONTORNOS)
      .map((c) => ({ ...c, forma: formaDaMarca(canvas, c, c.faixa) }));

    if (medidas.length === 0) continue;

    const lacos = medidas.filter((c) => c.forma?.lacos > 0);
    if (lacos.length > 0) {
      encontradas.push(...lacos.map((c) => ({ pagina: n, origem: 'pixels', ...c })));
      continue;
    }

    const candidatas = medidas.slice(0, LIMITE_CANDIDATAS);
    if (candidatas.length === 1) {
      encontradas.push({ pagina: n, origem: 'pixels', ...candidatas[0] });
      continue;
    }

    const escolhida = await escolherMarcacao(
      pngDe(comRotulos(canvas, candidatas)),
      candidatas.length,
    );
    // Modelo fora do ar, em dúvida, ou dizendo que nenhuma serve: a página fica
    // sem região, o que significa lê-la inteira. É o comportamento de sempre —
    // errar para o lado de trazer demais, que o usuário vê e desmarca, e não
    // para o lado de recortar no lugar errado, que ele não tem como perceber.
    if (escolhida !== null) {
      encontradas.push({ pagina: n, origem: 'ia', ...candidatas[escolhida] });
    }
  }

  return encontradas;
}

/**
 * Mede o contorno das marcas que vieram do traço vetorial.
 *
 * O detector vetorial sabe onde há tinta da caneta, mas devolve a caixa dela.
 * O contorno sai dos pixels da página renderizada, na cor que o detector achou
 * — um logotipo de outra cor dentro da caixa não vira parede.
 */
async function contornar(documento, regioes) {
  const paginas = [...new Set(regioes.map((r) => r.pagina))];
  const porPagina = new Map();
  for (const n of paginas) porPagina.set(n, await renderizarPagina(documento, n));

  return regioes.map((r) => {
    const faixa = faixaDaCor(r.cor);
    return { ...r, faixa, forma: formaDaMarca(porPagina.get(r.pagina), r, faixa) };
  });
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
    // Necessário desde que a página passou a ser desenhada, e não só lida.
    // Fatura que usa as fontes padrão do PDF (Helvetica, Times) não traz
    // desenho de letra nenhum dentro do arquivo: sem apontar onde estão as
    // substitutas, o pdf.js extrai o texto normalmente mas **renderiza a página
    // em branco** — e aí o reconhecimento lê uma folha vazia e a marcação é
    // procurada num nada. Aponta para o próprio pacote, não para uma CDN: a
    // leitura continua funcionando sem internet.
    standardFontDataUrl: PASTA_DE_FONTES,
  });

  const linhas = [];
  let paginas = 0;
  const dimensoes = [];
  let regioes = [];
  let origemDaMarcacao = 'nenhuma';
  let leituraPorImagem = false;
  const imagens = [];

  try {
    const documento = await tarefa.promise;
    paginas = documento.numPages;

    // A marcação vem do próprio arquivo: quem circula os lançamentos num editor
    // de PDF já disse o que quer, e o app segue essa indicação. Sem marca
    // nenhuma, lê o documento inteiro.
    const detectadas = await detectarRegioesMarcadas(documento, pdfjs);
    if (detectadas.length > 0) {
      // Os círculos pequenos da mesma caneta só entram se o contorno confirmar
      // que são laços — ver `companheiras` em marcacaoColorida.js.
      const candidatas = [
        ...detectadas,
        ...(detectadas.companheiras || []).map((r) => ({ ...r, companheira: true })),
      ];
      regioes = (await contornar(documento, candidatas))
        .filter((r) => !r.companheira || r.forma?.lacos > 0)
        .map(({ companheira, ...r }) => r);
      origemDaMarcacao = 'arquivo';
    } else {
      // Nenhum traço no conteúdo do PDF. Pode não haver marca — e pode haver
      // uma que só existe em pixels, porque a página foi digitalizada ou
      // achatada. Olhar a imagem é a única forma de saber.
      const achadas = await marcacaoNaImagem(documento, paginas);
      if (achadas.length > 0) {
        regioes = achadas;
        origemDaMarcacao = achadas.some((r) => r.origem === 'ia') ? 'ia' : 'pixels';
      }
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
      // As linhas são montadas com a página inteira e só depois filtradas: as
      // colunas saem das datas alinhadas, e com mais datas a conta é mais firme
      // do que olhando só o pedaço marcado.
      const todas = montarLinhas(conteudo.items);
      const escolhidas = daPagina ? filtrarPelaMarca(todas, daPagina, vista) : todas;

      linhas.push(...escolhidas.map(textoDaLinha).filter(Boolean));
      pagina.cleanup();
    }

    // Texto nenhum no arquivo: é página digitalizada. Antes isto era o fim da
    // leitura, com um recado pedindo para salvar as páginas como imagem e
    // enviá-las de novo. A página já está renderizada aqui — dá para fazer isso
    // pelo usuário, e ainda dentro do recorte que ele marcou.
    if (linhas.join('').length < 40) {
      const lidas = await lerPaginasRenderizadas(documento, regioes, paginas);
      if (lidas.linhas.length > 0) {
        linhas.push(...lidas.linhas);
        imagens.push(...lidas.imagens);
        leituraPorImagem = true;
      }
    }
  } finally {
    await tarefa.destroy();
  }

  // A grade do contorno é trabalho interno e pesa — serializada, seriam dezenas
  // de milhares de células na resposta. Para fora vai quantas áreas ela fecha.
  const resumo = regioes.map(({ forma, faixa, ...r }) => ({
    ...r, areas: forma ? forma.lacos + forma.abertas : 1,
  }));

  return {
    linhas, paginas, dimensoes, regioes: resumo, origemDaMarcacao, leituraPorImagem, imagens,
  };
}

const emLinhas = (texto) => texto.split('\n')
  .map((l) => l.replace(/\s+/g, ' ').trim())
  .filter(Boolean);

/**
 * As linhas como o reconhecimento as viu, cada uma com as suas palavras e a
 * caixa de cada palavra em pixels da imagem lida.
 */
function gruposDoReconhecimento(dados) {
  const grupos = [];
  for (const bloco of dados.blocks || []) {
    for (const paragrafo of bloco.paragraphs || []) {
      for (const linha of paragrafo.lines || []) {
        const palavras = [];
        for (const palavra of linha.words || []) {
          const texto = (palavra.text || '').trim();
          if (texto && palavra.bbox) palavras.push({ texto, ...palavra.bbox });
        }
        if (palavras.length > 0) grupos.push(palavras);
      }
    }
  }
  return grupos;
}

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
function gruposPorPosicao(palavras) {
  if (palavras.length < 4) return null;

  // A tolerância sai da própria imagem: print de celular e foto de fatura têm
  // escalas muito diferentes, e um número fixo de pixels serviria só a uma.
  const alturas = palavras.map((p) => p.y1 - p.y0).sort((a, b) => a - b);
  const tolerancia = Math.max((alturas[Math.floor(alturas.length / 2)] || 10) * 0.6, 4);

  const linhas = [];
  for (const p of [...palavras].sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1))) {
    const centro = (p.y0 + p.y1) / 2;
    const atual = linhas[linhas.length - 1];
    if (atual && centro - atual.centro <= tolerancia) atual.palavras.push(p);
    else linhas.push({ centro, palavras: [p] });
  }
  return linhas.map((l) => l.palavras.sort((a, b) => a.x0 - b.x0));
}

const textoDoGrupo = (palavras) => palavras.map((p) => p.texto).join(' ').trim();

function linhasPorPosicao(dados) {
  const grupos = gruposPorPosicao(gruposDoReconhecimento(dados).flat());
  return grupos ? grupos.map(textoDoGrupo).filter(Boolean) : null;
}

// Entre duas leituras da mesma imagem vence a que reconhece mais lançamentos.
const contarLancamentos = (linhas) => (linhas ? analisar(linhas, { mes: '2000-01' }).itens.length : -1);

/**
 * Empresta um reconhecedor de texto e garante que ele seja encerrado.
 *
 * O worker é um processo à parte: sem encerrá-lo, cada leitura deixaria um para
 * trás e o servidor iria acumulando memória a cada importação. E ele é caro de
 * abrir — por isso a função empresta **um** worker para o trabalho inteiro, e
 * não um por página.
 */
async function comReconhecedor(trabalho) {
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
    return await trabalho(worker);
  } catch (causa) {
    if (causa.status) throw causa;
    const erro = new Error(
      'Não foi possível ler a imagem. O reconhecimento de texto baixa um pacote de idioma '
      + 'na primeira execução e precisa de internet nesse momento. '
      + `Detalhe: ${causa.message}`,
    );
    erro.status = 502;
    throw erro;
  } finally {
    await worker?.terminate();
  }
}

async function reconhecer(worker, buffer) {
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
  return contarLancamentos(porPosicao) > contarLancamentos(doTexto) ? porPosicao : doTexto;
}

/**
 * Foto ou print: lido por inteiro. A marcação numa foto é só pixels, e
 * localizá-la ali é o trabalho de `rasterizador.js` — que hoje entra pelo
 * caminho do PDF, onde a página tem um referencial de coordenadas para o
 * recorte voltar.
 */
async function extrairDeImagem(buffer) {
  const linhas = await comReconhecedor((worker) => reconhecer(worker, buffer));
  return { linhas, paginas: 1 };
}

/**
 * Lê uma região marcada de uma página digitalizada.
 *
 * O reconhecimento lê o enquadramento inteiro da marca, e o que fica é decidido
 * depois, pela posição de cada palavra, com o mesmo filtro do PDF com texto —
 * lançamento a lançamento. Um filtro só para as duas origens é o que garante
 * que "dentro da marca" signifique a mesma coisa nas duas.
 *
 * As linhas, porém, são as do reconhecimento, e não as de `montarLinhas`: nele
 * a parcela ("04/10") chega como palavra solta com cara de data, e a detecção
 * de colunas por data alinhada a tomava por uma coluna — cortando cada compra
 * longe do próprio valor.
 *
 * Devolve as linhas e a imagem para o modelo de visão — mascarada no que ficou.
 */
async function lerRegiaoDigitalizada(worker, canvas, regiao) {
  const quadro = enquadrar(canvas, regiao);
  if (!quadro) return { linhas: [], imagem: null };

  const { data } = await worker.recognize(pngDe(recortar(canvas, regiao)), {}, { text: true, blocks: true });

  // Pixels do recorte para pontos da página, com o Y de baixo para cima como o
  // pdf.js entrega — é o referencial que o filtro espera. A palavra reconhecida
  // não tem linha de base; o meio da caixa dela é o ponto testado.
  const escala = ESCALA_OCR;
  const vista = { width: canvas.width / escala, height: canvas.height / escala };
  const pedaco = (p) => {
    const meio = vista.height - (quadro.y + (p.y0 + p.y1) / 2) / escala;
    return {
      texto: p.texto,
      x: (quadro.x + p.x0) / escala,
      y: meio,
      meio,
      largura: (p.x1 - p.x0) / escala,
      altura: (p.y1 - p.y0) / escala,
    };
  };

  // As mesmas duas leituras de `reconhecer` — a ordem do reconhecimento e a
  // reconstrução por posição —, cada uma filtrada pela marca, e vence a que
  // reconhece mais lançamentos.
  const doReconhecimento = gruposDoReconhecimento(data);
  const leituras = [doReconhecimento, gruposPorPosicao(doReconhecimento.flat())]
    .filter(Boolean)
    .map((grupos) => filtrarPelaMarca(grupos.map((g) => ({ pedacos: g.map(pedaco) })), [regiao], vista));
  const contagens = leituras.map((l) => contarLancamentos(l.map(textoDaLinha)));
  const escolhidas = leituras[contagens.indexOf(Math.max(...contagens))] || [];

  // A imagem do modelo mostra o miolo do laço mais as linhas que ficaram, com
  // um respiro em volta de cada uma. O que o filtro tirou não aparece para ele.
  const caixas = escolhidas.flatMap((l) => l.pedacos).map((p) => {
    const folga = p.altura * 0.4;
    return {
      x: (p.x - folga) * escala,
      y: (vista.height - p.meio - p.altura / 2 - folga) * escala,
      largura: (p.largura + folga * 2) * escala,
      altura: (p.altura + folga * 2) * escala,
    };
  });

  return {
    linhas: escolhidas.map(textoDaLinha).filter(Boolean),
    imagem: pngDe(recortar(canvas, regiao, { caixas })),
  };
}

/**
 * Lê as páginas que não têm texto no arquivo, a partir da imagem renderizada.
 *
 * Havendo marcação, só o que está dentro dela é lido — inclusive pelo modelo de
 * visão, que recebe as imagens devolvidas aqui. Sem marcação, a página inteira.
 */
async function lerPaginasRenderizadas(documento, regioes, paginas) {
  return comReconhecedor(async (worker) => {
    const linhas = [];
    // As mesmas imagens que o reconhecimento leu, para a rota poder mostrá-las
    // ao modelo de visão e cruzar as duas leituras.
    const imagens = [];

    for (let n = 1; n <= paginas; n += 1) {
      const daPagina = regioesDaPagina(regioes, n);
      if (daPagina && daPagina.length === 0) continue;

      // Renderiza de novo, mais alto: o render guardado é o que o modelo olhou,
      // e a resolução que serve para ele enxergar a marca não serve para o
      // reconhecimento ler o texto.
      const canvas = await renderizarPagina(documento, n, ESCALA_OCR);

      if (!daPagina?.length) {
        const png = pngDe(canvas);
        imagens.push(png);
        linhas.push(...await reconhecer(worker, png));
        continue;
      }

      // Com duas marcas na mesma página, cada uma é lida por si: juntá-las numa
      // caixa só arrastaria para dentro tudo o que estivesse entre elas.
      for (const regiao of daPagina) {
        const lida = await lerRegiaoDigitalizada(worker, canvas, regiao);
        linhas.push(...lida.linhas);
        if (lida.imagem) imagens.push(lida.imagem);
      }
    }
    return { linhas, imagens };
  });
}

export async function extrair(buffer, nomeArquivo, tipoMime = '') {
  const ehPdf = /\.pdf$/i.test(nomeArquivo) || tipoMime.includes('pdf');

  if (ehPdf) {
    const resultado = await extrairDePdf(buffer);

    if (resultado.linhas.join('').length < 40) {
      // Com marcação, pouco texto quase sempre significa região no lugar errado;
      // sem marcação, e depois de já ter tentado reconhecer a página como
      // imagem, significa que não há o que ler. Mensagens diferentes, porque a
      // saída para cada caso é diferente.
      const erro = new Error(resultado.origemDaMarcacao !== 'nenhuma'
        ? 'Não foi encontrado texto dentro do que está marcado. Confira se a marcação '
          + 'envolve as linhas de lançamento.'
        : 'Não foi encontrado texto neste PDF, nem como arquivo nem pelo reconhecimento '
          + 'da página. Se for um documento digitalizado, uma digitalização mais nítida costuma resolver.');
      erro.status = 422;
      throw erro;
    }
    // Página digitalizada lida por reconhecimento tem o mesmo tipo de erro de
    // uma foto, e merece a mesma segunda opinião: a rota usa esta origem para
    // decidir se cruza a leitura com o modelo de visão.
    return { ...resultado, origem: resultado.leituraPorImagem ? 'pdf-imagem' : 'pdf' };
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
  /pagamento\s+(via|efetuado|recebido|de\s+fatura|on[\s-]*line)/i,
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
//
// O "+" na frente é crédito, com ou sem espaço até o "R$": é como o Inter
// escreve pagamento e estorno ("+ R$ 1.915,73", em verde). O "-" só conta
// colado no número — separado por espaço, nessa mesma fatura, ele é a coluna
// "Beneficiário" vazia, e não sinal nenhum.
const RX_VALOR = /(?:(-)|(\+)\s?)?(?:R\$)?\s?(\d{1,3}(?:\.\d{3})*|\d+),(\d{2})(-)?/g;

// Mesma coisa, aceitando o ponto como separador decimal — só para o print de
// app, onde o reconhecimento troca a vírgula por ponto com frequência e um
// valor não lido faz a compra inteira se fundir na de cima. Na fatura em PDF
// esta versão não entra: lá "05.08" é data, e ela viraria R$ 5,08.
//
// A folga é segura porque grupo de milhar tem sempre três dígitos: "60.00" só
// pode ser decimal, e "1.234" continua não sendo valor nenhum.
const RX_VALOR_PONTO = /(-)?(?:R\$)?\s?(\d{1,3}(?:\.\d{3})*|\d+)[.,](\d{2})(?!\d)(-)?/g;

const RX_DATA_BARRA = /^(\d{2})[/.](\d{2})(?:[/.](\d{2,4}))?\b/;

// "12 ago", "15 de jul. 2026", "3 de setembro de 2025". O ponto da abreviação e
// o ano fazem parte da data: sem consumi-los, a fatura do Inter — que escreve
// "15 de jul. 2026" — deixava ". 2026" grudado na frente de toda descrição. O
// nome do mês é casado por extenso só com a continuação que ele de fato tem,
// para "12 agoMERCADO" não comer o nome da loja.
const RX_DATA_TEXTO = new RegExp(
  '^(\\d{1,2})\\s*(?:de\\s*)?'
  + '(jan(?:eiro)?|fev(?:ereiro)?|mar(?:[çc]o)?|abr(?:il)?|mai(?:o)?|jun(?:ho)?|jul(?:ho)?'
  + '|ago(?:sto)?|set(?:embro)?|out(?:ubro)?|nov(?:embro)?|dez(?:embro)?)\\.?'
  + '(?:\\s*(?:de\\s+)?(\\d{4})(?!\\d))?',
  'i',
);

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

  return [...linha.matchAll(rx)].map((m) => {
    // As duas expressões têm grupos diferentes: só a da fatura reconhece o "+".
    const [menos, mais, inteiro, centavos, menosNoFim] = aceitarPonto
      ? [m[1], undefined, m[2], m[3], m[4]]
      : [m[1], m[2], m[3], m[4], m[5]];
    return {
      valor: lerValor({ inteiro, centavos }, Boolean(menos || mais || menosNoFim) || negativo),
      inicio: m.index,
      fim: m.index + m[0].length,
    };
  });
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
      // Com o ano escrito, vale o ano escrito — a parcela 3 de 5 de uma compra
      // de julho não precisa ser adivinhada a partir do mês da fatura.
      let ano = texto[3] ? Number(texto[3]) : anoRef;
      if (!texto[3] && mes > mesRef + 1) ano -= 1;
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
    // O que sobra de "(Parcela 03 de 05)" depois que a parcela é lida e tirada.
    .replace(/\(\s*\)|\[\s*\]/g, ' ')
    .replace(/\s+/g, ' ')
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
//
// "Ativar débito automático" entrou na lista por um motivo concreto: grudado na
// descrição, ele casava com o filtro de ruído da fatura (que conhece "débito
// automático" como linha de resumo) e a última compra da tela era descartada
// inteira, com valor e tudo. A barra de tolerância no fim do bloco `analisar`
// impede o estrago; reconhecer o botão aqui evita que ele chegue lá.
const RX_BOTAO_DO_APP = /^(pagar|parcelar|antecipar|ativar|ver\s+(mais|fatura|todos))\b/i;

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
        const esquerda = trecho.slice(0, ruido.index).trim();

        // Onde está o valor em relação ao ruído decide o que fazer, e há três
        // situações — duas delas fáceis de confundir:
        //
        //   valor à esquerda    a compra veio primeiro e o resumo grudou no
        //                       fim. Fica a compra, sai o resumo.
        //   valor à direita,
        //   nome à esquerda     o "ruído" não é resumo: é o rodapé da tela do
        //                       aplicativo ("Ativar débito automático") caindo
        //                       em cima do último lançamento. Cortar levaria o
        //                       valor junto e a compra sumiria sem aviso.
        //   valor à direita,
        //   nada à esquerda     a linha É o resumo, com a data na frente —
        //                       "10/07 Pagamento via conta -10.912,72", que é a
        //                       quitação da fatura anterior. Ela precisa sumir
        //                       inteira, senão entra como um crédito enorme.
        const semData = esquerda.slice(acharData(esquerda, mes)?.fim ?? 0);
        const nomeAEsquerda = limparDescricao(semData);
        const ehRodapeGrudado = !acharValor(esquerda)
          && nomeAEsquerda.length >= 3 && /\p{L}{3}/u.test(nomeAEsquerda);

        if (ehRodapeGrudado) {
          // Some só o pedaço que casou; o resto da linha segue inteiro.
          util = `${esquerda} ${trecho.slice(ruido.fim)}`.replace(/\s+/g, ' ').trim();
        } else {
          util = esquerda;
          descartadas.push({ linha: indice + 1, texto: trecho.slice(ruido.index).trim(), motivo: 'resumo da fatura' });
        }
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
