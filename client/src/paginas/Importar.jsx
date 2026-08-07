import { useRef, useState } from 'react';
import { api, enviarArquivo } from '../api.js';
import { useMes } from '../App.jsx';
import { num } from '../formato.js';
import { Campo, Estado, useAviso, useDados } from '../componentes.jsx';
import ImportarFatura from './ImportarFatura.jsx';
import ImportarExtrato from './ImportarExtrato.jsx';

const ROTULOS = {
  cartoes: 'Cartões', categorias: 'Categorias', pessoas: 'Pessoas',
  lancamentos: 'Gastos avulsos', parcelamentos: 'Parcelamentos',
  contas: 'Contas', receitas: 'Receitas', encargos: 'Encargos',
  contas_bancarias: 'Contas bancárias',
};

export default function Importar() {
  const aviso = useAviso();
  const { recarregarMeses } = useMes();
  const arquivos = useDados(() => api.get('/importacao/planilhas'), []);
  const estatisticas = useDados(() => api.get('/estatisticas'), []);

  const [arquivo, setArquivo] = useState(null);
  const [daPasta, setDaPasta] = useState('');
  const [ano, setAno] = useState('');
  const [substituir, setSubstituir] = useState(true);
  const [importando, setImportando] = useState(false);
  const [arrastando, setArrastando] = useState(false);
  const [relatorio, setRelatorio] = useState(null);
  const [erro, setErro] = useState(null);
  const entradaArquivo = useRef(null);

  const naPasta = arquivos.dados?.arquivos || [];

  // Escolher um arquivo do computador e escolher um da pasta são caminhos
  // alternativos: marcar um limpa o outro, para não restar dúvida do que vai.
  const escolher = (lista) => {
    const f = lista?.[0];
    if (!f) return;
    setArquivo(f);
    setDaPasta('');
    setErro(null);
  };

  const importar = async () => {
    setImportando(true);
    setErro(null);
    setRelatorio(null);
    try {
      const r = arquivo
        ? await enviarArquivo('/importacao/arquivo', arquivo, { ano, substituir })
        : await api.post('/importacao', { arquivo: daPasta, ano: ano ? Number(ano) : undefined, substituir });
      setRelatorio(r);
      estatisticas.recarregar();
      recarregarMeses();
      arquivos.recarregar();
      aviso('Planilha importada.');
    } catch (e) {
      setErro(e.message);
      aviso(e.message, 'erro');
    } finally {
      setImportando(false);
    }
  };

  return (
    <>
      <ImportarFatura aoImportar={() => { estatisticas.recarregar(); recarregarMeses(); }} />

      <ImportarExtrato aoImportar={() => { estatisticas.recarregar(); recarregarMeses(); }} />

      <div className="cartao">
        <div className="cartao-titulo">Importar uma planilha</div>
        <div className="cartao-legenda">
          Envie qualquer arquivo <code>.xlsx</code> ou <code>.xls</code> do seu computador. A
          planilha precisa ter <b>uma aba por mês</b>, com o nome do mês na aba (Janeiro,
          Fevereiro…) — é assim que cada lançamento sabe a que competência pertence.
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
            {arquivo ? arquivo.name : 'Arraste a planilha aqui ou clique para escolher'}
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4 }}>
            {arquivo
              ? `${Math.round(arquivo.size / 1024)} KB — clique para trocar`
              : 'Arquivo .xlsx ou .xls, até 25 MB. Ele é lido e descartado; nada é salvo em disco.'}
          </div>
          <input
            ref={entradaArquivo}
            type="file"
            accept=".xlsx,.xls"
            style={{ display: 'none' }}
            onChange={(e) => escolher(e.target.files)}
          />
        </div>

        {naPasta.length > 0 && (
          <Campo
            rotulo="Ou use uma planilha da pasta do projeto"
            dica="Arquivos .xlsx que já estão na pasta do FinTrack"
          >
            <select
              value={daPasta}
              onChange={(e) => { setDaPasta(e.target.value); setArquivo(null); }}
            >
              <option value="">Nenhuma — vou enviar um arquivo</option>
              {naPasta.map((a) => (
                <option key={a.arquivo} value={a.arquivo}>
                  {a.arquivo} ({Math.round(a.tamanho / 1024)} KB)
                </option>
              ))}
            </select>
          </Campo>
        )}

        <div className="dupla" style={{ margin: '14px 0' }}>
          <Campo rotulo="Ano das abas" dica="Vazio = detecta pelo nome do arquivo">
            <input
              type="number"
              placeholder="2026"
              value={ano}
              onChange={(e) => setAno(e.target.value)}
            />
          </Campo>
        </div>

        <div className="linha-check" style={{ marginBottom: 16 }}>
          <input
            id="substituir"
            type="checkbox"
            checked={substituir}
            onChange={(e) => setSubstituir(e.target.checked)}
          />
          <label htmlFor="substituir">
            Apagar os lançamentos atuais antes de importar (cartões, categorias e pessoas são mantidos)
          </label>
        </div>

        {!substituir && (
          <div className="aviso" style={{ marginBottom: 16 }}>
            <b>Sem apagar, os registros se somam.</b> Importar a mesma planilha duas vezes
            duplica todos os valores. Só desmarque se estiver trazendo uma planilha de outro ano.
          </div>
        )}

        {erro && <div className="erro" style={{ marginBottom: 14 }}>{erro}</div>}

        <button
          type="button"
          className="botao primario"
          onClick={importar}
          disabled={importando || (!arquivo && !daPasta)}
        >
          {importando ? 'Importando…' : 'Importar agora'}
        </button>
      </div>

      {relatorio && (
        <div className="cartao">
          <div className="cartao-titulo">Importação concluída</div>
          <div className="cartao-legenda">
            {relatorio.arquivo} · ano {relatorio.ano} ·{' '}
            {relatorio.abas.map((a) => a.aba).join(', ')}
          </div>
          <div className="rolagem">
            <table>
              <thead><tr><th>O que entrou</th><th className="num">Registros</th></tr></thead>
              <tbody>
                {Object.entries(relatorio.criados).map(([chave, valor]) => (
                  <tr key={chave}>
                    <td>{ROTULOS[chave] || chave}</td>
                    <td className="num">{num(valor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {relatorio.avisos.map((a) => (
            <div className="aviso" style={{ marginTop: 14 }} key={a}>{a}</div>
          ))}
        </div>
      )}

      <div className="cartao">
        <div className="cartao-titulo">O que já está no banco</div>
        <div className="cartao-legenda">
          Tudo fica em um arquivo SQLite dentro de <code>data/</code>, na pasta do projeto.
          Nada sai do seu computador.
        </div>
        <Estado carregando={estatisticas.carregando} erro={estatisticas.erro}>
          {estatisticas.dados && (
            <div className="grade g4">
              {Object.entries(estatisticas.dados).map(([chave, valor]) => (
                <div key={chave}>
                  <div style={{ fontSize: 12.5, color: 'var(--text-2)' }}>{ROTULOS[chave] || 'Meses'}</div>
                  <div style={{ fontSize: 22, fontWeight: 650 }}>{num(valor)}</div>
                </div>
              ))}
            </div>
          )}
        </Estado>
      </div>

      <div className="cartao">
        <div className="cartao-titulo">O que o leitor procura na planilha</div>
        <div className="cartao-legenda">
          Cada bloco é localizado pelo seu cabeçalho, não por número de linha — uma linha a mais
          no topo da aba não atrapalha.
        </div>
        <ul style={{ margin: '0 0 16px', paddingLeft: 20, fontSize: 13.5, color: 'var(--text-2)', lineHeight: 1.75 }}>
          <li><b>Renda</b> — abre o bloco de receitas (descrição e valor ao lado).</li>
          <li><b>Nome</b> — abre a tabela da fatura do cartão: quem gastou, descrição, valor,
            parcela e total de parcelas.
          </li>
          <li><b>Data</b> — abre as tabelas de débitos e a do segundo cartão.</li>
          <li><b>Encargos</b> — juros e encargos lançados no mês.</li>
        </ul>
        <div className="cartao-legenda">Algumas coisas mudam de forma na importação — e isso é proposital.</div>
        <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13.5, color: 'var(--text-2)', lineHeight: 1.75 }}>
          <li>
            Uma conta repetida em nove abas vira <b>um registro só</b>, com o período em que
            esteve valendo. Mudou de valor? Vira dois períodos.
          </li>
          <li>
            Uma compra parcelada vira <b>uma linha</b> com a primeira parcela e o total.
            As parcelas de cada mês passam a ser calculadas.
          </li>
          <li>
            Linhas de renda com nome de pessoa (o SUMIF da planilha) <b>não viram receita</b>:
            o reembolso é recalculado a partir dos gastos marcados com aquela pessoa.
          </li>
          <li>
            Se uma aba mostra a 2ª parcela de uma compra que não aparecia na aba anterior, a
            1ª parcela é <b>reconstruída</b> no mês certo.
          </li>
        </ul>
      </div>
    </>
  );
}
