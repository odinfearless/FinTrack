import { useEffect, useMemo, useState, createContext, useContext } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './api.js';
import { mesAtual, rotuloMes, somarMeses } from './formato.js';
import { ProvedorAviso } from './componentes.jsx';

import Painel from './paginas/Painel.jsx';
import Despesas from './paginas/Despesas.jsx';
import Receitas from './paginas/Receitas.jsx';
import Contas from './paginas/Contas.jsx';
import Cartoes from './paginas/Cartoes.jsx';
import ContasBancarias from './paginas/ContasBancarias.jsx';
import Cadastros from './paginas/Cadastros.jsx';
import Projecao from './paginas/Projecao.jsx';
import Importar from './paginas/Importar.jsx';

/* ------------------------------ mês corrente ------------------------------ */

const ContextoMes = createContext(null);
export const useMes = () => useContext(ContextoMes);

const CHAVE_MES = 'fintrack:mes';
const CHAVE_TEMA = 'fintrack:tema';

function ProvedorMes({ children }) {
  const [mes, definirMes] = useState(() => localStorage.getItem(CHAVE_MES) || mesAtual());
  const [meses, setMeses] = useState([mes]);

  useEffect(() => { localStorage.setItem(CHAVE_MES, mes); }, [mes]);

  const carregarMeses = useMemo(() => async () => {
    try {
      const dados = await api.get('/meses');
      setMeses(dados.meses.length ? dados.meses : [mesAtual()]);
    } catch {
      setMeses([mesAtual()]);
    }
  }, []);

  useEffect(() => { carregarMeses(); }, [carregarMeses]);

  const valor = useMemo(
    () => ({ mes, definirMes, meses, recarregarMeses: carregarMeses }),
    [mes, meses, carregarMeses],
  );
  return <ContextoMes.Provider value={valor}>{children}</ContextoMes.Provider>;
}

/* --------------------------------- menu ----------------------------------- */

const MENU = [
  {
    titulo: 'Visão geral',
    itens: [
      { para: '/painel', ic: '◧', texto: 'Painel do mês' },
      { para: '/projecao', ic: '↗', texto: 'Projeção' },
    ],
  },
  {
    titulo: 'Lançamentos',
    itens: [
      { para: '/despesas', ic: '≡', texto: 'Gastos do mês' },
      { para: '/contas', ic: '⌂', texto: 'Contas e débitos' },
      { para: '/receitas', ic: '↓', texto: 'Receitas' },
    ],
  },
  {
    titulo: 'Cadastros',
    itens: [
      { para: '/cartoes', ic: '▭', texto: 'Cartões' },
      { para: '/contas-bancarias', ic: '⛁', texto: 'Contas bancárias' },
      { para: '/cadastros', ic: '⚑', texto: 'Categorias e pessoas' },
      { para: '/importar', ic: '⇪', texto: 'Importar gastos' },
    ],
  },
];

function Lateral({ aberta, aoNavegar }) {
  return (
    <aside className={`lateral ${aberta ? 'aberta' : ''}`}>
      <div className="marca">
        <div className="marca-icone">R$</div>
        <div>
          <div className="marca-nome">FinTrack</div>
          <div className="marca-sub">controle financeiro local</div>
        </div>
      </div>

      {MENU.map((grupo) => (
        <nav className="nav-grupo" key={grupo.titulo}>
          <div className="nav-titulo">{grupo.titulo}</div>
          {grupo.itens.map((item) => (
            <NavLink
              key={item.para}
              to={item.para}
              onClick={aoNavegar}
              className={({ isActive }) => `nav-item ${isActive ? 'ativo' : ''}`}
            >
              <span className="ic" aria-hidden="true">{item.ic}</span>
              {item.texto}
            </NavLink>
          ))}
        </nav>
      ))}
    </aside>
  );
}

/* --------------------------------- topo ----------------------------------- */

function SeletorMes() {
  const { mes, definirMes, meses } = useMes();
  const lista = meses.includes(mes) ? meses : [...meses, mes].sort();
  const indice = lista.indexOf(mes);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <button
        type="button"
        className="botao pequeno"
        onClick={() => definirMes(somarMeses(mes, -1))}
        aria-label="Mês anterior"
      >
        ‹
      </button>
      <select
        value={mes}
        onChange={(e) => definirMes(e.target.value)}
        style={{ width: 'auto', minWidth: 160 }}
        aria-label="Mês de referência"
      >
        {lista.map((m) => <option key={m} value={m}>{rotuloMes(m)}</option>)}
      </select>
      <button
        type="button"
        className="botao pequeno"
        onClick={() => definirMes(somarMeses(mes, 1))}
        disabled={indice === lista.length - 1 && false}
        aria-label="Próximo mês"
      >
        ›
      </button>
    </div>
  );
}

function BotaoTema() {
  const [tema, setTema] = useState(() => localStorage.getItem(CHAVE_TEMA) || 'sistema');

  useEffect(() => {
    const raiz = document.documentElement;
    if (tema === 'sistema') raiz.removeAttribute('data-tema');
    else raiz.setAttribute('data-tema', tema);
    localStorage.setItem(CHAVE_TEMA, tema);
  }, [tema]);

  const proximo = { sistema: 'claro', claro: 'escuro', escuro: 'sistema' };
  const rotulo = { sistema: 'Tema do sistema', claro: 'Tema claro', escuro: 'Tema escuro' };

  return (
    <button type="button" className="botao pequeno" onClick={() => setTema(proximo[tema])}>
      {rotulo[tema]}
    </button>
  );
}

const TITULOS = {
  '/painel': 'Painel do mês',
  '/projecao': 'Projeção dos próximos meses',
  '/despesas': 'Gastos do mês',
  '/contas': 'Contas e débitos',
  '/receitas': 'Receitas',
  '/cartoes': 'Cartões',
  '/contas-bancarias': 'Contas bancárias',
  '/cadastros': 'Categorias e pessoas',
  '/importar': 'Importar gastos',
};

export default function App() {
  const [menuAberto, setMenuAberto] = useState(false);
  const { pathname } = useLocation();

  useEffect(() => { setMenuAberto(false); }, [pathname]);

  useEffect(() => {
    if (!menuAberto) return undefined;
    const aoTeclar = (e) => { if (e.key === 'Escape') setMenuAberto(false); };
    document.addEventListener('keydown', aoTeclar);
    return () => document.removeEventListener('keydown', aoTeclar);
  }, [menuAberto]);

  return (
    <ProvedorAviso>
      <ProvedorMes>
        <div className="app">
          {/* Camada real, e não o escurecimento por box-shadow que havia antes:
              sombra é pintura, não recebe clique, e por isso tocar fora do menu
              não o fechava. */}
          {menuAberto && (
            <div
              className="fundo-lateral"
              onClick={() => setMenuAberto(false)}
              aria-hidden="true"
            />
          )}
          <Lateral aberta={menuAberto} aoNavegar={() => setMenuAberto(false)} />
          <div className="conteudo">
            <header className="topo">
              <button
                type="button"
                className="botao pequeno abre-menu"
                onClick={() => setMenuAberto((v) => !v)}
                aria-label="Abrir menu"
              >
                ☰
              </button>
              <h1>{TITULOS[pathname] || 'FinTrack'}</h1>
              <span className="espaco" />
              <SeletorMes />
              <BotaoTema />
            </header>

            <main className="pagina">
              <Routes>
                <Route path="/" element={<Navigate to="/painel" replace />} />
                <Route path="/painel" element={<Painel />} />
                <Route path="/projecao" element={<Projecao />} />
                <Route path="/despesas" element={<Despesas />} />
                {/* Parcelamento virou um tipo de gasto: quem tiver o link antigo
                    cai na tela onde ele agora é cadastrado e editado. */}
                <Route path="/parcelamentos" element={<Navigate to="/despesas" replace />} />
                <Route path="/contas" element={<Contas />} />
                <Route path="/receitas" element={<Receitas />} />
                <Route path="/cartoes" element={<Cartoes />} />
                <Route path="/contas-bancarias" element={<ContasBancarias />} />
                <Route path="/cadastros" element={<Cadastros />} />
                <Route path="/importar" element={<Importar />} />
                <Route path="*" element={<Navigate to="/painel" replace />} />
              </Routes>
            </main>
          </div>
        </div>
      </ProvedorMes>
    </ProvedorAviso>
  );
}
