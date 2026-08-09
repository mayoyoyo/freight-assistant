# Model comparison — post-fix code + post-fix data, judge v3, k=3, 24 cases

The claude-opus-5 row is the post-fix full run (runs-postfix-20260807.jsonl) —
the shipped configuration — so the sweep did not pay for a duplicate opus leg.
It was generated in two batches (cap interruption); the other legs ran
uninterrupted, so treat opus latency as indicative, not strictly comparable.
gpt-5.6-luna was graded with code graders + judge v3 like every other leg.

| Model | pass@1 (Wilson 95%) | pass^3 (Wilson 95%) | median latency | tool calls/run | est. cost/query |
| --- | --- | --- | --- | --- | --- |
claude-opus-5 | 70.8% (17/24) [50.8%, 85.1%] | 66.7% (16/24) [46.7%, 82.0%] | 14999 ms | 3.92 | $0.1209
claude-sonnet-5 | 62.5% (15/24) [42.7%, 78.8%] | 62.5% (15/24) [42.7%, 78.8%] | 9521 ms | 2.71 | $0.0610
claude-haiku-4-5 | 29.2% (7/24) [14.9%, 49.2%] | 12.5% (3/24) [4.3%, 31.0%] | 3581 ms | 1.39 | $0.0080
gpt-5.6-luna | 25.0% (6/24) [12.0%, 44.9%] | 4.2% (1/24) [0.7%, 20.2%] | 12400 ms | 5.42 | $0.0026

Cost is computed from the token usage each run actually recorded, priced with the
`PRICING` map in `evals/compare.ts` — not estimated from a per-call average.
Errored runs are excluded from every column and reported separately:

- claude-opus-5: 72 graded, 0 errored, 24 cases
- claude-sonnet-5: 72 graded, 0 errored, 24 cases
- claude-haiku-4-5: 72 graded, 0 errored, 24 cases
- gpt-5.6-luna: 72 graded, 0 errored, 24 cases
