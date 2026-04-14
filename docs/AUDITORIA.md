# Guia de Auditoria — PolymarketBTCAssistant

Este documento explica como ler, interpretar e cruzar as diferentes saídas do bot para verificar se ele está tomando decisões corretas e executando ordens reais quando deveria.

---

## 1. Duas saídas independentes

O bot grava informação em dois lugares ao mesmo tempo:

| Canal | Onde aparece | O que contém |
|---|---|---|
| **stdout** | Terminal (tela principal do bot) | Painel visual atualizado a cada segundo |
| **stderr** | Terminal (linha a linha, não apagada) | Logs de decisão do auto-trade |
| **CSV** | `logs/signals-<asset>-<window>.csv` | Histórico de sinais a cada ciclo |

O painel visual usa `readline` para limpar e redesenhar o `stdout` a cada ciclo — por isso os logs de decisão vão para `stderr`, que nunca é apagado.

---

## 2. Capturando os logs em arquivo

Para auditar uma sessão ao vivo, redirecione `stderr` para um arquivo separado:

```bash
# BTC 15m — logs de decisão em trade.log, painel visual no terminal
npm run start:btc15m 2>logs/trade.log

# Para acompanhar os dois ao mesmo tempo em terminais separados:
# Terminal 1:
npm run start:btc15m 2>logs/trade.log

# Terminal 2:
tail -f logs/trade.log
```

Para capturar tudo (stdout + stderr) em arquivo único:

```bash
npm run start:btc15m > logs/full.log 2>&1
```

> **Atenção**: nesse modo o painel visual fica ilegível no arquivo (contém escape codes ANSI). Use apenas para sessões não-interativas (servidor/cron).

---

## 3. Interpretando os logs de decisão (`stderr`)

Cada ciclo de 1 segundo emite uma das linhas abaixo, coloridas por gravidade:

### 3.1 Confiança abaixo do threshold — nenhuma ordem

```
[AUTO-TRADE] Confiança abaixo do threshold 60% — LONG 54.2% / SHORT 45.8% — sem ordem.
```
- Cor: cinza
- Significa: o modelo calculou probabilidade, mas nenhum lado atingiu 60%.
- **Normal**: acontece na maior parte dos ciclos.

### 3.2 Threshold atingido mas mercado bloqueado

```
[AUTO-TRADE] Sinal atingiu threshold mas trade bloqueado: mercado já operado (btc-up-or-down-15m-...).
```
- Cor: amarelo
- Significa: a confiança chegou a ≥60%, mas o bot já operou nesse mercado nesta sessão.
- Cada mercado só recebe **uma ordem por sessão** (proteção contra execução dupla).

Outras razões possíveis nessa linha:
- `mercado Polymarket indisponível` — falha de conexão com a API Gamma/CLOB
- `slug do mercado vazio` — mercado ainda não carregado no ciclo atual

### 3.3 Validações pré-execução falhas

```
[AUTO-TRADE] BLOQUEADO — tokenId do outcome LONG ausente (mercado: btc-up-or-down-...).
[AUTO-TRADE] BLOQUEADO — tokenId abc123 já operado nesta sessão.
[AUTO-TRADE] BLOQUEADO — preço inválido para SHORT: null (mercado: btc-up-or-down-...).
[AUTO-TRADE] BLOQUEADO — tamanho de trade inválido: NaN (saldo: null).
```
- Cor: vermelho (token ausente/preço/tamanho) ou amarelo (token já operado)
- Causas comuns:
  - Token ID ainda não chegou via WebSocket do Polymarket
  - Order book vazio (bestAsk = null)
  - Saldo USDC não acessível (credenciais CLOB ausentes ou API fora do ar)

### 3.4 Ordem sendo disparada

```
[AUTO-TRADE] DISPARANDO ordem LONG — confiança 67.3% | tamanho $3.15 | preço 0.6200 | token 123456...
```
- Cor: verde
- Confirma que todas as validações passaram e `executeTrade()` está sendo chamado.

### 3.5 Ordem executada com sucesso

```
[AUTO-TRADE] Ordem LONG executada com sucesso (btc-up-or-down-15m-...).
```
- Cor: verde
- Aparece imediatamente após a resposta da API Polymarket.

### 3.6 Falha na execução

```
[AUTO-TRADE] FALHA ao executar ordem LONG: Request failed with status code 400
[AUTO-TRADE] Erro de execução: Error: ...stack trace...
```
- Cor: vermelho
- O token é **removido de `tradedTokens`** após a falha — o bot tentará novamente no próximo ciclo em que a confiança for ≥60%.
- O stack trace completo aparece na segunda linha para diagnóstico.

---

## 4. O CSV de sinais

Arquivo: `logs/signals-<asset>-<window>.csv`  
Criado automaticamente; uma linha por ciclo de 1 segundo.

| Coluna | Descrição |
|---|---|
| `timestamp` | ISO 8601 UTC |
| `entry_minute` | Minuto decorrido desde o início da vela atual |
| `time_left_min` | Minutos restantes até o fechamento da vela |
| `regime` | `TRENDING` ou `RANGING` (detectado pelo regime engine) |
| `signal` | `BUY UP`, `BUY DOWN` ou `NO TRADE` |
| `model_up` | Probabilidade bruta de alta (0–1) do modelo |
| `model_down` | Probabilidade bruta de baixa (0–1) do modelo |
| `mkt_up` | Preço de mercado do token UP no Polymarket (centavos) |
| `mkt_down` | Preço de mercado do token DOWN no Polymarket (centavos) |
| `edge_up` | Edge calculado para UP (`model_up - mkt_up/100`) |
| `edge_down` | Edge calculado para DOWN (`model_down - mkt_down/100`) |
| `recommendation` | `LONG:EARLY:STRONG`, `NO_TRADE`, etc. |

### Consulta rápida com `awk`

```bash
# Ver todos os ciclos onde o modelo deu ≥60% para alta
awk -F',' 'NR>1 && $6 >= 0.60' logs/signals-btc-15m.csv

# Contar quantas vezes o sinal foi BUY UP
awk -F',' '$5 == "BUY UP"' logs/signals-btc-15m.csv | wc -l

# Ver os últimos 20 ciclos
tail -20 logs/signals-btc-15m.csv | column -t -s','
```

---

## 5. Cruzando CSV com logs de trade

Para verificar se uma ordem foi efetivamente enviada quando o modelo deu ≥60%:

**Passo 1** — Encontre no CSV os ciclos com `model_up` ou `model_down` ≥ 0.60:
```bash
awk -F',' 'NR>1 && ($6 >= 0.60 || $7 >= 0.60) {print $1, $5, $6, $7}' logs/signals-btc-15m.csv
```

**Passo 2** — Localize o timestamp correspondente no log de trade:
```bash
grep "DISPARANDO\|FALHA\|BLOQUEADO" logs/trade.log | grep "2026-04-13T14:3"
```

**Passo 3** — Se o CSV mostra `model_up >= 0.60` mas o log não mostra `DISPARANDO`, procure o motivo:
```bash
grep "AUTO-TRADE" logs/trade.log | grep -v "Confiança abaixo"
```

---

## 6. Verificando o modo de operação

### Confirmar que não está em mock

```bash
grep "TRADE_MOCK\|modo real\|MOCK" logs/trade.log | head -5
```

- `ClobClient inicializado (modo real...)` → ordens reais ativas
- `TRADE_MOCK_MODE ativo` → nenhuma ordem real; verificar `.env`

### Verificar threshold em uso

O threshold é logado indiretamente em cada linha de rejeição:
```
Confiança abaixo do threshold 60% — ...
```
Se aparecer um número diferente de 60, verificar `src/config.js` → `tradeThreshold`.

### Verificar tipo de assinatura (proxy wallet)

```bash
grep "sig type" logs/trade.log | head -3
```
- `sig type 2` + `funder 0x...` → proxy Gnosis Safe ativo (correto para contas Polymarket com proxy)
- `sig type 0` sem funder → EOA direto

---

## 7. Checklist de auditoria rápida

Execute antes de qualquer sessão de produção:

```bash
# 1. Bot inicializa sem erros?
npm run start:btc15m 2>&1 | head -20

# 2. Threshold correto?
node -e "import('./src/config.js').then(m => console.log('threshold:', m.CONFIG.tradeThreshold))"

# 3. Variáveis de ambiente presentes?
node -e "
const vars = ['PK','POLYMARKET_API_KEY','POLYMARKET_API_SECRET','POLYMARKET_API_PASSPHRASE','POLYMARKET_PROXY_ADDRESS'];
vars.forEach(v => console.log(v + ':', process.env[v] ? 'OK' : 'AUSENTE'));
"

# 4. Saldo USDC acessível?
# (verificar nas primeiras linhas do stderr ao iniciar o bot — aparece como refreshBalance)
```

---

## 8. Anatomia de uma ordem bem-sucedida no log

Uma ordem 100% saudável produz esta sequência no `stderr`:

```
[executor] ClobClient inicializado (modo real, sig type 2, funder 0xABC...).
...
[AUTO-TRADE] Confiança abaixo do threshold 60% — LONG 58.1% / SHORT 41.9% — sem ordem.
[AUTO-TRADE] Confiança abaixo do threshold 60% — LONG 59.7% / SHORT 40.3% — sem ordem.
[AUTO-TRADE] DISPARANDO ordem LONG — confiança 62.1% | tamanho $3.00 | preço 0.6200 | token 71321...
[EXECUCAO] Apostando $3.00 em BUY no Token 71321... a 62c (Probabilidade: 62.10%)
[EXECUCAO] Ordem enviada com sucesso.
[AUTO-TRADE] Ordem LONG executada com sucesso (btc-up-or-down-15m-...).
```

Se qualquer linha dessa sequência estiver ausente ou substituída por `BLOQUEADO`/`FALHA`, use as seções 3 e 5 deste guia para identificar o ponto de falha exato.
