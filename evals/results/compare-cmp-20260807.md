# Model comparison

| Model | pass@1 (Wilson 95%) | pass^3 (Wilson 95%) | median latency | tool calls/run | est. cost/query |
| --- | --- | --- | --- | --- | --- |
gpt-5.6-luna | 29.2% (7/24) [14.9%, 49.2%] | 12.5% (3/24) [4.3%, 31.0%] | 13704 ms | 5.19 | $0.0026

Cost is computed from the token usage each run actually recorded, priced with the
`PRICING` map in `evals/compare.ts` — not estimated from a per-call average.
Errored runs are excluded from every column and reported separately:

- gpt-5.6-luna: 72 graded, 0 errored, 24 cases
