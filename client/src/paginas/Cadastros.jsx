import { api, recurso } from '../api.js';
import {
  Campo, Estado, MenuAcoes, Modal, useAviso, useConfirmacao, useCrud, useDados, Vazio,
} from '../componentes.jsx';

const categorias = recurso('categorias');
const pessoas = recurso('pessoas');

const PALETA = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#4a3aa7', '#e34948', '#008300', '#898781'];

export default function Cadastros() {
  return (
    <div className="grade g2">
      <Categorias />
      <Pessoas />
    </div>
  );
}

function Categorias() {
  const aviso = useAviso();
  const { confirmar, elemento: dialogo } = useConfirmacao();
  const consulta = useDados(() => api.get('/categorias'), []);

  const crud = useCrud({
    recurso: categorias,
    recarregar: consulta.recarregar,
    nome: 'Categoria',
    genero: 'f',
    aviso,
    confirmar,
  });

  const lista = consulta.dados || [];

  return (
    <div className="cartao">
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div className="cartao-titulo">Categorias</div>
          <div className="cartao-legenda">
            Como os gastos são agrupados no painel. Excluir uma categoria não apaga os lançamentos —
            eles só ficam sem classificação.
          </div>
        </div>
        <button
          type="button"
          className="botao pequeno"
          onClick={() => crud.abrir({ nome: '', cor: PALETA[lista.length % PALETA.length] })}
        >
          + Nova
        </button>
      </div>

      <Estado carregando={consulta.carregando} erro={consulta.erro}>
        {lista.length === 0 ? (
          <Vazio titulo="Nenhuma categoria">Crie categorias para ver o painel por tipo de gasto.</Vazio>
        ) : (
          <div className="rolagem">
            <table>
              <thead>
                <tr><th>Categoria</th><th className="num">Em uso</th><th /></tr>
              </thead>
              <tbody>
                {lista.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}>
                        <i className="ponto" style={{ background: c.cor }} />{c.nome}
                      </span>
                    </td>
                    <td className="num fraco">{c.qtd_lancamentos}</td>
                    <td>
                      <div className="acoes">
                        <MenuAcoes itens={[
                          { texto: 'Editar', aoClicar: () => crud.abrir(c) },
                          {
                            texto: 'Excluir',
                            perigo: true,
                            aoClicar: () => crud.excluir(
                              c,
                              `Excluir a categoria "${c.nome}"? ${c.qtd_lancamentos} lançamentos ficarão sem categoria.`,
                            ),
                          },
                        ]}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Estado>

      <Modal
        aberto={Boolean(crud.form)}
        titulo={crud.form?.id ? 'Editar categoria' : 'Nova categoria'}
        aoFechar={crud.fechar}
        aoSalvar={crud.salvar}
        salvando={crud.salvando}
        erro={crud.erro}
      >
        {crud.form && (
          <>
            <Campo rotulo="Nome">
              <input
                autoFocus
                value={crud.form.nome}
                onChange={(e) => crud.setForm({ ...crud.form, nome: e.target.value })}
                placeholder="Mercado, transporte, saúde…"
              />
            </Campo>
            <Campo rotulo="Cor">
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {PALETA.map((hex) => (
                  <button
                    key={hex}
                    type="button"
                    aria-label={`Cor ${hex}`}
                    onClick={() => crud.setForm({ ...crud.form, cor: hex })}
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: 8,
                      background: hex,
                      cursor: 'pointer',
                      border: crud.form.cor === hex ? '3px solid var(--text)' : '1px solid var(--border)',
                    }}
                  />
                ))}
              </div>
            </Campo>
          </>
        )}
      </Modal>

      {dialogo}
    </div>
  );
}

function Pessoas() {
  const aviso = useAviso();
  const { confirmar, elemento: dialogo } = useConfirmacao();
  const consulta = useDados(() => api.get('/pessoas'), []);

  const crud = useCrud({
    recurso: pessoas,
    recarregar: consulta.recarregar,
    nome: 'Pessoa',
    genero: 'f',
    aviso,
    confirmar,
  });

  const lista = consulta.dados || [];

  return (
    <div className="cartao">
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div className="cartao-titulo">Pessoas</div>
          <div className="cartao-legenda">
            Quem usa seu cartão e depois te devolve. Marcando um gasto com a pessoa, o valor entra
            na fatura <i>e</i> volta como receita — o efeito líquido no seu bolso é zero.
          </div>
        </div>
        <button
          type="button"
          className="botao pequeno"
          onClick={() => crud.abrir({ nome: '', reembolsa: 1 })}
        >
          + Nova
        </button>
      </div>

      <Estado carregando={consulta.carregando} erro={consulta.erro}>
        {lista.length === 0 ? (
          <Vazio titulo="Nenhuma pessoa cadastrada">
            Útil quando alguém usa seu cartão e depois te paga.
          </Vazio>
        ) : (
          <div className="rolagem">
            <table>
              <thead>
                <tr><th>Nome</th><th>Reembolso</th><th /></tr>
              </thead>
              <tbody>
                {lista.map((p) => (
                  <tr key={p.id}>
                    <td>{p.nome}</td>
                    <td>
                      <span className="etiqueta">
                        {p.reembolsa ? 'entra como receita' : 'não reembolsa'}
                      </span>
                    </td>
                    <td>
                      <div className="acoes">
                        <MenuAcoes itens={[
                          { texto: 'Editar', aoClicar: () => crud.abrir(p) },
                          {
                            texto: 'Excluir',
                            perigo: true,
                            aoClicar: () => crud.excluir(p, `Excluir "${p.nome}"? Os gastos dela deixam de virar reembolso.`),
                          },
                        ]}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Estado>

      <Modal
        aberto={Boolean(crud.form)}
        titulo={crud.form?.id ? 'Editar pessoa' : 'Nova pessoa'}
        aoFechar={crud.fechar}
        aoSalvar={crud.salvar}
        salvando={crud.salvando}
        erro={crud.erro}
      >
        {crud.form && (
          <>
            <Campo rotulo="Nome">
              <input
                autoFocus
                value={crud.form.nome}
                onChange={(e) => crud.setForm({ ...crud.form, nome: e.target.value })}
              />
            </Campo>
            <div className="linha-check">
              <input
                id="reembolsa"
                type="checkbox"
                checked={Boolean(crud.form.reembolsa)}
                onChange={(e) => crud.setForm({ ...crud.form, reembolsa: e.target.checked ? 1 : 0 })}
              />
              <label htmlFor="reembolsa">Os gastos dessa pessoa voltam como receita</label>
            </div>
          </>
        )}
      </Modal>

      {dialogo}
    </div>
  );
}
