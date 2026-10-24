# Hardware and deployment plan

## Principle

Same hardware, same OS image, same time window, engines run one after another and never at the same time. Use one dedicated VM for the benchmark. Do not run Grafana, Prometheus or the apps on it during layer 1.

## Recommended hardware

| Item | Layer 1 | Layers 2 and 3 |
|---|---|---|
| Instance | AWS `c7i.xlarge` (4 vCPU, 8 GB) or any dedicated-core compute VM. Prefer `c7i.metal-24xl` or a `.metal` instance if you need no noisy neighbours. | 3 VMs, same family: `engine` (`c7i.xlarge`), `redis` (`c7i.large`), `loadgen` (`c7i.xlarge`). Same AZ and placement group. |
| OS | Ubuntu 24.04 LTS, same AMI for every run | same |
| Storage | 30 GB gp3 | same |
| Network | n/a | 10 Gbps class, private IPs only |

Cost for layer 1: one `c7i.xlarge` for about an hour per run.

## Host tuning (record what you did in the report)

```bash
sudo cpupower frequency-set -g performance
echo 1 | sudo tee /sys/devices/system/cpu/intel_pstate/no_turbo   # if present; avoids frequency jitter
sudo systemctl stop unattended-upgrades
BENCH_CPU=2 make layer1                                           # pin to an isolated core
```

Optionally boot with `isolcpus=2,3 nohz_full=2,3` and use `BENCH_CPU=2`. Cloud VMs often do not expose the governor. The report prints `n/a` in that case.

## Deployment steps

```bash
# 1. provision VM (Ubuntu 24.04), then:
sudo apt-get update && sudo apt-get install -y build-essential pkg-config libssl-dev git curl unzip
curl https://sh.rustup.rs -sSf | sh -s -- -y && source ~/.cargo/env
curl -fsSL https://bun.sh/install | bash && source ~/.bashrc

# 2. get the repo
git clone --recurse-submodules <benchmark-repo-url> && cd exchange-benchmark

# 3. build and run
make setup
BENCH_CPU=2 make layer1-full

# 4. publish
mkdir -p results/published && cp -r results/layer1-*-full results/published/
git add results/published && git commit -m "layer1 results <date> <instance type>"
```

## Run discipline

- Run `smoke` first to confirm parity, then `full`.
- Repeat `full` 3 times on different days or fresh VMs. Publish the median and the spread.
- Pin the engine commits through the submodules. A change to an engine means a new run.
- Re-run if the report says parity failed or the host was shared.
- Do not run layer 1 on a laptop for published numbers.

## Later layers (not implemented yet)

| Layer | Question | Measures | Needs |
|---|---|---|---|
| 2 Engine service | How long does an order take through queue, engine and result channel? | `LPUSH incoming-request` to `response-queue-{backend}` receive, using the `MARKETS_FIXTURE` env var and the ENGINE_CONTRACT protocol | Redis VM, loadgen VM, open-loop load generator with coordinated-omission correction, logging off |
| 3 Full exchange | How long until the client gets the match through the backend? | HTTP or WS order submit to result received, using the core-backend, db-worker and risk-engine | Full stack deployed identically per engine, auth token pool, loadgen on a separate VM |

For layers 2 and 3 use an open-loop generator at fixed rates (for example 500, 1k, 2k, 5k, 10k orders/s) and record latency from the intended send time. Prometheus and Grafana run on a fourth VM and scrape only. Do not co-locate them with the engine.
