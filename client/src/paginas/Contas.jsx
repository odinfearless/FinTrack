import { useState } from 'react';
import { api, recurso } from '../api.js';
import { useMes } from '../App.jsx';
import { brl, rotuloMes, vigencia } from '../formato.js';
import { useCadastros, opcoesCategoria } from '../cadastros.js';
import {
  Campo, CamposVigencia, EntradaMoeda, Estado, MenuAcoes, Modal, useAviso, useConfirmacao, useCrud,
  useDados, Valor, Vazio,
} from '../componentes.jsx';
import ModalLimpezaVigencia from '../LimpezaVigencia.jsx';

const contas = recurso('contas');

const FORMAS = ['D.AUTO', 'Boleto', 'Pix', 'Débito', 'Dinheiro'];

const vazio = (mes) => ({
  descricao: '', valor: '', forma: 'D.AUTO', categoria_id: '',
  dia_vencimento: '', mes_inicio: mes, mes_fim: null,
});

const ativaEm = (c, mes) => c.mes_inicio <= mes && (!c.mes_fim || c.mes_fim >= mes);

export default function Contas() {
  const { mes } = useMes();
  const aviso = useAviso();
  const { confirmar, elemento: dialogo } = useConfirmacao();
  const cadastros = useCadastros();
  const consulta = useDados(() => api.get('/contas'), []);
  const contasBancarias = useDados(() => api.get('/contas-bancarias'), []);
  const [limpando, setLimpando] = useState(false);

  const crud = useCrud({
    recurso: contas,
    recarregar: consulta.recarregar,
    nome: 'Conta',
    genero: 'f',
    aviso,
    confirmar,
    aoPreparar: (c) => ({
      ...c,
      categoria_id: c.categoria_id || '',
      dia_vencimento: c.dia_vencimento || '',
    }),
  });

  const lista = consulta.dados || [];
  const doMes = lista.filter((c) => ativaEm(c, mes));
  const total = doMes.reduce((t, c) => t + c.valor, 0);

  return (
    <>
      <div className="filtros">
        <span style={{ flex: 1 }} />
        {lista.length > 0 && (
          <button type="button" className="botao" onClick={() => setLimpando(true)}>
            Limpar contas
          </button>
        )}
        <button type="button" className="botao primario" onClick={() => crud.abrir(vazio(mes))}>
          + Nova conta
        </button>
      </div>

      <div className="aviso" style={{ marginBottom: 18 }}>
        <b>Contas fora do cartão</b> — luz, água, aluguel, débitos automáticos. Em {rotuloMes(mes)} são{' '}
        <b>{doMes.length} contas</b> somando <b>{brl(total)}</b>.
      </div>

      <Estado carregando={consulta.carregando} erro={consulta.erro}>
        <div className="cartao">
          {lista.length === 0 ? (
            <Vazio titulo="Nenhuma conta cadastrada">
              Cadastre uma vez e marque "repete nos meses seguintes": ela aparece sozinha todo mês.
            </Vazio>
          ) : (
            <div className="rolagem">
              <table>
                <thead>
                  <tr>
                    <th>Conta</th>
                    <th>Forma</th>
                    <th>Categoria</th>
                    <th className="num">Vence dia</th>
                    <th>Vigência</th>
                    <th className="num">Valor</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {lista.map((c) => {
                    const ativa = ativaEm(c, mes);
                    return (
                      <tr key={c.id} style={ativa ? undefined : { opacity: 0.55 }}>
                        <td>
                          {c.descricao}
                          {!ativa && <span className="etiqueta" style={{ marginLeft: 8 }}>fora do mês</span>}
                          {c.conta_bancaria && (
                            <div className="fraco" style={{ fontSize: 12.5 }}>debitada em {c.conta_bancaria}</div>
                          )}
                        </td>
                        <td><span className="etiqueta">{c.forma}</span></td>
                        <td>{c.categoria || <span className="fraco">—</span>}</td>
                        <td className="num fraco">{c.dia_vencimento || '—'}</td>
                        <td className="fraco" style={{ whiteSpace: 'nowrap' }}>{vigencia(c.mes_inicio, c.mes_fim)}</td>
                        <td className="num"><Valor v={c.valor} /></td>
                        <td>
                          <div className="acoes">
                            <MenuAcoes itens={[
                              { texto: 'Editar', aoClicar: () => crud.abrir(c) },
                              {
                                texto: 'Excluir',
                                perigo: true,
                                aoClicar: () => crud.excluir(c, `Excluir a conta "${c.descricao}"? Ela some de todos os meses.`),
                              },
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
        aberto={Boolean(crud.form)}
        titulo={crud.form?.id ? 'Editar conta' : 'Nova conta'}
        aoFechar={crud.fechar}
        aoSalvar={crud.salvar}
        salvando={crud.salvando}
        erro={crud.erro}
      >
        {crud.form && (
          <>
            <Campo rotulo="Descrição">
              <input
                autoFocus
                value={crud.form.descricao}
                onChange={(e) => crud.setForm({ ...crud.form, descricao: e.target.value })}
                placeholder="Luz, água, aluguel, internet…"
              />
            </Campo>
            <div className="dupla">
              <Campo rotulo="Valor (R$)">
                <EntradaMoeda
                  valor={crud.form.valor}
                  aoMudar={(v) => crud.setForm({ ...crud.form, valor: v })}
                />
              </Campo>
              <Campo rotulo="Forma de pagamento">
                <select
                  value={crud.form.forma}
                  onChange={(e) => crud.setForm({ ...crud.form, forma: e.target.value })}
                >
                  {FORMAS.map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
              </Campo>
            </div>
            <div className="dupla">
              <Campo rotulo="Dia do vencimento" dica="Opcional">
                <input
                  type="number"
                  min="1"
                  max="31"
                  value={crud.form.dia_vencimento}
                  onChange={(e) => crud.setForm({ ...crud.form, dia_vencimento: e.target.value })}
                />
              </Campo>
              <Campo rotulo="Categoria" dica="Opcional">
                <select
                  value={crud.form.categoria_id}
                  onChange={(e) => crud.setForm({ ...crud.form, categoria_id: e.target.value })}
                >
                  <option value="">Sem categoria</option>
                  {opcoesCategoria(cadastros.dados?.categorias).map((o) => (
                    <option key={o.valor} value={o.valor}>{o.texto}</option>
                  ))}
                </select>
              </Campo>
            </div>
            <CamposVigencia form={crud.form} setForm={crud.setForm} />
          </>
        )}
      </Modal>

      {limpando && (
        <ModalLimpezaVigencia
          recurso="contas"
          mes={mes}
          contasBancarias={contasBancarias.dados || []}
          aoFechar={() => setLimpando(false)}
          aoConcluir={(r) => {
            setLimpando(false);
            consulta.recarregar();
            aviso(r.quantidade === 0
              ? 'Nada foi apagado — nenhuma conta caía nesse recorte.'
              : `${r.quantidade} ${r.quantidade === 1 ? 'conta apagada' : 'contas apagadas'}`
                + ` (${brl(r.total)}). Cópia do banco salva antes de apagar.`);
          }}
        />
      )}

      {dialogo}
    </>
  );
}
