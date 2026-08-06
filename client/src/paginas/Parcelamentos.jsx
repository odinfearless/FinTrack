import { useState } from 'react';
import { api, recurso } from '../api.js';
import { useMes } from '../App.jsx';
import { brl, rotuloMes, somarMeses } from '../formato.js';
import { useCadastros, opcoesCartao, opcoesCategoria, opcoesPessoa } from '../cadastros.js';
import {
  Campo, EntradaMoeda, Estado, Medidor, MenuAcoes, Modal, useAviso, useConfirmacao, useDados,
  Valor, Vazio,
} from '../componentes.jsx';
import { corDeMarca } from '../CartaoVisual.jsx';

const parcelamentos = recurso('parcelamentos');

const vazio = (mes) => ({
  cartao_id: '', categoria_id: '', pessoa_id: '', descricao: '',
  valor_parcela: '', parcelas: '', mes_inicio: mes, data_compra: '', observacao: '',
});

/** Situação da compra em relação ao mês que está sendo olhado. */
function situacao(p, mes) {
  const [a1, m1] = p.mes_inicio.split('-').map(Number);
  const [a2, m2] = mes.split('-').map(Number);
  const indice = (a2 * 12 + m2) - (a1 * 12 + m1);
  if (indice < 0) return { estado: 'futuro', parcela: 0 };
  if (indice >= p.parcelas) return { estado: 'quitado', parcela: p.parcelas };
  return { estado: 'ativo', parcela: indice + 1 };
}

export default function Parcelamentos() {
  const { mes } = useMes();
  const aviso = useAviso();
  const { confirmar, elemento: dialogo } = useConfirmacao();
  const cadastros = useCadastros();

  const [form, setForm] = useState(null);
  const [salvando, setSalvando] = useState(false);
  const [erroForm, setErroForm] = useState(null);
  const [mostrarQuitados, setMostrarQuitados] = useState(false);

  const consulta = useDados(() => api.get('/parcelamentos'), []);

  const salvar = async () => {
    setSalvando(true);
    setErroForm(null);
    try {
      const corpo = {
        ...form,
        categoria_id: form.categoria_id || null,
        pessoa_id: form.pessoa_id || null,
        data_compra: form.data_compra || null,
      };
      if (form.id) await parcelamentos.atualizar(form.id, corpo);
      else await parcelamentos.criar(corpo);
      setForm(null);
      consulta.recarregar();
      aviso(form.id ? 'Parcelamento atualizado.' : 'Parcelamento cadastrado.');
    } catch (e) {
      setErroForm(e.message);
    } finally {
      setSalvando(false);
    }
  };

  const excluir = (p) => confirmar(
    `Excluir "${p.descricao}"? Todas as parcelas somem de todos os meses.`,
    async () => {
      try {
        await parcelamentos.remover(p.id);
        consulta.recarregar();
        aviso('Parcelamento excluído.');
      } catch (e) {
        aviso(e.message, 'erro');
      }
    },
  );

  const quitar = async (p) => {
    try {
      const r = await api.post(`/despesas/parcelamentos/${p.id}/quitar`, { mes });
      consulta.recarregar();
      aviso(`Quitado: a última parcela passou a ser ${rotuloMes(r.ultima_parcela, { curto: true })}.`);
    } catch (e) {
      aviso(e.message, 'erro');
    }
  };

  const c = cadastros.dados;
  const todos = consulta.dados || [];
  const comSituacao = todos.map((p) => ({ ...p, ...situacao(p, mes) }));
  const visiveis = mostrarQuitados ? comSituacao : comSituacao.filter((p) => p.estado !== 'quitado');

  const noMes = comSituacao.filter((p) => p.estado === 'ativo');
  const totalMes = noMes.reduce((t, p) => t + p.valor_parcela, 0);
  const totalFuturo = noMes.reduce((t, p) => t + (p.parcelas - p.parcela) * p.valor_parcela, 0);

  return (
    <>
      <div className="filtros">
        <div className="linha-check">
          <input
            id="quitados"
            type="checkbox"
            checked={mostrarQuitados}
            onChange={(e) => setMostrarQuitados(e.target.checked)}
          />
          <label htmlFor="quitados">Mostrar também os já quitados</label>
        </div>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="botao primario"
          onClick={() => { setErroForm(null); setForm(vazio(mes)); }}
          disabled={!c || opcoesCartao(c.cartoes).length === 0}
        >
          + Nova compra parcelada
        </button>
      </div>

      <div className="aviso" style={{ marginBottom: 18 }}>
        <b>Cadastre uma vez só.</b> A parcela do mês é calculada a partir da primeira parcela e do
        total — em {rotuloMes(mes)} são <b>{noMes.length} parcelamentos</b> somando{' '}
        <b>{brl(totalMes)}</b>, com <b>{brl(totalFuturo)}</b> ainda a vencer depois deste mês.
      </div>

      <Estado carregando={consulta.carregando} erro={consulta.erro}>
        <div className="cartao">
          {visiveis.length === 0 ? (
            <Vazio titulo="Nenhum parcelamento em andamento">
              Compras parceladas cadastradas aqui aparecem sozinhas na fatura de cada mês.
            </Vazio>
          ) : (
            <div className="rolagem">
              <table>
                <thead>
                  <tr>
                    <th>Compra</th>
                    <th>Cartão</th>
                    <th className="num">Parcela</th>
                    <th>Andamento</th>
                    <th>Período</th>
                    <th className="num">A vencer</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {visiveis.map((p) => {
                    const restantes = Math.max(p.parcelas - p.parcela, 0);
                    return (
                      <tr key={p.id}>
                        <td>
                          {p.descricao}
                          {p.pessoa && <span className="etiqueta" style={{ marginLeft: 8 }}>{p.pessoa}</span>}
                          {p.estado === 'quitado' && <span className="etiqueta" style={{ marginLeft: 8 }}>quitado</span>}
                          {p.estado === 'futuro' && <span className="etiqueta" style={{ marginLeft: 8 }}>começa depois</span>}
                        </td>
                        <td>
                          <span className="etiqueta">
                            <i className="ponto" style={{ background: corDeMarca(p.cartao_cor) }} />{p.cartao}
                          </span>
                        </td>
                        <td className="num"><Valor v={p.valor_parcela} /></td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <Medidor atual={p.parcela} total={p.parcelas} />
                        </td>
                        <td className="fraco" style={{ whiteSpace: 'nowrap' }}>
                          {rotuloMes(p.mes_inicio, { curto: true })} →{' '}
                          {rotuloMes(somarMeses(p.mes_inicio, p.parcelas - 1), { curto: true })}
                        </td>
                        <td className="num">
                          {restantes > 0
                            ? <Valor v={restantes * p.valor_parcela} />
                            : <span className="fraco">—</span>}
                        </td>
                        <td>
                          <div className="acoes">
                            <MenuAcoes itens={[
                              p.estado === 'ativo' && restantes > 0 && {
                                texto: 'Quitar neste mês',
                                aoClicar: () => quitar(p),
                              },
                              {
                                texto: 'Editar',
                                aoClicar: () => {
                                  setErroForm(null);
                                  setForm({
                                    ...p,
                                    categoria_id: p.categoria_id || '',
                                    pessoa_id: p.pessoa_id || '',
                                    data_compra: p.data_compra || '',
                                    observacao: p.observacao || '',
                                  });
                                },
                              },
                              { texto: 'Excluir', perigo: true, aoClicar: () => excluir(p) },
                            ]}
                            />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Estado>

      <Modal
        aberto={Boolean(form)}
        titulo={form?.id ? 'Editar parcelamento' : 'Nova compra parcelada'}
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
                placeholder="Notebook, geladeira, passagem…"
              />
            </Campo>
            <div className="dupla">
              <Campo rotulo="Valor da parcela (R$)">
                <EntradaMoeda
                  valor={form.valor_parcela}
                  aoMudar={(v) => setForm({ ...form, valor_parcela: v })}
                />
              </Campo>
              <Campo rotulo="Número de parcelas">
                <input
                  type="number"
                  min="1"
                  value={form.parcelas}
                  onChange={(e) => setForm({ ...form, parcelas: e.target.value })}
                />
              </Campo>
            </div>
            <div className="dupla">
              <Campo rotulo="Mês da 1ª parcela" dica="A partir dele o app calcula todas as outras">
                <input
                  type="month"
                  value={form.mes_inicio}
                  onChange={(e) => setForm({ ...form, mes_inicio: e.target.value })}
                />
              </Campo>
              <Campo rotulo="Cartão">
                <select value={form.cartao_id} onChange={(e) => setForm({ ...form, cartao_id: e.target.value })}>
                  <option value="">Selecione…</option>
                  {opcoesCartao(c?.cartoes).map((o) => <option key={o.valor} value={o.valor}>{o.texto}</option>)}
                </select>
              </Campo>
            </div>
            <div className="dupla">
              <Campo rotulo="Categoria" dica="Opcional">
                <select value={form.categoria_id} onChange={(e) => setForm({ ...form, categoria_id: e.target.value })}>
                  <option value="">Sem categoria</option>
                  {opcoesCategoria(c?.categorias).map((o) => <option key={o.valor} value={o.valor}>{o.texto}</option>)}
                </select>
              </Campo>
              <Campo rotulo="De quem é o gasto">
                <select value={form.pessoa_id} onChange={(e) => setForm({ ...form, pessoa_id: e.target.value })}>
                  <option value="">Meu</option>
                  {opcoesPessoa(c?.pessoas).map((o) => <option key={o.valor} value={o.valor}>{o.texto}</option>)}
                </select>
              </Campo>
            </div>
            {form.valor_parcela && form.parcelas > 0 && (
              <div className="aviso">
                Total da compra: <b>{brl(Number(form.valor_parcela) * Number(form.parcelas))}</b> ·
                última parcela em <b>{rotuloMes(somarMeses(form.mes_inicio, Number(form.parcelas) - 1))}</b>.
              </div>
            )}
          </>
        )}
      </Modal>

      {dialogo}
    </>
  );
}
