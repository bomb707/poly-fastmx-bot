# Reversal and sizing analysis

At an opposite-side action, the target either trims the obsolete position or crosses balance into a new predicted-side residual. Signed/fill sizes are labels only; they are not classifier inputs.

- 1,837 reconstructed reversal actions: 833 partial hedges and 1,004 inventory crossings.
- Cross formula: median old imbalance 6.788422 shares, median fill 21 signed minimum shares, median new-side residual 10.472223 shares.
- Chronological tree AUC: train 0.801535, untouched holdout 0.792915; holdout precision 71.324% and recall 83.143%.
