# Performance notes (tech design §9)

Measured 2026-10-30 on a MacBook (Apple silicon), Postgres 16 in Docker Desktop, test database, `BENCH=1 npx vitest run src/store/perf.test.ts`.

| Measure | Result |
|---|---|
| 1,000 sequential one-record audit transactions | 681 ms (≈ 0.7 ms each) |
| 1,000 audit transactions from 10 concurrent writers | 429 ms — the advisory lock is held only for the final insert, so concurrency still helps |
| 200 ingests (decode, encrypted archive, snapshot, metadata signals, Case; no later stages) | 888 ms (≈ 4.4 ms each) |
| Case list page, 50 rows decrypted | 1.9 ms |

Conclusion for E1: neither the audit lock nor encrypting every text field is a bottleneck at the volume of an operations inbox (hundreds of mails a day). Re-measure at E3, when every stage writes audit rows and the list shows risk and queues.
