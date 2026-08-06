import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, recurso } from '../api.js';
import { useMes } from '../App.jsx';
import { brl } from '../formato.js';
import { useCadastros, opcoesCartao, opcoesCategoria, opcoesPessoa } from '../cadastros.js';
import {
  Campo, EntradaMoeda, Modal, useAviso, useConfirmacao, useDados,
} from '../componentes.jsx';
import ListaGastos from './ListaGastos.jsx';
import { FORMAS } from '../NotaVisual.jsx';

const lancamentos = recurso('lancamentos');

const vazio = (mes) => ({
  mes, data: '', cartao_id: '', forma: '', categoria_id: '', pessoa_id: '', descricao: '', valor: '', observacao: '',
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

  const abrirNovo = () => { setErroForm(null); setForm(vazio(mes)); };

  const abrirEdicao = async (item) => {
    setErroForm(null);
    const linha = await api.get(`/lancamentos/${item.ref_id}`);
    setForm({
      ...linha,
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
      const corpo = {
        ...form,
        cartao_id: form.cartao_id || null,
        forma: form.forma || null,
        categoria_id: form.categoria_id || null,
        pessoa_id: form.pessoa_id || null,
        data: form.data || null,
      };
      if (form.id) await lancamentos.atualizar(form.id, corpo);
      else await lancamentos.criar(corpo);
      setForm(null);
      consulta.recarregar();
      resumo.recarregar();
      aviso(form.id ? 'Lançamento atualizado.' : 'Lançamento adicionado.');
    } catch (e) {
      setErroForm(e.message);
    } finally {
      setSalvando(false);
    }
  };

  const excluir = (item) => confirmar(
    `Excluir "${item.descricao}" de ${brl(item.valor)}? Essa ação não pode ser desfeita.`,
    async () => {
      try {
        await lancamentos.remover(item.ref_id);
        consulta.recarregar();
        resumo.recarregar();
        aviso('Lançamento excluído.');
      } catch (e) {
        aviso(e.message, 'erro');
      }
    },
  );

  const c = cadastros.dados;
  const nenhumCartao = c && c.cartoes.filter((x) => x.ativo).length === 0;

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
          dinheiro mesmo assim — se quiser registrar faturas, cadastre um cartão em{' '}
          <Link to="/cartoes" style={{ color: 'var(--s1)' }}>Cartões</Link>.
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
          aoEditar={abrirEdicao}
          aoExcluir={excluir}
        />
      )}

      <Modal
        aberto={Boolean(form)}
        titulo={form?.id ? 'Editar gasto' : 'Novo gasto'}
        aoFechar={() => setForm(null)}
        aoSalvar={salvar}
        salvando={salvando}
        erro={erroForm}
      >
        {form && (
          <>
            <Campo rotulo="Descrição">
              <input
                autoFocus
                value={form.descricao}
                onChange={(e) => setForm({ ...form, descricao: e.target.value })}
                placeholder="Mercado do mês, farmácia, jantar…"
              />
            </Campo>
            <div className="dupla">
              <Campo rotulo="Valor (R$)" dica="Negativo para estorno ou devolução">
                <EntradaMoeda
                  valor={form.valor}
                  aoMudar={(v) => setForm({ ...form, valor: v })}
                />
              </Campo>
              <Campo rotulo="Mês da fatura">
                <input type="month" value={form.mes} onChange={(e) => setForm({ ...form, mes: e.target.value })} />
              </Campo>
            </div>
            <div className="dupla">
              <Campo rotulo="Pago com" dica="Cartão, ou o dinheiro saiu direto do bolso">
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
                  <optgroup label="Cartões">
                    {opcoesCartao(c?.cartoes).map((o) => (
                      <option key={o.valor} value={`c${o.valor}`}>{o.texto}</option>
                    ))}
                  </optgroup>
                  <optgroup label="Sem cartão">
                    {FORMAS.map((f) => <option key={f} value={`f${f}`}>{f}</option>)}
                  </optgroup>
                </select>
              </Campo>
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
        )}
      </Modal>

      {dialogo}
    </>
  );
}
