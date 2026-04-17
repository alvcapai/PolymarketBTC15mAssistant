# Agent Operations Guide

Instruções para agentes verificarem o estado dos bots de trading Polymarket em produção.

## Acesso ao servidor

```
ssh claudio@147.79.87.101
```

Logs em: `/home/claudio/workspace/PolymarketBTC15mAssistant/logs/`

---

## Modos de operação

| Variável | Valor | Comportamento |
|---|---|---|
| `TRADE_MOCK_MODE=true` | padrão | **Mock / Calibração** — sem ordens reais. Registra posições em papel e verifica resultados via Polymarket API. Escreve em `mock-calibration-{timeframe}.csv`. |
| `TRADE_MOCK_MODE=false` | produção | **Live** — executa ordens reais via CLOB API. Requer `PK`, `POLYMARKET_API_KEY`, `POLYMARKET_API_SECRET`, `POLYMARKET_API_PASSPHRASE`. |

Em modo mock o bot:
- **NÃO altera** o bankroll real nem executa `executeTrade()`
- Registra cada entrada aprovada com `recordMockEntry()` (em memória)
- A cada 2 minutos chama `checkMockOutcomes()` — busca o resultado real no Polymarket e grava na CSV de calibração
- Exibe no dashboard: `Mode: MOCK CALIBRATION — paper=N pending`

Em modo live o bot:
- Executa ordens BUY via CLOB API
- Atualiza bankroll, exposure e posições abertas em memória
- Resgata posições ganhas automaticamente via `runAutoRedeem()`
- Exibe no dashboard: `Mode: LIVE`

---

## Arquitetura: dois motores de decisão

Os bots 15m e 5m são **árvores de decisão completamente separadas**. Não compartilham parâmetros de entrada, thresholds ou lógica de sinal.

| Aspecto | Bot 15m | Bot 5m |
|---|---|---|
| **Motor de entrada** | `engines/probability.js` → `decideEntry()` | `prediction5min/probability.js` → `evaluateEntry()` |
| **RSI** | 14 períodos (1m bars) | 5 períodos (1m bars) |
| **MACD** | 12/26/9 | 5/13/8 (metade dos períodos) |
| **VWAP lookback** | 5 minutos | 2 minutos |
| **RSI mid-range** | age sinal de tendência | **ignorado** — só extremos (<35, >65) |
| **Sinal dominante** | VWAP slope + failed reclaim | Heiken Ashi + expansão do histograma MACD |
| **Volume** | último 20 / média 120 candles | último 3 / média 15 candles |
| **Rate-of-change** | não usa | últimos 5 bars (peso 0.10) |
| **minProb** | 0.80 | 0.72 |
| **minEdge** | 10% | 8% |
| **maxEdge** | 15% | 20% |
| **Calibração** | fator 0.85 | fator 0.88 |
| **Time decay window** | 15 min | 5 min |
| **Circuit breaker** | ❌ não tem | ✅ 3 perdas consecutivas → cooldown |
| **Stop-loss** | ❌ não tem | ✅ −30% do tamanho do contrato |
| **Max stake** | $4.25 | $4.25 |
| **Série Polymarket BTC** | 10192 | 10684 |
| **Série Polymarket ETH** | 10191 | 10683 |

---

## 1. Status dos processos (PM2)

```bash
ssh claudio@147.79.87.101 "pm2 list"
```

Processos esperados:

| Nome | Descrição |
|---|---|
| `btc-15m` | Bot BTC 15 minutos |
| `eth-15m` | Bot ETH 15 minutos |
| `btc-5m` | Bot BTC 5 minutos |
| `eth-5m` | Bot ETH 5 minutos |

Verificar: todos com `status = online`. Se `status = errored` ou `stopped`, o bot caiu.

---

## 2. Bankroll atual

```bash
# BTC 15m
ssh claudio@147.79.87.101 "grep 'Bankroll:' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/btc15m-out.log | tail -1"

# ETH 15m
ssh claudio@147.79.87.101 "grep 'Bankroll:' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/eth15m-out.log | tail -1"

# BTC 5m
ssh claudio@147.79.87.101 "grep 'Bankroll:' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/btc5m-out.log | tail -1"

# ETH 5m
ssh claudio@147.79.87.101 "grep 'Bankroll:' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/eth5m-out.log | tail -1"
```

Saída esperada:
```
Bankroll:         $18.07 | cycle 1
```

---

## 3. Tentativas de entrada (ENTER)

```bash
# BTC 15m
ssh claudio@147.79.87.101 "grep 'decision=ENTER' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/btc15m-err.log | tail -20"

# ETH 15m
ssh claudio@147.79.87.101 "grep 'decision=ENTER' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/eth15m-err.log | tail -20"

# BTC 5m
ssh claudio@147.79.87.101 "grep 'decision=ENTER\|pred5m_ok' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/btc5m-err.log | tail -20"

# ETH 5m
ssh claudio@147.79.87.101 "grep 'decision=ENTER\|pred5m_ok' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/eth5m-err.log | tail -20"
```

Uma entrada bem-sucedida passa por:
1. `[RISK] ... decision=ENTER` — risk manager aprovou (15m) **ou** `reason=pred5m_ok` (5m)
2. `[AUTO-TRADE] DISPARANDO LONG/SHORT ...` — executor enviou a ordem
3. `[AUTO-TRADE] Ordem confirmada pela API` — confirmado

### Razões de skip específicas do bot 5m

| Razão no log | Causa |
|---|---|
| `trading_disabled` | `pred5mState.tradingEnabled = false` |
| `open_position_exists` | Já há posição aberta neste bot |
| `circuit_breaker_tripped` | 3+ perdas consecutivas → cooldown ativo |
| `outside_trading_hours` | Fora do horário PST 06h–17h |
| `market_not_alive` | Menos de 1.5 min para settlement |
| `prices_unavailable` | CLOB não retornou preços UP/DOWN |
| `prob_too_low_X_below_0.72` | Sinal TA abaixo do threshold mínimo |
| `edge_out_of_range_X_[0.08,0.20]` | Edge fora da faixa permitida |

### Razões de skip específicas do bot 15m

| Razão no log | Causa |
|---|---|
| `prob_model_X_below_0.80` | Probabilidade do modelo abaixo do mínimo |
| `edge_X_out_of_range_0.10_0.15` | Edge fora da faixa |
| `max_positions_2_reached` | Limite de posições abertas atingido |
| `paused_losing_streak_5` | 5 perdas consecutivas → bot pausado |
| `cycle_ended` | Bankroll abaixo do piso do ciclo |
| `exposure_X_exceeds_Y_35pct` | Exposição máxima atingida |

---

## 4. Circuit breaker (apenas bots 5m)

O circuit breaker do bot 5m protege contra sequências de perdas rápidas inerentes ao timeframe curto.

**Lógica:**
- 3 perdas consecutivas → cooldown inicial de **5 segundos**
- Cada perda adicional dobra o cooldown: 5s → 10s → 20s → 40s → máx 60s
- Uma vitória **reseta** completamente o circuit breaker

**Verificar estado do circuit breaker:**
```bash
# Ver TRIPPED no dashboard do bot 5m
ssh claudio@147.79.87.101 "grep 'Circuit breaker:' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/btc5m-out.log | tail -5"

# Ver eventos de perda que ativaram o circuit breaker
ssh claudio@147.79.87.101 "grep 'circuit_breaker_tripped\|OUTCOME.*LOSS' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/btc5m-err.log | tail -20"
```

Saída do dashboard quando ativo:
```
Circuit breaker:  losses=3 TRIPPED 47s
```

Saída quando normal:
```
Circuit breaker:  losses=1 ok
```

---

## 5. Stop-loss (apenas bots 5m)

O bot 5m monitora posições abertas a cada tick e loga quando o stop-loss seria acionado.

**Threshold:** PnL não-realizado ≤ −30% do tamanho do contrato.

> **Nota atual:** o log `[5M-EXIT]` indica a recomendação de saída, mas a execução de SELL não está implementada. A posição aguarda settlement normalmente. Isso é intencional para a fase atual — o stop-loss serve como alerta.

```bash
# Ver recomendações de saída antecipada
ssh claudio@147.79.87.101 "grep '5M-EXIT' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/btc5m-err.log | tail -20"
```

Saídas possíveis:
- `[5M-EXIT] Saída recomendada: stop_loss` — posição caiu 30%+
- `[5M-EXIT] Saída recomendada: settlement_imminent` — menos de 60s para settlement
- `[5M-EXIT] Saída recomendada: market_rolled` — mercado virou para o próximo período
- `[5M-EXIT] Saída recomendada: manual_kill_switch` — kill switch ativado manualmente

---

## 6. Apostas executadas (wins/losses)

```bash
# Wins e losses — todos os bots
ssh claudio@147.79.87.101 "grep 'OUTCOME' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/btc15m-err.log | tail -20"
ssh claudio@147.79.87.101 "grep 'OUTCOME' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/btc5m-err.log | tail -20"

# Ordens rejeitadas
ssh claudio@147.79.87.101 "grep 'rejeitou\|FALHA' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/btc5m-err.log | tail -20"
```

CSVs de sinais por bot:
```bash
ssh claudio@147.79.87.101 "tail -20 /home/claudio/workspace/PolymarketBTC15mAssistant/logs/signals-btc-15m.csv"
ssh claudio@147.79.87.101 "tail -20 /home/claudio/workspace/PolymarketBTC15mAssistant/logs/signals-btc-5m.csv"
ssh claudio@147.79.87.101 "tail -20 /home/claudio/workspace/PolymarketBTC15mAssistant/logs/signals-eth-15m.csv"
ssh claudio@147.79.87.101 "tail -20 /home/claudio/workspace/PolymarketBTC15mAssistant/logs/signals-eth-5m.csv"
```

Colunas: `timestamp, entry_minute, time_left_min, signal, decision_reason, side, prob_model_up, prob_model_down, prob_market_up, prob_market_down, edge_up, edge_down, stake_usd`

---

## 7. Erros do dia

```bash
# Substituir DATA por ex: 2026-04-16
ssh claudio@147.79.87.101 "grep 'DATA' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/btc15m-err.log | grep -v 'NO_TRADE' | grep -E '\[31m|rejeitou|FALHA|below_floor|fetch failed|Erro'"
ssh claudio@147.79.87.101 "grep 'DATA' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/btc5m-err.log | grep -v 'NO_TRADE' | grep -E '\[31m|rejeitou|FALHA|below_floor|fetch failed|Erro'"
```

### Erros comuns e o que significam

| Erro | Causa | Ação |
|---|---|---|
| `Size (X) lower than the minimum: 5` | Stake gerou menos de 5 shares. Preço alto para o stake. | Verificar `MAX_STAKE` / `maxStakeUsd` |
| `not enough balance / allowance` | Saldo USDC insuficiente | Fazer depósito |
| `bankroll_X_below_floor_Y` | Bankroll abaixo do piso de segurança | Verificar bankroll e repor |
| `could not run the execution` | Erro transitório da API Polymarket | Transitório — bot tenta novamente |
| `fetch failed` (Binance) | Erro de rede ao buscar preço spot | Transitório |
| `replacement fee too low` | Gas insuficiente para substituir tx no redeem | Não afeta apostas novas |
| `GS026` (execution reverted) | Erro no contrato Safe ao resgatar | Não afeta apostas novas |

---

## 8. Verificar se um ajuste de código funcionou

**a) Confirmar que o código novo está rodando:**
```bash
ssh claudio@147.79.87.101 "cd /home/claudio/workspace/PolymarketBTC15mAssistant && git log --oneline -3"
```

**b) Confirmar uptime (quando foi reiniciado):**
```bash
ssh claudio@147.79.87.101 "pm2 list"
```

**c) Verificar entradas após o restart:**
```bash
# 15m
ssh claudio@147.79.87.101 "grep '2026-04-16' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/btc15m-err.log | grep -E 'decision=ENTER|EXECUCAO|FALHA|below_floor'"

# 5m
ssh claudio@147.79.87.101 "grep '2026-04-16' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/btc5m-err.log | grep -E 'pred5m_ok|EXECUCAO|FALHA|circuit_breaker|5M-EXIT'"
```

---

## 9. Estado atual completo (snapshot rápido)

```bash
ssh claudio@147.79.87.101 "
echo '=== PM2 STATUS ==='
pm2 list

echo ''
echo '=== BANKROLL BTC-15m ==='
grep 'Bankroll:\|Exposure:' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/btc15m-out.log | tail -2

echo ''
echo '=== BANKROLL ETH-15m ==='
grep 'Bankroll:\|Exposure:' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/eth15m-out.log | tail -2

echo ''
echo '=== BANKROLL BTC-5m ==='
grep 'Bankroll:\|Exposure:\|Circuit breaker:' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/btc5m-out.log | tail -3

echo ''
echo '=== BANKROLL ETH-5m ==='
grep 'Bankroll:\|Exposure:\|Circuit breaker:' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/eth5m-out.log | tail -3

echo ''
echo '=== ULTIMA DECISAO BTC-15m ==='
grep 'decision=' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/btc15m-err.log | tail -1

echo ''
echo '=== ULTIMA DECISAO BTC-5m ==='
grep '\[RISK\]\|\[AUTO-TRADE\]' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/btc5m-err.log | tail -1

echo ''
echo '=== CIRCUIT BREAKER BTC-5m ==='
grep 'circuit_breaker_tripped\|OUTCOME' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/btc5m-err.log | tail -5

echo ''
echo '=== ERROS HOJE (BTC-15m) ==='
grep \$(date +%Y-%m-%d) /home/claudio/workspace/PolymarketBTC15mAssistant/logs/btc15m-err.log | grep -v NO_TRADE | grep -E '\[31m|FALHA|below_floor|Erro' | grep -v '^\s*$'

echo ''
echo '=== ERROS HOJE (BTC-5m) ==='
grep \$(date +%Y-%m-%d) /home/claudio/workspace/PolymarketBTC15mAssistant/logs/btc5m-err.log | grep -v NO_TRADE | grep -E '\[31m|FALHA|below_floor|5M-EXIT|Erro' | grep -v '^\s*$'
"
```

---

## 10. Calibração (Mock mode)

### Como usar

1. Certifique-se que `TRADE_MOCK_MODE=true` (é o padrão — sem riscos)
2. Inicie os bots normalmente via PM2
3. Deixe rodar por pelo menos 1–2 dias para acumular amostras suficientes
4. Analise o CSV de calibração

### Ver posições em papel aguardando resultado

```bash
# Número de posições pendentes aparece no dashboard (Mode: MOCK CALIBRATION — paper=N pending)
# Para ver os últimos registros de entrada:
ssh claudio@147.79.87.101 "grep 'MOCK-ENTRY' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/btc15m-err.log | tail -20"
ssh claudio@147.79.87.101 "grep 'MOCK-ENTRY' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/btc5m-err.log | tail -20"
```

### Ver resultados de calibração (wins/losses)

```bash
# Resultados em tempo real nos logs
ssh claudio@147.79.87.101 "grep 'MOCK-OUTCOME' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/btc15m-err.log | tail -30"
ssh claudio@147.79.87.101 "grep 'MOCK-OUTCOME' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/btc5m-err.log | tail -30"

# CSV de calibração completo
ssh claudio@147.79.87.101 "cat /home/claudio/workspace/PolymarketBTC15mAssistant/logs/mock-calibration-btc-15m.csv"
ssh claudio@147.79.87.101 "cat /home/claudio/workspace/PolymarketBTC15mAssistant/logs/mock-calibration-btc-5m.csv"
```

### Estrutura do CSV de calibração

| Coluna | Descrição |
|---|---|
| `timestamp_entry` | Quando a entrada foi aprovada |
| `timestamp_outcome` | Quando o resultado foi registrado |
| `timeframe` | `btc-15m`, `btc-5m`, `eth-15m`, `eth-5m` |
| `market_slug` | Slug do mercado Polymarket |
| `side` | `UP` ou `DOWN` |
| `entry_price` | Preço ask no momento da entrada |
| `stake_usd` | Stake em dólares (papel) |
| `prob_model` | Probabilidade do modelo para o lado escolhido |
| `prob_market` | Preço de mercado para o lado escolhido |
| `edge` | `prob_model - prob_market` |
| `raw_up` | Score bruto do motor de sinais [0–1] |
| `time_left_min_at_entry` | Minutos restantes quando entrou |
| `winner_side` | Lado que venceu de verdade (`UP` ou `DOWN`) |
| `outcome` | `WIN` ou `LOSS` |
| `pnl_mock_usd` | P&L estimado em dólares se fosse real |
| `signals_json` | Snapshot dos indicadores TA no momento da entrada |

### Métricas chave para calibração

```bash
# Win rate por timeframe (requer csvkit ou awk)
ssh claudio@147.79.87.101 "awk -F',' 'NR>1 {total++; if(\$14==\"WIN\") wins++} END {printf \"Win rate: %.1f%% (%d/%d)\n\", wins/total*100, wins, total}' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/mock-calibration-btc-5m.csv"

# P&L acumulado
ssh claudio@147.79.87.101 "awk -F',' 'NR>1 {pnl+=\$15} END {printf \"P&L total: $%.2f\n\", pnl}' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/mock-calibration-btc-5m.csv"

# Últimos 10 trades com resultado
ssh claudio@147.79.87.101 "tail -11 /home/claudio/workspace/PolymarketBTC15mAssistant/logs/mock-calibration-btc-5m.csv | column -t -s ','"
```

### O que ajustar com base nos resultados

| Sintoma | Possível causa | Ajuste |
|---|---|---|
| Win rate < 40% | Thresholds muito permissivos | Aumentar `minProb` ou `minEdge` |
| Win rate > 65% mas poucos trades | Thresholds muito restritivos | Reduzir `minProb` ou `minEdge` |
| Muitos `LOSS` com `time_left_min_at_entry < 2` | Entradas tarde demais | Aumentar `timeLeftMinMinutes` |
| `raw_up` alto mas `outcome=LOSS` recorrente | Sinal RSI ou Heiken não confiável | Revisar pesos em `scoreDirection5m()` |
| Circuit breaker disparando muito | Sequências de perdas normais ou parâmetro muito sensível | Aumentar `CIRCUIT_TRIP_LOSSES` |

---

## 12. Referência de arquivos de log

| Arquivo | Conteúdo |
|---|---|
| `btc15m-out.log` | Dashboard visual BTC 15m (bankroll, RSI 14, MACD 12/26/9, decisão, mode) |
| `btc15m-err.log` | Log detalhado BTC 15m: RISK, AUTO-TRADE, MOCK-ENTRY, MOCK-OUTCOME, erros |
| `eth15m-out.log` | Dashboard visual ETH 15m |
| `eth15m-err.log` | Log detalhado ETH 15m |
| `btc5m-out.log` | Dashboard visual BTC 5m (RSI 5, MACD 5/13/8, circuit breaker, sinal 5m, mode) |
| `btc5m-err.log` | Log detalhado BTC 5m: pred5m decisions, circuit breaker, 5M-EXIT, MOCK-ENTRY/OUTCOME |
| `eth5m-out.log` | Dashboard visual ETH 5m |
| `eth5m-err.log` | Log detalhado ETH 5m |
| `signals-btc-15m.csv` | Sinais e decisões tick-a-tick BTC 15m |
| `signals-eth-15m.csv` | Sinais e decisões tick-a-tick ETH 15m |
| `signals-btc-5m.csv` | Sinais e decisões tick-a-tick BTC 5m |
| `signals-eth-5m.csv` | Sinais e decisões tick-a-tick ETH 5m |
| `mock-calibration-btc-15m.csv` | Resultados reais de trades em papel — BTC 15m (uma linha por trade) |
| `mock-calibration-eth-15m.csv` | Resultados reais de trades em papel — ETH 15m |
| `mock-calibration-btc-5m.csv` | Resultados reais de trades em papel — BTC 5m |
| `mock-calibration-eth-5m.csv` | Resultados reais de trades em papel — ETH 5m |

---

## 13. Configurações editáveis por bot

### Parâmetros do bot 15m
Arquivo: `src/engines/risk-management.js`

| Parâmetro | Valor atual | Descrição |
|---|---|---|
| `MIN_EDGE` | 0.10 | Edge mínimo para entrar |
| `MAX_EDGE` | 0.15 | Edge máximo para entrar |
| `MIN_PROB` | 0.80 | Probabilidade mínima do modelo |
| `MIN_MARKET_PROB` | 0.75 | Probabilidade mínima de mercado |
| `MAX_STAKE` | $4.25 | Stake máximo por trade |
| `MAX_POSITIONS` | 2 | Posições abertas simultâneas |
| `MAX_EXPOSURE_PCT` | 35% | Exposição máxima do bankroll |
| `WITHDRAWAL_TRIGGER` | $150 | Bankroll que aciona saque |

Arquivo: `src/engines/probability.js`

| Parâmetro | Valor atual | Descrição |
|---|---|---|
| `failedVwapReclaim` | peso +3 down | Sinal mais forte de reversão |
| VWAP slope | peso +2 | Tendência do VWAP |
| RSI > 55 + rising | peso +2 up | Momentum de alta |

### Parâmetros do bot 5m
Arquivo: `src/prediction5min/config.js` — função `createPrediction5mConfig()`

| Parâmetro | Valor atual | Descrição |
|---|---|---|
| `stakePct` | 0.20 | 20% do bankroll por trade |
| `minStakeUsd` | $1.00 | Stake mínimo |
| `maxStakeUsd` | $4.25 | Stake máximo |
| `feeRate` | 0.02 | Taxa da CLOB (usada no sizing) |
| `minProb` | 0.72 | Probabilidade mínima do modelo 5m |
| `minEdge` | 0.08 | Edge mínimo para entrar |
| `maxEdge` | 0.20 | Edge máximo para entrar |
| `calibrationFactor` | 0.88 | Shrinkage da confiança do modelo |
| `candleWindowMinutes` | 5 | Janela para time-decay |
| `stopLossPct` | 0.30 | Stop-loss: −30% do contrato |
| `timeLeftMinMinutes` | 1.5 | Não entra se < 1.5 min para settlement |
| `tradingHoursStartPst` | 6 | Início do horário de operação (PST) |
| `tradingHoursEndPst` | 17 | Fim do horário de operação (PST) |
| `allowWeekends` | false | Bloqueia fins de semana |

Arquivo: `src/prediction5min/probability.js` — função `scoreDirection5m()`

| Sinal | Peso | Descrição |
|---|---|---|
| Heiken Ashi | 0.30 | Cor + contagem consecutiva (satura em 3) |
| MACD(5/13/8) hist | 0.25 | Direção + expansão do histograma |
| RSI(5) extremos | 0.20 | Só atua em <35 ou >65; mid-range ignorado |
| Volume surge | 0.15 | Últimos 3 bars vs média 15 bars + direção do preço |
| Rate of change | 0.10 | Variação dos últimos 5 bars (0.33% satura) |

Arquivo: `src/prediction5min/state.js` — circuit breaker

| Parâmetro | Valor atual | Descrição |
|---|---|---|
| `CIRCUIT_TRIP_LOSSES` | 3 | Perdas consecutivas para ativar |
| `CIRCUIT_BASE_COOLDOWN_MS` | 5000ms | Cooldown base (dobra a cada perda) |
| `CIRCUIT_MAX_COOLDOWN_MS` | 60000ms | Cooldown máximo |
