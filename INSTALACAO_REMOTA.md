# Conectar o aplicativo móvel ao PDV desktop

O PDV desktop executa a API no computador do caixa. O aplicativo móvel acessa essa API pela VPN Tailscale; não é necessário abrir a porta no roteador nem expor o PDV à internet.

## 1. Atualizar o PDV desktop

Instale uma versão do PDV desktop que ofereça a API na porta `3000`. As versões anteriores podem manter a API apenas em `127.0.0.1` e numa porta aleatória, o que impede o acesso pelo celular. Gere o instalador atualizado com `npm run desktop:dist` e instale-o no computador do caixa. A atualização não deve apagar a pasta de dados `%APPDATA%\PontoCerto PDV`.

Mantenha o PDV aberto enquanto usar o aplicativo móvel. Se a porta `3000` já estiver ocupada, defina `PORT=3001` no arquivo `.env` aberto pelo menu **Ajuda > Abrir configuração de sincronização**, reinicie o PDV e use essa porta nas regras e no endereço do aplicativo.

## 2. Instalar e conectar o Tailscale

1. Instale o Tailscale no computador do PDV e no celular Android, usando a fonte oficial: <https://tailscale.com/download>.
2. Entre nos dois dispositivos na mesma conta/rede Tailscale e confirme que ambos aparecem como conectados.
3. No computador do PDV, abra PowerShell e execute `tailscale ip -4`. Anote o endereço `100.x.x.x` mostrado.

## 3. Permitir a API apenas pela rede Tailscale

No computador do PDV, abra PowerShell **como administrador** e crie uma regra limitada à faixa de endereços da VPN:

```powershell
New-NetFirewallRule -DisplayName "PDV - Tailscale" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000 -RemoteAddress 100.64.0.0/10 -Profile Any
```

Se estiver usando outra porta, substitua `3000`. Não crie encaminhamento de porta no roteador e não autorize acesso em redes públicas. Se houver regra anterior liberando o PDV ou a porta para qualquer endereço, remova ou restrinja essa regra.

## 4. Testar do celular

Com o PDV aberto e o Tailscale conectado nos dois dispositivos, abra no navegador do celular:

```text
http://100.x.x.x:3000/api/status
```

Substitua `100.x.x.x` pelo IP anotado do computador. Deve aparecer uma resposta JSON de status. O endereço usa HTTP, mas o tráfego entre dispositivos é criptografado pelo túnel Tailscale. Não use esse endereço fora da VPN.

## 5. Conectar o aplicativo

1. Abra o aplicativo Vitrine no celular.
2. Em **Endereço do PDV**, digite `http://100.x.x.x:3000` — sem `/api/status`.
3. Informe o usuário e a senha já cadastrados no PDV. A senha não fica salva no aplicativo.
4. Selecione a unidade e toque em **Conectar**.

O computador precisa estar ligado, com o PDV aberto e o Tailscale conectado para o aplicativo consultar produtos, cadastrar produtos, gerenciar promoções ou enviar publicações.

## Diagnóstico

- Se `http://localhost:3000/api/status` não abrir no computador, confirme se o PDV atualizado está aberto e se a porta configurada está livre.
- Se abrir no computador, mas não no celular, confirme o IP `tailscale ip -4`, o estado conectado do Tailscale nos dois dispositivos e a regra do firewall.
- Um JSON `401` ou outra resposta HTTP significa que o serviço foi alcançado; confira a autenticação no aplicativo.
- Nunca compartilhe senha do PDV, token do site ou chave de autenticação.
