import { useState } from 'react';
import { api } from '../api.js';
import { brl, num, rotuloMes } from '../formato.js';
import { useCadastros, opcoesCategoria } from '../cadastros.js';
import { Estado, useAviso, useDados, Vazio } from '../componentes.jsx';

/**
 * Classificar o acervo — por estabelecimento, não por lançamento.
 *
 * O número de linhas sem categoria assusta mais do que o trabalho real: o mesmo
 * estabelecimento repete, e cinco compras na mesma farmácia são **uma** decisão.
 * A tela agrupa por isso, e cada grupo resolvido ensina o classificador, então a
 * próxima importação já chega com aquilo preenchido.
 */
export default function Classificar() {
  const aviso = useAviso();
  const cadastros = useCadastros();
  const consulta = useDados(() => api.get('/classificacao/pendentes'), []);

  // Escolhas ainda não gravadas: chave do grupo -> categoria_id.
  const [escolhas, setEscolhas] = useState({});
  const [salvando, setSalvando] = useState(false);

  const categorias = opcoesCategoria(cadastros.dados?.categorias);
  const dados = consulta.dados;
  const grupos = dados?.itens || [];

  // A sugestão só vale como escolha depois de o usuário deixá-la ficar: ela
  // aparece pré-selecionada, e o que for para o banco é o que está na tela.
  const categoriaDe = (g) => escolhas[g.chave] ?? g.sugestao_id ?? '';

  const marcados = grupos.filter((g) => categoriaDe(g));
  const lancamentosMarcados = marcados.reduce((t, g) => t + g.quantidade, 0);

  const aplicarSugestoes = () => {
    const novas = {};
    for (const g of grupos) if (g.sugestao_id) novas[g.chave] = g.sugestao_id;
    setEscolhas((atuais) => ({ ...atuais, ...novas }));
  };

  const salvar = async () => {
    setSalvando(true);
    try {
      const r = await api.post('/classificacao/aplicar', {
        grupos: marcados.map((g) => ({ categoria_id: Number(categoriaDe(g)), ids: g.ids })),
      });
      aviso(`${r.atualizados} lançamentos classificados em ${r.grupos} grupos. `
        + 'O classificador aprendeu com isso.');
      setEscolhas({});
      consulta.recarregar();
    } catch (e) {
      aviso(e.message, 'erro');
    } finally {
      setSalvando(false);
    }
  };

  return (
    <>
      <div className="aviso" style={{ marginBottom: 18 }}>
        <b>O app aprende com o que você classifica.</b> Cada grupo resolvido aqui vira exemplo: na
        importação seguinte, o mesmo estabelecimento já chega com a categoria preenchida — e uma
        loja nova da mesma rede, numa cidade diferente, também. Nada disso sai da sua máquina; a
        sugestão é contagem sobre o seu próprio histórico.
      </div>

      <Estado carregando={consulta.carregando} erro={consulta.erro}>
        {dados && (grupos.length === 0 ? (
          <div className="cartao">
            <Vazio titulo="Nada sem categoria">
              Todos os gastos já estão classificados. O classificador tem{' '}
              {num(dados.modelo.exemplos)} exemplos para as próximas importações.
            </Vazio>
          </div>
        ) : (
          <>
            <div className="grade g4" style={{ marginBottom: 18 }}>
              <div className="cartao indicador">
                <div className="rotulo">Sem categoria</div>
                <div className="valor">{num(dados.lancamentos)}</div>
                <div className="rodape">lançamentos</div>
              </div>
              <div className="cartao indicador">
                <div className="rotulo">Decisões de verdade</div>
                <div className="valor">{num(dados.grupos)}</div>
                <div className="rodape">estabelecimentos distintos</div>
              </div>
              <div className="cartao indicador">
                <div className="rotulo">Agrupar poupa</div>
                <div className="valor">{num(dados.decisoes_poupadas)}</div>
                <div className="rodape">cliques que você não precisa dar</div>
              </div>
              <div className="cartao indicador">
                <div className="rotulo">O que já foi aprendido</div>
                <div className="valor">{num(dados.modelo.exemplos)}</div>
                <div className="rodape">
                  exemplos · {num(dados.modelo.chaves)} sinais
                  {dados.modelo.ambiguas > 0 && ` · ${dados.modelo.ambiguas} em dúvida`}
                </div>
              </div>
            </div>

            <div className="filtros" style={{ marginBottom: 10 }}>
              <button
                type="button"
                className="botao pequeno"
                onClick={aplicarSugestoes}
                disabled={!grupos.some((g) => g.sugestao_id)}
                title={grupos.some((g) => g.sugestao_id)
                  ? undefined
                  : 'Ainda não há histórico parecido com estes gastos'}
              >
                Aceitar todas as sugestões
              </button>
              <button type="button" className="botao pequeno" onClick={() => setEscolhas({})}>
                Limpar escolhas
              </button>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 13.5, color: 'var(--text-2)' }}>
                {marcados.length} grupos · <b style={{ color: 'var(--text)' }}>{lancamentosMarcados}</b> lançamentos
              </span>
            </div>

            <div className="cartao">
              <div className="rolagem">
                <table>
                  <thead>
                    <tr>
                      <th>Estabelecimento</th>
                      <th>Cartão</th>
                      <th className="num">Vezes</th>
                      <th className="num">Total</th>
                      <th>Categoria</th>
                    </tr>
                  </thead>
                  <tbody>
                    {grupos.map((g) => (
                      <tr key={g.chave} style={categoriaDe(g) ? undefined : { opacity: 0.7 }}>
                        <td style={{ minWidth: 240 }}>
                          {g.rotulo}
                          {g.quantidade > 1 && (
                            <div className="fraco" style={{ fontSize: 12 }}>
                              {g.exemplos.map((e) => rotuloMes(e.mes, { curto: true })).join(', ')}
                              {g.quantidade > g.exemplos.length && ` +${g.quantidade - g.exemplos.length}`}
                            </div>
                          )}
                          {g.sugestao_motivo && (
                            <div className="fraco" style={{ fontSize: 12, marginTop: 2 }}>
                              sugerido: {g.sugestao_motivo}
                              {g.sugestao_confianca !== null && g.sugestao_confianca < 1
                                && ` · confiança ${Math.round(g.sugestao_confianca * 100)}%`}
                            </div>
                          )}
                        </td>
                        <td className="fraco">{g.cartao || <span className="fraco">—</span>}</td>
                        <td className="num">{g.quantidade}</td>
                        <td className="num">{brl(g.total)}</td>
                        <td>
                          <select
                            value={categoriaDe(g)}
                            onChange={(e) => setEscolhas((a) => ({ ...a, [g.chave]: e.target.value }))}
                            style={{ minWidth: 150 }}
                            aria-label={`Categoria de ${g.rotulo}`}
                          >
                            <option value="">Deixar sem categoria</option>
                            {categorias.map((o) => (
                              <option key={o.valor} value={o.valor}>{o.texto}</option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 9, marginTop: 16, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="botao primario"
                onClick={salvar}
                disabled={salvando || marcados.length === 0}
              >
                {salvando
                  ? 'Classificando…'
                  : `Classificar ${lancamentosMarcados} lançamentos`}
              </button>
            </div>
          </>
        ))}
      </Estado>
    </>
  );
}
