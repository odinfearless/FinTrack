import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useMes } from '../App.jsx';
import { brl, pct, rotuloMes } from '../formato.js';
import { Barras, Estado, Indicador, useDados, Valor, Vazio } from '../componentes.jsx';
import { corDeMarca } from '../CartaoVisual.jsx';
import { Tipo } from './ListaGastos.jsx';

const arred = (n) => Math.round(n * 100) / 100;

export default function Painel() {
  const { mes } = useMes();
  const { dados, carregando, erro } = useDados(() => api.get('/resumo', { mes }), [mes]);

  return (
    <Estado carregando={carregando} erro={erro}>
      {dados && <Conteudo r={dados} mes={mes} />}
    </Estado>
  );
}

function Conteudo({ r, mes }) {
  const vazio = r.quantidade.despesas === 0 && r.quantidade.contas === 0 && r.receitas === 0;

  if (vazio) {
    return (
      <div className="cartao">
        <Vazio titulo={`Nada lançado em ${rotuloMes(mes)}`}>
          <p style={{ maxWidth: 460, margin: '0 auto' }}>
            Comece cadastrando um <Link to="/cartoes" style={{ color: 'var(--s1)' }}>cartão</Link>,
            registrando suas <Link to="/receitas" style={{ color: 'var(--s1)' }}>receitas</Link> ou
            trazendo tudo de uma vez pela{' '}
            <Link to="/importar" style={{ color: 'var(--s1)' }}>importação da planilha</Link>.
          </p>
        </Vazio>
      </div>
    );
  }

  const negativo = r.saldo < 0;
  const variacao = r.comparativo.variacao_divida;

  return (
    <>
      <div className="cartao heroi">
        <div className="rotulo">Saldo de {rotuloMes(mes)} — renda líquida menos tudo que sai</div>
        <div className="valor" style={{ color: negativo ? 'var(--critico)' : 'var(--bom)' }}>
          {brl(r.saldo)}
        </div>
        <div className="nota">
          Entra <b>{brl(r.renda_liquida)}</b> · sai <b>{brl(r.divida_total)}</b>
          <br />
          {r.comprometimento !== null
            ? <>As despesas consomem <b>{pct(r.comprometimento)}</b> da renda líquida.</>
            : 'Sem receita lançada neste mês.'}
        </div>
      </div>

      <div className="grade g4" style={{ marginTop: 16 }}>
        <Indicador
          rotulo="Renda líquida"
          valor={brl(r.renda_liquida)}
          rodape={r.reembolsos > 0 ? `inclui ${brl(r.reembolsos)} de reembolsos` : 'receitas do mês'}
        />
        <Indicador
          rotulo="Total que sai"
          valor={brl(r.divida_total)}
          rodape={variacao === null
            ? `${r.quantidade.despesas} despesas + ${r.quantidade.contas} contas`
            : `${variacao > 0 ? '+' : ''}${pct(variacao)} vs ${rotuloMes(r.comparativo.mes, { curto: true })}`}
        />
        <Indicador
          rotulo="Faturas de cartão"
          valor={brl(r.total_cartoes)}
          rodape={`${r.por_cartao.filter((c) => c.total !== 0).length} cartões com movimento`}
        />
        <Indicador
          rotulo="Parcelas a vencer"
          valor={brl(r.saldo_futuro_parcelas)}
          rodape={`${r.quantidade.parcelamentos} parcelamentos em andamento`}
        />
      </div>

      <div className="grade g2" style={{ marginTop: 18 }}>
        <div className="cartao">
          <div className="cartao-titulo">Para onde vai o dinheiro</div>
          <div className="cartao-legenda">Faturas de cartão e contas fora do cartão.</div>
          <Barras
            // O corte é por "teve movimento", não por "é positivo": um cartão
            // que fechou o mês em crédito continua compondo o total, e omiti-lo
            // faria as barras não baterem com a dívida do mês.
            itens={[
              ...r.por_cartao.filter((c) => c.total !== 0).map((c) => ({
                chave: `c${c.cartao_id}`,
                rotulo: c.cartao,
                valor: c.total,
                cor: corDeMarca(c.cor),
                sub: pct((c.total / r.divida_total) * 100),
              })),
              ...(r.total_sem_cartao !== 0 ? [{
                chave: 'sem-cartao',
                rotulo: 'Sem cartão',
                valor: r.total_sem_cartao,
                cor: 'var(--s4)',
                sub: pct((r.total_sem_cartao / r.divida_total) * 100),
              }] : []),
              ...(r.total_contas !== 0 ? [{
                chave: 'contas',
                rotulo: 'Contas e débitos',
                valor: r.total_contas,
                cor: 'var(--s3)',
                sub: pct((r.total_contas / r.divida_total) * 100),
              }] : []),
            ]}
          />
        </div>

        <div className="cartao">
          <div className="cartao-titulo">Natureza do gasto</div>
          <div className="cartao-legenda">
            Compras do mês e parcelas herdadas de compras antigas.
          </div>
          <Barras
            cores={[1, 2]}
            itens={[
              {
                chave: 'a',
                rotulo: 'Compras avulsas',
                valor: arred(r.por_cartao.reduce((t, c) => t + c.avulsos, 0) + r.sem_cartao.avulsos),
                sub: `${r.quantidade.avulsos} itens`,
              },
              {
                chave: 'p',
                rotulo: 'Parcelas do mês',
                valor: r.por_cartao.reduce((t, c) => t + c.parcelamentos, 0),
                sub: `${r.quantidade.parcelamentos} compras`,
              },
            ]}
          />
        </div>
      </div>

      <div className="grade g2" style={{ marginTop: 18 }}>
        <div className="cartao">
          <div className="cartao-titulo">Gastos por categoria</div>
          <div className="cartao-legenda">
            Só classifica o que tem categoria escolhida no lançamento.
          </div>
          <Barras
            itens={r.por_categoria.slice(0, 9).map((c) => ({
              chave: c.categoria,
              rotulo: c.categoria,
              valor: c.total,
              cor: c.cor,
              sub: `${c.itens}×`,
            }))}
            vazio="Nenhum gasto categorizado neste mês."
          />
        </div>

        <div className="cartao">
          <div className="cartao-titulo">Maiores gastos</div>
          <div className="cartao-legenda">Os dez lançamentos mais pesados do mês.</div>
          <div className="rolagem">
            <table>
              <thead>
                <tr>
                  <th>Descrição</th>
                  <th>Tipo</th>
                  <th className="num">Valor</th>
                </tr>
              </thead>
              <tbody>
                {r.maiores.map((d) => (
                  <tr key={d.chave}>
                    <td>
                      {d.descricao}
                      {d.pessoa && <span className="etiqueta" style={{ marginLeft: 8 }}>{d.pessoa}</span>}
                    </td>
                    <td><Tipo d={d} /></td>
                    <td className="num"><Valor v={d.valor} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {r.por_pessoa.length > 0 && (
        <div className="cartao" style={{ marginTop: 18 }}>
          <div className="cartao-titulo">Gastos de terceiros a receber</div>
          <div className="cartao-legenda">
            Passam pela sua fatura mas voltam como receita — por isso já entram na renda líquida.
          </div>
          <div className="rolagem">
            <table>
              <thead>
                <tr><th>Pessoa</th><th className="num">Lançamentos</th><th className="num">Total</th></tr>
              </thead>
              <tbody>
                {r.por_pessoa.map((p) => (
                  <tr key={p.pessoa_id}>
                    <td>{p.pessoa}</td>
                    <td className="num">{p.itens}</td>
                    <td className="num"><Valor v={p.total} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
