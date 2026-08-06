import { useState } from 'react';
import { api } from '../api.js';
import { useMes } from '../App.jsx';
import { brl, rotuloMes } from '../formato.js';
import { Barras, Estado, useDados } from '../componentes.jsx';

export default function Projecao() {
  const { mes } = useMes();
  const [horizonte, setHorizonte] = useState(6);
  const { dados, carregando, erro } = useDados(
    () => api.get('/projecao', { mes, meses: horizonte }),
    [mes, horizonte],
  );

  const linhas = dados?.linhas || [];
  const piorMes = linhas.reduce((pior, l) => (!pior || l.saldo < pior.saldo ? l : pior), null);
  const totalSaida = linhas.reduce((t, l) => t + l.divida_total, 0);

  return (
    <>
      <div className="filtros">
        <div className="campo" style={{ minWidth: 190 }}>
          <label htmlFor="horizonte">Horizonte</label>
          <select id="horizonte" value={horizonte} onChange={(e) => setHorizonte(Number(e.target.value))}>
            {[3, 6, 12, 18, 24].map((n) => <option key={n} value={n}>{n} meses</option>)}
          </select>
        </div>
      </div>

      <div className="aviso" style={{ marginBottom: 18 }}>
        <b>Só o que já é conhecido hoje.</b> A projeção soma as parcelas que ainda vão vencer, as
        contas vigentes e as receitas recorrentes. Compras avulsas futuras — as que você ainda nem
        fez, incluindo as cobranças que se repetem todo mês — não entram, então o gasto real tende
        a ser maior.
      </div>

      <Estado carregando={carregando} erro={erro}>
        {linhas.length > 0 && (
          <>
            <div className="grade g3" style={{ marginBottom: 18 }}>
              <div className="cartao indicador">
                <div className="rotulo">Compromissos nos {horizonte} meses</div>
                <div className="valor">{brl(totalSaida)}</div>
                <div className="rodape">a partir de {rotuloMes(mes, { curto: true })}</div>
              </div>
              <div className="cartao indicador">
                <div className="rotulo">Mês mais apertado</div>
                <div className="valor" style={{ color: piorMes.saldo < 0 ? 'var(--critico)' : 'var(--bom)' }}>
                  {brl(piorMes.saldo)}
                </div>
                <div className="rodape">{rotuloMes(piorMes.mes)}</div>
              </div>
              <div className="cartao indicador">
                <div className="rotulo">Meses com saldo negativo</div>
                <div className="valor">{linhas.filter((l) => l.saldo < 0).length} de {linhas.length}</div>
                <div className="rodape">considerando só os compromissos já assumidos</div>
              </div>
            </div>

            <div className="cartao">
              <div className="cartao-titulo">Quanto sai por mês</div>
              <div className="cartao-legenda">Total já comprometido em cada competência.</div>
              <Barras
                itens={linhas.map((l) => ({
                  chave: l.mes,
                  rotulo: rotuloMes(l.mes, { curto: true }),
                  valor: l.divida_total,
                  sub: l.saldo < 0 ? `saldo ${brl(l.saldo)}` : null,
                }))}
              />
            </div>

            <div className="cartao">
              <div className="cartao-titulo">Mês a mês</div>
              <div className="cartao-legenda">Renda recorrente contra compromissos já assumidos.</div>
              <div className="rolagem">
                <table>
                  <thead>
                    <tr>
                      <th>Mês</th>
                      <th className="num">Renda líquida</th>
                      <th className="num">Cartões</th>
                      <th className="num">Contas</th>
                      <th className="num">Total que sai</th>
                      <th className="num">Saldo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {linhas.map((l) => (
                      <tr key={l.mes}>
                        <td>{rotuloMes(l.mes)}</td>
                        <td className="num">{brl(l.renda_liquida)}</td>
                        <td className="num">{brl(l.total_cartoes)}</td>
                        <td className="num">{brl(l.total_contas)}</td>
                        <td className="num">{brl(l.divida_total)}</td>
                        <td className="num" style={{ color: l.saldo < 0 ? 'var(--critico)' : 'var(--bom)', fontWeight: 600 }}>
                          {brl(l.saldo)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </Estado>
    </>
  );
}
