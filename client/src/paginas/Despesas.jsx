import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, recurso } from '../api.js';
import { useMes } from '../App.jsx';
import { brl, rotuloMes, situacaoParcelamento, somarMeses } from '../formato.js';
import { useCadastros, opcoesCartao, opcoesCategoria, opcoesPessoa } from '../cadastros.js';
import {
  Campo, EntradaMoeda, Modal, useAviso, useConfirmacao, useDados,
} from '../componentes.jsx';
import ListaGastos from './ListaGastos.jsx';
import { FORMAS } from '../NotaVisual.jsx';

const lancamentos = recurso('lancamentos');
const parcelamentos = recurso('parcelamentos');

/**
 * Um formulário só para os dois tipos de gasto.
 *
 * `parcelado` é a chave: ele decide para qual tabela o registro vai (lançamento
 * avulso ou parcelamento) e qual bloco de campos aparece. Fora desse bloco, os
 * campos são os mesmos nos dois casos e ficam sempre no mesmo lugar — o que muda
 * de um tipo para o outro é só o que é específico de parcela.
 */
const vazio = (mes) => ({
  parcelado: false,
  mes,
  data: '',
  cartao_id: '',
  forma: '',
  categoria_id: '',
  pessoa_id: '',
  descricao: '',
  valor: '',
  observacao: '',
  // Só usados quando `parcelado`.
  parcelas: '',
  mes_inicio: mes,
});

/** Linha da tabela `parcelamentos` no formato do formulário unificado. */
const deParcelamento = (p) => ({
  parcelado: true,
  id: p.id,
  mes: p.mes_inicio,
  mes_inicio: p.mes_inicio,
  parcelas: p.parcelas,
  data: p.data_compra || '',
  cartao_id: p.cartao_id || '',
  forma: '',
  categoria_id: p.categoria_id || '',
  pessoa_id: p.pessoa_id || '',
  descricao: p.descricao,
  valor: p.valor_parcela,
  observacao: p.observacao || '',
});

/** O inverso: o que o formulário manda para cada recurso. */
const corpoDe = (form) => (form.parcelado
  ? {
    cartao_id: form.cartao_id || null,
    categoria_id: form.categoria_id || null,
    pessoa_id: form.pessoa_id || null,
    descricao: form.descricao,
    valor_parcela: form.valor,
    parcelas: form.parcelas,
    mes_inicio: form.mes_inicio,
    data_compra: form.data || null,
    observacao: form.observacao || null,
  }
  : {
    mes: form.mes,
    data: form.data || null,
    cartao_id: form.cartao_id || null,
    forma: form.forma || null,
    categoria_id: form.categoria_id || null,
    pessoa_id: form.pessoa_id || null,
    descricao: form.descricao,
    valor: form.valor,
    observacao: form.observacao || null,
  });

export default function Despesas() {
  const { mes } = useMes();
  const aviso = useAviso();
  const { confirmar, elemento: dialogo } = useConfirmacao();
  const cadastros = useCadastros();

  // A tela de Cartões manda para cá com ?cartao=N, e o chip escolhido volta
  // para a URL. Os dois lados andam juntos: dá para chegar por link, trocar de
  // cartão livremente e recarregar a página sem perder a seleção.
  const [parametros, definirParametros] = useSearchParams();
  const cartaoDaUrl = parametros.get('cartao');

  const [filtros, setFiltros] = useState({
    q: '', cartao: cartaoDaUrl || '', categoria: '', origem: '',
  });

  useEffect(() => {
    if (cartaoDaUrl !== null) setFiltros((f) => ({ ...f, cartao: cartaoDaUrl }));
  }, [cartaoDaUrl]);

  useEffect(() => {
    // A guarda de igualdade é o que impede os dois efeitos de se alimentarem.
    if (filtros.cartao === (cartaoDaUrl || '')) return;
    const novos = new URLSearchParams(parametros);
    if (filtros.cartao) novos.set('cartao', filtros.cartao);
    else novos.delete('cartao');
    definirParametros(novos, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtros.cartao]);
  const [form, setForm] = useState(null);
  const [salvando, setSalvando] = useState(false);
  const [erroForm, setErroForm] = useState(null);

  const consulta = useDados(
    () => api.get('/despesas', { mes, ...filtros }),
    [mes, filtros.q, filtros.cartao, filtros.categoria, filtros.origem],
  );

  // O carrossel mostra o total de cada origem ao mesmo tempo, então precisa do
  // consolidado do mês inteiro — a consulta acima só traz o que passou no filtro.
  const resumo = useDados(() => api.get('/resumo', { mes }), [mes]);

  // As compras parceladas inteiras, para o bloco das que não caem neste mês —
  // uma que só começa depois, ou que já terminou, não aparece na lista acima e
  // sem isso não haveria como chegar nela.
  const compras = useDados(() => api.get('/parcelamentos'), []);

  const recarregarTudo = () => {
    consulta.recarregar();
    resumo.recarregar();
    compras.recarregar();
  };

  const abrirNovo = () => { setErroForm(null); setForm(vazio(mes)); };

  const abrirEdicao = async (item) => {
    setErroForm(null);
    if (item.origem === 'parcelamento') {
      setForm(deParcelamento(await api.get(`/parcelamentos/${item.ref_id}`)));
      return;
    }
    const linha = await api.get(`/lancamentos/${item.ref_id}`);
    setForm({
      ...vazio(mes),
      ...linha,
      parcelado: false,
      data: linha.data || '',
      cartao_id: linha.cartao_id || '',
      forma: linha.forma || '',
      categoria_id: linha.categoria_id || '',
      pessoa_id: linha.pessoa_id || '',
      observacao: linha.observacao || '',
    });
  };

  const salvar = async () => {
    setSalvando(true);
    setErroForm(null);
    try {
      const recursoAlvo = form.parcelado ? parcelamentos : lancamentos;
      const corpo = corpoDe(form);
      if (form.id) await recursoAlvo.atualizar(form.id, corpo);
      else await recursoAlvo.criar(corpo);
      setForm(null);
      recarregarTudo();
      const fim = form.parcelado ? 'a' : 'o';
      aviso(form.parcelado
        ? `Compra parcelada ${form.id ? 'atualizad' : 'cadastrad'}${fim}.`
        : `Lançamento ${form.id ? 'atualizad' : 'adicionad'}${fim}.`);
    } catch (e) {
      setErroForm(e.message);
    } finally {
      setSalvando(false);
    }
  };

  const excluir = (item) => {
    const parcelado = item.origem === 'parcelamento';
    const pergunta = parcelado
      ? `Excluir "${item.descricao}"? Todas as parcelas somem de todos os meses.`
      : `Excluir "${item.descricao}" de ${brl(item.valor)}? Essa ação não pode ser desfeita.`;

    return confirmar(pergunta, async () => {
      try {
        await (parcelado ? parcelamentos : lancamentos).remover(item.ref_id);
        recarregarTudo();
        aviso(parcelado ? 'Compra parcelada excluída.' : 'Lançamento excluído.');
      } catch (e) {
        aviso(e.message, 'erro');
      }
    });
  };

  /** Antecipa a quitação: a parcela deste mês passa a ser a última. */
  const quitar = async (item) => {
    try {
      const r = await api.post(`/despesas/parcelamentos/${item.ref_id}/quitar`, { mes });
      recarregarTudo();
      aviso(`Quitado: a última parcela passou a ser ${rotuloMes(r.ultima_parcela, { curto: true })}.`);
    } catch (e) {
      aviso(e.message, 'erro');
    }
  };

  const c = cadastros.dados;
  const nenhumCartao = c && c.cartoes.filter((x) => x.ativo).length === 0;

  // Compras parceladas que existem, mas não têm parcela neste mês.
  const foraDoMes = (compras.dados || [])
    .map((p) => ({
      ...p, ...situacaoParcelamento(p, mes), origem: 'parcelamento', ref_id: p.id,
    }))
    .filter((p) => p.estado !== 'ativo');

  return (
    <>
      <div className="filtros" style={{ marginBottom: 12 }}>
        <span style={{ flex: 1 }} />
        <button type="button" className="botao primario" onClick={abrirNovo}>
          + Novo gasto
        </button>
      </div>

      {nenhumCartao && (
        <div className="aviso" style={{ marginBottom: 16 }}>
          <b>Nenhum cartão cadastrado.</b> Dá para lançar gastos por Pix, transferência ou
          dinheiro mesmo assim — se quiser registrar faturas ou compras parceladas, cadastre um
          cartão em <Link to="/cartoes" style={{ color: 'var(--s1)' }}>Cartões</Link>.
        </div>
      )}

      {consulta.erro && <div className="cartao"><div className="erro">{consulta.erro}</div></div>}
      {!consulta.dados && consulta.carregando && <div className="vazio">Carregando…</div>}

      {/* Renderiza assim que houver dados e não some enquanto recarrega: com o
          antigo `Estado` a lista inteira desmontava a cada troca de filtro, o
          carrossel remontava e perdia posição e rolagem no meio do gesto. */}
      {consulta.dados && (
        <ListaGastos
          itens={consulta.dados.itens}
          mes={mes}
          cartoes={(c?.cartoes || []).filter((x) => x.ativo)}
          categorias={c?.categorias || []}
          resumo={resumo.dados}
          filtros={filtros}
          setFiltros={setFiltros}
          foraDoMes={foraDoMes}
          aoEditar={abrirEdicao}
          aoExcluir={excluir}
          aoQuitar={quitar}
        />
      )}

      <Modal
        aberto={Boolean(form)}
        titulo={tituloDo(form)}
        aoFechar={() => setForm(null)}
        aoSalvar={salvar}
        salvando={salvando}
        erro={erroForm}
      >
        {form && (
          <FormularioGasto form={form} setForm={setForm} cadastros={c} />
        )}
      </Modal>

      {dialogo}
    </>
  );
}

function tituloDo(form) {
  if (!form?.id) return 'Novo gasto';
  return form.parcelado ? 'Editar compra parcelada' : 'Editar gasto';
}

/**
 * Formulário único de gasto.
 *
 * O tipo fica no topo porque é ele que reconfigura o resto: em "parcelado" o
 * bloco reservado às parcelas aparece, o valor passa a ser o da parcela e o mês
 * da fatura dá lugar ao mês da primeira parcela — que é de onde o app calcula
 * todas as outras. Fora isso o formulário é o mesmo, na mesma ordem, para quem
 * lança não ter que reaprender a tela a cada tipo.
 */
function FormularioGasto({ form, setForm, cadastros: c }) {
  const p = form.parcelado;

  const trocarTipo = (parcelado) => setForm({
    ...form,
    parcelado,
    // Parcelamento é sempre de cartão: não há parcela em Pix ou dinheiro.
    forma: parcelado ? '' : form.forma,
    mes_inicio: form.mes_inicio || form.mes,
    parcelas: parcelado ? form.parcelas : '',
  });

  return (
    <>
      <div className="campo">
        <span>Tipo do gasto</span>
        {form.id ? (
          <div className="chips seletor-tipo">
            <span className={`chip ativo ${p ? 'parcelado' : ''}`}>{p ? 'Parcelado' : 'À vista'}</span>
          </div>
        ) : (
          <div className="chips seletor-tipo" role="group" aria-label="Tipo do gasto">
            <button
              type="button"
              className={`chip ${p ? '' : 'ativo'}`}
              aria-pressed={!p}
              onClick={() => trocarTipo(false)}
            >
              À vista
            </button>
            <button
              type="button"
              className={`chip ${p ? 'ativo parcelado' : ''}`}
              aria-pressed={p}
              onClick={() => trocarTipo(true)}
            >
              Parcelado
            </button>
          </div>
        )}
        <span className="dica">
          {form.id
            ? 'O tipo não muda depois de salvo — para trocar, exclua e cadastre de novo.'
            : 'Parcelado se cadastra uma vez só: a parcela aparece sozinha em cada mês.'}
        </span>
      </div>

      <Campo rotulo="Descrição">
        <input
          autoFocus
          value={form.descricao}
          onChange={(e) => setForm({ ...form, descricao: e.target.value })}
          placeholder={p ? 'Notebook, geladeira, passagem…' : 'Mercado do mês, farmácia, jantar…'}
        />
      </Campo>

      <div className="dupla">
        <Campo
          rotulo={p ? 'Valor da parcela (R$)' : 'Valor (R$)'}
          dica={p ? 'O que cai por mês na fatura' : 'Negativo para estorno ou devolução'}
        >
          <EntradaMoeda
            valor={form.valor}
            aoMudar={(v) => setForm({ ...form, valor: v })}
          />
        </Campo>
        <Campo
          rotulo="Pago com"
          dica={p ? 'Compra parcelada é sempre de cartão' : 'Cartão, ou o dinheiro saiu direto do bolso'}
        >
          <select
            value={form.cartao_id ? `c${form.cartao_id}` : (form.forma ? `f${form.forma}` : '')}
            onChange={(e) => {
              const v = e.target.value;
              if (v.startsWith('c')) setForm({ ...form, cartao_id: v.slice(1), forma: '' });
              else if (v.startsWith('f')) setForm({ ...form, cartao_id: '', forma: v.slice(1) });
              else setForm({ ...form, cartao_id: '', forma: '' });
            }}
          >
            <option value="">Selecione…</option>
            {p ? (
              opcoesCartao(c?.cartoes).map((o) => (
                <option key={o.valor} value={`c${o.valor}`}>{o.texto}</option>
              ))
            ) : (
              <>
                <optgroup label="Cartões">
                  {opcoesCartao(c?.cartoes).map((o) => (
                    <option key={o.valor} value={`c${o.valor}`}>{o.texto}</option>
                  ))}
                </optgroup>
                <optgroup label="Sem cartão">
                  {FORMAS.map((f) => <option key={f} value={`f${f}`}>{f}</option>)}
                </optgroup>
              </>
            )}
          </select>
        </Campo>
      </div>

      {/* Espaço reservado ao que só existe em compra parcelada. Fora dela, some
          inteiro — não fica campo desabilitado ocupando lugar. */}
      {p && (
        <div className="bloco-parcelado">
          <div className="dupla">
            <Campo rotulo="Número de parcelas">
              <input
                type="number"
                min="1"
                value={form.parcelas}
                onChange={(e) => setForm({ ...form, parcelas: e.target.value })}
              />
            </Campo>
            <Campo rotulo="Mês da 1ª parcela" dica="A partir dele o app calcula todas as outras">
              <input
                type="month"
                value={form.mes_inicio}
                onChange={(e) => setForm({ ...form, mes_inicio: e.target.value })}
              />
            </Campo>
          </div>
          {form.valor && form.parcelas > 0 && (
            <div className="aviso">
              Total da compra: <b>{brl(Number(form.valor) * Number(form.parcelas))}</b> ·
              última parcela em <b>{rotuloMes(somarMeses(form.mes_inicio, Number(form.parcelas) - 1))}</b>.
            </div>
          )}
        </div>
      )}

      <div className={p ? undefined : 'dupla'}>
        {!p && (
          <Campo rotulo="Mês da fatura">
            <input type="month" value={form.mes} onChange={(e) => setForm({ ...form, mes: e.target.value })} />
          </Campo>
        )}
        <Campo rotulo="Data da compra" dica="Opcional">
          <input type="date" value={form.data} onChange={(e) => setForm({ ...form, data: e.target.value })} />
        </Campo>
      </div>

      <div className="dupla">
        <Campo rotulo="Categoria" dica="Opcional">
          <select value={form.categoria_id} onChange={(e) => setForm({ ...form, categoria_id: e.target.value })}>
            <option value="">Sem categoria</option>
            {opcoesCategoria(c?.categorias).map((o) => <option key={o.valor} value={o.valor}>{o.texto}</option>)}
          </select>
        </Campo>
        <Campo rotulo="De quem é o gasto" dica="Vira reembolso na renda">
          <select value={form.pessoa_id} onChange={(e) => setForm({ ...form, pessoa_id: e.target.value })}>
            <option value="">Meu</option>
            {opcoesPessoa(c?.pessoas).map((o) => <option key={o.valor} value={o.valor}>{o.texto}</option>)}
          </select>
        </Campo>
      </div>

      <Campo rotulo="Observação" dica="Opcional">
        <input
          value={form.observacao}
          onChange={(e) => setForm({ ...form, observacao: e.target.value })}
        />
      </Campo>
    </>
  );
}
