# PontoCerto PDV

Sistema de ponto de venda em português, com interface web e banco SQLite persistente. O servidor centraliza o banco: vários computadores e unidades podem acessar a mesma instalação pelo navegador.

## Requisitos

- Node.js 22.5 ou mais recente.
- Dependências instaladas com `npm install`; o banco SQLite já é integrado ao Node.js.

## Aplicativo desktop para Windows

O PDV também pode ser executado em uma janela própria, sem abrir o navegador ou iniciar o servidor manualmente. A versão desktop inclui o servidor local e o SQLite, e foi projetada para uso em um único computador de caixa; ela não substitui o servidor central usado por vários computadores na rede.

Para executar em desenvolvimento, instale as dependências e inicie o aplicativo:

```powershell
npm install
npm run desktop
```

Para gerar o instalador do Windows (64 bits), execute:

```powershell
npm run desktop:dist
```

O instalador será criado na pasta `release`. O computador de destino não precisa ter Node.js. Na primeira execução, é possível selecionar um banco SQLite existente para importá-lo; a importação cria uma cópia e preserva o arquivo original. No modo de desenvolvimento, o banco em `data/pdv.sqlite` é copiado automaticamente quando ainda não existe uma base desktop.

O banco desktop e seus backups ficam em `%APPDATA%\PontoCerto PDV`. O aplicativo cria até sete backups diários automáticos; mantenha cópias adicionais em outro dispositivo ou local seguro. No menu **Ajuda**, use **Abrir pasta de dados e backups** para acessá-los. Para habilitar a sincronização com o site na versão instalada, configure URL, token e unidade no arquivo `.env` aberto pelo menu **Ajuda > Abrir configuração de sincronização** e reinicie o aplicativo. Sem configuração do site, as vendas continuam locais, mas não serão sincronizadas. O instalador ainda não possui assinatura digital; o Windows pode exibir um aviso de segurança ao executá-lo.

## Iniciar no Windows

Abra o PowerShell nesta pasta e execute:

```powershell
npm install
npm start
```

Acesse `http://127.0.0.1:3000`. Na primeira visita, crie a unidade principal e o usuário administrador. A senha inicial deve ter pelo menos 12 caracteres; não há senha padrão.

O banco é criado em `data/pdv.sqlite`. Para usar outra localização, defina `PDV_DB_PATH` antes de iniciar. Mantenha esse arquivo em armazenamento persistente e faça cópias de segurança regulares.

## Acesso pela rede ou internet

Para permitir conexões de outros computadores na rede, configure o servidor para escutar na rede e permita a porta escolhida no firewall:

```powershell
$env:PORT = "3000"
npm start
```

O aplicativo deve ficar em um único servidor; não copie o arquivo SQLite para cada caixa.

Para acesso pela internet, publique o servidor atrás de um proxy HTTPS (por exemplo, Caddy ou Nginx), restrinja o acesso ao serviço e habilite o cookie seguro:

```powershell
$env:PORT = "3000"
$env:PDV_COOKIE_SECURE = "true"
npm start
```

Em hospedagens gerenciadas, use a porta fornecida pela plataforma e permita que o proxy HTTPS encaminhe o tráfego para o processo Node. `0.0.0.0` é o endereço de escuta interno, não a URL pública do aplicativo. Não exponha a porta do Node diretamente à internet. Faça backup do banco antes de atualizações e teste a restauração. O SQLite é indicado para instalações pequenas ou médias em um único servidor; avalie PostgreSQL se o volume de gravações simultâneas crescer.

## Funções incluídas

- Cadastro inicial da loja, login, alteração de senha, sessão protegida e perfis administrador, gerente e operador.
- Cadastro e edição de produtos com foto otimizada, SKU e código de barras compartilhados com o site, preços, categorias e custo. O tipo de peça separa as grades de roupas (PP a XGG), calças/leggings (34 a 60) e calçados (33 a 46), com estoque independente por tamanho. Os códigos internos não são GTIN/EAN comerciais e não substituem códigos licenciados pela GS1.
- Página de promoções para definir percentual de desconto e período; o preço promocional é aplicado automaticamente no caixa durante o período agendado.
- Página de etiquetas para gerar PDF A4 com Code 128 por produto, limitada a 36 etiquetas por folha/seleção, com tamanhos prontos (30 × 20, 40 × 25, 50 × 30 e 60 × 40 mm) e tamanho personalizado. O formato Code 128 evita que leitores interpretem o prefixo interno 20–29 como código de preço/peso. As etiquetas mantêm as medidas escolhidas, com conteúdo separado em áreas para nome, barras, número e preço; as fileiras são centralizadas e usam intervalos de 1 mm para aproveitar a folha. Habilite Code 128 no leitor e imprima em escala de 100%, sem modo rascunho/economia de tinta; etiquetas muito estreitas ainda podem limitar a leitura.
- Estoque por unidade, entradas e saídas com motivo, transferência entre unidades e histórico de movimentações.
- Venda em tela única, com busca compacta por nome/SKU ou leitura de código de barras, itens adicionados sempre visíveis ao lado do catálogo, destaque do produto selecionado, desconto, dinheiro com cálculo de troco, Pix, débito, crédito e outros meios registrados manualmente.
- Baixa de estoque na venda; histórico acessível no caixa e cancelamento por gerente/administrador, com reposição do estoque, ajuste do faturamento e registro do estorno em dinheiro no caixa aberto. Estornos de Pix/cartão devem ser processados na operadora.
- Ao finalizar uma venda com Pix, o sistema oferece um QR local com os dados do pedido para testar a leitura. A aprovação é simulada pelo operador; o modo de teste não registra venda, não baixa estoque e não altera caixa ou relatórios. É possível voltar e registrar a venda normalmente após conferir o pagamento fora do sistema.
- Depois de uma venda registrada ou de uma simulação aprovada, o operador pode imprimir o comprovante ou dispensá-lo. Comprovantes de teste são identificados como simulação sem valor real.
- Cadastro de clientes.
- Abertura, suprimentos/sangrias, saldo esperado e fechamento/conferência do caixa.
- Relatório gerencial mensal completo, com fechamento diário, vendas e itens detalhados, pagamentos, operadores, conferência e movimentos de caixa, movimentações e posição atual de estoque, além de exportação CSV.
- Comprovante imprimível marcado como **não fiscal**.
- Cadastro de unidades e usuários. Os usuários atuais podem acessar todas as unidades.

## Sincronização com o site LDM

O PDV compartilha cadastros de produtos com o site e envia preços, promoções e movimentações de estoque para a API Laravel. Os produtos criados no site são importados pelo PDV; produtos existentes só são associados após uma escolha explícita na tela de conciliação. A sincronização de estoque e preços continua partindo do PDV para a unidade configurada. Pedidos temporários de teste finalizados no site são consultados pelo PDV e baixados da unidade configurada; entram no relatório como pedidos identificados do site e geram movimentações de estoque, mas não criam recebimentos nem alteram o caixa. O PDV também reconcilia o histórico paginado para incluir pedidos que já tinham sido confirmados antes dessa integração com relatórios.

1. No projeto `C:\projeto\LDM`, configure `PDV_SYNC_TOKEN` no `.env` com um segredo aleatório de pelo menos 32 caracteres e execute `php artisan migrate --force`. Não use nem compartilhe esse token em mensagens ou no código.
2. No servidor do PDV, configure as variáveis de ambiente antes de iniciar. Use o mesmo token:

   ```powershell
   $env:PDV_SITE_SYNC_URL = "https://seu-site.com"
   $env:PDV_SITE_SYNC_TOKEN = "<o mesmo segredo configurado no Laravel>"
   $env:PDV_SITE_SYNC_BRANCH_NAME = "Unidade principal"
   npm start
   ```

   Para desenvolvimento local na mesma máquina, use `http://127.0.0.1:8000`. O PDV deriva os caminhos `/api/pdv/...` dessa URL; uma URL terminada em `/api/pdv/sync` também é aceita. Fora do computador local, HTTPS é obrigatório.
3. Com a integração ativa, ao cadastrar um produto no PDV o servidor obtém SKU e código de barras centrais antes de salvar. Se o site estiver indisponível ou não estiver configurado, o produto não será criado. Cadastros feitos no site são importados periodicamente a partir do campo `data` da API; o estoque inicial recebido é aplicado apenas à unidade configurada no PDV. Se o SKU já existir no PDV com outro código de barras, o produto existente não é sobrescrito e a importação fica pendente para correção.
4. Para produtos que já existem nos dois sistemas, um administrador ou gerente pode abrir **Produtos e estoque**, comparar os nomes e selecionar explicitamente o correspondente no site. Nenhum vínculo ou alteração de códigos é feito automaticamente pelo nome. SKU e código de barras permanecem visíveis na lista local.
5. Confira as quantidades na unidade configurada. Em **Promoções**, o administrador pode usar **Alinhar estoque e preços iniciais** para substituir no site os saldos e preços pelos valores atuais do PDV.

Quando a internet cair, o PDV continua registrando vendas, cancelamentos, entradas, saídas e ajustes localmente no SQLite; as operações da unidade configurada são colocadas numa fila persistente e enviadas automaticamente ao site quando a conexão voltar. Uma falha de rede não desfaz a venda nem a baixa local do estoque. O reenvio é idempotente, então repetir um evento não duplica o movimento no site. Em **Promoções**, administradores e gerentes podem acompanhar a fila e usar **Tentar novamente**; erros e SKUs sem correspondência ficam visíveis ali. Cadastre e importe os produtos enquanto estiver online, para que seus códigos compartilhados estejam disponíveis no PDV antes de operar desconectado. O cadastro de um produto novo ainda exige conexão para reservar o SKU e o código de barras centrais.

Pedidos de teste do site são consultados a cada ciclo de sincronização, aplicados de modo idempotente e confirmados ao Laravel; se o estoque local for insuficiente, o pedido permanece pendente e o PDV não permite que o saldo fique negativo. Cadastros e importações são repetidos com segurança quando houver falha de rede, e produtos importados não são reenviados ao site. As promoções agendadas também são refletidas no catálogo do site e expiram automaticamente. Produtos e seus tamanhos/estoques por variação são sincronizados entre o site e o PDV.

O checkout do site está em **modo temporário de teste**: não processa pagamentos nem movimenta o caixa do PDV. Os pedidos recebidos são registrados separadamente das vendas presenciais, identificados no relatório mensal e geram movimentações de saída de estoque; seus valores não são contabilizados como pagamentos ou dinheiro recebido. Remova ou substitua esse fluxo ao integrar um provedor de pagamentos real.

## Limites importantes

O sistema não processa pagamentos na maquininha, não consulta serviços bancários e não emite NFC-e, SAT, NF-e ou documento fiscal. O QR do simulador não é Pix e não confirma pagamento. Em vendas registradas, Pix e cartão são apenas anotados para controle; confirme o pagamento no provedor/maquininha. Consulte um contador e integre um serviço fiscal apropriado antes de usar como emissor fiscal.

## Testes

```powershell
npm test
```

## Relatório mensal em PDF

Entre em **Relatórios**, escolha o mês e clique em **Gerar relatório**. Use **Imprimir / Salvar em PDF** e, na janela de impressão do navegador, escolha **Salvar como PDF** (papel A4 horizontal). O documento é gerencial e não fiscal; a posição de estoque apresentada é a posição atual, não um histórico do último dia do mês.
