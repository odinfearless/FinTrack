# FinTrack

Controle de gastos pessoais que roda inteiro na sua máquina: React no navegador,
API em Node e um banco **SQLite** em arquivo. Nada vai para a nuvem, nada precisa
de servidor instalado.

Nasceu da `Planilha 2026.xlsx` — e sabe importá-la.

## Começando

```bash
npm run setup
```

```bash
npm run importar -- "Planilha 2026.xlsx"
```

```bash
npm run dev
```

A interface abre em <http://localhost:5173> e a API sobe em
<http://localhost:3333>. O banco é criado sozinho em `data/fintrack.db` (bancos
antigos, de quando o projeto se chamava AppGastos, continuam sendo usados de onde
estão).

A importação é opcional: sem ela o app começa vazio, com um conjunto inicial de
categorias. Ela também pode ser feita pela tela **Importar gastos**.

### Outros comandos

| Comando | O que faz |
|---|---|
| `npm run build` | Gera o front em `client/dist` |
| `npm start` | Sobe tudo numa porta só (API + interface já construída) |
| `npm run importar -- "arquivo.xlsx"` | Importa uma planilha (substitui os lançamentos) |
| `npm run importar -- "outra.xlsx" --somar` | Importa somando aos dados existentes |
| `npm run reset -- --sim` | Apaga o banco e recomeça do zero |

## A ideia central: vigência, não repetição

A planilha exigia recopiar tudo a cada mês novo. Aqui cada coisa é cadastrada
**uma vez** e o mês é calculado:

| Na planilha | Aqui |
|---|---|
| Parcela `4/10` reescrita todo mês | 1 compra com 1ª parcela e total; o resto é derivado |
| Luz relançada todo mês | 1 conta marcada como recorrente |
| `SUMIF` por nome para o reembolso | calculado a partir dos gastos marcados com a pessoa |

Isso é o que faz a tela de **Projeção** existir: como o sistema sabe até quando
cada compromisso vale, ele consegue dizer como ficam os próximos meses.

Quando um valor muda (a luz sobe, o seguro reajusta), o período antigo se
fecha e um novo começa — o histórico continua correto.

Cobrança recorrente no cartão (Spotify, academia) **não tem cadastro próprio**:
ela é um gasto que se repete, então entra como lançamento do mês, e a fatura
seguinte a traz de novo. Fora do cartão, é uma conta.

### Parcelado é um tipo de gasto, não outra tela

Quem lança não pensa "vou cadastrar um parcelamento" — pensa "comprei isso, e
foi em 10x". Por isso existe **um formulário só**: em *Gastos do mês*, o botão
**+ Novo gasto** abre a mesma tela para os dois casos, e o seletor no topo troca
entre **à vista** e **parcelado**.

Escolhido "parcelado", aparece o bloco reservado às parcelas — número de
parcelas e mês da primeira, com o total da compra e o mês da última calculados
ali mesmo. O valor passa a ser o da parcela, o mês da fatura sai (quem manda é o
mês da 1ª parcela) e "pago com" fica só nos cartões, porque parcela em Pix ou
dinheiro não existe. Em "à vista" esse bloco some inteiro.

Na listagem, a parcela do mês tem as mesmas ações da compra inteira: **editar**
(mexe em todas as parcelas), **quitar neste mês** (a parcela deste mês vira a
última) e **excluir** (some de todos os meses). As compras que não têm parcela no
mês aberto — as que só começam depois e as que já terminaram — ficam no bloco
recolhido no fim da lista, para continuarem alcançáveis.

## Telas

- **Painel do mês** — saldo, composição da dívida, categorias, maiores gastos
- **Projeção** — os próximos meses com o que já está comprometido
- **Gastos do mês** — navegação por cartão: escolhe o cartão, vê o plástico com a
  fatura dele e os gastos embaixo; é onde se lança gasto, à vista ou parcelado
- **Contas e débitos** — o que é pago fora do cartão
- **Receitas** — salário, extras e ajustes (aceita valor negativo)
- **Cartões** — cadastro com cartão visual (bandeira e 4 últimos dígitos), limite, fechamento/vencimento e encargos do mês
- **Categorias e pessoas** — classificação e quem reembolsa
- **Importar gastos** — trazer um `.xlsx` ou uma **fatura em PDF/imagem** para dentro do banco

## Importando a fatura do cartão

Na tela **Importar gastos**, o primeiro bloco aceita a fatura direto:

1. Escolha o cartão e o mês da fatura.
2. Arraste o arquivo — PDF, foto da fatura ou print da lista do app do banco
   (PNG, JPG, WEBP), até 15 MB.
3. **Marque o que deve ser lido — no próprio PDF.** Circule os lançamentos num
   editor de PDF antes de enviar. O app acha o traço sozinho e lê só o que está
   dentro dele: cabeçalho, totais e rodapé ficam de fora, e é isso que elimina a
   maioria das leituras erradas.

   Serve **qualquer cor viva** — vermelho, verde, azul, rosa — e cores diferentes
   podem conviver no mesmo arquivo. Vale marcar várias áreas, em várias páginas.
   Sem marcação, o arquivo inteiro é lido.
4. Confira a tabela: descrição, valor, categoria e tipo são editáveis ali mesmo.
5. Confirme.

Sem nenhuma marcação vale a heurística, que tenta descartar totais e rodapés
sozinha. A marcação existe justamente para quando essa adivinhação erra.

O que distingue uma marcação de um logotipo ou de uma tarja colorida não é a cor,
e sim o que ela envolve: só vira região o traço que cerca **três ou mais linhas de
texto**. Decoração colorida raramente cerca alguma.

A detecção do traço é vetorial, então funciona em PDF. **Imagem é sempre lida por
inteiro** — numa foto o círculo seria só pixels, e reconhecê-lo é outro problema.

**Nada entra no banco antes da confirmação.** É proposital: heurística de texto e
OCR erram, e um valor errado importado em silêncio vira dívida errada no painel.

O que o leitor faz sozinho:

- separa data, descrição e valor de cada linha;
- **desgruda lançamentos que vieram na mesma linha.** A fatura é impressa em duas
  colunas e nem sempre dá para separá-las pelas coordenadas do PDF; quando a
  coluna da esquerda chega colada na da direita, o leitor corta nas datas e
  recupera os dois. O corte é sempre numa data, nunca num valor, senão `PARC
  03/10` e compras em outra moeda virariam lançamentos inventados;
- ignora totais, pagamentos, limites e rodapés — e, se o resumo vier grudado numa
  compra, descarta só o pedaço do resumo;
- reconhece parcelas (`PARC 03/10`, `3 DE 12`) e já cadastra a compra com o mês
  em que ela começou — a partir daí as parcelas seguintes são calculadas;
- sugere categoria por estabelecimento (Uber, iFood, postos, farmácias…), com o
  termo mais específico ganhando: "Mercado Livre" vai para compras online, não
  para supermercado;
- lê estorno e crédito com **valor negativo** e os deixa **desmarcados** — marcados,
  eles abatem a fatura em vez de somar;
- marca como **"já existe"** o que bate com algo do mês naquele cartão —
  incluindo parcelas vindas de outro mês — para não importar em dobro;
- ignora o bloco de **parcelas de faturas futuras**, que repete compras já cobradas.

Cada item pode virar compra avulsa ou parcelamento, escolhendo na própria tabela
de revisão. Quando a fatura declara o próprio total, a tela compara com o que foi
lido e avisa se falta ou sobra dinheiro.

### Print da lista do app do banco

O mesmo campo aceita um **print da tela de lançamentos do app**, que não tem a
estrutura de uma fatura: lá a data é um **cabeçalho de dia** ("2 de agosto") que
vale para tudo que vem abaixo, o nome do estabelecimento **quebra em duas ou três
linhas**, o valor fica à direita da linha em que o nome termina e embaixo de cada
compra ainda vem uma legenda ("Cartão físico").

O leitor reconhece esse formato e o traduz para o outro — cada compra vira uma
linha "dd/mm descrição valor" — e daí para frente vale tudo que já está descrito
acima: ruído, parcela, categoria, duplicata. Nesse formato ele ainda:

- **descarta a moldura do app**: o que vem antes do primeiro cabeçalho de dia
  (relógio, nome do cartão, abas de mês) e os botões do rodapé. Sem esse corte, o
  total que aparece na aba do mês entraria na lista como se fosse uma compra;
- **junta o nome quebrado ao seu valor**, tanto faz se o valor saiu alinhado com a
  primeira linha do nome ou com a última;
- **refaz as linhas pela posição das palavras** quando o reconhecimento enxerga a
  tela como duas colunas e devolve os nomes todos primeiro e os valores depois.
  Entre as duas leituras vence a que reconhece mais lançamentos, então foto de
  fatura impressa continua saindo pelo caminho de antes;
- **nunca funde duas compras numa só.** Se o reconhecimento estragar um valor, a
  compra correspondente sai como linha **ignorada**, com o motivo escrito. A
  alternativa — colá-la na compra de cima — apagaria um gasto sem avisar, e é
  justamente o que não pode acontecer numa importação. Quem delimita uma compra
  da outra é a legenda de baixo ("Cartão físico"). Pela mesma razão, o ponto é
  aceito como separador decimal aqui: `R$ 60.00` é a vírgula lida errado;
- **não declara total**: o print mostra um pedaço do mês, e comparar a soma com o
  total da fatura acusaria uma diferença que não é erro.

Um print cobre alguns dias; para o mês inteiro, envie os prints em sequência. O
que já foi importado volta marcado como **"já existe"** e desmarcado, então
sobreposição entre um print e o seguinte não vira lançamento em dobro.

A leitura de PDF não mudou: os dois formatos convivem, e a tela de revisão diz
qual dos dois foi reconhecido.

**PDF escaneado** (sem texto selecionável) não é lido como PDF — o sistema avisa
e pede que você envie como imagem, aí o reconhecimento de texto entra. O OCR roda
na sua máquina, mas baixa um pacote de idioma na primeira vez, e só nessa hora
precisa de internet.

Nem todo gasto passa por cartão. Escolhendo **Pix, transferência, dinheiro,
boleto ou débito** em vez de um cartão, o lançamento vai para o grupo
**Sem cartão** — que aparece como uma cédula, no lugar do plástico, e entra no
total do mês como qualquer outro gasto.

O cabeçalho da tela — chips de origem, desenho e total — é **o mesmo em qualquer
largura**; quem reflui é o CSS. Só a listagem troca de marcação, em 860px:
tabela onde há largura para comparar valores em coluna, cartões empilhados onde
a tabela viraria rolagem lateral.

As colunas da tabela acompanham a origem escolhida: com um cartão selecionado a
coluna "Origem" some (o desenho acima já diz qual é), e em "Sem cartão" entra a
coluna "Forma".

Na listagem em cartões, os lançamentos vêm **agrupados por dia**, com o total do
dia no cabeçalho — numa tela estreita, repetir a data em cada cartão gastava uma
linha de metadados à toa. A tabela do desktop mantém a data como coluna.

## Cartões

Cada cartão aparece como um cartão de verdade: bandeira (Visa, Mastercard, Elo,
Amex, Hipercard), 4 últimos dígitos e a cor escolhida. O formulário mostra a
prévia enquanto você digita, e a bandeira é deduzida do nome — "Itaú Uniclass
Visa" já vem marcada como Visa, sem você escolher.

**Só os 4 últimos dígitos são guardados**, e são opcionais. O número completo
nunca é pedido: ele não serve para nada aqui, e guardá-lo só criaria risco.

Cada cartão traz um **Ver gastos** que leva à tela de gastos já filtrada por ele
(`/despesas?cartao=N`). O chip escolhido lá também volta para a URL, então o
endereço serve para voltar depois ou recarregar sem perder a seleção.

### Limpar os gastos de um cartão

No menu de ações de cada cartão, **Limpar gastos** apaga os lançamentos sem
apagar o cadastro do cartão — útil quando uma importação entrou errada. Dá para
escolher **um mês só** ou **todos os meses** do cartão, e a tela mostra antes de
confirmar quantos registros e quanto valor saem de cada tipo.

O parcelamento é uma linha só que atravessa vários meses, então apagá-lo por
causa de agosto tira também as parcelas de setembro em diante — a tela avisa
quando é o caso, e a opção **"só gastos avulsos"** o preserva.
Antes de apagar, uma cópia do banco é gravada em `data/backup-<data>.db`.

O mesmo recorte existe no terminal, com prévia antes de confirmar:

```bash
npm run limpar -- "Itau" --mes 2026-08
```

A cor da tipografia sobre o plástico é calculada pela luminância do fundo, então
nenhuma das cores disponíveis deixa o texto ilegível — todas ficam acima de 3:1.

Há também a cor **Black**. Ela tem um detalhe: a cor do cartão não é só decoração,
ela também identifica o cartão nas barras do painel e nas bolinhas das tabelas — e
preto some contra o fundo do tema escuro. Por isso o preto vale para o plástico,
mas quando a mesma cor vira marca de dado ela é clareada o suficiente para
continuar visível nos dois temas (`corDeMarca`, em `client/src/CartaoVisual.jsx`).

## Como o dinheiro é somado

```
renda líquida  = receitas vigentes no mês + reembolsos de terceiros
dívida total   = faturas dos cartões (avulsos + parcelas + encargos)
               + gastos sem cartão (Pix, transferência, dinheiro)
               + contas fora do cartão
saldo          = renda líquida − dívida total
```

Gasto de uma pessoa marcada como "reembolsa" entra **duas vezes**, de propósito:
sai na fatura e volta como receita. O efeito líquido é zero, e a fatura continua
mostrando o valor real que o banco vai cobrar.

## Estrutura

```
server/
  db/schema.sql          esquema do SQLite
  lib/                   crud genérico, aritmética de competências
  services/mes.js        expande as parcelas do mês e consolida o total
  services/importador.js leitura da planilha
  routes/                endpoints REST
client/src/
  paginas/               uma tela por arquivo
  componentes.jsx        modal, tabela, barras, avisos, hooks de CRUD
data/fintrack.db         seu banco (não versionar)
```

## Sobre a importação da Planilha 2026

O leitor se ancora nos rótulos das abas (`Renda`, `Encargos`, `Nome`, `Data`),
não em números de linha, então pequenas mudanças de layout não quebram nada.

Dois pontos que valem saber:

- **Centavos que variam entre abas.** A mesma compra aparece como `326,68` numa
  aba e `326,58` na outra. O importador trata as duas como a mesma compra
  (tolerância de 1%); sem isso a dívida dobraria.
- **Parcelas reconstruídas.** Se uma aba mostra a 2ª parcela de algo que não
  estava na aba anterior, a 1ª parcela é criada no mês certo. Por isso o total de
  um mês pode ficar **maior** do que a planilha mostrava — a planilha é que
  estava incompleta.

Lançamentos sem descrição na planilha chegam como `(sem descrição)` e ficam sem
categoria. A tela de Gastos do mês, filtrando por "Sem categoria", é o lugar de
arrumá-los.
