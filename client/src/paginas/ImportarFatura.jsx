import { useRef, useState } from 'react';
import { api, enviarArquivo } from '../api.js';
import { useMes } from '../App.jsx';
import { brl, rotuloMes } from '../formato.js';
import { useCadastros, opcoesCartao, opcoesCategoria } from '../cadastros.js';
import { Campo, EntradaMoeda, useAviso, Valor, Vazio } from '../componentes.jsx';

const TIPOS = [
  { valor: 'avulso', texto: 'Compra avulsa' },
  { valor: 'parcelamento', texto: 'Parcelada' },
];

const EXTENSOES = '.pdf,.png,.jpg,.jpeg,.webp,.bmp,.tif,.tiff';

export default function ImportarFatura({ aoImportar }) {
  const { mes: mesGlobal } = useMes();
  const aviso = useAviso();
  const cadastros = useCadastros();
  const entradaArquivo = useRef(null);

  const [mes, setMes] = useState(mesGlobal);
  const [cartaoId, setCartaoId] = useState('');
  const [arquivo, setArquivo] = useState(null);
  const [lendo, setLendo] = useState(false);
  const [gravando, setGravando] = useState(false);
  const [erro, setErro] = useState(null);
  const [leitura, setLeitura] = useState(null);
  const [itens, setItens] = useState([]);
  const [arrastando, setArrastando] = useState(false);
  const [verDescartadas, setVerDescartadas] = useState(false);

  const cartoes = opcoesCartao(cadastros.dados?.cartoes);
  const categorias = opcoesCategoria(cadastros.dados?.categorias);

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
      const r = await enviarArquivo('/fatura/ler', arquivo, { mes, cartao_id: cartaoId });
      setLeitura(r);
      setItens(r.itens);
      if (r.itens.length === 0) {
        aviso('Nenhum lançamento foi reconhecido no arquivo.', 'erro');
      } else if (r.marcacao === 'arquivo') {
        aviso(`${r.regioes_usadas} áreas marcadas no arquivo · ${r.itens.length} lançamentos lidos.`);
      } else {
        aviso(`${r.itens.length} lançamentos reconhecidos. Revise antes de importar.`);
      }
    } catch (e) {
      setErro(e.message);
    } finally {
      setLendo(false);
    }
  };

  const alterar = (id, mudanca) => setItens(
    (atuais) => atuais.map((i) => (i.id === id ? { ...i, ...mudanca } : i)),
  );

  const marcarTodos = (valor) => setItens((atuais) => atuais.map((i) => ({ ...i, selecionado: valor })));

  const selecionados = itens.filter((i) => i.selecionado);
  const total = selecionados.reduce((t, i) => t + (Number(i.valor) || 0), 0);
  const duplicatas = itens.filter((i) => i.duplicata).length;

  // Quando a fatura declara o próprio total, a diferença é o melhor sinal de
  // que alguma linha ficou para trás — ou de que entrou o que não devia.
  const totalFatura = leitura?.total_fatura ?? null;
  const diferenca = totalFatura === null ? null : Math.round((total - totalFatura) * 100) / 100;

  const confirmar = async () => {
    setGravando(true);
    setErro(null);
    try {
      const r = await api.post('/fatura/confirmar', { mes, cartao_id: cartaoId, itens: selecionados });
      aviso(`${r.total} lançamentos importados para ${r.cartao}.`);
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
      <div className="cartao-titulo">Importar fatura em PDF ou imagem</div>
      <div className="cartao-legenda">
        O sistema lê os lançamentos do arquivo e mostra tudo para você conferir. Nada entra no
        banco antes de você confirmar.
      </div>

      <div className="dupla" style={{ marginBottom: 14 }}>
        <Campo rotulo="Cartão da fatura">
          <select value={cartaoId} onChange={(e) => setCartaoId(e.target.value)}>
            <option value="">Selecione…</option>
            {cartoes.map((o) => <option key={o.valor} value={o.valor}>{o.texto}</option>)}
          </select>
        </Campo>
        <Campo rotulo="Mês da fatura" dica="Usado para completar o ano das datas">
          <input type="month" value={mes} onChange={(e) => setMes(e.target.value)} />
        </Campo>
      </div>

      {cartoes.length === 0 && (
        <div className="aviso" style={{ marginBottom: 14 }}>
          <b>Cadastre um cartão primeiro.</b> Os lançamentos da fatura precisam de um cartão de destino.
        </div>
      )}

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
          {arquivo ? arquivo.name : 'Arraste a fatura aqui ou clique para escolher'}
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4 }}>
          {arquivo
            ? `${Math.round(arquivo.size / 1024)} KB — clique para trocar`
            : 'PDF com texto selecionável, ou foto/print da fatura (PNG, JPG). Até 15 MB.'}
        </div>
        <input
          ref={entradaArquivo}
          type="file"
          accept={EXTENSOES}
          style={{ display: 'none' }}
          onChange={(e) => escolher(e.target.files)}
        />
      </div>

      {erro && <div className="erro" style={{ marginBottom: 14 }}>{erro}</div>}

      <button
        type="button"
        className="botao primario"
        onClick={ler}
        disabled={!arquivo || lendo || !cartaoId}
      >
        {lendo ? 'Lendo o arquivo…' : 'Ler lançamentos'}
      </button>
      {lendo && arquivo && !/\.pdf$/i.test(arquivo.name) && (
        <span style={{ marginLeft: 12, fontSize: 12.5, color: 'var(--muted)' }}>
          Imagens levam mais tempo — o reconhecimento de texto roda na sua máquina.
        </span>
      )}

      {leitura && itens.length === 0 && (
        <Vazio titulo="Nenhum lançamento reconhecido">
          O arquivo foi lido ({leitura.linhas_lidas} linhas), mas nenhuma linha tinha o formato
          de data, descrição e valor. Se for um PDF escaneado, envie como imagem.
        </Vazio>
      )}

      {itens.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <div className="cartao-titulo">Confira antes de importar</div>
          <div className="cartao-legenda">
            {itens.length} lançamentos reconhecidos em {leitura.arquivo}
            {leitura.marcacao === 'arquivo'
              && `, dentro das ${leitura.regioes_usadas} áreas circuladas em vermelho no arquivo`}
            {leitura.origem === 'imagem' && ' (via reconhecimento de texto — vale conferir os valores com atenção)'}
            . Descrição e valor são editáveis aqui mesmo.
          </div>

          {duplicatas > 0 && (
            <div className="aviso" style={{ marginBottom: 14 }}>
              <b>{duplicatas} lançamentos já parecem existir</b> neste mês e neste cartão, com a mesma
              descrição e valor. Eles vieram desmarcados para você não importar em dobro.
            </div>
          )}

          <div className="filtros" style={{ marginBottom: 10 }}>
            <button type="button" className="botao pequeno" onClick={() => marcarTodos(true)}>
              Marcar todos
            </button>
            <button type="button" className="botao pequeno" onClick={() => marcarTodos(false)}>
              Desmarcar todos
            </button>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 13.5, color: 'var(--text-2)' }}>
              {selecionados.length} selecionados · <b style={{ color: 'var(--text)' }}><Valor v={total} /></b>
              {totalFatura !== null && <> · fatura {brl(totalFatura)}</>}
            </span>
          </div>

          {diferenca !== null && (
            <div
              className={diferenca === 0 ? 'aviso' : 'erro'}
              style={{ marginBottom: 14 }}
            >
              {diferenca === 0
                ? <><b>Fecha com a fatura.</b> O que está selecionado soma exatamente {brl(totalFatura)}.</>
                : (
                  <>
                    <b>Não fecha com a fatura: {diferenca > 0 ? 'sobram' : 'faltam'} {brl(Math.abs(diferenca))}.</b>{' '}
                    O documento declara {brl(totalFatura)} e a seleção soma {brl(total)}. Confira as linhas
                    ignoradas no fim da página — alguma compra pode não ter sido reconhecida — e desmarque
                    o que não for gasto.
                  </>
                )}
            </div>
          )}

          <div className="rolagem">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 34 }} />
                  <th>Data</th>
                  <th>Descrição</th>
                  <th>Categoria</th>
                  <th>Tipo</th>
                  <th>Parcela</th>
                  <th className="num">Valor</th>
                </tr>
              </thead>
              <tbody>
                {itens.map((i) => (
                  <tr key={i.id} style={i.selecionado ? undefined : { opacity: 0.5 }}>
                    <td>
                      <input
                        type="checkbox"
                        checked={i.selecionado}
                        aria-label={`Importar ${i.descricao}`}
                        onChange={(e) => alterar(i.id, { selecionado: e.target.checked })}
                      />
                    </td>
                    <td className="fraco" style={{ whiteSpace: 'nowrap' }}>
                      {i.data ? i.data.split('-').reverse().join('/') : '—'}
                    </td>
                    <td style={{ minWidth: 210 }}>
                      <input
                        value={i.descricao}
                        onChange={(e) => alterar(i.id, { descricao: e.target.value })}
                        title={i.linha_original}
                      />
                      {i.credito && <span className="etiqueta" style={{ marginTop: 4 }}>crédito/estorno</span>}
                      {i.duplicata && <span className="etiqueta" style={{ marginTop: 4 }}>já existe</span>}
                      {i.repetida && <span className="etiqueta" style={{ marginTop: 4 }}>linha repetida</span>}
                    </td>
                    <td>
                      <select
                        value={i.categoria_id || ''}
                        onChange={(e) => alterar(i.id, { categoria_id: e.target.value ? Number(e.target.value) : null })}
                        style={{ minWidth: 130 }}
                      >
                        <option value="">Sem categoria</option>
                        {categorias.map((o) => <option key={o.valor} value={o.valor}>{o.texto}</option>)}
                      </select>
                    </td>
                    <td>
                      <select
                        value={i.tipo}
                        onChange={(e) => alterar(i.id, {
                          tipo: e.target.value,
                          parcelas: e.target.value === 'parcelamento' ? (i.parcelas || 2) : i.parcelas,
                          parcela_atual: e.target.value === 'parcelamento' ? (i.parcela_atual || 1) : i.parcela_atual,
                        })}
                        style={{ minWidth: 130 }}
                      >
                        {TIPOS.map((t) => <option key={t.valor} value={t.valor}>{t.texto}</option>)}
                      </select>
                    </td>
                    <td>
                      {i.tipo === 'parcelamento' ? (
                        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <input
                            type="number"
                            min="1"
                            value={i.parcela_atual || 1}
                            onChange={(e) => alterar(i.id, { parcela_atual: Number(e.target.value) })}
                            style={{ width: 56 }}
                            aria-label="Parcela atual"
                          />
                          <span className="fraco">/</span>
                          <input
                            type="number"
                            min="1"
                            value={i.parcelas || 2}
                            onChange={(e) => alterar(i.id, { parcelas: Number(e.target.value) })}
                            style={{ width: 56 }}
                            aria-label="Total de parcelas"
                          />
                        </span>
                      ) : <span className="fraco">—</span>}
                    </td>
                    <td className="num">
                      <EntradaMoeda
                        valor={i.valor}
                        aoMudar={(v) => alterar(i.id, { valor: v })}
                        style={{ width: 108, textAlign: 'right' }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="aviso" style={{ marginTop: 14 }}>
            <b>Compra avulsa</b> entra só em {rotuloMes(mes, { curto: true })}.{' '}
            <b>Parcelada</b> é cadastrada uma vez e as parcelas seguintes passam a ser calculadas —
            informe a parcela que aparece na fatura e o sistema deduz em que mês a compra começou.{' '}
            Cobrança recorrente (Spotify, academia) entra como compra avulsa do mês, e volta a
            entrar na fatura seguinte.{' '}
            <b>Crédito e estorno</b> vêm com valor negativo e desmarcados: marque-os para que
            abatam a fatura em vez de somar.
          </div>

          <div style={{ display: 'flex', gap: 9, marginTop: 16, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="botao primario"
              onClick={confirmar}
              disabled={gravando || selecionados.length === 0}
            >
              {gravando ? 'Importando…' : `Importar ${selecionados.length} lançamentos`}
            </button>
            <button type="button" className="botao" onClick={() => { setLeitura(null); setItens([]); }}>
              Descartar leitura
            </button>
          </div>

          {leitura.descartadas.length > 0 && (
            <details style={{ marginTop: 16 }} open={verDescartadas} onToggle={(e) => setVerDescartadas(e.target.open)}>
              <summary>
                Ver as {leitura.descartadas.length} linhas ignoradas (totais, pagamentos, rodapés)
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
