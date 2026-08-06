import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, recurso } from '../api.js';
import { useMes } from '../App.jsx';
import { brl, pct, rotuloMes } from '../formato.js';
import {
  Campo, EntradaMoeda, Estado, MenuAcoes, Modal, useAviso, useConfirmacao, useCrud, useDados,
  Valor, Vazio,
} from '../componentes.jsx';
import CartaoVisual, { bandeirasDisponiveis, detectarBandeira } from '../CartaoVisual.jsx';

const cartoes = recurso('cartoes');

const CORES = [
  { hex: '#2a78d6', nome: 'Azul' },
  { hex: '#eb6834', nome: 'Laranja' },
  { hex: '#1baf7a', nome: 'Verde-água' },
  { hex: '#eda100', nome: 'Amarelo' },
  { hex: '#e87ba4', nome: 'Rosa' },
  { hex: '#4a3aa7', nome: 'Violeta' },
  { hex: '#e34948', nome: 'Vermelho' },
  { hex: '#008300', nome: 'Verde' },
  { hex: '#1c1c1a', nome: 'Black' },
];

const vazio = () => ({
  nome: '', emissor: '', bandeira: '', final: '', cor: '#2a78d6',
  limite: '', dia_fechamento: '', dia_vencimento: '', ativo: 1,
});

export default function Cartoes() {
  const { mes } = useMes();
  const aviso = useAviso();
  const { confirmar, elemento: dialogo } = useConfirmacao();
  const [limpando, setLimpando] = useState(null);

  const consulta = useDados(() => api.get('/cartoes'), []);
  const resumo = useDados(() => api.get('/resumo', { mes }), [mes]);
  const listaEncargos = useDados(() => api.get('/encargos', { mes }), [mes]);

  const crud = useCrud({
    recurso: cartoes,
    recarregar: () => { consulta.recarregar(); resumo.recarregar(); },
    nome: 'Cartão',
    aviso,
    confirmar,
    aoPreparar: (c) => ({
      ...c,
      emissor: c.emissor || '',
      // Cartões antigos guardavam texto livre ("Visa"); o select trabalha com
      // chaves, então o valor gravado é normalizado ao abrir o formulário.
      bandeira: detectarBandeira(c.bandeira) || '',
      final: c.final || '',
      limite: c.limite ?? '',
      dia_fechamento: c.dia_fechamento ?? '',
      dia_vencimento: c.dia_vencimento ?? '',
    }),
  });

  const salvarEncargo = async (cartaoId, valor) => {
    try {
      await api.put('/encargos', { mes, cartao_id: cartaoId, valor: Number(valor) || 0 });
      listaEncargos.recarregar();
      resumo.recarregar();
      aviso('Encargos atualizados.');
    } catch (e) {
      aviso(e.message, 'erro');
    }
  };

  const lista = consulta.dados || [];
  const porCartao = new Map((resumo.dados?.por_cartao || []).map((c) => [c.cartao_id, c]));
  const encargoDe = new Map((listaEncargos.dados || []).map((e) => [e.cartao_id, e.valor]));

  return (
    <>
      <div className="filtros">
        <span style={{ flex: 1 }} />
        <button type="button" className="botao primario" onClick={() => crud.abrir(vazio())}>
          + Novo cartão
        </button>
      </div>

      <Estado carregando={consulta.carregando} erro={consulta.erro}>
        {lista.length === 0 ? (
          <div className="cartao">
            <Vazio titulo="Nenhum cartão cadastrado">
              Cadastre seus cartões para começar a lançar gastos.
            </Vazio>
          </div>
        ) : (
          <div className="grade g2">
            {lista.map((c) => {
              const fatura = porCartao.get(c.id);
              // Fatura em crédito não ocupa limite — "-4,2% usado" não diria nada.
              const usoLimite = c.limite > 0 && fatura?.total > 0 ? (fatura.total / c.limite) * 100 : null;
              return (
                <div className="cartao painel-cartao" key={c.id}>
                  <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginBottom: 16 }}>
                    <CartaoVisual cartao={c} largura={276} />
                    <div style={{ flex: '1 1 150px', minWidth: 0 }}>
                      <div className="cartao-titulo" style={{ marginBottom: 2 }}>{c.nome}</div>
                      <div className="cartao-legenda" style={{ marginBottom: 12 }}>
                        {[c.emissor, c.final && `final ${c.final}`].filter(Boolean).join(' · ')
                          || 'Sem emissor informado'}
                        {!c.ativo && ' · inativo'}
                      </div>
                      <div className="rotulo" style={{ fontSize: 12, color: 'var(--text-2)' }}>
                        Fatura de {rotuloMes(mes, { curto: true })}
                      </div>
                      <div style={{ fontSize: 26, fontWeight: 650, letterSpacing: '-0.02em' }}>
                        <Valor v={fatura?.total || 0} />
                      </div>
                    </div>
                  </div>

                  <div className="grade g3" style={{ gap: 12, marginBottom: 14 }}>
                    <div>
                      <div className="rotulo" style={{ fontSize: 12, color: 'var(--text-2)' }}>Limite</div>
                      <div style={{ fontSize: 20, fontWeight: 650 }}>
                        {c.limite ? brl(c.limite) : <span className="fraco">—</span>}
                      </div>
                      {usoLimite !== null && (
                        <div className="rodape" style={{ fontSize: 12, color: usoLimite > 90 ? 'var(--critico)' : 'var(--muted)' }}>
                          {pct(usoLimite)} usado
                        </div>
                      )}
                    </div>
                    <div>
                      <div className="rotulo" style={{ fontSize: 12, color: 'var(--text-2)' }}>Fecha / vence</div>
                      <div style={{ fontSize: 20, fontWeight: 650 }}>
                        {c.dia_fechamento || '—'} / {c.dia_vencimento || '—'}
                      </div>
                    </div>
                  </div>

                  {fatura && fatura.total !== 0 && (
                    <div className="rolagem" style={{ marginBottom: 14 }}>
                      <table>
                        <tbody>
                          <tr><td>Compras avulsas</td><td className="num"><Valor v={fatura.avulsos} /></td></tr>
                          <tr><td>Parcelas</td><td className="num"><Valor v={fatura.parcelamentos} /></td></tr>
                        </tbody>
                      </table>
                    </div>
                  )}

                  <Campo rotulo={`Juros e encargos em ${rotuloMes(mes, { curto: true })}`}>
                    <EntradaMoeda
                      valorInicial={encargoDe.get(c.id) ?? 0}
                      key={`${c.id}-${mes}-${encargoDe.get(c.id) ?? 0}`}
                      aoSair={(e) => {
                        const novo = Number(e.target.value) || 0;
                        if (novo !== (encargoDe.get(c.id) ?? 0)) salvarEncargo(c.id, novo);
                      }}
                    />
                  </Campo>

                  <div className="acoes">
                    <Link
                      className="botao pequeno"
                      to={`/despesas?cartao=${c.id}`}
                      title={`Ver os gastos de ${c.nome} em ${rotuloMes(mes, { curto: true })}`}
                    >
                      Ver gastos
                    </Link>
                    <MenuAcoes itens={[
                      { texto: 'Editar', aoClicar: () => crud.abrir(c) },
                      { texto: 'Limpar gastos', perigo: true, aoClicar: () => setLimpando(c) },
                      {
                        texto: 'Excluir',
                        perigo: true,
                        aoClicar: () => crud.excluir(
                          c,
                          `Excluir "${c.nome}"? Isso apaga junto ${c.qtd_lancamentos} lançamentos `
                          + `e ${c.qtd_parcelamentos} parcelamentos ligados a ele.`,
                        ),
                      },
                    ]}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Estado>

      <Modal
        aberto={Boolean(crud.form)}
        titulo={crud.form?.id ? 'Editar cartão' : 'Novo cartão'}
        aoFechar={crud.fechar}
        aoSalvar={crud.salvar}
        salvando={crud.salvando}
        erro={crud.erro}
      >
        {crud.form && (
          <>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 4 }}>
              <CartaoVisual cartao={crud.form} largura={300} />
            </div>

            <Campo rotulo="Nome do cartão">
              <input
                autoFocus
                value={crud.form.nome}
                onChange={(e) => {
                  const nome = e.target.value;
                  // Enquanto a bandeira não foi escolhida à mão, ela acompanha o
                  // nome: quem digita "Itaú Uniclass Visa" já vê a marca certa.
                  const detectada = crud.form.bandeira ? null : detectarBandeira(nome);
                  crud.setForm({ ...crud.form, nome, ...(detectada ? { bandeira: detectada } : {}) });
                }}
                placeholder="Itaú Uniclass Visa"
              />
            </Campo>
            <div className="dupla">
              <Campo rotulo="Emissor" dica="Opcional">
                <input
                  value={crud.form.emissor}
                  onChange={(e) => crud.setForm({ ...crud.form, emissor: e.target.value })}
                  placeholder="Itaú, Inter, Nubank…"
                />
              </Campo>
              <Campo rotulo="Bandeira">
                <select
                  value={crud.form.bandeira}
                  onChange={(e) => crud.setForm({ ...crud.form, bandeira: e.target.value })}
                >
                  <option value="">Não informada</option>
                  {bandeirasDisponiveis.map((b) => (
                    <option key={b.valor} value={b.valor}>{b.texto}</option>
                  ))}
                </select>
              </Campo>
            </div>
            <Campo rotulo="4 últimos dígitos" dica="Só para você reconhecer o cartão — o número completo nunca é pedido">
              <input
                inputMode="numeric"
                maxLength={4}
                value={crud.form.final}
                onChange={(e) => crud.setForm({ ...crud.form, final: e.target.value.replace(/\D/g, '').slice(0, 4) })}
                placeholder="1234"
                style={{ width: 110, letterSpacing: '0.18em', fontVariantNumeric: 'tabular-nums' }}
              />
            </Campo>
            <div className="dupla">
              <Campo rotulo="Dia do fechamento" dica="Opcional">
                <input
                  type="number"
                  min="1"
                  max="31"
                  value={crud.form.dia_fechamento}
                  onChange={(e) => crud.setForm({ ...crud.form, dia_fechamento: e.target.value })}
                />
              </Campo>
              <Campo rotulo="Dia do vencimento" dica="Opcional">
                <input
                  type="number"
                  min="1"
                  max="31"
                  value={crud.form.dia_vencimento}
                  onChange={(e) => crud.setForm({ ...crud.form, dia_vencimento: e.target.value })}
                />
              </Campo>
            </div>
            <Campo rotulo="Limite (R$)" dica="Opcional — habilita o alerta de uso do limite">
              <EntradaMoeda
                valor={crud.form.limite}
                aoMudar={(v) => crud.setForm({ ...crud.form, limite: v })}
              />
            </Campo>
            <Campo rotulo="Cor de identificação">
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {CORES.map((cor) => (
                  <button
                    key={cor.hex}
                    type="button"
                    title={cor.nome}
                    aria-label={cor.nome}
                    onClick={() => crud.setForm({ ...crud.form, cor: cor.hex })}
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: 8,
                      background: cor.hex,
                      cursor: 'pointer',
                      border: crud.form.cor === cor.hex ? '3px solid var(--text)' : '1px solid var(--border)',
                    }}
                  />
                ))}
              </div>
            </Campo>
            <div className="linha-check">
              <input
                id="ativo"
                type="checkbox"
                checked={Boolean(crud.form.ativo)}
                onChange={(e) => crud.setForm({ ...crud.form, ativo: e.target.checked ? 1 : 0 })}
              />
              <label htmlFor="ativo">Cartão ativo (aparece nos formulários de lançamento)</label>
            </div>
          </>
        )}
      </Modal>

      {limpando && (
        <ModalLimpeza
          cartao={limpando}
          mes={mes}
          aoFechar={() => setLimpando(null)}
          aoConcluir={(resultado) => {
            setLimpando(null);
            consulta.recarregar();
            resumo.recarregar();
            listaEncargos.recarregar();
            aviso(`${resultado.quantidade} registros apagados de "${resultado.cartao.nome}".`);
          }}
        />
      )}

      {dialogo}
    </>
  );
}

const ROTULO_TABELA = {
  lancamentos: 'Gastos avulsos',
  parcelamentos: 'Parcelamentos',
  encargos: 'Juros e encargos',
};

/**
 * Apagar os gastos de um cartão sem apagar o cartão.
 *
 * A prévia vem do servidor a cada mudança de recorte, e é ela — não o texto do
 * botão — que diz o que vai sumir. O parcelamento é uma linha só que atravessa
 * meses: por isso, no recorte de um mês, existe a opção de preservá-lo em vez
 * de deixar a limpeza de agosto levar setembro junto.
 */
function ModalLimpeza({ cartao, mes, aoFechar, aoConcluir }) {
  const [escopo, setEscopo] = useState('mes');
  const [competencia, setCompetencia] = useState(mes);
  const [soAvulsos, setSoAvulsos] = useState(false);
  const [apagando, setApagando] = useState(false);
  const [erro, setErro] = useState(null);

  // Com o campo de mês vazio a busca não sai: sem o recorte, o servidor
  // responderia pelo cartão inteiro e a prévia mentiria sobre o que vai sumir.
  const mesValido = escopo !== 'mes' || /^\d{4}-(0[1-9]|1[0-2])$/.test(competencia || '');
  const previa = useDados(
    () => (mesValido
      ? api.get(`/cartoes/${cartao.id}/limpeza`, {
        mes: escopo === 'mes' ? competencia : undefined,
        so_avulsos: soAvulsos ? '1' : undefined,
      })
      : null),
    [cartao.id, escopo, competencia, soAvulsos],
  );

  const apagar = async () => {
    setApagando(true);
    setErro(null);
    try {
      aoConcluir(await api.post(`/cartoes/${cartao.id}/limpeza`, {
        mes: escopo === 'mes' ? competencia : null,
        so_avulsos: soAvulsos,
      }));
    } catch (e) {
      setErro(e.message);
      setApagando(false);
    }
  };

  const quantidade = previa.dados?.quantidade;
  const recorrentesNoMes = escopo === 'mes' && !soAvulsos && previa.dados
    && previa.dados.itens.parcelamentos.quantidade > 0;

  const rotuloBotao = () => {
    if (!mesValido) return 'Informe o mês';
    if (quantidade === undefined) return 'Apagar';
    if (quantidade === 0) return 'Nada a apagar';
    return `Apagar ${quantidade} ${quantidade === 1 ? 'registro' : 'registros'}`;
  };

  return (
    <Modal
      aberto
      titulo={`Limpar gastos de ${cartao.nome}`}
      aoFechar={aoFechar}
      aoSalvar={apagar}
      salvando={apagando}
      salvarDesabilitado={!mesValido || !quantidade || previa.carregando}
      erro={erro}
      perigo
      rotuloSalvar={rotuloBotao()}
      rotuloSalvando="Apagando…"
    >
      <p style={{ margin: '0 0 14px', fontSize: 13.5, color: 'var(--text-2)' }}>
        O cadastro do cartão continua — saem só os gastos. Uma cópia do banco é gravada
        em <code>data/</code> antes de apagar, e a planilha pode ser reimportada depois.
      </p>

      <Campo rotulo="O que apagar">
        <select value={escopo} onChange={(e) => setEscopo(e.target.value)}>
          <option value="mes">Só um mês</option>
          <option value="tudo">Todos os meses deste cartão</option>
        </select>
      </Campo>

      {escopo === 'mes' && (
        <Campo rotulo="Mês" dica={`Começa no mês aberto na tela (${rotuloMes(mes, { curto: true })})`}>
          <input type="month" value={competencia} onChange={(e) => setCompetencia(e.target.value)} />
        </Campo>
      )}

      <div className="linha-check">
        <input
          id="so-avulsos"
          type="checkbox"
          checked={soAvulsos}
          onChange={(e) => setSoAvulsos(e.target.checked)}
        />
        <label htmlFor="so-avulsos">Só gastos avulsos (mantém os parcelamentos)</label>
      </div>

      {recorrentesNoMes && (
        <div className="aviso" style={{ marginTop: 12 }}>
          <b>Parcelamento não pertence a um mês só.</b> Apagar os que passam por{' '}
          {rotuloMes(competencia, { curto: true })} remove também as parcelas dos outros meses.
          Marque a opção acima para preservá-los.
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <div className="rotulo" style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 6 }}>
          O que será apagado
        </div>
        <Estado carregando={previa.carregando} erro={previa.erro}>
          {previa.dados && (
            <div className="rolagem">
              <table>
                <thead>
                  <tr><th>Tipo</th><th className="num">Registros</th><th className="num">Valor</th></tr>
                </thead>
                <tbody>
                  {Object.entries(previa.dados.itens).map(([tabela, i]) => (
                    <tr key={tabela} className={i.quantidade === 0 ? 'fraco' : undefined}>
                      <td>{ROTULO_TABELA[tabela]}</td>
                      <td className="num">{i.quantidade}</td>
                      <td className="num">{brl(i.total)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td><b>Total</b></td>
                    <td className="num"><b>{previa.dados.quantidade}</b></td>
                    <td className="num"><b>{brl(previa.dados.total)}</b></td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </Estado>
        <div className="dica" style={{ marginTop: 6 }}>
          {escopo === 'mes'
            ? `Valores como pesam na fatura de ${rotuloMes(competencia, { curto: true })}.`
            : 'Parcelamentos contam a compra inteira, não só a parcela do mês.'}
        </div>
      </div>
    </Modal>
  );
}
