import { useEffect, useState, useCallback, useRef, createContext, useContext } from 'react';
import { createPortal } from 'react-dom';
import { brl, valorEntrada } from './formato.js';

/* --------------------------- carregamento de dados ------------------------ */

/**
 * Busca dados e devolve { dados, carregando, erro, recarregar }.
 * `chaves` funciona como a lista de dependências de um efeito.
 */
export function useDados(buscar, chaves = []) {
  const [estado, setEstado] = useState({ dados: null, carregando: true, erro: null });
  const [gatilho, setGatilho] = useState(0);

  useEffect(() => {
    let vivo = true;
    setEstado((e) => ({ ...e, carregando: true, erro: null }));
    Promise.resolve()
      .then(buscar)
      .then((dados) => vivo && setEstado({ dados, carregando: false, erro: null }))
      .catch((erro) => vivo && setEstado({ dados: null, carregando: false, erro: erro.message }));
    return () => { vivo = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...chaves, gatilho]);

  return { ...estado, recarregar: useCallback(() => setGatilho((g) => g + 1), []) };
}

/**
 * Verdadeiro em telas estreitas.
 *
 * Usado só onde a estrutura muda de verdade — a lista de gastos, que é tabela
 * no desktop e cartões no celular. Layout que só reflui continua sendo tarefa
 * do CSS; isto aqui é para trocar a marcação, não o arranjo.
 */
export function useEhMobile(largura = 860) {
  const consulta = `(max-width: ${largura}px)`;
  const [ehMobile, setEhMobile] = useState(
    () => (typeof window === 'undefined' ? false : window.matchMedia(consulta).matches),
  );

  useEffect(() => {
    const mq = window.matchMedia(consulta);
    const sincronizar = () => setEhMobile(mq.matches);

    sincronizar();
    mq.addEventListener('change', sincronizar);
    // Há ambientes em que o `change` não dispara ao redimensionar e a tela fica
    // presa na marcação errada; o `resize` fecha essa brecha.
    window.addEventListener('resize', sincronizar);

    return () => {
      mq.removeEventListener('change', sincronizar);
      window.removeEventListener('resize', sincronizar);
    };
  }, [consulta]);

  return ehMobile;
}

/* --------------------------------- avisos -------------------------------- */

const ContextoAviso = createContext(() => {});
export const useAviso = () => useContext(ContextoAviso);

export function ProvedorAviso({ children }) {
  const [aviso, setAviso] = useState(null);

  const mostrar = useCallback((texto, tipo = 'ok') => {
    setAviso({ texto, tipo, id: Date.now() });
  }, []);

  useEffect(() => {
    if (!aviso) return undefined;
    const t = setTimeout(() => setAviso(null), 4200);
    return () => clearTimeout(t);
  }, [aviso]);

  return (
    <ContextoAviso.Provider value={mostrar}>
      {children}
      {aviso && (
        <div className={`aviso-flutuante ${aviso.tipo === 'erro' ? 'ruim' : ''}`} role="status">
          {aviso.texto}
        </div>
      )}
    </ContextoAviso.Provider>
  );
}

/**
 * Valor monetário de um gasto. Negativo é crédito — estorno, devolução,
 * desconto — e sai na cor de "entrou dinheiro": lido rápido, `-R$ 300,00` no
 * meio de uma coluna de despesas passa por mais um gasto.
 */
export function Valor({ v }) {
  return <span className={Number(v) < 0 ? 'credito' : undefined}>{brl(v)}</span>;
}

/* -------------------------------- formulário ------------------------------ */

export function Campo({ rotulo, dica, children }) {
  return (
    <label className="campo">
      <span>{rotulo}</span>
      {children}
      {dica && <span className="dica">{dica}</span>}
    </label>
  );
}

/**
 * Campo de valor em reais.
 *
 * Enquanto o campo está em foco o texto é o que se digitou — normalizar no meio
 * da digitação apagaria o que ainda está sendo escrito. Fora do foco ele mostra
 * sempre duas casas, o mesmo formato com que o valor aparece lido em tela.
 *
 * Aceita as duas formas: controlado (`valor` + `aoMudar`) ou não controlado
 * (`valorInicial` + `aoSair`), como no campo de encargos, que salva no blur.
 */
export function EntradaMoeda({ valor, valorInicial, aoMudar, aoSair, ...resto }) {
  const [focado, setFocado] = useState(false);
  const controlado = valor !== undefined;

  const proprios = controlado
    ? {
      value: focado ? (valor ?? '') : valorEntrada(valor),
      onChange: (e) => aoMudar(e.target.value),
    }
    : { defaultValue: valorEntrada(valorInicial) };

  return (
    <input
      type="number"
      step="0.01"
      inputMode="decimal"
      {...proprios}
      {...resto}
      onFocus={(e) => { setFocado(true); resto.onFocus?.(e); }}
      onBlur={(e) => {
        setFocado(false);
        const texto = valorEntrada(e.target.value);
        if (controlado) { if (texto !== valor) aoMudar(texto); } else e.target.value = texto;
        aoSair?.(e);
      }}
    />
  );
}

export function Modal({
  titulo, aberto, aoFechar, aoSalvar, salvando, erro, children,
  rotuloSalvar = 'Salvar', rotuloSalvando = 'Salvando…', perigo = false, salvarDesabilitado = false,
}) {
  useEffect(() => {
    if (!aberto) return undefined;
    const escutar = (e) => { if (e.key === 'Escape') aoFechar(); };
    window.addEventListener('keydown', escutar);
    return () => window.removeEventListener('keydown', escutar);
  }, [aberto, aoFechar]);

  if (!aberto) return null;

  return (
    <div className="fundo-modal" onMouseDown={(e) => e.target === e.currentTarget && aoFechar()}>
      <form
        className="modal"
        onSubmit={(e) => { e.preventDefault(); aoSalvar(); }}
      >
        <div className="modal-topo"><h2>{titulo}</h2></div>
        <div className="modal-corpo">
          {erro && <div className="erro">{erro}</div>}
          {children}
        </div>
        <div className="modal-pe">
          <button type="button" className="botao" onClick={aoFechar}>Cancelar</button>
          <button
            type="submit"
            className="botao primario"
            disabled={salvando || salvarDesabilitado}
            // Vermelho quando o botão apaga algo, igual ao da confirmação de
            // exclusão: a cor é o último aviso antes do clique.
            style={perigo ? { background: 'var(--critico)', borderColor: 'var(--critico)' } : undefined}
          >
            {salvando ? rotuloSalvando : rotuloSalvar}
          </button>
        </div>
      </form>
    </div>
  );
}

/* ---------------------------------- painel -------------------------------- */

export function Indicador({ rotulo, valor, rodape, tom }) {
  return (
    <div className="cartao indicador">
      <div className="rotulo">{rotulo}</div>
      <div className={`valor ${tom || ''}`}>{valor}</div>
      {rodape && <div className="rodape">{rodape}</div>}
    </div>
  );
}

/**
 * Barras horizontais. Cor única por padrão; passe `cores` para dar identidade
 * própria a cada barra. O valor fica sempre rotulado ao lado — é o que garante
 * a leitura mesmo quando o contraste da cor é baixo.
 */
export function Barras({ itens, cores, formatar = brl, vazio = 'Nada para mostrar.' }) {
  if (!itens || itens.length === 0) return <p className="fraco" style={{ fontSize: 13 }}>{vazio}</p>;
  const maximo = Math.max(...itens.map((i) => Math.abs(i.valor)), 1);

  return itens.map((item, i) => {
    // Um saldo negativo (estornos maiores que as compras) tem comprimento, mas
    // não é gasto. A barra vai listrada e o valor sai na cor de crédito — sem
    // isso, -R$ 300 desenharia a mesma barra cheia de +R$ 300.
    const negativo = item.valor < 0;
    return (
      <div className="barra-linha" key={item.chave ?? item.rotulo ?? i}>
        <div className="barra-rotulo">{item.rotulo}</div>
        <div className="barra-trilha">
          <div
            className={`barra-preench ${negativo ? 'negativa' : ''}`}
            style={{
              width: `${Math.max((Math.abs(item.valor) / maximo) * 100, 0.8)}%`,
              background: item.cor || (cores ? `var(--s${cores[i % cores.length]})` : 'var(--s1)'),
            }}
            title={`${item.rotulo} — ${formatar(item.valor)}`}
          />
          <span className={`barra-valor ${negativo ? 'credito' : ''}`}>
            {formatar(item.valor)}
            {item.sub && <span className="barra-sub">{item.sub}</span>}
          </span>
        </div>
      </div>
    );
  });
}

export function Medidor({ atual, total, titulo }) {
  const pct = total > 0 ? Math.min((atual / total) * 100, 100) : 0;
  return (
    <>
      <span className="medidor" title={titulo || `${atual} de ${total}`}>
        <i style={{ width: `${pct}%` }} />
      </span>
      <span className="medidor-txt">{atual}/{total}</span>
    </>
  );
}

const ALTURA_ITEM = 36;

/**
 * Menu de ações recolhido atrás dos três pontos.
 *
 * A lista é renderizada em portal com posição fixa, e não dentro da linha: as
 * tabelas vivem em um contêiner com `overflow-x: auto`, que recortaria um menu
 * posicionado ali dentro. Em troca, o menu fecha ao rolar — posição fixa não
 * acompanha a rolagem.
 */
export function MenuAcoes({ itens, rotulo = 'Ações' }) {
  const [aberto, setAberto] = useState(false);
  const [posicao, setPosicao] = useState(null);
  const gatilho = useRef(null);

  const visiveis = (itens || []).filter(Boolean);

  useEffect(() => {
    if (!aberto) return undefined;

    const fechar = () => setAberto(false);
    const aoTeclar = (e) => {
      if (e.key !== 'Escape') return;
      setAberto(false);
      gatilho.current?.focus();
    };
    const aoApontar = (e) => {
      if (gatilho.current?.contains(e.target)) return;
      if (e.target.closest?.('[data-menu-acoes]')) return;
      fechar();
    };

    document.addEventListener('mousedown', aoApontar);
    document.addEventListener('keydown', aoTeclar);
    window.addEventListener('resize', fechar);
    window.addEventListener('scroll', fechar, true);

    return () => {
      document.removeEventListener('mousedown', aoApontar);
      document.removeEventListener('keydown', aoTeclar);
      window.removeEventListener('resize', fechar);
      window.removeEventListener('scroll', fechar, true);
    };
  }, [aberto]);

  if (visiveis.length === 0) return null;

  const alternar = () => {
    if (aberto) { setAberto(false); return; }

    const r = gatilho.current.getBoundingClientRect();
    const altura = visiveis.length * ALTURA_ITEM + 10;
    const cabeAbaixo = r.bottom + 6 + altura <= window.innerHeight;
    // `position: fixed` mede a partir da viewport sem a barra de rolagem, então
    // usar innerWidth desalinharia o menu pela largura da barra.
    const largura = document.documentElement.clientWidth;

    setPosicao({
      top: cabeAbaixo ? r.bottom + 6 : Math.max(8, r.top - 6 - altura),
      right: Math.max(8, largura - r.right),
    });
    setAberto(true);
  };

  return (
    <>
      <button
        ref={gatilho}
        type="button"
        className={`menu-gatilho ${aberto ? 'ativo' : ''}`}
        onClick={alternar}
        aria-haspopup="menu"
        aria-expanded={aberto}
        aria-label={rotulo}
        title={rotulo}
      >
        ⋯
      </button>

      {aberto && posicao && createPortal(
        <div
          className="menu-lista"
          data-menu-acoes=""
          role="menu"
          style={{ top: posicao.top, right: posicao.right }}
        >
          {visiveis.map((item) => (
            <button
              key={item.texto}
              type="button"
              role="menuitem"
              className={`menu-item ${item.perigo ? 'perigo' : ''}`}
              onClick={() => { setAberto(false); item.aoClicar(); }}
            >
              {item.texto}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

export function Vazio({ titulo, children }) {
  return (
    <div className="vazio">
      <strong>{titulo}</strong>
      {children}
    </div>
  );
}

export function Estado({ carregando, erro, children }) {
  if (carregando) return <div className="vazio">Carregando…</div>;
  if (erro) return <div className="cartao"><div className="erro">{erro}</div></div>;
  return children;
}

/**
 * Par início/fim de vigência. O checkbox é o jeito de dizer "repete todo mês":
 * marcado, mes_fim fica nulo; desmarcado, ele se iguala ao mês inicial.
 */
export function CamposVigencia({ form, setForm, rotuloInicio = 'A partir de' }) {
  const recorrente = form.mes_fim === null || form.mes_fim === '' || form.mes_fim > form.mes_inicio;

  return (
    <>
      <div className="dupla">
        <Campo rotulo={rotuloInicio}>
          <input
            type="month"
            value={form.mes_inicio}
            onChange={(e) => setForm({
              ...form,
              mes_inicio: e.target.value,
              mes_fim: recorrente ? form.mes_fim : e.target.value,
            })}
          />
        </Campo>
        <Campo rotulo="Até" dica={recorrente ? 'Vazio = sem data para acabar' : 'Vale só no mês inicial'}>
          <input
            type="month"
            value={form.mes_fim || ''}
            disabled={!recorrente}
            min={form.mes_inicio}
            onChange={(e) => setForm({ ...form, mes_fim: e.target.value || null })}
          />
        </Campo>
      </div>
      <div className="linha-check">
        <input
          id="recorrente"
          type="checkbox"
          checked={recorrente}
          onChange={(e) => setForm({ ...form, mes_fim: e.target.checked ? null : form.mes_inicio })}
        />
        <label htmlFor="recorrente">Repete nos meses seguintes</label>
      </div>
    </>
  );
}

/**
 * Estado de formulário + salvar + excluir para as telas de cadastro simples.
 * Evita repetir o mesmo vaivém de modal em cada página.
 */
export function useCrud({ recurso: r, recarregar, nome, genero = 'm', aviso, confirmar, aoPreparar }) {
  const [form, setForm] = useState(null);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState(null);
  const fim = genero === 'f' ? 'a' : 'o';

  const abrir = (dados) => { setErro(null); setForm(aoPreparar ? aoPreparar(dados) : dados); };
  const fechar = () => setForm(null);

  const salvar = async () => {
    setSalvando(true);
    setErro(null);
    try {
      if (form.id) await r.atualizar(form.id, form);
      else await r.criar(form);
      setForm(null);
      recarregar();
      aviso(form.id ? `${nome} atualizad${fim}.` : `${nome} cadastrad${fim}.`);
    } catch (e) {
      setErro(e.message);
    } finally {
      setSalvando(false);
    }
  };

  const excluir = (item, mensagem) => confirmar(mensagem, async () => {
    try {
      await r.remover(item.id);
      recarregar();
      aviso(`${nome} excluíd${fim}.`);
    } catch (e) {
      aviso(e.message, 'erro');
    }
  });

  return { form, setForm, abrir, fechar, salvar, excluir, salvando, erro };
}

/** Confirmação para ações destrutivas — nada é apagado sem passar por aqui. */
export function useConfirmacao() {
  const [pedido, setPedido] = useState(null);

  const confirmar = useCallback((mensagem, aoConfirmar) => setPedido({ mensagem, aoConfirmar }), []);

  const elemento = pedido && (
    <div className="fundo-modal" onMouseDown={(e) => e.target === e.currentTarget && setPedido(null)}>
      <div className="modal" style={{ width: 'min(430px, 100%)' }}>
        <div className="modal-topo"><h2>Confirmar exclusão</h2></div>
        <div className="modal-corpo"><p style={{ margin: 0, fontSize: 14 }}>{pedido.mensagem}</p></div>
        <div className="modal-pe">
          <button type="button" className="botao" onClick={() => setPedido(null)}>Cancelar</button>
          <button
            type="button"
            className="botao primario"
            style={{ background: 'var(--critico)', borderColor: 'var(--critico)' }}
            onClick={() => { pedido.aoConfirmar(); setPedido(null); }}
          >
            Excluir
          </button>
        </div>
      </div>
    </div>
  );

  return { confirmar, elemento };
}
