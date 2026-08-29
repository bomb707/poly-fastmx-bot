# FastMX paired toggle-mode backtest

Exact current-engine replay. Both modes use identical settled BTC 5m markets, causal V2 L2 frames, 520 ms delayed fixed-USD FAK matching, and modeled fees.

## holdout

| Mode | Active markets | Orders | Active win rate | PnL | ROI | Max drawdown | Profit factor |
|---|---:|---:|---:|---:|---:|---:|---:|
| Binance only | 1063/1152 (92.274%) | 3934 | 55.88% | −$384.36 | -1.536% | $450.51 | 0.8436 |
| CLOB + Binance | 813/1152 (70.573%) | 1547 | 57.196% | −$225.01 | -2.5944% | $290.25 | 0.8565 |

Paired PnL difference (both − Binance-only): **+$159.35**. Both was better in 501 markets, Binance-only in 540, equal in 111.

## train

| Mode | Active markets | Orders | Active win rate | PnL | ROI | Max drawdown | Profit factor |
|---|---:|---:|---:|---:|---:|---:|---:|
| Binance only | 979/1723 (56.82%) | 3668 | 55.975% | −$479.33 | -2.0312% | $576.77 | 0.7849 |
| CLOB + Binance | 668/1723 (38.77%) | 1178 | 59.281% | −$168.00 | -2.571% | $342.97 | 0.8643 |

Paired PnL difference (both − Binance-only): **+$311.34**. Both was better in 415 markets, Binance-only in 494, equal in 814.

## all

| Mode | Active markets | Orders | Active win rate | PnL | ROI | Max drawdown | Profit factor |
|---|---:|---:|---:|---:|---:|---:|---:|
| Binance only | 2042/2875 (71.026%) | 7602 | 55.926% | −$863.69 | -1.7763% | $1006.48 | 0.8157 |
| CLOB + Binance | 1481/2875 (51.513%) | 2725 | 58.136% | −$393.00 | -2.5843% | $489.23 | 0.8599 |

Paired PnL difference (both − Binance-only): **+$470.69**. Both was better in 916 markets, Binance-only in 1034, equal in 925.

Caveat: Historical strategy PnL under modeled fills is not evidence of future profitability.
