import { brl, dataBR, rotuloDia, rotuloMes, somarMeses } from '../formato.js';
import { corDeMarca } from '../CartaoVisual.jsx';
import CarrosselOrigens from '../CarrosselOrigens.jsx';
import { Medidor, MenuAcoes, useEhMobile, Valor, Vazio } from '../componentes.jsx';

const ROTULO_ORIGEM = { avulso: 'Avulso', parcelamento: 'Parcela' };

const TIPOS = [
  { valor: '', texto: 'Tudo' },
  { valor: 'avulso', texto: 'Avulsos' },
  { valor: 'parcelamento', texto: 'Parcelas' },
];

/**
 * Monta os slides do carrossel a partir do resumo do mês, para cada origem já
 * mostrar seu próprio total sem depender do filtro que está ativo.
 * Os encargos saem da conta: eles entram na fatura, mas não são lançamentos e
 * portanto não aparecem na lista abaixo.
 */
function montarSlides({ resumo, cartoes, formasSemCartao }) {
  const porCartao = new Map((resumo?.por_cartao || []).map((c) => [c.cartao_id, c]));
  const semCartao = resumo?.sem_cartao;

  const slidesCartoes = cartoes.map((c) => {
    const r = porCartao.get(c.id);
    return {
      chave: String(c.id),
      tipo: 'cartao',
      cartao: c,
      nome: c.nome,
      total: r ? r.total - r.encargos : 0,
      quantidade: r ? r.itens : 0,
    };
  });

  const slideSemCartao = {
    chave: 'sem',
    tipo: 'sem-cartao',
    nome: 'Sem cartão',
    formas: semCartao?.formas || formasSemCartao,
    total: semCartao?.total || 0,
    quantidade: semCartao?.itens || 0,
  };

  const todos = {
    chave: '',
    tipo: 'todos',
    nome: 'Todos',
    total: Math.round(([...slidesCartoes, slideSemCartao].reduce((t, s) => t + s.total, 0)) * 100) / 100,
    quantidade: [...slidesCartoes, slideSemCartao].reduce((t, s) => t + s.quantidade, 0),
  };

  return [todos, ...slidesCartoes, slideSemCartao];
}

/**
 * Visão de gastos.
 *
 * A navegação é por origem: o carrossel mostra os cartões (e a cédula dos gastos
 * sem cartão) com o total de cada um; o escolhido filtra a lista abaixo.
 *
 * Só a listagem troca de marcação: tabela onde há largura para comparar valores
 * em coluna, cartões onde a tabela viraria rolagem lateral.
 */
export default function ListaGastos({
  itens, mes, cartoes, categorias, resumo,
  filtros, setFiltros, foraDoMes = [], aoEditar, aoExcluir, aoQuitar,
}) {
  const ehMobile = useEhMobile();
  const selecionado = cartoes.find((c) => String(c.id) === String(filtros.cartao)) || null;
  const semCartaoSelecionado = filtros.cartao === 'sem';
  // Com uma origem escolhida, repetir o nome dela em cada item seria redundante.
  const origemFixada = Boolean(selecionado) || semCartaoSelecionado;

  // Quais formas de pagamento aparecem na cédula — sai dos próprios itens
  // listados, que nesse filtro são exatamente os gastos sem cartão.
  const formasSemCartao = itens.reduce((acc, d) => {
    if (d.cartao_id) return acc;
    const chave = d.forma || 'Outros';
    acc[chave] = (acc[chave] || 0) + d.valor;
    return acc;
  }, {});

  return (
    <>
      <CarrosselOrigens
        slides={montarSlides({ resumo, cartoes, formasSemCartao })}
        selecionado={filtros.cartao}
        aoSelecionar={(chave) => setFiltros((f) => ({ ...f, cartao: chave }))}
        cartoes={cartoes}
      />

      <div className="chips" role="tablist" aria-label="Tipo de gasto">
        {TIPOS.map((t) => (
          <button
            key={t.valor || 'tudo'}
            type="button"
            role="tab"
            aria-selected={filtros.origem === t.valor}
            className={`chip ${filtros.origem === t.valor ? 'ativo' : ''}`}
            onClick={() => setFiltros((f) => ({ ...f, origem: t.valor }))}
          >
            {t.texto}
          </button>
        ))}
      </div>

      <div className="gastos-busca">
        <input
          placeholder="Buscar descrição, categoria ou pessoa"
          value={filtros.q}
          onChange={(e) => setFiltros((f) => ({ ...f, q: e.target.value }))}
          aria-label="Buscar"
        />
        <select
          value={filtros.categoria}
          onChange={(e) => setFiltros((f) => ({ ...f, categoria: e.target.value }))}
          aria-label="Categoria"
        >
          <option value="">Todas as categorias</option>
          <option value="sem">Sem categoria</option>
          {categorias.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
        </select>
      </div>

      {itens.length === 0 && (
        <div className="cartao">
          <Vazio titulo="Nenhum lançamento aqui">
            Troque o cartão, o tipo de gasto ou a busca acima.
          </Vazio>
        </div>
      )}

      {itens.length > 0 && (ehMobile
        ? (
          <CartoesDeGasto
            itens={itens}
            mes={mes}
            origemFixada={origemFixada}
            mostrarForma={semCartaoSelecionado}
            aoEditar={aoEditar}
            aoExcluir={aoExcluir}
            aoQuitar={aoQuitar}
          />
        ) : (
          <TabelaDeGastos
            itens={itens}
            origemFixada={origemFixada}
            mostrarForma={semCartaoSelecionado}
            aoEditar={aoEditar}
            aoExcluir={aoExcluir}
            aoQuitar={aoQuitar}
          />
        ))}

      <ParceladasForaDoMes
        itens={foraDoMes}
        mes={mes}
        filtros={filtros}
        aoEditar={aoEditar}
        aoExcluir={aoExcluir}
      />
    </>
  );
}

/**
 * Espaço reservado às compras parceladas que não têm parcela no mês visível: as
 * que só começam depois e as que já terminaram.
 *
 * Existe porque a lista acima é do mês — sem ele, uma compra cadastrada para
 * começar em três meses sumiria da tela logo depois de salva, e uma já quitada
 * não teria mais como ser corrigida. Some inteiro quando não há nenhuma, e
 * também quando a listagem está filtrada só nos gastos avulsos.
 *
 * Os filtros da tela valem aqui também: procurar por uma compra e não achá-la
 * porque ela terminou no mês passado seria justamente o que este bloco existe
 * para evitar.
 */
function ParceladasForaDoMes({ itens, mes, filtros, aoEditar, aoExcluir }) {
  const termo = filtros.q.trim().toLowerCase();

  const visiveis = filtros.cartao === 'sem' ? [] : itens.filter((p) => {
    if (filtros.cartao && String(p.cartao_id) !== String(filtros.cartao)) return false;
    if (filtros.categoria === 'sem' && p.categoria_id) return false;
    if (filtros.categoria && filtros.categoria !== 'sem'
      && String(p.categoria_id) !== String(filtros.categoria)) return false;
    if (termo && !`${p.descricao} ${p.categoria || ''} ${p.pessoa || ''}`.toLowerCase().includes(termo)) {
      return false;
    }
    return true;
  });

  if (filtros.origem === 'avulso' || visiveis.length === 0) return null;

  return (
    <details className="cartao fora-do-mes">
      <summary>
        Compras parceladas fora de {rotuloMes(mes)}
        <span className="fraco"> · {visiveis.length}</span>
      </summary>

      <div className="rolagem">
        <table>
          <thead>
            <tr>
              <th>Compra</th>
              <th>Cartão</th>
              <th className="num">Parcela</th>
              <th>Período</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {visiveis.map((p) => (
              <tr key={p.id}>
                <td>
                  {p.descricao}
                  <span className="etiqueta" style={{ marginLeft: 8 }}>
                    {p.estado === 'quitado' ? 'quitada' : 'começa depois'}
                  </span>
                </td>
                <td>
                  <span className="etiqueta">
                    <i className="ponto" style={{ background: corDeMarca(p.cartao_cor) }} />{p.cartao}
                  </span>
                </td>
                <td className="num">
                  <Valor v={p.valor_parcela} />
                  <span className="fraco"> × {p.parcelas}</span>
                </td>
                <td className="fraco" style={{ whiteSpace: 'nowrap' }}>
                  {rotuloMes(p.mes_inicio, { curto: true })} →{' '}
                  {rotuloMes(somarMeses(p.mes_inicio, p.parcelas - 1), { curto: true })}
                </td>
                <td>
                  <div className="acoes">
                    <MenuAcoes itens={[
                      { texto: 'Editar', aoClicar: () => aoEditar(p) },
                      { texto: 'Excluir', perigo: true, aoClicar: () => aoExcluir(p) },
                    ]}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/**
 * Agrupa os lançamentos por dia da compra.
 *
 * Dias mais recentes primeiro, e o que não tem data vai para o fim — a data é
 * opcional no cadastro e vem vazia em boa parte do que a planilha importou, então
 * esse grupo costuma existir e não pode ficar no meio do caminho.
 * Dentro de cada dia a ordem por valor é preservada.
 */
function agruparPorDia(itens) {
  const mapa = new Map();
  for (const d of itens) {
    const chave = d.data || '';
    if (!mapa.has(chave)) mapa.set(chave, []);
    mapa.get(chave).push(d);
  }

  return [...mapa.entries()]
    .sort((a, b) => {
      if (a[0] === '') return 1;
      if (b[0] === '') return -1;
      return b[0].localeCompare(a[0]);
    })
    .map(([data, lista]) => ({
      data,
      itens: lista,
      total: Math.round(lista.reduce((t, d) => t + d.valor, 0) * 100) / 100,
    }));
}

function CabecalhoDia({ grupo, mes }) {
  const { titulo, detalhe } = rotuloDia(grupo.data, mes);
  return (
    <div className="grupo-dia">
      <span className="grupo-dia-titulo">{titulo}</span>
      <span className="grupo-dia-detalhe">{detalhe}</span>
      <span className="grupo-dia-total">
        {grupo.itens.length} {grupo.itens.length === 1 ? 'lançamento' : 'lançamentos'}
        {' · '}<b><Valor v={grupo.total} /></b>
      </span>
    </div>
  );
}

/** Etiqueta da origem: cartão colorido, ou a forma quando não houve cartão. */
function Origem({ d }) {
  const nome = d.cartao || d.forma || 'Sem cartão';
  return (
    <span className="etiqueta origem" title={nome}>
      <i className="ponto" style={{ background: d.cartao_id ? corDeMarca(d.cartao_cor) : 'var(--s3)' }} />
      <span className="origem-nome">{nome}</span>
    </span>
  );
}

/**
 * Tipo do gasto. Em parcelamento, o "4/10" vira barra de andamento: dá para ver
 * de relance quais compras estão quase quitadas e quais mal começaram — coisa
 * que uma fração solta no meio da tabela não entrega.
 */
function Tipo({ d, semEtiqueta = false }) {
  if (d.origem !== 'parcelamento') {
    return <span className={`etiqueta ${d.origem}`}>{ROTULO_ORIGEM[d.origem]}</span>;
  }

  const restantes = d.parcelas_restantes ?? 0;
  const titulo = restantes > 0
    ? `Parcela ${d.parcela_atual} de ${d.parcelas} · faltam ${restantes} (${brl(d.saldo_futuro || 0)})`
    : `Parcela ${d.parcela_atual} de ${d.parcelas} · última`;
  const medidor = <Medidor atual={d.parcela_atual} total={d.parcelas} titulo={titulo} />;

  // No celular a barra vai sozinha: com o "3/4" ao lado ela já diz que é
  // parcelamento, e a etiqueta empilhada em cima desalinhava a linha de
  // metadados inteira.
  if (semEtiqueta) return <span className="tipo-progresso">{medidor}</span>;

  return (
    <span className="tipo-parcela">
      <span className="etiqueta parcelamento">
        {ROTULO_ORIGEM[d.origem]}
        {restantes === 0 && ' · última'}
      </span>
      <span className="tipo-progresso">{medidor}</span>
    </span>
  );
}

/**
 * Ações da linha. A parcela abre a compra inteira: editar mexe em todas as
 * parcelas de uma vez, quitar encurta a compra aqui e excluir apaga o
 * parcelamento de todos os meses — por isso o texto de cada uma é diferente do
 * gasto avulso, mesmo o menu sendo o mesmo.
 */
function acoesDe(d, aoEditar, aoExcluir, aoQuitar) {
  if (d.origem === 'parcelamento') {
    return (
      <MenuAcoes itens={[
        aoQuitar && d.parcelas_restantes > 0 && {
          texto: 'Quitar neste mês',
          aoClicar: () => aoQuitar(d),
        },
        { texto: 'Editar compra', aoClicar: () => aoEditar(d) },
        { texto: 'Excluir compra', perigo: true, aoClicar: () => aoExcluir(d) },
      ]}
      />
    );
  }

  return (
    <MenuAcoes itens={[
      { texto: 'Editar', aoClicar: () => aoEditar(d) },
      { texto: 'Excluir', perigo: true, aoClicar: () => aoExcluir(d) },
    ]}
    />
  );
}

/**
 * Tabela — no desktop sobra largura, e comparar valores em coluna é mais fácil.
 * Aqui a data continua sendo uma coluna: com todas as linhas visíveis lado a
 * lado, cabeçalhos de dia só quebrariam a leitura vertical.
 */
function TabelaDeGastos({ itens, origemFixada, mostrarForma, aoEditar, aoExcluir, aoQuitar }) {
  return (
    <div className="cartao">
      <div className="rolagem">
        <table>
          <thead>
            <tr>
              <th>Descrição</th>
              {!origemFixada && <th>Origem</th>}
              {origemFixada && mostrarForma && <th>Forma</th>}
              <th>Categoria</th>
              <th>Tipo</th>
              <th>Quem</th>
              <th>Data</th>
              <th className="num">Valor</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {itens.map((d) => (
              <tr key={d.chave}>
                <td>{d.descricao}</td>
                {!origemFixada && <td><Origem d={d} /></td>}
                {origemFixada && mostrarForma && (
                  <td>{d.forma ? <span className="etiqueta">{d.forma}</span> : <span className="fraco">—</span>}</td>
                )}
                <td>{d.categoria || <span className="fraco">—</span>}</td>
                <td><Tipo d={d} /></td>
                <td>{d.pessoa || <span className="fraco">—</span>}</td>
                <td className="fraco">{dataBR(d.data)}</td>
                <td className="num"><Valor v={d.valor} /></td>
                <td><div className="acoes">{acoesDe(d, aoEditar, aoExcluir, aoQuitar)}</div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Cartões — no celular a tabela viraria rolagem lateral, ruim de ler e de tocar.
 *
 * Aqui os lançamentos vão agrupados por dia: repetir a data em cada cartão
 * ocupava uma linha de metadados que numa tela estreita é cara, e ainda deixava
 * a mesma informação escrita várias vezes seguidas.
 */
function CartoesDeGasto({ itens, mes, origemFixada, mostrarForma, aoEditar, aoExcluir, aoQuitar }) {
  return (
    <div className="grupos-dia">
      {agruparPorDia(itens).map((grupo) => (
        <section key={grupo.data || 'sem-data'}>
          <CabecalhoDia grupo={grupo} mes={mes} />
          <ul className="lista-despesas">
            {grupo.itens.map((d) => (
              <li className="item-despesa" key={d.chave}>
                <div className="item-topo">
                  <span className="item-descricao">{d.descricao}</span>
                  <span className="item-valor"><Valor v={d.valor} /></span>
                  {acoesDe(d, aoEditar, aoExcluir, aoQuitar)}
                </div>

                <div className="item-meta">
                  {!origemFixada && <Origem d={d} />}
                  {origemFixada && mostrarForma && d.forma && <span className="etiqueta">{d.forma}</span>}
                  <Tipo d={d} semEtiqueta />
                  {d.categoria && <span className="etiqueta">{d.categoria}</span>}
                  {d.pessoa && <span className="etiqueta">{d.pessoa}</span>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
