/**
 * Representação visual de um cartão de crédito.
 *
 * A cor escolhida no cadastro vira o fundo, então o texto não pode ser branco
 * fixo: em cima do amarelo ele some. A cor da tipografia é calculada a partir
 * da luminância do fundo.
 */

const BANDEIRAS = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  elo: 'Elo',
  amex: 'American Express',
  hipercard: 'Hipercard',
  outra: 'Outra',
};

const normalizar = (v) => String(v ?? '')
  .normalize('NFD').replace(/\p{Diacritic}/gu, '')
  .toLowerCase().trim();

/** Deduz a bandeira a partir de um texto livre — nome do cartão, por exemplo. */
export function detectarBandeira(...textos) {
  const alvo = normalizar(textos.filter(Boolean).join(' '));
  if (!alvo) return null;
  if (/\bvisa\b/.test(alvo)) return 'visa';
  if (/master\s?card|\bmaster\b|\bmc\b/.test(alvo)) return 'mastercard';
  if (/\belo\b/.test(alvo)) return 'elo';
  if (/amex|american\s?express/.test(alvo)) return 'amex';
  if (/hipercard|hiper/.test(alvo)) return 'hipercard';
  return null;
}

export const bandeirasDisponiveis = Object.entries(BANDEIRAS)
  .map(([valor, texto]) => ({ valor, texto }));

/** Luminância relativa (WCAG), para decidir entre tinta clara e escura. */
function luminancia(hex) {
  const limpo = String(hex || '').replace('#', '');
  if (limpo.length !== 6) return 0;
  const canais = [0, 2, 4].map((i) => {
    const c = parseInt(limpo.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * canais[0] + 0.7152 * canais[1] + 0.0722 * canais[2];
}

const MUITO_ESCURA = 0.055;

function clarear(hex, fator) {
  const limpo = String(hex || '').replace('#', '');
  if (limpo.length !== 6) return hex;
  const canais = [0, 2, 4].map((i) => {
    const c = parseInt(limpo.slice(i, i + 2), 16);
    return Math.round(c + (255 - c) * fator);
  });
  return `#${canais.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Cor segura para a identidade do cartão quando ela vira **marca de dado** —
 * a barra do painel, a bolinha das tabelas.
 *
 * O plástico preto do cartão fica preto, mas preto como barra some no tema
 * escuro (o fundo também é quase preto). Cores muito escuras são clareadas o
 * suficiente para passar de 3:1 nos dois temas; as demais passam intactas.
 */
export function corDeMarca(hex) {
  return luminancia(hex) < MUITO_ESCURA ? clarear(hex, 0.45) : hex;
}

function MarcaVisa({ tinta }) {
  return (
    <span style={{
      fontSize: 22,
      fontWeight: 800,
      fontStyle: 'italic',
      letterSpacing: '0.06em',
      color: tinta,
      lineHeight: 1,
    }}
    >
      VISA
    </span>
  );
}

function MarcaMastercard() {
  return (
    <svg width="46" height="30" viewBox="0 0 46 30" role="img" aria-label="Mastercard">
      <circle cx="17" cy="15" r="11" fill="#eb001b" />
      <circle cx="29" cy="15" r="11" fill="#f79e1b" />
      <path
        d="M23 6.6a11 11 0 0 0 0 16.8 11 11 0 0 0 0-16.8Z"
        fill="#ff5f00"
      />
    </svg>
  );
}

function MarcaTexto({ texto, tinta, italico = false }) {
  return (
    <span style={{
      fontSize: 15,
      fontWeight: 700,
      fontStyle: italico ? 'italic' : 'normal',
      letterSpacing: '0.03em',
      color: tinta,
      lineHeight: 1,
    }}
    >
      {texto}
    </span>
  );
}

function Marca({ bandeira, tinta }) {
  switch (bandeira) {
    case 'visa': return <MarcaVisa tinta={tinta} />;
    case 'mastercard': return <MarcaMastercard />;
    case 'elo': return <MarcaTexto texto="elo" tinta={tinta} />;
    case 'amex': return <MarcaTexto texto="AMEX" tinta={tinta} />;
    case 'hipercard': return <MarcaTexto texto="Hipercard" tinta={tinta} italico />;
    default: return null;
  }
}

export default function CartaoVisual({ cartao, largura = 300 }) {
  const cor = cartao?.cor || '#2a78d6';
  // O limiar sai do contraste, não do olho: acima de L 0.30 o branco cai abaixo
  // de 3:1 contra a cor pura (o canto mais claro do degradê), e aí a tinta
  // escura passa a ser a legível — é o caso do amarelo e do rosa.
  const claro = luminancia(cor) > 0.30;
  const tinta = claro ? '#0b0b0b' : '#ffffff';

  // Escurecer um preto não produz degradê nenhum — o cartão vira um retângulo
  // chapado. Em cores muito escuras o segundo ponto do degradê clareia.
  const escurissima = luminancia(cor) < MUITO_ESCURA;
  const segundaParada = escurissima
    ? `color-mix(in srgb, ${cor} 58%, #fff)`
    : `color-mix(in srgb, ${cor} 62%, #000)`;
  const tintaFraca = claro ? 'rgba(11,11,11,0.62)' : 'rgba(255,255,255,0.72)';

  const bandeira = normalizar(cartao?.bandeira) || detectarBandeira(cartao?.nome, cartao?.emissor);
  const final = String(cartao?.final || '').replace(/\D/g, '').slice(-4);
  const inativo = cartao && 'ativo' in cartao && !cartao.ativo;

  return (
    <div
      style={{
        width: largura,
        maxWidth: '100%',
        aspectRatio: '1.586',
        borderRadius: largura / 18,
        padding: `${largura / 16}px ${largura / 14}px`,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        color: tinta,
        background: `linear-gradient(135deg, ${cor} 0%, ${segundaParada} 100%)`,
        boxShadow: '0 6px 18px rgba(0,0,0,0.22)',
        opacity: inativo ? 0.55 : 1,
        filter: inativo ? 'grayscale(0.5)' : 'none',
        position: 'relative',
        overflow: 'hidden',
        flex: '0 0 auto',
      }}
    >
      {/* brilho diagonal, só para o plástico não parecer chapado */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          background: `linear-gradient(115deg, transparent 40%, ${claro ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.13)'} 50%, transparent 60%)`,
          pointerEvents: 'none',
        }}
      />

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, position: 'relative' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: largura / 25,
            fontWeight: 600,
            letterSpacing: '0.02em',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          >
            {cartao?.emissor || cartao?.nome || 'Novo cartão'}
          </div>
          {inativo && (
            <div style={{ fontSize: largura / 30, color: tintaFraca, marginTop: 2 }}>inativo</div>
          )}
        </div>
        {/* chip */}
        <div
          aria-hidden="true"
          style={{
            width: largura / 8,
            height: largura / 11,
            borderRadius: largura / 60,
            background: 'linear-gradient(135deg, #e8c66a 0%, #b9902f 45%, #f0dda1 100%)',
            boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.18)',
            flex: '0 0 auto',
          }}
        />
      </div>

      <div style={{
        position: 'relative',
        fontSize: largura / 15,
        fontWeight: 600,
        letterSpacing: '0.09em',
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
      }}
      >
        <span style={{ color: tintaFraca }}>•••• •••• ••••</span>{' '}
        <span>{final || '••••'}</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, position: 'relative' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: largura / 32, color: tintaFraca, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
            Cartão
          </div>
          <div style={{
            fontSize: largura / 22,
            fontWeight: 600,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          >
            {cartao?.nome || '—'}
          </div>
        </div>
        <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', minHeight: 26 }}>
          <Marca bandeira={bandeira} tinta={tinta} />
        </div>
      </div>
    </div>
  );
}
