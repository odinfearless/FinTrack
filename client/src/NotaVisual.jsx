/**
 * Representação visual dos gastos que não passam por cartão.
 *
 * É o par do CartaoVisual: onde há plástico, desenha-se o cartão; onde o
 * dinheiro sai direto do bolso (Pix, transferência, espécie), desenha-se a
 * cédula. As proporções são as mesmas para os dois ficarem lado a lado sem
 * desequilibrar o layout.
 */

export const FORMAS = ['Pix', 'Transferência', 'Dinheiro', 'Boleto', 'Débito'];

const VERDE = '#1baf7a';

export default function NotaVisual({ formas, largura = 286 }) {
  // `formas` é um mapa { Pix: 120.5, Dinheiro: 40 } vindo do resumo do mês.
  const usadas = Object.entries(formas || {})
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([nome]) => nome);

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
        color: '#ffffff',
        background: `linear-gradient(135deg, ${VERDE} 0%, color-mix(in srgb, ${VERDE} 58%, #000) 100%)`,
        boxShadow: '0 6px 18px rgba(0,0,0,0.22)',
        position: 'relative',
        overflow: 'hidden',
        flex: '0 0 auto',
      }}
    >
      {/* guilhoché simplificado: as linhas concêntricas de uma cédula */}
      <svg
        aria-hidden="true"
        viewBox="0 0 100 63"
        preserveAspectRatio="none"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0.16 }}
      >
        {[10, 16, 22, 28].map((r) => (
          <ellipse key={r} cx="50" cy="31.5" rx={r * 1.6} ry={r} fill="none" stroke="#fff" strokeWidth="0.4" />
        ))}
      </svg>

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, position: 'relative' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: largura / 25, fontWeight: 600, letterSpacing: '0.02em' }}>
            Sem cartão
          </div>
          <div style={{ fontSize: largura / 30, color: 'rgba(255,255,255,0.72)', marginTop: 2 }}>
            saiu direto do bolso
          </div>
        </div>

        {/* selo circular com o cifrão, no lugar do chip do cartão */}
        <div
          aria-hidden="true"
          style={{
            width: largura / 7.5,
            height: largura / 7.5,
            borderRadius: '50%',
            display: 'grid',
            placeItems: 'center',
            border: '2px solid rgba(255,255,255,0.55)',
            fontSize: largura / 14,
            fontWeight: 700,
            lineHeight: 1,
            flex: '0 0 auto',
          }}
        >
          $
        </div>
      </div>

      <div style={{ position: 'relative', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {(usadas.length ? usadas : FORMAS.slice(0, 3)).slice(0, 4).map((f) => (
          <span
            key={f}
            style={{
              fontSize: largura / 30,
              padding: '3px 9px',
              borderRadius: 999,
              background: usadas.length ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.10)',
              color: usadas.length ? '#fff' : 'rgba(255,255,255,0.65)',
              whiteSpace: 'nowrap',
            }}
          >
            {f}
          </span>
        ))}
      </div>

      <div style={{ position: 'relative' }}>
        <div style={{
          fontSize: largura / 32,
          color: 'rgba(255,255,255,0.72)',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
        }}
        >
          Pix · Transferência · Espécie
        </div>
      </div>
    </div>
  );
}
