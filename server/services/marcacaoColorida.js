/**
 * Detecção das marcações coloridas feitas no próprio PDF.
 *
 * Quando o usuário circula os lançamentos num editor de PDF, o traço vira
 * caminho vetorial no conteúdo da página — não uma anotação. Aqui esses traços
 * são localizados pela cor, e a área que envolvem vira a região a ler.
 *
 * Qualquer cor viva serve: vermelho, verde, azul, rosa. O que separa uma
 * marcação de um logotipo ou de uma tarja de cabeçalho não é a cor, e sim o que
 * ela envolve — marcação cerca várias linhas de texto, decoração não.
 *
 * As regiões saem normalizadas (0 a 1, origem no canto superior esquerdo).
 */

/** Aceita a cor tanto em hex (`#ea4335`) quanto em componentes. */
function paraRgb(valor) {
  if (typeof valor === 'string' && /^#[0-9a-f]{6}$/i.test(valor)) {
    return [1, 3, 5].map((i) => parseInt(valor.slice(i, i + 2), 16));
  }
  if (Array.isArray(valor) && valor.length >= 3) {
    return valor.slice(0, 3).map((c) => (c <= 1 ? Math.round(c * 255) : Math.round(c)));
  }
  return null;
}

/**
 * Cor de caneta: viva o bastante para não ser preto, branco ou cinza do
 * documento. Mede-se pela distância entre o canal mais forte e o mais fraco.
 */
function ehColorida(rgb) {
  if (!rgb) return false;
  const [r, g, b] = rgb;
  const maior = Math.max(r, g, b);
  const menor = Math.min(r, g, b);
  return maior > 90 && maior - menor > 55;
}

const chaveCor = (rgb) => `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`;

const aplicar = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

const multiplicar = (a, b) => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
];

/** Junta caixas que se tocam ou quase — um círculo à mão vira vários traços. */
function unir(caixas, folga = 0.02) {
  const restantes = [...caixas];
  const grupos = [];

  while (restantes.length) {
    const atual = { ...restantes.shift() };
    let mudou = true;
    while (mudou) {
      mudou = false;
      for (let i = restantes.length - 1; i >= 0; i -= 1) {
        const o = restantes[i];
        const encosta = atual.x - folga <= o.x + o.largura
          && o.x - folga <= atual.x + atual.largura
          && atual.y - folga <= o.y + o.altura
          && o.y - folga <= atual.y + atual.altura;
        if (!encosta) continue;
        const x1 = Math.min(atual.x, o.x);
        const y1 = Math.min(atual.y, o.y);
        const x2 = Math.max(atual.x + atual.largura, o.x + o.largura);
        const y2 = Math.max(atual.y + atual.altura, o.y + o.altura);
        atual.x = x1; atual.y = y1; atual.largura = x2 - x1; atual.altura = y2 - y1;
        restantes.splice(i, 1);
        mudou = true;
      }
    }
    grupos.push(atual);
  }
  return grupos;
}

const LINHAS_MINIMAS = 3;

/** Quantas linhas de texto distintas caem dentro da região. */
function linhasDentro(regiao, itens, vista) {
  const ys = new Set();
  for (const item of itens) {
    if (!item.str?.trim()) continue;
    const x = item.transform[4] / vista.width;
    const y = (vista.height - item.transform[5]) / vista.height;
    if (x >= regiao.x && x <= regiao.x + regiao.largura
      && y >= regiao.y && y <= regiao.y + regiao.altura) {
      ys.add(Math.round(item.transform[5]));
    }
  }
  return ys.size;
}

/**
 * Varre o documento e devolve as regiões envolvidas por traço colorido.
 * `pdfjs` é recebido por parâmetro para o módulo não decidir sozinho qual build
 * carregar — quem chama já tem a instância certa.
 */
export async function detectarRegioesMarcadas(documento, pdfjs) {
  const nomeOp = Object.fromEntries(Object.entries(pdfjs.OPS).map(([k, v]) => [v, k]));
  const encontradas = [];
  const cores = new Set();

  for (let n = 1; n <= documento.numPages; n += 1) {
    const pagina = await documento.getPage(n);
    const vista = pagina.getViewport({ scale: 1 });
    const lista = await pagina.getOperatorList();

    let ctm = [1, 0, 0, 1, 0, 0];
    const pilha = [];
    let corTraco = null;
    let corPreenchimento = null;
    // Cada cor acumula suas próprias caixas: marcações de cores diferentes na
    // mesma página são marcações diferentes e não devem se fundir.
    const porCor = new Map();

    for (let i = 0; i < lista.fnArray.length; i += 1) {
      const op = nomeOp[lista.fnArray[i]];
      const args = lista.argsArray[i];

      if (op === 'save') { pilha.push([...ctm]); continue; }
      if (op === 'restore') { ctm = pilha.pop() || [1, 0, 0, 1, 0, 0]; continue; }
      if (op === 'transform') { ctm = multiplicar(ctm, args); continue; }
      if (op === 'setStrokeRGBColor') { corTraco = paraRgb(args[0] ?? args); continue; }
      if (op === 'setFillRGBColor') { corPreenchimento = paraRgb(args[0] ?? args); continue; }
      if (op !== 'constructPath') continue;

      const cor = [corTraco, corPreenchimento].find(ehColorida);
      if (!cor) continue;

      // O terceiro argumento é a caixa do caminho: [minX, minY, maxX, maxY].
      const bbox = args[2];
      if (!bbox || bbox.length < 4) continue;

      const cantos = [
        aplicar(ctm, bbox[0], bbox[1]), aplicar(ctm, bbox[2], bbox[1]),
        aplicar(ctm, bbox[2], bbox[3]), aplicar(ctm, bbox[0], bbox[3]),
      ];
      const xs = cantos.map((c) => c[0]);
      const ys = cantos.map((c) => c[1]);

      // O PDF conta o Y de baixo para cima; a região sai no referencial da tela.
      const caixa = {
        x: Math.min(...xs) / vista.width,
        largura: (Math.max(...xs) - Math.min(...xs)) / vista.width,
        y: (vista.height - Math.max(...ys)) / vista.height,
        altura: (Math.max(...ys) - Math.min(...ys)) / vista.height,
      };

      // Traço que cobre a página inteira é moldura ou fundo, não marcação.
      if (caixa.largura > 0.97 && caixa.altura > 0.97) continue;

      const chave = chaveCor(cor);
      if (!porCor.has(chave)) porCor.set(chave, []);
      porCor.get(chave).push(caixa);
    }

    if (porCor.size > 0) {
      const conteudo = await pagina.getTextContent();
      for (const [chave, caixas] of porCor) {
        for (const regiao of unir(caixas)) {
          if (regiao.largura < 0.03 || regiao.altura < 0.005) continue;
          // A prova de que é marcação, e não logotipo ou tarja: ela cerca várias
          // linhas de texto. Decoração colorida raramente cerca alguma.
          if (linhasDentro(regiao, conteudo.items, vista) < LINHAS_MINIMAS) continue;
          encontradas.push({ pagina: n, cor: chave, ...regiao });
          cores.add(chave);
        }
      }
    }

    pagina.cleanup();
  }

  encontradas.cores = [...cores];
  return encontradas;
}
