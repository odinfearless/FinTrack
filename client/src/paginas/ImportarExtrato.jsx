import { useRef, useState } from 'react';
import { api, enviarArquivo, recurso } from '../api.js';
import { useMes } from '../App.jsx';
import {
  brl, dataBR, rotuloMes, somarMeses, vigencia,
} from '../formato.js';
import { useCadastros, opcoesCategoria } from '../cadastros.js';
import {
  Campo, EntradaMoeda, useAviso, useDados, Valor, Vazio,
} from '../componentes.jsx';

const contasBancarias = recurso('contas-bancarias');

const DESTINOS = [
  { valor: 'receita', texto: 'Receita' },
  { valor: 'conta', texto: 'Conta fixa' },
  { valor: 'gasto', texto: 'Gasto avulso' },
];

// As mesmas opções das telas de Contas e de Gastos: o que entra por aqui tem
// que caber nos mesmos selects depois, na hora de editar.
const FORMAS_CONTA = ['D.AUTO', 'Boleto', 'Pix', 'Débito', 'Dinheiro'];
const FORMAS_GASTO = ['Pix', 'Transferência', 'Dinheiro', 'Boleto', 'Débito'];
const TIPOS_RECEITA = [
  { valor: 'fixa', texto: 'Fixa' },
  { valor: 'variavel', texto: 'Variável' },
  { valor: 'ajuste', texto: 'Ajuste' },
];

/** O extrato pode trazer uma forma que a tela de destino não lista; ela entra
 *  na lista em vez de sumir, senão o select apareceria em branco. */
const comAtual = (lista, atual) => (atual && !lista.includes(atual) ? [atual, ...lista] : lista);

/**
 * Até quando o registro vale — a mesma regra que o servidor aplica ao gravar,
 * repetida aqui só para a tela poder mostrar a vigência antes de confirmar.
 */
function fimDe(item) {
  if (item.recorrente) return null;
  const { parcela } = item;
  if (parcela && parcela.total > parcela.atual) {
    return somarMeses(item.mes, parcela.total - parcela.atual);
  }
  return item.mes;
}

const isoDeBR = (v) => (v && /^\d{2}\/\d{2}\/\d{4}$/.test(v) ? v.split('/').reverse().join('-') : null);

/** Nome sugerido para a conta lida: o que basta para distingui-la de outra. */
function nomeSugerido(conta) {
  const partes = [conta.banco || 'Conta', conta.agencia, conta.numero].filter(Boolean);
  return partes.slice(0, 2).join(' ');
}

export default function ImportarExtrato({ aoImportar }) {
  const { mes: mesGlobal } = useMes();
  const aviso = useAviso();
  const cadastros = useCadastros();
  const contas = useDados(() => api.get('/contas-bancarias'), []);
  const entradaArquivo = useRef(null);

  const [arquivo, setArquivo] = useState(null);
  const [lendo, setLendo] = useState(false);
  const [gravando, setGravando] = useState(false);
  const [salvandoConta, setSalvandoConta] = useState(false);
  const [erro, setErro] = useState(null);
  const [leitura, setLeitura] = useState(null);
  const [itens, setItens] = useState([]);
  const [contaId, setContaId] = useState('');
  const [arrastando, setArrastando] = useState(false);

  const categorias = opcoesCategoria(cadastros.dados?.categorias);
  const listaContas = contas.dados || [];

  const escolher = (lista) => {
    const f = lista?.[0];
    if (!f) return;
    setArquivo(f);
    setErro(null);
    setLeitura(null);
    setItens([]);
  };

  const ler = async () => {
    if (!arquivo) return;
    setLendo(true);
    setErro(null);
    try {
      const r = await enviarArquivo('/extrato/ler', arquivo, { mes: mesGlobal });
      setLeitura(r);
      setItens(r.itens);
      setContaId(r.conta_bancaria ? String(r.conta_bancaria.id) : '');
      if (r.itens.length === 0) aviso('Nenhum lançamento foi reconhecido no extrato.', 'erro');
      else aviso(`${r.itens.length} lançamentos lidos. Confira o destino de cada um antes de importar.`);
    } catch (e) {
      setErro(e.message);
    } finally {
      setLendo(false);
    }
  };

  const alterar = (id, mudanca) => setItens(
    (atuais) => atuais.map((i) => (i.id === id ? { ...i, ...mudanca } : i)),
  );

  /**
   * Trocar o destino muda o sinal do que será gravado.
   *
   * Em `receitas` o valor negativo tem significado próprio — é o ajuste, o
   * juro do limite que abate a renda. Em `contas` e em `lancamentos` a despesa
   * é sempre positiva, e o menos ali significaria estorno. Por isso o sinal do
   * extrato só sobrevive do lado da receita.
   */
  const trocarDestino = (item, destino) => {
    const modulo = Math.abs(Number(item.valor) || 0);
    const mudanca = { destino };

    if (destino === 'receita') {
      mudanca.valor = item.valor_extrato < 0 ? -modulo : modulo;
      mudanca.tipo = item.tipo || (item.valor_extrato < 0 ? 'ajuste' : 'variavel');
    } else {
      mudanca.valor = modulo;
      const lista = destino === 'conta' ? FORMAS_CONTA : FORMAS_GASTO;
      mudanca.forma = lista.includes(item.forma) ? item.forma : lista[0];
      // Gasto avulso vive num mês só; a vigência é assunto de conta e receita.
      if (destino === 'gasto') mudanca.recorrente = false;
    }

    alterar(item.id, mudanca);
  };

  const marcarTodos = (valor) => setItens((atuais) => atuais.map((i) => ({ ...i, selecionado: valor })));

  const selecionados = itens.filter((i) => i.selecionado);
  const somar = (destino) => selecionados
    .filter((i) => i.destino === destino)
    .reduce((t, i) => t + (Number(i.valor) || 0), 0);

  const totalReceitas = somar('receita');
  const totalContas = somar('conta');
  const totalGastos = somar('gasto');

  const duplicatas = itens.filter((i) => i.duplicata).length;
  const comAlerta = itens.filter((i) => i.alerta).length;
  const incompletos = selecionados.filter(
    (i) => !String(i.descricao || '').trim() || !Number(i.valor),
  ).length;

  const meses = [...new Set(selecionados.map((i) => i.mes).filter(Boolean))].sort();

  const conta = leitura?.conta;
  const jaCadastrada = listaContas.some((c) => String(c.id) === String(contaId));

  const salvarConta = async () => {
    setSalvandoConta(true);
    try {
      const corpo = {
        banco: conta.banco,
        agencia: conta.agencia,
        numero: conta.numero,
        saldo: conta.saldo,
        limite_total: conta.limite_total,
        limite_usado: conta.limite_usado,
        saldo_em: isoDeBR(conta.periodo_fim),
      };
      const salva = jaCadastrada
        ? await contasBancarias.atualizar(contaId, corpo)
        : await contasBancarias.criar({ ...corpo, nome: nomeSugerido(conta) });
      setContaId(String(salva.id));
      contas.recarregar();
      aviso(jaCadastrada ? 'Saldo e limites atualizados.' : `Conta "${salva.nome}" cadastrada.`);
    } catch (e) {
      aviso(e.message, 'erro');
    } finally {
      setSalvandoConta(false);
    }
  };

  const confirmar = async () => {
    setGravando(true);
    setErro(null);
    try {
      const r = await api.post('/extrato/confirmar', {
        mes: mesGlobal,
        conta_bancaria_id: contaId || null,
        itens: selecionados,
      });
      aviso(`${r.total} lançamentos importados: ${r.criados.receitas} receitas, `
        + `${r.criados.contas} contas e ${r.criados.gastos} gastos.`);
      setLeitura(null);
      setItens([]);
      setArquivo(null);
      if (entradaArquivo.current) entradaArquivo.current.value = '';
      aoImportar?.();
    } catch (e) {
      setErro(e.message);
      aviso(e.message, 'erro');
    } finally {
      setGravando(false);
    }
  };

  return (
    <div className="cartao">
      <div className="cartao-titulo">Importar extrato da conta corrente</div>
      <div className="cartao-legenda">
        Envie o PDF do extrato e o sistema separa sozinho o que entrou do que saiu:{' '}
        <b>dinheiro que entrou vira receita</b>, <b>débito de concessionária vira conta</b> e o{' '}
        <b>resto vira gasto avulso</b>. Tudo aparece para conferência — nada entra no banco antes
        de você confirmar, e o destino de cada linha é trocável aqui mesmo.
      </div>

      <div
        onDragOver={(e) => { e.preventDefault(); setArrastando(true); }}
        onDragLeave={() => setArrastando(false)}
        onDrop={(e) => { e.preventDefault(); setArrastando(false); escolher(e.dataTransfer.files); }}
        onClick={() => entradaArquivo.current?.click()}
        style={{
          border: `2px dashed ${arrastando ? 'var(--s1)' : 'var(--border)'}`,
          background: arrastando ? 'color-mix(in srgb, var(--s1) 8%, transparent)' : 'var(--surface-2)',
          borderRadius: 12,
          padding: '26px 20px',
          textAlign: 'center',
          cursor: 'pointer',
          marginBottom: 14,
        }}
      >
        <div style={{ fontSize: 24, marginBottom: 6 }} aria-hidden="true">⇪</div>
        <div style={{ fontSize: 14, fontWeight: 600 }}>
          {arquivo ? arquivo.name : 'Arraste o extrato aqui ou clique para escolher'}
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4 }}>
          {arquivo
            ? `${Math.round(arquivo.size / 1024)} KB — clique para trocar`
            : 'Só PDF, e o baixado do banco — num print não dá para saber se um número é o valor '
              + 'do lançamento ou o saldo do dia. Até 15 MB.'}
        </div>
        <input
          ref={entradaArquivo}
          type="file"
          accept=".pdf"
          style={{ display: 'none' }}
          onChange={(e) => escolher(e.target.files)}
        />
      </div>

      {erro && <div className="erro" style={{ marginBottom: 14 }}>{erro}</div>}

      <button
        type="button"
        className="botao primario"
        onClick={ler}
        disabled={!arquivo || lendo}
      >
        {lendo ? 'Lendo o extrato…' : 'Ler lançamentos'}
      </button>

      {leitura && itens.length === 0 && (
        <Vazio titulo="Nenhum lançamento reconhecido">
          O arquivo foi lido ({leitura.linhas_lidas} linhas), mas nenhuma tinha o formato de data,
          descrição e valor na coluna de lançamentos.
        </Vazio>
      )}

      {itens.length > 0 && (
        <div style={{ marginTop: 20 }}>
          {/* -------------------------- conta do extrato ---------------------- */}
          <div className="cartao-titulo">A conta deste extrato</div>
          <div className="cartao-legenda">
            Vincular os lançamentos a uma conta é o que deixa o app dizer depois de onde cada
            débito sai. O nome do titular e o CPF que vêm no topo do arquivo não são lidos.
          </div>

          <div className="grade g4" style={{ marginBottom: 14 }}>
            <div>
              <div style={{ fontSize: 12.5, color: 'var(--text-2)' }}>Banco</div>
              <div style={{ fontSize: 17, fontWeight: 650 }}>{conta.banco || '—'}</div>
            </div>
            <div>
              <div style={{ fontSize: 12.5, color: 'var(--text-2)' }}>Agência / conta</div>
              <div style={{ fontSize: 17, fontWeight: 650 }}>
                {[conta.agencia, conta.numero].filter(Boolean).join(' / ') || '—'}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 12.5, color: 'var(--text-2)' }}>Saldo no extrato</div>
              <div style={{ fontSize: 17, fontWeight: 650 }}>
                {conta.saldo === null ? '—' : <Valor v={conta.saldo} />}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 12.5, color: 'var(--text-2)' }}>Limite usado</div>
              <div style={{ fontSize: 17, fontWeight: 650 }}>
                {conta.limite_usado === null ? '—' : brl(conta.limite_usado)}
                {conta.limite_total !== null && (
                  <span className="fraco" style={{ fontSize: 12.5 }}> de {brl(conta.limite_total)}</span>
                )}
              </div>
            </div>
          </div>

          <div className="dupla" style={{ marginBottom: 14 }}>
            <Campo rotulo="Vincular a" dica="Opcional — os lançamentos entram mesmo sem conta">
              <select value={contaId} onChange={(e) => setContaId(e.target.value)}>
                <option value="">Nenhuma conta</option>
                {listaContas.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
              </select>
            </Campo>
            <Campo rotulo="&nbsp;" dica={leitura.conta_bancaria ? 'Reconhecida pela agência e pelo número' : undefined}>
              <button
                type="button"
                className="botao"
                onClick={salvarConta}
                disabled={salvandoConta || (!jaCadastrada && !conta.banco && !conta.numero)}
              >
                {jaCadastrada
                  ? 'Atualizar saldo e limites desta conta'
                  : `Cadastrar "${nomeSugerido(conta)}"`}
              </button>
            </Campo>
          </div>

          {/* --------------------------- conferência -------------------------- */}
          {leitura.conferencia && (
            <div
              className={leitura.conferencia.confere ? 'aviso' : 'erro'}
              style={{ marginBottom: 14 }}
            >
              {leitura.conferencia.confere ? (
                <>
                  <b>O extrato fecha.</b> As linhas lidas somam {brl(leitura.conferencia.movimento)},
                  e o saldo da conta variou exatamente isso entre {dataBR(leitura.conferencia.data_inicial)} e{' '}
                  {dataBR(leitura.conferencia.data_final)} — de {brl(leitura.conferencia.inicial)} para{' '}
                  {brl(leitura.conferencia.final)}. Nenhum lançamento ficou para trás.
                </>
              ) : (
                <>
                  <b>Não fecha com o extrato: diferença de {brl(Math.abs(leitura.conferencia.diferenca))}.</b>{' '}
                  As linhas lidas somam {brl(leitura.conferencia.movimento)}, mas o saldo da conta variou{' '}
                  {brl(leitura.conferencia.variacao)} no período. Confira as linhas ignoradas no fim da
                  página — alguma pode não ter sido reconhecida.
                </>
              )}
            </div>
          )}

          {!leitura.colunas_detectadas && (
            <div className="aviso" style={{ marginBottom: 14 }}>
              <b>O cabeçalho "valor / saldo" não foi encontrado neste layout.</b> Sem ele, todo número
              da linha foi lido como lançamento — confira se algum saldo do dia entrou como despesa e
              desmarque o que não for movimento.
            </div>
          )}

          {meses.length > 1 && (
            <div className="aviso" style={{ marginBottom: 14 }}>
              <b>Este extrato atravessa {meses.length} competências</b> ({meses.map((m) => rotuloMes(m, { curto: true })).join(', ')}).
              Cada lançamento entra no mês da própria data — é o que mantém o salário do dia 6 no mês
              em que ele caiu. Para mudar um, basta mudar a data dele aqui na tabela.
            </div>
          )}

          {comAlerta > 0 && (
            <div className="aviso" style={{ marginBottom: 14 }}>
              <b>{comAlerta} {comAlerta === 1 ? 'linha veio desmarcada' : 'linhas vieram desmarcadas'} com
              um porquê.</b> Pagamento de fatura de cartão e aplicação/resgate não são gasto nem ganho
              novo: o motivo aparece ao lado da descrição. Marque só se souber que é o caso.
            </div>
          )}

          {duplicatas > 0 && (
            <div className="aviso" style={{ marginBottom: 14 }}>
              <b>{duplicatas} {duplicatas === 1 ? 'lançamento já existe' : 'lançamentos já existem'}</b> no
              app com a mesma descrição. Vieram desmarcados para você não importar em dobro — nas contas,
              basta o nome bater, porque cadastrar a segunda faria as duas somarem no painel.
            </div>
          )}

          {incompletos > 0 && (
            <div className="erro" style={{ marginBottom: 14 }}>
              <b>{incompletos} {incompletos === 1 ? 'linha marcada está' : 'linhas marcadas estão'} sem
              descrição ou sem valor.</b> Complete ou desmarque: o banco recusaria, e a contagem final
              não bateria com o que está na tela.
            </div>
          )}

          {/* ----------------------------- tabela ----------------------------- */}
          <div className="filtros" style={{ marginBottom: 10 }}>
            <button type="button" className="botao pequeno" onClick={() => marcarTodos(true)}>
              Marcar todos
            </button>
            <button type="button" className="botao pequeno" onClick={() => marcarTodos(false)}>
              Desmarcar todos
            </button>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 13.5, color: 'var(--text-2)' }}>
              {selecionados.length} selecionados · receitas{' '}
              <b style={{ color: 'var(--text)' }}>{brl(totalReceitas)}</b> · contas{' '}
              <b style={{ color: 'var(--text)' }}>{brl(totalContas)}</b> · gastos{' '}
              <b style={{ color: 'var(--text)' }}>{brl(totalGastos)}</b>
            </span>
          </div>

          <div className="rolagem">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 34 }} />
                  <th>Data</th>
                  <th>Descrição</th>
                  <th>Destino</th>
                  <th>Forma / tipo</th>
                  <th>Categoria</th>
                  <th>Vigência</th>
                  <th className="num">Valor</th>
                </tr>
              </thead>
              <tbody>
                {itens.map((i) => {
                  const ehReceita = i.destino === 'receita';
                  const ehGasto = i.destino === 'gasto';
                  return (
                    <tr key={i.id} style={i.selecionado ? undefined : { opacity: 0.5 }}>
                      <td>
                        <input
                          type="checkbox"
                          checked={i.selecionado}
                          aria-label={`Importar ${i.descricao}`}
                          onChange={(e) => alterar(i.id, { selecionado: e.target.checked })}
                        />
                      </td>
                      <td>
                        {/* A competência acompanha a data: mudar o dia aqui move
                            o lançamento de mês, e o rótulo abaixo mostra para
                            onde ele foi. */}
                        <input
                          type="date"
                          value={i.data || ''}
                          onChange={(e) => alterar(i.id, {
                            data: e.target.value || null,
                            mes: e.target.value ? e.target.value.slice(0, 7) : mesGlobal,
                          })}
                          style={{ width: 150 }}
                          aria-label={`Data de ${i.descricao}`}
                        />
                        <div className="fraco" style={{ fontSize: 12 }}>{rotuloMes(i.mes, { curto: true })}</div>
                      </td>
                      <td style={{ minWidth: 210 }}>
                        <input
                          value={i.descricao}
                          onChange={(e) => alterar(i.id, { descricao: e.target.value })}
                          title={i.linha_original}
                        />
                        <div>
                          {/* O que a linha era no extrato, e não o que vai ser
                              gravado: depois de trocar o destino, é isto que
                              permite conferir contra o documento. */}
                          <span
                            className={`etiqueta ${i.entrada ? 'credito' : ''}`}
                            style={{ marginTop: 4 }}
                          >
                            {i.entrada ? 'entrou' : 'saiu'} {brl(Math.abs(i.valor_extrato))}
                          </span>
                          {i.duplicata && <span className="etiqueta" style={{ marginTop: 4 }}>já existe</span>}
                          {i.repetida && <span className="etiqueta" style={{ marginTop: 4 }}>linha repetida</span>}
                          {i.parcela && (
                            <span className="etiqueta" style={{ marginTop: 4 }}>
                              parcela {i.parcela.atual}/{i.parcela.total}
                            </span>
                          )}
                        </div>
                        {i.alerta && (
                          <div className="fraco" style={{ fontSize: 12, marginTop: 4, maxWidth: 320 }}>
                            {i.alerta}
                          </div>
                        )}
                        {i.existente && (
                          <div className="fraco" style={{ fontSize: 12, marginTop: 4 }}>
                            Já cadastrada por {brl(i.existente.valor)} ·{' '}
                            {vigencia(i.existente.mes_inicio, i.existente.mes_fim)}
                          </div>
                        )}
                      </td>
                      <td>
                        <select
                          value={i.destino}
                          onChange={(e) => trocarDestino(i, e.target.value)}
                          style={{ minWidth: 130 }}
                          aria-label={`Destino de ${i.descricao}`}
                        >
                          {DESTINOS.map((d) => <option key={d.valor} value={d.valor}>{d.texto}</option>)}
                        </select>
                      </td>
                      <td>
                        {ehReceita ? (
                          <select
                            value={i.tipo}
                            onChange={(e) => alterar(i.id, { tipo: e.target.value })}
                            style={{ minWidth: 110 }}
                            aria-label={`Tipo de ${i.descricao}`}
                          >
                            {TIPOS_RECEITA.map((t) => <option key={t.valor} value={t.valor}>{t.texto}</option>)}
                          </select>
                        ) : (
                          <select
                            value={i.forma || ''}
                            onChange={(e) => alterar(i.id, { forma: e.target.value })}
                            style={{ minWidth: 110 }}
                            aria-label={`Forma de ${i.descricao}`}
                          >
                            {comAtual(ehGasto ? FORMAS_GASTO : FORMAS_CONTA, i.forma)
                              .map((f) => <option key={f} value={f}>{f}</option>)}
                          </select>
                        )}
                      </td>
                      <td>
                        {ehReceita ? <span className="fraco">—</span> : (
                          <select
                            value={i.categoria_id || ''}
                            onChange={(e) => alterar(i.id, {
                              categoria_id: e.target.value ? Number(e.target.value) : null,
                            })}
                            style={{ minWidth: 130 }}
                            aria-label={`Categoria de ${i.descricao}`}
                          >
                            <option value="">Sem categoria</option>
                            {categorias.map((o) => <option key={o.valor} value={o.valor}>{o.texto}</option>)}
                          </select>
                        )}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {ehGasto ? <span className="fraco">só neste mês</span> : (
                          <>
                            <div className="linha-check">
                              <input
                                id={`repete-${i.id}`}
                                type="checkbox"
                                checked={Boolean(i.recorrente)}
                                onChange={(e) => alterar(i.id, { recorrente: e.target.checked })}
                              />
                              <label htmlFor={`repete-${i.id}`} style={{ fontSize: 12.5 }}>repete</label>
                            </div>
                            {/* "vale" na frente porque a linha fica logo abaixo
                                da caixinha "repete", e sem ele as duas se leem
                                como uma frase só. */}
                            <div className="fraco" style={{ fontSize: 12 }}>
                              vale {vigencia(i.mes, fimDe(i))}
                            </div>
                          </>
                        )}
                      </td>
                      <td className="num">
                        <EntradaMoeda
                          valor={i.valor}
                          aoMudar={(v) => alterar(i.id, { valor: v })}
                          style={{ width: 108, textAlign: 'right' }}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="aviso" style={{ marginTop: 14 }}>
            <b>Receita</b> é dinheiro que entrou; com valor negativo ela vira desconto recorrente,
            que é onde cabe um consignado descontado todo mês.{' '}
            <b>Conta fixa</b> é o débito com nome e valor próprios — luz, água, telefone, seguro, e
            também juros e IOF do banco — e fica cadastrada uma vez só.{' '}
            <b>Gasto avulso</b> é o que aconteceu uma vez, como um Pix para alguém.{' '}
            Tudo entra valendo <b>só no mês do lançamento</b>: o extrato mostra um mês, e afirmar a
            partir dele que a conta de luz vale para sempre espalharia pela projeção um valor que
            muda toda fatura. Marque <b>repete</b> no que for igual todo mês. Onde o extrato diz a
            parcela ("11/12"), a vigência já vem fechada até a última.
          </div>

          <div style={{ display: 'flex', gap: 9, marginTop: 16, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="botao primario"
              onClick={confirmar}
              disabled={gravando || selecionados.length === 0 || incompletos > 0}
              title={incompletos > 0 ? 'Complete a descrição e o valor das linhas marcadas' : undefined}
            >
              {gravando ? 'Importando…' : `Importar ${selecionados.length} lançamentos`}
            </button>
            <button type="button" className="botao" onClick={() => { setLeitura(null); setItens([]); }}>
              Descartar leitura
            </button>
          </div>

          {leitura.descartadas.length > 0 && (
            <details style={{ marginTop: 16 }}>
              <summary>
                Ver as {leitura.descartadas.length} linhas ignoradas (saldo do dia, cabeçalho, rodapé)
              </summary>
              <div className="rolagem" style={{ marginTop: 10 }}>
                <table>
                  <thead><tr><th>Linha do arquivo</th><th>Motivo</th></tr></thead>
                  <tbody>
                    {leitura.descartadas.map((d) => (
                      <tr key={`${d.linha}-${d.texto}`}>
                        <td className="fraco" style={{ fontSize: 12.5 }}>{d.texto}</td>
                        <td className="fraco">{d.motivo}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
