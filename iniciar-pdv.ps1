# Script para iniciar o PDV com configurações do .env
# Uso: .\iniciar-pdv.ps1

$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptPath

# Verifica se existe arquivo .env
$envFile = Join-Path $scriptPath ".env"

if (Test-Path $envFile) {
    Write-Host "Carregando configurações do .env..." -ForegroundColor Green

    # Lê o arquivo .env e configura as variáveis de ambiente
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^(?!#)([^=]+)=(.*)$') {
            $name = $matches[1].Trim()
            $value = $matches[2].Trim()
            # Remove aspas se existirem
            $value = $value -replace '^"|"$', ''
            [Environment]::SetEnvironmentVariable($name, $value, "Process")
            Write-Host "  $name = $value" -ForegroundColor Cyan
        }
    }
} else {
    Write-Host "Arquivo .env não encontrado. Usando configurações padrão." -ForegroundColor Yellow
    Write-Host "Copie .env.example para .env e configure as variáveis desejadas." -ForegroundColor Yellow
}

# Configurações padrão se não estiverem definidas
if (-not $env:PORT) {
    $env:PORT = "3000"
    Write-Host "PORT não definido, usando padrão: 3000" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Iniciando PDV na porta $($env:PORT)..." -ForegroundColor Green
Write-Host "Acesse via Tailscale: http://[IP-TAILSCALE]:$($env:PORT)" -ForegroundColor Cyan
Write-Host "Ou localmente: http://127.0.0.1:$($env:PORT)" -ForegroundColor Cyan
Write-Host ""

# Inicia o servidor
npm start
