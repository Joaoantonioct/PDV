# Instalação e Acesso Remoto do PDV

## Acesso via Tailscale (VPN)

Este script permite acessar o PDV de qualquer lugar usando Tailscale.

### Passo 1: Instalar Tailscale no Servidor (Empresa)

1. Acesse: https://tailscale.com/download/windows
2. Baixe e instale o Tailscale
3. Faça login com sua conta (Google, Microsoft, GitHub, etc)
4. Anote o IP do Tailscale (ex: `100.x.x.x`)

### Passo 2: Instalar Tailscale no Computador de Casa

1. Mesmo processo: https://tailscale.com/download/windows
2. Faça login com a MESMA conta
3. Os computadores estarão na mesma rede privada

### Passo 3: Configurar o PDV

1. Edite o arquivo `.env` no diretório do PDV:
   ```powershell
   cd C:\pdv
   notepad .env
   ```

2. Configure as variáveis desejadas:
   ```env
   PORT=3000
   PDV_SITE_SYNC_URL=https://seu-site.com
   PDV_SITE_SYNC_TOKEN=seu-token-do-laravel
   PDV_SITE_SYNC_BRANCH_NAME=Unidade principal
   ```

3. Para sincronizar com o site LDM, configure o mesmo token no `.env` do projeto LDM:
   ```env
   PDV_SYNC_TOKEN=seu-token-do-laravel
   ```

### Passo 4: Iniciar o PDV

Use o script PowerShell para iniciar com as configurações:

```powershell
cd C:\pdv
.\iniciar-pdv.ps1
```

Se o PowerShell bloquear scripts, execute:
```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

### Passo 5: Acessar o PDV

**Da empresa (rede local):**
```
http://127.0.0.1:3000
```

**De casa (via Tailscale):**
```
http://100.x.x.x:3000
```
(substitua `100.x.x.x` pelo IP do Tailscale do servidor)

**Outros computadores na empresa:**
```
http://192.168.1.XXX:3000
```
(substitua pelo IP local do servidor)

## Testes Realizados

✅ **Script de inicialização do PDV**: Funcionando corretamente
- Carrega configurações do `.env`
- Inicia servidor na porta 3000
- Responde via HTTP

✅ **Banco de dados SQLite**: Funcionando corretamente
- Banco existe em `data/pdv.sqlite`
- Estrutura criada e funcional

✅ **Site LDM (desenvolvimento local)**: Funcionando corretamente
- Configurado para usar SQLite local
- Migrations aplicadas com sucesso
- Token de sincronização configurado

⚠️ **Firewall**: Requer configuração manual como administrador
- Execute o PowerShell como Administrador e rode:
  ```powershell
  New-NetFirewallRule -DisplayName "PDV" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow
  ```

## Acesso para Funcionários

Cada funcionário deve ter seu próprio login no PDV. Para criar usuários:

1. Acesse o PDV como administrador
2. Vá em "Usuários"
3. Crie um usuário para cada funcionário com:
   - Nome
   - Usuário (username)
   - Senha (mínimo 12 caracteres)
   - Cargo (ADMIN, MANAGER ou CASHIER)

## Firewall

Certifique-se de que a porta 3000 esteja liberada no firewall do Windows:

```powershell
# No PowerShell como Administrador
New-NetFirewallRule -DisplayName "PDV" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow
```

## Backup do Banco de Dados

O banco de dados fica em `data/pdv.sqlite`. Faça backups regulares:

```powershell
# Backup manual
Copy-Item C:\pdv\data\pdv.sqlite C:\pdv\data\backup_pdv_$(Get-Date -Format 'yyyyMMdd_HHmmss').sqlite
```

## Solução de Problemas

**PDV não inicia:**
- Verifique se a porta 3000 não está em uso: `netstat -ano | findstr :3000`
- Se estiver, encerre o processo ou mude a porta no `.env`

**Não consegue acessar de casa:**
- Verifique se o Tailscale está conectado nos dois computadores
- Verifique o IP do Tailscale do servidor
- Verifique o firewall do Windows

**Sincronização com site não funciona:**
- Verifique se `PDV_SITE_SYNC_URL` está correto no `.env` do PDV
- Verifique se `PDV_SYNC_TOKEN` está configurado no `.env` do LDM
- Verifique se os tokens são iguais
- Verifique se o site está acessível via HTTPS
