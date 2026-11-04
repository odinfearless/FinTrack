/**
 * Encontra a marcação do usuário olhando os pixels da página renderizada.
 *
 * Existe por causa de um limite do detector vetorial (`marcacaoColorida.js`):
 * ele lê os traços que estão no conteúdo do PDF. Marca que virou pixel — PDF
 * escaneado, página achatada na impressão, fatura impressa e digitalizada — não
 * deixa traço nenhum para ele encontrar.
 *
 * A divisão de trabalho aqui saiu de medição, e é o contrário do que parecia:
 *
 *   os pixels acham       varrer a página atrás de tinta viva devolveu a marca
 *                         com precisão de 1% da página, em 10 ms, e o mesmo
 *                         resultado toda vez;
 *
 *   o modelo escolhe      pedir a caixa ao modelo de visão custou de 5 a 33
 *                         segundos e variou de 0,7% a 12,7% de erro entre
 *                         execuções do mesmo pedido sobre a mesma imagem —
 *                         quanto mais ele raciocinava, mais longe caía.
 *
 * Então a conta de coordenada fica com quem sabe contar, e o modelo entra onde
 * ele é bom: dizer **qual** das manchas coloridas é a caneta do usuário, e não
 * o logotipo do banco ou a tarja do cabeçalho. Essa é uma pergunta de escolha,
 * não de medida.
 */

import { createCanvas } from '@napi-rs/canvas';
import { unir } from './marcacaoColorida.js';

// Escala 2. Medido: na escala 1 a localização errou 1,3% da página, na 2 errou
// 0,7%, e a 3 não melhorou nada — só dobrou o tempo. Para o modelo, resolução
// extra é peso morto: ele normaliza a imagem antes de olhar.
const ESCALA = 2;

// Para reconhecer texto a conta é outra: o Tesseract trabalha perto de 300
// pontos por polegada e a página do PDF tem 72, então a escala 4 é o que chega
// lá. Na fatura de teste a escala 2 já leu os doze lançamentos sem errar um
// dígito — a margem é para o documento digitalizado em resolução maior, onde
// renderizar pequeno joga fora detalhe que existe no arquivo. Custa cerca de
// meio segundo a mais por página.
export const ESCALA_OCR = 4;

/** Renderiza uma página do PDF num canvas. */
export async function renderizarPagina(documento, numero, escala = ESCALA) {
  const pagina = await documento.getPage(numero);
  try {
    const vista = pagina.getViewport({ scale: escala });
    const canvas = createCanvas(Math.ceil(vista.width), Math.ceil(vista.height));
    const ctx = canvas.getContext('2d');

    // Fundo branco explícito: o canvas nasce transparente e o PDF quase nunca
    // pinta o próprio fundo. Sem isto o PNG sai com texto preto sobre nada — e
    // no modelo de visão isso vira uma página escura.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await pagina.render({ canvasContext: ctx, viewport: vista, canvas }).promise;
    return canvas;
  } finally {
    pagina.cleanup();
  }
}

export const pngDe = (canvas) => canvas.toBuffer('image/png');

/* ---------------------------- tinta na página ----------------------------- */

// Um pixel só conta como tinta de caneta se for vivo: canal mais forte bem
// acima do mais fraco, e não escuro demais. É o mesmo critério do detector
// vetorial, aplicado a pixel em vez de a cor declarada no conteúdo.
const VIVACIDADE = 55;
const CLARIDADE = 90;

// Marcas de cores diferentes na mesma página são marcas diferentes e não devem
// se fundir numa caixa só. Seis faixas de matiz bastam para separar caneta
// vermelha de verde ou azul sem brigar com variação de tom dentro do traço.
const FAIXAS_DE_MATIZ = 6;

function matiz(r, g, b) {
  const maior = Math.max(r, g, b);
  const menor = Math.min(r, g, b);
  const d = maior - menor;
  let h;
  if (maior === r) h = ((g - b) / d) % 6;
  else if (maior === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = (h * 60 + 360) % 360;

  // O giro de meia faixa antes de dividir existe por causa do vermelho, que
  // fica em cima do zero: sem ele, um traço de caneta vermelha cai metade na
  // primeira faixa e metade na última, vira duas candidatas e manda para o
  // modelo uma escolha que não existe. Medido numa marca vermelha digitalizada:
  // duas regiões viravam uma.
  const giro = 360 / FAIXAS_DE_MATIZ / 2;
  return Math.floor(((h + giro) % 360) / (360 / FAIXAS_DE_MATIZ));
}

// A varredura vai de 2 em 2 pixels e agrupa em células: a marca é um traço de
// vários pixels de espessura e não some numa amostragem dessas, e a célula
// transforma milhares de pixels soltos num punhado de caixas para unir.
const PASSO = 2;
const CELULA = 8;

/**
 * Regiões de tinta colorida da página, em coordenadas normalizadas.
 *
 * Cada matiz é agrupado separadamente e o resultado sai ordenado da maior área
 * para a menor.
 */
export function regioesDeTinta(canvas) {
  const { data, width: w, height: h } = canvas.getContext('2d')
    .getImageData(0, 0, canvas.width, canvas.height);

  const colunas = Math.ceil(w / CELULA);
  const celulas = new Map(); // faixa de matiz -> Set de índices de célula
  let coloridos = 0;

  for (let y = 0; y < h; y += PASSO) {
    for (let x = 0; x < w; x += PASSO) {
      const i = (y * w + x) * 4;
      const r = data[i]; const g = data[i + 1]; const b = data[i + 2];
      const maior = Math.max(r, g, b);
      if (maior <= CLARIDADE || maior - Math.min(r, g, b) <= VIVACIDADE) continue;
      coloridos += 1;
      const faixa = matiz(r, g, b);
      if (!celulas.has(faixa)) celulas.set(faixa, new Set());
      celulas.get(faixa).add(Math.floor(y / CELULA) * colunas + Math.floor(x / CELULA));
    }
  }

  const regioes = [];
  for (const [faixa, indices] of celulas) {
    const caixas = [...indices].map((n) => ({
      x: ((n % colunas) * CELULA) / w,
      y: (Math.floor(n / colunas) * CELULA) / h,
      largura: CELULA / w,
      altura: CELULA / h,
    }));
    // A folga fecha o vão entre um traço e outro de um círculo feito à mão,
    // sem colar a marca num logotipo do outro lado da página. A faixa vai junto
    // porque o contorno da marca é procurado depois só na tinta da mesma cor.
    regioes.push(...unir(caixas, 0.01).map((r) => ({ ...r, faixa })));
  }

  const amostrados = Math.ceil(w / PASSO) * Math.ceil(h / PASSO);
  return {
    fracao: coloridos / amostrados,
    regioes: regioes.sort((a, b) => b.largura * b.altura - a.largura * a.altura),
  };
}

/**
 * Descarta o que a forma já denuncia não ser marcação.
 *
 * Fatura de banco é colorida por natureza — logotipo, tarja de cabeçalho,
 * listras de tabela. O que separa uma marca dessas coisas é a forma: marca
 * atravessa boa parte da largura para cercar linhas de lançamento, tem alguma
 * altura, e não cobre a página inteira.
 */
export function pareceMarcacao(regiao) {
  return regiao.largura > 0.25
    && regiao.altura > 0.015
    && !(regiao.largura > 0.97 && regiao.altura > 0.95);
}

/* --------------------------- o contorno da marca --------------------------- */

/**
 * Até aqui a marca era um retângulo: a caixa que envolve o traço. Só que
 * ninguém circula em retângulo. Na fatura de agosto o traço da página 2 desvia
 * do bloco "Pagamentos efetuados", e a caixa dele não — ela engolia o bloco, e
 * na página digitalizada o reconhecimento leu "Pagamento via conta -10.912,72"
 * sem os espaços, o filtro de resumo não reconheceu, e a quitação da fatura
 * anterior entrou como uma compra de dez mil reais. Na página 3 a caixa cobria
 * a folha quase inteira, inclusive as parcelas das próximas faturas.
 *
 * O que o usuário quis dizer é o **interior** do traço, e é isso que sai daqui:
 * uma grade sobre a página com o que está dentro de algum laço da marca.
 *
 * Como se acha o dentro: o traço vira uma máscara de células; quem o cerca é
 * descoberto inundando a partir da borda — o que a inundação não alcança está
 * fechado pelo traço. Isso vale para qualquer forma (oval, L, retângulo torto,
 * vários laços na mesma cor) sem precisar reconstruir o caminho do desenho.
 */

// Na escala 2, dois pixels são um ponto do PDF. Precisa ser fino assim por
// causa do círculo em volta de uma linha só: ele tem uns 14pt de altura, e numa
// grade de 2pt o traço de cima e o de baixo quase se encostavam — o fechamento
// que emenda o tremor do traço tapava o miolo, e o círculo deixava de ser laço.
const CELULA_FORMA = 2;

// Folga em volta da caixa da marca, para a borda da grade ficar do lado de fora
// do traço e a inundação ter por onde começar.
const MARGEM_FORMA = 0.012;

// Um laço precisa ter algum tamanho para delimitar linhas. Abaixo disso é
// texto colorido da própria fatura, ou um rabisco, e não define área.
const LARGURA_MINIMA_LACO = 0.03;
const ALTURA_MINIMA_LACO = 0.008;

/** Faixa de matiz de uma cor declarada no PDF (`#c5221f`), a mesma dos pixels. */
export function faixaDaCor(hex) {
  if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex)) return null;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  if (Math.max(r, g, b) - Math.min(r, g, b) === 0) return null;
  return matiz(r, g, b);
}

const ehTinta = (r, g, b) => {
  const maior = Math.max(r, g, b);
  return maior > CLARIDADE && maior - Math.min(r, g, b) > VIVACIDADE;
};

/**
 * Dilatação binária por um quadrado de lado 2r+1, em duas passadas.
 * `fora` é o valor assumido além da borda da grade.
 */
function dilatar(m, colunas, linhas, r, fora = 0) {
  const meio = new Uint8Array(m.length);
  const saida = new Uint8Array(m.length);
  const em = (v, i, n) => (i < 0 || i >= n ? fora : v);
  for (let y = 0; y < linhas; y += 1) {
    let soma = 0;
    for (let x = -r; x < r; x += 1) soma += em(m[y * colunas + x], x, colunas);
    for (let x = 0; x < colunas; x += 1) {
      soma += em(m[y * colunas + x + r], x + r, colunas);
      if (x - r - 1 >= -r) soma -= em(m[y * colunas + x - r - 1], x - r - 1, colunas);
      meio[y * colunas + x] = soma > 0 ? 1 : 0;
    }
  }
  for (let x = 0; x < colunas; x += 1) {
    let soma = 0;
    for (let y = -r; y < r; y += 1) soma += em(meio[y * colunas + x], y, linhas);
    for (let y = 0; y < linhas; y += 1) {
      soma += em(meio[(y + r) * colunas + x], y + r, linhas);
      if (y - r - 1 >= -r) soma -= em(meio[(y - r - 1) * colunas + x], y - r - 1, linhas);
      saida[y * colunas + x] = soma > 0 ? 1 : 0;
    }
  }
  return saida;
}

const inverter = (m) => m.map((v) => (v ? 0 : 1));

/**
 * Fechamento: dilata e depois erode. Emenda o vão entre o começo e o fim de um
 * traço feito à mão — que quase nunca se encontram — sem engordar a forma.
 */
function fechar(m, colunas, linhas, r) {
  const dilatada = dilatar(m, colunas, linhas, r, 0);
  // Erodir é dilatar o complemento; além da borda conta como tinta, para a
  // erosão não comer a marca que encosta na borda da grade.
  return inverter(dilatar(inverter(dilatada), colunas, linhas, r, 0));
}

/** Componentes conexos (vizinhança de 8) com caixa e lista de células. */
function componentes(m, colunas, linhas) {
  const rotulo = new Int32Array(m.length).fill(-1);
  const lista = [];
  const pilha = [];
  for (let inicio = 0; inicio < m.length; inicio += 1) {
    if (!m[inicio] || rotulo[inicio] >= 0) continue;
    const comp = { celulas: [], x0: colunas, y0: linhas, x1: -1, y1: -1 };
    rotulo[inicio] = lista.length;
    pilha.push(inicio);
    while (pilha.length) {
      const i = pilha.pop();
      const x = i % colunas;
      const y = (i - x) / colunas;
      comp.celulas.push(i);
      if (x < comp.x0) comp.x0 = x;
      if (x > comp.x1) comp.x1 = x;
      if (y < comp.y0) comp.y0 = y;
      if (y > comp.y1) comp.y1 = y;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx; const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= colunas || ny >= linhas) continue;
          const j = ny * colunas + nx;
          if (m[j] && rotulo[j] < 0) { rotulo[j] = lista.length; pilha.push(j); }
        }
      }
    }
    lista.push(comp);
  }
  return lista;
}

/**
 * O que um traço cerca, olhando só para ele.
 *
 * Trabalha na caixa do componente com uma célula de folga: tudo o que está
 * fora dessa caixa está fora do laço, e o anel de folga é por onde a inundação
 * começa. Devolve a máscara local do traço mais o que ele fecha.
 */
function cercado(traco, largura, altura) {
  const lw = largura + 2;
  const lh = altura + 2;
  const alcancado = new Uint8Array(lw * lh);
  const pilha = [];
  const parede = (x, y) => x > 0 && y > 0 && x <= largura && y <= altura && traco[(y - 1) * largura + (x - 1)];
  for (let x = 0; x < lw; x += 1) { pilha.push(x, 0, x, lh - 1); }
  for (let y = 0; y < lh; y += 1) { pilha.push(0, y, lw - 1, y); }
  while (pilha.length) {
    const y = pilha.pop(); const x = pilha.pop();
    if (x < 0 || y < 0 || x >= lw || y >= lh) continue;
    const i = y * lw + x;
    if (alcancado[i] || parede(x, y)) continue;
    alcancado[i] = 1;
    pilha.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
  }

  const dentro = new Uint8Array(largura * altura);
  let fechado = 0;
  let tinta = 0;
  for (let y = 0; y < altura; y += 1) {
    for (let x = 0; x < largura; x += 1) {
      const i = y * largura + x;
      if (traco[i]) { dentro[i] = 1; tinta += 1; continue; }
      if (!alcancado[(y + 1) * lw + (x + 1)]) { dentro[i] = 1; fechado += 1; }
    }
  }
  return { dentro, fechado, tinta };
}

/**
 * É laço — um traço que cerca uma área — ou é mancha?
 *
 * As duas medidas juntas são o que separa a caneta do usuário do desenho da
 * fatura. Um oval em volta de lançamentos é quase só vazio por dentro. Uma tarja
 * de cabeçalho também "cerca" alguma coisa — as letras brancas dentro dela —,
 * mas ali a tinta é a maior parte da área. Por isso o fechado precisa ser uma
 * fração razoável da caixa **e** comparável à própria tinta.
 *
 * Comparável, e não maior: no círculo apertado em volta de uma linha só, o
 * traço de cima e o de baixo somam quase tanto quanto o miolo. Numa tarja, a
 * proporção fica em um quarto; num trecho de marca-texto, em um terço.
 */
const ehLaco = ({ fechado, tinta }, area) => fechado >= area * 0.15 && fechado >= tinta * 0.6;

// Raios de fechamento, em células de 1pt, tentados em ordem. O primeiro emenda
// falhas mínimas do traço; os seguintes, o vão entre o começo e o fim de um
// círculo que não chegou a fechar (até cerca de 12pt e 24pt de cada lado).
const RAIOS = [1, 12, 24];

/**
 * O contorno da marca dentro de uma região: a grade do que está cercado.
 *
 * `faixa` restringe a tinta à cor da marca, para um logotipo de outra cor que
 * caia dentro da caixa não virar parede. Devolve `null` quando não há traço que
 * defina área — quem chama continua usando a caixa, como antes.
 *
 * Um traço que não fecha nem com o maior raio entra pela própria caixa: é o
 * colchete na margem, o círculo com um vão grande. Errar para o lado de trazer
 * um pouco a mais, que o usuário vê e desmarca, e não para o lado de perder o
 * que ele marcou.
 */
export function formaDaMarca(canvas, regiao, faixa = null) {
  const W = canvas.width;
  const H = canvas.height;
  const px0 = Math.max(0, Math.floor((regiao.x - MARGEM_FORMA) * W));
  const py0 = Math.max(0, Math.floor((regiao.y - MARGEM_FORMA) * H));
  const px1 = Math.min(W, Math.ceil((regiao.x + regiao.largura + MARGEM_FORMA) * W));
  const py1 = Math.min(H, Math.ceil((regiao.y + regiao.altura + MARGEM_FORMA) * H));
  const lw = px1 - px0;
  const lh = py1 - py0;
  if (lw < CELULA_FORMA * 4 || lh < CELULA_FORMA * 4) return null;

  const colunas = Math.ceil(lw / CELULA_FORMA);
  const linhas = Math.ceil(lh / CELULA_FORMA);
  const { data } = canvas.getContext('2d').getImageData(px0, py0, lw, lh);

  const tinta = new Uint8Array(colunas * linhas);
  for (let y = 0; y < lh; y += 1) {
    const linhaCel = Math.floor(y / CELULA_FORMA) * colunas;
    for (let x = 0; x < lw; x += 1) {
      const i = (y * lw + x) * 4;
      const r = data[i]; const g = data[i + 1]; const b = data[i + 2];
      if (!ehTinta(r, g, b)) continue;
      if (faixa !== null && matiz(r, g, b) !== faixa) continue;
      tinta[linhaCel + Math.floor(x / CELULA_FORMA)] = 1;
    }
  }

  const fechada = fechar(tinta, colunas, linhas, RAIOS[0]);
  const minimoX = (LARGURA_MINIMA_LACO * W) / CELULA_FORMA;
  const minimoY = (ALTURA_MINIMA_LACO * H) / CELULA_FORMA;

  const dentro = new Uint8Array(colunas * linhas);
  let lacos = 0;
  let abertas = 0;

  for (const comp of componentes(fechada, colunas, linhas)) {
    const largura = comp.x1 - comp.x0 + 1;
    const altura = comp.y1 - comp.y0 + 1;
    if (largura < minimoX || altura < minimoY) continue;

    let traco = new Uint8Array(largura * altura);
    for (const i of comp.celulas) {
      const x = i % colunas;
      const y = (i - x) / colunas;
      traco[(y - comp.y0) * largura + (x - comp.x0)] = 1;
    }

    let achado = null;
    for (let k = 0; k < RAIOS.length; k += 1) {
      if (k > 0) traco = fechar(traco, largura, altura, RAIOS[k]);
      const tentativa = cercado(traco, largura, altura);
      if (ehLaco(tentativa, largura * altura)) { achado = tentativa; break; }
    }

    if (achado) {
      lacos += 1;
      for (let y = 0; y < altura; y += 1) {
        for (let x = 0; x < largura; x += 1) {
          if (achado.dentro[y * largura + x]) dentro[(y + comp.y0) * colunas + (x + comp.x0)] = 1;
        }
      }
    } else {
      abertas += 1;
      for (let y = comp.y0; y <= comp.y1; y += 1) dentro.fill(1, y * colunas + comp.x0, y * colunas + comp.x1 + 1);
    }
  }

  if (lacos + abertas === 0) return null;
  return {
    x: px0 / W,
    y: py0 / H,
    passoX: CELULA_FORMA / W,
    passoY: CELULA_FORMA / H,
    colunas,
    linhas,
    celulas: dentro,
    lacos,
    abertas,
  };
}

/** O ponto (normalizado) está dentro do que a marca cerca? */
export function dentroDaForma(forma, nx, ny) {
  const c = Math.floor((nx - forma.x) / forma.passoX);
  const l = Math.floor((ny - forma.y) / forma.passoY);
  if (c < 0 || l < 0 || c >= forma.colunas || l >= forma.linhas) return false;
  return forma.celulas[l * forma.colunas + c] === 1;
}

/* ------------------------- desenho para a escolha -------------------------- */

const CORES_ROTULO = ['#1a73e8', '#188038', '#b06000', '#8430ce'];

/**
 * As letras são desenhadas a traço, e não escritas com uma fonte.
 *
 * Isso não é purismo: a etiqueta é o que o modelo tem que ler, e quando ela
 * saiu ilegível ele não escolheu nenhuma das caixas — 12 segundos de raciocínio
 * e resposta vazia, três vezes seguidas. Com a letra legível, a mesma pergunta
 * sobre a mesma página foi respondida certo em 0,9 segundo, oito vezes de oito.
 *
 * E a fonte não é garantida: `sans-serif` caiu numa fonte decorativa quadrada
 * nesta máquina, e a imagem do app é Alpine, que não traz fonte nenhuma. Quatro
 * letras a traço não dependem de nada disso.
 */
const LETRAS = {
  A: (ctx) => {
    ctx.moveTo(0.12, 0.92); ctx.lineTo(0.5, 0.08); ctx.lineTo(0.88, 0.92);
    ctx.moveTo(0.26, 0.62); ctx.lineTo(0.74, 0.62);
  },
  B: (ctx) => {
    ctx.moveTo(0.25, 0.08); ctx.lineTo(0.25, 0.92);
    ctx.moveTo(0.25, 0.08); ctx.quadraticCurveTo(0.85, 0.08, 0.85, 0.29);
    ctx.quadraticCurveTo(0.85, 0.5, 0.25, 0.5);
    ctx.quadraticCurveTo(0.9, 0.5, 0.9, 0.71);
    ctx.quadraticCurveTo(0.9, 0.92, 0.25, 0.92);
  },
  C: (ctx) => {
    ctx.moveTo(0.82, 0.24);
    ctx.quadraticCurveTo(0.5, 0.0, 0.2, 0.3);
    ctx.quadraticCurveTo(0.05, 0.5, 0.2, 0.7);
    ctx.quadraticCurveTo(0.5, 1.0, 0.82, 0.76);
  },
  D: (ctx) => {
    ctx.moveTo(0.25, 0.08); ctx.lineTo(0.25, 0.92);
    ctx.moveTo(0.25, 0.08);
    ctx.quadraticCurveTo(0.9, 0.08, 0.9, 0.5);
    ctx.quadraticCurveTo(0.9, 0.92, 0.25, 0.92);
  },
};

function desenharLetra(ctx, letra, x, y, lado) {
  const traco = LETRAS[letra];
  if (!traco) return;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(lado, lado);
  ctx.beginPath();
  traco(ctx);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 0.14;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.restore();
}

/**
 * Desenha as candidatas numeradas sobre a página, para o modelo poder apontar
 * uma delas por letra.
 *
 * Perguntar "qual letra" em vez de "quais coordenadas" é o ponto todo: a
 * resposta é um caractere, o raciocínio fica curto e a saída não tem como sair
 * 12% fora do lugar — ou a letra existe, ou a resposta é descartada.
 */
export function comRotulos(canvas, regioes) {
  const copia = createCanvas(canvas.width, canvas.height);
  const ctx = copia.getContext('2d');
  ctx.drawImage(canvas, 0, 0);

  regioes.forEach((regiao, i) => {
    const cor = CORES_ROTULO[i % CORES_ROTULO.length];
    const x = regiao.x * canvas.width;
    const y = regiao.y * canvas.height;
    const l = regiao.largura * canvas.width;
    const a = regiao.altura * canvas.height;
    const letra = String.fromCharCode(65 + i);

    ctx.strokeStyle = cor;
    ctx.lineWidth = Math.max(2, canvas.width / 400);
    ctx.strokeRect(x, y, l, a);

    // A etiqueta vai para dentro da caixa quando ela encosta no topo da página,
    // senão sai cortada e o modelo não tem o que ler.
    const lado = Math.max(28, canvas.width / 26);
    const ey = y - lado < 0 ? y : y - lado;
    ctx.fillStyle = cor;
    ctx.fillRect(x, ey, lado, lado);

    const margem = lado * 0.18;
    desenharLetra(ctx, letra, x + margem, ey + margem, lado - margem * 2);
  });

  return copia;
}

/**
 * Recorta a região do canvas, com uma folga.
 *
 * A folga existe porque a caixa vem de quem desenhou a marca por fora do texto:
 * apertada demais, ela corta a primeira letra da descrição ou o último dígito
 * do valor — e um valor com um dígito a menos entra no banco sem parecer errado.
 *
 * Mas folga demais traz o vizinho junto. Medido na fatura de teste, com as
 * linhas a 26pt uma da outra: com 1,5% entrava meia linha de cima, e o
 * reconhecimento leu essa metade como um lançamento de R$ 213,99 que ninguém
 * marcou. Com 0,8% o recorte trouxe exatamente as quatro linhas marcadas.
 *
 * O próprio traço da caneta é apagado: o reconhecimento o lia como "|", "O" ou
 * "—" grudado na data.
 *
 * Com `caixas`, o recorte sai mascarado: fica em branco tudo o que não está nem
 * no miolo do laço nem nas caixas dadas (as linhas que a leitura decidiu que
 * estão dentro da marca). É a imagem que vai para o modelo de visão — ele lê o
 * que vê, e assim só vê o que foi circulado. O reconhecimento de texto recebe o
 * recorte sem máscara: mascarar antes cortava ao meio as letras por onde o traço
 * passa, e a linha encostada no traço saía ilegível. Para ele, o filtro é
 * depois, pela posição de cada palavra.
 */
export function recortar(canvas, regiao, { folga = 0.008, caixas = null } = {}) {
  const q = enquadrar(canvas, regiao, folga);
  if (!q) return canvas;

  const recorte = createCanvas(q.l, q.a);
  const ctx = recorte.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, q.l, q.a);

  const mascarar = Boolean(regiao.forma && caixas);
  if (mascarar) {
    ctx.save();
    ctx.beginPath();
    tracarForma(ctx, regiao.forma, { x: q.x, y: q.y, escalaX: canvas.width, escalaY: canvas.height });
    for (const c of caixas) ctx.rect(c.x - q.x, c.y - q.y, c.largura, c.altura);
    ctx.clip();
  }
  ctx.drawImage(canvas, q.x, q.y, q.l, q.a, 0, 0, q.l, q.a);
  if (mascarar) ctx.restore();

  if (regiao.faixa !== undefined && regiao.faixa !== null) apagarTraco(recorte, regiao.faixa);
  return recorte;
}

/** O retângulo, em pixels do canvas, que `recortar` tira da região. */
export function enquadrar(canvas, regiao, folga = 0.008) {
  const x = Math.max(0, Math.round((regiao.x - folga) * canvas.width));
  const y = Math.max(0, Math.round((regiao.y - folga) * canvas.height));
  const l = Math.min(canvas.width - x, Math.round((regiao.largura + folga * 2) * canvas.width));
  const a = Math.min(canvas.height - y, Math.round((regiao.altura + folga * 2) * canvas.height));
  return l < 8 || a < 8 ? null : { x, y, l, a };
}

// Quanto o miolo do laço recua do traço na imagem do modelo, em células (1pt
// cada). Junto do traço ficam as pontas das linhas vizinhas que ele cruzou —
// metade de uma data, o começo de um valor —, e o modelo as leria como
// lançamento. As linhas de dentro que encostam no traço voltam pelas caixas.
const RECUO_DO_MIOLO = 6;

/** Acrescenta ao caminho atual os retângulos do miolo da forma. */
function tracarForma(ctx, forma, { x, y, escalaX, escalaY }) {
  forma.miolo ??= inverter(dilatar(inverter(forma.celulas), forma.colunas, forma.linhas, RECUO_DO_MIOLO, 1));
  const m = forma.miolo;
  const cw = forma.passoX * escalaX;
  const ch = forma.passoY * escalaY;
  const ox = forma.x * escalaX - x;
  const oy = forma.y * escalaY - y;
  // Uma faixa horizontal por sequência de células dentro: poucas centenas de
  // retângulos, em vez de um por célula.
  for (let l = 0; l < forma.linhas; l += 1) {
    let c = 0;
    while (c < forma.colunas) {
      if (!m[l * forma.colunas + c]) { c += 1; continue; }
      const inicio = c;
      while (c < forma.colunas && m[l * forma.colunas + c]) c += 1;
      ctx.rect(ox + inicio * cw, oy + l * ch, (c - inicio) * cw + 0.5, ch + 0.5);
    }
  }
}

// A franja do traço: o rosado claro que a suavização da borda e a compressão do
// JPEG deixam em volta da tinta. Não é viva o bastante para contar como marca,
// mas o reconhecimento a binariza como risco — e na digitalização de teste esse
// contorno pontilhado fez "212,20" sair "51920" e "55,50" sair "EBD.".
const FRANJA_VIVACIDADE = 22;
const FRANJA_CLARIDADE = 140;

/** Pinta de branco a tinta da cor da marca, e a franja clara em volta dela. */
function apagarTraco(canvas, faixa) {
  const ctx = canvas.getContext('2d');
  const imagem = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { data } = imagem;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]; const g = data[i + 1]; const b = data[i + 2];
    const maior = Math.max(r, g, b);
    const diferenca = maior - Math.min(r, g, b);
    const tinta = ehTinta(r, g, b);
    const franja = maior > FRANJA_CLARIDADE && diferenca > FRANJA_VIVACIDADE;
    if ((tinta || franja) && matiz(r, g, b) === faixa) {
      data[i] = 255; data[i + 1] = 255; data[i + 2] = 255;
    }
  }
  ctx.putImageData(imagem, 0, 0);
}
