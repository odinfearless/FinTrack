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

/**
 * Comportamento de carrossel, compartilhado por quem precisa dele.
 *
 * São duas coisas, e elas convergem para o mesmo estado: o item escolhido vai
 * para o centro com inércia — inclusive quando a escolha vem de fora do
 * carrossel —, e rolar o trilho escolhe quem parar no centro.
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

    el.addEventListener('scroll', aoRolar, { passive: true });
    return () => { el.removeEventListener('scroll', aoRolar); clearTimeout(tempo); };
    // `pronto` está aqui porque o trilho de quem busca dados só existe no DOM
    // depois da resposta: na primeira renderização não há elemento em que
    // escutar, e sem refazer o efeito a rolagem nunca chegaria a selecionar.
  }, [pronto]);

  return trilho;
}
