# FastMX hedge/reversal paired backtest

Exact current-engine replay on causal V2 L2 frames with 520 ms latency and modeled taker fees. The split was fixed before comparison.

## holdout

| Mode | Active | Orders (E/H/R) | Win rate | PnL | ROI | Max DD | Profit factor |
|---|---:|---:|---:|---:|---:|---:|---:|
| Entry/top-up only | 1144/1152 | 27610 (27610/0/0) | 57.255% | −$5254.78 | -4.12% | $6875.89 | 0.8571 |
| Partial hedge only | 1144/1152 | 44118 (27576/16542/0) | 45.192% | −$5854.18 | -3.0939% | $6122.98 | 0.6368 |
| Strong reversal only | 1144/1152 | 27990 (27894/0/96) | 60.664% | −$4905.49 | -3.6518% | $6948.49 | 0.864 |
| Hedge + reversal | 1144/1152 | 46421 (29248/16477/696) | 48.601% | −$6391.44 | -2.9803% | $6611.19 | 0.5764 |

Partial hedge only minus entry-only: **−$599.41**; better/worse/equal windows 488/601/63.  
Strong reversal only minus entry-only: **+$349.28**; better/worse/equal windows 69/20/1063.  
Hedge + reversal minus entry-only: **−$1136.67**; better/worse/equal windows 488/601/63.  

Both-mode invariant audit: 0 realized hedge crossings; 688/696 reversal fills crossed inventory (98.851%).

## train

| Mode | Active | Orders (E/H/R) | Win rate | PnL | ROI | Max DD | Profit factor |
|---|---:|---:|---:|---:|---:|---:|---:|
| Entry/top-up only | 1315/1723 | 24658 (24658/0/0) | 61.369% | −$4558.07 | -3.9659% | $5277.19 | 0.8637 |
| Partial hedge only | 1315/1723 | 39581 (24577/15004/0) | 48.821% | −$6018.77 | -3.5306% | $6145.24 | 0.5937 |
| Strong reversal only | 1315/1723 | 24869 (24770/0/99) | 63.346% | −$5947.25 | -4.9265% | $6536.58 | 0.8232 |
| Hedge + reversal | 1315/1723 | 42058 (26650/14751/657) | 53.688% | −$6031.42 | -3.0798% | $6396.27 | 0.5657 |

Partial hedge only minus entry-only: **−$1460.70**; better/worse/equal windows 484/548/691.  
Strong reversal only minus entry-only: **−$1389.19**; better/worse/equal windows 65/23/1635.  
Hedge + reversal minus entry-only: **−$1473.36**; better/worse/equal windows 484/548/691.  

Both-mode invariant audit: 0 realized hedge crossings; 650/657 reversal fills crossed inventory (98.935%).

## all

| Mode | Active | Orders (E/H/R) | Win rate | PnL | ROI | Max DD | Profit factor |
|---|---:|---:|---:|---:|---:|---:|---:|
| Entry/top-up only | 2459/2875 | 52268 (52268/0/0) | 59.455% | −$9812.84 | -4.047% | $10556.23 | 0.8602 |
| Partial hedge only | 2459/2875 | 83699 (52153/31546/0) | 47.133% | −$11872.95 | -3.3008% | $12243.99 | 0.6162 |
| Strong reversal only | 2459/2875 | 52859 (52664/0/195) | 62.098% | −$10852.75 | -4.2552% | $11336.26 | 0.8443 |
| Hedge + reversal | 2459/2875 | 88479 (55898/31228/1353) | 51.322% | −$12422.87 | -3.0278% | $12755.60 | 0.5713 |

Partial hedge only minus entry-only: **−$2060.11**; better/worse/equal windows 972/1149/754.  
Strong reversal only minus entry-only: **−$1039.90**; better/worse/equal windows 134/43/2698.  
Hedge + reversal minus entry-only: **−$2610.03**; better/worse/equal windows 972/1149/754.  

Both-mode invariant audit: 0 realized hedge crossings; 1338/1353 reversal fills crossed inventory (98.891%).

Caveat: Historical modeled PnL is not evidence of future profitability.
