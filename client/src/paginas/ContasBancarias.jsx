import { api, recurso } from '../api.js';
import { brl, dataBR } from '../formato.js';
import {
  Campo, EntradaMoeda, Estado, MenuAcoes, Modal, useAviso, useConfirmacao, useCrud, useDados,
  Valor, Vazio,
} from '../componentes.jsx';

const contasBancarias = recurso('contas-bancarias');

const vazio = () => ({
  nome: '', banco: '', agencia: '', numero: '', cor: '#f07c00',
  saldo: '', limite_total: '', limite_usado: '', saldo_em: '', ativo: 1,
});

/** Quanto do limite já foi consumido, para a barra e para o rótulo. */
function usoDoLimite(c) {
  if (!c.limite_total) return null;
  const usado = Number(c.limite_usado) || 0;
  return Math.min(Math.max((usado / c.limite_total) * 100, 0), 100);
}

export default function ContasBancarias() {
  const aviso = useAviso();
  const { confirmar, elemento: dialogo } = useConfirmacao();
  const consulta = useDados(() => api.get('/contas-bancarias'), []);

  const crud = useCrud({
    recurso: contasBancarias,
    recarregar: consulta.recarregar,
    nome: 'Conta',
    genero: 'f',
    aviso,
    confirmar,
    aoPreparar: (c) => ({
      ...c,
      banco: c.banco || '',
      agencia: c.agencia || '',
      numero: c.numero || '',
      saldo: c.saldo ?? '',
      limite_total: c.limite_total ?? '',
      limite_usado: c.limite_usado ?? '',
      saldo_em: c.saldo_em || '',
    }),
  });

  const lista = consulta.dados || [];

  return (
    <>
      <div className="filtros">
        <span style={{ flex: 1 }} />
        <button type="button" className="botao primario" onClick={() => crud.abrir(vazio())}>
          + Nova conta
        </button>
      </div>

      <div className="aviso" style={{ marginBottom: 18 }}>
        <b>A conta corrente é o outro lado do cartão.</b> É dela que saem os débitos automáticos e é
        nela que a receita cai. Saldo e limite são a última foto lida de um extrato — para atualizá-los
        sem digitar, basta importar um extrato mais novo em <b>Importar gastos</b>.
      </div>

      <Estado carregando={consulta.carregando} erro={consulta.erro}>
        <div className="cartao">
          {lista.length === 0 ? (
            <Vazio titulo="Nenhuma conta cadastrada">
              Importe o PDF de um extrato em "Importar gastos": banco, agência, número, saldo e limite
              são lidos do próprio arquivo, e a conta se cadastra com um clique.
            </Vazio>
          ) : (
            <div className="rolagem">
              <table>
                <thead>
                  <tr>
                    <th>Conta</th>
                    <th>Agência / número</th>
                    <th className="num">Saldo</th>
                    <th>Limite</th>
                    <th className="num">Lançamentos</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {lista.map((c) => {
                    const uso = usoDoLimite(c);
                    const vinculados = (c.qtd_lancamentos || 0) + (c.qtd_contas || 0) + (c.qtd_receitas || 0);
                    return (
                      <tr key={c.id} style={c.ativo ? undefined : { opacity: 0.55 }}>
                        <td>
                          <span
                            aria-hidden="true"
                            style={{
                              display: 'inline-block',
                              width: 10,
                              height: 10,
                              borderRadius: 3,
                              background: c.cor,
                              marginRight: 8,
                            }}
                          />
                          {c.nome}
                          {!c.ativo && <span className="etiqueta" style={{ marginLeft: 8 }}>inativa</span>}
                          <div className="fraco" style={{ fontSize: 12.5 }}>{c.banco || '—'}</div>
                        </td>
                        <td className="fraco" style={{ whiteSpace: 'nowrap' }}>
                          {[c.agencia, c.numero].filter(Boolean).join(' / ') || '—'}
                        </td>
                        <td className="num">
                          {c.saldo === null ? <span className="fraco">—</span> : <Valor v={c.saldo} />}
                          {c.saldo_em && (
                            <div className="fraco" style={{ fontSize: 12 }}>em {dataBR(c.saldo_em)}</div>
                          )}
                        </td>
                        <td style={{ minWidth: 170 }}>
                          {uso === null ? <span className="fraco">—</span> : (
                            <>
                              <span className="medidor" title={`${brl(c.limite_usado || 0)} de ${brl(c.limite_total)}`}>
                                <i style={{ width: `${uso}%` }} />
                              </span>
                              <div className="fraco" style={{ fontSize: 12 }}>
                                {brl(c.limite_usado || 0)} de {brl(c.limite_total)}
                              </div>
                            </>
                          )}
                        </td>
                        <td className="num fraco">{vinculados}</td>
                        <td>
                          <div className="acoes">
                            <MenuAcoes itens={[
                              { texto: 'Editar', aoClicar: () => crud.abrir(c) },
                              {
                                texto: 'Excluir',
                                perigo: true,
                                aoClicar: () => crud.excluir(
                                  c,
                                  `Excluir a conta "${c.nome}"? Os ${vinculados} lançamentos ligados a ela `
                                  + 'continuam no app, só deixam de apontar para uma conta.',
                                ),
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
        titulo={crud.form?.id ? 'Editar conta' : 'Nova conta bancária'}
        aoFechar={crud.fechar}
        aoSalvar={crud.salvar}
        salvando={crud.salvando}
        erro={crud.erro}
      >
        {crud.form && (
          <>
            <Campo rotulo="Nome" dica="Como você a chama — 'Itaú 8493', 'Conta do salário'">
              <input
                autoFocus
                value={crud.form.nome}
                onChange={(e) => crud.setForm({ ...crud.form, nome: e.target.value })}
              />
            </Campo>
            <div className="dupla">
              <Campo rotulo="Banco">
                <input
                  value={crud.form.banco}
                  onChange={(e) => crud.setForm({ ...crud.form, banco: e.target.value })}
                  placeholder="Itaú, Nubank, Inter…"
                />
              </Campo>
              <Campo rotulo="Cor">
                <input
                  type="color"
                  value={crud.form.cor}
                  onChange={(e) => crud.setForm({ ...crud.form, cor: e.target.value })}
                />
              </Campo>
            </div>
            <div className="dupla">
              <Campo rotulo="Agência" dica="Opcional">
                <input
                  value={crud.form.agencia}
                  onChange={(e) => crud.setForm({ ...crud.form, agencia: e.target.value })}
                />
              </Campo>
              <Campo rotulo="Número da conta" dica="Usado para reconhecer o extrato na importação">
                <input
                  value={crud.form.numero}
                  onChange={(e) => crud.setForm({ ...crud.form, numero: e.target.value })}
                />
              </Campo>
            </div>
            <div className="dupla">
              <Campo rotulo="Saldo (R$)" dica="Negativo se a conta estiver no vermelho">
                <EntradaMoeda
                  valor={crud.form.saldo}
                  aoMudar={(v) => crud.setForm({ ...crud.form, saldo: v })}
                />
              </Campo>
              <Campo rotulo="Saldo em" dica="Data da última leitura">
                <input
                  type="date"
                  value={crud.form.saldo_em}
                  onChange={(e) => crud.setForm({ ...crud.form, saldo_em: e.target.value })}
                />
              </Campo>
            </div>
            <div className="dupla">
              <Campo rotulo="Limite total (R$)" dica="Cheque especial contratado">
                <EntradaMoeda
                  valor={crud.form.limite_total}
                  aoMudar={(v) => crud.setForm({ ...crud.form, limite_total: v })}
                />
              </Campo>
              <Campo rotulo="Limite usado (R$)">
                <EntradaMoeda
                  valor={crud.form.limite_usado}
                  aoMudar={(v) => crud.setForm({ ...crud.form, limite_usado: v })}
                />
              </Campo>
            </div>
            <div className="linha-check">
              <input
                id="conta-ativa"
                type="checkbox"
                checked={Boolean(crud.form.ativo)}
                onChange={(e) => crud.setForm({ ...crud.form, ativo: e.target.checked ? 1 : 0 })}
              />
              <label htmlFor="conta-ativa">Conta ativa</label>
            </div>
          </>
        )}
      </Modal>

      {dialogo}
    </>
  );
}
