import { api, recurso } from '../api.js';
import { useMes } from '../App.jsx';
import { brl, rotuloMes, vigencia } from '../formato.js';
import {
  Campo, CamposVigencia, EntradaMoeda, Estado, MenuAcoes, Modal, useAviso, useConfirmacao, useCrud,
  useDados, Vazio,
} from '../componentes.jsx';

const receitas = recurso('receitas');

const TIPOS = [
  { valor: 'fixa', texto: 'Fixa (salário, aposentadoria)' },
  { valor: 'variavel', texto: 'Variável (freela, bônus, venda)' },
  { valor: 'ajuste', texto: 'Ajuste (desconto, juros, cheque especial)' },
];

const vazio = (mes) => ({ descricao: '', valor: '', tipo: 'fixa', mes_inicio: mes, mes_fim: null });

const ativaEm = (r, mes) => r.mes_inicio <= mes && (!r.mes_fim || r.mes_fim >= mes);

export default function Receitas() {
  const { mes } = useMes();
  const aviso = useAviso();
  const { confirmar, elemento: dialogo } = useConfirmacao();

  const consulta = useDados(() => api.get('/receitas'), []);
  const resumo = useDados(() => api.get('/resumo', { mes }), [mes]);

  const crud = useCrud({
    recurso: receitas,
    recarregar: () => { consulta.recarregar(); resumo.recarregar(); },
    nome: 'Receita',
    genero: 'f',
    aviso,
    confirmar,
  });

  const lista = consulta.dados || [];
  const doMes = lista.filter((r) => ativaEm(r, mes));
  const total = doMes.reduce((t, r) => t + r.valor, 0);
  const reembolsos = resumo.dados?.reembolsos || 0;

  return (
    <>
      <div className="filtros">
        <span style={{ flex: 1 }} />
        <button type="button" className="botao primario" onClick={() => crud.abrir(vazio(mes))}>
          + Nova receita
        </button>
      </div>

      <div className="grade g3" style={{ marginBottom: 18 }}>
        <div className="cartao indicador">
          <div className="rotulo">Receitas lançadas em {rotuloMes(mes, { curto: true })}</div>
          <div className="valor">{brl(total)}</div>
          <div className="rodape">{doMes.length} lançamentos vigentes</div>
        </div>
        <div className="cartao indicador">
          <div className="rotulo">Reembolsos de terceiros</div>
          <div className="valor">{brl(reembolsos)}</div>
          <div className="rodape">calculado a partir dos gastos marcados com uma pessoa</div>
        </div>
        <div className="cartao indicador">
          <div className="rotulo">Renda líquida</div>
          <div className="valor">{brl(total + reembolsos)}</div>
          <div className="rodape">é este valor que o painel usa</div>
        </div>
      </div>

      <div className="aviso" style={{ marginBottom: 18 }}>
        <b>Valores negativos são bem-vindos.</b> Use o tipo <i>ajuste</i> com valor negativo para
        descontos recorrentes — cheque especial, juros do limite, empréstimo consignado.
      </div>

      <Estado carregando={consulta.carregando} erro={consulta.erro}>
        <div className="cartao">
          {lista.length === 0 ? (
            <Vazio titulo="Nenhuma receita cadastrada">
              Lance seu salário uma vez marcando "repete nos meses seguintes".
            </Vazio>
          ) : (
            <div className="rolagem">
              <table>
                <thead>
                  <tr>
                    <th>Descrição</th>
                    <th>Tipo</th>
                    <th>Vigência</th>
                    <th className="num">Valor</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {lista.map((r) => {
                    const ativa = ativaEm(r, mes);
                    return (
                      <tr key={r.id} style={ativa ? undefined : { opacity: 0.55 }}>
                        <td>
                          {r.descricao}
                          {!ativa && <span className="etiqueta" style={{ marginLeft: 8 }}>fora do mês</span>}
                        </td>
                        <td><span className="etiqueta">{r.tipo}</span></td>
                        <td className="fraco" style={{ whiteSpace: 'nowrap' }}>{vigencia(r.mes_inicio, r.mes_fim)}</td>
                        <td className="num" style={r.valor < 0 ? { color: 'var(--critico)' } : undefined}>
                          {brl(r.valor)}
                        </td>
                        <td>
                          <div className="acoes">
                            <MenuAcoes itens={[
                              { texto: 'Editar', aoClicar: () => crud.abrir(r) },
                              {
                                texto: 'Excluir',
                                perigo: true,
                                aoClicar: () => crud.excluir(r, `Excluir a receita "${r.descricao}"? Ela some de todos os meses.`),
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
        titulo={crud.form?.id ? 'Editar receita' : 'Nova receita'}
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
                placeholder="Salário, freela, cheque especial…"
              />
            </Campo>
            <div className="dupla">
              <Campo rotulo="Valor (R$)" dica="Negativo para descontos">
                <EntradaMoeda
                  valor={crud.form.valor}
                  aoMudar={(v) => crud.setForm({ ...crud.form, valor: v })}
                />
              </Campo>
              <Campo rotulo="Tipo">
                <select
                  value={crud.form.tipo}
                  onChange={(e) => crud.setForm({ ...crud.form, tipo: e.target.value })}
                >
                  {TIPOS.map((t) => <option key={t.valor} value={t.valor}>{t.texto}</option>)}
                </select>
              </Campo>
            </div>
            <CamposVigencia form={crud.form} setForm={crud.setForm} />
          </>
        )}
      </Modal>

      {dialogo}
    </>
  );
}
