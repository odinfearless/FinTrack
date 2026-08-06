import { useEffect, useRef } from 'react';

const DURACAO = 460;

/**
 * Desliza o trilho até `destino` com desaceleração.
 *
 * A animação é feita quadro a quadro em vez de `behavior: 'smooth'` porque há
 * motores em que aquele modo simplesmente não executa — e aí o item escolhido
 * nunca chegaria ao centro. Aqui só existem atribuições de `scrollLeft`, que
 * funcionam em qualquer lugar.
 *
 * Devolve a função que cancela a animação em curso.
 */
function deslizarPara(el, destino, aoTerminar) {
  const inicio = el.scrollLeft;
  const delta = destino - inicio;

  if (Math.abs(delta) < 1) {
    aoTerminar();
    return () => {};
  }

  // O encaixe do scroll-snap disputaria com a animação e produziria trepidação;
  // ele é desligado durante o percurso e volta no fim, onde é útil de novo.
  const snapOriginal = el.style.scrollSnapType;
  el.style.scrollSnapType = 'none';

  const comeco = performance.now();
  let quadro;

  const passo = (agora) => {
    const t = Math.min((agora - comeco) / DURACAO, 1);
    // Sai rápido e vai frenando até parar: é isso que dá a sensação de inércia.
    const suavizado = 1 - (1 - t) ** 5;
    el.scrollLeft = inicio + delta * suavizado;

    if (t < 1) {
      quadro = requestAnimationFrame(passo);
      return;
    }
    el.style.scrollSnapType = snapOriginal;
    aoTerminar();
  };

  quadro = requestAnimationFrame(passo);

  return () => {
    cancelAnimationFrame(quadro);
    el.style.scrollSnapType = snapOriginal;
  };
}

/**
 * Onde o item começa, medido no conteúdo que rola.
 *
 * Sai da posição em tela, e não de `offsetLeft`: aquele é medido a partir do
 * ancestral posicionado mais próximo, que nem sempre é o trilho — o respiro
 * lateral do carrossel e um trilho interno já deslocam a conta, e o item iria
 * parar longe do centro pela largura desse deslocamento.
 */
function posicaoNoTrilho(el, item) {
  return item.getBoundingClientRect().left - el.getBoundingClientRect().left + el.scrollLeft;
}

// Abaixo disto o gesto foi um clique que tremeu, e não um arrasto: o item
// escolhido continua sendo escolhido.
const FOLGA_DE_CLIQUE = 5;

/**
 * Arrastar o trilho com o ponteiro, e soltá-lo com inércia.
 *
 * No toque isso já existe — a rolagem por gesto é do navegador, e refazê-la na
 * mão só atrapalharia. O que falta é no mouse: sem isto, no desktop só há a
 * roda, e num trilho horizontal ela é o gesto errado.
 *
 * O encaixe fica desligado durante o arrasto e a inércia, e volta quando o
 * movimento acaba — é ele que fecha o percurso num item inteiro, e daí o
 * escutador de rolagem escolhe quem ficou no centro.
 */
function arrastoComInercia(el) {
  let pressionado = false;
  let arrastando = false;
  let partidaX = 0;
  let partidaScroll = 0;
  let percorrido = 0;
  let amostras = [];
  let quadro;
  let snapOriginal = '';

  const parar = () => { if (quadro) cancelAnimationFrame(quadro); quadro = undefined; };
  const restaurarSnap = () => { el.style.scrollSnapType = snapOriginal; };

  const aoPressionar = (e) => {
    if (e.pointerType === 'touch' || e.button !== 0) return;
    parar();
    pressionado = true;
    arrastando = false;
    percorrido = 0;
    partidaX = e.clientX;
    partidaScroll = el.scrollLeft;
    amostras = [{ t: performance.now(), x: e.clientX }];
  };

  /**
   * O arrasto só começa de verdade depois da folga de clique — e é aí que o
   * ponteiro é capturado.
   *
   * Capturar já no `pointerdown` custava caro: com a captura ativa o `click`
   * passa a ser entregue ao trilho, e não ao item embaixo do cursor. O trilho
   * ficava arrastável e, em troca, nenhum cartão podia mais ser escolhido no
   * clique — que é o gesto principal quando tudo cabe na tela e não há o que
   * arrastar.
   */
  const comecarArrasto = (e) => {
    arrastando = true;
    snapOriginal = el.style.scrollSnapType;
    el.style.scrollSnapType = 'none';
    el.style.userSelect = 'none';
    el.classList.add('arrastando');
    // A captura é o que mantém o gesto vivo quando o ponteiro sai do trilho.
    // Falha se o ponteiro já não estiver ativo, e aí o arrasto segue sem ela.
    try { el.setPointerCapture(e.pointerId); } catch { /* sem captura */ }
  };

  const aoMover = (e) => {
    if (!pressionado) return;
    const dx = e.clientX - partidaX;
    percorrido = Math.max(percorrido, Math.abs(dx));
    if (!arrastando) {
      if (percorrido <= FOLGA_DE_CLIQUE) return;
      comecarArrasto(e);
    }
    el.scrollLeft = partidaScroll - dx;
    amostras.push({ t: performance.now(), x: e.clientX });
    if (amostras.length > 6) amostras.shift();
  };

  const aoSoltar = (e) => {
    const houveArrasto = arrastando;
    pressionado = false;
    arrastando = false;
    // Solto sem ter passado da folga, o gesto foi um clique: nada a desfazer, e
    // o clique segue seu caminho até o item.
    if (!houveArrasto) return;

    try { el.releasePointerCapture(e.pointerId); } catch { /* já solto */ }
    el.style.userSelect = '';
    el.classList.remove('arrastando');

    // A velocidade sai só das amostras recentes: usar o gesto inteiro faria uma
    // arrancada longa e um freio no fim virarem "velocidade média alta", e o
    // trilho sairia voando de um movimento que terminou parado.
    const agora = performance.now();
    const recentes = amostras.filter((a) => agora - a.t < 90);
    const primeira = recentes[0];
    const ultima = recentes[recentes.length - 1];
    let v = primeira && ultima.t > primeira.t
      ? (ultima.x - primeira.x) / (ultima.t - primeira.t)
      : 0;

    if (Math.abs(v) < 0.05 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      restaurarSnap();
      return;
    }

    let anterior = agora;
    const passo = (t) => {
      // O teto no intervalo evita um salto depois de um quadro perdido.
      const dt = Math.min(t - anterior, 32);
      anterior = t;
      el.scrollLeft -= v * dt;
      v *= 0.94 ** (dt / 16.67);

      const naPonta = el.scrollLeft <= 0 || el.scrollLeft >= el.scrollWidth - el.clientWidth;
      if (Math.abs(v) > 0.02 && !naPonta) { quadro = requestAnimationFrame(passo); return; }
      quadro = undefined;
      restaurarSnap();
    };
    quadro = requestAnimationFrame(passo);
  };

  // Sem isto, arrastar terminaria escolhendo o item onde o dedo parou: o clique
  // nasce do `pointerup` e chegaria ao botão como se ninguém tivesse arrastado.
  const aoClicar = (e) => {
    if (percorrido <= FOLGA_DE_CLIQUE) return;
    e.stopPropagation();
    e.preventDefault();
  };

  const aoArrastarNativo = (e) => e.preventDefault();

  el.addEventListener('pointerdown', aoPressionar);
  el.addEventListener('pointermove', aoMover);
  el.addEventListener('pointerup', aoSoltar);
  el.addEventListener('pointercancel', aoSoltar);
  el.addEventListener('click', aoClicar, true);
  el.addEventListener('dragstart', aoArrastarNativo);

  return () => {
    parar();
    el.removeEventListener('pointerdown', aoPressionar);
    el.removeEventListener('pointermove', aoMover);
    el.removeEventListener('pointerup', aoSoltar);
    el.removeEventListener('pointercancel', aoSoltar);
    el.removeEventListener('click', aoClicar, true);
    el.removeEventListener('dragstart', aoArrastarNativo);
  };
}

/**
 * Comportamento de carrossel, compartilhado por quem precisa dele.
 *
 * São três coisas, e elas convergem para o mesmo estado: o item escolhido vai
 * para o centro com inércia — inclusive quando a escolha vem de fora do
 * carrossel —, o trilho pode ser arrastado com o ponteiro, e o que parar no
 * centro passa a ser o escolhido.
 *
 * `pronto` existe para quem monta o trilho depois de buscar dados: enquanto for
 * falso não há item nenhum no DOM para centralizar, e sem esse aviso o primeiro
 * item escolhido ficaria fora do centro até a próxima troca.
 *
 * Devolve o `ref` do elemento que rola. Cada item precisa trazer `data-chave`,
 * e o escolhido, `data-ativo="sim"`.
 */
export function useCarrossel({ selecionado, aoSelecionar, pronto = true }) {
  const trilho = useRef(null);
  const ignorarRolagem = useRef(false);

  useEffect(() => {
    const el = trilho.current;
    const alvo = el?.querySelector('[data-ativo="sim"]');
    if (!el || !alvo) return undefined;

    // Rola o trilho, e não `scrollIntoView`: aquele também rola os ancestrais e
    // pode arrastar a página inteira junto; este mexe só no carrossel.
    const destino = Math.max(
      0,
      posicaoNoTrilho(el, alvo) - (el.clientWidth - alvo.offsetWidth) / 2,
    );
    ignorarRolagem.current = true;
    const liberar = () => { ignorarRolagem.current = false; };

    // Quem pediu menos movimento vai direto ao ponto.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.scrollLeft = destino;
      liberar();
      return undefined;
    }

    let concluido = false;
    const cancelar = deslizarPara(el, destino, () => { concluido = true; liberar(); });

    // Rede de segurança. `requestAnimationFrame` não roda em aba de segundo
    // plano, e sem isto a animação ficaria pela metade — o item nunca chegaria
    // ao centro. Se o prazo vencer sem ela ter terminado, o destino é assumido
    // de uma vez. A guarda evita puxar de volta quem já rolou o trilho na mão.
    const t = setTimeout(() => {
      if (concluido) return;
      cancelar();
      el.scrollLeft = destino;
      liberar();
    }, DURACAO + 400);

    return () => { cancelar(); clearTimeout(t); };
  }, [selecionado, pronto]);

  // O efeito abaixo não pode depender de `selecionado`/`aoSelecionar`: eles
  // mudam a cada render, o efeito seria refeito no meio do gesto e a limpeza
  // mataria o temporizador de espera antes de ele decidir qualquer coisa.
  const ultimo = useRef({ selecionado, aoSelecionar });
  ultimo.current = { selecionado, aoSelecionar };

  useEffect(() => {
    const el = trilho.current;
    if (!el) return undefined;

    let tempo;
    const aoRolar = () => {
      clearTimeout(tempo);
      // Espera a rolagem parar: selecionar durante o movimento trocaria o
      // estado várias vezes no meio de um único gesto.
      tempo = setTimeout(() => {
        if (ignorarRolagem.current) return;
        const centro = el.scrollLeft + el.clientWidth / 2;
        let melhor = null;
        for (const item of el.querySelectorAll('[data-chave]')) {
          const meio = posicaoNoTrilho(el, item) + item.offsetWidth / 2;
          const dist = Math.abs(meio - centro);
          if (!melhor || dist < melhor.dist) melhor = { dist, chave: item.dataset.chave };
        }
        if (melhor && melhor.chave !== ultimo.current.selecionado) {
          ultimo.current.aoSelecionar(melhor.chave);
        }
      }, 140);
    };

    const soltarArrasto = arrastoComInercia(el);

    el.addEventListener('scroll', aoRolar, { passive: true });
    return () => {
      soltarArrasto();
      el.removeEventListener('scroll', aoRolar);
      clearTimeout(tempo);
    };
    // `pronto` está aqui porque o trilho de quem busca dados só existe no DOM
    // depois da resposta: na primeira renderização não há elemento em que
    // escutar, e sem refazer o efeito a rolagem nunca chegaria a selecionar.
  }, [pronto]);

  return trilho;
}
