import CartaoVisual, { corDeMarca } from './CartaoVisual.jsx';
import NotaVisual from './NotaVisual.jsx';
import { useCarrossel } from './carrossel.js';
import { Valor } from './componentes.jsx';

const LARGURA = 232;

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
  // Traz o slide escolhido para o centro — inclusive quando a escolha veio de
  // fora do carrossel (o link "Ver gastos" da tela de Cartões, por exemplo).
  const trilho = useCarrossel({ selecionado, aoSelecionar });

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
