import { api } from './api.js';
import { useCarrossel } from './carrossel.js';
import { brl, mesAtual, rotuloMes } from './formato.js';
import { useDados } from './componentes.jsx';

// Precisam bater com .faixa-mes no estilos.css: a linha é desenhada por cima
// dos cartões, em coordenadas calculadas aqui, e um número fora de sintonia
// deixaria os pontos ao lado dos meses em vez de dentro deles.
const LARGURA = 120;
const ESPACO = 10;
const ALTURA = 150;

// Faixa vertical em que a linha se move — entre o nome do mês e o valor, sem
// encostar em nenhum dos dois.
const TOPO = 56;
const BASE = 102;

const passo = LARGURA + ESPACO;
const xDe = (i) => i * passo + LARGURA / 2;

/**
 * Converte os valores em alturas dentro da faixa.
 *
 * A escala parte de zero, e não do menor valor do período: com o piso no menor,
 * um mês de R$ 900 ao lado de um de R$ 1.000 desenharia um despencar que não
 * existe. O topo é o maior valor, para a variação continuar visível.
 */
function alturas(valores) {
  const maior = Math.max(...valores.map((v) => Math.abs(v)), 1);
  return valores.map((v) => BASE - (Math.abs(v) / maior) * (BASE - TOPO));
}

/**
 * Caminho suave por uma sequência de pontos.
 *
 * As alças de cada curva ficam na horizontal, no meio do caminho entre dois
 * pontos: isso arredonda os cantos sem inventar altura nenhuma — a curva nunca
 * sobe acima do ponto mais alto nem desce abaixo do mais baixo do trecho, que é
 * o risco de qualquer suavização feita por cima de dados.
 */
function caminho(pontos) {
  if (pontos.length === 0) return '';
  if (pontos.length === 1) return `M ${pontos[0].x} ${pontos[0].y}`;

  return pontos.reduce((d, p, i) => {
    if (i === 0) return `M ${p.x} ${p.y}`;
    const anterior = pontos[i - 1];
    const meio = (anterior.x + p.x) / 2;
    return `${d} C ${meio} ${anterior.y}, ${meio} ${p.y}, ${p.x} ${p.y}`;
  }, '');
}

/**
 * Faixa de meses do painel.
 *
 * Cada mês é um cartão com o total que sai nele, e a linha por cima liga os
 * totais — é ela que responde de relance a pergunta que a tabela de projeção só
 * responde depois de lida: o mês que vem alivia ou aperta?
 *
 * Do mês corrente para a frente a linha vira tracejada, porque ali não há
 * fatura fechada: é projeção do que já está comprometido, e some quase sempre
 * para menos do que vai acontecer de verdade.
 *
 * Tocar num mês leva o painel inteiro para ele.
 */
export default function FaixaDeMeses({ mes, meses, aoEscolher }) {
  // O mês escolhido pode estar fora da lista conhecida — quem chega pelas setas
  // do topo passa por meses ainda sem lançamento nenhum.
  const lista = meses.includes(mes) ? meses : [...meses, mes].sort();
  const primeiro = lista[0];
  const quantidade = lista.length;

  const consulta = useDados(
    () => api.get('/projecao', { mes: primeiro, meses: quantidade }),
    [primeiro, quantidade],
  );

  const linhas = consulta.dados?.linhas || [];

  // Mesmo carrossel do trilho de cartões da tela de gastos: o mês escolhido vai
  // para o centro com inércia, e arrastar o trilho escolhe quem parar no meio.
  const trilho = useCarrossel({
    selecionado: mes,
    aoSelecionar: aoEscolher,
    pronto: linhas.length > 0,
  });

  if (linhas.length === 0) return null;

  const hoje = mesAtual();
  const ys = alturas(linhas.map((l) => l.divida_total));
  const pontos = linhas.map((l, i) => ({ x: xDe(i), y: ys[i], mes: l.mes }));

  // Até o mês corrente a linha é cheia; dali para a frente, tracejada. O ponto
  // de virada entra nas duas para não abrir um vão entre elas.
  let fechado = 0;
  linhas.forEach((l, i) => { if (l.mes <= hoje) fechado = i; });
  const passados = pontos.slice(0, fechado + 1);
  const futuros = pontos.slice(fechado);
  const larguraTotal = quantidade * LARGURA + (quantidade - 1) * ESPACO;

  return (
    <div className="faixa" ref={trilho} role="tablist" aria-label="Meses">
      <div className="faixa-trilho" style={{ width: larguraTotal, height: ALTURA }}>
        <svg
          className="faixa-linha"
          width={larguraTotal}
          height={ALTURA}
          viewBox={`0 0 ${larguraTotal} ${ALTURA}`}
          aria-hidden="true"
        >
          <defs>
            <linearGradient id="faixa-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--s1)" stopOpacity="0.28" />
              <stop offset="100%" stopColor="var(--s1)" stopOpacity="0" />
            </linearGradient>
          </defs>

          {passados.length > 1 && (
            <path
              d={`${caminho(passados)} L ${passados[passados.length - 1].x} ${ALTURA} L ${passados[0].x} ${ALTURA} Z`}
              fill="url(#faixa-area)"
            />
          )}
          {passados.length > 1 && (
            <path d={caminho(passados)} fill="none" stroke="var(--s1)" strokeWidth="2" />
          )}
          {futuros.length > 1 && (
            <path
              d={caminho(futuros)}
              fill="none"
              stroke="var(--muted)"
              strokeWidth="2"
              strokeDasharray="5 5"
            />
          )}

          {/* Cheio é mês fechado, vazado é projeção, e o escolhido ganha anel. */}
          {pontos.map((p) => {
            const ativo = p.mes === mes;
            const projetado = p.mes > hoje;
            return (
              <circle
                key={p.mes}
                cx={p.x}
                cy={p.y}
                r={ativo ? 6 : 4.5}
                fill={ativo || projetado ? 'var(--surface)' : 'var(--s1)'}
                stroke={(ativo && 'var(--s1)') || (projetado && 'var(--muted)') || 'none'}
                strokeWidth={ativo ? 2.5 : 2}
              />
            );
          })}
        </svg>

        {linhas.map((l) => {
          const ativo = l.mes === mes;
          return (
            <button
              key={l.mes}
              type="button"
              role="tab"
              aria-selected={ativo}
              data-chave={l.mes}
              data-ativo={ativo ? 'sim' : 'nao'}
              className={`faixa-mes ${ativo ? 'ativo' : ''} ${l.mes > hoje ? 'projetado' : ''}`}
              style={{ width: LARGURA, height: ALTURA }}
              onClick={() => aoEscolher(l.mes)}
              title={`${rotuloMes(l.mes)} · sai ${brl(l.divida_total)}`}
            >
              <span className="faixa-mes-nome">{rotuloMes(l.mes, { curto: true })}</span>
              <span className="faixa-mes-valor">{brl(l.divida_total)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
