import { useEffect, useRef } from 'react';
import CartaoVisual, { corDeMarca } from './CartaoVisual.jsx';
import NotaVisual from './NotaVisual.jsx';
import { Valor } from './componentes.jsx';

const LARGURA = 232;
const DURACAO = 460;

/**
 * Desliza o trilho até `destino` com desaceleração.
 *
 * A animação é feita quadro a quadro em vez de `behavior: 'smooth'` porque há
 * motores em que aquele modo simplesmente não executa — e aí o cartão nunca
 * chegaria ao centro. Aqui só existem atribuições de `scrollLeft`, que funcionam
 * em qualquer lugar.
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

/** Slide de "Todos": não há plástico, então o resumo do mês faz as vezes dele. */
function ResumoVisual({ cartoes, largura }) {
  return (
    <div
      style={{
        width: largura,
        aspectRatio: '1.586',
        borderRadius: largura / 18,
        padding: `${largura / 14}px`,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        border: '1px solid var(--border)',
        background: 'var(--surface-2)',
        color: 'var(--text)',
      }}
    >
      <div style={{ fontSize: largura / 20, fontWeight: 650, letterSpacing: '-0.01em' }}>
        Tudo do mês
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {cartoes.slice(0, 6).map((c) => (
          <i
            key={c.id}
            className="ponto"
            style={{ background: corDeMarca(c.cor), width: 12, height: 12 }}
            title={c.nome}
          />
        ))}
        <i className="ponto" style={{ background: 'var(--s3)', width: 12, height: 12 }} title="Sem cartão" />
      </div>
      <div style={{ fontSize: largura / 26, color: 'var(--text-2)' }}>
        Cartões e gastos sem cartão
      </div>
    </div>
  );
}

/**
 * Carrossel das origens de gasto.
 *
 * Substitui a fileira de botões: em vez de ler nomes, o usuário reconhece o
 * cartão pelo desenho. Cada slide já traz o total daquele cartão no mês, então
 * dá para comparar as faturas passando o dedo, sem trocar de filtro.
 *
 * Rolar seleciona o slide que ficar centralizado; tocar também seleciona. As
 * duas formas convergem para o mesmo estado, e o `scroll-snap` garante que a
 * rolagem sempre pare num slide inteiro.
 */
export default function CarrosselOrigens({ slides, selecionado, aoSelecionar, cartoes }) {
  const trilho = useRef(null);
  const ignorarRolagem = useRef(false);

  // Traz o slide escolhido para o centro — inclusive quando a escolha veio de
  // fora do carrossel (o link "Ver gastos" da tela de Cartões, por exemplo).
  useEffect(() => {
    const el = trilho.current;
    const alvo = el?.querySelector('[data-ativo="sim"]');
    if (!el || !alvo) return undefined;

    // Rola o trilho, e não `scrollIntoView`: aquele também rola os ancestrais e
    // pode arrastar a página inteira junto; este mexe só no carrossel.
    const destino = Math.max(0, alvo.offsetLeft - (el.clientWidth - alvo.offsetWidth) / 2);
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
    // plano, e sem isto a animação ficaria pela metade — o cartão nunca chegaria
    // ao centro. Se o prazo vencer sem ela ter terminado, o destino é assumido
    // de uma vez. A guarda evita puxar de volta quem já rolou o trilho na mão.
    const t = setTimeout(() => {
      if (concluido) return;
      cancelar();
      el.scrollLeft = destino;
      liberar();
    }, DURACAO + 400);

    return () => { cancelar(); clearTimeout(t); };
  }, [selecionado]);

  // O efeito abaixo não pode depender de `selecionado`/`aoSelecionar`: eles mudam
  // a cada render, o efeito seria refeito no meio do gesto e a limpeza mataria o
  // temporizador de espera antes de ele decidir qualquer coisa.
  const ultimo = useRef({ selecionado, aoSelecionar });
  ultimo.current = { selecionado, aoSelecionar };

  useEffect(() => {
    const el = trilho.current;
    if (!el) return undefined;

    let tempo;
    const aoRolar = () => {
      clearTimeout(tempo);
      // Espera a rolagem parar: selecionar durante o movimento trocaria o filtro
      // várias vezes no meio de um único gesto.
      tempo = setTimeout(() => {
        if (ignorarRolagem.current) return;
        const centro = el.scrollLeft + el.clientWidth / 2;
        let melhor = null;
        for (const item of el.children) {
          const meio = item.offsetLeft + item.offsetWidth / 2;
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
  }, []);

  return (
    <div className="carrossel" ref={trilho} role="tablist" aria-label="Origem do gasto">
      {slides.map((s) => {
        const ativo = s.chave === selecionado;
        return (
          <button
            key={s.chave || 'todos'}
            type="button"
            role="tab"
            aria-selected={ativo}
            data-chave={s.chave}
            data-ativo={ativo ? 'sim' : 'nao'}
            className={`carrossel-item ${ativo ? 'ativo' : ''}`}
            onClick={() => aoSelecionar(s.chave)}
          >
            {s.tipo === 'cartao' && <CartaoVisual cartao={s.cartao} largura={LARGURA} />}
            {s.tipo === 'sem-cartao' && <NotaVisual formas={s.formas} largura={LARGURA} />}
            {s.tipo === 'todos' && <ResumoVisual cartoes={cartoes} largura={LARGURA} />}

            <span className="carrossel-info">
              <span className="carrossel-nome">{s.nome}</span>
              <span className="carrossel-total"><Valor v={s.total} /></span>
              <span className="carrossel-qtd">
                {s.quantidade} {s.quantidade === 1 ? 'lançamento' : 'lançamentos'}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
